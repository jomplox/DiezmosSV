import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
let nextStripeEventCreated = Math.floor(Date.now() / 1000);

describe("Stripe signed webhooks", () => {
  let database: ReturnType<typeof migratedDatabase>;
  let workerEnv: Env;

  beforeEach(() => {
    nextStripeEventCreated = Math.floor(Date.now() / 1000);
    database = migratedDatabase();
    workerEnv = {
      ...env(new InMemoryD1()),
      DB: sqliteD1(database),
      APP_ENV: "local",
      APP_ORIGIN: origin,
      STRIPE_MOCK_MODE: "1"
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    database.close();
  });

  it("persists the actual one-time payment method when Charge arrives before Checkout", async () => {
    const checkout = await createCheckout(workerEnv, {
      requestId: "5f51f70e-9c9c-4cde-a95a-aed1a101fd89",
      amount: 50,
      frequency: "once"
    });
    const row = checkoutRow(database, checkout.sessionId);
    const charge = stripeEvent("evt_charge_apple_pay_first", "charge.succeeded", succeededCharge({
      id: "ch_apple_pay_first",
      paymentIntentId: "pi_apple_pay_first",
      amountCents: 5000,
      checkoutId: row.id,
      methodType: "card",
      walletType: "apple_pay"
    }));

    expect((await sendSignedWebhook(workerEnv, charge)).status).toBe(200);
    expect(database.prepare(
      `SELECT payment_method_type, payment_method_wallet, payment_method_charge_id
         FROM stripe_checkout_sessions WHERE id = ?`
    ).get(row.id)).toEqual({
      payment_method_type: "card",
      payment_method_wallet: "apple_pay",
      payment_method_charge_id: "ch_apple_pay_first"
    });
    expect(count(database, "stripe_gifts")).toBe(0);

    const completed = stripeEvent("evt_checkout_apple_pay_after", "checkout.session.completed", checkoutSession({
      id: checkout.sessionId,
      checkoutId: row.id,
      amountCents: 5000,
      frequency: "once",
      paymentIntentId: "pi_apple_pay_first"
    }));
    expect((await sendSignedWebhook(workerEnv, completed)).status).toBe(200);
    expect(database.prepare(
      `SELECT payment_method_type, payment_method_wallet, payment_method_charge_id
         FROM stripe_gifts WHERE source_id = 'pi_apple_pay_first'`
    ).get()).toEqual({
      payment_method_type: "card",
      payment_method_wallet: "apple_pay",
      payment_method_charge_id: "ch_apple_pay_first"
    });
    const snapshot = database.prepare(
      "SELECT snapshot_json FROM stripe_acknowledgment_deliveries"
    ).get() as { snapshot_json: string };
    expect(JSON.parse(snapshot.snapshot_json)).toMatchObject({
      pdf: { paymentMethod: "Apple Pay" }
    });
  });

  it("waits for actual method evidence when Checkout arrives before Charge", async () => {
    const checkout = await createCheckout(workerEnv, {
      requestId: "77d8426d-881f-4a9a-b5c8-9b07c7f9e84a",
      amount: 50,
      frequency: "once"
    });
    const row = checkoutRow(database, checkout.sessionId);
    const completed = stripeEvent("evt_checkout_link_first", "checkout.session.completed", checkoutSession({
      id: checkout.sessionId,
      checkoutId: row.id,
      amountCents: 5000,
      frequency: "once",
      paymentIntentId: "pi_link_after"
    }));

    expect((await sendSignedWebhook(workerEnv, completed)).status).toBe(200);
    expect(database.prepare(
      "SELECT snapshot_json FROM stripe_acknowledgment_deliveries"
    ).get()).toEqual({ snapshot_json: null });

    const charge = stripeEvent("evt_charge_link_after", "charge.succeeded", succeededCharge({
      id: "ch_link_after",
      paymentIntentId: "pi_link_after",
      amountCents: 5000,
      checkoutId: row.id,
      methodType: "link"
    }));
    expect((await sendSignedWebhook(workerEnv, charge)).status).toBe(200);
    expect(database.prepare(
      `SELECT payment_method_type, payment_method_wallet, payment_method_charge_id
         FROM stripe_gifts WHERE source_id = 'pi_link_after'`
    ).get()).toEqual({
      payment_method_type: "link",
      payment_method_wallet: null,
      payment_method_charge_id: "ch_link_after"
    });
    const snapshot = database.prepare(
      "SELECT snapshot_json FROM stripe_acknowledgment_deliveries"
    ).get() as { snapshot_json: string };
    expect(JSON.parse(snapshot.snapshot_json)).toMatchObject({
      pdf: { paymentMethod: "Link" }
    });
  });

  it("converges the actual method into a monthly gift when Charge arrives first", async () => {
    const checkout = await createCheckout(workerEnv, {
      requestId: "6221cf52-a7b8-4225-873e-7d8d27038d7b",
      amount: 25,
      frequency: "monthly"
    });
    const row = checkoutRow(database, checkout.sessionId);
    const charge = stripeEvent("evt_charge_ach_first", "charge.succeeded", succeededCharge({
      id: "ch_ach_first",
      paymentIntentId: "pi_ach_first",
      amountCents: 2500,
      methodType: "us_bank_account"
    }));
    expect((await sendSignedWebhook(workerEnv, charge)).status).toBe(200);
    expect(database.prepare(
      `SELECT stripe_payment_intent_id, payment_method_type, payment_method_charge_id
         FROM stripe_webhook_events WHERE id = 'evt_charge_ach_first'`
    ).get()).toEqual({
      stripe_payment_intent_id: "pi_ach_first",
      payment_method_type: "us_bank_account",
      payment_method_charge_id: "ch_ach_first"
    });

    expect((await sendSignedWebhook(workerEnv, stripeEvent(
      "evt_invoice_ach_after",
      "invoice.paid",
      invoice({
        id: "in_ach_first",
        checkoutId: row.id,
        subscriptionId: "sub_ach_first",
        amountCents: 2500
      })
    ))).status).toBe(200);
    expect((await sendSignedWebhook(workerEnv, stripeEvent(
      "evt_invoice_payment_ach_after",
      "invoice_payment.paid",
      invoicePaymentProof({
        id: "inpay_ach_first",
        invoiceId: "in_ach_first",
        amountCents: 2500,
        paymentIntentId: "pi_ach_first"
      })
    ))).status).toBe(200);

    expect(database.prepare(
      `SELECT payment_method_type, payment_method_wallet, payment_method_charge_id
         FROM stripe_gifts WHERE source_id = 'in_ach_first'`
    ).get()).toEqual({
      payment_method_type: "us_bank_account",
      payment_method_wallet: null,
      payment_method_charge_id: "ch_ach_first"
    });
    const snapshot = database.prepare(
      "SELECT snapshot_json FROM stripe_acknowledgment_deliveries"
    ).get() as { snapshot_json: string };
    expect(JSON.parse(snapshot.snapshot_json)).toMatchObject({
      pdf: { paymentMethod: "ACH Direct Debit" }
    });
  });

  it("adds monthly method evidence and snapshots the receipt when Charge arrives last", async () => {
    const checkout = await createCheckout(workerEnv, {
      requestId: "03964e51-c29f-4afb-a374-9cae3494fa44",
      amount: 25,
      frequency: "monthly"
    });
    const row = checkoutRow(database, checkout.sessionId);
    expect((await sendSignedWebhook(workerEnv, stripeEvent(
      "evt_invoice_before_method",
      "invoice.paid",
      invoice({
        id: "in_method_after",
        checkoutId: row.id,
        subscriptionId: "sub_method_after",
        amountCents: 2500
      })
    ))).status).toBe(200);
    expect((await sendSignedWebhook(workerEnv, stripeEvent(
      "evt_invoice_payment_before_method",
      "invoice_payment.paid",
      invoicePaymentProof({
        id: "inpay_method_after",
        invoiceId: "in_method_after",
        amountCents: 2500,
        paymentIntentId: "pi_method_after"
      })
    ))).status).toBe(200);
    expect(database.prepare(
      `SELECT payment_method_type FROM stripe_gifts WHERE source_id = 'in_method_after'`
    ).get()).toEqual({ payment_method_type: null });
    expect(database.prepare(
      "SELECT snapshot_json FROM stripe_acknowledgment_deliveries"
    ).get()).toEqual({ snapshot_json: null });

    expect((await sendSignedWebhook(workerEnv, stripeEvent(
      "evt_charge_google_pay_after",
      "charge.succeeded",
      succeededCharge({
        id: "ch_google_pay_after",
        paymentIntentId: "pi_method_after",
        amountCents: 2500,
        methodType: "card",
        walletType: "google_pay"
      })
    ))).status).toBe(200);
    expect(database.prepare(
      `SELECT payment_method_type, payment_method_wallet
         FROM stripe_gifts WHERE source_id = 'in_method_after'`
    ).get()).toEqual({ payment_method_type: "card", payment_method_wallet: "google_pay" });
    const snapshot = database.prepare(
      "SELECT snapshot_json FROM stripe_acknowledgment_deliveries"
    ).get() as { snapshot_json: string };
    expect(JSON.parse(snapshot.snapshot_json)).toMatchObject({
      pdf: { paymentMethod: "Google Pay" }
    });
  });

  it("rejects conflicting signed method evidence without overwriting the first Charge", async () => {
    const checkout = await createCheckout(workerEnv, {
      requestId: "10cecc84-d3cc-41bd-9620-e6b3be18f51a",
      amount: 50,
      frequency: "once"
    });
    const row = checkoutRow(database, checkout.sessionId);
    expect((await sendSignedWebhook(workerEnv, stripeEvent(
      "evt_charge_method_original",
      "charge.succeeded",
      succeededCharge({
        id: "ch_method_original",
        paymentIntentId: "pi_method_conflict",
        amountCents: 5000,
        checkoutId: row.id,
        methodType: "card",
        walletType: "apple_pay"
      })
    ))).status).toBe(200);

    const conflict = await sendSignedWebhook(workerEnv, stripeEvent(
      "evt_charge_method_conflict",
      "charge.succeeded",
      succeededCharge({
        id: "ch_method_conflict",
        paymentIntentId: "pi_method_conflict",
        amountCents: 5000,
        checkoutId: row.id,
        methodType: "link"
      })
    ));
    expect(conflict.status).toBe(500);
    expect(database.prepare(
      `SELECT payment_method_type, payment_method_wallet, payment_method_charge_id
         FROM stripe_checkout_sessions WHERE id = ?`
    ).get(row.id)).toEqual({
      payment_method_type: "card",
      payment_method_wallet: "apple_pay",
      payment_method_charge_id: "ch_method_original"
    });
  });

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
      donor_email: "donante@example.org",
      donor_phone: "+1 281 974 9002",
      donor_address_json: JSON.stringify({
        line1: "332 Tangle Birch Court",
        line2: null,
        city: "Montgomery",
        state: "TX",
        postalCode: "77316",
        country: "US"
      })
    });
    expect(count(database, "stripe_gifts")).toBe(1);
    expect(count(database, "stripe_acknowledgment_deliveries")).toBe(1);
    expect(database.prepare(
      "SELECT donor_phone, donor_address_json FROM stripe_gifts WHERE source_id = 'pi_once_fixture'"
    ).get()).toEqual({
      donor_phone: "+1 281 974 9002",
      donor_address_json: JSON.stringify({
        line1: "332 Tangle Birch Court",
        line2: null,
        city: "Montgomery",
        state: "TX",
        postalCode: "77316",
        country: "US"
      })
    });

    const replay = await sendSignedWebhook(workerEnv, event);
    expect(replay.status).toBe(200);
    expect(count(database, "stripe_webhook_events")).toBe(1);
    expect(count(database, "stripe_gifts")).toBe(1);
    expect(count(database, "stripe_acknowledgment_deliveries")).toBe(1);
  });

  it("rejects Checkout metadata whose gift type conflicts with the durable reservation", async () => {
    const checkout = await createCheckout(workerEnv, {
      requestId: "b7bac362-3ae3-478f-8bf9-f4ebfd1aeeb0",
      amount: 50,
      frequency: "once",
      giftType: "offering"
    });
    const row = checkoutRow(database, checkout.sessionId);
    const event = stripeEvent("evt_checkout_gift_type_conflict", "checkout.session.completed", checkoutSession({
      id: checkout.sessionId,
      checkoutId: row.id,
      amountCents: 5000,
      frequency: "once",
      paymentIntentId: "pi_gift_type_conflict",
      giftType: "tithe"
    }));
    expect((await sendSignedWebhook(workerEnv, event)).status).toBe(500);
    expect(count(database, "stripe_gifts")).toBe(0);
  });

  it("attaches a delayed signed Session after ambiguous creation retry exhaustion", async () => {
    const checkout = await createCheckout(workerEnv, {
      requestId: "e1ec5708-dddb-477d-82bd-4773e8057db2",
      amount: 50,
      frequency: "once"
    });
    const reservation = checkoutRow(database, checkout.sessionId);
    database.prepare(
      `UPDATE stripe_checkout_sessions
          SET stripe_session_id = NULL, status = 'FAILED', expires_at = NULL,
              creation_attempt_count = 3, creation_outcome_class = 'AMBIGUOUS',
              error_code = 'stripe_checkout_create_failed'
        WHERE id = ?`
    ).run(reservation.id);
    expect(database.prepare(
      `SELECT status, stripe_session_id, creation_attempt_count, creation_outcome_class
         FROM stripe_checkout_sessions WHERE id = ?`
    ).get(reservation.id)).toEqual({
      status: "FAILED",
      stripe_session_id: null,
      creation_attempt_count: 3,
      creation_outcome_class: "AMBIGUOUS"
    });
    const event = stripeEvent(
      "evt_checkout_reconciled",
      "checkout.session.completed",
      checkoutSession({
        id: checkout.sessionId,
        checkoutId: reservation.id,
        amountCents: 5000,
        frequency: "once",
        paymentIntentId: "pi_reconciled_fixture"
      })
    );

    const response = await sendSignedWebhook(workerEnv, event);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ received: true });
    expect(checkoutRow(database, checkout.sessionId)).toMatchObject({
      id: reservation.id,
      stripe_session_id: checkout.sessionId,
      status: "COMPLETE",
      payment_status: "PAID",
      stripe_payment_intent_id: "pi_reconciled_fixture"
    });
    expect(count(database, "stripe_gifts")).toBe(1);
    expect(count(database, "stripe_acknowledgment_deliveries")).toBe(1);
  });

  it("returns terminal unavailability after an attached Session receives async payment failure", async () => {
    const providerBodies: string[] = [];
    vi.stubGlobal("fetch", stripeCheckoutFetch(providerBodies));
    const providerEnv = stripeProviderEnv(workerEnv);
    const requestId = "21c7fd3f-1b0b-48f5-b65a-942c16a43333";
    const checkout = await createCheckout(providerEnv, {
      requestId,
      amount: 50,
      frequency: "once"
    });
    const reservation = checkoutRow(database, checkout.sessionId);
    const failed = stripeEvent(
      "evt_attached_async_failed",
      "checkout.session.async_payment_failed",
      checkoutSession({
        id: checkout.sessionId,
        checkoutId: reservation.id,
        amountCents: 5000,
        frequency: "once",
        paymentIntentId: "pi_attached_async_failed",
        paid: false
      }),
      false,
      2_000_000_400
    );

    expect((await sendSignedWebhook(providerEnv, failed)).status).toBe(200);
    expect(checkoutRow(database, checkout.sessionId)).toMatchObject({
      status: "FAILED",
      stripe_session_id: checkout.sessionId,
      creation_outcome_class: null,
      checkout_event_created: 2_000_000_400,
      checkout_event_id: "evt_attached_async_failed"
    });

    const retry = await requestCheckout({
      ...providerEnv,
      STRIPE_RESTRICTED_KEY: "rk_test_terminal_fixture_rotated",
      STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: "pmc_terminal_fixture_rotated"
    }, { requestId, amount: 50, frequency: "once" });
    expect(retry.response.status).toBe(409);
    expect(retry.body).toMatchObject({ error: "stripe_checkout_unavailable" });
    expect(providerBodies).toHaveLength(1);
  });

  it("returns terminal unavailability when a delayed failed Session reconciles an exhausted ambiguous row", async () => {
    const providerBodies: string[] = [];
    vi.stubGlobal("fetch", stripeCheckoutFetch(providerBodies));
    const providerEnv = stripeProviderEnv(workerEnv);
    const requestId = "f35c7b7c-7fb4-4870-bbdd-24c90fd0193c";
    const checkout = await createCheckout(providerEnv, {
      requestId,
      amount: 50,
      frequency: "once"
    });
    const reservation = checkoutRow(database, checkout.sessionId);
    database.prepare(
      `UPDATE stripe_checkout_sessions
          SET stripe_session_id = NULL, status = 'FAILED', expires_at = NULL,
              creation_attempt_count = 3, creation_outcome_class = 'AMBIGUOUS',
              error_code = 'stripe_checkout_create_failed'
        WHERE id = ?`
    ).run(reservation.id);
    const delayedFailure = stripeEvent(
      "evt_exhausted_async_failed",
      "checkout.session.async_payment_failed",
      checkoutSession({
        id: checkout.sessionId,
        checkoutId: reservation.id,
        amountCents: 5000,
        frequency: "once",
        paymentIntentId: "pi_exhausted_async_failed",
        paid: false
      }),
      false,
      2_000_000_500
    );

    expect((await sendSignedWebhook(providerEnv, delayedFailure)).status).toBe(200);
    expect(checkoutRow(database, checkout.sessionId)).toMatchObject({
      status: "FAILED",
      stripe_session_id: checkout.sessionId,
      creation_attempt_count: 3,
      creation_outcome_class: "AMBIGUOUS",
      checkout_event_created: 2_000_000_500,
      checkout_event_id: "evt_exhausted_async_failed"
    });

    const retry = await requestCheckout(providerEnv, { requestId, amount: 50, frequency: "once" });
    expect(retry.response.status).toBe(409);
    expect(retry.body).toMatchObject({ error: "stripe_checkout_unavailable" });
    expect(providerBodies).toHaveLength(1);
  });

  it("rejects a reconciled Session identity conflict", async () => {
    const checkout = await createCheckout(workerEnv, {
      requestId: "7ebfe017-ec8e-4fd0-b366-06265304183d",
      amount: 50,
      frequency: "once",
      giftType: "offering"
    });
    const reservation = checkoutRow(database, checkout.sessionId);
    database.prepare(
      `UPDATE stripe_checkout_sessions
          SET stripe_session_id = NULL, status = 'CREATING', expires_at = NULL
        WHERE id = ?`
    ).run(reservation.id);
    const event = stripeEvent(
      "evt_checkout_reconciled_conflict",
      "checkout.session.completed",
      checkoutSession({
        id: checkout.sessionId,
        checkoutId: reservation.id,
        amountCents: 5000,
        frequency: "once",
        paymentIntentId: "pi_reconciled_conflict",
        giftType: "tithe"
      })
    );

    const response = await sendSignedWebhook(workerEnv, event);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "stripe_event_processing_failed" });
    expect(database.prepare(
      `SELECT status, stripe_session_id FROM stripe_checkout_sessions WHERE id = ?`
    ).get(reservation.id)).toEqual({ status: "CREATING", stripe_session_id: null });
    expect(database.prepare(
      `SELECT status, failure_code FROM stripe_webhook_events WHERE id = ?`
    ).get("evt_checkout_reconciled_conflict")).toEqual({
      status: "FAILED",
      failure_code: "checkout_identity_mismatch"
    });
    expect(count(database, "stripe_gifts")).toBe(0);
    expect(count(database, "stripe_acknowledgment_deliveries")).toBe(0);
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
      .toEqual([]);

    const invoicePayment = stripeEvent(
      "evt_invoice_payment",
      "invoice_payment.paid",
      invoicePaymentProof({
        id: "inpay_initial_fixture",
        invoiceId: "in_initial_fixture",
        amountCents: 2500,
        paymentIntentId: "pi_monthly_fixture"
      })
    );
    expect((await sendSignedWebhook(workerEnv, invoicePayment)).status).toBe(200);
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
    expect((await sendSignedWebhook(workerEnv, stripeEvent(
      "evt_invoice_payment_renewal",
      "invoice_payment.paid",
      invoicePaymentProof({
        id: "inpay_renewal_fixture",
        invoiceId: "in_renewal_fixture",
        amountCents: 2500,
        paymentIntentId: "pi_monthly_renewal_fixture"
      })
    ))).status).toBe(200);
    expect(database.prepare("SELECT source_id FROM stripe_gifts ORDER BY source_id").all())
      .toEqual([
        { source_id: "in_initial_fixture" },
        { source_id: "in_renewal_fixture" }
      ]);
    expect(count(database, "stripe_acknowledgment_deliveries")).toBe(2);

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
      metadata: { checkout_id: row.id, lane: "eeuu_501c3", frequency: "monthly", gift_type: "tithe" }
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
    expect((await sendSignedWebhook(workerEnv, stripeEvent(
      "evt_invoice_payment_after_cancel",
      "invoice_payment.paid",
      invoicePaymentProof({
        id: "inpay_after_cancel_fixture",
        invoiceId: "in_paid_before_cancel_fixture",
        amountCents: 2500,
        paymentIntentId: "pi_after_cancel_fixture"
      })
    ))).status).toBe(200);
    expect(checkoutRow(database, checkout.sessionId).subscription_status).toBe("CANCELED");
    expect(count(database, "stripe_gifts")).toBe(3);
  });

  it("requires matching paid InvoicePayment evidence and converges in either webhook order", async () => {
    const invoiceFirstCheckout = await createCheckout(workerEnv, {
      requestId: "8a9f2baa-c8f0-48f7-8d20-b18f5bda34d0",
      amount: 25,
      frequency: "monthly"
    });
    const invoiceFirstRow = checkoutRow(database, invoiceFirstCheckout.sessionId);
    const invoiceFirst = stripeEvent("evt_invoice_proof_first", "invoice.paid", invoice({
      id: "in_proof_first",
      checkoutId: invoiceFirstRow.id,
      subscriptionId: "sub_proof_first",
      amountCents: 2500
    }));

    expect((await sendSignedWebhook(workerEnv, invoiceFirst)).status).toBe(200);
    expect((await sendSignedWebhook(workerEnv, invoiceFirst)).status).toBe(200);
    expect(database.prepare("SELECT source_id FROM stripe_gifts WHERE source_id = 'in_proof_first'").get())
      .toBeUndefined();
    expect(count(database, "stripe_acknowledgment_deliveries")).toBe(0);

    const outOfBand = stripeEvent("evt_invoice_payment_record", "invoice_payment.paid", {
      id: "inpay_payment_record",
      object: "invoice_payment",
      invoice: "in_proof_first",
      livemode: false,
      amount_paid: 2500,
      currency: "usd",
      payment: { type: "payment_record", payment_record: "pyr_external" },
      status: "paid"
    });
    expect((await sendSignedWebhook(workerEnv, outOfBand)).status).toBe(200);
    expect(database.prepare("SELECT source_id FROM stripe_gifts WHERE source_id = 'in_proof_first'").get())
      .toBeUndefined();

    const paidProof = stripeEvent("evt_invoice_payment_proof", "invoice_payment.paid", {
      id: "inpay_proof_first",
      object: "invoice_payment",
      invoice: "in_proof_first",
      livemode: false,
      amount_paid: 2500,
      currency: "usd",
      payment: { type: "payment_intent", payment_intent: "pi_proof_first" },
      status: "paid"
    });
    expect((await sendSignedWebhook(workerEnv, paidProof)).status).toBe(200);
    expect((await sendSignedWebhook(workerEnv, paidProof)).status).toBe(200);
    expect(database.prepare(
      "SELECT source_id, stripe_payment_intent_id FROM stripe_gifts WHERE source_id = 'in_proof_first'"
    ).get()).toEqual({ source_id: "in_proof_first", stripe_payment_intent_id: "pi_proof_first" });
    expect(count(database, "stripe_acknowledgment_deliveries")).toBe(1);

    const proofFirstCheckout = await createCheckout(workerEnv, {
      requestId: "6bf04041-b6c6-472d-bd03-0217946d8fb7",
      amount: 30,
      frequency: "monthly"
    });
    const proofFirstRow = checkoutRow(database, proofFirstCheckout.sessionId);
    const proofFirst = stripeEvent("evt_payment_proof_first", "invoice_payment.paid", {
      id: "inpay_proof_before_invoice",
      object: "invoice_payment",
      invoice: "in_proof_after",
      livemode: false,
      amount_paid: 3000,
      currency: "usd",
      payment: { type: "payment_intent", payment_intent: "pi_proof_after" },
      status: "paid"
    });
    expect((await sendSignedWebhook(workerEnv, proofFirst)).status).toBe(200);
    expect(database.prepare("SELECT source_id FROM stripe_gifts WHERE source_id = 'in_proof_after'").get())
      .toBeUndefined();

    const laterInvoice = stripeEvent("evt_invoice_after_proof", "invoice.paid", invoice({
      id: "in_proof_after",
      checkoutId: proofFirstRow.id,
      subscriptionId: "sub_proof_after",
      amountCents: 3000
    }));
    expect((await sendSignedWebhook(workerEnv, laterInvoice)).status).toBe(200);
    expect((await sendSignedWebhook(workerEnv, laterInvoice)).status).toBe(200);
    expect(database.prepare(
      "SELECT source_id, stripe_payment_intent_id FROM stripe_gifts WHERE source_id = 'in_proof_after'"
    ).get()).toEqual({ source_id: "in_proof_after", stripe_payment_intent_id: "pi_proof_after" });
    expect(count(database, "stripe_acknowledgment_deliveries")).toBe(2);
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

  it("keeps Checkout state monotonic for older and equal-timestamp deliveries", async () => {
    const checkout = await createCheckout(workerEnv, {
      requestId: "aeb1e80f-ef55-4681-b45b-cc60164e485a",
      amount: 40,
      frequency: "once"
    });
    const row = checkoutRow(database, checkout.sessionId);
    const failed = stripeEvent("evt_checkout_failed_newer", "checkout.session.async_payment_failed", checkoutSession({
      id: checkout.sessionId,
      checkoutId: row.id,
      amountCents: 4000,
      frequency: "once",
      paymentIntentId: "pi_ordered_fixture",
      paid: false
    }), false, 2_000_000_200);
    const olderCompleted = stripeEvent("evt_checkout_completed_older", "checkout.session.completed", checkoutSession({
      id: checkout.sessionId,
      checkoutId: row.id,
      amountCents: 4000,
      frequency: "once",
      paymentIntentId: "pi_ordered_fixture",
      paid: false
    }), false, 2_000_000_100);
    const equalCompleted = stripeEvent("evt_checkout_completed_equal", "checkout.session.completed", checkoutSession({
      id: checkout.sessionId,
      checkoutId: row.id,
      amountCents: 4000,
      frequency: "once",
      paymentIntentId: "pi_ordered_fixture",
      paid: false
    }), false, 2_000_000_200);

    expect((await sendSignedWebhook(workerEnv, failed)).status).toBe(200);
    expect((await sendSignedWebhook(workerEnv, olderCompleted)).status).toBe(200);
    expect((await sendSignedWebhook(workerEnv, equalCompleted)).status).toBe(200);
    expect(checkoutRow(database, checkout.sessionId)).toMatchObject({
      status: "FAILED",
      payment_status: "UNPAID",
      checkout_event_created: 2_000_000_200,
      checkout_event_id: "evt_checkout_failed_newer"
    });

    const publicStatus = await worker.fetch(
      new Request(`${origin}/api/donations/stripe/session/${checkout.sessionId}`),
      workerEnv
    );
    expect(publicStatus.status).toBe(200);
    await expect(publicStatus.json()).resolves.toMatchObject({ status: "FAILED" });
  });

  it("keeps monthly state monotonic while still recording a delayed settled gift", async () => {
    const checkout = await createCheckout(workerEnv, {
      requestId: "64dcfbc5-7dce-4789-90cf-a27b3f7137d8",
      amount: 30,
      frequency: "monthly"
    });
    const row = checkoutRow(database, checkout.sessionId);
    const newerFailure = stripeEvent("evt_invoice_failed_newer", "invoice.payment_failed", invoice({
      id: "in_failed_newer",
      checkoutId: row.id,
      subscriptionId: "sub_fixture",
      amountCents: 3000,
      paid: false
    }), false, 2_000_000_300);
    const olderPaid = stripeEvent("evt_invoice_paid_older", "invoice.paid", invoice({
      id: "in_paid_older",
      checkoutId: row.id,
      subscriptionId: "sub_fixture",
      amountCents: 3000
    }), false, 2_000_000_200);
    const equalPaid = stripeEvent("evt_invoice_paid_equal", "invoice.paid", invoice({
      id: "in_paid_equal",
      checkoutId: row.id,
      subscriptionId: "sub_fixture",
      amountCents: 3000
    }), false, 2_000_000_300);
    const equalFailure = stripeEvent("evt_invoice_failed_equal", "invoice.payment_failed", invoice({
      id: "in_failed_equal",
      checkoutId: row.id,
      subscriptionId: "sub_fixture",
      amountCents: 3000,
      paid: false
    }), false, 2_000_000_300);

    expect((await sendSignedWebhook(workerEnv, newerFailure)).status).toBe(200);
    expect(checkoutRow(database, checkout.sessionId)).toMatchObject({
      subscription_status: "PAST_DUE",
      subscription_event_created: 2_000_000_300
    });
    const olderCanceled = stripeEvent("evt_subscription_deleted_older", "customer.subscription.deleted", {
      id: "sub_fixture",
      object: "subscription",
      metadata: { checkout_id: row.id, lane: "eeuu_501c3", frequency: "monthly", gift_type: "tithe" }
    }, false, 2_000_000_200);
    expect((await sendSignedWebhook(workerEnv, olderCanceled)).status).toBe(200);
    expect(checkoutRow(database, checkout.sessionId)).toMatchObject({
      subscription_status: "PAST_DUE",
      subscription_event_created: 2_000_000_300,
      subscription_event_id: "evt_invoice_failed_newer"
    });
    expect((await sendSignedWebhook(workerEnv, olderPaid)).status).toBe(200);
    expect((await sendSignedWebhook(workerEnv, stripeEvent(
      "evt_invoice_payment_paid_older",
      "invoice_payment.paid",
      invoicePaymentProof({
        id: "inpay_paid_older",
        invoiceId: "in_paid_older",
        amountCents: 3000,
        paymentIntentId: "pi_paid_older"
      })
    ))).status).toBe(200);
    expect(checkoutRow(database, checkout.sessionId).subscription_status).toBe("PAST_DUE");
    expect(database.prepare("SELECT source_id FROM stripe_gifts ORDER BY source_id").all())
      .toEqual([{ source_id: "in_paid_older" }]);

    expect((await sendSignedWebhook(workerEnv, equalPaid)).status).toBe(200);
    expect((await sendSignedWebhook(workerEnv, equalFailure)).status).toBe(200);
    expect(checkoutRow(database, checkout.sessionId)).toMatchObject({
      subscription_status: "ACTIVE",
      subscription_event_created: 2_000_000_300,
      subscription_event_id: "evt_invoice_paid_equal"
    });
  });
});

async function createCheckout(
  workerEnv: Env,
  body: { requestId: string; amount: number; frequency: "once" | "monthly"; giftType?: "tithe" | "offering" }
): Promise<{ sessionId: string }> {
  const { response, body: responseBody } = await requestCheckout(workerEnv, body);
  expect(response.status).toBe(201);
  return responseBody as { sessionId: string };
}

async function requestCheckout(
  workerEnv: Env,
  body: { requestId: string; amount: number; frequency: "once" | "monthly"; giftType?: "tithe" | "offering" }
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await worker.fetch(new Request(`${origin}/api/donations/stripe/checkout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: origin,
      "CF-Connecting-IP": "203.0.113.50"
    },
    body: JSON.stringify({ giftType: "tithe", ...body })
  }), workerEnv);
  return { response, body: await response.json() as Record<string, unknown> };
}

async function sendSignedWebhook(workerEnv: Env, body: string): Promise<Response> {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: workerEnv.STRIPE_MOCK_MODE === "1"
      ? webhookSecret
      : String(workerEnv.STRIPE_WEBHOOK_SECRET),
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

function stripeProviderEnv(workerEnv: Env): Env {
  return {
    ...workerEnv,
    STRIPE_MOCK_MODE: undefined,
    STRIPE_RESTRICTED_KEY: "rk_test_terminal_fixture",
    STRIPE_PUBLISHABLE_KEY: "pk_test_terminal_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_terminal_fixture",
    STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: "pmc_terminal_fixture",
    STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_terminal_fixture",
    STRIPE_US_LEGAL_NAME: "Example Nonprofit",
    STRIPE_US_EIN: "12-3456789",
    STRIPE_US_PHONE: "+1 555 010 0100",
    STRIPE_US_WEBSITE: "https://example.org",
    STRIPE_US_MAILING_ADDRESS: "100 Test Avenue\nNew York, NY 10001, USA",
    STRIPE_US_SIGNER_NAME: "Test Signer",
    STRIPE_US_SIGNER_TITLE: "Treasurer",
    STRIPE_API_PROXY_URL: "http://127.0.0.1:8791"
  };
}

function stripeCheckoutFetch(providerBodies: string[]): typeof fetch {
  return vi.fn<typeof fetch>(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/v1/checkout/sessions") {
      throw new Error(`Unexpected Stripe request: ${request.method} ${url.pathname}`);
    }
    const body = await request.text();
    providerBodies.push(body);
    const params = new URLSearchParams(body);
    const checkoutId = String(params.get("client_reference_id"));
    const sessionId = `cs_test_${checkoutId}`;
    return new Response(JSON.stringify({
      id: sessionId,
      object: "checkout.session",
      client_reference_id: checkoutId,
      client_secret: `${sessionId}_secret_fixture`,
      url: null,
      created: 1_700_000_000,
      livemode: false,
      status: "open",
      payment_status: "unpaid",
      mode: params.get("mode"),
      amount_total: Number(params.get("line_items[0][price_data][unit_amount]")),
      currency: "usd",
      customer: null,
      subscription: null,
      payment_intent: null,
      customer_details: null,
      customer_email: null,
      metadata: {
        checkout_id: params.get("metadata[checkout_id]"),
        frequency: params.get("metadata[frequency]"),
        lane: params.get("metadata[lane]"),
        gift_type: params.get("metadata[gift_type]")
      },
      expires_at: 1_786_370_400
    }), {
      headers: { "Content-Type": "application/json", "Request-Id": "req_terminal_fixture" }
    });
  });
}

function stripeEvent(
  id: string,
  type: string,
  object: Record<string, unknown>,
  livemode = false,
  created = nextStripeEventCreated++
): string {
  return JSON.stringify({
    id,
    object: "event",
    api_version: STRIPE_API_VERSION,
    created,
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
  giftType?: "tithe" | "offering";
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
      name: "Donante Ejemplo",
      phone: "+1 281 974 9002",
      address: {
        line1: "332 Tangle Birch Court",
        line2: null,
        city: "Montgomery",
        state: "TX",
        postal_code: "77316",
        country: "US"
      }
    },
    metadata: {
      checkout_id: input.checkoutId,
      frequency: input.frequency,
      gift_type: input.giftType ?? "tithe",
      lane: "eeuu_501c3"
    },
    expires_at: 1_786_370_400
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
          gift_type: "tithe",
          lane: "eeuu_501c3"
        }
      }
    },
    status_transitions: {
      paid_at: paid ? Math.floor(Date.now() / 1000) : null
    }
  };
}

function invoicePaymentProof(input: {
  id: string;
  invoiceId: string;
  amountCents: number;
  paymentIntentId: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: "invoice_payment",
    invoice: input.invoiceId,
    livemode: false,
    amount_paid: input.amountCents,
    currency: "usd",
    payment: {
      type: "payment_intent",
      payment_intent: input.paymentIntentId
    },
    status: "paid"
  };
}

function succeededCharge(input: {
  id: string;
  paymentIntentId: string;
  amountCents: number;
  checkoutId?: string;
  methodType: string;
  walletType?: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    object: "charge",
    livemode: false,
    paid: true,
    status: "succeeded",
    amount: input.amountCents,
    currency: "usd",
    payment_intent: input.paymentIntentId,
    metadata: input.checkoutId
      ? {
          checkout_id: input.checkoutId,
          frequency: "once",
          gift_type: "tithe",
          lane: "eeuu_501c3"
        }
      : {},
    payment_method_details: {
      type: input.methodType,
      ...(input.methodType === "card"
        ? { card: { wallet: input.walletType ? { type: input.walletType } : null } }
        : {})
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
