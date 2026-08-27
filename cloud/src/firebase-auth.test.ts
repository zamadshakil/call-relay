import { createLocalJWKSet, exportJWK, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { hasActiveEntitlement, verifyFirebaseIdToken } from "./firebase-auth";
import type { AccountContext, ApprovalStatus, Env, SubscriptionStatus } from "./types";

async function fixture(): Promise<{
  sign: (overrides?: Record<string, unknown>) => Promise<string>;
  keySet: ReturnType<typeof createLocalJWKSet>;
}> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await exportJWK(pair.publicKey);
  publicJwk.kid = "firebase-test-key";
  publicJwk.alg = "RS256";
  const keySet = createLocalJWKSet({ keys: [publicJwk] });
  const sign = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const now = Math.floor(Date.now() / 1000);
    const issuedAt = typeof overrides.__issuedAt === "number" ? overrides.__issuedAt : now;
    const expiresAt = typeof overrides.__expiresAt === "number" ? overrides.__expiresAt : now + 3600;
    const { __issuedAt: _issuedAt, __expiresAt: _expiresAt, ...claims } = overrides;
    const defaults = {
      email: "approved@gmail.com",
      email_verified: true,
      auth_time: now - 30,
      name: "Approved User",
      picture: "https://example.invalid/avatar.png",
      ...claims,
    };
    return new SignJWT(defaults)
      .setProtectedHeader({ alg: "RS256", kid: "firebase-test-key" })
      .setIssuer("https://securetoken.google.com/integration-project")
      .setAudience("integration-project")
      .setSubject("firebase-user-1")
      .setIssuedAt(issuedAt)
      .setExpirationTime(expiresAt)
      .sign(pair.privateKey);
  };
  return { sign, keySet };
}

const authEnv = {
  FIREBASE_PROJECT_ID: "integration-project",
  FCM_PROJECT_ID: "integration-project",
} as unknown as Env;

describe("Firebase ID token verification", () => {
  it("accepts a current, verified Firebase token", async () => {
    const { sign, keySet } = await fixture();
    const identity = await verifyFirebaseIdToken(await sign(), authEnv, keySet);
    expect(identity).toMatchObject({ uid: "firebase-user-1", email: "approved@gmail.com", emailVerified: true });
  });

  it("rejects an unverified email", async () => {
    const { sign, keySet } = await fixture();
    await expect(verifyFirebaseIdToken(await sign({ email_verified: false }), authEnv, keySet))
      .rejects.toMatchObject({ status: 403 });
  });

  it("rejects wrong audience and expired tokens", async () => {
    const { sign, keySet } = await fixture();
    const valid = await sign();
    await expect(verifyFirebaseIdToken(valid, { ...authEnv, FIREBASE_PROJECT_ID: "wrong-project" } as Env, keySet))
      .rejects.toMatchObject({ status: 401 });
    const now = Math.floor(Date.now() / 1000);
    const expired = await sign({ auth_time: now - 7200, __issuedAt: now - 7200, __expiresAt: now - 3600 });
    await expect(verifyFirebaseIdToken(expired, authEnv, keySet)).rejects.toMatchObject({ status: 401 });
  });
});

describe("account entitlement", () => {
  const account = (approvalStatus: ApprovalStatus, status: SubscriptionStatus, periodEnd: number | null = Date.now() + 60_000): AccountContext => ({
    identity: {
      uid: "firebase-user-1",
      email: "approved@gmail.com",
      emailVerified: true,
      displayName: null,
      photoUrl: null,
      issuedAt: 0,
      authTime: 0,
    },
    approvalStatus,
    subscription: {
      user_id: "firebase-user-1",
      paddle_customer_id: null,
      paddle_subscription_id: null,
      plan_code: "monthly",
      status,
      current_period_ends_at: periodEnd,
      cancel_at_period_end: 0,
      latest_transaction_id: null,
      source_occurred_at: 0,
      created_at: 0,
      updated_at: 0,
    },
  });

  it("allows only approved, current, active subscriptions", () => {
    expect(hasActiveEntitlement(account("approved", "active"))).toBe(true);
    for (const status of ["none", "pending", "past_due", "paused", "canceled", "refunded", "disputed"] satisfies SubscriptionStatus[]) {
      expect(hasActiveEntitlement(account("approved", status))).toBe(false);
    }
    expect(hasActiveEntitlement(account("unknown", "active"))).toBe(false);
    expect(hasActiveEntitlement(account("suspended", "active"))).toBe(false);
    expect(hasActiveEntitlement(account("approved", "active", Date.now() - 1))).toBe(false);
  });
});
