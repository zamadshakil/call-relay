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
  if (body.iceServers !== undefined) {
    // The standard endpoint returns an array, while the tagged-credential
    // endpoint currently returns one ICE server object under the same field.
    const servers = validateIceServers(Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers]);
    const hasStun = servers.some((server) =>
      (typeof server.urls === "string" ? [server.urls] : server.urls).some((url) => url.startsWith("stun:")),
    );
    return hasStun ? servers : [{ urls: CLOUDFLARE_STUN_URLS }, ...servers];
  }
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
  const credential: TurnCredentialRow = {
    username,
    call_id: call.id,
    device_id: device.id,
    custom_identifier: customIdentifier,
    created_at: now,
    expires_at: expiresAt,
    revoked_at: null,
    revoke_attempts: 0,
    last_error: null,
  };
  const results = await env.CALL_RELAY_DB.batch([
    env.CALL_RELAY_DB.prepare(
      `INSERT INTO turn_credentials(username, call_id, device_id, custom_identifier, created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?
       FROM call_sessions cs
       JOIN pairings p ON p.id = cs.pairing_id
       JOIN devices d ON d.id = ?
       WHERE cs.id = ? AND cs.pairing_id = ?
         AND (cs.android_device_id = ? OR cs.peer_device_id = ?)
         AND cs.state NOT IN ('ending', 'ended', 'failed')
         AND p.confirmed_at IS NOT NULL AND p.revoked_at IS NULL
         AND d.revoked_at IS NULL
       ON CONFLICT(username) DO NOTHING`,
    ).bind(
      username, call.id, device.id, customIdentifier, now, expiresAt,
      device.id, call.id, call.pairing_id, device.id, device.id,
    ),
    env.CALL_RELAY_DB.prepare(
      `UPDATE call_sessions AS cs
       SET media_transport = 'webrtc_p2p', ice_policy = 'all', updated_at = ?
       WHERE cs.id = ? AND cs.state NOT IN ('ending', 'ended', 'failed')
         AND EXISTS (
           SELECT 1 FROM turn_credentials tc
           WHERE tc.username = ? AND tc.call_id = cs.id AND tc.device_id = ? AND tc.created_at = ?
         )`,
    ).bind(now, call.id, username, device.id, now),
  ]);
  if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    // The provider call is necessarily outside D1's transaction. Pairing,
    // device, or call revocation can therefore win while it is in flight.
    // Persist the losing credential only as durable revocation work, attempt
    // provider cleanup immediately, and never disclose it to the caller.
    try {
      await env.CALL_RELAY_DB.prepare(
        `INSERT INTO turn_credentials(username, call_id, device_id, custom_identifier, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(username) DO NOTHING`,
      ).bind(username, call.id, device.id, customIdentifier, now, expiresAt).run();
    } catch (error) {
      // A concurrently purged call can make the tracking insert violate its
      // foreign key. Provider revocation must still be attempted immediately.
      console.error(JSON.stringify({
        message: "post-revocation TURN credential could not be tracked",
        callId: call.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
    try {
      await revokeOne(env, credential);
    } catch (error) {
      console.error(JSON.stringify({
        message: "post-revocation TURN credential cleanup failed",
        callId: call.id,
        error: error instanceof Error ? error.message : String(error),
      }));
    }

    const eligibility = await env.CALL_RELAY_DB.prepare(
      `SELECT cs.state AS call_state, p.id AS pairing_id, p.confirmed_at,
              p.revoked_at AS pairing_revoked_at, d.id AS device_id,
              d.revoked_at AS device_revoked_at
       FROM call_sessions cs
       LEFT JOIN pairings p ON p.id = cs.pairing_id
       LEFT JOIN devices d ON d.id = ?
       WHERE cs.id = ?`,
    ).bind(device.id, call.id).first<{
      call_state: string;
      pairing_id: string | null;
      confirmed_at: number | null;
      pairing_revoked_at: number | null;
      device_id: string | null;
      device_revoked_at: number | null;
    }>();
    if (!eligibility) {
      throw new HttpError(409, "call is unavailable", "CALL_UNAVAILABLE");
    }
    if (!eligibility.device_id || eligibility.device_revoked_at !== null) {
      throw new HttpError(410, "device has been revoked", "DEVICE_REVOKED");
    }
    if (!eligibility.pairing_id || eligibility.pairing_revoked_at !== null) {
      throw new HttpError(410, "pairing has been revoked", "PAIRING_REVOKED");
    }
    if (eligibility.confirmed_at === null) {
      throw new HttpError(409, "pairing is not confirmed", "PAIRING_NOT_CONFIRMED");
    }
    throw new HttpError(409, "call is closing or closed", "CALL_CLOSED");
  }
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

export async function revokeTurnCredentialsForPairing(env: Env, pairingId: string): Promise<void> {
  const credentials = await env.CALL_RELAY_DB.prepare(
    `SELECT tc.* FROM turn_credentials tc
     JOIN call_sessions cs ON cs.id = tc.call_id
     WHERE cs.pairing_id = ? AND tc.revoked_at IS NULL
     ORDER BY tc.created_at LIMIT 50`,
  ).bind(pairingId).all<TurnCredentialRow>();
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
