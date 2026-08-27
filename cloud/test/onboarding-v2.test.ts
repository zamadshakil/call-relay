import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { exportJWK, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { revokeDueTurnCredentials } from "../src/turn";
import type { Env } from "../src/types";

interface TestDevice {
  deviceId: string;
  privateKey: CryptoKey;
}

let firebasePrivateKey: CryptoKey;
let firebasePublicJwk: Record<string, unknown>;
const failNextTurnRevocation = new Set<string>();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function sha256Base64Url(value: Uint8Array): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", value.buffer as ArrayBuffer)));
}

async function firebaseToken(uid: string, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, email_verified: true, auth_time: now - 10, name: "Relay User" })
    .setProtectedHeader({ alg: "RS256", kid: "firebase-integration-key" })
    .setIssuer("https://securetoken.google.com/integration-project")
    .setAudience("integration-project")
    .setSubject(uid)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(firebasePrivateKey);
}

async function invoke(request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, env as unknown as Env, context);
  await waitOnExecutionContext(context);
  return response;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  expect(body).toBeTypeOf("object");
  return body as Record<string, unknown>;
}

function bearerRequest(path: string, token: string, method: "GET" | "POST" = "GET", body?: Record<string, unknown>): Request {
  return new Request(`https://relay.test${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function createDevice(token: string, platform: "android" | "browser", displayName: string): Promise<TestDevice> {
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const agreement = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const publicKeySpki = base64Url(new Uint8Array(await crypto.subtle.exportKey("spki", signing.publicKey)));
  const agreementPublicKeyRaw = base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", agreement.publicKey)));
  const response = await invoke(bearerRequest("/v1/devices/register", token, "POST", {
    platform,
    displayName,
    publicKeySpki,
    agreementPublicKeyRaw,
    appVersion: 3,
  }));
  expect(response.status).toBe(201);
  return { deviceId: String((await responseJson(response)).deviceId), privateKey: signing.privateKey };
}

async function signedRequest(
  device: TestDevice,
  path: string,
  method: "GET" | "POST" | "PUT",
  body?: Record<string, unknown>,
): Promise<Request> {
  const bodyText = body ? JSON.stringify(body) : "";
  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID();
  const bodyHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText))),
    (byte) => byte.toString(16).padStart(2, "0")).join("");
  const canonical = `${method}\n${path}\n${bodyHash}\n${timestamp}\n${nonce}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    device.privateKey,
    new TextEncoder().encode(canonical),
  ));
  return new Request(`https://relay.test${path}`, {
    method,
    headers: {
      "x-relay-device": device.deviceId,
      "x-relay-timestamp": timestamp,
      "x-relay-nonce": nonce,
      "x-relay-signature": base64Url(signature),
      "x-relay-app-version": "android-webrtc-3",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? bodyText : undefined,
  });
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  firebasePrivateKey = pair.privateKey;
  firebasePublicJwk = { ...(await exportJWK(pair.publicKey)), kid: "firebase-integration-key", alg: "RS256" };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.includes("securetoken@system.gserviceaccount.com")) {
      return Response.json({ keys: [firebasePublicJwk] }, { headers: { "cache-control": "public, max-age=3600" } });
    }
    if (request.url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "firebase-admin-access-token" });
    if (request.url.includes("identitytoolkit.googleapis.com")) return Response.json({ users: [{ localId: "firebase-user-v2", validSince: "0" }] });
    if (request.url.includes("rtc.live.cloudflare.com") && request.url.endsWith("/revoke")) {
      const username = decodeURIComponent(request.url.split("/credentials/")[1]?.split("/revoke")[0] ?? "");
      if (failNextTurnRevocation.delete(username)) return Response.json({ error: "temporary TURN failure" }, { status: 503 });
      return Response.json({ revoked: true });
    }
    throw new Error(`unexpected fetch in onboarding test: ${request.url}`);
  });
});

afterAll(() => vi.unstubAllGlobals());

describe("consumer onboarding v2", () => {
  it("binds the same paid Firebase user to Android and browser and completes a single-use QR pairing", async () => {
    const uid = "firebase-user-v2";
    const email = "approved-v2@gmail.com";
    const token = await firebaseToken(uid, email);
    await env.CALL_RELAY_DB.prepare(
      "INSERT INTO approved_emails(email, status, created_at, updated_at) VALUES (?, 'approved', ?, ?)",
    ).bind(email, Date.now(), Date.now()).run();

    const sessionResponse = await invoke(bearerRequest("/v1/auth/session", token, "POST"));
    expect(sessionResponse.status).toBe(200);
    expect((await responseJson(sessionResponse)).account).toMatchObject({ email, approvalStatus: "approved" });

    const now = Date.now();
    await env.CALL_RELAY_DB.prepare(
      `INSERT INTO billing_subscriptions(user_id, plan_code, status, current_period_ends_at, created_at, updated_at)
       VALUES (?, 'monthly', 'active', ?, ?, ?)`,
    ).bind(uid, now + 30 * 24 * 60 * 60 * 1000, now, now).run();

    const android = await createDevice(token, "android", "Relay Android");
    const browser = await createDevice(token, "browser", "iPhone browser");

    const serviceInstanceId = crypto.randomUUID();
    const processStartedAt = Date.now() - 5_000;
    const heartbeatBody = {
      serviceInstanceId,
      sequence: 1,
      relayReady: true,
      signalState: "Connected",
      processStartedAt,
      lastErrorCode: null,
    };
    const heartbeat = await invoke(await signedRequest(
      android,
      `/v1/devices/${android.deviceId}/heartbeat`,
      "POST",
      heartbeatBody,
    ));
    expect(heartbeat.status).toBe(200);
    expect(await responseJson(heartbeat)).toMatchObject({ accepted: true, duplicate: false, heartbeatAt: expect.any(Number) });
    const duplicateHeartbeat = await invoke(await signedRequest(
      android,
      `/v1/devices/${android.deviceId}/heartbeat`,
      "POST",
      heartbeatBody,
    ));
    expect(duplicateHeartbeat.status).toBe(409);
    expect((await responseJson(duplicateHeartbeat)).code).toBe("HEARTBEAT_REPLAY");
    const restartedServiceInstanceId = crypto.randomUUID();
    const restartedProcessStartedAt = processStartedAt + 1_000;
    const restartedHeartbeat = await invoke(await signedRequest(
      android,
      `/v1/devices/${android.deviceId}/heartbeat`,
      "POST",
      {
        ...heartbeatBody,
        serviceInstanceId: restartedServiceInstanceId,
        processStartedAt: restartedProcessStartedAt,
        lastErrorCode: "signaling_error",
      },
    ));
    expect(restartedHeartbeat.status).toBe(200);
    const staleHeartbeat = await invoke(await signedRequest(
      android,
      `/v1/devices/${android.deviceId}/heartbeat`,
      "POST",
      { ...heartbeatBody, sequence: 2 },
    ));
    expect(staleHeartbeat.status).toBe(409);
    expect((await responseJson(staleHeartbeat)).code).toBe("STALE_SERVICE_INSTANCE");
    const peerHeartbeat = await invoke(await signedRequest(
      browser,
      `/v1/devices/${browser.deviceId}/heartbeat`,
      "POST",
      heartbeatBody,
    ));
    expect(peerHeartbeat.status).toBe(403);

    const accountAfterHeartbeat = await responseJson(await invoke(bearerRequest("/v1/me", token)));
    const accountDevices = accountAfterHeartbeat.devices as Array<Record<string, unknown>>;
    const androidAccountDevice = accountDevices.find((candidate) => candidate.id === android.deviceId);
    expect(androidAccountDevice).toMatchObject({
      lastAuthenticatedAt: expect.any(Number),
      relayPresence: {
        relayReady: true,
        signalState: "connected",
        serviceInstanceId: restartedServiceInstanceId,
        processStartedAt: restartedProcessStartedAt,
        heartbeatAt: expect.any(Number),
        heartbeatFresh: true,
        lastErrorCode: "signaling_error",
      },
    });
    expect(androidAccountDevice).not.toHaveProperty("online");

    const sim = await invoke(await signedRequest(android, `/v1/devices/${android.deviceId}/sim-profile`, "PUT", {
      slotIndex: 0,
      carrierName: "Jazz",
      countryIso: "PK",
      numberSource: "user_confirmed",
      phoneNumber: "+923001234567",
    }));
    expect(sim.status).toBe(200);
    const storedSim = await env.CALL_RELAY_DB.prepare(
      "SELECT phone_number_ciphertext, phone_number_iv, phone_number_last4 FROM sim_profiles WHERE device_id = ?",
    ).bind(android.deviceId).first<{ phone_number_ciphertext: string; phone_number_iv: string; phone_number_last4: string }>();
    expect(storedSim?.phone_number_ciphertext).not.toContain("923001234567");
    expect(storedSim?.phone_number_iv).toBeTruthy();
    expect(storedSim?.phone_number_last4).toBe("4567");

    const invitationId = `inv_${"a".repeat(32)}`;
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const challengeHash = await sha256Base64Url(challenge);
    const createdInvitation = await invoke(await signedRequest(android, "/v1/pairing-invitations", "POST", { invitationId, challengeHash }));
    expect(createdInvitation.status).toBe(201);
    const peerEphemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const peerPublicKeyRaw = base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", peerEphemeral.publicKey)));
    const commitment = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const peerProof = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const otherUid = "firebase-user-other";
    const otherEmail = "other-approved@gmail.com";
    const otherToken = await firebaseToken(otherUid, otherEmail);
    await env.CALL_RELAY_DB.prepare(
      "INSERT INTO approved_emails(email, status, created_at, updated_at) VALUES (?, 'approved', ?, ?)",
    ).bind(otherEmail, now, now).run();
    await env.CALL_RELAY_DB.prepare(
      `INSERT INTO firebase_users(id, email, email_verified, created_at, updated_at, last_authenticated_at)
       VALUES (?, ?, 1, ?, ?, ?)`,
    ).bind(otherUid, otherEmail, now, now, now).run();
    await env.CALL_RELAY_DB.prepare(
      `INSERT INTO billing_subscriptions(user_id, plan_code, status, current_period_ends_at, created_at, updated_at)
       VALUES (?, 'monthly', 'active', ?, ?, ?)`,
    ).bind(otherUid, now + 30 * 24 * 60 * 60 * 1000, now, now).run();
    const wrongAccount = await invoke(bearerRequest(`/v1/pairing-invitations/${invitationId}/consume`, otherToken, "POST", {
      peerDeviceId: browser.deviceId,
      challengeHash,
      peerPublicKeyRaw,
      commitment,
      proof: peerProof,
    }));
    expect(wrongAccount.status).toBe(403);
    const consumed = await invoke(bearerRequest(`/v1/pairing-invitations/${invitationId}/consume`, token, "POST", {
      peerDeviceId: browser.deviceId,
      challengeHash,
      peerPublicKeyRaw,
      commitment,
      proof: peerProof,
    }));
    expect(consumed.status).toBe(201);
    const pairingId = String((await responseJson(consumed)).pairingId);

    const replay = await invoke(bearerRequest(`/v1/pairing-invitations/${invitationId}/consume`, token, "POST", {
      peerDeviceId: browser.deviceId,
      challengeHash,
      peerPublicKeyRaw,
      commitment,
      proof: peerProof,
    }));
    expect(replay.status).toBe(409);

    const secondPeer = await invoke(bearerRequest("/v1/devices/register", token, "POST", {
      platform: "browser",
      displayName: "Second iPhone browser",
      publicKeySpki: base64Url(new Uint8Array(await crypto.subtle.exportKey("spki", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])).publicKey))),
      agreementPublicKeyRaw: base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])).publicKey))),
      appVersion: 3,
    }));
    expect(secondPeer.status).toBe(409);

    const pending = await invoke(await signedRequest(android, "/v1/pairings/current-device", "GET"));
    expect((await responseJson(pending)).pairing).toMatchObject({ id: pairingId, peer_public_key_raw: peerPublicKeyRaw, peer_proof: peerProof });
    const androidProof = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const confirmed = await invoke(await signedRequest(android, `/v1/pairings/${pairingId}/confirm`, "POST", {
      commitment,
      proof: androidProof,
    }));
    expect(confirmed.status).toBe(200);
    expect((await responseJson(confirmed)).confirmed).toBe(true);

    const browserCurrent = await invoke(bearerRequest("/v1/pairings/current", token));
    expect((await responseJson(browserCurrent)).pairing).toMatchObject({ id: pairingId, android_proof: androidProof, confirmed_at: expect.any(Number) });

    const expiredInvitationId = `inv_${"e".repeat(32)}`;
    expect((await invoke(await signedRequest(android, "/v1/pairing-invitations", "POST", {
      invitationId: expiredInvitationId,
      challengeHash,
    }))).status).toBe(201);
    await env.CALL_RELAY_DB.prepare("UPDATE pairing_invitations SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, expiredInvitationId).run();
    const expired = await invoke(bearerRequest(`/v1/pairing-invitations/${expiredInvitationId}/consume`, token, "POST", {
      peerDeviceId: browser.deviceId,
      challengeHash,
      peerPublicKeyRaw,
      commitment,
      proof: peerProof,
    }));
    expect(expired.status).toBe(410);

    await env.CALL_RELAY_DB.prepare("UPDATE billing_subscriptions SET status = 'past_due' WHERE user_id = ?").bind(uid).run();
    const blockedCall = await invoke(await signedRequest(browser, "/v1/calls/outgoing", "POST", {
      pairingId,
      phoneNumber: "+923001234567",
      requestId: crypto.randomUUID(),
    }));
    expect(blockedCall.status).toBe(402);

    await env.CALL_RELAY_DB.prepare("UPDATE billing_subscriptions SET status = 'active' WHERE user_id = ?").bind(uid).run();
    const replacementCallId = `call_${"b".repeat(32)}`;
    const replacementTurnUsername = "replacement-active-turn";
    const activeCallCreatedAt = Date.now();
    await env.CALL_RELAY_DB.batch([
      env.CALL_RELAY_DB.prepare(
        `INSERT INTO call_sessions(id, pairing_id, android_device_id, peer_device_id, direction, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'incoming', 'active', ?, ?)`,
      ).bind(replacementCallId, pairingId, android.deviceId, browser.deviceId, activeCallCreatedAt, activeCallCreatedAt),
      env.CALL_RELAY_DB.prepare(
        `INSERT INTO turn_credentials(username, call_id, device_id, custom_identifier, created_at, expires_at)
         VALUES (?, ?, ?, 'replacement-test', ?, ?)`,
      ).bind(replacementTurnUsername, replacementCallId, browser.deviceId, activeCallCreatedAt, activeCallCreatedAt + 7_200_000),
    ]);
    const replacementSigning = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const replacementAgreement = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const replacementResponse = await invoke(bearerRequest("/v1/devices/register", token, "POST", {
      platform: "browser",
      displayName: "Replacement iPhone browser",
      publicKeySpki: base64Url(new Uint8Array(await crypto.subtle.exportKey("spki", replacementSigning.publicKey))),
      agreementPublicKeyRaw: base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", replacementAgreement.publicKey))),
      appVersion: 3,
      replaceExisting: true,
    }));
    expect(replacementResponse.status).toBe(201);
    const replacementDeviceId = String((await responseJson(replacementResponse)).deviceId);
    const revokedPairing = await env.CALL_RELAY_DB.prepare(
      "SELECT revoked_at FROM pairings WHERE id = ?",
    ).bind(pairingId).first<{ revoked_at: number | null }>();
    expect(revokedPairing?.revoked_at).toEqual(expect.any(Number));
    const revocationDelivery = await env.CALL_RELAY_DB.prepare(
      "SELECT delivered_at, attempts FROM pairing_control_outbox WHERE pairing_id = ?",
    ).bind(pairingId).first<{ delivered_at: number | null; attempts: number }>();
    expect(revocationDelivery).toMatchObject({ delivered_at: expect.any(Number), attempts: 1 });
    const failedReplacementCall = await env.CALL_RELAY_DB.prepare(
      "SELECT state, failure_code, media_failure_code, ended_at FROM call_sessions WHERE id = ?",
    ).bind(replacementCallId).first<{ state: string; failure_code: string | null; media_failure_code: string | null; ended_at: number | null }>();
    expect(failedReplacementCall).toMatchObject({
      state: "failed",
      failure_code: "pairing_revoked",
      media_failure_code: "pairing_revoked",
      ended_at: expect.any(Number),
    });
    const revokedReplacementTurn = await env.CALL_RELAY_DB.prepare(
      "SELECT revoked_at, last_error FROM turn_credentials WHERE username = ?",
    ).bind(replacementTurnUsername).first<{ revoked_at: number | null; last_error: string | null }>();
    expect(revokedReplacementTurn).toMatchObject({ revoked_at: expect.any(Number), last_error: null });
    const revokedDeviceRequest = await invoke(await signedRequest(browser, "/v1/calls/current", "GET"));
    expect(revokedDeviceRequest.status).toBe(410);
    expect((await responseJson(revokedDeviceRequest)).code).toBe("DEVICE_REVOKED");

    const revokedSignal = await env.PAIRING_SIGNAL.getByName(pairingId).fetch(new Request("https://pairing-signal.internal/connect", {
      headers: {
        upgrade: "websocket",
        "x-relay-signal-device": browser.deviceId,
        "x-relay-signal-role": "peer",
        "x-relay-signal-jti": crypto.randomUUID(),
        "x-relay-signal-exp": String(Date.now() + 60_000),
      },
    }));
    expect(revokedSignal.status).toBe(410);
    expect((await responseJson(revokedSignal)).code).toBe("PAIRING_REVOKED");

    const revokePairingId = `pair_${"c".repeat(32)}`;
    const revokeCallId = `call_${"d".repeat(32)}`;
    const revokeTurnUsername = "explicit-revoke-active-turn";
    const revokeCreatedAt = Date.now();
    await env.CALL_RELAY_DB.batch([
      env.CALL_RELAY_DB.prepare(
        `INSERT INTO pairings(id, device_a_id, device_b_id, secret_commitment, created_at, created_by_device_id,
          confirmed_by_device_id, confirmed_at, protocol_version, user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?)`,
      ).bind(
        revokePairingId, android.deviceId, replacementDeviceId, commitment, revokeCreatedAt,
        android.deviceId, replacementDeviceId, revokeCreatedAt, uid,
      ),
      env.CALL_RELAY_DB.prepare(
        `INSERT INTO call_sessions(id, pairing_id, android_device_id, peer_device_id, direction, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'incoming', 'active', ?, ?)`,
      ).bind(revokeCallId, revokePairingId, android.deviceId, replacementDeviceId, revokeCreatedAt, revokeCreatedAt),
      env.CALL_RELAY_DB.prepare(
        `INSERT INTO turn_credentials(username, call_id, device_id, custom_identifier, created_at, expires_at)
         VALUES (?, ?, ?, 'explicit-revoke-test', ?, ?)`,
      ).bind(revokeTurnUsername, revokeCallId, replacementDeviceId, revokeCreatedAt, revokeCreatedAt + 7_200_000),
    ]);
    failNextTurnRevocation.add(revokeTurnUsername);
    const explicitRevoke = await invoke(bearerRequest(`/v1/devices/${replacementDeviceId}/revoke`, token, "POST"));
    expect(explicitRevoke.status).toBe(200);
    const explicitlyFailedCall = await env.CALL_RELAY_DB.prepare(
      "SELECT state, failure_code, ended_at FROM call_sessions WHERE id = ?",
    ).bind(revokeCallId).first<{ state: string; failure_code: string | null; ended_at: number | null }>();
    expect(explicitlyFailedCall).toMatchObject({ state: "failed", failure_code: "pairing_revoked", ended_at: expect.any(Number) });
    const explicitlyRevokedTurn = await env.CALL_RELAY_DB.prepare(
      "SELECT revoked_at, revoke_attempts, last_error FROM turn_credentials WHERE username = ?",
    ).bind(revokeTurnUsername).first<{ revoked_at: number | null; revoke_attempts: number; last_error: string | null }>();
    expect(explicitlyRevokedTurn).toMatchObject({ revoked_at: null, revoke_attempts: 1, last_error: "Cloudflare TURN revoke failed (503)" });
    await revokeDueTurnCredentials(env as unknown as Env);
    const retriedTurn = await env.CALL_RELAY_DB.prepare(
      "SELECT revoked_at, revoke_attempts, last_error FROM turn_credentials WHERE username = ?",
    ).bind(revokeTurnUsername).first<{ revoked_at: number | null; revoke_attempts: number; last_error: string | null }>();
    expect(retriedTurn).toMatchObject({ revoked_at: expect.any(Number), revoke_attempts: 1, last_error: null });
  });
});
