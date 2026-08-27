import type { Env, PairingControlOutboxRow, PairingRevocationReason } from "./types";
import { revokeTurnCredentialsForPairing } from "./turn";

function id(): string {
  return `pctl_${crypto.randomUUID().replaceAll("-", "")}`;
}

export async function activePairingIdsForDevice(env: Env, deviceId: string): Promise<string[]> {
  const rows = await env.CALL_RELAY_DB.prepare(
    "SELECT id FROM pairings WHERE revoked_at IS NULL AND (device_a_id = ? OR device_b_id = ?)",
  ).bind(deviceId, deviceId).all<{ id: string }>();
  return rows.results.map((row) => row.id);
}

export function pairingRevocationStatements(
  env: Env,
  pairingIds: string[],
  reason: PairingRevocationReason,
  revokedAt: number,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const pairingId of pairingIds) {
    statements.push(
      env.CALL_RELAY_DB.prepare("UPDATE pairings SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .bind(revokedAt, pairingId),
      env.CALL_RELAY_DB.prepare(
        `UPDATE call_sessions
         SET state = 'failed', failure_code = 'pairing_revoked', media_failure_code = 'pairing_revoked',
             ended_at = COALESCE(ended_at, ?), updated_at = ?, version = version + 1
         WHERE pairing_id = ? AND state NOT IN ('ended', 'failed')`,
      ).bind(revokedAt, revokedAt, pairingId),
      env.CALL_RELAY_DB.prepare(
        `INSERT OR IGNORE INTO pairing_control_outbox(id, pairing_id, action, reason, created_at)
         SELECT ?, ?, 'revoke', ?, ? WHERE EXISTS (
           SELECT 1 FROM pairings WHERE id = ? AND revoked_at IS NOT NULL
         )`,
      ).bind(id(), pairingId, reason, revokedAt, pairingId),
    );
  }
  return statements;
}

export async function deliverPairingControlItem(env: Env, outboxId: string): Promise<void> {
  const row = await env.CALL_RELAY_DB.prepare(
    "SELECT * FROM pairing_control_outbox WHERE id = ? AND delivered_at IS NULL",
  ).bind(outboxId).first<PairingControlOutboxRow>();
  if (!row) return;
  try {
    // Recreate the stub for every delivery attempt. An RPC exception can poison
    // the prior stub, while the Durable Object method itself is idempotent.
    await env.PAIRING_SIGNAL.getByName(row.pairing_id).revokePairing(row.reason, row.created_at);
    // TURN rows are themselves a durable retry queue: a failed provider revoke
    // increments revoke_attempts and remains eligible for the scheduled drain.
    // Running it from this outbox also provides immediate best-effort cleanup.
    await revokeTurnCredentialsForPairing(env, row.pairing_id);
    await env.CALL_RELAY_DB.prepare(
      "UPDATE pairing_control_outbox SET delivered_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ? AND delivered_at IS NULL",
    ).bind(Date.now(), row.id).run();
  } catch (error) {
    await env.CALL_RELAY_DB.prepare(
      "UPDATE pairing_control_outbox SET attempts = attempts + 1, last_error = ? WHERE id = ? AND delivered_at IS NULL",
    ).bind(error instanceof Error ? error.message.slice(0, 500) : "unknown Durable Object failure", row.id).run();
    throw error;
  }
}

export async function deliverPairingRevocations(env: Env, pairingIds: string[]): Promise<void> {
  if (pairingIds.length === 0) return;
  const placeholders = pairingIds.map(() => "?").join(",");
  const rows = await env.CALL_RELAY_DB.prepare(
    `SELECT id FROM pairing_control_outbox
     WHERE delivered_at IS NULL AND pairing_id IN (${placeholders}) ORDER BY created_at`,
  ).bind(...pairingIds).all<{ id: string }>();
  for (const row of rows.results) {
    try {
      await deliverPairingControlItem(env, row.id);
    } catch (error) {
      console.error(JSON.stringify({
        message: "pairing revocation delivery failed",
        outboxId: row.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

export async function drainPairingControlOutbox(env: Env, limit = 25): Promise<void> {
  const pending = await env.CALL_RELAY_DB.prepare(
    "SELECT id FROM pairing_control_outbox WHERE delivered_at IS NULL ORDER BY created_at LIMIT ?",
  ).bind(limit).all<{ id: string }>();
  for (const row of pending.results) {
    try {
      await deliverPairingControlItem(env, row.id);
    } catch (error) {
      console.error(JSON.stringify({
        message: "pairing control outbox retry failed",
        outboxId: row.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}
