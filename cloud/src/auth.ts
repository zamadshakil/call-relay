import { fromBase64Url, HttpError, sha256Hex } from "./http";
import type { DeviceRow, Env } from "./types";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export async function authenticate(request: Request, env: Env, body: Uint8Array): Promise<DeviceRow> {
  const deviceId = request.headers.get("x-relay-device") ?? "";
  const timestampText = request.headers.get("x-relay-timestamp") ?? "";
  const nonce = request.headers.get("x-relay-nonce") ?? "";
  const signatureText = request.headers.get("x-relay-signature") ?? "";
  const timestamp = Number(timestampText);

  if (!deviceId || deviceId.length > 80 || !nonce || nonce.length > 128 || !signatureText || signatureText.length > 128 || !Number.isSafeInteger(timestamp)) {
    throw new HttpError(401, "missing or invalid request signature headers", "INVALID_DEVICE_SIGNATURE");
  }
  if (Math.abs(Date.now() - timestamp) > MAX_CLOCK_SKEW_MS) {
    throw new HttpError(401, "request timestamp is outside the allowed window", "DEVICE_CLOCK_SKEW");
  }

  const device = await env.CALL_RELAY_DB.prepare(
    `SELECT id, platform, display_name, public_key_spki, fcm_token, fcm_target_kind, revoked_at, user_id,
      agreement_public_key_raw, app_version FROM devices WHERE id = ?`,
  ).bind(deviceId).first<DeviceRow>();
  if (!device) throw new HttpError(401, "device is not registered", "DEVICE_NOT_FOUND");

  const url = new URL(request.url);
  const bodyHash = await sha256Hex(body);
  const canonical = `${request.method.toUpperCase()}\n${url.pathname}${url.search}\n${bodyHash}\n${timestampText}\n${nonce}`;
  const verified = await (async (): Promise<boolean> => {
    try {
      const key = await crypto.subtle.importKey(
        "spki",
        fromBase64Url(device.public_key_spki).buffer as ArrayBuffer,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["verify"],
      );
      return await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        key,
        fromBase64Url(signatureText).buffer as ArrayBuffer,
        new TextEncoder().encode(canonical),
      );
    } catch {
      return false;
    }
  })();
  if (!verified) throw new HttpError(401, "invalid request signature", "INVALID_DEVICE_SIGNATURE");
  if (device.revoked_at !== null) {
    throw new HttpError(410, "this device registration has been revoked", "DEVICE_REVOKED");
  }

  const nonceResult = await env.CALL_RELAY_DB.prepare(
    "INSERT OR IGNORE INTO request_nonces(device_id, nonce, created_at) VALUES (?, ?, ?)",
  ).bind(deviceId, nonce, Date.now()).run();
  if (nonceResult.meta.changes !== 1) {
    throw new HttpError(409, "request nonce has already been used", "REQUEST_REPLAY");
  }
  await env.CALL_RELAY_DB.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?")
    .bind(Date.now(), deviceId).run();
  return device;
}
