import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/types";

async function invoke(request: Request): Promise<Response> {
  const context = createExecutionContext();
  const response = await worker.fetch(request as Request<unknown, IncomingRequestCfProperties>, env as unknown as Env, context);
  await waitOnExecutionContext(context);
  return response;
}

async function signature(body: string, timestamp: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("pdl_ntfset_integration"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}:${body}`)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function send(event: Record<string, unknown>, valid = true): Promise<Response> {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const digest = valid ? await signature(body, timestamp) : "0".repeat(64);
  return invoke(new Request("https://relay.test/v1/billing/webhooks/paddle", {
    method: "POST",
    headers: { "content-type": "application/json", "paddle-signature": `ts=${timestamp};h1=${digest}` },
    body,
  }));
}

const userId = "paddle-webhook-user";
const customerId = `ctm_${"c".repeat(26)}`;
const subscriptionId = `sub_${"s".repeat(26)}`;
const androidDeviceId = `dev_${"p".repeat(32)}`;

beforeEach(async () => {
  const now = Date.now();
  await env.CALL_RELAY_DB.prepare(
    `INSERT OR REPLACE INTO firebase_users(id, email, email_verified, created_at, updated_at, last_authenticated_at)
     VALUES (?, ?, 1, ?, ?, ?)`,
  ).bind(userId, "paddle-webhook@gmail.com", now, now, now).run();
  await env.CALL_RELAY_DB.prepare("DELETE FROM billing_subscriptions WHERE user_id = ?").bind(userId).run();
  await env.CALL_RELAY_DB.prepare("DELETE FROM push_outbox WHERE target_device_id = ?").bind(androidDeviceId).run();
  await env.CALL_RELAY_DB.prepare("DELETE FROM devices WHERE id = ?").bind(androidDeviceId).run();
  await env.CALL_RELAY_DB.prepare(
    `INSERT INTO devices(id, platform, display_name, public_key_spki, created_at, last_seen_at, user_id)
     VALUES (?, 'android', 'Paddle test Android', 'test', ?, ?, ?)`,
  ).bind(androidDeviceId, now, now, userId).run();
});

describe("Paddle webhook provisioning", () => {
  it("verifies the raw body, activates idempotently, and ignores older subscription state", async () => {
    const occurredAt = new Date(Date.now() - 10_000).toISOString();
    const created = {
      event_id: `evt_${"a".repeat(26)}`,
      event_type: "subscription.created",
      occurred_at: occurredAt,
      data: {
        id: subscriptionId,
        customer_id: customerId,
        status: "active",
        custom_data: { firebase_uid: userId, plan_code: "monthly" },
        current_billing_period: { ends_at: new Date(Date.now() + 30 * 86_400_000).toISOString() },
      },
    };
    expect((await send(created)).status).toBe(200);
    const duplicate = await send(created);
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({ duplicate: true });
    const active = await env.CALL_RELAY_DB.prepare(
      "SELECT status, plan_code, paddle_customer_id, paddle_subscription_id FROM billing_subscriptions WHERE user_id = ?",
    ).bind(userId).first<Record<string, unknown>>();
    expect(active).toMatchObject({ status: "active", plan_code: "monthly", paddle_customer_id: customerId, paddle_subscription_id: subscriptionId });
    const activationPush = await env.CALL_RELAY_DB.prepare(
      "SELECT payload_json FROM push_outbox WHERE target_device_id = ? ORDER BY created_at DESC LIMIT 1",
    ).bind(androidDeviceId).first<{ payload_json: string }>();
    expect(JSON.parse(activationPush?.payload_json ?? "{}")).toMatchObject({ data: { type: "entitlement_changed", status: "active" } });

    const olderCanceled = {
      ...created,
      event_id: `evt_${"b".repeat(26)}`,
      event_type: "subscription.canceled",
      occurred_at: new Date(Date.parse(occurredAt) - 60_000).toISOString(),
      data: {
        ...created.data,
        id: `sub_${"o".repeat(26)}`,
        customer_id: `ctm_${"o".repeat(26)}`,
        status: "canceled",
        custom_data: { firebase_uid: userId, plan_code: "annual" },
      },
    };
    expect((await send(olderCanceled)).status).toBe(200);
    const afterOlder = await env.CALL_RELAY_DB.prepare(
      "SELECT status, plan_code, paddle_customer_id, paddle_subscription_id FROM billing_subscriptions WHERE user_id = ?",
    ).bind(userId).first<Record<string, unknown>>();
    expect(afterOlder).toMatchObject({
      status: "active",
      plan_code: "monthly",
      paddle_customer_id: customerId,
      paddle_subscription_id: subscriptionId,
    });

    const paymentFailed = {
      event_id: `evt_${"d".repeat(26)}`,
      event_type: "transaction.payment_failed",
      occurred_at: new Date(Date.now() + 1_000).toISOString(),
      data: {
        id: `txn_${"t".repeat(26)}`,
        customer_id: customerId,
        subscription_id: subscriptionId,
        custom_data: { firebase_uid: userId },
      },
    };
    expect((await send(paymentFailed)).status).toBe(200);
    const pastDue = await env.CALL_RELAY_DB.prepare("SELECT status FROM billing_subscriptions WHERE user_id = ?")
      .bind(userId).first<{ status: string }>();
    expect(pastDue?.status).toBe("past_due");
    const suspensionPush = await env.CALL_RELAY_DB.prepare(
      "SELECT payload_json FROM push_outbox WHERE target_device_id = ? ORDER BY created_at DESC LIMIT 1",
    ).bind(androidDeviceId).first<{ payload_json: string }>();
    expect(JSON.parse(suspensionPush?.payload_json ?? "{}")).toMatchObject({ data: { type: "entitlement_changed", status: "past_due" } });
  });

  it("rejects a forged signature before parsing or storing the event", async () => {
    const eventId = `evt_${"z".repeat(26)}`;
    const response = await send({
      event_id: eventId,
      event_type: "subscription.updated",
      occurred_at: new Date().toISOString(),
      data: {},
    }, false);
    expect(response.status).toBe(401);
    const stored = await env.CALL_RELAY_DB.prepare("SELECT id FROM billing_webhook_events WHERE id = ?").bind(eventId).first();
    expect(stored).toBeNull();
  });

  it("activates a completed recurring transaction by its checkout transaction ID", async () => {
    const now = Date.now();
    const transactionId = `txn_${"r".repeat(26)}`;
    await env.CALL_RELAY_DB.prepare(
      `INSERT INTO billing_subscriptions(user_id, plan_code, status, latest_transaction_id, created_at, updated_at)
       VALUES (?, 'monthly', 'pending', ?, ?, ?)`,
    ).bind(userId, transactionId, now, now).run();
    const completed = {
      event_id: `evt_${"r".repeat(26)}`,
      event_type: "transaction.completed",
      occurred_at: new Date(now).toISOString(),
      data: {
        id: transactionId,
        customer_id: customerId,
        subscription_id: subscriptionId,
        status: "completed",
        billing_period: { ends_at: new Date(now + 30 * 86_400_000).toISOString() },
        items: [{ price: { id: "pri_01h000000000000000000000000" } }],
      },
    };
    expect((await send(completed)).status).toBe(200);
    const activated = await env.CALL_RELAY_DB.prepare(
      "SELECT status, plan_code, paddle_subscription_id FROM billing_subscriptions WHERE user_id = ?",
    ).bind(userId).first<Record<string, unknown>>();
    expect(activated).toMatchObject({ status: "active", plan_code: "monthly", paddle_subscription_id: subscriptionId });
  });

  it("does not consume an event when provisioning fails and accepts its retry", async () => {
    const conflictingUser = "paddle-customer-conflict";
    const conflictingCustomer = `ctm_${"x".repeat(26)}`;
    const eventId = `evt_${"x".repeat(26)}`;
    const now = Date.now();
    await env.CALL_RELAY_DB.prepare(
      `INSERT OR REPLACE INTO firebase_users(id, email, email_verified, created_at, updated_at, last_authenticated_at)
       VALUES (?, ?, 1, ?, ?, ?)`,
    ).bind(conflictingUser, "conflict@gmail.com", now, now, now).run();
    await env.CALL_RELAY_DB.prepare(
      `INSERT INTO billing_subscriptions(user_id, paddle_customer_id, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    ).bind(conflictingUser, conflictingCustomer, now, now).run();
    const event = {
      event_id: eventId,
      event_type: "subscription.created",
      occurred_at: new Date(now).toISOString(),
      data: {
        id: `sub_${"x".repeat(26)}`,
        customer_id: conflictingCustomer,
        status: "active",
        custom_data: { firebase_uid: userId, plan_code: "monthly" },
        current_billing_period: { ends_at: new Date(now + 30 * 86_400_000).toISOString() },
      },
    };
    expect((await send(event)).status).toBe(500);
    expect(await env.CALL_RELAY_DB.prepare("SELECT id FROM billing_webhook_events WHERE id = ?").bind(eventId).first()).toBeNull();

    await env.CALL_RELAY_DB.prepare("DELETE FROM billing_subscriptions WHERE user_id = ?").bind(conflictingUser).run();
    expect((await send(event)).status).toBe(200);
    const receipt = await env.CALL_RELAY_DB.prepare("SELECT processed_at FROM billing_webhook_events WHERE id = ?")
      .bind(eventId).first<{ processed_at: number }>();
    expect(receipt?.processed_at).toBeGreaterThan(0);
    await env.CALL_RELAY_DB.prepare("DELETE FROM firebase_users WHERE id = ?").bind(conflictingUser).run();
  });
});
