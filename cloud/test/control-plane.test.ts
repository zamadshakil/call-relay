import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { revokeDueTurnCredentials } from "../src/turn";
import type { Env } from "../src/types";

interface TestDevice {
  deviceId: string;
  privateKey: CryptoKey;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function invoke(request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(
    request as Request<unknown, IncomingRequestCfProperties>,
    env as unknown as Env,
    context,
  );
  await waitOnExecutionContext(context);
  return response;
}

async function json(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

async function enroll(platform: "android" | "browser", displayName: string): Promise<TestDevice> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
  const response = await invoke(new Request("https://relay.test/v1/devices/enroll", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-enrollment-invite": "integration-test-invite",
      "x-relay-app-version": platform === "android" ? "android-webrtc-2" : "web-webrtc-1",
    },
    body: JSON.stringify({ platform, displayName, publicKeySpki: base64Url(spki) }),
  }));
  expect(response.status).toBe(201);
  const body = await json(response);
  expect(body.deviceId).toMatch(/^dev_[a-f0-9]{32}$/u);
  return { deviceId: String(body.deviceId), privateKey: keyPair.privateKey };
}

async function signedRequest(
  device: TestDevice,
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: Record<string, unknown>,
  fixed?: { nonce: string; timestamp: string },
): Promise<Request> {
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  const timestamp = fixed?.timestamp ?? Date.now().toString();
  const nonce = fixed?.nonce ?? crypto.randomUUID();
  const canonical = `${method}\n${path}\n${await sha256Hex(bodyText)}\n${timestamp}\n${nonce}`;
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    device.privateKey,
    new TextEncoder().encode(canonical),
  ));
  const headers = new Headers({
    "x-relay-device": device.deviceId,
    "x-relay-timestamp": timestamp,
    "x-relay-nonce": nonce,
    "x-relay-signature": base64Url(signature),
    "x-relay-app-version": "android-webrtc-2",
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://relay.test${path}`, { method, headers, body: bodyText || undefined });
}

async function signedFetch(
  device: TestDevice,
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  body?: Record<string, unknown>,
): Promise<Response> {
  return invoke(await signedRequest(device, path, method, body));
}

async function event(
  device: TestDevice,
  callId: string,
  type: string,
  payload?: Record<string, unknown>,
): Promise<Response> {
  return signedFetch(device, `/v1/calls/${callId}/events`, "POST", {
    type,
    commandId: crypto.randomUUID(),
    ...(payload ? { payload } : {}),
  });
}

async function expiredSignalTicket(pairingId: string, deviceId: string, role: "android" | "peer"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ pairingId, deviceId, role, protocolVersion: 1 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setAudience("call-relay-pairing-signal")
    .setSubject(deviceId)
    .setJti(crypto.randomUUID())
    .setIssuedAt(now - 120)
    .setExpirationTime(now - 60)
    .sign(new TextEncoder().encode("integration-signal-ticket-secret-with-32-bytes"));
}

describe("Worker control plane", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects pre-migration Android enrollment at the cutover gate", async () => {
    const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
    const response = await invoke(new Request("https://relay.test/v1/devices/enroll", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-enrollment-invite": "integration-test-invite",
        "x-relay-app-version": "android-webrtc-1",
      },
      body: JSON.stringify({ platform: "android", displayName: "Old Android", publicKeySpki: base64Url(spki) }),
    }));
    expect(response.status).toBe(426);
  });

  it("enforces pairing confirmation, roles, idempotency, state transitions, and Cloudflare-only media grants", async () => {
    const android = await enroll("android", "Relay Android");
    const browser = await enroll("browser", "Browser peer");
    const pushConfig = await signedFetch(browser, "/v1/push/config", "GET");
    expect(pushConfig.status).toBe(200);
    expect((await json(pushConfig)).vapidPublicKey).toMatch(/^[A-Za-z0-9_-]{80,120}$/u);
    const pushSubscription = await signedFetch(browser, `/v1/devices/${browser.deviceId}/web-push-subscription`, "PUT", {
      endpoint: "https://web.push.apple.com/Q2FsbFJlbGF5VGVzdA",
      expirationTime: null,
      keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) },
    });
    expect(pushSubscription.status).toBe(200);
    const encryptedSubscription = await env.CALL_RELAY_DB.prepare(
      "SELECT subscription_ciphertext, subscription_iv FROM web_push_subscriptions WHERE device_id = ?",
    ).bind(browser.deviceId).first<{ subscription_ciphertext: string; subscription_iv: string }>();
    expect(encryptedSubscription?.subscription_ciphertext).not.toContain("push.apple.com");
    expect(encryptedSubscription?.subscription_iv).toMatch(/^[A-Za-z0-9_-]+$/u);
    const pairingSecret = crypto.getRandomValues(new Uint8Array(32));
    const commitment = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", pairingSecret)));

    const pairingResponse = await signedFetch(browser, "/v1/pairings", "POST", {
      peerDeviceId: android.deviceId,
      secretCommitment: commitment,
    });
    expect(pairingResponse.status).toBe(201);
    const pairing = await json(pairingResponse);
    const pairingId = String(pairing.pairingId);

    const unconfirmedCall = await signedFetch(browser, "/v1/calls/outgoing", "POST", {
      pairingId,
      phoneNumber: "+923001234567",
      requestId: crypto.randomUUID(),
    });
    expect(unconfirmedCall.status).toBe(403);

    const confirmation = await signedFetch(android, `/v1/pairings/${pairingId}/confirm`, "POST", {
      secretCommitment: commitment,
    });
    expect(confirmation.status).toBe(200);
    expect((await json(confirmation)).confirmed).toBe(true);

    const signalTicketResponse = await signedFetch(browser, `/v1/pairings/${pairingId}/signal-ticket`, "POST", {});
    expect(signalTicketResponse.status).toBe(201);
    const signalTicket = await json(signalTicketResponse);
    expect(signalTicket.protocol).toBe("call-relay.signal.v1");
    expect(signalTicket.role).toBe("peer");
    const wrongPairing = await invoke(new Request("https://relay.test/v1/pairings/pair_00000000000000000000000000000000/signal", {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `call-relay.signal.v1, cr-ticket.${String(signalTicket.ticket)}`,
      },
    }));
    expect(wrongPairing.status).toBe(403);
    const expired = await invoke(new Request(`https://relay.test/v1/pairings/${pairingId}/signal`, {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `call-relay.signal.v1, cr-ticket.${await expiredSignalTicket(pairingId, browser.deviceId, "peer")}`,
      },
    }));
    expect(expired.status).toBe(401);
    const websocketRequest = new Request(`https://relay.test/v1/pairings/${pairingId}/signal`, {
      headers: {
        upgrade: "websocket",
        "sec-websocket-protocol": `call-relay.signal.v1, cr-ticket.${String(signalTicket.ticket)}`,
      },
    });
    const websocketResponse = await invoke(websocketRequest);
    expect(websocketResponse.status).toBe(101);
    websocketResponse.webSocket?.accept();
    const reusedTicket = await invoke(websocketRequest);
    expect(reusedTicket.status).toBe(409);
    websocketResponse.webSocket?.close(1000, "test complete");

    const secondBrowser = await enroll("browser", "Second browser peer");
    const conflictingPairing = await signedFetch(secondBrowser, "/v1/pairings", "POST", {
      peerDeviceId: android.deviceId,
      secretCommitment: commitment,
    });
    expect(conflictingPairing.status).toBe(409);

    const requestId = crypto.randomUUID();
    const outgoingRequest = { pairingId, phoneNumber: "+923001234567", requestId };
    const created = await signedFetch(browser, "/v1/calls/outgoing", "POST", outgoingRequest);
    expect(created.status).toBe(201);
    const createdBody = await json(created);
    const outgoingCallId = String(createdBody.callId);
    expect(createdBody.state).toBe("dialing_sim");

    const duplicateCreate = await signedFetch(browser, "/v1/calls/outgoing", "POST", outgoingRequest);
    expect(duplicateCreate.status).toBe(200);
    const duplicateBody = await json(duplicateCreate);
    expect(duplicateBody.callId).toBe(outgoingCallId);
    expect(duplicateBody.duplicate).toBe(true);

    expect((await event(browser, outgoingCallId, "active")).status).toBe(403);
    const active = await event(android, outgoingCallId, "active");
    expect(active.status).toBe(200);
    expect((await json(active)).state).toBe("active");
    const activeVersion = await env.CALL_RELAY_DB.prepare("SELECT version FROM call_sessions WHERE id = ?")
      .bind(outgoingCallId).first<{ version: number }>();
    const restoredServiceActive = await event(android, outgoingCallId, "active");
    expect(restoredServiceActive.status).toBe(200);
    expect(await json(restoredServiceActive)).toMatchObject({ state: "active", duplicate: true });
    const versionAfterRestoredService = await env.CALL_RELAY_DB.prepare("SELECT version FROM call_sessions WHERE id = ?")
      .bind(outgoingCallId).first<{ version: number }>();
    expect(versionAfterRestoredService?.version).toBe(activeVersion?.version);
    expect((await event(browser, outgoingCallId, "media_heartbeat")).status).toBe(403);
    expect((await event(android, outgoingCallId, "media_heartbeat")).status).toBe(200);

    const dtmf = await event(browser, outgoingCallId, "dtmf", { digit: "5" });
    expect(dtmf.status).toBe(200);
    const queued = await env.CALL_RELAY_DB.prepare(
      "SELECT COUNT(*) AS count FROM push_outbox WHERE target_device_id = ? AND queued_at IS NOT NULL",
    ).bind(android.deviceId).first<{ count: number }>();
    expect(queued?.count).toBeGreaterThanOrEqual(2);

    expect((await event(browser, outgoingCallId, "end")).status).toBe(200);
    const ended = await event(android, outgoingCallId, "end");
    expect((await json(ended)).state).toBe("ended");

    const incomingCreated = await signedFetch(android, "/v1/calls/incoming", "POST", {
      pairingId,
      requestId: crypto.randomUUID(),
    });
    expect(incomingCreated.status).toBe(201);
    const incomingCallId = String((await json(incomingCreated)).callId);
    const browserNotification = await env.CALL_RELAY_DB.prepare(
      "SELECT channel, payload_json, queued_at FROM push_outbox WHERE target_device_id = ? ORDER BY created_at DESC LIMIT 1",
    ).bind(browser.deviceId).first<{ channel: string; payload_json: string; queued_at: number | null }>();
    expect(browserNotification?.channel).toBe("web_push");
    expect(browserNotification?.queued_at).toEqual(expect.any(Number));
    expect(JSON.parse(browserNotification?.payload_json ?? "{}").data).toMatchObject({
      type: "incoming_call",
      callId: incomingCallId,
      callVersion: "0",
    });

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      expect(request.headers.get("authorization")).toBe("Bearer integration-turn-token");
      if (request.url.endsWith("/credentials/test-turn-username/revoke")) {
        return Response.json({ revoked: true });
      }
      expect(request.url).toContain("/v1/turn/keys/integration-turn-key/credentials/generate");
      return Response.json({
        iceServers: {
          urls: [
            "turn:turn.cloudflare.com:3478?transport=udp",
            "turns:turn.cloudflare.com:443?transport=tcp",
          ],
          username: "test-turn-username",
          credential: "test-turn-password",
        },
      }, { status: 201 });
    });
    const mediaResponse = await signedFetch(browser, `/v1/calls/${incomingCallId}/media-config`, "POST", {});
    expect(mediaResponse.status).toBe(200);
    const media = await json(mediaResponse);
    expect(media.transport).toBe("webrtc_p2p");
    expect(media.offerer).toBe("android");
    expect(media.iceTransportPolicy).toBe("all");
    expect(media.iceServers).toHaveLength(2);
    const returnedIceServers = media.iceServers as Array<{ urls: string[] }>;
    expect(returnedIceServers[1]?.urls).toContain("turns:turn.cloudflare.com:443?transport=tcp");
    const storedCredential = await env.CALL_RELAY_DB.prepare(
      "SELECT username, call_id, device_id FROM turn_credentials WHERE username = ?",
    ).bind("test-turn-username").first<{ username: string; call_id: string; device_id: string }>();
    expect(storedCredential).toEqual({ username: "test-turn-username", call_id: incomingCallId, device_id: browser.deviceId });

    const removedToken = await signedFetch(browser, `/v1/calls/${incomingCallId}/token`, "POST", {});
    expect(removedToken.status).toBe(410);

    const accepted = await event(browser, incomingCallId, "accept");
    expect((await json(accepted)).state).toBe("accepted");
    const acceptedTimestamp = await env.CALL_RELAY_DB.prepare(
      "SELECT updated_at FROM call_sessions WHERE id = ?",
    ).bind(incomingCallId).first<{ updated_at: number }>();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await event(android, incomingCallId, "media_heartbeat")).status).toBe(409);
    }
    const afterPrematureHeartbeats = await env.CALL_RELAY_DB.prepare(
      "SELECT updated_at FROM call_sessions WHERE id = ?",
    ).bind(incomingCallId).first<{ updated_at: number }>();
    expect(afterPrematureHeartbeats?.updated_at).toBe(acceptedTimestamp?.updated_at);
    expect((await event(browser, incomingCallId, "answering_sim")).status).toBe(403);
    expect((await event(android, incomingCallId, "answering_sim")).status).toBe(200);
    const afterFirstAnswerRequest = await env.CALL_RELAY_DB.prepare(
      "SELECT version FROM call_sessions WHERE id = ?",
    ).bind(incomingCallId).first<{ version: number }>();
    const duplicateAnswerRequest = await json(await event(android, incomingCallId, "answering_sim"));
    expect(duplicateAnswerRequest.duplicate).toBe(true);
    const afterDuplicateAnswerRequest = await env.CALL_RELAY_DB.prepare(
      "SELECT version FROM call_sessions WHERE id = ?",
    ).bind(incomingCallId).first<{ version: number }>();
    expect(afterDuplicateAnswerRequest?.version).toBe(afterFirstAnswerRequest?.version);
    const answerEvents = await env.CALL_RELAY_DB.prepare(
      "SELECT COUNT(*) AS count FROM call_events WHERE call_id = ? AND event_type = 'answering_sim'",
    ).bind(incomingCallId).first<{ count: number }>();
    expect(answerEvents?.count).toBe(1);
    expect((await json(await event(android, incomingCallId, "active"))).state).toBe("active");
    await env.CALL_RELAY_DB.prepare("UPDATE call_sessions SET updated_at = 1 WHERE id = ?").bind(incomingCallId).run();
    expect((await event(android, incomingCallId, "media_heartbeat")).status).toBe(200);
    const activeHeartbeatTimestamp = await env.CALL_RELAY_DB.prepare(
      "SELECT updated_at FROM call_sessions WHERE id = ?",
    ).bind(incomingCallId).first<{ updated_at: number }>();
    expect(activeHeartbeatTimestamp?.updated_at).toBeGreaterThan(1);
    const incomingMilestones = await env.CALL_RELAY_DB.prepare(
      "SELECT peer_accepted_at, telecom_answer_requested_at, sim_active_at FROM call_sessions WHERE id = ?",
    ).bind(incomingCallId).first<{ peer_accepted_at: number | null; telecom_answer_requested_at: number | null; sim_active_at: number | null }>();
    expect(incomingMilestones).toMatchObject({
      peer_accepted_at: expect.any(Number),
      telecom_answer_requested_at: expect.any(Number),
      sim_active_at: expect.any(Number),
    });
    const summary = await event(android, incomingCallId, "media_summary", {
      setupDurationMs: 1250,
      candidateType: "relay",
      protocol: "tls",
      bytesSent: 4096,
      sdp: "v=0\r\nthis-must-never-be-stored",
      candidate: "candidate:private-address",
    });
    expect(summary.status).toBe(200);
    const storedSummary = await env.CALL_RELAY_DB.prepare(
      "SELECT payload_json FROM call_events WHERE call_id = ? AND event_type = 'media_summary' ORDER BY created_at DESC LIMIT 1",
    ).bind(incomingCallId).first<{ payload_json: string }>();
    expect(JSON.parse(storedSummary?.payload_json ?? "{}")).toEqual({
      setupDurationMs: 1250,
      candidateType: "relay",
      protocol: "tls",
      bytesSent: 4096,
    });
    expect((await json(await event(android, incomingCallId, "end"))).state).toBe("ended");
    const revokedCredential = await env.CALL_RELAY_DB.prepare(
      "SELECT revoked_at, last_error FROM turn_credentials WHERE username = ?",
    ).bind("test-turn-username").first<{ revoked_at: number | null; last_error: string | null }>();
    expect(revokedCredential?.revoked_at).toEqual(expect.any(Number));
    expect(revokedCredential?.last_error).toBeNull();

    const current = await signedFetch(browser, "/v1/calls/current", "GET");
    expect(current.status).toBe(200);
    expect((await json(current)).call).toBeNull();
  });

  it("does not create a call or push when its pairing is revoked between validation and insertion", async () => {
    const android = await enroll("android", "Revocation-race Android");
    const browser = await enroll("browser", "Revocation-race browser");
    const pairingSecret = crypto.getRandomValues(new Uint8Array(32));
    const commitment = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", pairingSecret)));
    const pairingResponse = await signedFetch(browser, "/v1/pairings", "POST", {
      peerDeviceId: android.deviceId,
      secretCommitment: commitment,
    });
    const pairingId = String((await json(pairingResponse)).pairingId);
    expect((await signedFetch(android, `/v1/pairings/${pairingId}/confirm`, "POST", {
      secretCommitment: commitment,
    })).status).toBe(200);

    const originalBatch = env.CALL_RELAY_DB.batch.bind(env.CALL_RELAY_DB);
    vi.spyOn(env.CALL_RELAY_DB, "batch").mockImplementationOnce(async (statements) => {
      await env.CALL_RELAY_DB.prepare("UPDATE pairings SET revoked_at = ? WHERE id = ?")
        .bind(Date.now(), pairingId).run();
      return originalBatch(statements);
    });
    const response = await signedFetch(browser, "/v1/calls/outgoing", "POST", {
      pairingId,
      phoneNumber: "+923001234567",
      requestId: crypto.randomUUID(),
    });
    expect(response.status).toBe(410);
    expect((await json(response)).code).toBe("PAIRING_REVOKED");
    const calls = await env.CALL_RELAY_DB.prepare("SELECT COUNT(*) AS count FROM call_sessions WHERE pairing_id = ?")
      .bind(pairingId).first<{ count: number }>();
    expect(calls?.count).toBe(0);
    const pushes = await env.CALL_RELAY_DB.prepare("SELECT COUNT(*) AS count FROM push_outbox WHERE target_device_id = ?")
      .bind(android.deviceId).first<{ count: number }>();
    expect(pushes?.count).toBe(0);
  });

  it("revokes and durably tracks a TURN credential generated after pairing revocation wins", async () => {
    const android = await enroll("android", "TURN-race Android");
    const browser = await enroll("browser", "TURN-race browser");
    const pairingSecret = crypto.getRandomValues(new Uint8Array(32));
    const commitment = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", pairingSecret)));
    const pairingResponse = await signedFetch(browser, "/v1/pairings", "POST", {
      peerDeviceId: android.deviceId,
      secretCommitment: commitment,
    });
    const pairingId = String((await json(pairingResponse)).pairingId);
    expect((await signedFetch(android, `/v1/pairings/${pairingId}/confirm`, "POST", {
      secretCommitment: commitment,
    })).status).toBe(200);
    const callResponse = await signedFetch(android, "/v1/calls/incoming", "POST", {
      pairingId,
      requestId: crypto.randomUUID(),
    });
    const callId = String((await json(callResponse)).callId);

    let revokeAttempts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url.endsWith("/credentials/race-turn-username/revoke")) {
        revokeAttempts += 1;
        return revokeAttempts === 1
          ? Response.json({ error: "temporary TURN failure" }, { status: 503 })
          : Response.json({ revoked: true });
      }
      expect(request.url).toContain("/v1/turn/keys/integration-turn-key/credentials/generate");
      return Response.json({
        iceServers: {
          urls: ["turn:turn.cloudflare.com:3478?transport=udp"],
          username: "race-turn-username",
          credential: "race-turn-password",
        },
      }, { status: 201 });
    });

    const originalBatch = env.CALL_RELAY_DB.batch.bind(env.CALL_RELAY_DB);
    vi.spyOn(env.CALL_RELAY_DB, "batch").mockImplementationOnce(async (statements) => {
      const now = Date.now();
      await originalBatch([
        env.CALL_RELAY_DB.prepare("UPDATE pairings SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
          .bind(now, pairingId),
        env.CALL_RELAY_DB.prepare(
          `UPDATE call_sessions
           SET state = 'failed', failure_code = 'pairing_revoked', media_failure_code = 'pairing_revoked',
               ended_at = ?, updated_at = ?, version = version + 1
           WHERE id = ? AND state NOT IN ('ended', 'failed')`,
        ).bind(now, now, callId),
      ]);
      return originalBatch(statements);
    });

    const response = await signedFetch(browser, `/v1/calls/${callId}/media-config`, "POST", {});
    expect(response.status).toBe(410);
    expect(await json(response)).toMatchObject({ code: "PAIRING_REVOKED" });
    expect(revokeAttempts).toBe(1);
    const pendingCleanup = await env.CALL_RELAY_DB.prepare(
      "SELECT revoked_at, revoke_attempts, last_error FROM turn_credentials WHERE username = ?",
    ).bind("race-turn-username").first<{ revoked_at: number | null; revoke_attempts: number; last_error: string | null }>();
    expect(pendingCleanup).toMatchObject({
      revoked_at: null,
      revoke_attempts: 1,
      last_error: "Cloudflare TURN revoke failed (503)",
    });

    await revokeDueTurnCredentials(env as unknown as Env);
    expect(revokeAttempts).toBe(2);
    const cleanedUp = await env.CALL_RELAY_DB.prepare(
      "SELECT revoked_at, revoke_attempts, last_error FROM turn_credentials WHERE username = ?",
    ).bind("race-turn-username").first<{ revoked_at: number | null; revoke_attempts: number; last_error: string | null }>();
    expect(cleanedUp).toMatchObject({ revoked_at: expect.any(Number), revoke_attempts: 1, last_error: null });
  });

  it("rejects replayed signatures and oversized enrollment bodies", async () => {
    const browser = await enroll("browser", "Replay test peer");
    const fixed = { nonce: crypto.randomUUID(), timestamp: Date.now().toString() };
    const first = await invoke(await signedRequest(browser, "/v1/calls/current", "GET", undefined, fixed));
    expect(first.status).toBe(200);
    const replay = await invoke(await signedRequest(browser, "/v1/calls/current", "GET", undefined, fixed));
    expect(replay.status).toBe(409);

    const oversized = await invoke(new Request("https://relay.test/v1/devices/enroll", {
      method: "POST",
      headers: { "content-type": "application/json", "x-enrollment-invite": "integration-test-invite" },
      body: JSON.stringify({ platform: "browser", displayName: "x".repeat(17_000), publicKeySpki: "invalid" }),
    }));
    expect(oversized.status).toBe(413);
  });
});
