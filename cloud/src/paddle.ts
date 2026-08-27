import { authenticateFirebase, requireApproved } from "./firebase-auth";
import { HttpError, json, readBodyBytes, readJson, requireString, timingSafeEqualText } from "./http";
import { secretValue } from "./secrets";
import { dispatchOutboxItem } from "./outbox";
import type { AccountContext, Env, PlanCode, SubscriptionStatus } from "./types";

type JsonObject = Record<string, unknown>;

function apiBase(env: Env): string {
  return env.PADDLE_ENVIRONMENT === "production" ? "https://api.paddle.com" : "https://sandbox-api.paddle.com";
}

function priceId(env: Env, plan: PlanCode): string {
  const value = plan === "monthly" ? env.PADDLE_MONTHLY_PRICE_ID : env.PADDLE_ANNUAL_PRICE_ID;
  if (!/^pri_[a-z0-9]{26}$/u.test(value)) throw new HttpError(503, `${plan} billing is not configured`);
  return value;
}

async function paddleFetch(env: Env, path: string, init: RequestInit): Promise<JsonObject> {
  const apiKey = await secretValue(env.PADDLE_API_KEY, "PADDLE_API_KEY");
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("content-type", "application/json");
  headers.set("paddle-version", "1");
  const response = await fetch(`${apiBase(env)}${path}`, { ...init, headers });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    console.error(JSON.stringify({ message: "Paddle API request failed", path, status: response.status }));
    throw new HttpError(502, "the billing provider is temporarily unavailable");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(502, "the billing provider returned an invalid response");
  return value as JsonObject;
}

function requestIp(request: Request): string | null {
  const candidate = request.headers.get("cf-connecting-ip");
  return candidate && candidate.length <= 64 ? candidate : null;
}

function nestedObject(value: unknown, key: string): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !(key in value)) return null;
  const nested = (value as JsonObject)[key];
  return typeof nested === "object" && nested !== null && !Array.isArray(nested) ? nested as JsonObject : null;
}

function lineItemPlan(lineItem: JsonObject, env: Env): PlanCode | null {
  const price = nestedObject(lineItem, "price");
  const candidate = typeof lineItem.price_id === "string" ? lineItem.price_id : typeof price?.id === "string" ? price.id : null;
  if (candidate === env.PADDLE_MONTHLY_PRICE_ID) return "monthly";
  if (candidate === env.PADDLE_ANNUAL_PRICE_ID) return "annual";
  return null;
}

function formattedAmount(lineItem: JsonObject): string | null {
  const formatted = nestedObject(lineItem, "formatted_unit_totals");
  return typeof formatted?.total === "string" ? formatted.total : null;
}

function minorAmount(lineItem: JsonObject): number | null {
  const totals = nestedObject(lineItem, "unit_totals");
  const value = Number(totals?.total);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export async function billingPlans(request: Request, env: Env): Promise<Response> {
  const account = await authenticateFirebase(request, env);
  requireApproved(account);
  const preview = await paddleFetch(env, "/pricing-preview", {
    method: "POST",
    body: JSON.stringify({
      items: [
        { price_id: priceId(env, "monthly"), quantity: 1 },
        { price_id: priceId(env, "annual"), quantity: 1 },
      ],
      ...(requestIp(request) ? { customer_ip_address: requestIp(request) } : {}),
    }),
  });
  const data = nestedObject(preview, "data");
  const details = nestedObject(data, "details");
  const lineItems = Array.isArray(details?.line_items) ? details.line_items : [];
  const plans = lineItems.flatMap((item): Array<{ code: PlanCode; priceId: string; formattedPrice: string; minorAmount: number }> => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
    const record = item as JsonObject;
    const code = lineItemPlan(record, env);
    const formattedPrice = formattedAmount(record);
    const amount = minorAmount(record);
    return code && formattedPrice && amount !== null ? [{ code, priceId: priceId(env, code), formattedPrice, minorAmount: amount }] : [];
  });
  if (plans.length !== 2) throw new HttpError(502, "localized billing prices are unavailable");
  return json({ plans, currencyCode: typeof data?.currency_code === "string" ? data.currency_code : null });
}

export async function createCheckout(request: Request, env: Env): Promise<Response> {
  const account = await authenticateFirebase(request, env);
  requireApproved(account);
  const body = await readJson<JsonObject>(request);
  const plan = requireString(body.plan, "plan", 16) as PlanCode;
  if (plan !== "monthly" && plan !== "annual") throw new HttpError(400, "plan must be monthly or annual");
  const returnTarget = body.returnTarget === undefined ? "web" : requireString(body.returnTarget, "returnTarget", 16);
  if (returnTarget !== "web" && returnTarget !== "android") throw new HttpError(400, "returnTarget must be web or android");
  if (account.subscription?.status === "active") throw new HttpError(409, "use Manage plan for an existing subscription");
  const checkoutReturnUrl = new URL("/billing/complete", env.PUBLIC_APP_URL);
  if (returnTarget === "android") checkoutReturnUrl.searchParams.set("return", "android");
  const checkoutBase = checkoutReturnUrl.toString();
  const transaction = await paddleFetch(env, "/transactions", {
    method: "POST",
    body: JSON.stringify({
      items: [{ price_id: priceId(env, plan), quantity: 1 }],
      collection_mode: "automatic",
      custom_data: { firebase_uid: account.identity.uid, plan_code: plan },
      checkout: { url: checkoutBase },
    }),
  });
  const data = nestedObject(transaction, "data");
  const checkout = nestedObject(data, "checkout");
  const checkoutUrl = typeof checkout?.url === "string" ? checkout.url : null;
  const transactionId = typeof data?.id === "string" ? data.id : null;
  if (!checkoutUrl || !transactionId) throw new HttpError(502, "Paddle did not return a checkout link");
  const now = Date.now();
  await env.CALL_RELAY_DB.prepare(
    `INSERT INTO billing_subscriptions(user_id, plan_code, status, latest_transaction_id, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET plan_code = excluded.plan_code, status = CASE
       WHEN billing_subscriptions.status = 'active' THEN billing_subscriptions.status ELSE 'pending' END,
       latest_transaction_id = excluded.latest_transaction_id, updated_at = excluded.updated_at`,
  ).bind(account.identity.uid, plan, transactionId, now, now).run();
  return json({ checkoutUrl, transactionId }, { status: 201 });
}

export async function createPortal(request: Request, env: Env): Promise<Response> {
  const account = await authenticateFirebase(request, env);
  requireApproved(account);
  const customerId = account.subscription?.paddle_customer_id;
  if (!customerId || !/^ctm_[a-z0-9]{26}$/u.test(customerId)) throw new HttpError(409, "no Paddle customer is associated with this account");
  const subscriptionId = account.subscription?.paddle_subscription_id;
  const portal = await paddleFetch(env, `/customers/${encodeURIComponent(customerId)}/portal-sessions`, {
    method: "POST",
    body: JSON.stringify(subscriptionId ? { subscription_ids: [subscriptionId] } : {}),
  });
  const data = nestedObject(portal, "data");
  const urls = nestedObject(data, "urls");
  const general = nestedObject(urls, "general");
  const portalUrl = typeof general?.overview === "string" ? general.overview : null;
  if (!portalUrl) throw new HttpError(502, "Paddle did not return a customer portal link");
  return json({ portalUrl });
}

interface PaddleEnvelope {
  event_id: string;
  event_type: string;
  occurred_at: string;
  data: JsonObject;
}

function parsePaddleEvent(value: unknown): PaddleEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new HttpError(400, "invalid Paddle event");
  const record = value as JsonObject;
  const eventId = requireString(record.event_id, "event_id", 80);
  const eventType = requireString(record.event_type, "event_type", 100);
  const occurredAt = requireString(record.occurred_at, "occurred_at", 64);
  if (!/^evt_[a-z0-9]{26}$/u.test(eventId) || !Number.isFinite(Date.parse(occurredAt))) throw new HttpError(400, "invalid Paddle event metadata");
  if (typeof record.data !== "object" || record.data === null || Array.isArray(record.data)) throw new HttpError(400, "invalid Paddle event data");
  return { event_id: eventId, event_type: eventType, occurred_at: occurredAt, data: record.data as JsonObject };
}

function parseSignature(header: string): { timestamp: number; signatures: string[] } {
  const values = header.split(";").map((part) => part.trim().split("=", 2));
  const timestamp = Number(values.find(([name]) => name === "ts")?.[1]);
  const signatures = values.filter(([name, value]) => name === "h1" && /^[a-f0-9]{64}$/iu.test(value ?? "")).map(([, value]) => value?.toLowerCase() ?? "");
  if (!Number.isSafeInteger(timestamp) || signatures.length === 0) throw new HttpError(401, "invalid Paddle signature header");
  return { timestamp, signatures };
}

async function verifyPaddleSignature(rawBody: Uint8Array, signatureHeader: string, env: Env): Promise<void> {
  const { timestamp, signatures } = parseSignature(signatureHeader);
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) throw new HttpError(401, "expired Paddle webhook signature");
  const secret = await secretValue(env.PADDLE_WEBHOOK_SECRET, "PADDLE_WEBHOOK_SECRET");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const prefix = new TextEncoder().encode(`${timestamp}:`);
  const signed = new Uint8Array(prefix.byteLength + rawBody.byteLength);
  signed.set(prefix);
  signed.set(rawBody, prefix.byteLength);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  const expected = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  for (const candidate of signatures) {
    if (await timingSafeEqualText(candidate, expected)) return;
  }
  throw new HttpError(401, "invalid Paddle webhook signature");
}

function customData(data: JsonObject): JsonObject {
  return typeof data.custom_data === "object" && data.custom_data !== null && !Array.isArray(data.custom_data) ? data.custom_data as JsonObject : {};
}

function nullableString(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function eventPlan(data: JsonObject, env: Env): PlanCode | null {
  const customPlan = customData(data).plan_code;
  if (customPlan === "monthly" || customPlan === "annual") return customPlan;
  if (Array.isArray(data.items)) {
    for (const item of data.items) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
      const price = nestedObject(item, "price");
      const candidate = typeof price?.id === "string" ? price.id : null;
      if (candidate === env.PADDLE_MONTHLY_PRICE_ID) return "monthly";
      if (candidate === env.PADDLE_ANNUAL_PRICE_ID) return "annual";
    }
  }
  return null;
}

function subscriptionStatus(event: PaddleEnvelope): SubscriptionStatus | null {
  const rawStatus = typeof event.data.status === "string" ? event.data.status : null;
  if (event.event_type === "transaction.payment_failed" || rawStatus === "past_due") return "past_due";
  if (event.event_type.startsWith("subscription.")) {
    if (rawStatus === "active") return "active";
    if (rawStatus === "paused") return "paused";
    if (rawStatus === "canceled") return "canceled";
    if (rawStatus === "past_due") return "past_due";
    if (rawStatus === "trialing") return "pending";
  }
  if ((event.event_type === "adjustment.created" || event.event_type === "adjustment.updated") &&
      event.data.status === "approved") {
    if (event.data.action === "refund") return "refunded";
    if (event.data.action === "chargeback" || event.data.action === "chargeback_warning") return "disputed";
  }
  return null;
}

function periodEnd(data: JsonObject): number | null {
  const period = nestedObject(data, "current_billing_period") ?? nestedObject(data, "billing_period");
  if (typeof period?.ends_at !== "string") return null;
  const value = Date.parse(period.ends_at);
  return Number.isFinite(value) ? value : null;
}

async function resolveWebhookUser(env: Env, event: PaddleEnvelope): Promise<string | null> {
  const customUid = customData(event.data).firebase_uid;
  if (typeof customUid === "string" && customUid.length > 0 && customUid.length <= 128) return customUid;
  const subscriptionId = nullableString(event.data.subscription_id ?? event.data.id, /^sub_[a-z0-9]{26}$/u);
  const customerId = nullableString(event.data.customer_id, /^ctm_[a-z0-9]{26}$/u);
  const transactionId = event.event_type.startsWith("transaction.")
    ? nullableString(event.data.id, /^txn_[a-z0-9]{26}$/u)
    : nullableString(event.data.transaction_id, /^txn_[a-z0-9]{26}$/u);
  if (!subscriptionId && !customerId && !transactionId) return null;
  const row = await env.CALL_RELAY_DB.prepare(
    `SELECT user_id FROM billing_subscriptions
     WHERE paddle_subscription_id = ? OR paddle_customer_id = ? OR latest_transaction_id = ? LIMIT 1`,
  ).bind(subscriptionId, customerId, transactionId).first<{ user_id: string }>();
  return row?.user_id ?? null;
}

async function applyPaddleEvent(env: Env, event: PaddleEnvelope, occurredAt: number): Promise<string | null> {
  const userId = await resolveWebhookUser(env, event);
  if (!userId) return null;
  const user = await env.CALL_RELAY_DB.prepare("SELECT id FROM firebase_users WHERE id = ?").bind(userId).first<{ id: string }>();
  if (!user) return null;
  const paddleCustomerId = nullableString(event.data.customer_id, /^ctm_[a-z0-9]{26}$/u);
  const paddleSubscriptionId = event.event_type.startsWith("subscription.")
    ? nullableString(event.data.id, /^sub_[a-z0-9]{26}$/u)
    : nullableString(event.data.subscription_id, /^sub_[a-z0-9]{26}$/u);
  const transactionId = event.event_type.startsWith("transaction.")
    ? nullableString(event.data.id, /^txn_[a-z0-9]{26}$/u)
    : nullableString(event.data.transaction_id, /^txn_[a-z0-9]{26}$/u);
  const plan = eventPlan(event.data, env);
  const transactionPeriodEnd = periodEnd(event.data);
  const completedRecurringPayment = event.event_type === "transaction.completed" &&
    event.data.status === "completed" && paddleSubscriptionId !== null && plan !== null && transactionPeriodEnd !== null;
  const status = completedRecurringPayment ? "active" : subscriptionStatus(event);
  const scheduled = nestedObject(event.data, "scheduled_change");
  const cancelAtPeriodEnd = scheduled?.action === "cancel" ? 1 : 0;
  const cancellationUpdate = event.event_type.startsWith("subscription.") ? cancelAtPeriodEnd : null;
  const now = Date.now();
  await env.CALL_RELAY_DB.prepare(
    `INSERT INTO billing_subscriptions(user_id, paddle_customer_id, paddle_subscription_id, plan_code, status,
       current_period_ends_at, cancel_at_period_end, latest_transaction_id, source_occurred_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       paddle_customer_id = CASE WHEN excluded.source_occurred_at >= billing_subscriptions.source_occurred_at
         THEN COALESCE(excluded.paddle_customer_id, billing_subscriptions.paddle_customer_id)
         ELSE billing_subscriptions.paddle_customer_id END,
       paddle_subscription_id = CASE WHEN excluded.source_occurred_at >= billing_subscriptions.source_occurred_at
         THEN COALESCE(excluded.paddle_subscription_id, billing_subscriptions.paddle_subscription_id)
         ELSE billing_subscriptions.paddle_subscription_id END,
       plan_code = CASE WHEN excluded.source_occurred_at >= billing_subscriptions.source_occurred_at
         THEN COALESCE(excluded.plan_code, billing_subscriptions.plan_code)
         ELSE billing_subscriptions.plan_code END,
       status = CASE WHEN excluded.source_occurred_at >= billing_subscriptions.source_occurred_at AND ? IS NOT NULL
         THEN excluded.status ELSE billing_subscriptions.status END,
       current_period_ends_at = CASE WHEN excluded.source_occurred_at >= billing_subscriptions.source_occurred_at
         THEN COALESCE(excluded.current_period_ends_at, billing_subscriptions.current_period_ends_at)
         ELSE billing_subscriptions.current_period_ends_at END,
       cancel_at_period_end = CASE WHEN excluded.source_occurred_at >= billing_subscriptions.source_occurred_at AND ? IS NOT NULL
         THEN excluded.cancel_at_period_end ELSE billing_subscriptions.cancel_at_period_end END,
       latest_transaction_id = CASE WHEN excluded.source_occurred_at >= billing_subscriptions.source_occurred_at
         THEN COALESCE(excluded.latest_transaction_id, billing_subscriptions.latest_transaction_id)
         ELSE billing_subscriptions.latest_transaction_id END,
       source_occurred_at = MAX(excluded.source_occurred_at, billing_subscriptions.source_occurred_at),
       updated_at = excluded.updated_at`,
  ).bind(
    userId, paddleCustomerId, paddleSubscriptionId, plan, status ?? "pending", transactionPeriodEnd, cancelAtPeriodEnd,
    transactionId, occurredAt, now, now, status, cancellationUpdate,
  ).run();
  return userId;
}

export async function paddleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const rawBody = await readBodyBytes(request, 256 * 1024);
  await verifyPaddleSignature(rawBody, request.headers.get("paddle-signature") ?? "", env);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(rawBody));
  } catch {
    throw new HttpError(400, "invalid Paddle webhook JSON");
  }
  const event = parsePaddleEvent(parsed);
  const occurredAt = Date.parse(event.occurred_at);
  const insert = await env.CALL_RELAY_DB.prepare(
    "INSERT OR IGNORE INTO billing_webhook_events(id, event_type, occurred_at, processed_at) VALUES (?, ?, ?, ?)",
  ).bind(event.event_id, event.event_type, occurredAt, 0).run();
  if (insert.meta.changes !== 1) {
    const existing = await env.CALL_RELAY_DB.prepare("SELECT processed_at FROM billing_webhook_events WHERE id = ?")
      .bind(event.event_id).first<{ processed_at: number }>();
    if ((existing?.processed_at ?? 0) > 0) return json({ received: true, duplicate: true });
    throw new HttpError(503, "this Paddle event is already being processed; retry shortly");
  }
  try {
    const userId = await applyPaddleEvent(env, event, occurredAt);
    if (userId && (subscriptionStatus(event) !== null || event.event_type === "transaction.completed")) {
      const [subscription, android] = await Promise.all([
        env.CALL_RELAY_DB.prepare("SELECT status FROM billing_subscriptions WHERE user_id = ?").bind(userId).first<{ status: string }>(),
        env.CALL_RELAY_DB.prepare("SELECT id FROM devices WHERE user_id = ? AND platform = 'android' AND revoked_at IS NULL LIMIT 1")
          .bind(userId).first<{ id: string }>(),
      ]);
      if (subscription && android) {
        const outboxId = `push_${crypto.randomUUID().replaceAll("-", "")}`;
        await env.CALL_RELAY_DB.prepare(
          "INSERT INTO push_outbox(id, target_device_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
        ).bind(outboxId, android.id, JSON.stringify({
          targetDeviceId: android.id,
          data: { type: "entitlement_changed", status: subscription.status },
        }), Date.now()).run();
        ctx.waitUntil(dispatchOutboxItem(env, outboxId).catch((error: unknown) => {
          console.error(JSON.stringify({ message: "entitlement push enqueue failed", error: error instanceof Error ? error.message : String(error) }));
        }));
      }
    }
    await env.CALL_RELAY_DB.prepare("UPDATE billing_webhook_events SET processed_at = ? WHERE id = ? AND processed_at = 0")
      .bind(Date.now(), event.event_id).run();
  } catch (error) {
    await env.CALL_RELAY_DB.prepare("DELETE FROM billing_webhook_events WHERE id = ? AND processed_at = 0")
      .bind(event.event_id).run();
    throw error;
  }
  return json({ received: true });
}

export function publicEntitlement(account: AccountContext): Record<string, unknown> {
  return {
    status: account.subscription?.status ?? "none",
    plan: account.subscription?.plan_code ?? null,
    currentPeriodEndsAt: account.subscription?.current_period_ends_at ?? null,
  };
}
