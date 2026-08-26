import QRCode from "qrcode";
import { deriveSignalKey, signalMac, verifySignalMac } from "./key-derivation";
import "./style.css";

interface StoredIdentity {
  deviceId: string;
  publicKeySpki: string;
  pairingId?: string;
  privateKeyJwk?: JsonWebKey;
  pairingSecret?: string;
}

interface CallView {
  id: string;
  pairing_id: string;
  android_device_id: string;
  peer_device_id: string;
  direction: "incoming" | "outgoing";
  state: string;
  relay_mode: "full_duplex" | "listen" | "talk";
  version: number;
  created_at: number;
}

interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

interface MediaConfig {
  transport: "webrtc_p2p";
  offerer: "android";
  iceTransportPolicy: "all";
  iceServers: IceServerConfig[];
  credentialsExpiresAt: number;
  protocolVersion: 1;
}

interface SignalEnvelope {
  version: 1;
  callId: string;
  senderDeviceId: string;
  role: "android" | "peer";
  sessionId: string;
  sequence: number;
  timestamp: number;
  type: string;
  payload: string;
  mac: string;
}

type JsonObject = Record<string, unknown>;

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
const encodePayload = (value: JsonObject): string => base64Url(new TextEncoder().encode(JSON.stringify(value)));
const decodePayload = (value: string): JsonObject => {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(value)));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("signal payload is invalid");
  return parsed as JsonObject;
};

const identityKey = "call-relay-browser-identity-v1";
const keyDatabaseName = "call-relay-browser-keys-v1";
const signingKeyName = "device-signing";
const pairingKeyName = "pairing-hkdf";
const signalProtocol = "call-relay.signal.v1";

let identity: StoredIdentity | undefined = loadIdentity();
let signingKey: CryptoKey | undefined;
let pairingKey: CryptoKey | undefined;
let pairingQrSecret = "";
let currentCall: CallView | undefined;

let signalSocket: WebSocket | undefined;
let signalConnection: Promise<void> | undefined;
let signalMessageChain: Promise<void> = Promise.resolve();
let signalSessionId = "";
let signalSequence = 0;
let reconnectTimer: number | undefined;
let reconnectAttempts = 0;
let deliberatelyDisconnected = false;
const signalKeyCache = new Map<string, CryptoKey>();
const remoteSequences = new Map<string, number>();

let peerConnection: RTCPeerConnection | undefined;
let localStream: MediaStream | undefined;
let mediaCallId = "";
let mediaConfig: MediaConfig | undefined;
let mediaGeneration = 0;
let currentIcePolicy: RTCIceTransportPolicy = "all";
let candidateBatch: RTCIceCandidateInit[] = [];
let candidateTimer: number | undefined;
let credentialRefreshTimer: number | undefined;
let statsTimer: number | undefined;
let forceRelayTimer: number | undefined;
let setupFailureTimer: number | undefined;
let disconnectRecoveryTimer: number | undefined;
let pendingRemoteCandidates: RTCIceCandidateInit[] = [];
let remoteIceComplete = false;
let lastRoute = "";
let relayRestartRequested = false;
let setupStartedAt = 0;
let setupDurationMs = 0;
let iceRestartCount = 0;
let lastStatsSummary: JsonObject = {};

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
    signingKey = await crypto.subtle.importKey("jwk", identity.privateKeyJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    await storeKey(signingKeyName, signingKey);
  }
  if (identity?.pairingSecret && !pairingKey) {
    const secret = fromBase64Url(identity.pairingSecret);
    if (secret.byteLength === 32) {
      pairingQrSecret = identity.pairingSecret;
      pairingKey = await crypto.subtle.importKey("raw", secret.buffer as ArrayBuffer, "HKDF", false, ["deriveKey"]);
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
    ? `Pairing: ${identity.pairingId}${pairingQrSecret ? " — scan the QR now" : " — key secured"}`
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

function apiUrl(path: string): string {
  const configured = element<HTMLInputElement>("apiBase").value.trim().replace(/\/$/u, "");
  if (!configured) return path;
  const url = new URL(configured);
  if (url.origin !== location.origin || (url.pathname !== "" && url.pathname !== "/")) throw new Error("API base must be this console's own origin");
  return `${url.origin}${path}`;
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
  headers.set("x-relay-app-version", "web-webrtc-1");
  if (bodyText) headers.set("content-type", "application/json");
  return fetch(apiUrl(path), { ...init, method, headers });
}

async function responseJson(response: Response): Promise<JsonObject> {
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("server returned invalid JSON");
  const data = value as JsonObject;
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : `request failed (${response.status})`);
  return data;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`server response is missing ${name}`);
  return value;
}

function callView(value: unknown): CallView | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as JsonObject;
  if (
    typeof record.id !== "string" || typeof record.pairing_id !== "string" ||
    typeof record.android_device_id !== "string" || typeof record.peer_device_id !== "string" ||
    (record.direction !== "incoming" && record.direction !== "outgoing") || typeof record.state !== "string" ||
    typeof record.version !== "number" || typeof record.created_at !== "number" ||
    (record.relay_mode !== "full_duplex" && record.relay_mode !== "listen" && record.relay_mode !== "talk")
  ) return undefined;
  return record as unknown as CallView;
}

async function signalKey(callId: string): Promise<CryptoKey> {
  await keysReady;
  if (!pairingKey) throw new Error("pairing key is unavailable; recreate the pairing");
  let key = signalKeyCache.get(callId);
  if (!key) {
    key = await deriveSignalKey(pairingKey, callId);
    signalKeyCache.set(callId, key);
  }
  return key;
}

function signalCanonical(envelope: Omit<SignalEnvelope, "mac">): string {
  return [
    envelope.version,
    envelope.callId,
    envelope.senderDeviceId,
    envelope.role,
    envelope.sessionId,
    envelope.sequence,
    envelope.timestamp,
    envelope.type,
    envelope.payload,
  ].join("\n");
}

async function sendSignal(type: string, payload: JsonObject, callId = mediaCallId): Promise<void> {
  await ensureSignalConnected();
  if (!identity || !signalSocket || signalSocket.readyState !== WebSocket.OPEN || !signalSessionId) throw new Error("signaling is not ready");
  const unsigned: Omit<SignalEnvelope, "mac"> = {
    version: 1,
    callId,
    senderDeviceId: identity.deviceId,
    role: "peer",
    sessionId: signalSessionId,
    sequence: ++signalSequence,
    timestamp: Date.now(),
    type,
    payload: encodePayload(payload),
  };
  signalSocket.send(JSON.stringify({ ...unsigned, mac: await signalMac(await signalKey(callId), signalCanonical(unsigned)) } satisfies SignalEnvelope));
}

async function verifyEnvelope(envelope: SignalEnvelope): Promise<boolean> {
  if (!currentCall || envelope.callId !== currentCall.id || envelope.senderDeviceId !== currentCall.android_device_id || envelope.role !== "android") return false;
  const remoteSequence = remoteSequences.get(envelope.sessionId) ?? 0;
  if (envelope.sequence <= remoteSequence || Math.abs(Date.now() - envelope.timestamp) > 5 * 60 * 1000) return false;
  const { mac: _mac, ...unsigned } = envelope;
  const valid = await verifySignalMac(await signalKey(envelope.callId), signalCanonical(unsigned), fromBase64Url(envelope.mac));
  if (valid) remoteSequences.set(envelope.sessionId, envelope.sequence);
  return valid;
}

function websocketUrl(pairingId: string): string {
  const url = new URL(apiUrl(`/v1/pairings/${pairingId}/signal`), location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

async function connectSignal(): Promise<void> {
  await keysReady;
  if (!identity?.pairingId || !pairingKey) return;
  if (signalSocket?.readyState === WebSocket.OPEN) return;
  if (signalConnection) return signalConnection;
  deliberatelyDisconnected = false;
  signalConnection = (async () => {
    const ticketResponse = await responseJson(await signedFetch(`/v1/pairings/${identity!.pairingId}/signal-ticket`, { method: "POST", body: "{}" }));
    const ticket = requiredString(ticketResponse.ticket, "ticket");
    const protocol = requiredString(ticketResponse.protocol, "protocol");
    if (protocol !== signalProtocol) throw new Error("server returned an unsupported signaling protocol");
    const socket = new WebSocket(websocketUrl(identity!.pairingId!), [signalProtocol, `cr-ticket.${ticket}`]);
    signalSocket = socket;
    socket.onmessage = (event) => {
      signalMessageChain = signalMessageChain
        .then(() => handleSignalMessage(String(event.data)))
        .catch((error) => { log(`Signaling error: ${String(error)}`); });
    };
    socket.onclose = () => {
      if (signalSocket === socket) {
        signalSocket = undefined;
        signalSessionId = "";
        element<HTMLOutputElement>("signal").value = "Disconnected";
        if (!deliberatelyDisconnected) scheduleSignalReconnect();
      }
    };
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("signaling connection timed out")), 10_000);
      socket.onopen = () => {
        window.clearTimeout(timeout);
        reconnectAttempts = 0;
        element<HTMLOutputElement>("signal").value = "Connected — authenticating session";
        resolve();
      };
      socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("signaling WebSocket failed"));
      };
    });
    void recoverCurrentCall();
  })();
  try {
    await signalConnection;
  } finally {
    signalConnection = undefined;
  }
}

async function ensureSignalConnected(): Promise<void> {
  await connectSignal();
  if (signalSessionId) return;
  await new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const check = (): void => {
      if (signalSessionId) resolve();
      else if (Date.now() >= deadline) reject(new Error("signaling session hello timed out"));
      else window.setTimeout(check, 25);
    };
    check();
  });
}

function scheduleSignalReconnect(): void {
  if (reconnectTimer !== undefined || !identity?.pairingId) return;
  const delay = Math.min(10_000, 500 * 2 ** Math.min(reconnectAttempts++, 5));
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = undefined;
    void connectSignal().catch((error) => {
      log(`Signaling reconnect failed: ${String(error)}`);
      scheduleSignalReconnect();
    });
  }, delay);
}

async function handleSignalMessage(message: string): Promise<void> {
  const value: unknown = JSON.parse(message);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid signaling message");
  const record = value as JsonObject;
  if (record.type === "hello") {
    signalSessionId = requiredString(record.sessionId, "sessionId");
    signalSequence = 0;
    element<HTMLOutputElement>("signal").value = "Connected and authenticated";
    return;
  }
  if (record.type === "presence") {
    element<HTMLOutputElement>("presence").value = record.android === true ? "Android online" : "Android offline";
    return;
  }
  if (record.type === "call_snapshot") {
    const call = callView(record.call);
    if (call) await applyCallSnapshot(call);
    return;
  }
  if (record.type === "protocol_error") throw new Error(requiredString(record.message, "message"));
  const envelope = record as unknown as SignalEnvelope;
  if (!await verifyEnvelope(envelope)) throw new Error("rejected unauthenticated or replayed signal");
  await handlePeerSignal(envelope.type, decodePayload(envelope.payload));
}

async function recoverCurrentCall(): Promise<void> {
  try {
    const data = await responseJson(await signedFetch("/v1/calls/current"));
    const call = callView(data.call);
    if (call) await applyCallSnapshot(call);
  } catch (error) {
    log(`Call recovery failed: ${String(error)}`);
  }
}

async function applyCallSnapshot(call: CallView): Promise<void> {
  if (currentCall?.id === call.id && currentCall.version >= call.version) return;
  if (currentCall?.id !== call.id && currentCall && currentCall.created_at > call.created_at) return;
  const changedCall = currentCall?.id !== call.id;
  currentCall = call;
  element<HTMLInputElement>("callId").value = call.id;
  if (changedCall) log(`${call.direction === "incoming" ? "Incoming" : "Outgoing"} call session: ${call.id}`);
  if (call.state === "ended" || call.state === "failed") {
    log(`Call ${call.state}`);
    closeMedia();
    currentCall = undefined;
    return;
  }
  applyPeerMode(call.relay_mode);
  if (call.direction === "outgoing" || call.state === "accepted" || call.state === "active") {
    await ensurePeerConnection(call.id);
  }
}

function parseMediaConfig(data: JsonObject): MediaConfig {
  if (
    data.transport !== "webrtc_p2p" || data.offerer !== "android" || data.iceTransportPolicy !== "all" ||
    data.protocolVersion !== 1 || !Array.isArray(data.iceServers) || typeof data.credentialsExpiresAt !== "number"
  ) throw new Error("server returned invalid WebRTC media configuration");
  return data as unknown as MediaConfig;
}

async function requestMediaConfig(callId: string): Promise<MediaConfig> {
  return parseMediaConfig(await responseJson(await signedFetch(`/v1/calls/${callId}/media-config`, { method: "POST", body: "{}" })));
}

async function ensurePeerConnection(callId: string): Promise<RTCPeerConnection> {
  if (peerConnection && mediaCallId === callId) return peerConnection;
  closeMedia(false);
  const generation = ++mediaGeneration;
  mediaCallId = callId;
  setupStartedAt = Date.now();
  setupDurationMs = 0;
  iceRestartCount = 0;
  element<HTMLOutputElement>("media").value = "Requesting Cloudflare STUN/TURN credentials";
  const config = await requestMediaConfig(callId);
  if (generation !== mediaGeneration) throw new Error("media setup was cancelled");
  mediaConfig = config;
  currentIcePolicy = "all";
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    video: false,
  });
  if (generation !== mediaGeneration) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("media setup was cancelled");
  }
  localStream = stream;
  const connection = new RTCPeerConnection({
    iceServers: config.iceServers,
    iceTransportPolicy: "all",
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
  });
  peerConnection = connection;
  for (const track of stream.getAudioTracks()) connection.addTrack(track, stream);
  applyPeerMode(currentCall?.relay_mode ?? "full_duplex");

  connection.ontrack = (event) => {
    if (event.track.kind !== "audio") return;
    const audio = element<HTMLAudioElement>("remoteAudio");
    audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
    void audio.play().catch(() => log("Tap the page once if Safari blocks remote audio autoplay"));
  };
  connection.onicecandidate = (event) => {
    if (event.candidate) {
      candidateBatch.push(event.candidate.toJSON());
      candidateTimer ??= window.setTimeout(() => void flushCandidates(), 50);
    } else {
      void flushCandidates().then(() => sendSignal("ice_complete", {}, callId)).catch((error) => log(`ICE send failed: ${String(error)}`));
    }
  };
  connection.onconnectionstatechange = () => void handleConnectionState(connection);
  connection.oniceconnectionstatechange = () => {
    if (connection.iceConnectionState === "failed") void requestRelayRestart("ice_failed");
  };
  element<HTMLOutputElement>("media").value = "Ready — waiting for Android offer";
  scheduleCredentialRefresh();
  void sendEvent(callId, "media_connecting").catch(() => undefined);
  return connection;
}

async function flushCandidates(): Promise<void> {
  if (candidateTimer !== undefined) window.clearTimeout(candidateTimer);
  candidateTimer = undefined;
  const candidates = candidateBatch;
  candidateBatch = [];
  if (candidates.length) await sendSignal("ice_candidates", { candidates });
}

async function handlePeerSignal(type: string, payload: JsonObject): Promise<void> {
  if (!currentCall) throw new Error("no active call for signaling");
  if (type === "offer") {
    relayRestartRequested = false;
    const sdp = requiredString(payload.sdp, "sdp");
    const connection = await ensurePeerConnection(currentCall.id);
    if (payload.icePolicy === "relay") {
      currentIcePolicy = "relay";
      connection.setConfiguration({ ...connection.getConfiguration(), iceTransportPolicy: "relay" });
    }
    await connection.setRemoteDescription({ type: "offer", sdp });
    for (const candidate of pendingRemoteCandidates.splice(0)) await connection.addIceCandidate(candidate);
    if (remoteIceComplete) await connection.addIceCandidate(null);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await sendSignal("answer", { sdp: answer.sdp ?? "", icePolicy: currentIcePolicy });
    startSetupDeadlines();
    return;
  }
  if (type === "ice_candidates") {
    if (!Array.isArray(payload.candidates) || payload.candidates.length > 128) throw new Error("invalid ICE candidate batch");
    const candidates = payload.candidates as RTCIceCandidateInit[];
    if (peerConnection?.remoteDescription) {
      for (const candidate of candidates) await peerConnection.addIceCandidate(candidate);
    } else {
      pendingRemoteCandidates.push(...candidates);
    }
    return;
  }
  if (type === "ice_complete") {
    remoteIceComplete = true;
    if (peerConnection?.remoteDescription) await peerConnection.addIceCandidate(null);
    return;
  }
  if (type === "media_failed") {
    element<HTMLOutputElement>("media").value = `Android media failed: ${String(payload.reason ?? "unknown")}`;
    return;
  }
}

function startSetupDeadlines(): void {
  if (forceRelayTimer !== undefined) window.clearTimeout(forceRelayTimer);
  if (setupFailureTimer !== undefined) window.clearTimeout(setupFailureTimer);
  forceRelayTimer = window.setTimeout(() => void requestRelayRestart("direct_timeout"), 8_000);
  setupFailureTimer = window.setTimeout(() => void failMedia("ice_timeout"), 20_000);
}

async function requestRelayRestart(reason: string): Promise<void> {
  if (!peerConnection || peerConnection.connectionState === "connected" || relayRestartRequested) return;
  relayRestartRequested = true;
  iceRestartCount += 1;
  if (currentIcePolicy !== "relay") {
    currentIcePolicy = "relay";
    peerConnection.setConfiguration({ ...peerConnection.getConfiguration(), iceTransportPolicy: "relay" });
  }
  element<HTMLOutputElement>("media").value = "Direct path unavailable — forcing Cloudflare TURN";
  await Promise.allSettled([
    sendSignal("ice_restart_request", { reason, icePolicy: "relay" }),
    mediaCallId ? sendEvent(mediaCallId, "media_restarting", { reason, icePolicy: "relay" }) : Promise.resolve({}),
  ]);
}

async function failMedia(code: string): Promise<void> {
  if (!mediaCallId || peerConnection?.connectionState === "connected") return;
  const callId = mediaCallId;
  closeMedia();
  element<HTMLOutputElement>("media").value = `Failed: ${code}`;
  await sendEvent(callId, "failed", undefined, code).catch((error) => log(`Failed to report media error: ${String(error)}`));
}

async function handleConnectionState(connection: RTCPeerConnection): Promise<void> {
  if (connection !== peerConnection) return;
  if (connection.connectionState === "connected") {
    relayRestartRequested = false;
    if (!setupDurationMs) setupDurationMs = Math.max(0, Date.now() - setupStartedAt);
    if (forceRelayTimer !== undefined) window.clearTimeout(forceRelayTimer);
    if (setupFailureTimer !== undefined) window.clearTimeout(setupFailureTimer);
    if (disconnectRecoveryTimer !== undefined) window.clearTimeout(disconnectRecoveryTimer);
    forceRelayTimer = setupFailureTimer = disconnectRecoveryTimer = undefined;
    const route = await selectedRoute(connection);
    element<HTMLOutputElement>("media").value = `Connected — ${route.label}`;
    await Promise.allSettled([
      sendSignal("media_ready", { route: route.candidateType, protocol: route.protocol }),
      mediaCallId ? sendEvent(mediaCallId, "media_connected", { candidateType: route.candidateType, icePolicy: currentIcePolicy }) : Promise.resolve({}),
    ]);
    startStats();
    return;
  }
  if (connection.connectionState === "disconnected") {
    element<HTMLOutputElement>("media").value = "Media interrupted — waiting briefly for recovery";
    disconnectRecoveryTimer ??= window.setTimeout(() => void requestRelayRestart("network_change"), 3_000);
    return;
  }
  if (connection.connectionState === "failed") await requestRelayRestart("connection_failed");
}

async function selectedRoute(connection: RTCPeerConnection): Promise<{ candidateType: "host" | "srflx" | "relay"; protocol: string; label: string }> {
  const stats = await connection.getStats();
  let pair: RTCStats | undefined;
  stats.forEach((report) => {
    if (report.type === "candidate-pair" && report.state === "succeeded" && (report.nominated === true || report.selected === true)) pair = report;
  });
  const pairRecord = pair as (RTCStats & { localCandidateId?: string }) | undefined;
  const local = pairRecord?.localCandidateId ? stats.get(pairRecord.localCandidateId) : undefined;
  const candidateType = local?.candidateType === "relay" ? "relay" : local?.candidateType === "srflx" ? "srflx" : "host";
  const protocol = typeof local?.relayProtocol === "string" ? local.relayProtocol : typeof local?.protocol === "string" ? local.protocol : "unknown";
  return { candidateType, protocol, label: candidateType === "relay" ? `Cloudflare TURN/${protocol}` : `direct ${candidateType}/${protocol}` };
}

function startStats(): void {
  if (statsTimer !== undefined) window.clearInterval(statsTimer);
  statsTimer = window.setInterval(() => void updateStats(), 5_000);
  void updateStats();
}

async function updateStats(): Promise<void> {
  if (!peerConnection || peerConnection.connectionState !== "connected") return;
  const stats = await peerConnection.getStats();
  const route = await selectedRoute(peerConnection);
  let rttMs = 0;
  let jitterMs = 0;
  let packetsLost = 0;
  let concealedSamples = 0;
  let bytesSent = 0;
  let bytesReceived = 0;
  stats.forEach((report) => {
    if (report.type === "candidate-pair" && report.state === "succeeded" && typeof report.currentRoundTripTime === "number") rttMs = report.currentRoundTripTime * 1000;
    if (report.type === "inbound-rtp" && report.kind === "audio") {
      if (typeof report.jitter === "number") jitterMs = report.jitter * 1000;
      if (typeof report.packetsLost === "number") packetsLost = report.packetsLost;
      if (typeof report.concealedSamples === "number") concealedSamples = report.concealedSamples;
      if (typeof report.bytesReceived === "number") bytesReceived = report.bytesReceived;
    }
    if (report.type === "outbound-rtp" && report.kind === "audio" && typeof report.bytesSent === "number") bytesSent = report.bytesSent;
  });
  lastStatsSummary = {
    setupDurationMs,
    candidateType: route.candidateType,
    protocol: ["udp", "tcp", "tls"].includes(route.protocol) ? route.protocol : "unknown",
    rttMs,
    jitterMs,
    packetsLost,
    concealedSamples,
    bytesSent,
    bytesReceived,
    iceRestartCount,
  };
  element<HTMLOutputElement>("stats").value = `${route.label} · RTT ${rttMs.toFixed(0)} ms · jitter ${jitterMs.toFixed(0)} ms · lost ${packetsLost} · received ${(bytesReceived / 1024).toFixed(0)} KiB`;
  const routeKey = `${route.candidateType}:${route.protocol}`;
  if (lastRoute && routeKey !== lastRoute && mediaCallId) {
    void sendEvent(mediaCallId, "media_path_changed", { candidateType: route.candidateType, icePolicy: currentIcePolicy }).catch(() => undefined);
  }
  lastRoute = routeKey;
}

function scheduleCredentialRefresh(): void {
  if (credentialRefreshTimer !== undefined) window.clearTimeout(credentialRefreshTimer);
  if (!mediaConfig) return;
  const delay = Math.max(60_000, Math.floor((mediaConfig.credentialsExpiresAt - Date.now()) * 0.75));
  credentialRefreshTimer = window.setTimeout(() => void refreshMediaConfig(), delay);
}

async function refreshMediaConfig(): Promise<void> {
  if (!peerConnection || !mediaCallId) return;
  try {
    mediaConfig = await requestMediaConfig(mediaCallId);
    peerConnection.setConfiguration({
      ...peerConnection.getConfiguration(),
      iceServers: mediaConfig.iceServers,
      iceTransportPolicy: currentIcePolicy,
    });
    scheduleCredentialRefresh();
    log("TURN credentials refreshed");
  } catch (error) {
    log(`TURN credential refresh failed: ${String(error)}`);
    credentialRefreshTimer = window.setTimeout(() => void refreshMediaConfig(), 30_000);
  }
}

function applyPeerMode(mode: CallView["relay_mode"]): void {
  localStream?.getAudioTracks().forEach((track) => { track.enabled = mode !== "listen"; });
  element<HTMLAudioElement>("remoteAudio").muted = mode === "talk";
}

function closeMedia(clearCallId = true): void {
  mediaGeneration += 1;
  for (const timer of [candidateTimer, credentialRefreshTimer, statsTimer, forceRelayTimer, setupFailureTimer, disconnectRecoveryTimer]) {
    if (timer !== undefined) window.clearTimeout(timer);
  }
  candidateTimer = credentialRefreshTimer = statsTimer = forceRelayTimer = setupFailureTimer = disconnectRecoveryTimer = undefined;
  peerConnection?.close();
  peerConnection = undefined;
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = undefined;
  element<HTMLAudioElement>("remoteAudio").srcObject = null;
  candidateBatch = [];
  pendingRemoteCandidates = [];
  remoteIceComplete = false;
  mediaConfig = undefined;
  currentIcePolicy = "all";
  lastRoute = "";
  relayRestartRequested = false;
  setupStartedAt = setupDurationMs = iceRestartCount = 0;
  lastStatsSummary = {};
  if (clearCallId) mediaCallId = "";
  element<HTMLOutputElement>("media").value = "Disconnected";
  element<HTMLOutputElement>("stats").value = "No active media";
}

async function sendEvent(callId: string, type: string, payload?: JsonObject, code?: string): Promise<JsonObject> {
  if (!callId) throw new Error("call ID is required");
  return responseJson(await signedFetch(`/v1/calls/${callId}/events`, {
    method: "POST",
    body: JSON.stringify({ type, commandId: crypto.randomUUID(), ...(payload ? { payload } : {}), ...(code ? { code } : {}) }),
  }));
}

element("enroll").addEventListener("click", () => void (async () => {
  await keysReady;
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey));
  const response = await fetch(apiUrl("/v1/devices/enroll"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-enrollment-invite": element<HTMLInputElement>("invite").value,
      "x-relay-app-version": "web-webrtc-1",
    },
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
  pairingKey = await crypto.subtle.importKey("raw", secret.buffer as ArrayBuffer, "HKDF", false, ["deriveKey"]);
  await storeKey(pairingKeyName, pairingKey);
  saveIdentity();
  log("Pairing created. Transfer the QR to Android, then signaling will connect after confirmation.");
  await connectSignal();
})().catch((error) => log(`ERROR: ${String(error)}`)));

element("dial").addEventListener("click", () => void (async () => {
  if (!identity?.pairingId) throw new Error("pair first");
  await ensureSignalConnected();
  const response = await signedFetch("/v1/calls/outgoing", {
    method: "POST",
    body: JSON.stringify({ pairingId: identity.pairingId, phoneNumber: element<HTMLInputElement>("phoneNumber").value.trim(), requestId: crypto.randomUUID() }),
  });
  const data = await responseJson(response);
  const callId = requiredString(data.callId, "callId");
  element<HTMLInputElement>("callId").value = callId;
  const callData = await responseJson(await signedFetch(`/v1/calls/${callId}`));
  const call = callView(callData.call);
  if (!call) throw new Error("server returned an invalid call");
  await applyCallSnapshot(call);
  log(`Outgoing request created: ${callId}`);
})().catch((error) => log(`ERROR: ${String(error)}`)));

document.querySelectorAll<HTMLButtonElement>("[data-event]").forEach((button) => {
  button.addEventListener("click", () => void (async () => {
    const callId = element<HTMLInputElement>("callId").value.trim();
    const event = button.dataset.event;
    if (!event) throw new Error("button event is missing");
    if (event === "accept") {
      await ensureSignalConnected();
      await ensurePeerConnection(callId);
    }
    if (event === "end" && mediaCallId === callId && Object.keys(lastStatsSummary).length) {
      await sendEvent(callId, "media_summary", lastStatsSummary);
    }
    await sendEvent(callId, event);
    if (event === "end" || event === "reject") closeMedia();
    if (event === "full_duplex" || event === "listen" || event === "talk") applyPeerMode(event);
    log(`Sent ${event}`);
  })().catch((error) => log(`ERROR: ${String(error)}`)));
});

for (const [id, muted] of [["mute", true], ["unmute", false]] as const) {
  element(id).addEventListener("click", () => void (async () => {
    await sendEvent(element<HTMLInputElement>("callId").value.trim(), "mute", { muted });
    log(muted ? "Android relay microphone muted" : "Android relay microphone unmuted");
  })().catch((error) => log(`ERROR: ${String(error)}`)));
}

element("sendDtmf").addEventListener("click", () => void (async () => {
  const digit = element<HTMLInputElement>("dtmf").value.trim();
  await sendEvent(element<HTMLInputElement>("callId").value.trim(), "dtmf", { digit });
  log(`Sent DTMF ${digit}`);
})().catch((error) => log(`ERROR: ${String(error)}`)));

element("join").addEventListener("click", () => void (async () => {
  await ensureSignalConnected();
  await ensurePeerConnection(element<HTMLInputElement>("callId").value.trim());
})().catch((error) => log(`ERROR: ${String(error)}`)));
element("leave").addEventListener("click", () => closeMedia());

window.addEventListener("online", () => {
  void connectSignal();
  if (peerConnection && peerConnection.connectionState !== "connected") void requestRelayRestart("network_online");
});
window.addEventListener("beforeunload", () => {
  deliberatelyDisconnected = true;
  signalSocket?.close(1000, "page closing");
  closeMedia();
});

render();
void keysReady.then(() => connectSignal()).catch((error) => log(`Signaling unavailable: ${String(error)}`));
