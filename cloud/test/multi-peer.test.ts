import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { exportJWK, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

type Platform = "android" | "browser" | "ios";

interface TestDevice {
  deviceId: string;
  platform: Platform;
  privateKey: CryptoKey;
  agreementPublicKeyRaw: string;
}

interface MultiPeerFixture {
  uid: string;
  token: string;
  android: TestDevice;
  browser: TestDevice;
  ios: TestDevice;
  browserPairingId: string;
  iosPairingId: string;
}

let firebasePrivateKey: CryptoKey;
let firebasePublicJwk: Record<string, unknown>;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function firebaseToken(uid: string, email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email, email_verified: true, auth_time: now - 10, name: "Multi Peer User" })
    .setProtectedHeader({ alg: "RS256", kid: "firebase-multi-peer-key" })
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

function bearerRequest(
  path: string,
  token: string,
  method: "GET" | "POST" = "GET",
  body?: Record<string, unknown>,
): Request {
  return new Request(`https://relay.test${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
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
  const bodyHash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
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
      "x-relay-app-version": device.platform === "android" ? "android-webrtc-3" : "ios-native-1",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? bodyText : undefined,
  });
}

async function registerDevice(token: string, platform: Platform, displayName: string): Promise<TestDevice> {
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
  return {
    deviceId: String((await responseJson(response)).deviceId),
    platform,
    privateKey: signing.privateKey,
    agreementPublicKeyRaw,
  };
}

async function insertConfirmedPairing(
  uid: string,
  android: TestDevice,
  peer: TestDevice,
  createdAt: number,
): Promise<string> {
  const invitationId = `inv_${crypto.randomUUID().replaceAll("-", "")}`;
  const pairingId = `pair_${crypto.randomUUID().replaceAll("-", "")}`;
  const [deviceAId, deviceBId] = [android.deviceId, peer.deviceId].sort();
  const opaque = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  await env.CALL_RELAY_DB.batch([
    env.CALL_RELAY_DB.prepare(
      `INSERT INTO pairing_invitations(
         id, user_id, android_device_id, challenge_hash, peer_device_id, peer_public_key_raw,
         peer_commitment, peer_proof, created_at, expires_at, consumed_at, confirmed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      invitationId,
      uid,
      android.deviceId,
      opaque,
      peer.deviceId,
      peer.agreementPublicKeyRaw,
      opaque,
      opaque,
      createdAt,
      createdAt + 300_000,
      createdAt,
      createdAt,
    ),
    env.CALL_RELAY_DB.prepare(
      `INSERT INTO pairings(
         id, device_a_id, device_b_id, secret_commitment, created_at, created_by_device_id,
         confirmed_by_device_id, confirmed_at, protocol_version, user_id, invitation_id,
         peer_proof, android_proof
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?, ?, ?, ?)`,
    ).bind(
      pairingId,
      deviceAId,
      deviceBId,
      opaque,
      createdAt,
      peer.deviceId,
      android.deviceId,
      createdAt,
      uid,
      invitationId,
      opaque,
      opaque,
    ),
    env.CALL_RELAY_DB.prepare(
      "UPDATE pairing_invitations SET pairing_id = ? WHERE id = ?",
    ).bind(pairingId, invitationId),
  ]);
  return pairingId;
}

async function provisionFixture(label: string): Promise<MultiPeerFixture> {
  const suffix = `${label}-${crypto.randomUUID()}`;
  const uid = `multi-${suffix}`;
  const email = `multi-${suffix}@gmail.com`;
  const token = await firebaseToken(uid, email);
  const now = Date.now();
  await env.CALL_RELAY_DB.prepare(
    "INSERT INTO approved_emails(email, status, created_at, updated_at) VALUES (?, 'approved', ?, ?)",
  ).bind(email, now, now).run();
  expect((await invoke(bearerRequest("/v1/me", token))).status).toBe(200);
  await env.CALL_RELAY_DB.prepare(
    `INSERT INTO billing_subscriptions(user_id, plan_code, status, current_period_ends_at, created_at, updated_at)
     VALUES (?, 'monthly', 'active', ?, ?, ?)`,
  ).bind(uid, now + 30 * 24 * 60 * 60 * 1000, now, now).run();

  const android = await registerDevice(token, "android", `${label} Android`);
  const [browser, ios] = await Promise.all([
    registerDevice(token, "browser", `${label} Browser`),
    registerDevice(token, "ios", `${label} iPhone`),
  ]);
  const browserPairingId = await insertConfirmedPairing(uid, android, browser, now + 1);
  const iosPairingId = await insertConfirmedPairing(uid, android, ios, now + 2);
  return { uid, token, android, browser, ios, browserPairingId, iosPairingId };
}

async function createIncoming(
  fixture: MultiPeerFixture,
  body: Record<string, unknown> = {},
): Promise<{ callId: string; requestId: string; response: Response }> {
  const requestId = crypto.randomUUID();
  const response = await invoke(await signedRequest(fixture.android, "/v1/calls/incoming", "POST", {
    requestId,
    phoneNumber: "+923001234567",
    ...body,
  }));
  const payload = await responseJson(response.clone());
  return { callId: String(payload.callId), requestId, response };
}

async function sendEvent(
  device: TestDevice,
  callId: string,
  type: string,
  payload: Record<string, unknown> = {},
): Promise<Response> {
  return invoke(await signedRequest(device, `/v1/calls/${callId}/events`, "POST", {
    type,
    commandId: crypto.randomUUID(),
    payload,
  }));
}

async function durableSnapshot(pairingId: string, peerDeviceId: string): Promise<Record<string, unknown>> {
  const response = await env.PAIRING_SIGNAL.getByName(pairingId).fetch(new Request("https://pairing-signal.internal/connect", {
    headers: {
      upgrade: "websocket",
      "x-relay-signal-device": peerDeviceId,
      "x-relay-signal-role": "peer",
      "x-relay-signal-jti": crypto.randomUUID(),
      "x-relay-signal-exp": String(Date.now() + 60_000),
    },
  }));
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  expect(socket).toBeTruthy();
  const snapshot = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`snapshot timeout for ${pairingId}`)), 2_000);
    socket!.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message: unknown = JSON.parse(event.data);
      if (
        typeof message === "object" && message !== null &&
        "type" in message && message.type === "call_snapshot" &&
        "call" in message && typeof message.call === "object" && message.call !== null
      ) {
        clearTimeout(timeout);
        resolve(message.call as Record<string, unknown>);
      }
    });
  });
  socket!.accept();
  try {
    return await snapshot;
  } finally {
    socket!.close(1000, "snapshot received");
  }
}

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  firebasePrivateKey = pair.privateKey;
  firebasePublicJwk = { ...(await exportJWK(pair.publicKey)), kid: "firebase-multi-peer-key", alg: "RS256" };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url.includes("securetoken@system.gserviceaccount.com")) {
      return Response.json({ keys: [firebasePublicJwk] }, { headers: { "cache-control": "public, max-age=3600" } });
    }
    if (request.url.includes("rtc.live.cloudflare.com") && request.url.endsWith("/revoke")) {
      return Response.json({ revoked: true });
    }
    throw new Error(`unexpected fetch in multi-peer test: ${request.url}`);
  });
});

afterAll(() => vi.unstubAllGlobals());

describe("multi-peer call routing", () => {
  it("installs the multi-peer schema and registers one browser plus one iPhone without breaking legacy pairing fields", async () => {
    const callColumns = await env.CALL_RELAY_DB.prepare("PRAGMA table_info(call_sessions)").all<{ name: string }>();
    expect(callColumns.results.map((column) => column.name)).toEqual(expect.arrayContaining([
      "selected_pairing_id",
      "selected_peer_device_id",
    ]));
    const recipientColumns = await env.CALL_RELAY_DB.prepare("PRAGMA table_info(call_recipients)").all<{ name: string }>();
    expect(recipientColumns.results.map((column) => column.name)).toEqual(expect.arrayContaining([
      "call_id",
      "pairing_id",
      "peer_device_id",
      "status",
      "decision_command_id",
    ]));

    const fixture = await provisionFixture("registration");
    const devicePlatforms = await env.CALL_RELAY_DB.prepare(
      "SELECT platform FROM devices WHERE user_id = ? AND revoked_at IS NULL ORDER BY platform",
    ).bind(fixture.uid).all<{ platform: Platform }>();
    expect(devicePlatforms.results.map((row) => row.platform)).toEqual(["android", "browser", "ios"]);

    const accountPairings = await responseJson(await invoke(bearerRequest("/v1/pairings/current", fixture.token)));
    const pairings = accountPairings.pairings as Array<Record<string, unknown>>;
    expect(pairings).toHaveLength(2);
    expect(accountPairings.pairing).toEqual(pairings[0]);
    expect(pairings.map((pairing) => pairing.id)).toEqual([
      fixture.iosPairingId,
      fixture.browserPairingId,
    ]);

    const devicePairings = await responseJson(await invoke(await signedRequest(
      fixture.android,
      "/v1/pairings/current-device",
      "GET",
    )));
    const androidPairings = devicePairings.pairings as Array<Record<string, unknown>>;
    expect(androidPairings).toHaveLength(2);
    expect(devicePairings.pairing).toEqual(androidPairings[0]);
    expect(androidPairings.map((pairing) => pairing.peer_platform)).toEqual(["ios", "browser"]);

    const secondBrowser = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const secondAgreement = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const duplicateBrowser = await invoke(bearerRequest("/v1/devices/register", fixture.token, "POST", {
      platform: "browser",
      displayName: "Disallowed second browser",
      publicKeySpki: base64Url(new Uint8Array(await crypto.subtle.exportKey("spki", secondBrowser.publicKey))),
      agreementPublicKeyRaw: base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", secondAgreement.publicKey))),
      appVersion: 3,
    }));
    expect(duplicateBrowser.status).toBe(409);
  });

  it("atomically selects the first answering peer, tailors snapshots, and rejects losing-peer controls", async () => {
    const fixture = await provisionFixture("claim");
    const created = await createIncoming(fixture);
    expect(created.response.status).toBe(201);

    const browserBefore = await responseJson(await invoke(await signedRequest(
      fixture.browser,
      `/v1/calls/${created.callId}`,
      "GET",
    )));
    const iosBefore = await responseJson(await invoke(await signedRequest(
      fixture.ios,
      `/v1/calls/${created.callId}`,
      "GET",
    )));
    expect(browserBefore.call).toMatchObject({
      selected_pairing_id: null,
      selected_peer_device_id: null,
      recipient_status: "ringing",
      phone_number: "+923001234567",
    });
    expect(iosBefore.call).toMatchObject({ recipient_status: "ringing" });
    expect(await durableSnapshot(fixture.browserPairingId, fixture.browser.deviceId)).toMatchObject({
      id: created.callId,
      recipient_status: "ringing",
    });
    expect(await durableSnapshot(fixture.iosPairingId, fixture.ios.deviceId)).toMatchObject({
      id: created.callId,
      recipient_status: "ringing",
    });

    const browserAcceptRequest = await signedRequest(fixture.browser, `/v1/calls/${created.callId}/events`, "POST", {
      type: "accept",
      commandId: crypto.randomUUID(),
      payload: {},
    });
    const iosAcceptRequest = await signedRequest(fixture.ios, `/v1/calls/${created.callId}/events`, "POST", {
      type: "accept",
      commandId: crypto.randomUUID(),
      payload: {},
    });
    const results = await Promise.all([invoke(browserAcceptRequest), invoke(iosAcceptRequest)]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = results[0]?.status === 200 ? fixture.browser : fixture.ios;
    const loser = results[0]?.status === 409 ? fixture.browser : fixture.ios;
    const winningPairingId = winner.deviceId === fixture.browser.deviceId
      ? fixture.browserPairingId
      : fixture.iosPairingId;
    const loserResponse = results.find((response) => response.status === 409);
    expect((await responseJson(loserResponse!)).code).toBe("CALL_CLAIMED");

    const call = await env.CALL_RELAY_DB.prepare(
      "SELECT state, pairing_id, peer_device_id, selected_pairing_id, selected_peer_device_id FROM call_sessions WHERE id = ?",
    ).bind(created.callId).first<Record<string, unknown>>();
    expect(call).toMatchObject({
      state: "accepted",
      pairing_id: winningPairingId,
      peer_device_id: winner.deviceId,
      selected_pairing_id: winningPairingId,
      selected_peer_device_id: winner.deviceId,
    });
    const recipients = await env.CALL_RELAY_DB.prepare(
      "SELECT peer_device_id, status FROM call_recipients WHERE call_id = ? ORDER BY peer_device_id",
    ).bind(created.callId).all<{ peer_device_id: string; status: string }>();
    expect(recipients.results.find((recipient) => recipient.peer_device_id === winner.deviceId)?.status).toBe("selected");
    expect(recipients.results.find((recipient) => recipient.peer_device_id === loser.deviceId)?.status).toBe("answered_elsewhere");
    const browserCancellation = await env.CALL_RELAY_DB.prepare(
      `SELECT payload_json FROM push_outbox
       WHERE target_device_id = ? AND json_extract(payload_json, '$.data.type') = 'call_cancelled'
         AND json_extract(payload_json, '$.data.callId') = ?`,
    ).bind(fixture.browser.deviceId, created.callId).first<{ payload_json: string }>();
    if (loser.deviceId === fixture.browser.deviceId) {
      expect(JSON.parse(browserCancellation?.payload_json ?? "{}").data).toMatchObject({
        type: "call_cancelled",
        event: "answered_elsewhere",
        callId: created.callId,
      });
    } else {
      expect(browserCancellation).toBeNull();
    }

    expect(await durableSnapshot(winningPairingId, winner.deviceId)).toMatchObject({
      id: created.callId,
      recipient_status: "selected",
    });
    const losingPairingId = loser.deviceId === fixture.browser.deviceId
      ? fixture.browserPairingId
      : fixture.iosPairingId;
    expect(await durableSnapshot(losingPairingId, loser.deviceId)).toMatchObject({
      id: created.callId,
      recipient_status: "answered_elsewhere",
    });

    const winnerCurrent = await responseJson(await invoke(await signedRequest(winner, "/v1/calls/current", "GET")));
    const loserCurrent = await responseJson(await invoke(await signedRequest(loser, "/v1/calls/current", "GET")));
    expect(winnerCurrent.call).toMatchObject({ id: created.callId, recipient_status: "selected" });
    expect(loserCurrent.call).toMatchObject({ id: created.callId, recipient_status: "answered_elsewhere" });

    const losingControl = await sendEvent(loser, created.callId, "mute", { muted: true });
    expect(losingControl.status).toBe(403);
    expect((await responseJson(losingControl)).code).toBe("CALL_NOT_SELECTED");
    expect((await sendEvent(winner, created.callId, "mute", { muted: true })).status).toBe(200);

    const revokeLoser = await invoke(bearerRequest(`/v1/devices/${loser.deviceId}/revoke`, fixture.token, "POST"));
    expect(revokeLoser.status).toBe(200);
    expect((await env.CALL_RELAY_DB.prepare("SELECT state FROM call_sessions WHERE id = ?")
      .bind(created.callId).first<{ state: string }>())?.state).toBe("accepted");

    const revokeWinner = await invoke(bearerRequest(`/v1/devices/${winner.deviceId}/revoke`, fixture.token, "POST"));
    expect(revokeWinner.status).toBe(200);
    expect(await env.CALL_RELAY_DB.prepare("SELECT state, failure_code FROM call_sessions WHERE id = ?")
      .bind(created.callId).first()).toMatchObject({ state: "failed", failure_code: "pairing_revoked" });
  });

  it("cancels the browser Web Push ring when the native iPhone wins", async () => {
    const fixture = await provisionFixture("ios-wins");
    const created = await createIncoming(fixture);
    expect((await sendEvent(fixture.ios, created.callId, "accept")).status).toBe(200);

    const cancellation = await env.CALL_RELAY_DB.prepare(
      `SELECT channel, payload_json FROM push_outbox
       WHERE target_device_id = ? AND json_extract(payload_json, '$.data.type') = 'call_cancelled'
         AND json_extract(payload_json, '$.data.callId') = ?`,
    ).bind(fixture.browser.deviceId, created.callId).first<{ channel: string; payload_json: string }>();
    expect(cancellation?.channel).toBe("web_push");
    expect(JSON.parse(cancellation?.payload_json ?? "{}").data).toMatchObject({
      type: "call_cancelled",
      event: "answered_elsewhere",
      callId: created.callId,
    });
    const browserSnapshot = await responseJson(await invoke(await signedRequest(
      fixture.browser,
      `/v1/calls/${created.callId}`,
      "GET",
    )));
    expect(browserSnapshot.call).toMatchObject({ recipient_status: "answered_elsewhere" });
  });

  it("declines only one recipient at a time and ends the Android request only after every peer declines", async () => {
    const fixture = await provisionFixture("reject");
    const created = await createIncoming(fixture);
    expect(created.response.status).toBe(201);

    const firstReject = await sendEvent(fixture.browser, created.callId, "reject");
    expect(firstReject.status).toBe(200);
    expect(await responseJson(firstReject)).toMatchObject({ state: "ringing_peer" });
    const afterFirst = await env.CALL_RELAY_DB.prepare(
      "SELECT peer_device_id, status FROM call_recipients WHERE call_id = ? ORDER BY peer_device_id",
    ).bind(created.callId).all<{ peer_device_id: string; status: string }>();
    expect(afterFirst.results.find((recipient) => recipient.peer_device_id === fixture.browser.deviceId)?.status).toBe("declined");
    expect(afterFirst.results.find((recipient) => recipient.peer_device_id === fixture.ios.deviceId)?.status).toBe("ringing");
    expect((await env.CALL_RELAY_DB.prepare("SELECT state FROM call_sessions WHERE id = ?")
      .bind(created.callId).first<{ state: string }>())?.state).toBe("ringing_peer");

    const duplicateRejectCommandId = crypto.randomUUID();
    const firstDuplicateRequest = await signedRequest(fixture.browser, `/v1/calls/${created.callId}/events`, "POST", {
      type: "reject",
      commandId: duplicateRejectCommandId,
      payload: {},
    });
    expect((await invoke(firstDuplicateRequest)).status).toBe(200);

    const finalReject = await sendEvent(fixture.ios, created.callId, "reject");
    expect(finalReject.status).toBe(200);
    expect(await responseJson(finalReject)).toMatchObject({ state: "ending" });
    const finalRecipients = await env.CALL_RELAY_DB.prepare(
      "SELECT status FROM call_recipients WHERE call_id = ? ORDER BY status",
    ).bind(created.callId).all<{ status: string }>();
    expect(finalRecipients.results.map((recipient) => recipient.status)).toEqual(["declined", "declined"]);
    const androidRejectPush = await env.CALL_RELAY_DB.prepare(
      `SELECT payload_json FROM push_outbox
       WHERE target_device_id = ? AND json_extract(payload_json, '$.data.callId') = ?
         AND json_extract(payload_json, '$.data.event') = 'reject'`,
    ).bind(fixture.android.deviceId, created.callId).first<{ payload_json: string }>();
    expect(androidRejectPush).not.toBeNull();
  });

  it("keeps recipient decisions consistent when both peers reject concurrently", async () => {
    const fixture = await provisionFixture("concurrent-reject");
    const created = await createIncoming(fixture);
    const [browserReject, iosReject] = await Promise.all([
      sendEvent(fixture.browser, created.callId, "reject"),
      sendEvent(fixture.ios, created.callId, "reject"),
    ]);

    expect([browserReject.status, iosReject.status].sort()).toEqual([200, 200]);
    expect(await env.CALL_RELAY_DB.prepare("SELECT state FROM call_sessions WHERE id = ?")
      .bind(created.callId).first()).toMatchObject({ state: "ending" });
    const recipients = await env.CALL_RELAY_DB.prepare(
      "SELECT status FROM call_recipients WHERE call_id = ? ORDER BY peer_device_id",
    ).bind(created.callId).all<{ status: string }>();
    expect(recipients.results.map((recipient) => recipient.status)).toEqual(["declined", "declined"]);
  });

  it("allows a remaining peer to accept while the other peer is rejecting", async () => {
    const fixture = await provisionFixture("accept-reject-race");
    const created = await createIncoming(fixture);
    const [browserReject, iosAccept] = await Promise.all([
      sendEvent(fixture.browser, created.callId, "reject"),
      sendEvent(fixture.ios, created.callId, "accept"),
    ]);

    expect(iosAccept.status).toBe(200);
    expect([200, 409]).toContain(browserReject.status);
    expect(await env.CALL_RELAY_DB.prepare(
      "SELECT state, selected_pairing_id, selected_peer_device_id FROM call_sessions WHERE id = ?",
    ).bind(created.callId).first()).toMatchObject({
      state: "accepted",
      selected_pairing_id: fixture.iosPairingId,
      selected_peer_device_id: fixture.ios.deviceId,
    });
    const recipients = await env.CALL_RELAY_DB.prepare(
      "SELECT peer_device_id, status FROM call_recipients WHERE call_id = ?",
    ).bind(created.callId).all<{ peer_device_id: string; status: string }>();
    expect(recipients.results.find((recipient) => recipient.peer_device_id === fixture.ios.deviceId)?.status).toBe("selected");
    expect(["declined", "answered_elsewhere"]).toContain(
      recipients.results.find((recipient) => recipient.peer_device_id === fixture.browser.deviceId)?.status,
    );
  });

  it("keeps the legacy pairingId request shape, deduplicates requests, and recovers stale multi-peer calls", async () => {
    const fixture = await provisionFixture("recovery");
    const first = await createIncoming(fixture, { pairingId: fixture.browserPairingId });
    expect(first.response.status).toBe(201);
    const firstRecipients = await env.CALL_RELAY_DB.prepare(
      "SELECT pairing_id, status FROM call_recipients WHERE call_id = ? ORDER BY pairing_id",
    ).bind(first.callId).all<{ pairing_id: string; status: string }>();
    expect(firstRecipients.results).toHaveLength(2);
    expect(firstRecipients.results.every((recipient) => recipient.status === "ringing")).toBe(true);

    const duplicate = await invoke(await signedRequest(fixture.android, "/v1/calls/incoming", "POST", {
      requestId: first.requestId,
      pairingId: fixture.browserPairingId,
      phoneNumber: "+923001234567",
    }));
    expect(duplicate.status).toBe(200);
    expect(await responseJson(duplicate)).toMatchObject({ callId: first.callId, state: "ringing_peer", duplicate: true });

    await env.CALL_RELAY_DB.prepare("UPDATE call_sessions SET updated_at = ? WHERE id = ?")
      .bind(Date.now() - 121_000, first.callId).run();
    const recovered = await createIncoming(fixture);
    expect(recovered.response.status).toBe(201);
    expect(recovered.callId).not.toBe(first.callId);
    expect(await env.CALL_RELAY_DB.prepare("SELECT state, failure_code FROM call_sessions WHERE id = ?")
      .bind(first.callId).first()).toMatchObject({ state: "failed", failure_code: "stale_session" });
    const staleRecipients = await env.CALL_RELAY_DB.prepare(
      "SELECT status FROM call_recipients WHERE call_id = ? ORDER BY pairing_id",
    ).bind(first.callId).all<{ status: string }>();
    expect(staleRecipients.results.map((recipient) => recipient.status)).toEqual(["missed", "missed"]);
  });
});
