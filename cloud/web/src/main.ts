import { ExternalE2EEKeyProvider, Room, RoomEvent, Track } from "livekit-client";
import QRCode from "qrcode";
import { deriveCallPassphrase } from "./key-derivation";
import "./style.css";

interface StoredIdentity {
  deviceId: string;
  publicKeySpki: string;
  pairingId?: string;
  // Migrated once from the original development build into non-exportable IndexedDB keys.
  privateKeyJwk?: JsonWebKey;
  pairingSecret?: string;
}

interface CallView {
  id: string;
  direction: "incoming" | "outgoing";
  state: string;
  relay_mode: "full_duplex" | "listen" | "talk";
}

const element = <T extends HTMLElement>(id: string): T => document.querySelector<T>(`#${id}`)!;
const logElement = element<HTMLPreElement>("log");
const log = (message: string): void => {
  logElement.textContent = `${new Date().toLocaleTimeString()}  ${message}\n${logElement.textContent ?? ""}`;
};
const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
};
const fromBase64Url = (value: string): Uint8Array => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
};
const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const identityKey = "call-relay-browser-identity-v1";
const keyDatabaseName = "call-relay-browser-keys-v1";
const signingKeyName = "device-signing";
const pairingKeyName = "pairing-hkdf";
let identity: StoredIdentity | undefined = loadIdentity();
let signingKey: CryptoKey | undefined;
let pairingKey: CryptoKey | undefined;
let pairingQrSecret = "";
let room: Room | undefined;
let roomCallId = "";
let joining: Promise<void> | undefined;
let mediaGeneration = 0;
let polling = false;
let lastSeenCallId = "";
let lastPollingError = "";

function loadIdentity(): StoredIdentity | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(identityKey) ?? "null");
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.deviceId !== "string" || typeof record.publicKeySpki !== "string") return undefined;
    return value as StoredIdentity;
  } catch {
    return undefined;
  }
}

function openKeyDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(keyDatabaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("keys");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("browser key database could not open"));
  });
}

async function storedKey(name: string): Promise<CryptoKey | undefined> {
  const database = await openKeyDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction("keys", "readonly").objectStore("keys").get(name);
      request.onsuccess = () => {
        const value: unknown = request.result;
        const looksLikeCryptoKey = typeof value === "object" && value !== null &&
          "type" in value && "algorithm" in value && "usages" in value && "extractable" in value;
        resolve(looksLikeCryptoKey ? value as CryptoKey : undefined);
      };
      request.onerror = () => reject(request.error ?? new Error("browser key could not be read"));
    });
  } finally {
    database.close();
  }
}

async function storeKey(name: string, key: CryptoKey): Promise<void> {
  const database = await openKeyDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("keys", "readwrite");
      transaction.objectStore("keys").put(key, name);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("browser key could not be stored"));
      transaction.onabort = () => reject(transaction.error ?? new Error("browser key storage was aborted"));
    });
  } finally {
    database.close();
  }
}

async function deleteKey(name: string): Promise<void> {
  const database = await openKeyDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("keys", "readwrite");
      transaction.objectStore("keys").delete(name);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error("browser key could not be removed"));
    });
  } finally {
    database.close();
  }
}

async function initializeKeys(): Promise<void> {
  signingKey = await storedKey(signingKeyName);
  pairingKey = await storedKey(pairingKeyName);
  if (identity?.privateKeyJwk && !signingKey) {
    signingKey = await crypto.subtle.importKey(
      "jwk",
      identity.privateKeyJwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    await storeKey(signingKeyName, signingKey);
  }
  if (identity?.pairingSecret && !pairingKey) {
    const secret = fromBase64Url(identity.pairingSecret);
    if (secret.byteLength === 32) {
      pairingQrSecret = identity.pairingSecret;
      pairingKey = await crypto.subtle.importKey("raw", secret.buffer as ArrayBuffer, "HKDF", false, ["deriveBits"]);
      await storeKey(pairingKeyName, pairingKey);
    }
  }
  if (identity) {
    delete identity.privateKeyJwk;
    delete identity.pairingSecret;
    saveIdentity();
  } else {
    render();
  }
}

const keysReady = initializeKeys().catch((error) => {
  log(`ERROR: secure browser key storage failed: ${String(error)}`);
  throw error;
});

function saveIdentity(): void {
  if (identity) localStorage.setItem(identityKey, JSON.stringify(identity));
  else localStorage.removeItem(identityKey);
  render();
}

function render(): void {
  element<HTMLOutputElement>("identity").value = identity ? `Device: ${identity.deviceId}` : "Not enrolled";
  element<HTMLOutputElement>("pairing").value = identity?.pairingId
    ? `Pairing: ${identity.pairingId}${pairingQrSecret ? " — scan the QR now" : " — key secured; recreate to show a new QR"}`
    : "Not paired";
  const canvas = element<HTMLCanvasElement>("pairingQr");
  if (identity?.pairingId && pairingQrSecret) {
    const parameters = new URLSearchParams({ pairingId: identity.pairingId, secret: pairingQrSecret });
    canvas.hidden = false;
    void QRCode.toCanvas(canvas, `callrelay://pair?${parameters.toString()}`, { width: 240, margin: 2 });
  } else {
    canvas.hidden = true;
  }
}

async function signedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  await keysReady;
  if (!identity) throw new Error("enroll this browser first");
  if (!signingKey) throw new Error("browser signing key is unavailable; enroll again");
  const method = (init.method ?? "GET").toUpperCase();
  const bodyText = typeof init.body === "string" ? init.body : "";
  const bodyHash = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText))));
  const timestamp = Date.now().toString();
  const nonce = crypto.randomUUID();
  const canonical = `${method}\n${path}\n${bodyHash}\n${timestamp}\n${nonce}`;
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, new TextEncoder().encode(canonical)));
  const headers = new Headers(init.headers);
  headers.set("x-relay-device", identity.deviceId);
  headers.set("x-relay-timestamp", timestamp);
  headers.set("x-relay-nonce", nonce);
  headers.set("x-relay-signature", base64Url(signature));
  if (bodyText) headers.set("content-type", "application/json");
  return fetch(apiUrl(path), { ...init, method, headers });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("server returned invalid JSON");
  const data = value as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `request failed (${response.status})`);
  return data;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`server response is missing ${name}`);
  return value;
}

function apiUrl(path: string): string {
  const configured = element<HTMLInputElement>("apiBase").value.trim().replace(/\/$/u, "");
  if (!configured) return path;
  const url = new URL(configured);
  if (url.origin !== location.origin || (url.pathname !== "" && url.pathname !== "/")) {
    throw new Error("API base must be this console's own origin");
  }
  return `${url.origin}${path}`;
}

function callView(value: unknown): CallView | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || (record.direction !== "incoming" && record.direction !== "outgoing") || typeof record.state !== "string") return undefined;
  const mode = record.relay_mode;
  if (mode !== "full_duplex" && mode !== "listen" && mode !== "talk") return undefined;
  return { id: record.id, direction: record.direction, state: record.state, relay_mode: mode };
}

element("enroll").addEventListener("click", () => void (async () => {
  await keysReady;
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const response = await fetch(apiUrl("/v1/devices/enroll"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-enrollment-invite": element<HTMLInputElement>("invite").value },
    body: JSON.stringify({ platform: "browser", displayName: element<HTMLInputElement>("deviceName").value, publicKeySpki: base64Url(spki) }),
  });
  const data = await responseJson(response);
  signingKey = keys.privateKey;
  pairingKey = undefined;
  pairingQrSecret = "";
  await Promise.all([storeKey(signingKeyName, signingKey), deleteKey(pairingKeyName)]);
  identity = { deviceId: requiredString(data.deviceId, "deviceId"), publicKeySpki: base64Url(spki) };
  saveIdentity();
  log("Browser enrolled");
})().catch((error) => log(`ERROR: ${String(error)}`)));

element("pair").addEventListener("click", () => void (async () => {
  await keysReady;
  if (!identity) throw new Error("enroll first");
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const commitment = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", secret)));
  const response = await signedFetch("/v1/pairings", {
    method: "POST",
    body: JSON.stringify({ peerDeviceId: element<HTMLInputElement>("peerDevice").value.trim(), secretCommitment: commitment }),
  });
  const data = await responseJson(response);
  identity.pairingId = requiredString(data.pairingId, "pairingId");
  pairingQrSecret = base64Url(secret);
  pairingKey = await crypto.subtle.importKey("raw", secret.buffer as ArrayBuffer, "HKDF", false, ["deriveBits"]);
  await storeKey(pairingKeyName, pairingKey);
  saveIdentity();
  log("Pairing created. Transfer the pairing ID and secret to Android by QR before real use.");
})().catch((error) => log(`ERROR: ${String(error)}`)));

element("dial").addEventListener("click", () => void (async () => {
  if (!identity?.pairingId) throw new Error("pair first");
  const response = await signedFetch("/v1/calls/outgoing", {
    method: "POST",
    body: JSON.stringify({ pairingId: identity.pairingId, phoneNumber: element<HTMLInputElement>("phoneNumber").value.trim(), requestId: crypto.randomUUID() }),
  });
  const data = await responseJson(response);
  const callId = requiredString(data.callId, "callId");
  element<HTMLInputElement>("callId").value = callId;
  lastSeenCallId = callId;
  await joinCall(callId);
  log(`Outgoing request created: ${callId}`);
})().catch((error) => log(`ERROR: ${String(error)}`)));

async function sendEvent(callId: string, type: string, payload?: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!callId) throw new Error("call ID is required");
  return responseJson(await signedFetch(`/v1/calls/${callId}/events`, {
    method: "POST",
    body: JSON.stringify({ type, commandId: crypto.randomUUID(), ...(payload ? { payload } : {}) }),
  }));
}

function leaveRoom(): void {
  mediaGeneration += 1;
  disconnectRoom();
}

function disconnectRoom(): void {
  room?.disconnect();
  room = undefined;
  roomCallId = "";
  element("remoteAudio").replaceChildren();
  element<HTMLOutputElement>("media").value = "Disconnected";
}

async function joinCall(callId: string): Promise<void> {
  if (room && roomCallId === callId) return;
  if (joining) return joining;
  joining = (async () => {
    await keysReady;
    if (!pairingKey) throw new Error("pairing key is unavailable; create the pairing again");
    const generation = ++mediaGeneration;
    disconnectRoom();
    const credentials = await responseJson(await signedFetch(`/v1/calls/${callId}/token`, { method: "POST", body: "{}" }));
    const keyProvider = new ExternalE2EEKeyProvider();
    const nextRoom = new Room({
      adaptiveStream: false,
      dynacast: false,
      encryption: {
        keyProvider,
        worker: new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), { type: "module" }),
      },
    });
    nextRoom.on(RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === Track.Kind.Audio) element("remoteAudio").appendChild(track.attach());
    });
    nextRoom.on(RoomEvent.Disconnected, () => {
      if (room === nextRoom) element<HTMLOutputElement>("media").value = "Disconnected";
    });
    try {
      await keyProvider.setKey(await deriveCallPassphrase(pairingKey, callId));
      await nextRoom.setE2EEEnabled(true);
      await nextRoom.connect(requiredString(credentials.serverUrl, "serverUrl"), requiredString(credentials.participantToken, "participantToken"));
      if (generation !== mediaGeneration) throw new Error("media join was cancelled");
      await nextRoom.localParticipant.setMicrophoneEnabled(true);
      if (generation !== mediaGeneration) throw new Error("media join was cancelled");
      room = nextRoom;
      roomCallId = callId;
      element<HTMLOutputElement>("media").value = "Connected — microphone live";
      log("LiveKit audio joined with end-to-end encryption");
    } catch (error) {
      nextRoom.disconnect();
      throw error;
    }
  })();
  try {
    await joining;
  } finally {
    joining = undefined;
  }
}

async function applyPeerMode(mode: string): Promise<void> {
  if (!room) return;
  await room.localParticipant.setMicrophoneEnabled(mode !== "listen");
}

document.querySelectorAll<HTMLButtonElement>("[data-event]").forEach((button) => {
  button.addEventListener("click", () => void (async () => {
    const callId = element<HTMLInputElement>("callId").value.trim();
    const event = button.dataset.event;
    if (!event) throw new Error("button event is missing");
    if (event === "accept") await joinCall(callId);
    await sendEvent(callId, event);
    if (event === "end" || event === "reject") leaveRoom();
    if (["full_duplex", "listen", "talk"].includes(event)) await applyPeerMode(event);
    log(`Sent ${event}`);
  })().catch((error) => log(`ERROR: ${String(error)}`)));
});

for (const [id, muted] of [["mute", true], ["unmute", false]] as const) {
  element(id).addEventListener("click", () => void (async () => {
    const callId = element<HTMLInputElement>("callId").value.trim();
    await sendEvent(callId, "mute", { muted });
    log(muted ? "Android relay microphone muted" : "Android relay microphone unmuted");
  })().catch((error) => log(`ERROR: ${String(error)}`)));
}

element("sendDtmf").addEventListener("click", () => void (async () => {
  const callId = element<HTMLInputElement>("callId").value.trim();
  const digit = element<HTMLInputElement>("dtmf").value.trim();
  await sendEvent(callId, "dtmf", { digit });
  log(`Sent DTMF ${digit}`);
})().catch((error) => log(`ERROR: ${String(error)}`)));

element("join").addEventListener("click", () => void joinCall(element<HTMLInputElement>("callId").value.trim())
  .catch((error) => log(`ERROR: ${String(error)}`)));
element("leave").addEventListener("click", leaveRoom);

setInterval(() => void (async () => {
  if (!identity || polling) return;
  polling = true;
  try {
    const path = lastSeenCallId ? `/v1/calls/${lastSeenCallId}` : "/v1/calls/current";
    let data = await responseJson(await signedFetch(path));
    let call = callView(data.call);
    if (!call && lastSeenCallId) {
      data = await responseJson(await signedFetch("/v1/calls/current"));
      call = callView(data.call);
    }
    if (call) {
      element<HTMLInputElement>("callId").value = call.id;
      if (call.id !== lastSeenCallId) log(`${call.direction === "incoming" ? "Incoming" : "Outgoing"} call session: ${call.id}`);
      lastSeenCallId = call.id;
      if (call.state === "ended" || call.state === "failed") {
        log(`Call ${call.state}`);
        leaveRoom();
        lastSeenCallId = "";
      }
      await applyPeerMode(call.relay_mode);
    }
    lastPollingError = "";
  } catch (error) {
    const message = String(error);
    if (message !== lastPollingError) log(`Polling error: ${message}`);
    lastPollingError = message;
  } finally {
    polling = false;
  }
})(), 2_000);

render();
