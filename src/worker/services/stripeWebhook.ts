import type Stripe from "stripe";
import { isValidEmail } from "../../shared/email";
import type { Repository, StripeCheckoutRecord, StripeGiftRecord } from "../storage/repository";
import type { Env } from "../types";
import { newId } from "../utils/ids";
import { snapshotStripeAcknowledgmentEvidence } from "./stripeAcknowledgment";
import { stripePaymentMethodEvidence } from "./stripePaymentMethod";

export class StripeWebhookEventError extends Error {
  constructor(readonly code: string) {
    super(`Stripe webhook event rejected: ${code}`);
    this.name = "StripeWebhookEventError";
  }
}

export async function processStripeWebhookEvent(
  repo: Repository,
  event: Stripe.Event,
  now: string,
  env?: Env
): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded":
    case "checkout.session.async_payment_failed":
    case "checkout.session.expired":
      await processCheckoutSessionEvent(repo, event, now, env);
      return;
    case "invoice.paid":
      await processInvoicePaidEvent(repo, event, now, env);
      return;
    case "invoice.payment_failed":
      await processInvoiceFailedEvent(repo, event, now);
      return;
    case "invoice_payment.paid":
      await processInvoicePaymentPaidEvent(repo, event, now, env);
      return;
    case "customer.subscription.deleted":
      await processSubscriptionDeletedEvent(repo, event, now);
      return;
    case "charge.succeeded":
      await processChargeSucceededEvent(repo, event, now, env);
      return;
    case "charge.refunded":
      await processChargeRefundedEvent(repo, event, now, env);
      return;
    default:
      return;
  }
}

async function processCheckoutSessionEvent(
  repo: Repository,
  event: Stripe.Event,
  now: string,
  env?: Env
): Promise<void> {
  const session = record(event.data.object);
  requireObjectType(session, "checkout.session");
  const sessionId = stripeId(session.id, "cs_");
  let checkout = await repo.getStripeCheckoutBySessionId(sessionId);
  if (!checkout) {
    const reservationId = reconciledCheckoutId(session);
    const reservation = await repo.getStripeCheckoutById(reservationId);
    if (!reservation) throw new StripeWebhookEventError("checkout_not_found");
    assertEventMode(reservation, event.livemode);
    assertCheckoutIdentity(session, reservation);
    const expiresAt = epochIso(session.expires_at);
    if (!expiresAt) throw new StripeWebhookEventError("checkout_identity_mismatch");
    checkout = await repo.attachStripeCheckoutSession({
      id: reservation.id,
      stripeSessionId: sessionId,
      expiresAt,
      now
    });
    if (!checkout) throw new StripeWebhookEventError("checkout_identity_mismatch");
  }
  assertEventMode(checkout, event.livemode);
  assertCheckoutIdentity(session, checkout);

  const customerId = optionalStripeId(session.customer, "cus_");
  const subscriptionId = optionalStripeId(session.subscription, "sub_");
  const paymentIntentId = optionalStripeId(session.payment_intent, "pi_");
  const customerDetails = optionalRecord(session.customer_details);
  const donorName = donorText(customerDetails?.name, 200);
  const donorEmail = donorEmailValue(customerDetails?.email ?? session.customer_email);
  const donorPhone = donorPhoneValue(customerDetails?.phone);
  const donorAddressJson = donorAddressValue(customerDetails?.address);
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
  const eventCreated = providerEventCreated(event);
  const eventId = providerEventId(event);
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
    donorPhone,
    donorAddressJson,
    completedAt,
    eventCreated,
    eventRank: paymentStatus === "PAID"
      ? 4
      : event.type === "checkout.session.async_payment_failed"
        ? 3
        : event.type === "checkout.session.expired"
          ? 2
          : 1,
    eventId,
    subscriptionEventRank: checkout.frequency === "MONTHLY" && paymentStatus === "PAID" ? 2 : undefined,
    now
  });
  if (!updated) throw new StripeWebhookEventError("checkout_update_failed");

  if (
    updated.frequency === "ONCE"
    && status === "COMPLETE"
    && paymentStatus === "PAID"
  ) {
    if (!paymentIntentId) throw new StripeWebhookEventError("payment_intent_missing");
    const recorded = await repo.recordStripeGiftAndAcknowledgment({
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
      paymentMethodType: updated.payment_method_type,
      paymentMethodWallet: updated.payment_method_wallet,
      paymentMethodChargeId: updated.payment_method_charge_id,
      paymentMethodEventId: updated.payment_method_event_id,
      donorName: updated.donor_name,
      donorEmail: updated.donor_email,
      donorPhone: updated.donor_phone,
      donorAddressJson: updated.donor_address_json,
      settledAt: completedAt ?? eventTime(event),
      now
    });
    if (env && recorded.record.payment_method_type) {
      await snapshotStripeAcknowledgmentEvidence(env, repo, recorded.acknowledgmentId, now);
    }
  }
}

async function processInvoicePaidEvent(
  repo: Repository,
  event: Stripe.Event,
  now: string,
  env?: Env
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
  const donorPhone = donorPhoneValue(invoice.customer_phone);
  const donorAddressJson = donorAddressValue(invoice.customer_address);
  const updated = await repo.updateStripeCheckoutFromInvoice({
    id: checkout.id,
    stripeCustomerId: optionalStripeId(invoice.customer, "cus_"),
    stripeSubscriptionId: context.subscriptionId,
    subscriptionStatus: "ACTIVE",
    donorName: donorText(invoice.customer_name, 200),
    donorEmail: donorEmailValue(invoice.customer_email),
    donorPhone,
    donorAddressJson,
    settled: true,
    completedAt: settledAt,
    eventCreated: providerEventCreated(event),
    eventRank: 2,
    eventId: providerEventId(event),
    now
  });
  if (!updated) throw new StripeWebhookEventError("invoice_checkout_conflict");
  const settlement = await repo.stageStripeInvoicePaid({
    invoiceId,
    checkoutId: updated.id,
    subscriptionId: context.subscriptionId,
    amountCents: amountPaid,
    donorName: updated.donor_name,
    donorEmail: updated.donor_email,
    donorPhone: updated.donor_phone,
    donorAddressJson: updated.donor_address_json,
    settledAt,
    livemode: event.livemode,
    eventId: providerEventId(event),
    now
  });
  await recordReadyInvoiceSettlement(repo, settlement, updated, now, env);
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
    donorPhone: donorPhoneValue(invoice.customer_phone),
    donorAddressJson: donorAddressValue(invoice.customer_address),
    settled: false,
    completedAt: null,
    eventCreated: providerEventCreated(event),
    eventRank: 1,
    eventId: providerEventId(event),
    now
  });
  if (!updated) throw new StripeWebhookEventError("invoice_checkout_conflict");
}

async function processInvoicePaymentPaidEvent(
  repo: Repository,
  event: Stripe.Event,
  now: string,
  env?: Env
): Promise<void> {
  const invoicePayment = record(event.data.object);
  requireObjectType(invoicePayment, "invoice_payment");
  const invoiceId = stripeId(invoicePayment.invoice, "in_");
  const payment = optionalRecord(invoicePayment.payment);
  if (payment?.type !== "payment_intent") {
    return;
  }
  if (invoicePayment.status !== "paid") return;
  const invoicePaymentId = stripeId(invoicePayment.id, "inpay_");
  const paymentIntentId = stripeId(payment.payment_intent, "pi_");
  const amountPaid = positiveInteger(invoicePayment.amount_paid, "invoice_payment_amount_invalid");
  if (invoicePayment.currency !== "usd") {
    throw new StripeWebhookEventError("invoice_payment_amount_mismatch");
  }
  let settlement = await repo.stageStripeInvoicePayment({
    invoiceId,
    invoicePaymentId,
    paymentIntentId,
    amountCents: amountPaid,
    livemode: event.livemode,
    eventId: providerEventId(event),
    now
  });
  const methodEvidence = await repo.getStripeChargePaymentMethodByPaymentIntent(paymentIntentId);
  if (methodEvidence) {
    const attached = await repo.recordStripePaymentMethodForInvoiceByPaymentIntent({
      paymentIntentId,
      amountCents: methodEvidence.payment_method_amount_cents,
      livemode: methodEvidence.livemode === 1,
      methodType: methodEvidence.payment_method_type,
      methodWallet: methodEvidence.payment_method_wallet,
      chargeId: methodEvidence.payment_method_charge_id,
      eventId: methodEvidence.event_id,
      now
    });
    if (!attached) throw new StripeWebhookEventError("invoice_payment_method_missing");
    settlement = attached.settlement;
  }
  if (!settlement.checkout_id) return;
  const checkout = await repo.getStripeCheckoutById(settlement.checkout_id);
  if (!checkout || checkout.frequency !== "MONTHLY") {
    throw new StripeWebhookEventError("monthly_checkout_not_found");
  }
  assertEventMode(checkout, event.livemode);
  await recordReadyInvoiceSettlement(repo, settlement, checkout, now, env);
}

async function recordReadyInvoiceSettlement(
  repo: Repository,
  settlement: Awaited<ReturnType<Repository["stageStripeInvoicePaid"]>>,
  checkout: StripeCheckoutRecord,
  now: string,
  env?: Env
): Promise<void> {
  if (settlement.status === "RECORDED") return;
  if (
    !settlement.checkout_id
    || !settlement.subscription_id
    || settlement.amount_cents === null
    || !settlement.settled_at
    || settlement.invoice_livemode === null
    || !settlement.invoice_payment_id
    || !settlement.payment_intent_id
    || settlement.payment_amount_cents === null
    || settlement.payment_livemode === null
  ) {
    return;
  }
  if (
    settlement.checkout_id !== checkout.id
    || settlement.amount_cents !== settlement.payment_amount_cents
    || settlement.currency !== settlement.payment_currency
    || settlement.invoice_livemode !== settlement.payment_livemode
    || settlement.invoice_livemode !== checkout.livemode
  ) {
    throw new StripeWebhookEventError("invoice_payment_amount_mismatch");
  }
  const methodEvidence = [
    settlement.payment_method_type,
    settlement.payment_method_charge_id,
    settlement.payment_method_event_id,
    settlement.payment_method_payment_intent_id,
    settlement.payment_method_amount_cents,
    settlement.payment_method_livemode
  ];
  const hasAnyMethodEvidence = methodEvidence.some((value) => value !== null);
  const hasCompleteMethodEvidence = methodEvidence.every((value) => value !== null);
  if (
    hasAnyMethodEvidence !== hasCompleteMethodEvidence
    || (hasCompleteMethodEvidence && (
      settlement.payment_intent_id !== settlement.payment_method_payment_intent_id
      || settlement.amount_cents !== settlement.payment_method_amount_cents
      || settlement.invoice_livemode !== settlement.payment_method_livemode
    ))
  ) {
    throw new StripeWebhookEventError("invoice_payment_method_mismatch");
  }
  const recorded = await repo.recordStripeGiftAndAcknowledgment({
    giftId: settlement.gift_id ?? newId("stripe_gift"),
    acknowledgmentId: newId("stripe_ack"),
    sourceType: "INVOICE",
    sourceId: settlement.invoice_id,
    checkoutId: checkout.id,
    stripePaymentIntentId: settlement.payment_intent_id,
    stripeInvoiceId: settlement.invoice_id,
    stripeSubscriptionId: settlement.subscription_id,
    frequency: "MONTHLY",
    giftType: requiredCheckoutGiftType(checkout),
    amountCents: settlement.amount_cents,
    paymentMethodType: settlement.payment_method_type,
    paymentMethodWallet: settlement.payment_method_wallet,
    paymentMethodChargeId: settlement.payment_method_charge_id,
    paymentMethodEventId: settlement.payment_method_event_id,
    donorName: settlement.donor_name,
    donorEmail: settlement.donor_email,
    donorPhone: settlement.donor_phone,
    donorAddressJson: settlement.donor_address_json,
    settledAt: settlement.settled_at,
    now
  });
  await repo.markStripeInvoiceSettlementRecorded({
    invoiceId: settlement.invoice_id,
    giftId: recorded.record.id,
    now
  });
  if (env && recorded.record.payment_method_type) {
    await snapshotStripeAcknowledgmentEvidence(env, repo, recorded.acknowledgmentId, now);
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
    eventCreated: providerEventCreated(event),
    eventRank: 3,
    eventId: providerEventId(event),
    now
  })) {
    throw new StripeWebhookEventError("subscription_update_failed");
  }
}

async function processChargeRefundedEvent(
  repo: Repository,
  event: Stripe.Event,
  now: string,
  env?: Env
): Promise<void> {
  const charge = record(event.data.object);
  requireObjectType(charge, "charge");
  const paymentIntentId = optionalStripeId(charge.payment_intent, "pi_");
  if (!paymentIntentId) throw new StripeWebhookEventError("refund_payment_intent_missing");
  const amountRefunded = nonNegativeInteger(charge.amount_refunded, "refund_amount_invalid");
  let gift = await repo.applyStripeRefund({
    stripePaymentIntentId: paymentIntentId,
    refundedAmountCents: amountRefunded,
    now
  });
  if (!gift) throw new StripeWebhookEventError("refund_gift_not_found");
  if (
    optionalRecord(charge.payment_method_details)
    && (!gift.payment_method_type || gift.payment_method_type === "legacy_stripe")
  ) {
    await applyStripeChargePaymentMethod(repo, event, charge, now, env);
    gift = await repo.getStripeGiftBySourceId(gift.source_id) ?? gift;
  }
  if (env && gift.refunded_amount_cents > 0 && gift.payment_method_type) {
    const correction = await repo.getStripeAcknowledgmentForGiftEvidence(
      gift.id,
      gift.refunded_amount_cents
    );
    if (!correction) throw new StripeWebhookEventError("refund_acknowledgment_missing");
    await snapshotStripeAcknowledgmentEvidence(env, repo, correction.id, now);
  }
}

async function processChargeSucceededEvent(
  repo: Repository,
  event: Stripe.Event,
  now: string,
  env?: Env
): Promise<void> {
  const charge = record(event.data.object);
  requireObjectType(charge, "charge");
  if (charge.paid !== true || charge.status !== "succeeded") {
    throw new StripeWebhookEventError("charge_not_succeeded");
  }
  await applyStripeChargePaymentMethod(repo, event, charge, now, env);
}

async function applyStripeChargePaymentMethod(
  repo: Repository,
  event: Stripe.Event,
  charge: Record<string, unknown>,
  now: string,
  env?: Env
): Promise<void> {
  if (Boolean(charge.livemode) !== event.livemode) {
    throw new StripeWebhookEventError("event_mode_mismatch");
  }
  if (charge.currency !== "usd") {
    throw new StripeWebhookEventError("charge_amount_mismatch");
  }
  const amountCents = positiveInteger(charge.amount, "charge_amount_invalid");
  const paymentIntentId = optionalStripeId(charge.payment_intent, "pi_");
  if (!paymentIntentId) throw new StripeWebhookEventError("payment_intent_missing");
  let method;
  try {
    method = stripePaymentMethodEvidence(charge, providerEventId(event));
  } catch (error) {
    const code = error instanceof Error ? error.message : "payment_method_invalid";
    throw new StripeWebhookEventError(code);
  }
  try {
    await repo.recordStripeWebhookPaymentMethodEvidence({
      eventId: method.eventId,
      paymentIntentId,
      amountCents,
      livemode: event.livemode,
      methodType: method.type,
      methodWallet: method.wallet,
      chargeId: method.chargeId,
      now
    });
  } catch {
    throw new StripeWebhookEventError("payment_method_identity_conflict");
  }
  let gift: StripeGiftRecord | null = null;
  const metadata = optionalRecord(charge.metadata);
  if (metadata?.lane === "eeuu_501c3" && metadata.frequency === "once") {
    if (metadata.gift_type !== "tithe" && metadata.gift_type !== "offering") {
      throw new StripeWebhookEventError("charge_metadata_invalid");
    }
    const checkoutId = stripeId(metadata.checkout_id, "stripe_checkout_");
    const checkout = await repo.getStripeCheckoutById(checkoutId);
    if (!checkout || checkout.frequency !== "ONCE") {
      throw new StripeWebhookEventError("checkout_not_found");
    }
    assertEventMode(checkout, event.livemode);
    if (
      checkout.amount_cents !== amountCents
      || metadata.gift_type !== (requiredCheckoutGiftType(checkout) === "TITHE" ? "tithe" : "offering")
    ) {
      throw new StripeWebhookEventError("charge_amount_mismatch");
    }
    try {
      ({ gift } = await repo.recordStripePaymentMethodForCheckout({
        checkoutId,
        paymentIntentId,
        amountCents,
        livemode: event.livemode,
        methodType: method.type,
        methodWallet: method.wallet,
        chargeId: method.chargeId,
        eventId: method.eventId,
        now
      }));
    } catch {
      throw new StripeWebhookEventError("payment_method_identity_conflict");
    }
  } else {
    if (metadata?.lane === "eeuu_501c3" && metadata.frequency !== "monthly") {
      throw new StripeWebhookEventError("charge_metadata_invalid");
    }
    let result: Awaited<ReturnType<Repository["recordStripePaymentMethodForInvoiceByPaymentIntent"]>>;
    try {
      result = await repo.recordStripePaymentMethodForInvoiceByPaymentIntent({
        paymentIntentId,
        amountCents,
        livemode: event.livemode,
        methodType: method.type,
        methodWallet: method.wallet,
        chargeId: method.chargeId,
        eventId: method.eventId,
        now
      });
    } catch {
      throw new StripeWebhookEventError("payment_method_identity_conflict");
    }
    if (!result) return;
    gift = result.gift;
    if (!gift && result.settlement.checkout_id) {
      const checkout = await repo.getStripeCheckoutById(result.settlement.checkout_id);
      if (!checkout || checkout.frequency !== "MONTHLY") {
        throw new StripeWebhookEventError("monthly_checkout_not_found");
      }
      assertEventMode(checkout, event.livemode);
      await recordReadyInvoiceSettlement(repo, result.settlement, checkout, now, env);
      gift = await repo.getStripeGiftBySourceId(result.settlement.invoice_id);
    }
  }
  if (env && gift) {
    const delivery = await repo.getStripeAcknowledgmentForGiftEvidence(
      gift.id,
      gift.refunded_amount_cents
    );
    if (!delivery) throw new StripeWebhookEventError("acknowledgment_missing");
    await snapshotStripeAcknowledgmentEvidence(env, repo, delivery.id, now);
  }
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

function reconciledCheckoutId(session: Record<string, unknown>): string {
  const clientReferenceId = typeof session.client_reference_id === "string"
    ? session.client_reference_id
    : "";
  const metadataCheckoutId = optionalRecord(session.metadata)?.checkout_id;
  if (
    !/^stripe_checkout_[A-Za-z0-9_-]{4,200}$/.test(clientReferenceId)
    || metadataCheckoutId !== clientReferenceId
  ) {
    throw new StripeWebhookEventError("checkout_identity_mismatch");
  }
  return clientReferenceId;
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

function eventTime(event: Stripe.Event): string {
  return epochIso(event.created) ?? new Date(0).toISOString();
}

function providerEventCreated(event: Stripe.Event): number {
  if (!Number.isInteger(event.created) || event.created <= 0) {
    throw new StripeWebhookEventError("event_created_invalid");
  }
  return event.created;
}

function providerEventId(event: Stripe.Event): string {
  return stripeId(event.id, "evt_");
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

function donorPhoneValue(value: unknown): string | null {
  const phone = donorText(value, 40);
  return phone && phone.length >= 7 ? phone : null;
}

function donorAddressValue(value: unknown): string | null {
  const address = optionalRecord(value);
  if (!address) return null;
  const normalized = {
    line1: donorText(address.line1, 200),
    line2: donorText(address.line2, 200),
    city: donorText(address.city, 100),
    state: donorText(address.state, 100),
    postalCode: donorText(address.postal_code, 32),
    country: donorText(address.country, 2)?.toUpperCase() ?? null
  };
  return Object.values(normalized).some(Boolean) ? JSON.stringify(normalized) : null;
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
