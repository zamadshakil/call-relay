import { authenticateFirebase, requireEntitlement } from "./firebase-auth";
import { fromBase64Url, HttpError, json, readJson, requireString, timingSafeEqualText } from "./http";
import { dispatchOutboxItem } from "./outbox";
import type { DeviceRow, Env, PairingRow, Platform, PushJob } from "./types";

type JsonObject = Record<string, unknown>;

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function requireOpaque32(value: unknown, name: string): string {
  const result = requireString(value, name, 64);
  try {
    if (fromBase64Url(result).byteLength !== 32) throw new Error("wrong length");
  } catch {
    throw new HttpError(400, `${name} must encode 32 bytes`);
  }
  return result;
}

async function requireAgreementKey(value: unknown, name: string): Promise<string> {
  const encoded = requireString(value, name, 256);
  try {
    const bytes = fromBase64Url(encoded);
    if (bytes.byteLength !== 65 || bytes[0] !== 4) throw new Error("unexpected key length");
    await crypto.subtle.importKey("raw", bytes.buffer as ArrayBuffer, { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    throw new HttpError(400, `${name} must be a valid P-256 ECDH public key`);
  }
  return encoded;
}

function pushPayload(targetDeviceId: string, data: Record<string, string>): string {
  return JSON.stringify({ targetDeviceId, data } satisfies PushJob);
}

export async function createPairingInvitation(request: Request, env: Env, device: DeviceRow): Promise<Response> {
  if (device.platform !== "android" || !device.user_id) throw new HttpError(403, "only an enrolled Android relay can create a pairing invitation");
  const body = await readJson<JsonObject>(request);
  const invitationId = requireString(body.invitationId, "invitationId", 80);
  if (!/^inv_[a-f0-9]{32}$/u.test(invitationId)) throw new HttpError(400, "invitationId is invalid");
  const challengeHash = requireOpaque32(body.challengeHash, "challengeHash");
  const now = Date.now();
  const expiresAt = now + 5 * 60 * 1000;
  await env.CALL_RELAY_DB.batch([
    env.CALL_RELAY_DB.prepare(
      `UPDATE pairings SET revoked_at = ? WHERE user_id = ? AND protocol_version = 2 AND confirmed_at IS NULL AND revoked_at IS NULL`,
    ).bind(now, device.user_id),
    env.CALL_RELAY_DB.prepare(
      `UPDATE pairing_invitations SET revoked_at = ? WHERE android_device_id = ? AND confirmed_at IS NULL AND revoked_at IS NULL`,
    ).bind(now, device.id),
    env.CALL_RELAY_DB.prepare(
      `INSERT INTO pairing_invitations(id, user_id, android_device_id, challenge_hash, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(invitationId, device.user_id, device.id, challengeHash, now, expiresAt),
  ]);
  return json({ invitationId, expiresAt, pairingUrlBase: new URL("/pair", env.PUBLIC_APP_URL).toString() }, { status: 201 });
}

export async function consumePairingInvitation(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  invitationId: string,
): Promise<Response> {
  const account = await authenticateFirebase(request, env);
  requireEntitlement(account, env.ACCESS_MODE);
  const body = await readJson<JsonObject>(request);
  const peerDeviceId = requireString(body.peerDeviceId, "peerDeviceId", 80);
  if (!/^dev_[a-f0-9]{32}$/u.test(peerDeviceId)) throw new HttpError(400, "peerDeviceId is invalid");
  const challengeHash = requireOpaque32(body.challengeHash, "challengeHash");
  const peerPublicKeyRaw = await requireAgreementKey(body.peerPublicKeyRaw, "peerPublicKeyRaw");
  const commitment = requireOpaque32(body.commitment, "commitment");
  const peerProof = requireOpaque32(body.proof, "proof");
  const invitation = await env.CALL_RELAY_DB.prepare(
    `SELECT id, user_id, android_device_id, challenge_hash, expires_at, consumed_at, revoked_at
     FROM pairing_invitations WHERE id = ?`,
  ).bind(invitationId).first<{
    id: string;
    user_id: string;
    android_device_id: string;
    challenge_hash: string;
    expires_at: number;
    consumed_at: number | null;
    revoked_at: number | null;
  }>();
  if (!invitation || invitation.revoked_at !== null) throw new HttpError(404, "pairing invitation not found");
  if (invitation.user_id !== account.identity.uid) throw new HttpError(403, "pairing requires the same Google account");
  if (invitation.consumed_at !== null) throw new HttpError(409, "pairing invitation has already been used");
  if (invitation.expires_at <= Date.now()) throw new HttpError(410, "pairing invitation has expired");
  if (!await timingSafeEqualText(challengeHash, invitation.challenge_hash)) throw new HttpError(403, "pairing challenge does not match");
  const peer = await env.CALL_RELAY_DB.prepare(
    "SELECT id, platform FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
  ).bind(peerDeviceId, account.identity.uid).first<{ id: string; platform: Platform }>();
  if (!peer || (peer.platform !== "browser" && peer.platform !== "ios")) throw new HttpError(403, "an enrolled peer device is required");
  const android = await env.CALL_RELAY_DB.prepare(
    "SELECT id FROM devices WHERE id = ? AND user_id = ? AND platform = 'android' AND revoked_at IS NULL",
  ).bind(invitation.android_device_id, account.identity.uid).first<{ id: string }>();
  if (!android) throw new HttpError(409, "the Android relay is unavailable");
  const [deviceA, deviceB] = [android.id, peer.id].sort();
  const pairingId = id("pair");
  const outboxId = id("push");
  const now = Date.now();
  const results = await env.CALL_RELAY_DB.batch([
    env.CALL_RELAY_DB.prepare(
      `UPDATE pairing_invitations SET peer_device_id = ?, peer_public_key_raw = ?, peer_commitment = ?, peer_proof = ?, consumed_at = ?
       WHERE id = ? AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    ).bind(peer.id, peerPublicKeyRaw, commitment, peerProof, now, invitation.id, now),
    env.CALL_RELAY_DB.prepare(
      `INSERT INTO pairings(id, device_a_id, device_b_id, secret_commitment, created_at, created_by_device_id,
       protocol_version, user_id, invitation_id, peer_proof)
       SELECT ?, ?, ?, ?, ?, ?, 2, ?, ?, ? FROM pairing_invitations
       WHERE id = ? AND peer_device_id = ? AND consumed_at = ? AND pairing_id IS NULL`,
    ).bind(pairingId, deviceA, deviceB, commitment, now, peer.id, account.identity.uid, invitation.id, peerProof, invitation.id, peer.id, now),
    env.CALL_RELAY_DB.prepare(
      "UPDATE pairing_invitations SET pairing_id = ? WHERE id = ? AND pairing_id IS NULL AND peer_device_id = ? AND consumed_at = ?",
    ).bind(pairingId, invitation.id, peer.id, now),
    env.CALL_RELAY_DB.prepare(
      `INSERT INTO push_outbox(id, target_device_id, payload_json, created_at)
       SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pairings WHERE id = ?)`,
    ).bind(outboxId, android.id, pushPayload(android.id, {
      type: "pairing_invitation_consumed",
      invitationId: invitation.id,
      pairingId,
      peerDeviceId: peer.id,
      peerPublicKeyRaw,
      commitment,
      peerProof,
    }), now, pairingId),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    throw new HttpError(409, "pairing invitation was consumed concurrently");
  }
  ctx.waitUntil(dispatchOutboxItem(env, outboxId).catch((error: unknown) => {
    console.error(JSON.stringify({ message: "pairing push enqueue failed", pairingId, error: error instanceof Error ? error.message : String(error) }));
  }));
  return json({ pairingId, status: "awaiting_android_confirmation" }, { status: 201 });
}

export async function confirmPairingV2(request: Request, env: Env, device: DeviceRow, pairing: PairingRow): Promise<Response> {
  if (device.platform !== "android" || !device.user_id || pairing.user_id !== device.user_id) {
    throw new HttpError(403, "only the owning Android relay can confirm this pairing");
  }
  if (pairing.confirmed_at !== null) {
    return json({ pairingId: pairing.id, confirmed: true, duplicate: true });
  }
  const body = await readJson<JsonObject>(request);
  const commitment = requireOpaque32(body.commitment, "commitment");
  const androidProof = requireOpaque32(body.proof, "proof");
  if (!await timingSafeEqualText(commitment, pairing.secret_commitment)) throw new HttpError(403, "pairing commitments do not match");
  const now = Date.now();
  const result = await env.CALL_RELAY_DB.prepare(
    `UPDATE pairings SET confirmed_by_device_id = ?, confirmed_at = ?, android_proof = ?
     WHERE id = ? AND protocol_version = 2 AND confirmed_at IS NULL AND revoked_at IS NULL`,
  ).bind(device.id, now, androidProof, pairing.id).run();
  if (result.meta.changes !== 1) throw new HttpError(409, "pairing changed concurrently");
  await env.CALL_RELAY_DB.prepare(
    "UPDATE pairing_invitations SET confirmed_at = ? WHERE id = ? AND pairing_id = ?",
  ).bind(now, pairing.invitation_id, pairing.id).run();
  return json({ pairingId: pairing.id, confirmed: true, androidProof });
}

export async function currentPairingForAccount(request: Request, env: Env): Promise<Response> {
  const account = await authenticateFirebase(request, env);
  const row = await env.CALL_RELAY_DB.prepare(
    `SELECT p.id, p.protocol_version, p.confirmed_at, p.revoked_at, p.device_a_id, p.device_b_id,
      p.secret_commitment, p.peer_proof, p.android_proof, p.invitation_id,
      pi.peer_public_key_raw, pi.expires_at, pi.consumed_at,
      da.platform AS device_a_platform, da.display_name AS device_a_name,
      db.platform AS device_b_platform, db.display_name AS device_b_name
     FROM pairings p
     JOIN devices da ON da.id = p.device_a_id
     JOIN devices db ON db.id = p.device_b_id
     LEFT JOIN pairing_invitations pi ON pi.id = p.invitation_id
     WHERE p.user_id = ? AND p.revoked_at IS NULL ORDER BY p.created_at DESC LIMIT 1`,
  ).bind(account.identity.uid).first<Record<string, unknown>>();
  return json({ pairing: row ?? null });
}

export async function pendingPairingForDevice(env: Env, device: DeviceRow): Promise<Response> {
  if (!device.user_id) throw new HttpError(404, "pairing not found");
  const row = await env.CALL_RELAY_DB.prepare(
    `SELECT p.id, p.protocol_version, p.confirmed_at, p.secret_commitment, p.peer_proof, p.android_proof,
      p.invitation_id, pi.peer_device_id, pi.peer_public_key_raw, pi.expires_at
     FROM pairings p JOIN pairing_invitations pi ON pi.id = p.invitation_id
     WHERE p.user_id = ? AND p.revoked_at IS NULL AND (p.device_a_id = ? OR p.device_b_id = ?)
     ORDER BY p.created_at DESC LIMIT 1`,
  ).bind(device.user_id, device.id, device.id).first<Record<string, unknown>>();
  return json({ pairing: row ?? null });
}
