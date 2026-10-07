import Stripe from "stripe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { snapshotStripeAcknowledgmentEvidence } from "../../src/worker/services/stripeAcknowledgment";
import type {
  StripeLegacyInvoiceSnapshot,
  StripeLegacySubscriptionSnapshot
} from "../../src/worker/services/stripeClient";
import { STRIPE_API_VERSION } from "../../src/worker/services/stripeDonations";
import {
  adoptLegacyStripeSubscription,
  StripeLegacyAdoptionError,
  type LegacyAdoptionGateway
} from "../../src/worker/services/stripeLegacyAdoption";
import { Repository } from "../../src/worker/storage/repository";
import type { Env } from "../../src/worker/types";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { migratedDatabase } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

const origin = "https://example.org";
const backfillFromIso = "2026-01-01T05:00:00.000Z";
const now = "2026-10-07T18:00:00.000Z";

describe("legacy Stripe subscription adoption", () => {
  let database: ReturnType<typeof migratedDatabase>;
  let repo: Repository;
  let workerEnv: Env;

  beforeEach(() => {
    database = migratedDatabase();
    const db = sqliteD1(database);
    repo = new Repository(db);
    workerEnv = {
      ...env(new InMemoryD1()),
      DB: db,
      APP_ENV: "local",
      APP_ORIGIN: origin,
      STRIPE_MOCK_MODE: "1"
    };
  });

  afterEach(() => database.close());

  it("adopts a legacy subscription, silently records its invoices, and labels it last", async () => {
    stagePendingInvoicePayment(database, {
      invoiceId: "in_legacy_february",
      paymentIntentId: "pi_legacy_february"
    });
    const gateway = fakeGateway(subscription(), [
      paidInvoice("in_legacy_january", "pi_legacy_january", "2026-01-13T12:00:00.000Z"),
      paidInvoice("in_legacy_february", "pi_legacy_february", "2026-02-13T12:00:00.000Z"),
      paidInvoice("in_legacy_december", "pi_legacy_december", "2025-12-13T12:00:00.000Z")
    ]);
    gateway.onUpdate = () => {
      // Stripe is labelled only after every durable write has landed.
      expect(count(database, "stripe_checkout_sessions")).toBe(1);
      expect(count(database, "stripe_gifts")).toBe(2);
    };

    const result = await adoptLegacyStripeSubscription({
      repo, gateway, subscriptionId: "sub_legacy_fixture", livemode: false, backfillFromIso, dryRun: false, now
    });

    expect(result).toEqual({
      dryRun: false,
      subscriptionId: "sub_legacy_fixture",
      checkoutId: "stripe_checkout_legacy_sub_legacy_fixture",
      giftType: "TITHE",
      amountCents: 10000,
      invoices: { eligible: 2, recorded: 2, alreadyRecorded: 0 },
      backfilledCents: 20000
    });
    expect(database.prepare(
      `SELECT frequency, gift_type, amount_cents, livemode, status, payment_status,
              stripe_customer_id, stripe_subscription_id, subscription_status,
              donor_name, donor_email, adopted_at
         FROM stripe_checkout_sessions`
    ).get()).toEqual({
      frequency: "MONTHLY",
      gift_type: "TITHE",
      amount_cents: 10000,
      livemode: 0,
      status: "COMPLETE",
      payment_status: "PAID",
      stripe_customer_id: "cus_legacy_fixture",
      stripe_subscription_id: "sub_legacy_fixture",
      subscription_status: "ACTIVE",
      donor_name: "Donante Heredado",
      donor_email: "heredado@example.org",
      adopted_at: now
    });
    expect(database.prepare(
      `SELECT source_id, stripe_payment_intent_id, payment_method_type, payment_method_charge_id,
              settled_at, acknowledgment_suppressed
         FROM stripe_gifts ORDER BY settled_at`
    ).all()).toEqual([
      {
        source_id: "in_legacy_january",
        stripe_payment_intent_id: "pi_legacy_january",
        payment_method_type: "legacy_stripe",
        payment_method_charge_id: null,
        settled_at: "2026-01-13T12:00:00.000Z",
        acknowledgment_suppressed: 1
      },
      {
        source_id: "in_legacy_february",
        stripe_payment_intent_id: "pi_legacy_february",
        payment_method_type: "card",
        payment_method_charge_id: "ch_legacy_february",
        settled_at: "2026-02-13T12:00:00.000Z",
        acknowledgment_suppressed: 1
      }
    ]);
    expect(count(database, "stripe_acknowledgment_deliveries")).toBe(0);
    expect(database.prepare(
      "SELECT status, checkout_id FROM stripe_invoice_settlements WHERE invoice_id = 'in_legacy_february'"
    ).get()).toEqual({ status: "RECORDED", checkout_id: "stripe_checkout_legacy_sub_legacy_fixture" });
    expect(gateway.updates).toEqual([{
      id: "sub_legacy_fixture",
      metadata: {
        checkout_id: "stripe_checkout_legacy_sub_legacy_fixture",
        frequency: "monthly",
        gift_type: "tithe",
        lane: "eeuu_501c3"
      }
    }]);

    gateway.subscription = { ...gateway.subscription, metadata: gateway.updates[0].metadata };
    expect(await adoptLegacyStripeSubscription({
      repo, gateway, subscriptionId: "sub_legacy_fixture", livemode: false, backfillFromIso, dryRun: false, now
    })).toMatchObject({ invoices: { eligible: 2, recorded: 0, alreadyRecorded: 2 } });
    expect(count(database, "stripe_gifts")).toBe(2);
    expect(count(database, "stripe_checkout_sessions")).toBe(1);
  });

  it("maps designated legacy funds to ofrenda", async () => {
    const gateway = fakeGateway(subscription({ productName: "Medios (TPC) - 30.00 (USD)" }), []);
    expect(await adoptLegacyStripeSubscription({
      repo, gateway, subscriptionId: "sub_legacy_fixture", livemode: false, backfillFromIso, dryRun: false, now
    })).toMatchObject({ giftType: "OFFERING" });
    expect(gateway.updates[0].metadata.gift_type).toBe("offering");
  });

  it("previews an adoption without writing anything", async () => {
    const gateway = fakeGateway(subscription(), [
      paidInvoice("in_legacy_january", "pi_legacy_january", "2026-01-13T12:00:00.000Z")
    ]);
    expect(await adoptLegacyStripeSubscription({
      repo, gateway, subscriptionId: "sub_legacy_fixture", livemode: false, backfillFromIso, dryRun: true, now
    })).toMatchObject({
      dryRun: true,
      invoices: { eligible: 1, recorded: 0, alreadyRecorded: 0 },
      backfilledCents: 10000
    });
    expect(count(database, "stripe_checkout_sessions")).toBe(0);
    expect(count(database, "stripe_gifts")).toBe(0);
    expect(gateway.updates).toEqual([]);
  });

  it.each([
    ["subscription_mode_mismatch", { livemode: true }],
    ["subscription_not_active", { status: "canceled" }],
    ["subscription_shape_unsupported", { interval: "year" }],
    ["subscription_shape_unsupported", { currency: "eur" }],
    ["subscription_customer_missing", { customerId: null }],
    ["subscription_already_in_lane", {
      metadata: { lane: "eeuu_501c3", checkout_id: "stripe_checkout_someone_else" }
    }]
  ] as const)("refuses %s", async (code, overrides) => {
    const gateway = fakeGateway(subscription(overrides), []);
    await expect(adoptLegacyStripeSubscription({
      repo, gateway, subscriptionId: "sub_legacy_fixture", livemode: false, backfillFromIso, dryRun: false, now
    })).rejects.toEqual(new StripeLegacyAdoptionError(code));
    expect(count(database, "stripe_checkout_sessions")).toBe(0);
    expect(gateway.updates).toEqual([]);
  });

  it("refuses an invoice that was not settled by exactly one PaymentIntent", async () => {
    const invoice = paidInvoice("in_legacy_split", "pi_legacy_split", "2026-03-13T12:00:00.000Z");
    const gateway = fakeGateway(subscription(), [{
      ...invoice,
      payments: [...invoice.payments, { ...invoice.payments[0], paymentIntentId: "pi_other" }]
    }]);
    await expect(adoptLegacyStripeSubscription({
      repo, gateway, subscriptionId: "sub_legacy_fixture", livemode: false, backfillFromIso, dryRun: false, now
    })).rejects.toEqual(new StripeLegacyAdoptionError("invoice_shape_unsupported"));
    expect(count(database, "stripe_checkout_sessions")).toBe(0);
  });

  it("never acknowledges a silently recorded gift, even after a refund", async () => {
    const gateway = fakeGateway(subscription(), [
      paidInvoice("in_legacy_january", "pi_legacy_january", "2026-01-13T12:00:00.000Z")
    ]);
    await adoptLegacyStripeSubscription({
      repo, gateway, subscriptionId: "sub_legacy_fixture", livemode: false, backfillFromIso, dryRun: false, now
    });

    expect(await repo.applyStripeRefund({
      stripePaymentIntentId: "pi_legacy_january",
      refundedAmountCents: 10000,
      now
    })).toMatchObject({ status: "REFUNDED" });
    expect(count(database, "stripe_acknowledgment_deliveries")).toBe(0);
    expect(() => database.prepare(
      `INSERT INTO stripe_acknowledgment_deliveries (
         id, gift_id, revision, kind, evidence_refunded_amount_cents, status,
         attempt_count, created_at, updated_at
       ) SELECT 'stripe_ack_forced', id, 1, 'ORIGINAL', 0, 'PENDING', 0, ?, ? FROM stripe_gifts`
    ).run(now, now)).toThrow(/stripe_acknowledgment_suppressed/);
  });

  it("records the next renewal and introduces the new site in its first acknowledgment only", async () => {
    const gateway = fakeGateway(subscription(), []);
    await adoptLegacyStripeSubscription({
      repo, gateway, subscriptionId: "sub_legacy_fixture", livemode: false, backfillFromIso, dryRun: false, now
    });
    const checkoutId = "stripe_checkout_legacy_sub_legacy_fixture";

    for (const [index, month] of ["10", "11"].entries()) {
      const invoiceId = `in_renewal_${month}`;
      const paid = stripeEvent(`evt_renewal_paid_${month}`, "invoice.paid", {
        id: invoiceId,
        object: "invoice",
        livemode: false,
        amount_paid: 10000,
        currency: "usd",
        customer: "cus_legacy_fixture",
        customer_email: "heredado@example.org",
        customer_name: "Donante Heredado",
        parent: {
          type: "subscription_details",
          subscription_details: { subscription: "sub_legacy_fixture", metadata: gateway.updates[0].metadata }
        },
        status_transitions: { paid_at: 1_791_400_000 + index * 2_600_000 }
      });
      const payment = stripeEvent(`evt_renewal_payment_${month}`, "invoice_payment.paid", {
        id: `inpay_renewal_${month}`,
        object: "invoice_payment",
        invoice: invoiceId,
        amount_paid: 10000,
        currency: "usd",
        status: "paid",
        payment: { type: "payment_intent", payment_intent: `pi_renewal_${month}` }
      });
      expect((await sendSignedWebhook(workerEnv, paid)).status).toBe(200);
      expect((await sendSignedWebhook(workerEnv, payment)).status).toBe(200);
    }

    const deliveries = database.prepare(
      `SELECT delivery.id FROM stripe_acknowledgment_deliveries AS delivery
         JOIN stripe_gifts AS gift ON gift.id = delivery.gift_id
        WHERE gift.checkout_id = ? ORDER BY gift.settled_at`
    ).all(checkoutId) as Array<{ id: string }>;
    expect(deliveries).toHaveLength(2);

    const first = await snapshotStripeAcknowledgmentEvidence(workerEnv, repo, deliveries[0].id, now);
    const second = await snapshotStripeAcknowledgmentEvidence(workerEnv, repo, deliveries[1].id, now);
    const introduction = "Gracias por su fidelidad. Su diezmo mensual ahora se registra en nuestro " +
      "nuevo sitio de donaciones, example.org/donar. No necesita hacer nada: su aportación " +
      "continúa igual, y a partir de ahora recibirá este comprobante con cada entrega.";
    expect(first.content.text).toContain(introduction);
    expect(first.content.text.indexOf(introduction)).toBeGreaterThan(first.content.text.indexOf("Estimado(a)"));
    expect(first.content.html).toContain("example.org/donar");
    expect(second.content.text).not.toContain("Gracias por su fidelidad");
    expect((await snapshotStripeAcknowledgmentEvidence(workerEnv, repo, deliveries[0].id, now)).content.text)
      .toContain(introduction);
  });
});

interface FakeGateway extends LegacyAdoptionGateway {
  subscription: StripeLegacySubscriptionSnapshot;
  updates: Array<{ id: string; metadata: Record<string, string> }>;
  onUpdate?: () => void;
}

function fakeGateway(
  initial: StripeLegacySubscriptionSnapshot,
  invoices: StripeLegacyInvoiceSnapshot[]
): FakeGateway {
  const gateway: FakeGateway = {
    subscription: initial,
    updates: [],
    async retrieveLegacySubscription(id) {
      expect(id).toBe("sub_legacy_fixture");
      return gateway.subscription;
    },
    async listPaidSubscriptionInvoices(subscriptionId, paidFromSeconds) {
      expect(subscriptionId).toBe("sub_legacy_fixture");
      return invoices.filter((invoice) => (invoice.paidAt ?? 0) >= paidFromSeconds);
    },
    async updateSubscriptionMetadata(id, metadata) {
      gateway.onUpdate?.();
      gateway.updates.push({ id, metadata });
    }
  };
  return gateway;
}

function subscription(overrides: {
  livemode?: boolean;
  status?: string;
  interval?: string;
  currency?: string;
  customerId?: string | null;
  productName?: string;
  metadata?: Record<string, string>;
} = {}): StripeLegacySubscriptionSnapshot {
  return {
    id: "sub_legacy_fixture",
    livemode: overrides.livemode ?? false,
    status: overrides.status ?? "active",
    customerId: overrides.customerId === undefined ? "cus_legacy_fixture" : overrides.customerId,
    donorName: "Donante Heredado",
    donorEmail: "heredado@example.org",
    metadata: overrides.metadata ?? { "Donation Post ID": "123", Email: "heredado@example.org" },
    items: [{
      amountCents: 10000,
      currency: overrides.currency ?? "usd",
      interval: overrides.interval ?? "month",
      intervalCount: 1,
      productName: overrides.productName ?? "Diezmo (TPC) - 100.00"
    }]
  };
}

function paidInvoice(id: string, paymentIntentId: string, paidAtIso: string): StripeLegacyInvoiceSnapshot {
  return {
    id,
    livemode: false,
    amountPaid: 10000,
    currency: "usd",
    paidAt: Date.parse(paidAtIso) / 1000,
    payments: [{ type: "payment_intent", paymentIntentId, status: "paid", amountPaid: 10000 }]
  };
}

// Mirrors the orphan rows production holds: the payment half of a legacy invoice,
// recorded before its invoice half was ever accepted.
function stagePendingInvoicePayment(
  database: ReturnType<typeof migratedDatabase>,
  input: { invoiceId: string; paymentIntentId: string }
): void {
  database.prepare(
    `INSERT INTO stripe_invoice_settlements (
       invoice_id, invoice_payment_id, payment_intent_id, payment_amount_cents,
       payment_currency, payment_livemode, payment_event_id,
       payment_method_type, payment_method_charge_id, payment_method_event_id,
       payment_method_payment_intent_id, payment_method_amount_cents, payment_method_livemode,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, 10000, 'usd', 0, ?, 'card', ?, ?, ?, 10000, 0, 'PENDING', ?, ?)`
  ).run(
    input.invoiceId,
    `inpay_${input.invoiceId}`,
    input.paymentIntentId,
    `evt_payment_${input.invoiceId}`,
    "ch_legacy_february",
    `evt_charge_${input.invoiceId}`,
    input.paymentIntentId,
    now,
    now
  );
}

function stripeEvent(id: string, type: string, object: Record<string, unknown>): string {
  return JSON.stringify({
    id,
    object: "event",
    api_version: STRIPE_API_VERSION,
    created: Math.floor(Date.now() / 1000),
    data: { object },
    livemode: false,
    pending_webhooks: 1,
    request: null,
    type
  });
}

async function sendSignedWebhook(workerEnv: Env, body: string): Promise<Response> {
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: "whsec_mock",
    timestamp: Math.floor(Date.now() / 1000)
  });
  return worker.fetch(new Request(`${origin}/webhooks/stripe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Stripe-Signature": signature },
    body
  }), workerEnv);
}

function count(database: ReturnType<typeof migratedDatabase>, table: string): number {
  const allowed = new Set([
    "stripe_checkout_sessions",
    "stripe_gifts",
    "stripe_acknowledgment_deliveries"
  ]);
  if (!allowed.has(table)) throw new Error("Unexpected test table");
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}
