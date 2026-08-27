import webpush from "web-push";
import { base64Url, fromBase64Url, HttpError, json, readJson, requireString } from "./http";
import { secretValue } from "./secrets";
import type { DeviceRow, Env, PushDeliveryResult } from "./types";

interface WebPushSubscriptionData {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

interface StoredSubscription {
  subscription_ciphertext: string;
  subscription_iv: string;
}

type JsonObject = Record<string, unknown>;

function allowedPushHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "fcm.googleapis.com" ||
    host.endsWith(".push.apple.com") ||
    host.endsWith(".push.services.mozilla.com");
}

function parseSubscription(body: JsonObject): WebPushSubscriptionData {
  const endpoint = requireString(body.endpoint, "endpoint", 2_048);
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new HttpError(400, "push endpoint is invalid");
  }
  if (url.protocol !== "https:" || !allowedPushHost(url.hostname)) {
    throw new HttpError(400, "push endpoint provider is unsupported");
  }
  if (typeof body.keys !== "object" || body.keys === null || Array.isArray(body.keys)) {
    throw new HttpError(400, "push subscription keys are required");
  }
  const keys = body.keys as Record<string, unknown>;
  const p256dh = requireString(keys.p256dh, "p256dh", 256);
  const auth = requireString(keys.auth, "auth", 128);
  if (!/^[A-Za-z0-9_-]+$/u.test(p256dh) || !/^[A-Za-z0-9_-]+$/u.test(auth)) {
    throw new HttpError(400, "push subscription keys are invalid");
  }
  const expirationTime = body.expirationTime === null || body.expirationTime === undefined
    ? null
    : Number(body.expirationTime);
  if (expirationTime !== null && (!Number.isSafeInteger(expirationTime) || expirationTime <= Date.now())) {
    throw new HttpError(400, "push subscription is already expired");
  }
  return { endpoint: url.toString(), expirationTime, keys: { p256dh, auth } };
}

async function encryptionKey(env: Env): Promise<CryptoKey> {
  const encoded = await secretValue(env.PUSH_SUBSCRIPTION_ENCRYPTION_KEY, "PUSH_SUBSCRIPTION_ENCRYPTION_KEY");
  const bytes = fromBase64Url(encoded);
  if (bytes.byteLength !== 32) throw new Error("PUSH_SUBSCRIPTION_ENCRYPTION_KEY must encode 32 bytes");
  return crypto.subtle.importKey("raw", bytes.buffer as ArrayBuffer, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptSubscription(env: Env, deviceId: string, subscription: WebPushSubscriptionData): Promise<{ ciphertext: string; iv: string }> {
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(subscription));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(deviceId) },
    key,
    plaintext,
  ));
  return { ciphertext: base64Url(ciphertext), iv: base64Url(iv) };
}

async function decryptSubscription(env: Env, deviceId: string, row: StoredSubscription): Promise<WebPushSubscriptionData> {
  const key = await encryptionKey(env);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64Url(row.subscription_iv).buffer as ArrayBuffer,
      additionalData: new TextEncoder().encode(deviceId),
    },
    key,
    fromBase64Url(row.subscription_ciphertext).buffer as ArrayBuffer,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as WebPushSubscriptionData;
}

export function webPushConfig(env: Env): Response {
  if (!env.VAPID_PUBLIC_KEY || !/^[A-Za-z0-9_-]{80,120}$/u.test(env.VAPID_PUBLIC_KEY)) {
    throw new HttpError(503, "incoming notifications are not configured");
  }
  return json({ vapidPublicKey: env.VAPID_PUBLIC_KEY });
}

export async function saveWebPushSubscription(request: Request, env: Env, device: DeviceRow): Promise<Response> {
  if (device.platform !== "browser") throw new HttpError(403, "Web Push belongs to the paired browser");
  const subscription = parseSubscription(await readJson<JsonObject>(request));
  const endpointHash = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(subscription.endpoint))));
  const encrypted = await encryptSubscription(env, device.id, subscription);
  const now = Date.now();
  await env.CALL_RELAY_DB.prepare(
    `INSERT INTO web_push_subscriptions(device_id, endpoint_hash, subscription_ciphertext, subscription_iv, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_id) DO UPDATE SET endpoint_hash = excluded.endpoint_hash,
       subscription_ciphertext = excluded.subscription_ciphertext, subscription_iv = excluded.subscription_iv,
       updated_at = excluded.updated_at`,
  ).bind(device.id, endpointHash, encrypted.ciphertext, encrypted.iv, now, now).run();
  return json({ subscribed: true });
}

export async function deleteWebPushSubscription(env: Env, device: DeviceRow): Promise<Response> {
  if (device.platform !== "browser") throw new HttpError(403, "Web Push belongs to the paired browser");
  await env.CALL_RELAY_DB.prepare("DELETE FROM web_push_subscriptions WHERE device_id = ?").bind(device.id).run();
  return json({ subscribed: false });
}

export async function deliverWebPush(
  env: Env,
  targetDeviceId: string,
  data: Record<string, string>,
): Promise<PushDeliveryResult> {
  const row = await env.CALL_RELAY_DB.prepare(
    "SELECT subscription_ciphertext, subscription_iv FROM web_push_subscriptions WHERE device_id = ?",
  ).bind(targetDeviceId).first<StoredSubscription>();
  if (!row) return { accepted: false, gone: false };
  const subscription = await decryptSubscription(env, targetDeviceId, row);
  const callId = data.callId ?? "";
  const payload = JSON.stringify({
    title: "Incoming Call Relay call",
    body: "Open Call Relay to answer from your Android SIM.",
    tag: callId ? `incoming-${callId}` : "incoming-call",
    url: callId ? `/?call=${encodeURIComponent(callId)}` : "/",
  });
  try {
    const response = await webpush.sendNotification(subscription, payload, {
      TTL: 30,
      urgency: "high",
      topic: callId ? `call-${callId.slice(-24)}` : "incoming-call",
      vapidDetails: {
        subject: env.VAPID_SUBJECT,
        publicKey: env.VAPID_PUBLIC_KEY,
        privateKey: await secretValue(env.VAPID_PRIVATE_KEY, "VAPID_PRIVATE_KEY"),
      },
    });
    const location = response.headers.location;
    return { accepted: true, gone: false, ...(typeof location === "string" ? { providerMessageId: location.slice(0, 500) } : {}) };
  } catch (error) {
    if (error instanceof webpush.WebPushError && (error.statusCode === 404 || error.statusCode === 410)) {
      await env.CALL_RELAY_DB.prepare("DELETE FROM web_push_subscriptions WHERE device_id = ?").bind(targetDeviceId).run();
      return { accepted: false, gone: true };
    }
    throw error;
  }
}
