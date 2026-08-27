import type { Env, PushJob } from "./types";
import { googleAccessToken } from "./google-oauth";

export async function deliverPush(env: Env, job: PushJob): Promise<void> {
  const device = await env.CALL_RELAY_DB.prepare(
    "SELECT fcm_token, fcm_target_kind FROM devices WHERE id = ? AND revoked_at IS NULL",
  ).bind(job.targetDeviceId).first<{ fcm_token: string | null; fcm_target_kind: "token" | "fid" }>();
  if (!device?.fcm_token) return;
  const accessToken = await googleAccessToken(env, ["https://www.googleapis.com/auth/firebase.messaging"]);
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
          [device.fcm_target_kind]: device.fcm_token,
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
