import { HttpError, sha256Hex } from "./http";
import { secretValue } from "./secrets";
import type { CallRow, DeviceRow, Env, IceServerConfig, TurnCredentialRow } from "./types";

const TURN_API_ORIGIN = "https://rtc.live.cloudflare.com";
const TURN_TTL_SECONDS = 2 * 60 * 60;
const TURN_REQUEST_TIMEOUT_MS = 5_000;

interface CloudflareIceResponse {
  iceServers?: unknown;
  username?: unknown;
  credential?: unknown;
}

const CLOUDFLARE_STUN_URLS = ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"];
const CLOUDFLARE_TURN_URLS = [
  "turn:turn.cloudflare.com:3478?transport=udp",
  "turn:turn.cloudflare.com:53?transport=udp",
  "turn:turn.cloudflare.com:3478?transport=tcp",
  "turn:turn.cloudflare.com:80?transport=tcp",
  "turns:turn.cloudflare.com:5349?transport=tcp",
  "turns:turn.cloudflare.com:443?transport=tcp",
];

function validIceUrl(value: string): boolean {
  return /^(?:stun|turn|turns):[^\s]+$/u.test(value);
}

function validateIceServers(value: unknown): IceServerConfig[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 8) {
    throw new Error("Cloudflare TURN returned an invalid iceServers list");
  }
  const servers = value.map((entry): IceServerConfig => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error("invalid ICE server entry");
    const record = entry as Record<string, unknown>;
    const urls = typeof record.urls === "string"
      ? record.urls
      : Array.isArray(record.urls) && record.urls.every((url) => typeof url === "string")
        ? record.urls as string[]
        : undefined;
    const allUrls = typeof urls === "string" ? [urls] : urls;
    if (!allUrls || allUrls.length === 0 || allUrls.length > 16 || !allUrls.every(validIceUrl)) {
      throw new Error("invalid ICE server URLs");
    }
    const username = typeof record.username === "string" ? record.username : undefined;
    const credential = typeof record.credential === "string" ? record.credential : undefined;
    if (allUrls.some((url) => url.startsWith("turn")) && (!username || !credential)) {
      throw new Error("TURN server credentials are missing");
    }
    return { urls: urls as string | string[], ...(username ? { username } : {}), ...(credential ? { credential } : {}) };
  });
  if (!servers.some((server) => (typeof server.urls === "string" ? [server.urls] : server.urls).some((url) => url.startsWith("turn")))) {
    throw new Error("Cloudflare response does not contain a TURN server");
  }
  return servers;
}

function iceServersFromCredential(body: CloudflareIceResponse): IceServerConfig[] {
  if (body.iceServers !== undefined) return validateIceServers(body.iceServers);
  if (typeof body.username !== "string" || !body.username || typeof body.credential !== "string" || !body.credential) {
    throw new Error("Cloudflare TURN returned invalid credentials");
  }
  return [
    { urls: CLOUDFLARE_STUN_URLS },
    { urls: CLOUDFLARE_TURN_URLS, username: body.username, credential: body.credential },
  ];
}

async function turnApi(env: Env, path: string, init: RequestInit): Promise<Response> {
  const token = await secretValue(env.CF_TURN_API_TOKEN, "CF_TURN_API_TOKEN");
  return fetch(`${TURN_API_ORIGIN}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
    signal: AbortSignal.timeout(TURN_REQUEST_TIMEOUT_MS),
  });
}

export async function createMediaConfig(env: Env, call: CallRow, device: DeviceRow): Promise<{
  transport: "webrtc_p2p";
  offerer: "android";
  iceTransportPolicy: "all";
  iceServers: IceServerConfig[];
  credentialsExpiresAt: number;
  protocolVersion: 1;
}> {
  const keyId = await secretValue(env.CF_TURN_KEY_ID, "CF_TURN_KEY_ID");
  const customIdentifier = (await sha256Hex(new TextEncoder().encode(`${call.id}:${device.id === call.android_device_id ? "android" : "peer"}`))).slice(0, 32);
  let response: Response | undefined;
  let lastError: unknown;
  for (const delay of [0, 250]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      response = await turnApi(env, `/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate`, {
        method: "POST",
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS, customIdentifier }),
      });
      if (response.ok) break;
      lastError = new Error(`Cloudflare TURN credential request failed (${response.status})`);
    } catch (error) {
      lastError = error;
    }
  }
  if (!response?.ok) {
    console.error(JSON.stringify({ message: "TURN credential generation failed", status: response?.status ?? null }));
    throw new HttpError(503, lastError instanceof Error ? lastError.message : "Cloudflare TURN is unavailable");
  }
  const body = await response.json<CloudflareIceResponse>();
  const iceServers = iceServersFromCredential(body);
  const username = iceServers.find((server) => server.username)?.username;
  if (!username) throw new HttpError(503, "Cloudflare TURN response did not include a username");
  const now = Date.now();
  const expiresAt = now + TURN_TTL_SECONDS * 1000;
  await env.CALL_RELAY_DB.batch([
    env.CALL_RELAY_DB.prepare(
      `INSERT INTO turn_credentials(username, call_id, device_id, custom_identifier, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(username) DO NOTHING`,
    ).bind(username, call.id, device.id, customIdentifier, now, expiresAt),
    env.CALL_RELAY_DB.prepare(
      "UPDATE call_sessions SET media_transport = 'webrtc_p2p', ice_policy = 'all', updated_at = ? WHERE id = ?",
    ).bind(now, call.id),
  ]);
  return {
    transport: "webrtc_p2p",
    offerer: "android",
    iceTransportPolicy: "all",
    iceServers,
    credentialsExpiresAt: expiresAt,
    protocolVersion: 1,
  };
}

async function revokeOne(env: Env, credential: TurnCredentialRow): Promise<void> {
  const keyId = await secretValue(env.CF_TURN_KEY_ID, "CF_TURN_KEY_ID");
  try {
    const response = await turnApi(
      env,
      `/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/${encodeURIComponent(credential.username)}/revoke`,
      { method: "POST", body: "{}" },
    );
    if (!response.ok && response.status !== 404) throw new Error(`Cloudflare TURN revoke failed (${response.status})`);
    await env.CALL_RELAY_DB.prepare("UPDATE turn_credentials SET revoked_at = ?, last_error = NULL WHERE username = ?")
      .bind(Date.now(), credential.username).run();
  } catch (error) {
    await env.CALL_RELAY_DB.prepare(
      "UPDATE turn_credentials SET revoke_attempts = revoke_attempts + 1, last_error = ? WHERE username = ?",
    ).bind(error instanceof Error ? error.message.slice(0, 200) : "unknown revoke error", credential.username).run();
    throw error;
  }
}

export async function revokeTurnCredentialsForCall(env: Env, callId: string): Promise<void> {
  const credentials = await env.CALL_RELAY_DB.prepare(
    "SELECT * FROM turn_credentials WHERE call_id = ? AND revoked_at IS NULL LIMIT 20",
  ).bind(callId).all<TurnCredentialRow>();
  await Promise.allSettled(credentials.results.map((credential) => revokeOne(env, credential)));
}

export async function revokeDueTurnCredentials(env: Env): Promise<void> {
  const credentials = await env.CALL_RELAY_DB.prepare(
    `SELECT tc.* FROM turn_credentials tc
     JOIN call_sessions cs ON cs.id = tc.call_id
     WHERE tc.revoked_at IS NULL
       AND (tc.expires_at < ? OR cs.state IN ('ended', 'failed'))
       AND tc.revoke_attempts < 10
     ORDER BY tc.created_at LIMIT 50`,
  ).bind(Date.now()).all<TurnCredentialRow>();
  await Promise.allSettled(credentials.results.map((credential) => revokeOne(env, credential)));
}
