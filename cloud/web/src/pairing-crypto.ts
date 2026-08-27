const encoder = new TextEncoder();

export function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

export async function derivePairingSecret(
  privateKey: CryptoKey,
  androidPublicKeyRaw: Uint8Array,
  challenge: Uint8Array,
): Promise<Uint8Array> {
  if (challenge.byteLength !== 32 || androidPublicKeyRaw.byteLength !== 65) throw new Error("invalid pairing QR key material");
  const androidPublicKey = await crypto.subtle.importKey(
    "raw",
    androidPublicKeyRaw.buffer as ArrayBuffer,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: androidPublicKey }, privateKey, 256);
  const hkdf = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: challenge.buffer as ArrayBuffer,
    info: encoder.encode("call-relay/pairing/v2"),
  }, hkdf, 256));
}

export async function pairingCommitment(secret: Uint8Array): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", secret.buffer as ArrayBuffer)));
}

async function proof(secret: Uint8Array, canonical: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", secret.buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(canonical))));
}

export async function importPairingProofKey(secret: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", secret.buffer as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function proofWithKey(key: CryptoKey, canonical: string): Promise<string> {
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(canonical))));
}

export function peerProofCanonical(
  invitationId: string,
  peerDeviceId: string,
  peerPublicKeyRaw: string,
  commitment: string,
): string {
  return ["peer", invitationId, peerDeviceId, peerPublicKeyRaw, commitment].join("\n");
}

export function androidProofCanonical(
  invitationId: string,
  pairingId: string,
  androidDeviceId: string,
  peerDeviceId: string,
  commitment: string,
): string {
  return ["android", invitationId, pairingId, androidDeviceId, peerDeviceId, commitment].join("\n");
}

export async function createPeerProof(
  secret: Uint8Array,
  invitationId: string,
  peerDeviceId: string,
  peerPublicKeyRaw: string,
  commitment: string,
): Promise<string> {
  return proof(secret, peerProofCanonical(invitationId, peerDeviceId, peerPublicKeyRaw, commitment));
}

export async function verifyAndroidProof(
  secret: Uint8Array,
  candidate: string,
  invitationId: string,
  pairingId: string,
  androidDeviceId: string,
  peerDeviceId: string,
  commitment: string,
): Promise<boolean> {
  const expected = await proof(secret, androidProofCanonical(invitationId, pairingId, androidDeviceId, peerDeviceId, commitment));
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const provided = new Uint8Array(providedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < provided.length; index++) difference |= (provided[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  return difference === 0;
}

export async function verifyAndroidProofWithKey(
  key: CryptoKey,
  candidate: string,
  invitationId: string,
  pairingId: string,
  androidDeviceId: string,
  peerDeviceId: string,
  commitment: string,
): Promise<boolean> {
  const expected = await proofWithKey(key, androidProofCanonical(invitationId, pairingId, androidDeviceId, peerDeviceId, commitment));
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const provided = new Uint8Array(providedHash);
  const expectedBytes = new Uint8Array(expectedHash);
  let difference = 0;
  for (let index = 0; index < provided.length; index++) difference |= (provided[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  return difference === 0;
}
