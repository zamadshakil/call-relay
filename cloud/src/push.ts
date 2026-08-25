import { importPKCS8, SignJWT } from "jose";
import type { Env, PushJob } from "./types";
import { secretValue } from "./secrets";

async function googleAccessToken(env: Env): Promise<string> {
  if (env.FCM_PROJECT_ID === "replace-me") {
    throw new Error("FCM credentials are not configured");
  }
  const clientEmail = await secretValue(env.FCM_CLIENT_EMAIL, "FCM_CLIENT_EMAIL");
  const privateKey = await secretValue(env.FCM_PRIVATE_KEY, "FCM_PRIVATE_KEY");
  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(privateKey.replaceAll("\\n", "\n"), "RS256");
  const assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/firebase.messaging" })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(clientEmail)
    .setSubject(clientEmail)
    .setAudience("https://oauth2.googleapis.com/token")
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!response.ok) throw new Error(`FCM OAuth failed (${response.status})`);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || !("access_token" in value) || typeof value.access_token !== "string") {
    throw new Error("FCM OAuth returned an invalid access token response");
  }
  return value.access_token;
}

export async function deliverPush(env: Env, job: PushJob): Promise<void> {
  const device = await env.CALL_RELAY_DB.prepare(
    "SELECT fcm_token FROM devices WHERE id = ? AND revoked_at IS NULL",
  ).bind(job.targetDeviceId).first<{ fcm_token: string | null }>();
  if (!device?.fcm_token) return;
  const accessToken = await googleAccessToken(env);
  const response = await fetch(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(env.FCM_PROJECT_ID)}/messages:send`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        message: {
          fid: device.fcm_token,
          data: job.data,
          android: { priority: "high", ttl: "30s" },
        },
      }),
    },
  );
  if (!response.ok) {
    const errorText = (await response.text()).slice(0, 2_000);
    if (response.status === 404 || errorText.includes("UNREGISTERED")) {
      await env.CALL_RELAY_DB.prepare("UPDATE devices SET fcm_token = NULL WHERE id = ?")
        .bind(job.targetDeviceId).run();
      return;
    }
    throw new Error(`FCM delivery failed (${response.status}): ${errorText}`);
  }
}
