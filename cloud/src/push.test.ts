import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverPush } from "./push";
import type { Env } from "./types";

describe("FCM delivery", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ["fid", "f"],
    ["token", "t"],
  ] as const)("targets Android using the stored FCM %s field", async (targetKind, idCharacter) => {
    const deviceId = `dev_${idCharacter.repeat(32)}`;
    const now = Date.now();
    await env.CALL_RELAY_DB.prepare(
      "INSERT INTO devices(id, platform, display_name, public_key_spki, fcm_token, fcm_target_kind, created_at, last_seen_at) VALUES (?, 'android', 'test', 'test', ?, ?, ?, ?)",
    ).bind(deviceId, "test-installation-id", targetKind, now, now).run();

    const requestUrls: string[] = [];
    let sentMessage: unknown;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requestUrls.push(request.url);
      if (request.url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "test-access-token" });
      }
      sentMessage = await request.json();
      return Response.json({ name: "projects/integration-project/messages/test" });
    });

    await deliverPush(env as unknown as Env, { targetDeviceId: deviceId, data: { type: "outgoing_call" } });

    expect(requestUrls).toHaveLength(2);
    expect(sentMessage).toMatchObject({ message: {
      [targetKind]: "test-installation-id",
      data: { type: "outgoing_call" },
    } });
  });
});
