import { describe, expect, it } from "vitest";
import { deriveSignalKey, signalMac } from "./key-derivation";

describe("per-call signaling authentication", () => {
  it("matches the cross-platform HKDF/HMAC vector", async () => {
    const secret = Uint8Array.from({ length: 32 }, (_, index) => index);
    const pairingKey = await crypto.subtle.importKey("raw", secret.buffer as ArrayBuffer, "HKDF", false, ["deriveKey"]);
    const signalKey = await deriveSignalKey(pairingKey, "call_0123456789abcdef0123456789abcdef");
    const canonical = "1\ncall_0123456789abcdef0123456789abcdef\ndev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\npeer\nsession-1\n1\n1700000000000\nanswer\neyJzZHAiOiJ0ZXN0In0";
    await expect(signalMac(signalKey, canonical)).resolves.toBe("649z0zD0g5SOewjQswZhtQHSxz2zgVVAUvj-SVeHj2E");
  });
});
