import { DurableObject } from "cloudflare:workers";
import type { Env, SignalRole } from "./types";

const MAX_SIGNAL_BYTES = 64 * 1024;
const ALLOWED_TYPES = new Set([
  "offer",
  "answer",
  "ice_candidates",
  "ice_complete",
  "ice_restart_request",
  "media_ready",
  "media_failed",
]);

interface SocketAttachment {
  deviceId: string;
  role: SignalRole;
  sessionId: string;
  lastSequence: number;
}

interface SignalEnvelope {
  version: number;
  callId: string;
  senderDeviceId: string;
  role: SignalRole;
  sessionId: string;
  sequence: number;
  timestamp: number;
  type: string;
  payload: string;
  mac: string;
}

function parseEnvelope(message: string): SignalEnvelope {
  const value: unknown = JSON.parse(message);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("signal envelope must be an object");
  const envelope = value as Record<string, unknown>;
  if (
    envelope.version !== 1 ||
    typeof envelope.callId !== "string" || !/^call_[a-f0-9]{32}$/u.test(envelope.callId) ||
    typeof envelope.senderDeviceId !== "string" ||
    (envelope.role !== "android" && envelope.role !== "peer") ||
    typeof envelope.sessionId !== "string" ||
    typeof envelope.sequence !== "number" || !Number.isSafeInteger(envelope.sequence) || envelope.sequence < 1 ||
    typeof envelope.timestamp !== "number" || !Number.isSafeInteger(envelope.timestamp) ||
    typeof envelope.type !== "string" || !ALLOWED_TYPES.has(envelope.type) ||
    typeof envelope.payload !== "string" || envelope.payload.length > 60 * 1024 ||
    typeof envelope.mac !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(envelope.mac)
  ) throw new Error("signal envelope is invalid");
  return envelope as unknown as SignalEnvelope;
}

export class PairingSignal extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS used_tickets (
          jti TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pairing_state (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          active_call_id TEXT,
          call_version INTEGER,
          snapshot_json TEXT
        );
      `);
    });
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("websocket upgrade required", { status: 426 });
    const deviceId = request.headers.get("x-relay-signal-device") ?? "";
    const role = request.headers.get("x-relay-signal-role") as SignalRole | null;
    const jti = request.headers.get("x-relay-signal-jti") ?? "";
    const ticketExpiresAt = Number(request.headers.get("x-relay-signal-exp") ?? "0");
    if (!deviceId || (role !== "android" && role !== "peer") || !jti || !Number.isSafeInteger(ticketExpiresAt) || ticketExpiresAt < Date.now()) {
      return new Response("invalid signaling identity", { status: 401 });
    }
    this.ctx.storage.sql.exec("DELETE FROM used_tickets WHERE expires_at < ?", Date.now());
    if (this.ctx.storage.sql.exec<{ jti: string }>("SELECT jti FROM used_tickets WHERE jti = ?", jti).toArray()[0]) {
      return new Response("signaling ticket has already been used", { status: 409 });
    }
    this.ctx.storage.sql.exec("INSERT INTO used_tickets(jti, expires_at) VALUES (?, ?)", jti, ticketExpiresAt);

    for (const existing of this.ctx.getWebSockets()) {
      const attachment = existing.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.role === role) existing.close(4001, "replaced by a newer connection");
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: SocketAttachment = {
      deviceId,
      role,
      sessionId: crypto.randomUUID(),
      lastSequence: 0,
    };
    server.serializeAttachment(attachment);
    this.ctx.acceptWebSocket(server, [role]);
    server.send(JSON.stringify({ type: "hello", protocolVersion: 1, sessionId: attachment.sessionId, role }));
    const state = this.ctx.storage.sql.exec<{ snapshot_json: string | null }>("SELECT snapshot_json FROM pairing_state WHERE singleton = 1").toArray()[0];
    if (state?.snapshot_json) server.send(JSON.stringify({ type: "call_snapshot", call: JSON.parse(state.snapshot_json) }));
    this.broadcastPresence();
    return new Response(null, { status: 101, webSocket: client, headers: { "sec-websocket-protocol": "call-relay.signal.v1" } });
  }

  async publishSnapshot(snapshotJson: string): Promise<void> {
    const call = JSON.parse(snapshotJson) as { id?: unknown; state?: unknown; version?: unknown; created_at?: unknown };
    if (
      typeof call.id !== "string" || !/^call_[a-f0-9]{32}$/u.test(call.id) ||
      typeof call.version !== "number" || !Number.isSafeInteger(call.version) || call.version < 0 ||
      typeof call.created_at !== "number" || !Number.isSafeInteger(call.created_at)
    ) throw new Error("call snapshot is invalid");
    const existingState = this.ctx.storage.sql.exec<{ snapshot_json: string | null }>(
      "SELECT snapshot_json FROM pairing_state WHERE singleton = 1",
    ).toArray()[0];
    if (existingState?.snapshot_json) {
      const existing = JSON.parse(existingState.snapshot_json) as { id?: unknown; version?: unknown; created_at?: unknown };
      if (existing.id === call.id && typeof existing.version === "number" && existing.version >= call.version) return;
      if (existing.id !== call.id && typeof existing.created_at === "number" && existing.created_at > call.created_at) return;
    }
    const terminal = call.state === "ended" || call.state === "failed";
    const callId = !terminal ? call.id : null;
    const version = call.version;
    this.ctx.storage.sql.exec(
      `INSERT INTO pairing_state(singleton, active_call_id, call_version, snapshot_json) VALUES (1, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET active_call_id = excluded.active_call_id,
       call_version = excluded.call_version, snapshot_json = excluded.snapshot_json`,
      callId,
      version,
      snapshotJson,
    );
    const message = JSON.stringify({ type: "call_snapshot", call });
    for (const socket of this.ctx.getWebSockets()) socket.send(message);
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    try {
      if (typeof message !== "string" || new TextEncoder().encode(message).byteLength > MAX_SIGNAL_BYTES) throw new Error("signal frame is too large");
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment) throw new Error("socket identity is missing");
      const envelope = parseEnvelope(message);
      const active = this.ctx.storage.sql.exec<{ active_call_id: string | null }>("SELECT active_call_id FROM pairing_state WHERE singleton = 1").toArray()[0];
      if (!active?.active_call_id || envelope.callId !== active.active_call_id) throw new Error("signal does not belong to the active call");
      if (
        envelope.senderDeviceId !== attachment.deviceId ||
        envelope.role !== attachment.role ||
        envelope.sessionId !== attachment.sessionId ||
        envelope.sequence <= attachment.lastSequence ||
        Math.abs(Date.now() - envelope.timestamp) > 5 * 60 * 1000
      ) throw new Error("signal sender or sequence is invalid");
      if (envelope.type === "offer" && attachment.role !== "android") throw new Error("only Android may create offers");
      if (envelope.type === "answer" && attachment.role !== "peer") throw new Error("only the peer may answer offers");
      attachment.lastSequence = envelope.sequence;
      socket.serializeAttachment(attachment);
      for (const peer of this.ctx.getWebSockets()) {
        if (peer !== socket) peer.send(message);
      }
    } catch (error) {
      socket.send(JSON.stringify({ type: "protocol_error", message: error instanceof Error ? error.message : "invalid signaling message" }));
    }
  }

  override webSocketClose(socket: WebSocket, code: number, reason: string, wasClean: boolean): void {
    socket.close(code, reason);
    this.broadcastPresence();
    if (!wasClean) console.warn(JSON.stringify({ message: "signaling websocket closed uncleanly", code }));
  }

  override webSocketError(socket: WebSocket): void {
    socket.close(1011, "signaling websocket error");
    this.broadcastPresence();
  }

  private broadcastPresence(): void {
    const sockets = this.ctx.getWebSockets();
    const roles = new Set(sockets.map((socket) => (socket.deserializeAttachment() as SocketAttachment | null)?.role).filter(Boolean));
    const message = JSON.stringify({ type: "presence", android: roles.has("android"), peer: roles.has("peer") });
    for (const socket of sockets) socket.send(message);
  }
}
