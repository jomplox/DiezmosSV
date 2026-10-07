import type { Repository, StripeGiftType } from "../storage/repository";
import { StripeGiftConflictError } from "../storage/repository/stripeDonations";
import { newId } from "../utils/ids";
import type { StripeGateway, StripeLegacyInvoiceSnapshot } from "./stripeClient";

// Monthly subscriptions created by retired donation sites on the shared Stripe
// account are adopted into the eeuu_501c3 lane: a durable checkout row is
// created, their invoices since `backfillFromIso` are recorded as gifts that are
// never acknowledged, and only then is the subscription labelled with this
// lane's metadata so future renewals settle through the normal webhook path.

export type LegacyAdoptionGateway = Pick<
  StripeGateway,
  "retrieveLegacySubscription" | "listPaidSubscriptionInvoices" | "updateSubscriptionMetadata"
>;

export class StripeLegacyAdoptionError extends Error {
  constructor(readonly code: string) {
    super(`Legacy Stripe subscription adoption refused: ${code}`);
    this.name = "StripeLegacyAdoptionError";
  }
}

export interface LegacyAdoptionResult {
  dryRun: boolean;
  subscriptionId: string;
  checkoutId: string;
  giftType: Exclude<StripeGiftType, "UNSPECIFIED">;
  amountCents: number;
  invoices: { eligible: number; recorded: number; alreadyRecorded: number };
  backfilledCents: number;
}

export async function adoptLegacyStripeSubscription(input: {
  repo: Repository;
  gateway: LegacyAdoptionGateway;
  subscriptionId: string;
  livemode: boolean;
  backfillFromIso: string;
  dryRun: boolean;
  now: string;
}): Promise<LegacyAdoptionResult> {
  const { repo, gateway } = input;
  const subscription = await gateway.retrieveLegacySubscription(input.subscriptionId);
  if (subscription.livemode !== input.livemode) {
    throw new StripeLegacyAdoptionError("subscription_mode_mismatch");
  }
  if (subscription.status !== "active") {
    throw new StripeLegacyAdoptionError("subscription_not_active");
  }
  const [item] = subscription.items;
  if (
    subscription.items.length !== 1
    || item.currency !== "usd"
    || item.interval !== "month"
    || item.intervalCount !== 1
    || !validAmount(item.amountCents)
  ) {
    throw new StripeLegacyAdoptionError("subscription_shape_unsupported");
  }
  if (!subscription.customerId) {
    throw new StripeLegacyAdoptionError("subscription_customer_missing");
  }
  const checkoutId = `stripe_checkout_legacy_${subscription.id}`;
  const lane = subscription.metadata.lane;
  if (lane !== undefined && (lane !== "eeuu_501c3" || subscription.metadata.checkout_id !== checkoutId)) {
    throw new StripeLegacyAdoptionError("subscription_already_in_lane");
  }
  const amountCents = item.amountCents;
  const giftType = /diezmo/i.test(item.productName ?? "") ? "TITHE" : "OFFERING";

  const paidFromSeconds = Math.floor(Date.parse(input.backfillFromIso) / 1000);
  const invoices = await gateway.listPaidSubscriptionInvoices(subscription.id, paidFromSeconds);
  const eligible = invoices.map((invoice) => eligibleInvoice(invoice, input.livemode, paidFromSeconds));
  const backfilledCents = eligible.reduce((sum, invoice) => sum + invoice.amountCents, 0);
  const result: LegacyAdoptionResult = {
    dryRun: input.dryRun,
    subscriptionId: subscription.id,
    checkoutId,
    giftType,
    amountCents,
    invoices: { eligible: eligible.length, recorded: 0, alreadyRecorded: 0 },
    backfilledCents
  };
  if (input.dryRun) return result;

  const checkout = await repo.adoptLegacyStripeCheckout({
    id: checkoutId,
    requestId: `legacy-subscription:${subscription.id}`,
    subscriptionId: subscription.id,
    customerId: subscription.customerId,
    giftType,
    amountCents,
    livemode: input.livemode,
    donorName: subscription.donorName,
    donorEmail: subscription.donorEmail,
    now: input.now
  });
  if (
    !checkout
    || checkout.frequency !== "MONTHLY"
    || checkout.stripe_subscription_id !== subscription.id
    || checkout.gift_type !== giftType
    || checkout.amount_cents !== amountCents
    || checkout.livemode !== (input.livemode ? 1 : 0)
    || !checkout.adopted_at
  ) {
    throw new StripeLegacyAdoptionError("adoption_conflict");
  }

  for (const invoice of eligible) {
    let recorded;
    try {
      recorded = await repo.recordSuppressedStripeInvoiceGift({
        giftId: newId("stripe_gift"),
        invoiceId: invoice.id,
        checkoutId,
        subscriptionId: subscription.id,
        paymentIntentId: invoice.paymentIntentId,
        giftType,
        amountCents: invoice.amountCents,
        livemode: input.livemode,
        donorName: checkout.donor_name,
        donorEmail: checkout.donor_email,
        settledAt: invoice.settledAt,
        now: input.now
      });
    } catch (error) {
      if (error instanceof StripeGiftConflictError) {
        throw new StripeLegacyAdoptionError("invoice_conflict");
      }
      throw error;
    }
    if (recorded.inserted) result.invoices.recorded += 1;
    else result.invoices.alreadyRecorded += 1;
  }

  await gateway.updateSubscriptionMetadata(subscription.id, {
    checkout_id: checkoutId,
    frequency: "monthly",
    gift_type: giftType === "TITHE" ? "tithe" : "offering",
    lane: "eeuu_501c3"
  });
  return result;
}

function eligibleInvoice(
  invoice: StripeLegacyInvoiceSnapshot,
  livemode: boolean,
  paidFromSeconds: number
): { id: string; paymentIntentId: string; amountCents: number; settledAt: string } {
  const [payment] = invoice.payments;
  if (
    !/^in_[A-Za-z0-9_]+$/.test(invoice.id)
    || invoice.livemode !== livemode
    || invoice.currency !== "usd"
    || !validAmount(invoice.amountPaid)
    || invoice.paidAt === null
    || invoice.paidAt < paidFromSeconds
    || invoice.payments.length !== 1
    || payment.type !== "payment_intent"
    || payment.status !== "paid"
    || payment.amountPaid !== invoice.amountPaid
    || !payment.paymentIntentId?.startsWith("pi_")
  ) {
    throw new StripeLegacyAdoptionError("invoice_shape_unsupported");
  }
  return {
    id: invoice.id,
    paymentIntentId: payment.paymentIntentId,
    amountCents: invoice.amountPaid,
    settledAt: new Date(invoice.paidAt * 1000).toISOString()
  };
}

function validAmount(value: number | null): value is number {
  return Number.isInteger(value) && Number(value) >= 100 && Number(value) <= 500000;
}
