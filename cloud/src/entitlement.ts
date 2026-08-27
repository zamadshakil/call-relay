import { HttpError } from "./http";
import type { DeviceRow, Env } from "./types";

export async function requireDeviceEntitlement(env: Env, device: DeviceRow): Promise<void> {
  if (device.user_id === null) {
    if (env.ONBOARDING_V2_ENABLED === "true") throw new HttpError(403, "this legacy device must be re-enrolled with Google");
    return;
  }
  const row = await env.CALL_RELAY_DB.prepare(
    `SELECT ae.status AS approval_status, bs.status AS subscription_status, bs.current_period_ends_at
     FROM firebase_users fu
     LEFT JOIN approved_emails ae ON ae.email = fu.email COLLATE NOCASE
     LEFT JOIN billing_subscriptions bs ON bs.user_id = fu.id
     WHERE fu.id = ?`,
  ).bind(device.user_id).first<{
    approval_status: "approved" | "suspended" | null;
    subscription_status: string | null;
    current_period_ends_at: number | null;
  }>();
  if (row?.approval_status !== "approved") throw new HttpError(403, "an approved account is required");
  if (env.ACCESS_MODE === "approval_only") return;
  const active = row.subscription_status === "active" &&
    (row.current_period_ends_at === null || row.current_period_ends_at > Date.now());
  if (!active) throw new HttpError(402, "an active paid subscription is required");
}

export async function assertSameAccount(env: Env, firstDeviceId: string, secondDeviceId: string): Promise<string> {
  const rows = await env.CALL_RELAY_DB.prepare(
    "SELECT id, user_id FROM devices WHERE id IN (?, ?) AND revoked_at IS NULL",
  ).bind(firstDeviceId, secondDeviceId).all<{ id: string; user_id: string | null }>();
  if (rows.results.length !== 2) throw new HttpError(404, "device is unavailable");
  const first = rows.results.find((row) => row.id === firstDeviceId);
  const second = rows.results.find((row) => row.id === secondDeviceId);
  if (!first?.user_id || first.user_id !== second?.user_id) throw new HttpError(403, "both devices must use the same Google account");
  return first.user_id;
}
