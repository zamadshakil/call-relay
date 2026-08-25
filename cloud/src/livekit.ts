import { base64Url } from "./http";
import type { CallRow, DeviceRow, Env } from "./types";
import { secretValue } from "./secrets";

function encode(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

export async function createLiveKitToken(env: Env, call: CallRow, device: DeviceRow): Promise<string> {
  const apiKey = await secretValue(env.LIVEKIT_API_KEY, "LIVEKIT_API_KEY");
  const apiSecret = await secretValue(env.LIVEKIT_API_SECRET, "LIVEKIT_API_SECRET");
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({
    iss: apiKey,
    sub: device.id,
    name: device.display_name,
    nbf: now - 5,
    exp: now + 10 * 60,
    video: {
      room: `call-${call.id}`,
      roomJoin: true,
      canPublish: true,
      canPublishSources: ["microphone"],
      canSubscribe: true,
      canPublishData: false,
    },
    metadata: JSON.stringify({ callId: call.id, platform: device.platform }),
  });
  const unsigned = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(apiSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(unsigned)));
  return `${unsigned}.${base64Url(signature)}`;
}
