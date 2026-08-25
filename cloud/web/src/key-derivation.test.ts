import { describe, expect, it } from "vitest";
import { deriveCallPassphrase } from "./key-derivation";

describe("per-call E2EE derivation", () => {
  it("matches the Android HKDF vector", async () => {
    const secret = Uint8Array.from({ length: 32 }, (_, index) => index);
    const key = await crypto.subtle.importKey("raw", secret.buffer as ArrayBuffer, "HKDF", false, ["deriveBits"]);
    await expect(deriveCallPassphrase(key, "call_0123456789abcdef0123456789abcdef"))
      .resolves.toBe("bkFr_ArwK8qzQx2FHpsf1CWj6nsa_aID0akuByZUnDw");
  });
});
