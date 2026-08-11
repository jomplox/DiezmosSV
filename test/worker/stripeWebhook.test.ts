import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { STRIPE_API_VERSION } from "../../src/worker/services/stripeDonations";
import type { Env } from "../../src/worker/types";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { migratedDatabase } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

const origin = "https://example.org";
const webhookSecret = "whsec_mock";

describe("Stripe signed webhooks", () => {
  let database: ReturnType<typeof migratedDatabase>;
  let workerEnv: Env;

  beforeEach(() => {
    database = migratedDatabase();
    workerEnv = {
      ...env(new InMemoryD1()),
      DB: sqliteD1(database),
      APP_ENV: "local",
      APP_ORIGIN: origin,
      STRIPE_MOCK_MODE: "1"
    };
  });

  afterEach(() => database.close());

  it("rejects forged and wrong-environment events, then idempotently settles one one-time gift", async () => {
    const checkout = await createCheckout(workerEnv, {
      requestId: "0c2e2165-edb7-4e4b-bc50-95a7fa3cdfe5",
      amount: 50,
      frequency: "once"
    });
    const row = checkoutRow(database, checkout.sessionId);
    const event = stripeEvent("evt_checkout_once", "checkout.session.completed", checkoutSession({
      id: checkout.sessionId,
      checkoutId: row.id,
      amountCents: 5000,
      frequency: "once",
      paymentIntentId: "pi_once_fixture"
    }));

    const forged = await worker.fetch(new Request(`${origin}/webhooks/stripe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Stripe-Signature": "t=1,v1=forged"
      },
      body: event
    }), workerEnv);
    expect(forged.status).toBe(400);
    expect(count(database, "stripe_webhook_events")).toBe(0);

    const wrongEnvironmentBody = stripeEvent(
      "evt_wrong_environment",
      "checkout.session.completed",
      { ...JSON.parse(event).data.object, livemode: true },
      true
    );
    const wrongEnvironment = await sendSignedWebhook(workerEnv, wrongEnvironmentBody);
    expect(wrongEnvironment.status).toBe(400);
    expect(count(database, "stripe_webhook_events")).toBe(0);

    const settled = await sendSignedWebhook(workerEnv, event);
    expect(settled.status).toBe(200);
    await expect(settled.json()).resolves.toEqual({ received: true });
    expect(checkoutRow(database, checkout.sessionId)).toMatchObject({
      status: "COMPLETE",
      payment_status: "PAID",
      stripe_payment_intent_id: "pi_once_fixture",
      stripe_customer_id: "cus_fixture",
      donor_email: "donante@example.org"
    });
    expect(count(database, "stripe_gifts")).toBe(1);
    expect(count(database, "stripe_acknowledgment_deliveries")).toBe(1);

    const replay = await sendSignedWebhook(workerEnv, event);
    expect(replay.status).toBe(200);
    expect(count(database, "stripe_webhook_events")).toBe(1);
    expect(count(database, "stripe_gifts")).toBe(1);
    expect(count(database, "stripe_acknowledgment_deliveries")).toBe(1);
  });

  it("settles every monthly invoice once even when invoice delivery precedes Checkout completion", async () => {
    const checkout = await createCheckout(workerEnv, {
      requestId: "993b9407-9e16-4915-90ec-7f95855b8fab",
      amount: 25,
      frequency: "monthly"
    });
    const row = checkoutRow(database, checkout.sessionId);
    const initialInvoice = stripeEvent("evt_invoice_initial", "invoice.paid", invoice({
      id: "in_initial_fixture",
      checkoutId: row.id,
      subscriptionId: "sub_fixture",
      amountCents: 2500
    }));

    expect((await sendSignedWebhook(workerEnv, initialInvoice)).status).toBe(200);
    expect(checkoutRow(database, checkout.sessionId)).toMatchObject({
      status: "COMPLETE",
      payment_status: "PAID",
      stripe_customer_id: "cus_fixture",
      stripe_subscription_id: "sub_fixture",
      subscription_status: "ACTIVE"
    });
    expect(database.prepare("SELECT source_id FROM stripe_gifts ORDER BY source_id").all())
      .toEqual([{ source_id: "in_initial_fixture" }]);

    expect((await sendSignedWebhook(workerEnv, initialInvoice)).status).toBe(200);
    const renewal = stripeEvent("evt_invoice_renewal", "invoice.paid", invoice({
      id: "in_renewal_fixture",
      checkoutId: row.id,
      subscriptionId: "sub_fixture",
      amountCents: 2500
    }));
    expect((await sendSignedWebhook(workerEnv, renewal)).status).toBe(200);
    expect(database.prepare("SELECT source_id FROM stripe_gifts ORDER BY source_id").all())
      .toEqual([
        { source_id: "in_initial_fixture" },
        { source_id: "in_renewal_fixture" }
      ]);
    expect(count(database, "stripe_acknowledgment_deliveries")).toBe(2);

    const invoicePayment = stripeEvent("evt_invoice_payment", "invoice_payment.paid", {
      id: "inpay_initial_fixture",
      object: "invoice_payment",
      invoice: "in_initial_fixture",
      livemode: false,
      amount_paid: 2500,
      currency: "usd",
      payment: {
        type: "payment_intent",
        payment_intent: "pi_monthly_fixture"
      },
      status: "paid"
    });
    expect((await sendSignedWebhook(workerEnv, invoicePayment)).status).toBe(200);
    expect(database.prepare(
      "SELECT stripe_payment_intent_id FROM stripe_gifts WHERE source_id = 'in_initial_fixture'"
    ).get()).toEqual({ stripe_payment_intent_id: "pi_monthly_fixture" });
    const monthlyRefund = stripeEvent("evt_monthly_refund", "charge.refunded", {
      id: "ch_monthly_fixture",
      object: "charge",
      livemode: false,
      payment_intent: "pi_monthly_fixture",
      amount: 2500,
      amount_refunded: 1000,
      refunded: false
    });
    expect((await sendSignedWebhook(workerEnv, monthlyRefund)).status).toBe(200);
    expect(database.prepare(
      "SELECT status, refunded_amount_cents FROM stripe_gifts WHERE source_id = 'in_initial_fixture'"
    ).get()).toEqual({ status: "PARTIALLY_REFUNDED", refunded_amount_cents: 1000 });

    const failed = stripeEvent("evt_invoice_failed", "invoice.payment_failed", invoice({
      id: "in_failed_fixture",
      checkoutId: row.id,
      subscriptionId: "sub_fixture",
      amountCents: 2500,
      paid: false
    }));
    expect((await sendSignedWebhook(workerEnv, failed)).status).toBe(200);
    expect(checkoutRow(database, checkout.sessionId).subscription_status).toBe("PAST_DUE");
    expect(count(database, "stripe_gifts")).toBe(2);

    const canceled = stripeEvent("evt_subscription_deleted", "customer.subscription.deleted", {
      id: "sub_fixture",
      object: "subscription",
      metadata: { checkout_id: row.id, lane: "eeuu_501c3", frequency: "monthly" }
    });
    expect((await sendSignedWebhook(workerEnv, canceled)).status).toBe(200);
    expect(checkoutRow(database, checkout.sessionId).subscription_status).toBe("CANCELED");

    const delayedPaidInvoice = stripeEvent("evt_invoice_paid_after_cancel", "invoice.paid", invoice({
      id: "in_paid_before_cancel_fixture",
      checkoutId: row.id,
      subscriptionId: "sub_fixture",
      amountCents: 2500
    }));
    expect((await sendSignedWebhook(workerEnv, delayedPaidInvoice)).status).toBe(200);
    expect(checkoutRow(database, checkout.sessionId).subscription_status).toBe("CANCELED");
    expect(count(database, "stripe_gifts")).toBe(3);
  });

  it("handles asynchronous settlement, expiration, and refunds without duplicate gifts", async () => {
    const checkout = await createCheckout(workerEnv, {
      requestId: "7315264c-056a-442d-9367-965ce669208f",
      amount: 100,
      frequency: "once"
    });
    const row = checkoutRow(database, checkout.sessionId);
    const asyncSucceeded = stripeEvent(
      "evt_async_succeeded",
      "checkout.session.async_payment_succeeded",
      checkoutSession({
        id: checkout.sessionId,
        checkoutId: row.id,
        amountCents: 10000,
        frequency: "once",
        paymentIntentId: "pi_async_fixture"
      })
    );
    expect((await sendSignedWebhook(workerEnv, asyncSucceeded)).status).toBe(200);
    expect(count(database, "stripe_gifts")).toBe(1);

    const delayedAsyncFailure = stripeEvent(
      "evt_async_failed_late",
      "checkout.session.async_payment_failed",
      checkoutSession({
        id: checkout.sessionId,
        checkoutId: row.id,
        amountCents: 10000,
        frequency: "once",
        paymentIntentId: "pi_async_fixture",
        paid: false
      })
    );
    expect((await sendSignedWebhook(workerEnv, delayedAsyncFailure)).status).toBe(200);
    expect(checkoutRow(database, checkout.sessionId)).toMatchObject({
      status: "COMPLETE",
      payment_status: "PAID"
    });
    expect(count(database, "stripe_gifts")).toBe(1);

    const refunded = stripeEvent("evt_refunded", "charge.refunded", {
      id: "ch_fixture",
      object: "charge",
      livemode: false,
      payment_intent: "pi_async_fixture",
      amount: 10000,
      amount_refunded: 10000,
      refunded: true
    });
    expect((await sendSignedWebhook(workerEnv, refunded)).status).toBe(200);
    expect(database.prepare(
      "SELECT status, refunded_amount_cents FROM stripe_gifts WHERE source_id = 'pi_async_fixture'"
    ).get()).toEqual({ status: "REFUNDED", refunded_amount_cents: 10000 });

    const delayedPartialRefund = stripeEvent("evt_partial_refund_late", "charge.refunded", {
      id: "ch_fixture",
      object: "charge",
      livemode: false,
      payment_intent: "pi_async_fixture",
      amount: 10000,
      amount_refunded: 1000,
      refunded: false
    });
    expect((await sendSignedWebhook(workerEnv, delayedPartialRefund)).status).toBe(200);
    expect(database.prepare(
      "SELECT status, refunded_amount_cents FROM stripe_gifts WHERE source_id = 'pi_async_fixture'"
    ).get()).toEqual({ status: "REFUNDED", refunded_amount_cents: 10000 });

    const expiringCheckout = await createCheckout(workerEnv, {
      requestId: "b7bac362-3ae3-478f-8bf9-f4ebfd1aeeb0",
      amount: 10,
      frequency: "once"
    });
    const expiringRow = checkoutRow(database, expiringCheckout.sessionId);
    const expired = stripeEvent("evt_expired", "checkout.session.expired", checkoutSession({
      id: expiringCheckout.sessionId,
      checkoutId: expiringRow.id,
      amountCents: 1000,
      frequency: "once",
      paymentIntentId: null,
      paid: false,
      status: "expired"
    }));
    expect((await sendSignedWebhook(workerEnv, expired)).status).toBe(200);
    expect(checkoutRow(database, expiringCheckout.sessionId).status).toBe("EXPIRED");
  });
});

async function createCheckout(
  workerEnv: Env,
  body: { requestId: string; amount: number; frequency: "once" | "monthly" }
): Promise<{ sessionId: string }> {
  const response = await worker.fetch(new Request(`${origin}/api/donations/stripe/checkout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.50"
    },
    body: JSON.stringify(body)
  }), workerEnv);
  expect(response.status).toBe(201);
  return await response.json() as { sessionId: string };
}

async function sendSignedWebhook(workerEnv: Env, body: string): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: webhookSecret,
    timestamp
  });
  return worker.fetch(new Request(`${origin}/webhooks/stripe`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Stripe-Signature": signature
    },
    body
  }), workerEnv);
}

function stripeEvent(
  id: string,
  type: string,
  object: Record<string, unknown>,
  livemode = false
): string {
  return JSON.stringify({
    id,
    object: "event",
    api_version: STRIPE_API_VERSION,
    created: Math.floor(Date.now() / 1000),
    data: { object },
    livemode,
    pending_webhooks: 1,
    request: null,
    type
  });
}

function checkoutSession(input: {
  id: string;
  checkoutId: string;
  amountCents: number;
  frequency: "once" | "monthly";
  paymentIntentId: string | null;
  paid?: boolean;
  status?: "complete" | "expired";
}): Record<string, unknown> {
  const paid = input.paid ?? true;
  return {
    id: input.id,
    object: "checkout.session",
    livemode: false,
    status: input.status ?? "complete",
    payment_status: paid ? "paid" : "unpaid",
    mode: input.frequency === "monthly" ? "subscription" : "payment",
    amount_total: input.amountCents,
    currency: "usd",
    client_reference_id: input.checkoutId,
    customer: "cus_fixture",
    subscription: input.frequency === "monthly" ? "sub_fixture" : null,
    payment_intent: input.paymentIntentId,
    customer_details: {
      email: "donante@example.org",
      name: "Donante Ejemplo"
    },
    metadata: {
      checkout_id: input.checkoutId,
      frequency: input.frequency,
      lane: "eeuu_501c3"
    }
  };
}

function invoice(input: {
  id: string;
  checkoutId: string;
  subscriptionId: string;
  amountCents: number;
  paid?: boolean;
}): Record<string, unknown> {
  const paid = input.paid ?? true;
  return {
    id: input.id,
    object: "invoice",
    livemode: false,
    amount_paid: paid ? input.amountCents : 0,
    amount_due: input.amountCents,
    currency: "usd",
    customer: "cus_fixture",
    customer_email: "donante@example.org",
    customer_name: "Donante Ejemplo",
    parent: {
      type: "subscription_details",
      subscription_details: {
        subscription: input.subscriptionId,
        metadata: {
          checkout_id: input.checkoutId,
          frequency: "monthly",
          lane: "eeuu_501c3"
        }
      }
    },
    status_transitions: {
      paid_at: paid ? Math.floor(Date.now() / 1000) : null
    }
  };
}

function checkoutRow(
  database: ReturnType<typeof migratedDatabase>,
  sessionId: string
): Record<string, any> {
  const row = database.prepare(
    "SELECT * FROM stripe_checkout_sessions WHERE stripe_session_id = ?"
  ).get(sessionId);
  expect(row).toBeTruthy();
  return row as Record<string, any>;
}

function count(database: ReturnType<typeof migratedDatabase>, table: string): number {
  const allowed = new Set([
    "stripe_webhook_events",
    "stripe_gifts",
    "stripe_acknowledgment_deliveries"
  ]);
  if (!allowed.has(table)) throw new Error("Unexpected test table");
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}
