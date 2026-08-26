function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export async function deriveSignalKey(pairingKey: CryptoKey, callId: string): Promise<CryptoKey> {
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode(callId),
      info: new TextEncoder().encode("call-relay/signaling/v1"),
    },
    pairingKey,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export async function signalMac(key: CryptoKey, canonical: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical));
  return base64Url(new Uint8Array(signature));
}

export async function verifySignalMac(key: CryptoKey, canonical: string, mac: Uint8Array): Promise<boolean> {
  return crypto.subtle.verify("HMAC", key, mac.buffer as ArrayBuffer, new TextEncoder().encode(canonical));
}
