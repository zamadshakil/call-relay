import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Env } from "./types";

type Frame = Record<string, unknown>;

interface SocketCollector {
  socket: WebSocket;
  waitFor(predicate: (frame: Frame) => boolean): Promise<Frame>;
}

function collect(socket: WebSocket): SocketCollector {
  const frames: Frame[] = [];
  const waiters: Array<{ predicate: (frame: Frame) => boolean; resolve: (frame: Frame) => void }> = [];
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String(event.data)) as Frame;
    frames.push(frame);
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter?.predicate(frame)) {
        waiters.splice(index, 1);
        waiter.resolve(frame);
      }
    }
  });
  socket.accept();
  return {
    socket,
    async waitFor(predicate): Promise<Frame> {
      const existing = frames.find(predicate);
      if (existing) return existing;
      return new Promise<Frame>((resolve, reject) => {
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error("timed out waiting for signaling frame"));
        }, 2_000);
      });
    },
  };
}

async function openSocket(
  stub: DurableObjectStub<import("./pairing-signal").PairingSignal>,
  role: "android" | "peer",
  deviceId: string,
): Promise<SocketCollector> {
  const response = await stub.fetch(new Request("https://pairing-signal.internal/connect", {
    headers: {
      upgrade: "websocket",
      "x-relay-signal-device": deviceId,
      "x-relay-signal-role": role,
      "x-relay-signal-jti": crypto.randomUUID(),
      "x-relay-signal-exp": String(Date.now() + 60_000),
    },
  }));
  expect(response.status).toBe(101);
  expect(response.webSocket).toBeDefined();
  return collect(response.webSocket as WebSocket);
}

describe("PairingSignal Durable Object", () => {
  it("versions live presence, validates offer requests, and closes revoked pairings", async () => {
    const pairingName = `pair-test-${crypto.randomUUID()}`;
    const stub = (env as unknown as Env).PAIRING_SIGNAL.getByName(pairingName);
    const callId = `call_${"a".repeat(32)}`;
    await stub.publishSnapshot(JSON.stringify({ id: callId, state: "created", version: 0, created_at: Date.now() }));

    const peerDeviceId = `dev_${"b".repeat(32)}`;
    const androidDeviceId = `dev_${"c".repeat(32)}`;
    const peer = await openSocket(stub, "peer", peerDeviceId);
    const peerHello = await peer.waitFor((frame) => frame.type === "hello");
    const firstPresence = await peer.waitFor((frame) => frame.type === "presence");
    expect(firstPresence).toMatchObject({ android: false, peer: true, version: expect.any(Number), serverTime: expect.any(Number) });

    const android = await openSocket(stub, "android", androidDeviceId);
    const secondPresence = await peer.waitFor(
      (frame) => frame.type === "presence" && Number(frame.version) > Number(firstPresence.version),
    );
    expect(secondPresence).toMatchObject({ android: true, peer: true, serverTime: expect.any(Number) });

    const invalidOfferRequest = {
      version: 1,
      callId,
      senderDeviceId: peerDeviceId,
      role: "peer",
      sessionId: peerHello.sessionId,
      sequence: 1,
      timestamp: Date.now(),
      type: "offer_request",
      payload: "",
      mac: "A".repeat(43),
    };
    peer.socket.send(JSON.stringify(invalidOfferRequest));
    const protocolError = await peer.waitFor((frame) => frame.type === "protocol_error");
    expect(protocolError).toMatchObject({ code: "INVALID_SIGNAL_ENVELOPE", serverTime: expect.any(Number) });

    const negotiationId = "negotiation_0001";
    peer.socket.send(JSON.stringify({ ...invalidOfferRequest, negotiationId }));
    const relayed = await android.waitFor((frame) => frame.type === "offer_request");
    expect(relayed).toMatchObject({ callId, senderDeviceId: peerDeviceId, negotiationId });

    const peerClose = new Promise<CloseEvent>((resolve) => peer.socket.addEventListener("close", resolve, { once: true }));
    const androidClose = new Promise<CloseEvent>((resolve) => android.socket.addEventListener("close", resolve, { once: true }));
    await stub.revokePairing("device_replaced", Date.now());
    expect(await peer.waitFor((frame) => frame.type === "pairing_revoked")).toMatchObject({
      code: "PAIRING_REVOKED",
      reason: "device_replaced",
      version: expect.any(Number),
      serverTime: expect.any(Number),
    });
    expect((await peerClose).code).toBe(4003);
    expect((await androidClose).code).toBe(4003);

    const rejected = await stub.fetch(new Request("https://pairing-signal.internal/connect", {
      headers: {
        upgrade: "websocket",
        "x-relay-signal-device": peerDeviceId,
        "x-relay-signal-role": "peer",
        "x-relay-signal-jti": crypto.randomUUID(),
        "x-relay-signal-exp": String(Date.now() + 60_000),
      },
    }));
    expect(rejected.status).toBe(410);
    expect(await rejected.json()).toMatchObject({ code: "PAIRING_REVOKED" });
  });
});
