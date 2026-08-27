import { HttpError } from "./http";
import type { Env, PushJob, PushOutboxRow } from "./types";

function parsePushJob(row: PushOutboxRow): PushJob {
  const value: unknown = JSON.parse(row.payload_json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(500, "invalid push outbox payload");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.targetDeviceId !== "string" || typeof record.data !== "object" || record.data === null || Array.isArray(record.data)) {
    throw new HttpError(500, "invalid push outbox payload");
  }
  const data: Record<string, string> = {};
  for (const [key, item] of Object.entries(record.data as Record<string, unknown>)) {
    if (typeof item !== "string") throw new HttpError(500, "invalid push outbox data");
    data[key] = item;
  }
  return { outboxId: row.id, channel: row.channel, targetDeviceId: record.targetDeviceId, data };
}

export async function dispatchOutboxItem(env: Env, outboxId: string): Promise<void> {
  const row = await env.CALL_RELAY_DB.prepare(
    "SELECT id, target_device_id, channel, payload_json, attempts FROM push_outbox WHERE id = ? AND queued_at IS NULL",
  ).bind(outboxId).first<PushOutboxRow>();
  if (!row) return;
  try {
    await env.PUSH_QUEUE.send(parsePushJob(row));
    await env.CALL_RELAY_DB.prepare(
      "UPDATE push_outbox SET queued_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ? AND queued_at IS NULL",
    ).bind(Date.now(), outboxId).run();
  } catch (error) {
    await env.CALL_RELAY_DB.prepare(
      "UPDATE push_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ? AND queued_at IS NULL",
    ).bind(error instanceof Error ? error.message.slice(0, 500) : "unknown enqueue failure", outboxId).run();
    throw error;
  }
}

export async function drainOutbox(env: Env, limit = 25): Promise<void> {
  const pending = await env.CALL_RELAY_DB.prepare(
    "SELECT id FROM push_outbox WHERE queued_at IS NULL ORDER BY created_at LIMIT ?",
  ).bind(limit).all<{ id: string }>();
  for (const row of pending.results) {
    try {
      await dispatchOutboxItem(env, row.id);
    } catch (error) {
      console.error(JSON.stringify({ message: "push outbox enqueue failed", outboxId: row.id, error: error instanceof Error ? error.message : String(error) }));
    }
  }
}
