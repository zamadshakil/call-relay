import { authenticate } from "./auth";
import { HttpError, fromBase64Url, json, readBodyBytes, readJson, requireString, timingSafeEqualText } from "./http";
import { dispatchOutboxItem, drainOutbox } from "./outbox";
import { PairingSignal } from "./pairing-signal";
import { deliverPush } from "./push";
import { secretValue } from "./secrets";
import { createSignalTicket, SIGNALING_PROTOCOL, signalRole, signalTicketFromProtocols, verifySignalTicket } from "./signal-ticket";
import { canTransition, isE164 } from "./state";
import { createMediaConfig, revokeDueTurnCredentials, revokeTurnCredentialsForCall } from "./turn";
import type { CallRow, CallState, DeviceRow, Env, PairingRow, Platform, PushJob, RelayMode } from "./types";

export { PairingSignal };

type JsonObject = Record<string, unknown>;
type EventType = "accept" | "reject" | "end" | "mute" | "dtmf" | "full_duplex" | "listen" | "talk" | "active" | "failed" |
  "media_connecting" | "media_connected" | "media_path_changed" | "media_restarting" | "media_summary" | "media_heartbeat";

const EVENT_TYPES = new Set<EventType>([
  "accept", "reject", "end", "mute", "dtmf", "full_duplex", "listen", "talk", "active", "failed",
  "media_connecting", "media_connected", "media_path_changed", "media_restarting", "media_summary", "media_heartbeat",
]);
const MODE_EVENTS = new Set<EventType>(["full_duplex", "listen", "talk"]);
const MEDIA_EVENTS = new Set<EventType>(["media_connecting", "media_connected", "media_path_changed", "media_restarting", "media_summary"]);
const MIN_ANDROID_APP_VERSION = 2;

function assertSupportedAndroidVersion(request: Request): void {
  const value = request.headers.get("x-relay-app-version") ?? "";
  const match = /^android-webrtc-(\d+)$/u.exec(value);
  if (!match || Number(match[1]) < MIN_ANDROID_APP_VERSION) {
    throw new HttpError(426, `Android app version android-webrtc-${MIN_ANDROID_APP_VERSION} or newer is required`);
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
  return JSON.stringify({ targetDeviceId, data } satisfies PushJob);
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

function broadcastCall(env: Env, ctx: ExecutionContext, call: CallRow): void {
  ctx.waitUntil(env.PAIRING_SIGNAL.getByName(call.pairing_id).publishSnapshot(JSON.stringify(call)).catch((error: unknown) => {
    console.error(JSON.stringify({ message: "call snapshot broadcast failed", callId: call.id, error: error instanceof Error ? error.message : String(error) }));
  }));
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
  if (platform === "android") assertSupportedAndroidVersion(request);
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
    broadcastCall(env, ctx, updated);
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
  const outboxId = targetPlatform === "android" ? id("push") : null;
  const statements: D1PreparedStatement[] = [env.CALL_RELAY_DB.prepare(
    "INSERT INTO call_sessions(id, pairing_id, android_device_id, peer_device_id, direction, state, phone_number, created_at, updated_at, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(callId, pairingId, androidDeviceId, peerDeviceId, direction, state, phoneNumber, now, now, requestId)];
  if (outboxId) statements.push(env.CALL_RELAY_DB.prepare(
    "INSERT INTO push_outbox(id, target_device_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
  ).bind(outboxId, targetDeviceId, pushPayload(targetDeviceId, { type: "outgoing_call", callId, phoneNumber: phoneNumber ?? "" }), now));
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
  broadcastCall(env, ctx, await getCall(env, callId));
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
       ice_policy = COALESCE(?, ice_policy), version = version + 1, last_event_id = ?
       WHERE id = ? AND version = ? AND state = ?`,
    ).bind(nextState, relayMode, now, terminal, failureCode, mediaConnectedAt, mediaFailureCode, candidateType, icePolicy, eventId, call.id, call.version, call.state),
    env.CALL_RELAY_DB.prepare(
      "INSERT INTO call_events(id, call_id, device_id, event_type, payload_json, created_at, command_id) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM call_sessions WHERE id = ? AND last_event_id = ?)",
    ).bind(eventId, call.id, device.id, eventType, JSON.stringify(payload), now, commandId, call.id, eventId),
  ];
  if (outboxId && !MEDIA_EVENTS.has(eventType)) statements.push(env.CALL_RELAY_DB.prepare(
    "INSERT INTO push_outbox(id, target_device_id, payload_json, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM call_sessions WHERE id = ? AND last_event_id = ?)",
  ).bind(outboxId, targetDeviceId, pushPayload(targetDeviceId, {
    type: "call_event", callId: call.id, event: eventType, commandId,
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
  broadcastCall(env, ctx, updatedCall);
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
    "SELECT id, platform, display_name, public_key_spki, fcm_token, revoked_at FROM devices WHERE id = ? AND revoked_at IS NULL",
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
  if (request.method === "POST" && url.pathname === "/v1/devices/enroll") return enroll(request, env);
  const body = request.method === "GET" || request.method === "HEAD" ? new Uint8Array() : await readBodyBytes(request.clone());
  const device = await authenticate(request, env, body);
  if (device.platform === "android") assertSupportedAndroidVersion(request);
  if (request.method === "GET" && url.pathname === "/v1/calls/current") {
    const call = await env.CALL_RELAY_DB.prepare(
      "SELECT * FROM call_sessions WHERE (android_device_id = ? OR peer_device_id = ?) AND state NOT IN ('ended', 'failed') ORDER BY created_at DESC LIMIT 1",
    ).bind(device.id, device.id).first<CallRow>();
    return json({ call: call ?? null });
  }
  if (request.method === "POST" && url.pathname === "/v1/devices/push-token") {
    if (device.platform !== "android") throw new HttpError(403, "push tokens are only accepted for Android");
    const tokenBody = await readJson<JsonObject>(request);
    const fcmToken = requireString(tokenBody.fcmToken, "fcmToken", 4096);
    await env.CALL_RELAY_DB.prepare("UPDATE devices SET fcm_token = ?, last_seen_at = ? WHERE id = ?")
      .bind(fcmToken, Date.now(), device.id).run();
    return json({ updated: true });
  }
  if (request.method === "POST" && url.pathname === "/v1/pairings") return pair(request, env, device);
  const pairingMatch = /^\/v1\/pairings\/(pair_[a-f0-9]{32})\/confirm$/u.exec(url.pathname);
  if (request.method === "POST" && pairingMatch) return confirmPairing(request, env, device, pairingMatch[1] ?? "");
  const signalTicketMatch = /^\/v1\/pairings\/(pair_[a-f0-9]{32})\/signal-ticket$/u.exec(url.pathname);
  if (request.method === "POST" && signalTicketMatch) return issueSignalTicket(env, device, signalTicketMatch[1] ?? "");
  if (request.method === "POST" && url.pathname === "/v1/calls/incoming") return createCall(request, env, ctx, device, "incoming");
  if (request.method === "POST" && url.pathname === "/v1/calls/outgoing") return createCall(request, env, ctx, device, "outgoing");
  const match = /^\/v1\/calls\/(call_[a-f0-9]{32})(?:\/(token|media-config|events))?$/u.exec(url.pathname);
  if (!match) throw new HttpError(404, "endpoint not found");
  const call = await getCall(env, match[1] ?? "");
  if (request.method === "GET" && !match[2]) {
    assertCallMember(call, device.id);
    return json({ call });
  }
  if (request.method === "POST" && match[2] === "token") return json({ error: "participant media tokens were removed; update the client" }, { status: 410 });
  if (request.method === "POST" && match[2] === "media-config") return callMediaConfig(env, call, device);
  if (request.method === "POST" && match[2] === "events") return appendEvent(request, env, ctx, call, device);
  throw new HttpError(405, "method not allowed");
}

function secureAssetResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' https: wss:; media-src 'self' blob:; worker-src 'self' blob:; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  headers.set("permissions-policy", "camera=(), microphone=(self), geolocation=()");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-frame-options", "DENY");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      if (request.method !== "GET") return json({ error: "method not allowed" }, { status: 405 });
      return json({ ok: true, audioStored: false, mediaTransport: "webrtc_p2p" });
    }
    if (!url.pathname.startsWith("/v1/")) return secureAssetResponse(await env.ASSETS.fetch(request));
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
        await deliverPush(env, message.body);
        message.ack();
      } catch (error) {
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
    await env.CALL_RELAY_DB.batch([
      env.CALL_RELAY_DB.prepare("DELETE FROM request_nonces WHERE created_at < ?").bind(nonceBefore),
      env.CALL_RELAY_DB.prepare("DELETE FROM push_outbox WHERE created_at < ?").bind(purgeBefore),
      env.CALL_RELAY_DB.prepare("DELETE FROM call_events WHERE call_id IN (SELECT id FROM call_sessions WHERE updated_at < ?)").bind(purgeBefore),
      env.CALL_RELAY_DB.prepare("DELETE FROM call_sessions WHERE updated_at < ?").bind(purgeBefore),
    ]);
  },
} satisfies ExportedHandler<Env, PushJob>;
