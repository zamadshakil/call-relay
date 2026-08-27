import { describe, expect, it } from "vitest";
import { createPeerProof, derivePairingSecret, fromBase64Url, pairingCommitment } from "./pairing-crypto";

describe("pairing v2 cross-platform vector", () => {
  it("derives the fixed P-256 ECDH, HKDF, commitment, and proof values", async () => {
    const privateKey = await crypto.subtle.importKey("jwk", {
      key_ops: ["deriveBits"],
      ext: true,
      kty: "EC",
      x: "5C-uAgDJUOrXaiBH4X5vIFGSjqg9dnngO7tTRCrJI-M",
      y: "GfQbMG9g-g9xuJsri14CFHh3l0B0CLtaI5xT-dTTfMQ",
      crv: "P-256",
      d: "2svvLbe8g8D7e-F10BbtOUtP0cK9T11T3jyTt-9wXZI",
    }, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    const peerPublicKeyRaw = "BOucf96-wMdY7lu44K2pj62BdPX_KzSQu6AYF6hAlvSE_JuZOlp2gy8Q06l43pXmsryCaX2RBd63hbR7F8KQGYw";
    const challenge = Uint8Array.from({ length: 32 }, (_, index) => index);
    const secret = await derivePairingSecret(privateKey, fromBase64Url(peerPublicKeyRaw), challenge);
    expect(Buffer.from(secret).toString("base64url")).toBe("w4A2crfb1uTGkkQ7fsKBiuk-lCqrsbqEBIxUOc5f4NA");
    const commitment = await pairingCommitment(secret);
    expect(commitment).toBe("_zfMsRazpSzuP3E-CG7AUHoJn8zs8lBows_NmBAGS6Y");
    await expect(createPeerProof(
      secret,
      "inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      peerPublicKeyRaw,
      commitment,
    )).resolves.toBe("XaC1HMn4GEAhJQfcHB2XmA7W7UYm-LoAAOuo20w65Jk");
  });
});
