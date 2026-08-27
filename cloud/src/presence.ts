import { HttpError, json, readJson, requireString } from "./http";
import type { DevicePresenceRow, DeviceRow, Env, SignalState } from "./types";

type JsonObject = Record<string, unknown>;

export const RELAY_HEARTBEAT_FRESH_MS = 75_000;

function requireTimestamp(value: unknown, name: string, now: number): number {
  const timestamp = Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > now + 5 * 60 * 1000) {
    throw new HttpError(400, `${name} must be a Unix epoch timestamp in milliseconds`, "INVALID_HEARTBEAT");
  }
  return timestamp;
}

export async function recordDeviceHeartbeat(request: Request, env: Env, device: DeviceRow, pathDeviceId: string): Promise<Response> {
  if (pathDeviceId !== device.id) {
    throw new HttpError(403, "a device may update only its own relay heartbeat", "DEVICE_MISMATCH");
  }
  if (device.platform !== "android") {
    throw new HttpError(403, "relay heartbeats belong to Android relay devices", "PLATFORM_NOT_SUPPORTED");
  }

  const body = await readJson<JsonObject>(request);
  const serviceInstanceId = requireString(body.serviceInstanceId, "serviceInstanceId", 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(serviceInstanceId)) {
    throw new HttpError(400, "serviceInstanceId must be a UUID v4", "INVALID_HEARTBEAT");
  }
  const sequence = Number(body.sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new HttpError(400, "sequence must be a positive integer", "INVALID_HEARTBEAT");
  }
  if (typeof body.relayReady !== "boolean") {
    throw new HttpError(400, "relayReady must be a boolean", "INVALID_HEARTBEAT");
  }
  const signalState = requireString(body.signalState, "signalState", 32).toLowerCase() as SignalState;
  if (!(["connecting", "connected", "disconnected"] satisfies SignalState[]).includes(signalState)) {
    throw new HttpError(400, "signalState is invalid", "INVALID_HEARTBEAT");
  }
  const now = Date.now();
  const processStartedAt = requireTimestamp(body.processStartedAt, "processStartedAt", now);

  let activeCallId: string | null = null;
  if (body.activeCallId !== undefined && body.activeCallId !== null) {
    activeCallId = requireString(body.activeCallId, "activeCallId", 80);
    if (!/^call_[a-f0-9]{32}$/u.test(activeCallId)) {
      throw new HttpError(400, "activeCallId is invalid", "INVALID_HEARTBEAT");
    }
    const call = await env.CALL_RELAY_DB.prepare("SELECT id FROM call_sessions WHERE id = ? AND android_device_id = ?")
      .bind(activeCallId, device.id).first<{ id: string }>();
    if (!call) throw new HttpError(409, "activeCallId does not belong to this Android relay", "ACTIVE_CALL_MISMATCH");
  }

  let lastErrorCode: string | null = null;
  if (body.lastErrorCode !== undefined && body.lastErrorCode !== null) {
    lastErrorCode = requireString(body.lastErrorCode, "lastErrorCode", 80);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(lastErrorCode)) {
      throw new HttpError(400, "lastErrorCode is invalid", "INVALID_HEARTBEAT");
    }
  }

  const result = await env.CALL_RELAY_DB.prepare(
    `INSERT INTO device_presence(
       device_id, service_instance_id, sequence, relay_ready, signal_state, active_call_id,
       process_started_at, last_heartbeat_at, last_error_code, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET
       service_instance_id = excluded.service_instance_id,
       sequence = excluded.sequence,
       relay_ready = excluded.relay_ready,
       signal_state = excluded.signal_state,
       active_call_id = excluded.active_call_id,
       process_started_at = excluded.process_started_at,
       last_heartbeat_at = excluded.last_heartbeat_at,
       last_error_code = excluded.last_error_code,
       updated_at = excluded.updated_at
     WHERE excluded.process_started_at > device_presence.process_started_at
        OR (
          excluded.process_started_at = device_presence.process_started_at
          AND excluded.service_instance_id = device_presence.service_instance_id
          AND excluded.sequence > device_presence.sequence
        )`,
  ).bind(
    device.id,
    serviceInstanceId,
    sequence,
    body.relayReady ? 1 : 0,
    signalState,
    activeCallId,
    processStartedAt,
    now,
    lastErrorCode,
    now,
  ).run();

  if (result.meta.changes !== 1) {
    const current = await env.CALL_RELAY_DB.prepare("SELECT * FROM device_presence WHERE device_id = ?")
      .bind(device.id).first<DevicePresenceRow>();
    if (current && (processStartedAt < current.process_started_at || current.service_instance_id !== serviceInstanceId)) {
      throw new HttpError(409, "heartbeat belongs to a stale relay service instance", "STALE_SERVICE_INSTANCE");
    }
    throw new HttpError(409, "heartbeat sequence has already been used", "HEARTBEAT_REPLAY");
  }

  return json({ accepted: true, duplicate: false, heartbeatAt: now, freshForMs: RELAY_HEARTBEAT_FRESH_MS });
}
