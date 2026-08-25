import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
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
    headers: { "content-type": "application/json", "x-enrollment-invite": "integration-test-invite" },
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
  method: "GET" | "POST",
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
  });
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://relay.test${path}`, { method, headers, body: bodyText || undefined });
}

async function signedFetch(
  device: TestDevice,
  path: string,
  method: "GET" | "POST",
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

describe("Worker control plane", () => {
  it("enforces pairing confirmation, roles, idempotency, state transitions, and least-privilege media grants", async () => {
    const android = await enroll("android", "Relay Android");
    const browser = await enroll("browser", "Browser peer");
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

    const tokenResponse = await signedFetch(browser, `/v1/calls/${incomingCallId}/token`, "POST", {});
    expect(tokenResponse.status).toBe(200);
    const tokenBody = await json(tokenResponse);
    const token = String(tokenBody.participantToken);
    const segments = token.split(".");
    expect(segments).toHaveLength(3);
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(segments[1] ?? ""))) as Record<string, unknown>;
    const verificationKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("integration-api-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    expect(await crypto.subtle.verify(
      "HMAC",
      verificationKey,
      fromBase64Url(segments[2] ?? "").buffer as ArrayBuffer,
      new TextEncoder().encode(`${segments[0]}.${segments[1]}`),
    )).toBe(true);
    const grant = claims.video as Record<string, unknown>;
    expect(grant.room).toBe(`call-${incomingCallId}`);
    expect(grant.roomJoin).toBe(true);
    expect(grant.canPublishSources).toEqual(["microphone"]);
    expect(grant.canPublishData).toBe(false);
    expect(claims.sub).toBe(browser.deviceId);

    const accepted = await event(browser, incomingCallId, "accept");
    expect((await json(accepted)).state).toBe("accepted");
    expect((await json(await event(android, incomingCallId, "active"))).state).toBe("active");
    expect((await json(await event(android, incomingCallId, "end"))).state).toBe("ended");

    const current = await signedFetch(browser, "/v1/calls/current", "GET");
    expect(current.status).toBe(200);
    expect((await json(current)).call).toBeNull();
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
