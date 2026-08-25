function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function deriveCallPassphrase(pairingKey: CryptoKey, callId: string): Promise<string> {
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(callId),
      info: new TextEncoder().encode("call-relay-e2ee-v1"),
    },
    pairingKey,
    256,
  );
  return base64Url(new Uint8Array(bits));
}
