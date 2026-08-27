import { authenticateFirebase, hasActiveEntitlement, requireEntitlement } from "./firebase-auth";
import { base64Url, fromBase64Url, HttpError, json, readJson, requireString } from "./http";
import { secretValue } from "./secrets";
import type { AccountContext, DeviceRow, Env, Platform } from "./types";

type JsonObject = Record<string, unknown>;

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function validateSigningKey(encoded: string): Promise<void> {
  try {
    const bytes = fromBase64Url(encoded);
    if (bytes.byteLength < 80 || bytes.byteLength > 160) throw new Error("unexpected signing key length");
    await crypto.subtle.importKey("spki", bytes.buffer as ArrayBuffer, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    throw new HttpError(400, "publicKeySpki must be a valid P-256 signing key");
  }
}

async function validateAgreementKey(encoded: string): Promise<void> {
  try {
    const bytes = fromBase64Url(encoded);
    if (bytes.byteLength !== 65 || bytes[0] !== 4) throw new Error("unexpected agreement key length");
    await crypto.subtle.importKey("raw", bytes.buffer as ArrayBuffer, { name: "ECDH", namedCurve: "P-256" }, false, []);
  } catch {
    throw new HttpError(400, "agreementPublicKeyRaw must be a valid P-256 ECDH key");
  }
}

function publicSubscription(account: AccountContext): Record<string, unknown> {
  const subscription = account.subscription;
  return {
    status: subscription?.status ?? "none",
    plan: subscription?.plan_code ?? null,
    currentPeriodEndsAt: subscription?.current_period_ends_at ?? null,
    cancelAtPeriodEnd: subscription?.cancel_at_period_end === 1,
    active: hasActiveEntitlement(account),
  };
}

async function accountSnapshot(env: Env, account: AccountContext): Promise<Record<string, unknown>> {
  const devices = await env.CALL_RELAY_DB.prepare(
    `SELECT d.id, d.platform, d.display_name, d.last_seen_at, d.revoked_at,
      sp.slot_index, sp.carrier_name, sp.country_iso, sp.number_source, sp.phone_number_last4
     FROM devices d LEFT JOIN sim_profiles sp ON sp.device_id = d.id
     WHERE d.user_id = ? AND d.revoked_at IS NULL ORDER BY d.created_at`,
  ).bind(account.identity.uid).all<{
    id: string;
    platform: Platform;
    display_name: string;
    last_seen_at: number;
    revoked_at: number | null;
    slot_index: number | null;
    carrier_name: string | null;
    country_iso: string | null;
    number_source: string | null;
    phone_number_last4: string | null;
  }>();
  const pairing = await env.CALL_RELAY_DB.prepare(
    `SELECT p.id, p.confirmed_at, p.protocol_version, p.device_a_id, p.device_b_id,
      da.display_name AS device_a_name, db.display_name AS device_b_name,
      da.last_seen_at AS device_a_seen, db.last_seen_at AS device_b_seen
     FROM pairings p
     JOIN devices da ON da.id = p.device_a_id
     JOIN devices db ON db.id = p.device_b_id
     WHERE p.user_id = ? AND p.revoked_at IS NULL ORDER BY p.created_at DESC LIMIT 1`,
  ).bind(account.identity.uid).first<Record<string, unknown>>();
  return {
    account: {
      uid: account.identity.uid,
      email: account.identity.email,
      displayName: account.identity.displayName,
      photoUrl: account.identity.photoUrl,
      approvalStatus: account.approvalStatus,
    },
    subscription: publicSubscription(account),
    devices: devices.results.map((device) => ({
      id: device.id,
      platform: device.platform,
      displayName: device.display_name,
      online: Date.now() - device.last_seen_at < 90_000,
      sim: device.slot_index === null ? null : {
        slotIndex: device.slot_index,
        carrierName: device.carrier_name,
        countryIso: device.country_iso,
        numberSource: device.number_source,
        maskedNumber: device.phone_number_last4 ? `••••${device.phone_number_last4}` : null,
      },
    })),
    pairing: pairing ?? null,
  };
}

export async function authSession(request: Request, env: Env): Promise<Response> {
  const account = await authenticateFirebase(request, env, { checkRevoked: true });
  return json(await accountSnapshot(env, account));
}

export async function me(request: Request, env: Env): Promise<Response> {
  const account = await authenticateFirebase(request, env);
  return json(await accountSnapshot(env, account));
}

export async function registerDevice(request: Request, env: Env): Promise<Response> {
  const account = await authenticateFirebase(request, env);
  requireEntitlement(account);
  const body = await readJson<JsonObject>(request);
  const platform = requireString(body.platform, "platform", 16) as Platform;
  if (!(["android", "browser", "ios"] satisfies Platform[]).includes(platform)) throw new HttpError(400, "platform is invalid");
  const displayName = requireString(body.displayName, "displayName", 80).trim();
  if (!displayName) throw new HttpError(400, "displayName is invalid");
  const publicKeySpki = requireString(body.publicKeySpki, "publicKeySpki", 512);
  const agreementPublicKeyRaw = requireString(body.agreementPublicKeyRaw, "agreementPublicKeyRaw", 256);
  await Promise.all([validateSigningKey(publicKeySpki), validateAgreementKey(agreementPublicKeyRaw)]);
  const appVersion = Number(body.appVersion);
  if (!Number.isSafeInteger(appVersion) || appVersion < 1 || appVersion > 1_000_000) throw new HttpError(400, "appVersion is invalid");
  const minimumVersion = Number(env.MIN_ANDROID_APP_VERSION);
  if (platform === "android" && Number.isSafeInteger(minimumVersion) && appVersion < minimumVersion) {
    throw new HttpError(426, `Android app version ${minimumVersion} or newer is required`);
  }
  const fcmInstallationId = platform === "android" && typeof body.fcmInstallationId === "string" && body.fcmInstallationId.length <= 4096
    ? body.fcmInstallationId
    : null;
  const rolePlatforms: Platform[] = platform === "android" ? ["android"] : ["browser", "ios"];
  const existing = await env.CALL_RELAY_DB.prepare(
    `SELECT id, public_key_spki FROM devices WHERE user_id = ? AND platform IN (${rolePlatforms.map(() => "?").join(",")}) AND revoked_at IS NULL LIMIT 1`,
  ).bind(account.identity.uid, ...rolePlatforms).first<{ id: string; public_key_spki: string }>();
  const now = Date.now();
  if (existing?.public_key_spki === publicKeySpki) {
    await env.CALL_RELAY_DB.prepare(
      "UPDATE devices SET display_name = ?, agreement_public_key_raw = ?, app_version = ?, fcm_token = COALESCE(?, fcm_token), fcm_target_kind = CASE WHEN ? IS NULL THEN fcm_target_kind ELSE 'fid' END, last_seen_at = ? WHERE id = ?",
    ).bind(displayName, agreementPublicKeyRaw, appVersion, fcmInstallationId, fcmInstallationId, now, existing.id).run();
    return json({ deviceId: existing.id, existing: true });
  }
  if (existing && body.replaceExisting !== true) {
    throw new HttpError(409, platform === "android" ? "this account already has an Android relay; explicit replacement is required" : "this account already has a peer; explicit replacement is required");
  }
  if (existing) {
    await env.CALL_RELAY_DB.batch([
      env.CALL_RELAY_DB.prepare("UPDATE pairings SET revoked_at = ? WHERE revoked_at IS NULL AND (device_a_id = ? OR device_b_id = ?)").bind(now, existing.id, existing.id),
      env.CALL_RELAY_DB.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND user_id = ?").bind(now, existing.id, account.identity.uid),
    ]);
  }
  const deviceId = id("dev");
  await env.CALL_RELAY_DB.prepare(
    `INSERT INTO devices(id, platform, display_name, public_key_spki, fcm_token, fcm_target_kind, created_at, last_seen_at, user_id, agreement_public_key_raw, app_version)
     VALUES (?, ?, ?, ?, ?, 'fid', ?, ?, ?, ?, ?)`,
  ).bind(deviceId, platform, displayName, publicKeySpki, fcmInstallationId, now, now, account.identity.uid, agreementPublicKeyRaw, appVersion).run();
  return json({ deviceId, existing: false }, { status: 201 });
}

function base64UrlKey(value: string, name: string): string {
  const key = requireString(value, name, 128);
  try {
    if (fromBase64Url(key).byteLength !== 32) throw new Error("wrong length");
  } catch {
    throw new HttpError(500, `${name} is not configured as 32 bytes`);
  }
  return key;
}

async function encryptPhoneNumber(env: Env, phoneNumber: string): Promise<{ ciphertext: string; iv: string }> {
  const keyText = base64UrlKey(await secretValue(env.SIM_PROFILE_ENCRYPTION_KEY, "SIM_PROFILE_ENCRYPTION_KEY"), "SIM_PROFILE_ENCRYPTION_KEY");
  const keyBytes = fromBase64Url(keyText);
  const key = await crypto.subtle.importKey("raw", keyBytes.buffer as ArrayBuffer, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(phoneNumber)));
  return { ciphertext: base64Url(ciphertext), iv: base64Url(iv) };
}

export async function updateSimProfile(request: Request, env: Env, device: DeviceRow): Promise<Response> {
  if (device.platform !== "android") throw new HttpError(403, "SIM profiles belong to Android relay devices");
  const body = await readJson<JsonObject>(request);
  const slotIndex = Number(body.slotIndex);
  if (!Number.isSafeInteger(slotIndex) || slotIndex < 0 || slotIndex > 8) throw new HttpError(400, "slotIndex is invalid");
  const carrierName = requireString(body.carrierName, "carrierName", 100).trim();
  const countryIso = requireString(body.countryIso, "countryIso", 2).toUpperCase();
  if (!/^[A-Z]{2}$/u.test(countryIso)) throw new HttpError(400, "countryIso is invalid");
  const numberSource = requireString(body.numberSource, "numberSource", 32);
  if (!(["subscription", "user_confirmed", "unavailable"] as const).includes(numberSource as "subscription" | "user_confirmed" | "unavailable")) {
    throw new HttpError(400, "numberSource is invalid");
  }
  let ciphertext: string | null = null;
  let iv: string | null = null;
  let last4: string | null = null;
  if (numberSource !== "unavailable") {
    const phoneNumber = requireString(body.phoneNumber, "phoneNumber", 18);
    if (!/^\+[1-9][0-9]{7,14}$/u.test(phoneNumber)) throw new HttpError(400, "phoneNumber must be E.164");
    ({ ciphertext, iv } = await encryptPhoneNumber(env, phoneNumber));
    last4 = phoneNumber.slice(-4);
  }
  await env.CALL_RELAY_DB.prepare(
    `INSERT INTO sim_profiles(device_id, slot_index, carrier_name, country_iso, number_source, phone_number_ciphertext, phone_number_iv, phone_number_last4, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET slot_index = excluded.slot_index, carrier_name = excluded.carrier_name,
       country_iso = excluded.country_iso, number_source = excluded.number_source,
       phone_number_ciphertext = excluded.phone_number_ciphertext, phone_number_iv = excluded.phone_number_iv,
       phone_number_last4 = excluded.phone_number_last4, updated_at = excluded.updated_at`,
  ).bind(device.id, slotIndex, carrierName, countryIso, numberSource, ciphertext, iv, last4, Date.now()).run();
  return json({ updated: true, maskedNumber: last4 ? `••••${last4}` : null });
}

export async function revokeDevice(request: Request, env: Env, deviceId: string): Promise<Response> {
  const account = await authenticateFirebase(request, env);
  const device = await env.CALL_RELAY_DB.prepare("SELECT id FROM devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(deviceId, account.identity.uid).first<{ id: string }>();
  if (!device) throw new HttpError(404, "device not found");
  const now = Date.now();
  await env.CALL_RELAY_DB.batch([
    env.CALL_RELAY_DB.prepare("UPDATE pairings SET revoked_at = ? WHERE revoked_at IS NULL AND (device_a_id = ? OR device_b_id = ?)").bind(now, deviceId, deviceId),
    env.CALL_RELAY_DB.prepare("UPDATE pairing_invitations SET revoked_at = ? WHERE android_device_id = ? AND revoked_at IS NULL").bind(now, deviceId),
    env.CALL_RELAY_DB.prepare("UPDATE devices SET revoked_at = ?, fcm_token = NULL WHERE id = ? AND user_id = ?").bind(now, deviceId, account.identity.uid),
  ]);
  return json({ revoked: true });
}
