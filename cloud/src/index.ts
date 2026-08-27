import { authenticate } from "./auth";
import { requireDeviceEntitlement } from "./entitlement";
import { authSession, me, registerDevice, revokeDevice, updateSimProfile } from "./onboarding";
import { isFirebaseAuthHelperPath, proxyFirebaseAuthHelper } from "./firebase-auth-proxy";
import { billingPlans, createCheckout, createPortal, paddleWebhook } from "./paddle";
import {
  confirmPairingV2,
  consumePairingInvitation,
  createPairingInvitation,
  currentPairingForAccount,
  pendingPairingForDevice,
} from "./pairing-v2";
import { HttpError, fromBase64Url, json, readBodyBytes, readJson, requireString, timingSafeEqualText } from "./http";
import { dispatchOutboxItem, drainOutbox } from "./outbox";
import { PairingSignal } from "./pairing-signal";
import { deliverPush } from "./push";
import { secretValue } from "./secrets";
import { createSignalTicket, SIGNALING_PROTOCOL, signalRole, signalTicketFromProtocols, verifySignalTicket } from "./signal-ticket";
import { canTransition, isE164 } from "./state";
import { createMediaConfig, revokeDueTurnCredentials, revokeTurnCredentialsForCall } from "./turn";
import type { CallRow, CallState, DeviceRow, Env, PairingRow, Platform, PushJob, RelayMode } from "./types";
import { deleteWebPushSubscription, saveWebPushSubscription, webPushConfig } from "./web-push";

export { PairingSignal };

type JsonObject = Record<string, unknown>;
type EventType = "accept" | "reject" | "end" | "mute" | "dtmf" | "full_duplex" | "listen" | "talk" | "active" | "failed" |
  "answering_sim" | "media_connecting" | "media_connected" | "media_path_changed" | "media_restarting" | "media_summary" | "media_heartbeat";

const EVENT_TYPES = new Set<EventType>([
  "accept", "reject", "end", "mute", "dtmf", "full_duplex", "listen", "talk", "active", "failed",
  "answering_sim", "media_connecting", "media_connected", "media_path_changed", "media_restarting", "media_summary", "media_heartbeat",
]);
const MODE_EVENTS = new Set<EventType>(["full_duplex", "listen", "talk"]);
const MEDIA_EVENTS = new Set<EventType>(["media_connecting", "media_connected", "media_path_changed", "media_restarting", "media_summary"]);
const LEGACY_MIN_ANDROID_APP_VERSION = 2;

function assertSupportedAndroidVersion(request: Request, env: Env): void {
  const value = request.headers.get("x-relay-app-version") ?? "";
  const match = /^android-webrtc-(\d+)$/u.exec(value);
  const configured = Number(env.MIN_ANDROID_APP_VERSION);
  const minimum = Number.isSafeInteger(configured) && configured >= LEGACY_MIN_ANDROID_APP_VERSION ? configured : LEGACY_MIN_ANDROID_APP_VERSION;
  if (!match || Number(match[1]) < minimum) {
    throw new HttpError(426, `Android app version android-webrtc-${minimum} or newer is required`);
  }
}

function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function requireId(value: unknown, name: string, prefix: string): string {
  const result = requireString(value, name, 80);
  if (!new RegExp(`^${prefix}_[a-f0-9]{32}$`, "u").test(result)) throw new HttpError(400, `${name} is invalid`);
  return result;
}

function requireCommandId(value: unknown): string {
  const commandId = requireString(value, "commandId", 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(commandId)) {
    throw new HttpError(400, "commandId must be a UUID v4");
  }
  return commandId;
}

function pushPayload(targetDeviceId: string, data: Record<string, string>): string {
  return JSON.stringify({ targetDeviceId, data });
}

async function getCall(env: Env, callId: string): Promise<CallRow> {
  const call = await env.CALL_RELAY_DB.prepare("SELECT * FROM call_sessions WHERE id = ?")
    .bind(callId).first<CallRow>();
  if (!call) throw new HttpError(404, "call not found");
  return call;
}

async function getPairing(env: Env, pairingId: string): Promise<PairingRow> {
  const pairing = await env.CALL_RELAY_DB.prepare("SELECT * FROM pairings WHERE id = ? AND revoked_at IS NULL")
    .bind(pairingId).first<PairingRow>();
  if (!pairing) throw new HttpError(404, "pairing not found");
  return pairing;
}

async function broadcastCall(env: Env, call: CallRow): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // Recreate the stub on every attempt because a thrown DO RPC can poison a stub.
      await env.PAIRING_SIGNAL.getByName(call.pairing_id).publishSnapshot(JSON.stringify(call));
      return;
    } catch (error) {
      const durableError = error as Error & { retryable?: boolean; overloaded?: boolean };
      if (durableError.overloaded || !durableError.retryable || attempt === 2) {
        console.error(JSON.stringify({ message: "call snapshot broadcast failed", callId: call.id, error: durableError.message }));
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (2 ** attempt)));
    }
  }
}

function assertCallMember(call: CallRow, deviceId: string): void {
  if (call.android_device_id !== deviceId && call.peer_device_id !== deviceId) {
    throw new HttpError(403, "device is not a member of this call");
  }
}

async function validateP256Spki(encoded: string): Promise<void> {
  try {
    const bytes = fromBase64Url(encoded);
    if (bytes.byteLength < 80 || bytes.byteLength > 160) throw new Error("unexpected key length");
    await crypto.subtle.importKey("spki", bytes.buffer as ArrayBuffer, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    throw new HttpError(400, "publicKeySpki must be a valid P-256 public key");
  }
}

async function enroll(request: Request, env: Env): Promise<Response> {
  const enrollmentInvite = await secretValue(env.ENROLLMENT_INVITE, "ENROLLMENT_INVITE");
  if (!await timingSafeEqualText(request.headers.get("x-enrollment-invite") ?? "", enrollmentInvite)) {
    throw new HttpError(403, "invalid enrollment invite");
  }
  const body = await readJson<JsonObject>(request);
  const platform = requireString(body.platform, "platform") as Platform;
  if (!["android", "browser", "ios"].includes(platform)) throw new HttpError(400, "platform is invalid");
  if (platform === "android") assertSupportedAndroidVersion(request, env);
  const displayName = requireString(body.displayName, "displayName", 80).trim();
  if (!displayName) throw new HttpError(400, "displayName is invalid");
  const publicKeySpki = requireString(body.publicKeySpki, "publicKeySpki", 512);
  await validateP256Spki(publicKeySpki);
  const fcmToken = platform === "android" && typeof body.fcmToken === "string" && body.fcmToken.length <= 4096 ? body.fcmToken : null;
  const deviceId = id("dev");
  const now = Date.now();
  await env.CALL_RELAY_DB.prepare(
    "INSERT INTO devices(id, platform, display_name, public_key_spki, fcm_token, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(deviceId, platform, displayName, publicKeySpki, fcmToken, now, now).run();
  return json({ deviceId }, { status: 201 });
}

async function pair(request: Request, env: Env, device: DeviceRow): Promise<Response> {
  if (device.platform === "android") throw new HttpError(403, "the peer device must create the pairing");
  const body = await readJson<JsonObject>(request);
  const peerDeviceId = requireId(body.peerDeviceId, "peerDeviceId", "dev");
  const commitment = requireString(body.secretCommitment, "secretCommitment", 64);
  if (!/^[A-Za-z0-9_-]{43}$/u.test(commitment)) throw new HttpError(400, "secretCommitment must encode 32 bytes");
  const peer = await env.CALL_RELAY_DB.prepare("SELECT id, platform FROM devices WHERE id = ? AND revoked_at IS NULL")
    .bind(peerDeviceId).first<{ id: string; platform: Platform }>();
  if (!peer || peer.platform !== "android") throw new HttpError(400, "peer must be an enrolled Android device");
  const [deviceA, deviceB] = [device.id, peer.id].sort();
  const existing = await env.CALL_RELAY_DB.prepare("SELECT * FROM pairings WHERE device_a_id = ? AND device_b_id = ?")
    .bind(deviceA, deviceB).first<PairingRow>();
  const now = Date.now();
  if (existing) {
    if (existing.created_by_device_id !== null && existing.created_by_device_id !== device.id) {
      throw new HttpError(409, "this Android is already paired by another peer");
    }
    await env.CALL_RELAY_DB.prepare(
      "UPDATE pairings SET secret_commitment = ?, created_by_device_id = ?, confirmed_by_device_id = NULL, confirmed_at = NULL, revoked_at = NULL, created_at = ? WHERE id = ?",
    ).bind(commitment, device.id, now, existing.id).run();
    return json({ pairingId: existing.id, confirmed: false });
  }
  const conflictingPairing = await env.CALL_RELAY_DB.prepare(
    `SELECT id FROM pairings
     WHERE revoked_at IS NULL AND (
       device_a_id IN (?, ?) OR device_b_id IN (?, ?)
     ) LIMIT 1`,
  ).bind(deviceA, deviceB, deviceA, deviceB).first<{ id: string }>();
  if (conflictingPairing) throw new HttpError(409, "one of these devices already has a paired peer");
  const pairingId = id("pair");
  try {
    await env.CALL_RELAY_DB.prepare(
      "INSERT INTO pairings(id, device_a_id, device_b_id, secret_commitment, created_at, created_by_device_id) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(pairingId, deviceA, deviceB, commitment, now, device.id).run();
  } catch (error) {
    const raceConflict = await env.CALL_RELAY_DB.prepare(
      `SELECT id FROM pairings
       WHERE revoked_at IS NULL AND (
         device_a_id IN (?, ?) OR device_b_id IN (?, ?)
       ) LIMIT 1`,
    ).bind(deviceA, deviceB, deviceA, deviceB).first<{ id: string }>();
    if (raceConflict) throw new HttpError(409, "one of these devices already has a paired peer");
    throw error;
  }
  return json({ pairingId, confirmed: false }, { status: 201 });
}

async function confirmPairing(request: Request, env: Env, device: DeviceRow, pairingId: string): Promise<Response> {
  if (device.platform !== "android") throw new HttpError(403, "only Android can confirm a pairing");
  const pairing = await env.CALL_RELAY_DB.prepare("SELECT * FROM pairings WHERE id = ? AND revoked_at IS NULL")
    .bind(pairingId).first<PairingRow>();
  if (!pairing || (pairing.device_a_id !== device.id && pairing.device_b_id !== device.id)) throw new HttpError(404, "pairing not found");
  if (pairing.protocol_version === 2) return confirmPairingV2(request, env, device, pairing);
  if (env.ONBOARDING_V2_ENABLED === "true") throw new HttpError(410, "legacy secret pairing has been removed");
  if (pairing.created_by_device_id === device.id) throw new HttpError(403, "the creator cannot confirm its own pairing");
  const body = await readJson<JsonObject>(request);
  const commitment = requireString(body.secretCommitment, "secretCommitment", 64);
  if (!await timingSafeEqualText(commitment, pairing.secret_commitment)) throw new HttpError(403, "pairing secret does not match");
  const now = Date.now();
  await env.CALL_RELAY_DB.prepare(
    "UPDATE pairings SET confirmed_by_device_id = ?, confirmed_at = ? WHERE id = ? AND revoked_at IS NULL",
  ).bind(device.id, now, pairing.id).run();
  return json({ pairingId: pairing.id, confirmed: true });
}

async function expireStaleForAndroid(env: Env, ctx: ExecutionContext, androidDeviceId: string, now: number): Promise<void> {
  const stale = await env.CALL_RELAY_DB.prepare(
    `SELECT id FROM call_sessions
     WHERE android_device_id = ? AND state NOT IN ('ended', 'failed') AND (
       (state IN ('created', 'ringing_peer', 'accepted', 'dialing_sim') AND updated_at < ?) OR
       (state = 'active' AND updated_at < ?) OR
       (state = 'ending' AND updated_at < ?)
     )`,
  ).bind(androidDeviceId, now - 120_000, now - 90_000, now - 30_000).all<{ id: string }>();
  await env.CALL_RELAY_DB.prepare(
    `UPDATE call_sessions SET state = 'failed', failure_code = 'stale_session', ended_at = ?, updated_at = ?, version = version + 1
     WHERE android_device_id = ? AND state NOT IN ('ended', 'failed') AND (
       (state IN ('created', 'ringing_peer', 'accepted', 'dialing_sim') AND updated_at < ?) OR
       (state = 'active' AND updated_at < ?) OR
       (state = 'ending' AND updated_at < ?)
     )`,
  ).bind(now, now, androidDeviceId, now - 120_000, now - 90_000, now - 30_000).run();
  for (const staleCall of stale.results) {
    const updated = await getCall(env, staleCall.id);
    await broadcastCall(env, updated);
    ctx.waitUntil(revokeTurnCredentialsForCall(env, staleCall.id));
  }
}

async function createCall(request: Request, env: Env, ctx: ExecutionContext, device: DeviceRow, direction: "incoming" | "outgoing"): Promise<Response> {
  const body = await readJson<JsonObject>(request);
  const pairingId = requireId(body.pairingId, "pairingId", "pair");
  const requestId = requireCommandId(body.requestId);
  const pairing = await env.CALL_RELAY_DB.prepare(
    "SELECT * FROM pairings WHERE id = ? AND revoked_at IS NULL AND confirmed_at IS NOT NULL",
  ).bind(pairingId).first<PairingRow>();
  if (!pairing || (pairing.device_a_id !== device.id && pairing.device_b_id !== device.id)) throw new HttpError(403, "confirmed pairing is unavailable");
  const peerId = pairing.device_a_id === device.id ? pairing.device_b_id : pairing.device_a_id;
  const peer = await env.CALL_RELAY_DB.prepare("SELECT id, platform FROM devices WHERE id = ? AND revoked_at IS NULL")
    .bind(peerId).first<{ id: string; platform: Platform }>();
  if (!peer) throw new HttpError(409, "paired peer is unavailable");
  const androidDeviceId = device.platform === "android" ? device.id : peer.platform === "android" ? peer.id : "";
  if (!androidDeviceId) throw new HttpError(409, "a pairing must contain one Android device");
  const peerDeviceId = androidDeviceId === device.id ? peer.id : device.id;
  if (direction === "incoming" && device.id !== androidDeviceId) throw new HttpError(403, "incoming calls originate on Android");
  if (direction === "outgoing" && device.id === androidDeviceId) throw new HttpError(403, "outgoing requests originate on the peer");
  const existingRequest = await env.CALL_RELAY_DB.prepare(
    "SELECT id, state FROM call_sessions WHERE pairing_id = ? AND direction = ? AND request_id = ?",
  ).bind(pairingId, direction, requestId).first<{ id: string; state: CallState }>();
  if (existingRequest) return json({ callId: existingRequest.id, state: existingRequest.state, duplicate: true });
  let phoneNumber: string | null = null;
  if (direction === "outgoing") {
    phoneNumber = requireString(body.phoneNumber, "phoneNumber", 18);
    if (!isE164(phoneNumber)) throw new HttpError(400, "phoneNumber must be E.164");
  }
  const callId = id("call");
  const now = Date.now();
  await expireStaleForAndroid(env, ctx, androidDeviceId, now);
  const state: CallState = direction === "incoming" ? "ringing_peer" : "dialing_sim";
  const targetDeviceId = direction === "outgoing" ? androidDeviceId : peerDeviceId;
  const targetPlatform = targetDeviceId === device.id ? device.platform : peer.platform;
  const pushChannel = targetPlatform === "android" ? "android_fcm" : targetPlatform === "browser" ? "web_push" : null;
  const outboxId = pushChannel ? id("push") : null;
  const statements: D1PreparedStatement[] = [env.CALL_RELAY_DB.prepare(
    "INSERT INTO call_sessions(id, pairing_id, android_device_id, peer_device_id, direction, state, phone_number, created_at, updated_at, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(callId, pairingId, androidDeviceId, peerDeviceId, direction, state, phoneNumber, now, now, requestId)];
  if (outboxId) statements.push(env.CALL_RELAY_DB.prepare(
    "INSERT INTO push_outbox(id, target_device_id, channel, payload_json, created_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(outboxId, targetDeviceId, pushChannel, pushPayload(targetDeviceId, {
    type: direction === "incoming" ? "incoming_call" : "outgoing_call",
    callId,
    phoneNumber: direction === "outgoing" ? phoneNumber ?? "" : "",
    callVersion: "0",
  }), now));
  try {
    await env.CALL_RELAY_DB.batch(statements);
  } catch (error) {
    const duplicate = await env.CALL_RELAY_DB.prepare(
      "SELECT id, state FROM call_sessions WHERE pairing_id = ? AND direction = ? AND request_id = ?",
    ).bind(pairingId, direction, requestId).first<{ id: string; state: CallState }>();
    if (duplicate) return json({ callId: duplicate.id, state: duplicate.state, duplicate: true });
    const openCall = await env.CALL_RELAY_DB.prepare(
      "SELECT id FROM call_sessions WHERE android_device_id = ? AND state NOT IN ('ended', 'failed') LIMIT 1",
    ).bind(androidDeviceId).first<{ id: string }>();
    if (openCall) throw new HttpError(409, "the Android device already has an open call");
    throw error;
  }
  if (outboxId) ctx.waitUntil(dispatchOutboxItem(env, outboxId).catch((error: unknown) => {
    console.error(JSON.stringify({ message: "initial call push enqueue failed", callId, error: error instanceof Error ? error.message : String(error) }));
  }));
  await broadcastCall(env, await getCall(env, callId));
  return json({ callId, state }, { status: 201 });
}

async function callMediaConfig(env: Env, call: CallRow, device: DeviceRow): Promise<Response> {
  assertCallMember(call, device.id);
  if (["ending", "ended", "failed"].includes(call.state)) throw new HttpError(409, "call is closing or closed");
  const confirmed = await env.CALL_RELAY_DB.prepare("SELECT id FROM pairings WHERE id = ? AND confirmed_at IS NOT NULL AND revoked_at IS NULL")
    .bind(call.pairing_id).first<{ id: string }>();
  if (!confirmed) throw new HttpError(409, "pairing is not confirmed");
  return json(await createMediaConfig(env, call, device));
}

function authorizeEvent(call: CallRow, device: DeviceRow, eventType: EventType): CallState {
  const isAndroid = device.id === call.android_device_id;
  if (eventType === "accept" || eventType === "reject") {
    if (isAndroid || call.direction !== "incoming" || call.state !== "ringing_peer") throw new HttpError(403, `${eventType} is only valid for the peer on a ringing incoming call`);
    return eventType === "accept" ? "accepted" : "ending";
  }
  if (eventType === "active") {
    const expectedState = call.direction === "incoming" ? "accepted" : "dialing_sim";
    if (!isAndroid || call.state !== expectedState) throw new HttpError(403, "only Android can report an expected SIM call active");
    return "active";
  }
  if (eventType === "answering_sim") {
    if (!isAndroid || call.direction !== "incoming" || call.state !== "accepted") {
      throw new HttpError(403, "only Android can report an accepted SIM call answer attempt");
    }
    return call.state;
  }
  if (eventType === "end") return isAndroid ? "ended" : "ending";
  if (eventType === "failed") return "failed";
  if (MODE_EVENTS.has(eventType)) return call.state;
  if (eventType === "mute" || eventType === "dtmf") {
    if (isAndroid) throw new HttpError(403, "this control originates from the paired peer");
    return call.state;
  }
  if (MEDIA_EVENTS.has(eventType)) return call.state;
  return call.state;
}

function sanitizeEventPayload(eventType: EventType, payload: Record<string, unknown>): Record<string, unknown> {
  if (eventType === "dtmf") {
    if (typeof payload.digit !== "string" || !/^[0-9*#]$/u.test(payload.digit)) throw new HttpError(400, "DTMF must be one digit from 0-9, * or #");
    return { digit: payload.digit };
  }
  if (eventType === "mute") {
    if (typeof payload.muted !== "boolean") throw new HttpError(400, "mute payload must contain a boolean muted value");
    return { muted: payload.muted };
  }
  if (eventType === "media_connected" || eventType === "media_path_changed" || eventType === "media_restarting") {
    const result: Record<string, unknown> = {};
    if (payload.candidateType !== undefined) {
      if (typeof payload.candidateType !== "string" || !["host", "srflx", "relay"].includes(payload.candidateType)) throw new HttpError(400, "candidateType is invalid");
      result.candidateType = payload.candidateType;
    }
    if (payload.icePolicy !== undefined) {
      if (payload.icePolicy !== "all" && payload.icePolicy !== "relay") throw new HttpError(400, "icePolicy is invalid");
      result.icePolicy = payload.icePolicy;
    }
    if (eventType === "media_restarting" && payload.reason !== undefined) {
      const allowed = new Set(["direct_timeout", "ice_failed", "connection_failed", "network_change", "network_online", "peer_request"]);
      if (typeof payload.reason !== "string" || !allowed.has(payload.reason)) throw new HttpError(400, "media restart reason is invalid");
      result.reason = payload.reason;
    }
    return result;
  }
  if (eventType === "media_summary") {
    const result: Record<string, unknown> = {};
    const limits: Record<string, number> = {
      setupDurationMs: 120_000,
      rttMs: 60_000,
      jitterMs: 60_000,
      packetsLost: 1_000_000_000_000,
      concealedSamples: 10_000_000_000_000,
      bytesSent: 10_000_000_000_000,
      bytesReceived: 10_000_000_000_000,
      iceRestartCount: 10_000,
    };
    for (const [name, maximum] of Object.entries(limits)) {
      const value = payload[name];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) throw new HttpError(400, `${name} is invalid`);
      result[name] = value;
    }
    if (payload.candidateType !== undefined) {
      if (typeof payload.candidateType !== "string" || !["host", "srflx", "relay", "unknown"].includes(payload.candidateType)) throw new HttpError(400, "candidateType is invalid");
      result.candidateType = payload.candidateType;
    }
    if (payload.protocol !== undefined) {
      if (typeof payload.protocol !== "string" || !["udp", "tcp", "tls", "unknown"].includes(payload.protocol)) throw new HttpError(400, "media protocol is invalid");
      result.protocol = payload.protocol;
    }
    return result;
  }
  return {};
}

async function appendEvent(request: Request, env: Env, ctx: ExecutionContext, call: CallRow, device: DeviceRow): Promise<Response> {
  assertCallMember(call, device.id);
  const body = await readJson<JsonObject>(request);
  const eventTypeValue = requireString(body.type, "type", 64);
  if (!EVENT_TYPES.has(eventTypeValue as EventType)) throw new HttpError(400, "unsupported event type");
  const eventType = eventTypeValue as EventType;
  const commandId = requireCommandId(body.commandId);
  const rawPayload = typeof body.payload === "object" && body.payload !== null && !Array.isArray(body.payload) ? body.payload as Record<string, unknown> : {};
  const payload = sanitizeEventPayload(eventType, rawPayload);
  const candidateType = typeof payload.candidateType === "string" ? payload.candidateType : null;
  if (candidateType !== null && !["host", "srflx", "relay"].includes(candidateType)) throw new HttpError(400, "candidateType is invalid");
  const icePolicy = typeof payload.icePolicy === "string" ? payload.icePolicy : null;
  if (icePolicy !== null && icePolicy !== "all" && icePolicy !== "relay") throw new HttpError(400, "icePolicy is invalid");
  const duplicate = await env.CALL_RELAY_DB.prepare("SELECT id FROM call_events WHERE call_id = ? AND command_id = ?")
    .bind(call.id, commandId).first<{ id: string }>();
  if (duplicate) {
    const current = await getCall(env, call.id);
    return json({ callId: current.id, state: current.state, relayMode: current.relay_mode, duplicate: true });
  }
  if (["ended", "failed"].includes(call.state)) throw new HttpError(409, "call is closed");
  if (eventType === "media_heartbeat") {
    if (device.id !== call.android_device_id) throw new HttpError(403, "only Android can report relay media health");
    await env.CALL_RELAY_DB.prepare("UPDATE call_sessions SET updated_at = ? WHERE id = ? AND state NOT IN ('ended', 'failed')")
      .bind(Date.now(), call.id).run();
    return json({ callId: call.id, state: call.state, relayMode: call.relay_mode });
  }
  const nextState = authorizeEvent(call, device, eventType);
  if (!canTransition(call.state, nextState)) throw new HttpError(409, `cannot transition ${call.state} to ${nextState}`);
  const relayMode = MODE_EVENTS.has(eventType) ? eventType as RelayMode : call.relay_mode;
  const now = Date.now();
  const terminal = ["ended", "failed"].includes(nextState) ? now : null;
  const eventId = id("evt");
  const targetDeviceId = device.id === call.android_device_id ? call.peer_device_id : call.android_device_id;
  const target = await env.CALL_RELAY_DB.prepare("SELECT platform FROM devices WHERE id = ? AND revoked_at IS NULL")
    .bind(targetDeviceId).first<{ platform: Platform }>();
  const outboxId = target?.platform === "android" ? id("push") : null;
  const failureCode = eventType === "failed" ? requireString(body.code ?? "unknown", "code", 80) : null;
  if (failureCode !== null && !/^[a-z0-9_]{1,80}$/u.test(failureCode)) throw new HttpError(400, "failure code is invalid");
  const mediaConnectedAt = eventType === "media_connected" ? now : null;
  const mediaFailureCode = eventType === "failed" ? failureCode : null;
  const statements: D1PreparedStatement[] = [
    env.CALL_RELAY_DB.prepare(
      `UPDATE call_sessions SET state = ?, relay_mode = ?, updated_at = ?, ended_at = COALESCE(?, ended_at),
       failure_code = COALESCE(?, failure_code), media_connected_at = COALESCE(?, media_connected_at),
       media_failure_code = COALESCE(?, media_failure_code), selected_candidate_type = COALESCE(?, selected_candidate_type),
       ice_policy = COALESCE(?, ice_policy), peer_accepted_at = COALESCE(?, peer_accepted_at),
       telecom_answer_requested_at = COALESCE(?, telecom_answer_requested_at), sim_active_at = COALESCE(?, sim_active_at),
       version = version + 1, last_event_id = ?
       WHERE id = ? AND version = ? AND state = ?`,
    ).bind(
      nextState, relayMode, now, terminal, failureCode, mediaConnectedAt, mediaFailureCode, candidateType, icePolicy,
      eventType === "accept" ? now : null,
      eventType === "answering_sim" ? now : null,
      eventType === "active" ? now : null,
      eventId, call.id, call.version, call.state,
    ),
    env.CALL_RELAY_DB.prepare(
      "INSERT INTO call_events(id, call_id, device_id, event_type, payload_json, created_at, command_id) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM call_sessions WHERE id = ? AND last_event_id = ?)",
    ).bind(eventId, call.id, device.id, eventType, JSON.stringify(payload), now, commandId, call.id, eventId),
  ];
  if (outboxId && !MEDIA_EVENTS.has(eventType)) statements.push(env.CALL_RELAY_DB.prepare(
    "INSERT INTO push_outbox(id, target_device_id, channel, payload_json, created_at) SELECT ?, ?, 'android_fcm', ?, ? WHERE EXISTS (SELECT 1 FROM call_sessions WHERE id = ? AND last_event_id = ?)",
  ).bind(outboxId, targetDeviceId, pushPayload(targetDeviceId, {
    type: "call_event", callId: call.id, event: eventType, commandId, callVersion: String(call.version + 1),
    ...(eventType === "dtmf" ? { digit: String(payload.digit) } : {}),
    ...(eventType === "mute" ? { muted: String(payload.muted) } : {}),
  }), now, call.id, eventId));
  const results = await env.CALL_RELAY_DB.batch(statements);
  if (results[0]?.meta.changes !== 1) {
    const concurrentDuplicate = await env.CALL_RELAY_DB.prepare("SELECT id FROM call_events WHERE call_id = ? AND command_id = ?")
      .bind(call.id, commandId).first<{ id: string }>();
    if (concurrentDuplicate) {
      const current = await getCall(env, call.id);
      return json({ callId: current.id, state: current.state, relayMode: current.relay_mode, duplicate: true });
    }
    throw new HttpError(409, "call changed concurrently; retry the command");
  }
  if (outboxId && !MEDIA_EVENTS.has(eventType)) ctx.waitUntil(dispatchOutboxItem(env, outboxId).catch((error: unknown) => {
    console.error(JSON.stringify({ message: "event push enqueue failed", callId: call.id, eventType, error: error instanceof Error ? error.message : String(error) }));
  }));
  const updatedCall = await getCall(env, call.id);
  await broadcastCall(env, updatedCall);
  if (["ended", "failed"].includes(nextState)) {
    ctx.waitUntil(revokeTurnCredentialsForCall(env, call.id));
  }
  return json({ callId: call.id, state: nextState, relayMode });
}

async function issueSignalTicket(env: Env, device: DeviceRow, pairingId: string): Promise<Response> {
  const pairing = await getPairing(env, pairingId);
  if (pairing.confirmed_at === null) throw new HttpError(409, "pairing is not confirmed");
  signalRole(pairing, device);
  return json(await createSignalTicket(env, pairing, device), { status: 201 });
}

async function openSignalSocket(request: Request, env: Env, pairingId: string): Promise<Response> {
  const encodedTicket = signalTicketFromProtocols(request.headers.get("sec-websocket-protocol"));
  const ticket = await verifySignalTicket(env, encodedTicket);
  if (ticket.pairingId !== pairingId) throw new HttpError(403, "signaling ticket is for another pairing");
  const pairing = await getPairing(env, pairingId);
  if (pairing.confirmed_at === null) throw new HttpError(409, "pairing is not confirmed");
  const device = await env.CALL_RELAY_DB.prepare(
    `SELECT id, platform, display_name, public_key_spki, fcm_token, fcm_target_kind, revoked_at, user_id,
      agreement_public_key_raw, app_version FROM devices WHERE id = ? AND revoked_at IS NULL`,
  ).bind(ticket.deviceId).first<DeviceRow>();
  if (!device || signalRole(pairing, device) !== ticket.role) throw new HttpError(403, "signaling ticket identity is invalid");
  const headers = new Headers(request.headers);
  headers.set("sec-websocket-protocol", SIGNALING_PROTOCOL);
  headers.set("x-relay-signal-device", ticket.deviceId);
  headers.set("x-relay-signal-role", ticket.role);
  headers.set("x-relay-signal-jti", ticket.jti);
  headers.set("x-relay-signal-exp", ticket.expiresAt.toString());
  return env.PAIRING_SIGNAL.getByName(pairingId).fetch(new Request("https://pairing-signal.internal/connect", { headers }));
}

async function api(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const billingDisabled = env.ACCESS_MODE === "approval_only";
  if (request.method === "POST" && url.pathname === "/v1/billing/webhooks/paddle") {
    if (billingDisabled) throw new HttpError(410, "billing is disabled; approved accounts receive access directly");
    return paddleWebhook(request, env, ctx);
  }
  if (request.method === "POST" && url.pathname === "/v1/auth/session") return authSession(request, env);
  if (request.method === "GET" && url.pathname === "/v1/me") return me(request, env);
  if (request.method === "GET" && url.pathname === "/v1/billing/plans") {
    if (billingDisabled) throw new HttpError(410, "billing is disabled; approved accounts receive access directly");
    return billingPlans(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/billing/checkout") {
    if (billingDisabled) throw new HttpError(410, "billing is disabled; approved accounts receive access directly");
    return createCheckout(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/billing/portal") {
    if (billingDisabled) throw new HttpError(410, "billing is disabled; approved accounts receive access directly");
    return createPortal(request, env);
  }
  if (request.method === "POST" && url.pathname === "/v1/devices/register") return registerDevice(request, env);
  if (request.method === "GET" && url.pathname === "/v1/pairings/current") return currentPairingForAccount(request, env);
  const consumeInvitationMatch = /^\/v1\/pairing-invitations\/(inv_[a-f0-9]{32})\/consume$/u.exec(url.pathname);
  if (request.method === "POST" && consumeInvitationMatch) {
    return consumePairingInvitation(request, env, ctx, consumeInvitationMatch[1] ?? "");
  }
  const revokeDeviceMatch = /^\/v1\/devices\/(dev_[a-f0-9]{32})\/revoke$/u.exec(url.pathname);
  if (request.method === "POST" && revokeDeviceMatch) return revokeDevice(request, env, revokeDeviceMatch[1] ?? "");
  if (request.method === "POST" && url.pathname === "/v1/devices/enroll") {
    if (env.ONBOARDING_V2_ENABLED === "true") return json({ error: "manual enrollment has been removed; sign in with Google" }, { status: 410 });
    return enroll(request, env);
  }
  const body = request.method === "GET" || request.method === "HEAD" ? new Uint8Array() : await readBodyBytes(request.clone());
  const device = await authenticate(request, env, body);
  if (device.platform === "android") assertSupportedAndroidVersion(request, env);
  if (request.method === "GET" && url.pathname === "/v1/calls/current") {
    const call = await env.CALL_RELAY_DB.prepare(
      "SELECT * FROM call_sessions WHERE (android_device_id = ? OR peer_device_id = ?) AND state NOT IN ('ended', 'failed') ORDER BY created_at DESC LIMIT 1",
    ).bind(device.id, device.id).first<CallRow>();
    return json({ call: call ?? null });
  }
  if (request.method === "GET" && url.pathname === "/v1/push/config") {
    await requireDeviceEntitlement(env, device);
    return webPushConfig(env);
  }
  const webPushMatch = /^\/v1\/devices\/(dev_[a-f0-9]{32})\/web-push-subscription$/u.exec(url.pathname);
  if (webPushMatch) {
    if (webPushMatch[1] !== device.id) throw new HttpError(403, "a device may update only its own push subscription");
    await requireDeviceEntitlement(env, device);
    if (request.method === "PUT") return saveWebPushSubscription(request, env, device);
    if (request.method === "DELETE") return deleteWebPushSubscription(env, device);
  }
  if (request.method === "POST" && url.pathname === "/v1/devices/push-token") {
    if (device.platform !== "android") throw new HttpError(403, "push tokens are only accepted for Android");
    const tokenBody = await readJson<JsonObject>(request);
    const fcmTarget = requireString(tokenBody.fcmInstallationId ?? tokenBody.fcmToken, "fcmInstallationId", 4096);
    const targetKind = typeof tokenBody.fcmInstallationId === "string" ? "fid" : "token";
    await env.CALL_RELAY_DB.prepare("UPDATE devices SET fcm_token = ?, fcm_target_kind = ?, last_seen_at = ? WHERE id = ?")
      .bind(fcmTarget, targetKind, Date.now(), device.id).run();
    return json({ updated: true });
  }
  const simProfileMatch = /^\/v1\/devices\/(dev_[a-f0-9]{32})\/sim-profile$/u.exec(url.pathname);
  if (request.method === "PUT" && simProfileMatch) {
    if (simProfileMatch[1] !== device.id) throw new HttpError(403, "a device may update only its own SIM profile");
    await requireDeviceEntitlement(env, device);
    return updateSimProfile(request, env, device);
  }
  if (request.method === "POST" && url.pathname === "/v1/pairing-invitations") {
    await requireDeviceEntitlement(env, device);
    return createPairingInvitation(request, env, device);
  }
  if (request.method === "GET" && url.pathname === "/v1/pairings/current-device") {
    await requireDeviceEntitlement(env, device);
    return pendingPairingForDevice(env, device);
  }
  if (request.method === "POST" && url.pathname === "/v1/pairings") {
    if (env.ONBOARDING_V2_ENABLED === "true") throw new HttpError(410, "legacy secret pairing has been removed");
    return pair(request, env, device);
  }
  const pairingMatch = /^\/v1\/pairings\/(pair_[a-f0-9]{32})\/confirm$/u.exec(url.pathname);
  if (request.method === "POST" && pairingMatch) {
    if (env.ONBOARDING_V2_ENABLED === "true") await requireDeviceEntitlement(env, device);
    return confirmPairing(request, env, device, pairingMatch[1] ?? "");
  }
  const signalTicketMatch = /^\/v1\/pairings\/(pair_[a-f0-9]{32})\/signal-ticket$/u.exec(url.pathname);
  if (request.method === "POST" && signalTicketMatch) {
    await requireDeviceEntitlement(env, device);
    return issueSignalTicket(env, device, signalTicketMatch[1] ?? "");
  }
  if (request.method === "POST" && url.pathname === "/v1/calls/incoming") {
    await requireDeviceEntitlement(env, device);
    return createCall(request, env, ctx, device, "incoming");
  }
  if (request.method === "POST" && url.pathname === "/v1/calls/outgoing") {
    await requireDeviceEntitlement(env, device);
    return createCall(request, env, ctx, device, "outgoing");
  }
  const match = /^\/v1\/calls\/(call_[a-f0-9]{32})(?:\/(token|media-config|events))?$/u.exec(url.pathname);
  if (!match) throw new HttpError(404, "endpoint not found");
  const call = await getCall(env, match[1] ?? "");
  if (request.method === "GET" && !match[2]) {
    assertCallMember(call, device.id);
    return json({ call });
  }
  if (request.method === "POST" && match[2] === "token") return json({ error: "participant media tokens were removed; update the client" }, { status: 410 });
  if (request.method === "POST" && match[2] === "media-config") {
    await requireDeviceEntitlement(env, device);
    return callMediaConfig(env, call, device);
  }
  if (request.method === "POST" && match[2] === "events") return appendEvent(request, env, ctx, call, device);
  throw new HttpError(405, "method not allowed");
}

function secureAssetResponse(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  const path = new URL(request.url).pathname;
  const contentType = headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    // The application shell contains the current hashed bundle name. Caching
    // it can strand an installed PWA on an obsolete or misconfigured bundle.
    headers.set("cache-control", "no-store");
  } else if (path === "/sw.js") {
    headers.set("cache-control", "no-cache, max-age=0, must-revalidate");
    headers.set("service-worker-allowed", "/");
  }
  headers.set("content-security-policy", "default-src 'self'; script-src 'self' https://apis.google.com https://cdn.paddle.com; style-src 'self' 'unsafe-inline' https://cdn.paddle.com; connect-src 'self' https: wss:; media-src 'self' blob:; worker-src 'self' blob:; img-src 'self' data: https:; frame-src 'self' https://accounts.google.com https://*.firebaseapp.com https://*.paddle.com https://*.paddle.dev; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://accounts.google.com");
  headers.set("permissions-policy", "camera=(self), microphone=(self), geolocation=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("cross-origin-opener-policy", "same-origin-allow-popups");
  headers.set("x-frame-options", "DENY");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (isFirebaseAuthHelperPath(url.pathname)) {
      try {
        return await proxyFirebaseAuthHelper(request, env.FIREBASE_PROJECT_ID);
      } catch (error) {
        console.error(JSON.stringify({ message: "Firebase auth helper proxy failed", error: error instanceof Error ? error.message : String(error) }));
        return new Response("Authentication service unavailable", { status: 502, headers: { "cache-control": "no-store" } });
      }
    }
    if (url.pathname === "/health") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, { status: 405 });
      return json({ ok: true, audioStored: false, mediaTransport: "webrtc_p2p" });
    }
    if (!url.pathname.startsWith("/v1/")) return secureAssetResponse(request, await env.ASSETS.fetch(request));
    try {
      const signalMatch = /^\/v1\/pairings\/(pair_[a-f0-9]{32})\/signal$/u.exec(url.pathname);
      if (request.method === "GET" && signalMatch) return await openSignalSocket(request, env, signalMatch[1] ?? "");
      return await api(request, env, ctx);
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, { status: error.status });
      console.error(JSON.stringify({ message: "unhandled request error", path: url.pathname, error: error instanceof Error ? error.message : String(error) }));
      return json({ error: "internal error" }, { status: 500 });
    }
  },
  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      try {
        const delivered = await deliverPush(env, message.body);
        await env.CALL_RELAY_DB.prepare(
          "UPDATE push_outbox SET provider_accepted_at = ?, provider_message_id = ?, last_error = NULL WHERE id = ?",
        ).bind(delivered.accepted ? Date.now() : null, delivered.providerMessageId ?? null, message.body.outboxId).run();
        message.ack();
      } catch (error) {
        await env.CALL_RELAY_DB.prepare(
          "UPDATE push_outbox SET last_error = ? WHERE id = ?",
        ).bind(error instanceof Error ? error.message.slice(0, 500) : "unknown provider failure", message.body.outboxId).run();
        console.error(JSON.stringify({ message: "push delivery failed", messageId: message.id, error: error instanceof Error ? error.message : String(error) }));
        message.retry();
      }
    }
  },
  async scheduled(_controller, env): Promise<void> {
    await drainOutbox(env);
    const now = Date.now();
    const stale = await env.CALL_RELAY_DB.prepare(
      `SELECT id, pairing_id FROM call_sessions
       WHERE state NOT IN ('ended', 'failed') AND (
         (state IN ('created', 'ringing_peer', 'accepted', 'dialing_sim') AND updated_at < ?) OR
         (state = 'active' AND updated_at < ?) OR
         (state = 'ending' AND updated_at < ?)
       )`,
    ).bind(now - 120_000, now - 90_000, now - 30_000).all<{ id: string; pairing_id: string }>();
    await env.CALL_RELAY_DB.prepare(
      `UPDATE call_sessions SET state = 'failed', failure_code = 'session_timeout', ended_at = ?, updated_at = ?, version = version + 1
       WHERE state NOT IN ('ended', 'failed') AND (
         (state IN ('created', 'ringing_peer', 'accepted', 'dialing_sim') AND updated_at < ?) OR
         (state = 'active' AND updated_at < ?) OR
         (state = 'ending' AND updated_at < ?)
       )`,
    ).bind(now, now, now - 120_000, now - 90_000, now - 30_000).run();
    await Promise.all(stale.results.map(async (staleCall) => {
      const updated = await getCall(env, staleCall.id);
      await env.PAIRING_SIGNAL.getByName(staleCall.pairing_id).publishSnapshot(JSON.stringify(updated));
      await revokeTurnCredentialsForCall(env, staleCall.id);
    }));
    await revokeDueTurnCredentials(env);
    const purgeBefore = now - 24 * 60 * 60 * 1000;
    const nonceBefore = now - 10 * 60 * 1000;
    const billingEventBefore = now - 180 * 24 * 60 * 60 * 1000;
    await env.CALL_RELAY_DB.batch([
      env.CALL_RELAY_DB.prepare("DELETE FROM request_nonces WHERE created_at < ?").bind(nonceBefore),
      env.CALL_RELAY_DB.prepare("DELETE FROM push_outbox WHERE created_at < ?").bind(purgeBefore),
      env.CALL_RELAY_DB.prepare("DELETE FROM call_events WHERE call_id IN (SELECT id FROM call_sessions WHERE updated_at < ?)").bind(purgeBefore),
      env.CALL_RELAY_DB.prepare("DELETE FROM call_sessions WHERE updated_at < ?").bind(purgeBefore),
      env.CALL_RELAY_DB.prepare("DELETE FROM pairing_invitations WHERE pairing_id IS NULL AND expires_at < ?").bind(purgeBefore),
      env.CALL_RELAY_DB.prepare("DELETE FROM billing_webhook_events WHERE processed_at < ?").bind(billingEventBefore),
    ]);
  },
} satisfies ExportedHandler<Env, PushJob>;
