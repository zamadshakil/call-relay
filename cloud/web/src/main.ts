import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import { initializePaddle } from "@paddle/paddle-js";
import { initializeApp } from "firebase/app";
import {
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signInWithRedirect,
  signOut as firebaseSignOut,
  type Auth,
  type User,
} from "firebase/auth";
import { assertFirebaseWebConfigured, firebaseConfig } from "./firebase-config";
import { paddleClientToken, paddleEnvironment } from "./billing-config";
import { deriveSignalKey, signalMac, verifySignalMac } from "./key-derivation";
import {
  base64Url,
  createPeerProof,
  derivePairingSecret,
  fromBase64Url,
  importPairingProofKey,
  pairingCommitment,
  verifyAndroidProofWithKey,
} from "./pairing-crypto";
import "./style.css";

interface StoredIdentity {
  deviceId: string;
  publicKeySpki: string;
  pairingId?: string;
}

interface AccountSnapshot {
  account: { uid: string; email: string; displayName: string | null; photoUrl: string | null; approvalStatus: "approved" | "unknown" | "suspended" };
  subscription: {
    status: string;
    plan: "monthly" | "annual" | null;
    currentPeriodEndsAt: number | null;
    cancelAtPeriodEnd: boolean;
    active: boolean;
    billingRequired: boolean;
    accessMode: "paid" | "approval_only";
  };
  devices: Array<{ id: string; platform: "android" | "browser" | "ios"; displayName: string; online: boolean; sim: { carrierName: string; maskedNumber: string | null } | null }>;
  pairing: Record<string, unknown> | null;
}

interface PendingPairingMaterial {
  invitationId: string;
  pairingId: string;
  androidDeviceId: string;
  peerDeviceId: string;
  commitment: string;
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
  peer_accepted_at?: number | null;
  telecom_answer_requested_at?: number | null;
  sim_active_at?: number | null;
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
const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const encodePayload = (value: JsonObject): string => base64Url(new TextEncoder().encode(JSON.stringify(value)));
const decodePayload = (value: string): JsonObject => {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(fromBase64Url(value)));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("signal payload is invalid");
  return parsed as JsonObject;
};

const identityKey = "call-relay-browser-identity-v2";
const keyDatabaseName = "call-relay-browser-keys-v2";
const signingKeyName = "device-signing";
const agreementKeyName = "device-agreement";
const pairingKeyName = "pairing-hkdf";
const pairingProofKeyName = "pairing-proof";
const pendingPairingStorageKey = "call-relay-pending-pairing-v2";
const signalProtocol = "call-relay.signal.v1";
let firebaseAuth: Auth | undefined;
let firebaseInitializationError: unknown;
try {
  assertFirebaseWebConfigured();
  firebaseAuth = getAuth(initializeApp(firebaseConfig));
} catch (error) {
  firebaseInitializationError = error;
}

function requireFirebaseAuth(): Auth {
  if (!firebaseAuth) {
    throw firebaseInitializationError instanceof Error
      ? firebaseInitializationError
      : new Error("Firebase web sign-in is not configured on this deployment");
  }
  return firebaseAuth;
}

let identity: StoredIdentity | undefined = loadIdentity();
let signingKey: CryptoKey | undefined;
let agreementKey: CryptoKey | undefined;
let pairingKey: CryptoKey | undefined;
let pairingProofKey: CryptoKey | undefined;
let firebaseUser: User | null = null;
let account: AccountSnapshot | undefined;
let startupError: string | undefined;
let scannerControls: IScannerControls | undefined;
let pendingPairing: PendingPairingMaterial | undefined = loadPendingPairing();
let accountScreenOpen = false;
const initialPageParameters = new URLSearchParams(location.search);
const androidBillingReturn = initialPageParameters.get("return") === "android";
let checkoutPageActive = initialPageParameters.has("_ptxn");
let currentCall: CallView | undefined;

let signalSocket: WebSocket | undefined;
let signalConnection: Promise<void> | undefined;
let signalMessageChain: Promise<void> = Promise.resolve();
let signalSessionId = "";
let signalSequence = 0;
let reconnectTimer: number | undefined;
let reconnectAttempts = 0;
let deliberatelyDisconnected = false;
let signalHeartbeatTimer: number | undefined;
let lastSignalPongAt = 0;
let foregroundRecovery: Promise<void> | undefined;
const signalKeyCache = new Map<string, CryptoKey>();
const remoteSequences = new Map<string, number>();

let peerConnection: RTCPeerConnection | undefined;
let localStream: MediaStream | undefined;
let localMicMuted = false;
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
let offerRecoveryTimer: number | undefined;
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

function loadPendingPairing(): PendingPairingMaterial | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(pendingPairingStorageKey) ?? "null");
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (["invitationId", "pairingId", "androidDeviceId", "peerDeviceId", "commitment"].some((key) => typeof record[key] !== "string")) return undefined;
    return value as PendingPairingMaterial;
  } catch {
    return undefined;
  }
}

function savePendingPairing(): void {
  if (pendingPairing) localStorage.setItem(pendingPairingStorageKey, JSON.stringify(pendingPairing));
  else localStorage.removeItem(pendingPairingStorageKey);
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
  agreementKey = await storedKey(agreementKeyName);
  pairingKey = await storedKey(pairingKeyName);
  pairingProofKey = await storedKey(pairingProofKeyName);
  if (identity && (!signingKey || !agreementKey)) {
    identity = undefined;
    pairingKey = undefined;
    localStorage.removeItem(identityKey);
    await Promise.all([deleteKey(signingKeyName), deleteKey(agreementKeyName), deleteKey(pairingKeyName), deleteKey(pairingProofKeyName)]);
  }
  render();
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

const screenIds = ["loadingScreen", "signInScreen", "approvalScreen", "plansScreen", "paymentScreen", "pairScreen", "homeScreen", "accountScreen"] as const;

function showScreen(id: typeof screenIds[number]): void {
  for (const screenId of screenIds) element<HTMLElement>(screenId).hidden = screenId !== id;
}

function render(): void {
  if (checkoutPageActive) {
    showScreen("paymentScreen");
    return;
  }
  if (accountScreenOpen && firebaseUser && account) {
    showScreen("accountScreen");
    renderAccountDetails();
    return;
  }
  if (startupError) {
    showScreen("approvalScreen");
    element("approvalTitle").textContent = "Could not restore this browser session";
    element("approvalMessage").textContent = startupError;
    element<HTMLButtonElement>("sessionRetry").hidden = false;
    element<HTMLAnchorElement>("approvalContact").hidden = true;
    return;
  }
  if (!firebaseUser) return showScreen("signInScreen");
  if (!account) return showScreen("loadingScreen");
  if (account.account.approvalStatus !== "approved") {
    showScreen("approvalScreen");
    const suspended = account.account.approvalStatus === "suspended";
    element("approvalTitle").textContent = suspended ? "This account is suspended" : "This account is not approved";
    element("approvalMessage").textContent = suspended
      ? "Calling and device access are disabled. Contact support if you believe this is a mistake."
      : "Call Relay is currently invite-only. Ask support to approve this Google account.";
    element<HTMLButtonElement>("sessionRetry").hidden = true;
    element<HTMLAnchorElement>("approvalContact").hidden = false;
    return;
  }
  if (!account.subscription.active) {
    if (location.pathname === "/billing/complete" || account.subscription.status === "pending") showScreen("paymentScreen");
    else showScreen("plansScreen");
    return;
  }
  const pairingId = typeof account.pairing?.id === "string" ? account.pairing.id : undefined;
  const pairingConfirmed = typeof account.pairing?.confirmed_at === "number";
  if (!identity || !pairingId || !pairingConfirmed || !pairingKey) {
    showScreen("pairScreen");
    return;
  }
  identity.pairingId = pairingId;
  saveIdentityWithoutRender();
  showScreen("homeScreen");
  const android = account.devices.find((device) => device.platform === "android");
  element("accountEmail").textContent = account.account.email;
  element("planSummary").textContent = account.subscription.billingRequired
    ? `${account.subscription.plan === "annual" ? "Annual" : "Monthly"} plan${account.subscription.currentPeriodEndsAt ? ` · renews ${new Date(account.subscription.currentPeriodEndsAt).toLocaleDateString()}` : ""}`
    : "Approved access · payment not required";
  element("androidName").textContent = android?.displayName ?? "Android relay";
  element<HTMLOutputElement>("presence").value = android?.online ? "Android online" : "Android offline";
}

function saveIdentityWithoutRender(): void {
  if (identity) localStorage.setItem(identityKey, JSON.stringify(identity));
  else localStorage.removeItem(identityKey);
}

function renderAccountDetails(): void {
  if (!account) return;
  const android = account.devices.find((device) => device.platform === "android");
  const values: Array<[string, string]> = [
    ["Google account", account.account.email],
    ["Access", account.subscription.billingRequired
      ? account.subscription.plan === "annual" ? "Annual" : account.subscription.plan === "monthly" ? "Monthly" : account.subscription.status
      : "Approved account"],
    ["Android", android?.displayName ?? "Not registered"],
    ["SIM", android?.sim ? `${android.sim.carrierName}${android.sim.maskedNumber ? ` · ${android.sim.maskedNumber}` : ""}` : "Not configured"],
    ["Peer", account.pairing ? "Paired" : "Not paired"],
  ];
  element("accountDetails").replaceChildren(...values.map(([label, value]) => {
    const row = document.createElement("div");
    const name = document.createElement("span");
    const content = document.createElement("strong");
    name.textContent = label;
    content.textContent = value;
    row.appendChild(name);
    row.appendChild(content);
    return row;
  }));
  element<HTMLButtonElement>("managePlan").hidden = !account.subscription.billingRequired;
}

function apiUrl(path: string): string {
  return path;
}

async function bearerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  if (!firebaseUser) throw new Error("sign in with Google first");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${await firebaseUser.getIdToken()}`);
  if (typeof init.body === "string") headers.set("content-type", "application/json");
  return fetch(apiUrl(path), { ...init, headers });
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

function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function setNotificationStatus(message: string, enabled = false): void {
  element("notificationStatus").textContent = message;
  const button = element<HTMLButtonElement>("enableNotifications");
  button.textContent = enabled ? "Incoming notifications enabled" : "Enable incoming call notifications";
  button.disabled = enabled;
}

function serializedPushSubscription(subscription: PushSubscription): JsonObject {
  const value = subscription.toJSON();
  if (!value.endpoint || !value.keys?.p256dh || !value.keys.auth) throw new Error("browser returned an incomplete push subscription");
  return {
    endpoint: value.endpoint,
    expirationTime: value.expirationTime ?? null,
    keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
  };
}

async function uploadPushSubscription(subscription: PushSubscription): Promise<void> {
  if (!identity) return;
  await responseJson(await signedFetch(`/v1/devices/${identity.deviceId}/web-push-subscription`, {
    method: "PUT",
    body: JSON.stringify(serializedPushSubscription(subscription)),
  }));
  setNotificationStatus("Background incoming-call notifications are enabled on this device.", true);
}

async function syncExistingPushSubscription(): Promise<void> {
  if (!pushSupported() || !identity || !account?.subscription.active) {
    if (!pushSupported()) setNotificationStatus("Install this site to the iPhone Home Screen to enable background notifications.");
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) await uploadPushSubscription(subscription);
  else if (Notification.permission === "denied") setNotificationStatus("Notifications are blocked in iPhone Settings.");
}

async function enableIncomingNotifications(): Promise<void> {
  if (!pushSupported()) throw new Error("Install Call Relay to the iPhone Home Screen, then open it from the icon and try again");
  if (!identity) throw new Error("pair this browser first");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("notification permission was not granted");
  const registration = await navigator.serviceWorker.ready;
  const config = await responseJson(await signedFetch("/v1/push/config"));
  const vapidPublicKey = requiredString(config.vapidPublicKey, "vapidPublicKey");
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: fromBase64Url(vapidPublicKey) as Uint8Array<ArrayBuffer>,
    });
  }
  await uploadPushSubscription(subscription);
}

async function unsubscribeIncomingNotifications(): Promise<void> {
  if (!pushSupported()) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  await subscription?.unsubscribe();
}

function parseAccountSnapshot(value: JsonObject): AccountSnapshot {
  if (typeof value.account !== "object" || value.account === null || Array.isArray(value.account)) throw new Error("server returned an invalid account");
  if (typeof value.subscription !== "object" || value.subscription === null || Array.isArray(value.subscription)) throw new Error("server returned an invalid subscription");
  if (!Array.isArray(value.devices)) throw new Error("server returned invalid devices");
  return value as unknown as AccountSnapshot;
}

async function refreshAccount(checkRevocation = false): Promise<AccountSnapshot> {
  const path = checkRevocation ? "/v1/auth/session" : "/v1/me";
  const init: RequestInit = { method: checkRevocation ? "POST" : "GET" };
  let response = await bearerFetch(path, init);
  if (checkRevocation && response.status === 401 && firebaseUser) {
    await firebaseUser.getIdToken(true);
    response = await bearerFetch(path, init);
  }
  const snapshot = parseAccountSnapshot(await responseJson(response));
  account = snapshot;
  render();
  return snapshot;
}

async function clearLocalDevice(): Promise<void> {
  deliberatelyDisconnected = true;
  signalSocket?.close(1000, "device identity reset");
  closeMedia();
  identity = undefined;
  signingKey = undefined;
  agreementKey = undefined;
  pairingKey = undefined;
  pairingProofKey = undefined;
  pendingPairing = undefined;
  savePendingPairing();
  saveIdentityWithoutRender();
  await Promise.all([deleteKey(signingKeyName), deleteKey(agreementKeyName), deleteKey(pairingKeyName), deleteKey(pairingProofKeyName)]);
}

async function ensureBrowserRegistration(replaceExisting = false): Promise<void> {
  await keysReady;
  if (!firebaseUser || !account?.subscription.active) return;
  const serverOwnsLocalDevice = identity && account.devices.some((device) => device.id === identity?.deviceId && (device.platform === "browser" || device.platform === "ios"));
  if (serverOwnsLocalDevice && signingKey && agreementKey) return;
  if (identity || signingKey || agreementKey) await clearLocalDevice();
  const signing = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const agreement = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const publicKeySpki = base64Url(new Uint8Array(await crypto.subtle.exportKey("spki", signing.publicKey)));
  const agreementPublicKeyRaw = base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", agreement.publicKey)));
  const response = await bearerFetch("/v1/devices/register", {
    method: "POST",
    body: JSON.stringify({
      platform: "browser",
      displayName: "iPhone browser",
      publicKeySpki,
      agreementPublicKeyRaw,
      appVersion: 2,
      replaceExisting,
    }),
  });
  if (response.status === 409 && !replaceExisting) {
    element<HTMLButtonElement>("replacePeer").hidden = false;
    throw new Error("This account already has a peer. Choose Replace previously paired browser to continue.");
  }
  const data = await responseJson(response);
  signingKey = signing.privateKey;
  agreementKey = agreement.privateKey;
  await Promise.all([storeKey(signingKeyName, signingKey), storeKey(agreementKeyName, agreementKey)]);
  identity = { deviceId: requiredString(data.deviceId, "deviceId"), publicKeySpki };
  saveIdentityWithoutRender();
  await refreshAccount();
}

async function bootstrapAuthenticatedUser(user: User): Promise<void> {
  firebaseUser = user;
  startupError = undefined;
  showScreen("loadingScreen");
  const snapshot = await withTimeout(
    refreshAccount(true),
    15_000,
    "The secure-session request timed out. Check the connection and retry, or use another Google account.",
  );
  if (snapshot.account.approvalStatus === "approved" && snapshot.subscription.active) {
    await ensureBrowserRegistration(false).catch((error) => {
      log(String(error));
      render();
    });
  }
  await resumePairingFromUrl();
  render();
  if (identity?.pairingId && pairingKey) await connectSignal();
  await syncExistingPushSubscription().catch((error) => log(`Notification subscription sync failed: ${String(error)}`));
  if (location.pathname === "/billing/complete" && !snapshot.subscription.active) startPaymentPolling();
  if (snapshot.account.approvalStatus === "approved" && !snapshot.subscription.active && snapshot.subscription.status !== "pending") {
    await loadPlans().catch((error) => log(`Pricing unavailable: ${String(error)}`));
  }
  startAccountRefresh();
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timeout: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = window.setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
}

function showStartupError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  startupError = message || "The secure session could not be restored. Retry or use another Google account.";
  log(`Session setup failed: ${message}`);
  render();
}

let plansLoading = false;
let paymentTimer: number | undefined;
let pairingTimer: number | undefined;
let accountRefreshTimer: number | undefined;

function startAccountRefresh(): void {
  if (accountRefreshTimer !== undefined) window.clearInterval(accountRefreshTimer);
  accountRefreshTimer = window.setInterval(() => {
    if (!firebaseUser || document.visibilityState !== "visible") return;
    void refreshAccount().catch((error) => log(`Account refresh failed: ${String(error)}`));
  }, 30_000);
}

async function loadPlans(): Promise<void> {
  if (plansLoading || !firebaseUser) return;
  plansLoading = true;
  const container = element("planCards");
  container.textContent = "Loading localized prices…";
  try {
    const data = await responseJson(await bearerFetch("/v1/billing/plans"));
    if (!Array.isArray(data.plans)) throw new Error("server returned invalid plans");
    const plans = data.plans.filter((plan): plan is { code: "monthly" | "annual"; formattedPrice: string; minorAmount: number } =>
      typeof plan === "object" && plan !== null && !Array.isArray(plan) &&
      ((plan as JsonObject).code === "monthly" || (plan as JsonObject).code === "annual") &&
      typeof (plan as JsonObject).formattedPrice === "string" && typeof (plan as JsonObject).minorAmount === "number");
    const monthly = plans.find((plan) => plan.code === "monthly");
    const annual = plans.find((plan) => plan.code === "annual");
    if (!monthly || !annual) throw new Error("both plans are unavailable");
    const saving = monthly.minorAmount > 0 ? Math.max(0, Math.round((1 - annual.minorAmount / (monthly.minorAmount * 12)) * 100)) : 0;
    container.replaceChildren(...plans.map((plan) => {
      const card = document.createElement("article");
      const title = document.createElement("h3");
      const price = document.createElement("strong");
      const note = document.createElement("p");
      const button = document.createElement("button");
      title.textContent = plan.code === "annual" ? "Annual" : "Monthly";
      if (plan.code === "annual" && saving > 0) {
        const badge = document.createElement("span");
        badge.className = "plan-badge";
        badge.textContent = `Save ${saving}%`;
        title.appendChild(badge);
      }
      price.textContent = plan.formattedPrice;
      note.textContent = plan.code === "annual" ? "Billed once per year" : "Billed every month";
      button.className = "primary";
      button.textContent = `Choose ${plan.code}`;
      button.addEventListener("click", () => void beginCheckout(plan.code, button));
      card.appendChild(title);
      card.appendChild(price);
      card.appendChild(note);
      card.appendChild(button);
      return card;
    }));
  } finally {
    plansLoading = false;
  }
}

async function beginCheckout(plan: "monthly" | "annual", button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const data = await responseJson(await bearerFetch("/v1/billing/checkout", { method: "POST", body: JSON.stringify({ plan }) }));
    const checkoutUrl = requiredString(data.checkoutUrl, "checkoutUrl");
    const target = new URL(checkoutUrl);
    if (target.protocol !== "https:") throw new Error("billing provider returned an unsafe checkout URL");
    location.assign(target.toString());
  } catch (error) {
    button.disabled = false;
    log(`Checkout failed: ${String(error)}`);
  }
}

function startPaymentPolling(): void {
  if (paymentTimer !== undefined) return;
  const check = async (): Promise<void> => {
    try {
      const snapshot = await refreshAccount();
      if (snapshot.subscription.active) {
        if (paymentTimer !== undefined) window.clearInterval(paymentTimer);
        paymentTimer = undefined;
        await ensureBrowserRegistration(false);
        history.replaceState({}, "", "/");
        render();
      }
    } catch (error) {
      log(`Payment confirmation check failed: ${String(error)}`);
    }
  };
  paymentTimer = window.setInterval(() => void check(), 2_000);
  void check();
}

async function initializeHostedCheckout(): Promise<void> {
  if (!checkoutPageActive) return;
  if (!paddleClientToken) {
    checkoutPageActive = false;
    throw new Error("Paddle.js client token is not configured for this deployment");
  }
  await initializePaddle({
    token: paddleClientToken,
    environment: paddleEnvironment,
    eventCallback: (event) => {
      if (event.name !== "checkout.completed") return;
      checkoutPageActive = false;
      history.replaceState({}, "", androidBillingReturn ? "/billing/complete?return=android" : "/billing/complete");
      element<HTMLAnchorElement>("returnToAndroid").hidden = !androidBillingReturn;
      showScreen("paymentScreen");
      if (firebaseUser) startPaymentPolling();
      if (androidBillingReturn) location.href = "callrelay://billing/complete";
    },
  });
}

function qrParameters(text: string): { invitationId: string; challenge: Uint8Array; androidPublicKey: Uint8Array } {
  const url = new URL(text);
  if (url.origin !== location.origin || url.pathname !== "/pair") throw new Error("this QR belongs to another Call Relay deployment");
  const parameters = new URLSearchParams(url.hash.replace(/^#/u, ""));
  if (parameters.get("v") !== "2") throw new Error("unsupported pairing QR version");
  const invitationId = parameters.get("id") ?? "";
  if (!/^inv_[a-f0-9]{32}$/u.test(invitationId)) throw new Error("pairing invitation is invalid");
  const challenge = fromBase64Url(parameters.get("c") ?? "");
  const androidPublicKey = fromBase64Url(parameters.get("k") ?? "");
  if (challenge.byteLength !== 32 || androidPublicKey.byteLength !== 65) throw new Error("pairing QR key material is invalid");
  return { invitationId, challenge, androidPublicKey };
}

async function consumePairingQr(text: string): Promise<void> {
  if (!identity || !firebaseUser || !account?.subscription.active) throw new Error("finish sign-in and account approval first");
  const { invitationId, challenge, androidPublicKey } = qrParameters(text);
  scannerControls?.stop();
  scannerControls = undefined;
  element("scannerStatus").textContent = "Securing the pairing…";
  history.replaceState({}, "", "/pair");
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const peerPublicKeyRaw = base64Url(new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey)));
  const secret = await derivePairingSecret(ephemeral.privateKey, androidPublicKey, challenge);
  const commitment = await pairingCommitment(secret);
  const proof = await createPeerProof(secret, invitationId, identity.deviceId, peerPublicKeyRaw, commitment);
  const challengeHash = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", challenge.buffer as ArrayBuffer)));
  const response = await responseJson(await bearerFetch(`/v1/pairing-invitations/${invitationId}/consume`, {
    method: "POST",
    body: JSON.stringify({ peerDeviceId: identity.deviceId, challengeHash, peerPublicKeyRaw, commitment, proof }),
  }));
  const pairingId = requiredString(response.pairingId, "pairingId");
  const android = account.devices.find((device) => device.platform === "android");
  if (!android) throw new Error("the Android relay is not registered");
  pairingKey = await crypto.subtle.importKey("raw", secret.buffer as ArrayBuffer, "HKDF", false, ["deriveKey"]);
  pairingProofKey = await importPairingProofKey(secret);
  await Promise.all([storeKey(pairingKeyName, pairingKey), storeKey(pairingProofKeyName, pairingProofKey)]);
  pendingPairing = { invitationId, pairingId, androidDeviceId: android.id, peerDeviceId: identity.deviceId, commitment };
  savePendingPairing();
  identity.pairingId = pairingId;
  saveIdentityWithoutRender();
  secret.fill(0);
  challenge.fill(0);
  element("scannerStatus").textContent = "Waiting for Android to confirm…";
  startPairingPolling();
}

function startPairingPolling(): void {
  if (pairingTimer !== undefined) return;
  let attempts = 0;
  const check = async (): Promise<void> => {
    attempts += 1;
    try {
      const data = await responseJson(await bearerFetch("/v1/pairings/current"));
      if (typeof data.pairing !== "object" || data.pairing === null || Array.isArray(data.pairing)) return;
      const pairing = data.pairing as JsonObject;
      if (typeof pairing.confirmed_at !== "number" || typeof pairing.android_proof !== "string") return;
      if (!pendingPairing || !pairingProofKey || pairing.id !== pendingPairing.pairingId) throw new Error("local pairing verification material is unavailable; replace the peer and scan again");
      const verified = await verifyAndroidProofWithKey(
        pairingProofKey,
        pairing.android_proof,
        pendingPairing.invitationId,
        pendingPairing.pairingId,
        pendingPairing.androidDeviceId,
        pendingPairing.peerDeviceId,
        pendingPairing.commitment,
      );
      if (!verified) throw new Error("Android pairing proof is invalid");
      if (pairingTimer !== undefined) window.clearInterval(pairingTimer);
      pairingTimer = undefined;
      pendingPairing = undefined;
      savePendingPairing();
      pairingProofKey = undefined;
      await deleteKey(pairingProofKeyName);
      await refreshAccount();
      render();
      await connectSignal();
    } catch (error) {
      log(`Pairing check failed: ${String(error)}`);
      if (attempts >= 30) element("scannerStatus").textContent = "Android has not confirmed yet. Keep both apps open or refresh the QR.";
    }
  };
  pairingTimer = window.setInterval(() => void check(), 500);
  void check();
}

async function startScanner(): Promise<void> {
  if (!identity) throw new Error("browser enrollment is not ready");
  scannerControls?.stop();
  element("scannerStatus").textContent = "Point the camera at the Android QR";
  const reader = new BrowserQRCodeReader();
  scannerControls = await reader.decodeFromVideoDevice(undefined, element<HTMLVideoElement>("qrVideo"), (result, error, controls) => {
    if (result) {
      controls.stop();
      scannerControls = undefined;
      void consumePairingQr(result.getText()).catch((cause) => {
        element("scannerStatus").textContent = cause instanceof Error ? cause.message : String(cause);
      });
    } else if (error && error.name !== "NotFoundException") {
      log(`QR scan error: ${String(error)}`);
    }
  });
}

async function resumePairingFromUrl(): Promise<void> {
  if (location.pathname === "/pair" && location.hash.length > 1 && account?.subscription.active && identity) {
    await consumePairingQr(location.href);
    return;
  }
  if (pendingPairing && pairingKey && pairingProofKey) startPairingPolling();
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
  if (signalSocket && signalSocket.readyState !== WebSocket.CLOSED) signalSocket.close(4000, "reconnecting");
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
        stopSignalHeartbeat();
        if (!deliberatelyDisconnected) scheduleSignalReconnect();
      }
    };
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("signaling connection timed out")), 10_000);
      socket.onopen = () => {
        window.clearTimeout(timeout);
        reconnectAttempts = 0;
        lastSignalPongAt = Date.now();
        startSignalHeartbeat();
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

function stopSignalHeartbeat(): void {
  if (signalHeartbeatTimer !== undefined) window.clearInterval(signalHeartbeatTimer);
  signalHeartbeatTimer = undefined;
}

function startSignalHeartbeat(): void {
  stopSignalHeartbeat();
  signalHeartbeatTimer = window.setInterval(() => {
    const socket = signalSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (lastSignalPongAt > 0 && Date.now() - lastSignalPongAt > 45_000) {
      socket.close(4002, "heartbeat timeout");
      return;
    }
    socket.send("ping");
  }, 20_000);
}

async function recoverForegroundSession(): Promise<void> {
  if (foregroundRecovery) return foregroundRecovery;
  foregroundRecovery = (async () => {
    if (!firebaseUser || !identity?.pairingId || !pairingKey) return;
    await refreshAccount();
    await ensureSignalConnected();
    await recoverCurrentCall();
    await syncExistingPushSubscription();
  })();
  try {
    await foregroundRecovery;
  } finally {
    foregroundRecovery = undefined;
  }
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
  if (message === "pong") {
    lastSignalPongAt = Date.now();
    return;
  }
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
    else if (currentCall) {
      closeMedia();
      currentCall = undefined;
      element("incomingBanner").hidden = true;
    }
  } catch (error) {
    log(`Call recovery failed: ${String(error)}`);
  }
}

async function applyCallSnapshot(call: CallView): Promise<void> {
  if (currentCall?.id === call.id && currentCall.version >= call.version) return;
  if (currentCall?.id !== call.id && currentCall && currentCall.created_at > call.created_at) return;
  const changedCall = currentCall?.id !== call.id;
  currentCall = call;
  const incoming = element("incomingBanner");
  incoming.hidden = call.direction !== "incoming" || !["ringing_peer", "accepted", "active"].includes(call.state);
  const accepting = element<HTMLButtonElement>("acceptCall");
  if (call.state === "ringing_peer") {
    element("incomingState").textContent = "Waiting for you";
    accepting.disabled = false;
    accepting.textContent = "Accept";
  } else if (call.state === "accepted") {
    element("incomingState").textContent = call.telecom_answer_requested_at ? "Answering Android SIM call" : "Connecting audio";
    accepting.disabled = true;
    accepting.textContent = call.telecom_answer_requested_at ? "Answering…" : "Preparing…";
  } else {
    element("incomingState").textContent = "Connected";
    accepting.disabled = true;
    accepting.textContent = "Active";
  }
  if (changedCall) log(`${call.direction === "incoming" ? "Incoming" : "Outgoing"} call session: ${call.id}`);
  if (call.state === "ended" || call.state === "failed") {
    log(`Call ${call.state}`);
    closeMedia();
    currentCall = undefined;
    incoming.hidden = true;
    accepting.disabled = false;
    accepting.textContent = "Accept";
    return;
  }
  applyPeerMode(call.relay_mode);
  if (call.direction === "incoming" && call.state === "ringing_peer" && changedCall) {
    if (offerRecoveryTimer !== undefined) window.clearTimeout(offerRecoveryTimer);
    offerRecoveryTimer = window.setTimeout(() => {
      if (currentCall?.id === call.id && (!peerConnection || !peerConnection.remoteDescription)) {
        void sendSignal("ice_restart_request", { reason: "incoming_offer_recovery", icePolicy: "relay" }, call.id)
          .catch((error) => log(`Incoming media recovery failed: ${String(error)}`));
      }
    }, 1_500);
  }
  if (call.direction === "outgoing" || call.state === "accepted" || call.state === "active") {
    await ensurePeerConnection(call.id);
    if (changedCall) {
      if (offerRecoveryTimer !== undefined) window.clearTimeout(offerRecoveryTimer);
      offerRecoveryTimer = window.setTimeout(() => {
        if (currentCall?.id === call.id && peerConnection && !peerConnection.remoteDescription) {
          void sendSignal("ice_restart_request", { reason: "foreground_offer_recovery", icePolicy: "relay" }, call.id)
            .catch((error) => log(`Foreground media recovery failed: ${String(error)}`));
        }
      }, 1_500);
    }
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
  const speechConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    channelCount: 1,
  };
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: speechConstraints,
    video: false,
  });
  if (generation !== mediaGeneration) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error("media setup was cancelled");
  }
  for (const track of stream.getAudioTracks()) {
    track.contentHint = "speech";
    // WebKit has historically applied some capture constraints only when they
    // are repeated on the live track. Failure is non-fatal because Safari may
    // omit individual optional constraints while still providing processed audio.
    await track.applyConstraints(speechConstraints).catch(() => undefined);
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
  localStream?.getAudioTracks().forEach((track) => { track.enabled = mode !== "listen" && !localMicMuted; });
  element<HTMLAudioElement>("remoteAudio").muted = mode === "talk";
}

function closeMedia(clearCallId = true): void {
  mediaGeneration += 1;
  for (const timer of [candidateTimer, credentialRefreshTimer, statsTimer, forceRelayTimer, setupFailureTimer, disconnectRecoveryTimer, offerRecoveryTimer]) {
    if (timer !== undefined) window.clearTimeout(timer);
  }
  candidateTimer = credentialRefreshTimer = statsTimer = forceRelayTimer = setupFailureTimer = disconnectRecoveryTimer = offerRecoveryTimer = undefined;
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
  localMicMuted = false;
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

element("dial").addEventListener("click", () => void (async () => {
  if (!identity?.pairingId) throw new Error("pair first");
  await ensureSignalConnected();
  const input = element<HTMLInputElement>("phoneNumber").value.trim().replace(/[\s()-]/gu, "").replace(/^00/u, "+");
  if (!/^\+[1-9][0-9]{7,14}$/u.test(input)) throw new Error("enter a complete international number, for example +923001234567");
  const response = await signedFetch("/v1/calls/outgoing", {
    method: "POST",
    body: JSON.stringify({ pairingId: identity.pairingId, phoneNumber: input, requestId: crypto.randomUUID() }),
  });
  const data = await responseJson(response);
  const callId = requiredString(data.callId, "callId");
  const callData = await responseJson(await signedFetch(`/v1/calls/${callId}`));
  const call = callView(callData.call);
  if (!call) throw new Error("server returned an invalid call");
  await applyCallSnapshot(call);
  log(`Outgoing request created: ${callId}`);
})().catch((error) => log(`ERROR: ${String(error)}`)));

document.querySelectorAll<HTMLButtonElement>("[data-event]").forEach((button) => {
  button.addEventListener("click", () => void (async () => {
    const callId = currentCall?.id ?? mediaCallId;
    if (!callId) throw new Error("there is no active call");
    const event = button.dataset.event;
    if (!event) throw new Error("button event is missing");
    if (event === "accept") {
      button.disabled = true;
      button.textContent = "Preparing…";
      element("incomingState").textContent = "Preparing secure audio";
      await element<HTMLAudioElement>("remoteAudio").play().catch(() => undefined);
      await ensureSignalConnected();
      await ensurePeerConnection(callId);
    }
    if (event === "end" && mediaCallId === callId && Object.keys(lastStatsSummary).length) {
      await sendEvent(callId, "media_summary", lastStatsSummary);
    }
    await sendEvent(callId, event);
    if (event === "accept") {
      button.textContent = "Waiting…";
      element("incomingState").textContent = "Waiting for Android to answer";
    }
    if (event === "end" || event === "reject") closeMedia();
    if (event === "full_duplex" || event === "listen" || event === "talk") applyPeerMode(event);
    log(`Sent ${event}`);
  })().catch((error) => {
    if (button.dataset.event === "accept") {
      button.disabled = false;
      button.textContent = "Accept";
      element("incomingState").textContent = "Could not answer — tap to retry";
    }
    log(`ERROR: ${String(error)}`);
  }));
});

for (const [id, muted] of [["mute", true], ["unmute", false]] as const) {
  element(id).addEventListener("click", () => void (async () => {
    const callId = currentCall?.id ?? mediaCallId;
    if (!callId) throw new Error("there is no active call");
    localMicMuted = muted;
    applyPeerMode(currentCall?.relay_mode ?? "full_duplex");
    log(muted ? "iPhone microphone muted" : "iPhone microphone unmuted");
  })().catch((error) => log(`ERROR: ${String(error)}`)));
}

element("sendDtmf").addEventListener("click", () => void (async () => {
  const digit = element<HTMLInputElement>("dtmf").value.trim();
  const callId = currentCall?.id ?? mediaCallId;
  if (!callId) throw new Error("there is no active call");
  await sendEvent(callId, "dtmf", { digit });
  log(`Sent DTMF ${digit}`);
})().catch((error) => log(`ERROR: ${String(error)}`)));

element("googleSignIn").addEventListener("click", () => void (async () => {
  const auth = requireFirebaseAuth();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: "select_account" });
  try {
    await signInWithPopup(auth, provider);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
    if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") {
      await signInWithRedirect(auth, provider);
      return;
    }
    throw error;
  }
})().catch((error) => {
  showScreen("signInScreen");
  log(`Google sign-in failed: ${String(error)}`);
}));

async function performSignOut(revoke = true): Promise<void> {
  scannerControls?.stop();
  scannerControls = undefined;
  if (paymentTimer !== undefined) window.clearInterval(paymentTimer);
  if (pairingTimer !== undefined) window.clearInterval(pairingTimer);
  if (accountRefreshTimer !== undefined) window.clearInterval(accountRefreshTimer);
  paymentTimer = pairingTimer = undefined;
  accountRefreshTimer = undefined;
  if (revoke && identity && firebaseUser) {
    await responseJson(await signedFetch(`/v1/devices/${identity.deviceId}/web-push-subscription`, { method: "DELETE" })).catch(() => undefined);
    await responseJson(await bearerFetch(`/v1/devices/${identity.deviceId}/revoke`, { method: "POST", body: "{}" })).catch(() => undefined);
  }
  await unsubscribeIncomingNotifications().catch(() => undefined);
  await clearLocalDevice();
  account = undefined;
  accountScreenOpen = false;
  const auth = requireFirebaseAuth();
  await firebaseSignOut(auth);
  firebaseUser = null;
  render();
}

element("approvalSignOut").addEventListener("click", () => void performSignOut(false));
element("sessionRetry").addEventListener("click", () => {
  if (!firebaseUser) return render();
  startupError = undefined;
  showScreen("loadingScreen");
  void bootstrapAuthenticatedUser(firebaseUser).catch(showStartupError);
});
element("signOut").addEventListener("click", () => void performSignOut(true));
element("scanQr").addEventListener("click", () => void startScanner().catch((error) => {
  element("scannerStatus").textContent = error instanceof Error ? error.message : String(error);
}));
element("replacePeer").addEventListener("click", () => void ensureBrowserRegistration(true).then(() => {
  element<HTMLButtonElement>("replacePeer").hidden = true;
  render();
}).catch((error) => log(`Peer replacement failed: ${String(error)}`)));
element("enableNotifications").addEventListener("click", () => void enableIncomingNotifications().catch((error) => {
  setNotificationStatus(error instanceof Error ? error.message : String(error));
  log(`Notification setup failed: ${String(error)}`);
}));
element("refreshPayment").addEventListener("click", () => startPaymentPolling());
element<HTMLAnchorElement>("returnToAndroid").hidden = !androidBillingReturn;
element("accountMenu").addEventListener("click", () => { accountScreenOpen = true; render(); });
element("closeAccount").addEventListener("click", () => { accountScreenOpen = false; render(); });
element("managePlan").addEventListener("click", () => void (async () => {
  const data = await responseJson(await bearerFetch("/v1/billing/portal", { method: "POST", body: "{}" }));
  const portalUrl = new URL(requiredString(data.portalUrl, "portalUrl"));
  if (portalUrl.protocol !== "https:") throw new Error("billing portal URL is unsafe");
  location.assign(portalUrl.toString());
})().catch((error) => log(`Billing portal failed: ${String(error)}`)));
element("startReplacePeer").addEventListener("click", () => void (async () => {
  if (identity) await responseJson(await bearerFetch(`/v1/devices/${identity.deviceId}/revoke`, { method: "POST", body: "{}" }));
  await clearLocalDevice();
  accountScreenOpen = false;
  await refreshAccount();
  await ensureBrowserRegistration(false);
  render();
})().catch((error) => log(`Peer replacement failed: ${String(error)}`)));

window.addEventListener("online", () => {
  void recoverForegroundSession().catch((error) => log(`Online recovery failed: ${String(error)}`));
  if (peerConnection && peerConnection.connectionState !== "connected") void requestRelayRestart("network_online");
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && firebaseUser) {
    void recoverForegroundSession().catch((error) => log(`Foreground recovery failed: ${String(error)}`));
  }
});
window.addEventListener("focus", () => void recoverForegroundSession().catch((error) => log(`Focus recovery failed: ${String(error)}`)));
window.addEventListener("pageshow", () => void recoverForegroundSession().catch((error) => log(`Page recovery failed: ${String(error)}`)));
window.addEventListener("beforeunload", () => {
  deliberatelyDisconnected = true;
  stopSignalHeartbeat();
  signalSocket?.close(1000, "page closing");
  closeMedia();
});

render();
void initializeHostedCheckout().catch((error) => log(`Checkout initialization failed: ${String(error)}`));
if (androidBillingReturn && !checkoutPageActive) window.setTimeout(() => { location.href = "callrelay://billing/complete"; }, 250);
if (firebaseAuth) {
  void getRedirectResult(firebaseAuth).catch((error) => log(`Google redirect failed: ${String(error)}`));
  onAuthStateChanged(firebaseAuth, (user) => {
    if (!user) {
      if (accountRefreshTimer !== undefined) window.clearInterval(accountRefreshTimer);
      accountRefreshTimer = undefined;
      firebaseUser = null;
      account = undefined;
      startupError = undefined;
      render();
      return;
    }
    void bootstrapAuthenticatedUser(user).catch(showStartupError);
  });
} else {
  showStartupError(firebaseInitializationError ?? new Error("Firebase web sign-in is not configured on this deployment"));
}
if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/sw.js").catch((error) => log(`Offline shell unavailable: ${String(error)}`));
