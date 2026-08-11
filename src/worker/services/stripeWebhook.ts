import type Stripe from "stripe";
import { isValidEmail } from "../../shared/email";
import type { Repository, StripeCheckoutRecord } from "../storage/repository";
import { newId } from "../utils/ids";

export class StripeWebhookEventError extends Error {
  constructor(readonly code: string) {
    super(`Stripe webhook event rejected: ${code}`);
    this.name = "StripeWebhookEventError";
  }
}

export async function processStripeWebhookEvent(
  repo: Repository,
  event: Stripe.Event,
  now: string
): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired":
      await processCheckoutSessionEvent(repo, event, now);
      return;
    case "invoice.paid":
      await processInvoicePaidEvent(repo, event, now);
      return;
    case "invoice.payment_failed":
      await processInvoiceFailedEvent(repo, event, now);
      return;
    case "invoice_payment.paid":
      await processInvoicePaymentPaidEvent(repo, event, now);
      return;
    case "customer.subscription.deleted":
      await processSubscriptionDeletedEvent(repo, event, now);
      return;
    case "charge.refunded":
      await processChargeRefundedEvent(repo, event, now);
      return;
    default:
      return;
  }
}

async function processCheckoutSessionEvent(
  repo: Repository,
  event: Stripe.Event,
  now: string
): Promise<void> {
  const session = record(event.data.object);
  requireObjectType(session, "checkout.session");
  const sessionId = stripeId(session.id, "cs_");
  const checkout = await repo.getStripeCheckoutBySessionId(sessionId);
  if (!checkout) throw new StripeWebhookEventError("checkout_not_found");
  assertEventMode(checkout, event.livemode);
  assertCheckoutIdentity(session, checkout);

  const customerId = optionalStripeId(session.customer, "cus_");
  const subscriptionId = optionalStripeId(session.subscription, "sub_");
  const paymentIntentId = optionalStripeId(session.payment_intent, "pi_");
  const customerDetails = optionalRecord(session.customer_details);
  const donorName = donorText(customerDetails?.name, 200);
  const donorEmail = donorEmailValue(customerDetails?.email ?? session.customer_email);
  const paymentStatus = event.type === "checkout.session.async_payment_succeeded"
    ? "PAID"
    : session.payment_status === "paid"
      ? "PAID"
      : session.payment_status === "no_payment_required"
        ? "NO_PAYMENT_REQUIRED"
        : "UNPAID";
  const status = event.type === "checkout.session.expired"
    ? "EXPIRED"
    : event.type === "checkout.session.async_payment_failed"
      ? "FAILED"
      : "COMPLETE";
  const completedAt = status === "COMPLETE" ? eventTime(event) : null;
  const updated = await repo.updateStripeCheckoutFromEvent({
    stripeSessionId: sessionId,
    status,
    paymentStatus,
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId,
    subscriptionStatus: checkout.frequency === "MONTHLY" && paymentStatus === "PAID" ? "ACTIVE" : null,
    stripePaymentIntentId: paymentIntentId,
    donorName,
    donorEmail,
    completedAt,
    now
  });
  if (!updated) throw new StripeWebhookEventError("checkout_update_failed");

  if (
    updated.frequency === "ONCE"
    && status === "COMPLETE"
    && paymentStatus === "PAID"
  ) {
    if (!paymentIntentId) throw new StripeWebhookEventError("payment_intent_missing");
    await repo.recordStripeGiftAndAcknowledgment({
      giftId: newId("stripe_gift"),
      acknowledgmentId: newId("stripe_ack"),
      sourceType: "PAYMENT_INTENT",
      sourceId: paymentIntentId,
      checkoutId: updated.id,
      stripePaymentIntentId: paymentIntentId,
      stripeInvoiceId: null,
      stripeSubscriptionId: null,
      frequency: "ONCE",
      giftType: requiredCheckoutGiftType(updated),
      amountCents: updated.amount_cents,
      donorName: updated.donor_name,
      donorEmail: updated.donor_email,
      settledAt: completedAt ?? eventTime(event),
      now
    });
  }
}

async function processInvoicePaidEvent(
  repo: Repository,
  event: Stripe.Event,
  now: string
): Promise<void> {
  const invoice = record(event.data.object);
  requireObjectType(invoice, "invoice");
  const invoiceId = stripeId(invoice.id, "in_");
  const context = invoiceSubscriptionContext(invoice);
  const checkout = await repo.getStripeCheckoutById(context.checkoutId);
  if (!checkout || checkout.frequency !== "MONTHLY") {
    throw new StripeWebhookEventError("monthly_checkout_not_found");
  }
  assertEventMode(checkout, event.livemode);
  assertMonthlyMetadata(context, checkout);
  const amountPaid = positiveInteger(invoice.amount_paid, "invoice_amount_invalid");
  if (amountPaid !== checkout.amount_cents || invoice.currency !== "usd") {
    throw new StripeWebhookEventError("invoice_amount_mismatch");
  }
  const settledAt = epochIso(optionalRecord(invoice.status_transitions)?.paid_at) ?? eventTime(event);
  const updated = await repo.updateStripeCheckoutFromInvoice({
    id: checkout.id,
    stripeCustomerId: optionalStripeId(invoice.customer, "cus_"),
    stripeSubscriptionId: context.subscriptionId,
    subscriptionStatus: "ACTIVE",
    donorName: donorText(invoice.customer_name, 200),
    donorEmail: donorEmailValue(invoice.customer_email),
    settled: true,
    completedAt: settledAt,
    now
  });
  if (!updated) throw new StripeWebhookEventError("invoice_checkout_conflict");
  const paymentIntentId = invoicePaymentIntentId(invoice);
  await repo.recordStripeGiftAndAcknowledgment({
    giftId: newId("stripe_gift"),
    acknowledgmentId: newId("stripe_ack"),
    sourceType: "INVOICE",
    sourceId: invoiceId,
    checkoutId: updated.id,
    stripePaymentIntentId: paymentIntentId,
    stripeInvoiceId: invoiceId,
    stripeSubscriptionId: context.subscriptionId,
    frequency: "MONTHLY",
    giftType: requiredCheckoutGiftType(updated),
    amountCents: amountPaid,
    donorName: updated.donor_name,
    donorEmail: updated.donor_email,
    settledAt,
    now
  });
}

async function processInvoiceFailedEvent(
  repo: Repository,
  event: Stripe.Event,
  now: string
): Promise<void> {
  const invoice = record(event.data.object);
  requireObjectType(invoice, "invoice");
  const context = invoiceSubscriptionContext(invoice);
  const checkout = await repo.getStripeCheckoutById(context.checkoutId);
  if (!checkout || checkout.frequency !== "MONTHLY") {
    throw new StripeWebhookEventError("monthly_checkout_not_found");
  }
  assertEventMode(checkout, event.livemode);
  assertMonthlyMetadata(context, checkout);
  const updated = await repo.updateStripeCheckoutFromInvoice({
    id: checkout.id,
    stripeCustomerId: optionalStripeId(invoice.customer, "cus_"),
    stripeSubscriptionId: context.subscriptionId,
    subscriptionStatus: "PAST_DUE",
    donorName: donorText(invoice.customer_name, 200),
    donorEmail: donorEmailValue(invoice.customer_email),
    settled: false,
    completedAt: null,
    now
  });
  if (!updated) throw new StripeWebhookEventError("invoice_checkout_conflict");
}

async function processInvoicePaymentPaidEvent(
  repo: Repository,
  event: Stripe.Event,
  now: string
): Promise<void> {
  const invoicePayment = record(event.data.object);
  requireObjectType(invoicePayment, "invoice_payment");
  const invoiceId = stripeId(invoicePayment.invoice, "in_");
  const payment = optionalRecord(invoicePayment.payment);
  if (payment?.type !== "payment_intent") {
    throw new StripeWebhookEventError("invoice_payment_type_invalid");
  }
  const paymentIntentId = stripeId(payment.payment_intent, "pi_");
  const gift = await repo.getStripeGiftBySourceId(invoiceId);
  if (!gift || gift.source_type !== "INVOICE" || !gift.checkout_id) {
    throw new StripeWebhookEventError("invoice_gift_not_found");
  }
  const checkout = await repo.getStripeCheckoutById(gift.checkout_id);
  if (!checkout) throw new StripeWebhookEventError("monthly_checkout_not_found");
  assertEventMode(checkout, event.livemode);
  if (
    invoicePayment.currency !== "usd"
    || invoicePayment.amount_paid !== gift.amount_cents
  ) {
    throw new StripeWebhookEventError("invoice_payment_amount_mismatch");
  }
  if (!await repo.attachStripeInvoicePaymentIntent({
    stripeInvoiceId: invoiceId,
    stripePaymentIntentId: paymentIntentId,
    now
  })) {
    throw new StripeWebhookEventError("invoice_payment_conflict");
  }
}

async function processSubscriptionDeletedEvent(
  repo: Repository,
  event: Stripe.Event,
  now: string
): Promise<void> {
  const subscription = record(event.data.object);
  requireObjectType(subscription, "subscription");
  const subscriptionId = stripeId(subscription.id, "sub_");
  const metadata = optionalRecord(subscription.metadata);
  if (
    metadata?.lane !== "eeuu_501c3"
    || metadata.frequency !== "monthly"
    || (metadata.gift_type !== "tithe" && metadata.gift_type !== "offering")
  ) {
    throw new StripeWebhookEventError("subscription_metadata_invalid");
  }
  const checkoutId = stripeId(metadata.checkout_id, "stripe_checkout_");
  const checkout = await repo.getStripeCheckoutById(checkoutId);
  if (!checkout || checkout.stripe_subscription_id !== subscriptionId) {
    throw new StripeWebhookEventError("subscription_checkout_conflict");
  }
  assertEventMode(checkout, event.livemode);
  if (metadata.gift_type !== (requiredCheckoutGiftType(checkout) === "TITHE" ? "tithe" : "offering")) {
    throw new StripeWebhookEventError("subscription_metadata_gift_type_mismatch");
  }
  if (!await repo.updateStripeSubscriptionStatus({
    stripeSubscriptionId: subscriptionId,
    status: "CANCELED",
    now
  })) {
    throw new StripeWebhookEventError("subscription_update_failed");
  }
}

async function processChargeRefundedEvent(
  repo: Repository,
  event: Stripe.Event,
  now: string
): Promise<void> {
  const charge = record(event.data.object);
  requireObjectType(charge, "charge");
  const paymentIntentId = optionalStripeId(charge.payment_intent, "pi_");
  if (!paymentIntentId) throw new StripeWebhookEventError("refund_payment_intent_missing");
  const amountRefunded = nonNegativeInteger(charge.amount_refunded, "refund_amount_invalid");
  const gift = await repo.applyStripeRefund({
    stripePaymentIntentId: paymentIntentId,
    refundedAmountCents: amountRefunded,
    now
  });
  if (!gift) throw new StripeWebhookEventError("refund_gift_not_found");
}

function assertCheckoutIdentity(
  session: Record<string, unknown>,
  checkout: StripeCheckoutRecord
): void {
  const metadata = optionalRecord(session.metadata);
  const expectedFrequency = checkout.frequency === "MONTHLY" ? "monthly" : "once";
  const expectedGiftType = checkout.gift_type === "TITHE" ? "tithe" : "offering";
  const expectedMode = checkout.frequency === "MONTHLY" ? "subscription" : "payment";
  if (
    session.client_reference_id !== checkout.id
    || metadata?.checkout_id !== checkout.id
    || metadata.frequency !== expectedFrequency
    || metadata.gift_type !== expectedGiftType
    || metadata.lane !== "eeuu_501c3"
    || session.mode !== expectedMode
    || session.currency !== "usd"
    || session.amount_total !== checkout.amount_cents
  ) {
    throw new StripeWebhookEventError("checkout_identity_mismatch");
  }
}

function assertEventMode(checkout: StripeCheckoutRecord, eventLivemode: boolean): void {
  if (Boolean(checkout.livemode) !== eventLivemode) {
    throw new StripeWebhookEventError("event_mode_mismatch");
  }
}

function invoiceSubscriptionContext(invoice: Record<string, unknown>): {
  checkoutId: string;
  subscriptionId: string;
  giftType: "tithe" | "offering";
} {
  const parent = optionalRecord(invoice.parent);
  const details = optionalRecord(parent?.subscription_details);
  const metadata = optionalRecord(details?.metadata);
  if (!details
    || parent?.type !== "subscription_details"
    || metadata?.lane !== "eeuu_501c3"
    || metadata.frequency !== "monthly"
    || (metadata.gift_type !== "tithe" && metadata.gift_type !== "offering")) {
    throw new StripeWebhookEventError("invoice_metadata_invalid");
  }
  return {
    checkoutId: stripeId(metadata.checkout_id, "stripe_checkout_"),
    subscriptionId: stripeId(details.subscription, "sub_"),
    giftType: metadata.gift_type
  };
}

function requiredCheckoutGiftType(checkout: StripeCheckoutRecord): "TITHE" | "OFFERING" {
  if (checkout.gift_type === "TITHE" || checkout.gift_type === "OFFERING") {
    return checkout.gift_type;
  }
  throw new StripeWebhookEventError("checkout_gift_type_invalid");
}

function assertMonthlyMetadata(
  context: { giftType: "tithe" | "offering" },
  checkout: StripeCheckoutRecord
): void {
  const expectedGiftType = requiredCheckoutGiftType(checkout) === "TITHE" ? "tithe" : "offering";
  if (context.giftType !== expectedGiftType) {
    throw new StripeWebhookEventError("invoice_metadata_gift_type_mismatch");
  }
}

function invoicePaymentIntentId(invoice: Record<string, unknown>): string | null {
  const payments = optionalRecord(invoice.payments);
  const data = Array.isArray(payments?.data) ? payments.data : [];
  for (const entry of data) {
    const payment = optionalRecord(optionalRecord(entry)?.payment);
    const id = optionalStripeId(payment?.payment_intent, "pi_");
    if (id) return id;
  }
  return null;
}

function eventTime(event: Stripe.Event): string {
  return epochIso(event.created) ?? new Date(0).toISOString();
}

function epochIso(value: unknown): string | null {
  if (!Number.isInteger(value) || Number(value) <= 0) return null;
  const date = new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function donorText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function donorEmailValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length <= 254 && isValidEmail(normalized) ? normalized : null;
}

function positiveInteger(value: unknown, code: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new StripeWebhookEventError(code);
  return Number(value);
}

function nonNegativeInteger(value: unknown, code: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new StripeWebhookEventError(code);
  return Number(value);
}

function stripeId(value: unknown, prefix: string): string {
  const id = externalId(value);
  if (!id || !id.startsWith(prefix) || id.length > 255 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new StripeWebhookEventError("stripe_identifier_invalid");
  }
  return id;
}

function optionalStripeId(value: unknown, prefix: string): string | null {
  if (value == null) return null;
  return stripeId(value, prefix);
}

function externalId(value: unknown): string | null {
  if (typeof value === "string") return value;
  const object = optionalRecord(value);
  return typeof object?.id === "string" ? object.id : null;
}

function requireObjectType(value: Record<string, unknown>, expected: string): void {
  if (value.object !== expected) throw new StripeWebhookEventError("event_object_invalid");
}

function record(value: unknown): Record<string, unknown> {
  const result = optionalRecord(value);
  if (!result) throw new StripeWebhookEventError("event_object_invalid");
  return result;
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
