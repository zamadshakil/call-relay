import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { googleAccessToken } from "./google-oauth";
import { HttpError } from "./http";
import type { AccountContext, ApprovalStatus, Env, FirebaseIdentity, SubscriptionRow } from "./types";

const FIREBASE_JWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com"),
);
const MAX_FIREBASE_TOKEN_AGE_SECONDS = 65 * 60;

function bearerToken(request: Request): string {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._-]+)$/u.exec(authorization);
  if (!match?.[1]) throw new HttpError(401, "a Firebase bearer token is required");
  return match[1];
}

export async function verifyFirebaseIdToken(
  token: string,
  env: Env,
  keySet: JWTVerifyGetKey = FIREBASE_JWKS,
): Promise<FirebaseIdentity> {
  const projectId = String(env.FIREBASE_PROJECT_ID || env.FCM_PROJECT_ID);
  if (!projectId || projectId === "replace-me") throw new Error("FIREBASE_PROJECT_ID is not configured");
  try {
    const { payload, protectedHeader } = await jwtVerify(token, keySet, {
      algorithms: ["RS256"],
      audience: projectId,
      issuer: `https://securetoken.google.com/${projectId}`,
      maxTokenAge: MAX_FIREBASE_TOKEN_AGE_SECONDS,
    });
    if (protectedHeader.alg !== "RS256") throw new Error("unexpected signing algorithm");
    if (typeof payload.sub !== "string" || payload.sub.length === 0 || payload.sub.length > 128) throw new Error("invalid subject");
    if (typeof payload.email !== "string" || payload.email.length > 320) throw new Error("verified email is required");
    if (payload.email_verified !== true) throw new HttpError(403, "the Google email address is not verified");
    if (typeof payload.iat !== "number" || typeof payload.auth_time !== "number") throw new Error("missing token timestamps");
    return {
      uid: payload.sub,
      email: payload.email.trim().toLowerCase(),
      emailVerified: true,
      displayName: typeof payload.name === "string" ? payload.name.slice(0, 160) : null,
      photoUrl: typeof payload.picture === "string" ? payload.picture.slice(0, 2048) : null,
      issuedAt: payload.iat,
      authTime: payload.auth_time,
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "invalid or expired Firebase ID token");
  }
}

async function assertFirebaseUserNotRevoked(env: Env, identity: FirebaseIdentity): Promise<void> {
  const accessToken = await googleAccessToken(env, ["https://www.googleapis.com/auth/identitytoolkit"]);
  const projectId = String(env.FIREBASE_PROJECT_ID || env.FCM_PROJECT_ID);
  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/accounts:lookup`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ localId: [identity.uid] }),
    },
  );
  if (!response.ok) throw new HttpError(503, "Firebase account status could not be verified");
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("users" in body) || !Array.isArray(body.users) || body.users.length !== 1) {
    throw new HttpError(401, "Firebase user no longer exists");
  }
  const user: unknown = body.users[0];
  if (typeof user !== "object" || user === null) throw new HttpError(401, "Firebase user no longer exists");
  if (!("localId" in user) || user.localId !== identity.uid) throw new HttpError(401, "Firebase user no longer exists");
  if ("disabled" in user && user.disabled === true) throw new HttpError(403, "Firebase user is disabled");
  const validSince = "validSince" in user ? Number(user.validSince) : 0;
  if (Number.isFinite(validSince) && validSince > 0 && identity.authTime < validSince) {
    throw new HttpError(401, "Firebase session has been revoked; sign in again");
  }
}

async function approvalFor(env: Env, email: string): Promise<ApprovalStatus> {
  const row = await env.CALL_RELAY_DB.prepare("SELECT status FROM approved_emails WHERE email = ? COLLATE NOCASE")
    .bind(email).first<{ status: "approved" | "suspended" }>();
  return row?.status ?? "unknown";
}

async function subscriptionFor(env: Env, userId: string): Promise<SubscriptionRow | null> {
  return env.CALL_RELAY_DB.prepare("SELECT * FROM billing_subscriptions WHERE user_id = ?")
    .bind(userId).first<SubscriptionRow>();
}

export async function authenticateFirebase(
  request: Request,
  env: Env,
  options: { persist?: boolean; checkRevoked?: boolean } = {},
): Promise<AccountContext> {
  const identity = await verifyFirebaseIdToken(bearerToken(request), env);
  if (options.checkRevoked === true) await assertFirebaseUserNotRevoked(env, identity);
  const now = Date.now();
  if (options.persist !== false) {
    await env.CALL_RELAY_DB.prepare(
      `INSERT INTO firebase_users(id, email, display_name, photo_url, email_verified, created_at, updated_at, last_authenticated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET email = excluded.email, display_name = excluded.display_name,
         photo_url = excluded.photo_url, email_verified = 1, updated_at = excluded.updated_at,
         last_authenticated_at = excluded.last_authenticated_at`,
    ).bind(identity.uid, identity.email, identity.displayName, identity.photoUrl, now, now, now).run();
  }
  const [approvalStatus, subscription] = await Promise.all([
    approvalFor(env, identity.email),
    subscriptionFor(env, identity.uid),
  ]);
  return { identity, approvalStatus, subscription };
}

export function hasActiveEntitlement(account: AccountContext, now = Date.now()): boolean {
  const subscription = account.subscription;
  return account.approvalStatus === "approved" && subscription?.status === "active" &&
    (subscription.current_period_ends_at === null || subscription.current_period_ends_at > now);
}

export function requireApproved(account: AccountContext): void {
  if (account.approvalStatus === "unknown") throw new HttpError(403, "this account is not approved");
  if (account.approvalStatus === "suspended") throw new HttpError(403, "this account is suspended");
}

export function requireEntitlement(account: AccountContext): void {
  requireApproved(account);
  if (!hasActiveEntitlement(account)) throw new HttpError(402, "an active paid subscription is required");
}
