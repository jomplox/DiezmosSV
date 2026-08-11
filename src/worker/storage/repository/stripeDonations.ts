export type StripeGiftFrequency = "ONCE" | "MONTHLY";
export type StripeGiftType = "TITHE" | "OFFERING" | "UNSPECIFIED";
export type StripeCheckoutStatus = "CREATING" | "OPEN" | "COMPLETE" | "EXPIRED" | "FAILED";
export type StripePaymentStatus = "UNPAID" | "PAID" | "NO_PAYMENT_REQUIRED";

const STRIPE_PROCESSING_CLAIM_LEASE_MS = 5 * 60 * 1000;

export interface StripeCheckoutRecord {
  id: string;
  request_id: string;
  request_fingerprint: string;
  stripe_session_id: string | null;
  frequency: StripeGiftFrequency;
  gift_type: StripeGiftType;
  amount_cents: number;
  currency: "usd";
  livemode: 0 | 1;
  status: StripeCheckoutStatus;
  creation_attempt_count: number;
  payment_status: StripePaymentStatus;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: "ACTIVE" | "PAST_DUE" | "CANCELED" | null;
  stripe_payment_intent_id: string | null;
  donor_name: string | null;
  donor_email: string | null;
  rate_limit_claim_id: string | null;
  error_code: string | null;
  expires_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface StripeGiftRecord {
  id: string;
  source_type: "PAYMENT_INTENT" | "INVOICE";
  source_id: string;
  checkout_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_invoice_id: string | null;
  stripe_subscription_id: string | null;
  frequency: StripeGiftFrequency;
  gift_type: StripeGiftType;
  amount_cents: number;
  currency: "usd";
  donor_name: string | null;
  donor_email: string | null;
  settled_at: string;
  status: "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED";
  refunded_amount_cents: number;
  created_at: string;
  updated_at: string;
}

export interface StripeAcknowledgmentClaim {
  id: string;
  gift_id: string;
  status: "PROCESSING";
  attempt_count: number;
  processing_claim_id: string;
  dispatch_started_at: string | null;
  donor_name: string | null;
  donor_email: string | null;
  frequency: StripeGiftFrequency;
  gift_type: StripeGiftType;
  amount_cents: number;
  settled_at: string;
}

export class StripeGiftConflictError extends Error {
  constructor() {
    super("Stripe gift source conflicts with its durable record");
    this.name = "StripeGiftConflictError";
  }
}

export async function reserveStripeCheckout(
  db: D1Database,
  input: {
    id: string;
    requestId: string;
    requestFingerprint: string;
    frequency: StripeGiftFrequency;
    giftType: Exclude<StripeGiftType, "UNSPECIFIED">;
    amountCents: number;
    livemode: boolean;
    rateLimitClaimId: string | null;
    now: string;
  }
): Promise<{
  kind: "CREATED" | "EXISTING" | "CONFLICT";
  record: StripeCheckoutRecord;
}> {
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO stripe_checkout_sessions (
       id, request_id, request_fingerprint, frequency, gift_type, amount_cents, currency,
       livemode, status, payment_status, rate_limit_claim_id, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'usd', ?, 'CREATING', 'UNPAID', ?, ?, ?)`
  ).bind(
    input.id,
    input.requestId,
    input.requestFingerprint,
    input.frequency,
    input.giftType,
    input.amountCents,
    input.livemode ? 1 : 0,
    input.rateLimitClaimId,
    input.now,
    input.now
  ).run();
  const record = await getStripeCheckoutByRequestId(db, input.requestId);
  if (!record) {
    throw new Error("Stripe Checkout reservation could not be read");
  }
  if (Number(inserted.meta?.changes ?? 0) === 1) {
    return { kind: "CREATED", record };
  }
  const matches = record.request_fingerprint === input.requestFingerprint
    && record.frequency === input.frequency
    && record.gift_type === input.giftType
    && record.amount_cents === input.amountCents
    && record.livemode === (input.livemode ? 1 : 0);
  return { kind: matches ? "EXISTING" : "CONFLICT", record };
}

export async function getStripeCheckoutByRequestId(
  db: D1Database,
  requestId: string
): Promise<StripeCheckoutRecord | null> {
  return db.prepare(
    "SELECT * FROM stripe_checkout_sessions WHERE request_id = ?"
  ).bind(requestId).first<StripeCheckoutRecord>();
}

export async function getStripeCheckoutBySessionId(
  db: D1Database,
  stripeSessionId: string
): Promise<StripeCheckoutRecord | null> {
  return db.prepare(
    "SELECT * FROM stripe_checkout_sessions WHERE stripe_session_id = ?"
  ).bind(stripeSessionId).first<StripeCheckoutRecord>();
}

export async function getStripeCheckoutById(
  db: D1Database,
  id: string
): Promise<StripeCheckoutRecord | null> {
  return db.prepare(
    "SELECT * FROM stripe_checkout_sessions WHERE id = ?"
  ).bind(id).first<StripeCheckoutRecord>();
}

export async function completeStripeCheckoutCreation(
  db: D1Database,
  input: {
    id: string;
    stripeSessionId: string;
    expiresAt: string;
    now: string;
  }
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE stripe_checkout_sessions
        SET stripe_session_id = ?, status = 'OPEN', expires_at = ?, error_code = NULL, updated_at = ?
      WHERE id = ? AND status = 'CREATING' AND stripe_session_id IS NULL`
  ).bind(input.stripeSessionId, input.expiresAt, input.now, input.id).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function failStripeCheckoutCreation(
  db: D1Database,
  input: { id: string; errorCode: string; now: string }
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE stripe_checkout_sessions
        SET status = 'FAILED', error_code = ?, updated_at = ?
      WHERE id = ? AND status = 'CREATING' AND stripe_session_id IS NULL`
  ).bind(input.errorCode, input.now, input.id).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function reclaimStripeCheckoutCreation(
  db: D1Database,
  input: { id: string; now: string }
): Promise<StripeCheckoutRecord | null> {
  return db.prepare(
    `UPDATE stripe_checkout_sessions
        SET status = 'CREATING', creation_attempt_count = creation_attempt_count + 1,
            error_code = NULL, updated_at = ?
      WHERE id = ? AND stripe_session_id IS NULL
        AND creation_attempt_count < 3
        AND (
          status = 'FAILED'
          OR (status = 'CREATING' AND updated_at < ?)
        )
      RETURNING *`
  ).bind(
    input.now,
    input.id,
    stripeClaimStaleBefore(input.now)
  ).first<StripeCheckoutRecord>();
}

export async function updateStripeCheckoutFromEvent(
  db: D1Database,
  input: {
    stripeSessionId: string;
    status: Exclude<StripeCheckoutStatus, "CREATING">;
    paymentStatus: StripePaymentStatus;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    subscriptionStatus?: StripeCheckoutRecord["subscription_status"];
    stripePaymentIntentId: string | null;
    donorName: string | null;
    donorEmail: string | null;
    completedAt: string | null;
    now: string;
  }
): Promise<StripeCheckoutRecord | null> {
  return db.prepare(
    `UPDATE stripe_checkout_sessions
        SET status = CASE
              WHEN payment_status = 'PAID' OR ? = 'PAID' THEN 'COMPLETE'
              ELSE ?
            END,
            payment_status = CASE
              WHEN payment_status = 'PAID' OR ? = 'PAID' THEN 'PAID'
              ELSE ?
            END,
            stripe_customer_id = COALESCE(?, stripe_customer_id),
            stripe_subscription_id = COALESCE(?, stripe_subscription_id),
            subscription_status = CASE
              WHEN subscription_status = 'CANCELED' THEN 'CANCELED'
              ELSE COALESCE(?, subscription_status)
            END,
            stripe_payment_intent_id = COALESCE(?, stripe_payment_intent_id),
            donor_name = COALESCE(?, donor_name),
            donor_email = COALESCE(?, donor_email),
            completed_at = COALESCE(?, completed_at),
            updated_at = ?
      WHERE stripe_session_id = ?
      RETURNING *`
  ).bind(
    input.paymentStatus,
    input.status,
    input.paymentStatus,
    input.paymentStatus,
    input.stripeCustomerId,
    input.stripeSubscriptionId,
    input.subscriptionStatus ?? null,
    input.stripePaymentIntentId,
    input.donorName,
    input.donorEmail,
    input.completedAt,
    input.now,
    input.stripeSessionId
  ).first<StripeCheckoutRecord>();
}

export async function updateStripeSubscriptionStatus(
  db: D1Database,
  input: {
    stripeSubscriptionId: string;
    status: NonNullable<StripeCheckoutRecord["subscription_status"]>;
    now: string;
  }
): Promise<StripeCheckoutRecord | null> {
  return db.prepare(
    `UPDATE stripe_checkout_sessions
        SET subscription_status = ?, updated_at = ?
      WHERE stripe_subscription_id = ? AND frequency = 'MONTHLY'
      RETURNING *`
  ).bind(
    input.status,
    input.now,
    input.stripeSubscriptionId
  ).first<StripeCheckoutRecord>();
}

export async function updateStripeCheckoutFromInvoice(
  db: D1Database,
  input: {
    id: string;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string;
    subscriptionStatus: NonNullable<StripeCheckoutRecord["subscription_status"]>;
    donorName: string | null;
    donorEmail: string | null;
    settled: boolean;
    completedAt: string | null;
    now: string;
  }
): Promise<StripeCheckoutRecord | null> {
  return db.prepare(
    `UPDATE stripe_checkout_sessions
        SET status = CASE WHEN ? = 1 THEN 'COMPLETE' ELSE status END,
            payment_status = CASE WHEN ? = 1 THEN 'PAID' ELSE payment_status END,
            stripe_customer_id = COALESCE(?, stripe_customer_id),
            stripe_subscription_id = COALESCE(stripe_subscription_id, ?),
            subscription_status = CASE
              WHEN subscription_status = 'CANCELED' THEN 'CANCELED'
              ELSE ?
            END,
            donor_name = COALESCE(?, donor_name),
            donor_email = COALESCE(?, donor_email),
            completed_at = CASE WHEN ? = 1 THEN COALESCE(?, completed_at) ELSE completed_at END,
            updated_at = ?
      WHERE id = ? AND frequency = 'MONTHLY'
        AND (stripe_subscription_id IS NULL OR stripe_subscription_id = ?)
      RETURNING *`
  ).bind(
    input.settled ? 1 : 0,
    input.settled ? 1 : 0,
    input.stripeCustomerId,
    input.stripeSubscriptionId,
    input.subscriptionStatus,
    input.donorName,
    input.donorEmail,
    input.settled ? 1 : 0,
    input.completedAt,
    input.now,
    input.id,
    input.stripeSubscriptionId
  ).first<StripeCheckoutRecord>();
}

interface StripeWebhookEventRow {
  event_type: string;
  livemode: 0 | 1;
  status: "PROCESSING" | "PROCESSED" | "FAILED";
  attempt_count: number;
}

export interface StripeWebhookHealthRecord {
  receivedAt: string;
  eventType: string;
  status: "PROCESSING" | "PROCESSED" | "FAILED";
  livemode: boolean;
}

export async function getLatestStripeWebhookHealth(
  db: D1Database
): Promise<StripeWebhookHealthRecord | null> {
  const row = await db.prepare(
    `SELECT received_at, event_type, status, livemode
       FROM stripe_webhook_events
      ORDER BY received_at DESC, id DESC
      LIMIT 1`
  ).first<{
    received_at: string;
    event_type: string;
    status: "PROCESSING" | "PROCESSED" | "FAILED";
    livemode: 0 | 1;
  }>();
  return row ? {
    receivedAt: row.received_at,
    eventType: row.event_type,
    status: row.status,
    livemode: row.livemode === 1
  } : null;
}

export async function claimStripeWebhookEvent(
  db: D1Database,
  input: {
    eventId: string;
    eventType: string;
    livemode: boolean;
    claimId: string;
    now: string;
  }
): Promise<{
  kind: "CLAIMED" | "BUSY" | "DUPLICATE" | "CONFLICT";
  attemptCount: number;
}> {
  const inserted = await db.prepare(
    `INSERT OR IGNORE INTO stripe_webhook_events (
       id, event_type, livemode, status, attempt_count, processing_claim_id,
       received_at, updated_at
     ) VALUES (?, ?, ?, 'PROCESSING', 1, ?, ?, ?)`
  ).bind(
    input.eventId,
    input.eventType,
    input.livemode ? 1 : 0,
    input.claimId,
    input.now,
    input.now
  ).run();
  if (Number(inserted.meta?.changes ?? 0) === 1) {
    return { kind: "CLAIMED", attemptCount: 1 };
  }

  let row = await getStripeWebhookEvent(db, input.eventId);
  if (!row) {
    throw new Error("Stripe webhook event claim could not be read");
  }
  if (row.event_type !== input.eventType || row.livemode !== (input.livemode ? 1 : 0)) {
    return { kind: "CONFLICT", attemptCount: row.attempt_count };
  }
  if (row.status === "PROCESSED") {
    return { kind: "DUPLICATE", attemptCount: row.attempt_count };
  }

  const reclaimed = await db.prepare(
    `UPDATE stripe_webhook_events
        SET status = 'PROCESSING', attempt_count = attempt_count + 1,
            processing_claim_id = ?, failure_code = NULL, processed_at = NULL,
            updated_at = ?
      WHERE id = ? AND (
        status = 'FAILED'
        OR (status = 'PROCESSING' AND updated_at < ?)
      )`
  ).bind(
    input.claimId,
    input.now,
    input.eventId,
    stripeClaimStaleBefore(input.now)
  ).run();
  row = await getStripeWebhookEvent(db, input.eventId);
  if (!row) {
    throw new Error("Stripe webhook event reclaim could not be read");
  }
  if (Number(reclaimed.meta?.changes ?? 0) === 1) {
    return { kind: "CLAIMED", attemptCount: row.attempt_count };
  }
  return {
    kind: row.status === "PROCESSED" ? "DUPLICATE" : "BUSY",
    attemptCount: row.attempt_count
  };
}

async function getStripeWebhookEvent(
  db: D1Database,
  id: string
): Promise<StripeWebhookEventRow | null> {
  return db.prepare(
    `SELECT event_type, livemode, status, attempt_count
       FROM stripe_webhook_events WHERE id = ?`
  ).bind(id).first<StripeWebhookEventRow>();
}

export async function finalizeStripeWebhookEvent(
  db: D1Database,
  input: {
    eventId: string;
    claimId: string;
    outcome: "PROCESSED" | "FAILED";
    failureCode?: string | null;
    now: string;
  }
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE stripe_webhook_events
        SET status = ?, failure_code = ?, processed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'PROCESSING' AND processing_claim_id = ?`
  ).bind(
    input.outcome,
    input.failureCode ?? null,
    input.now,
    input.now,
    input.eventId,
    input.claimId
  ).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function recordStripeGiftAndAcknowledgment(
  db: D1Database,
  input: {
    giftId: string;
    acknowledgmentId: string;
    sourceType: "PAYMENT_INTENT" | "INVOICE";
    sourceId: string;
    checkoutId: string | null;
    stripePaymentIntentId: string | null;
    stripeInvoiceId: string | null;
    stripeSubscriptionId: string | null;
    frequency: StripeGiftFrequency;
    giftType: Exclude<StripeGiftType, "UNSPECIFIED">;
    amountCents: number;
    donorName: string | null;
    donorEmail: string | null;
    settledAt: string;
    now: string;
  }
): Promise<{ inserted: boolean; record: StripeGiftRecord }> {
  const giftStatement = db.prepare(
    `INSERT OR IGNORE INTO stripe_gifts (
       id, source_type, source_id, checkout_id, stripe_payment_intent_id,
       stripe_invoice_id, stripe_subscription_id, frequency, gift_type, amount_cents,
       currency, donor_name, donor_email, settled_at, status,
       refunded_amount_cents, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'usd', ?, ?, ?, 'PAID', 0, ?, ?)`
  ).bind(
    input.giftId,
    input.sourceType,
    input.sourceId,
    input.checkoutId,
    input.stripePaymentIntentId,
    input.stripeInvoiceId,
    input.stripeSubscriptionId,
    input.frequency,
    input.giftType,
    input.amountCents,
    input.donorName,
    input.donorEmail,
    input.settledAt,
    input.now,
    input.now
  );
  const acknowledgmentStatement = db.prepare(
    `INSERT OR IGNORE INTO stripe_acknowledgment_deliveries (
       id, gift_id, status, attempt_count, created_at, updated_at
     ) SELECT ?, id, 'PENDING', 0, ?, ?
         FROM stripe_gifts WHERE source_id = ?`
  ).bind(input.acknowledgmentId, input.now, input.now, input.sourceId);
  const [giftResult] = await db.batch([giftStatement, acknowledgmentStatement]);
  const record = await db.prepare(
    "SELECT * FROM stripe_gifts WHERE source_id = ?"
  ).bind(input.sourceId).first<StripeGiftRecord>();
  if (!record) {
    throw new Error("Settled Stripe gift could not be read");
  }
  if (!stripeGiftMatches(record, input)) {
    throw new StripeGiftConflictError();
  }
  return { inserted: Number(giftResult.meta?.changes ?? 0) === 1, record };
}

function stripeGiftMatches(
  record: StripeGiftRecord,
  input: Parameters<typeof recordStripeGiftAndAcknowledgment>[1]
): boolean {
  return record.source_type === input.sourceType
    && record.source_id === input.sourceId
    && record.checkout_id === input.checkoutId
    && record.stripe_payment_intent_id === input.stripePaymentIntentId
    && record.stripe_invoice_id === input.stripeInvoiceId
    && record.stripe_subscription_id === input.stripeSubscriptionId
    && record.frequency === input.frequency
    && record.gift_type === input.giftType
    && record.amount_cents === input.amountCents;
}

export async function claimNextStripeAcknowledgment(
  db: D1Database,
  input: { claimId: string; now: string }
): Promise<StripeAcknowledgmentClaim | null> {
  const staleBefore = stripeClaimStaleBefore(input.now);
  await db.prepare(
    `UPDATE stripe_acknowledgment_deliveries
        SET status = 'REVIEW', processing_claim_id = NULL,
            failure_code = 'provider_outcome_unknown_after_claim_timeout',
            retry_safe = 0, updated_at = ?
      WHERE status = 'PROCESSING' AND dispatch_started_at IS NOT NULL
        AND updated_at < ?`
  ).bind(input.now, staleBefore).run();
  const claimed = await db.prepare(
    `UPDATE stripe_acknowledgment_deliveries
        SET status = 'PROCESSING', processing_claim_id = ?,
            attempt_count = attempt_count + 1, last_attempt_at = ?,
            dispatch_started_at = NULL, retry_safe = 0, updated_at = ?
      WHERE id = (
        SELECT id FROM stripe_acknowledgment_deliveries
         WHERE status = 'PENDING'
            OR (status = 'FAILED' AND retry_safe = 1)
            OR (
              status = 'PROCESSING' AND dispatch_started_at IS NULL
              AND updated_at < ?
            )
         ORDER BY created_at, id
         LIMIT 1
      )
      RETURNING id`
  ).bind(input.claimId, input.now, input.now, staleBefore).first<{ id: string }>();
  if (!claimed) {
    return null;
  }
  return db.prepare(
    `SELECT delivery.id, delivery.gift_id, delivery.status,
            delivery.attempt_count, delivery.processing_claim_id,
            delivery.dispatch_started_at, gift.donor_name, gift.donor_email,
            gift.frequency, gift.gift_type, gift.amount_cents, gift.settled_at
       FROM stripe_acknowledgment_deliveries AS delivery
       JOIN stripe_gifts AS gift ON gift.id = delivery.gift_id
      WHERE delivery.id = ? AND delivery.processing_claim_id = ?`
  ).bind(claimed.id, input.claimId).first<StripeAcknowledgmentClaim>();
}

export async function markStripeAcknowledgmentDispatchStarted(
  db: D1Database,
  input: { id: string; claimId: string; now: string }
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE stripe_acknowledgment_deliveries
        SET dispatch_started_at = ?, updated_at = ?
      WHERE id = ? AND status = 'PROCESSING'
        AND processing_claim_id = ? AND dispatch_started_at IS NULL`
  ).bind(input.now, input.now, input.id, input.claimId).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function finalizeStripeAcknowledgment(
  db: D1Database,
  input: {
    id: string;
    claimId: string;
    outcome: "SENT" | "FAILED" | "REVIEW";
    providerIdHash?: string | null;
    failureCode?: string | null;
    retrySafe?: boolean;
    now: string;
  }
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE stripe_acknowledgment_deliveries
        SET status = ?, processing_claim_id = NULL, provider_id_hash = ?,
            failure_code = ?, retry_safe = ?, sent_at = ?, updated_at = ?
      WHERE id = ? AND status = 'PROCESSING' AND processing_claim_id = ?`
  ).bind(
    input.outcome,
    input.providerIdHash ?? null,
    input.failureCode ?? null,
    input.retrySafe ? 1 : 0,
    input.outcome === "SENT" ? input.now : null,
    input.now,
    input.id,
    input.claimId
  ).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function applyStripeRefund(
  db: D1Database,
  input: { stripePaymentIntentId: string; refundedAmountCents: number; now: string }
): Promise<StripeGiftRecord | null> {
  return db.prepare(
    `UPDATE stripe_gifts
        SET refunded_amount_cents = MAX(refunded_amount_cents, ?),
            status = CASE
              WHEN MAX(refunded_amount_cents, ?) = 0 THEN 'PAID'
              WHEN MAX(refunded_amount_cents, ?) >= amount_cents THEN 'REFUNDED'
              ELSE 'PARTIALLY_REFUNDED'
            END,
            updated_at = ?
      WHERE stripe_payment_intent_id = ? AND ? BETWEEN 0 AND amount_cents
      RETURNING *`
  ).bind(
    input.refundedAmountCents,
    input.refundedAmountCents,
    input.refundedAmountCents,
    input.now,
    input.stripePaymentIntentId,
    input.refundedAmountCents
  ).first<StripeGiftRecord>();
}

export async function getStripeGiftBySourceId(
  db: D1Database,
  sourceId: string
): Promise<StripeGiftRecord | null> {
  return db.prepare(
    "SELECT * FROM stripe_gifts WHERE source_id = ?"
  ).bind(sourceId).first<StripeGiftRecord>();
}

export async function attachStripeInvoicePaymentIntent(
  db: D1Database,
  input: { stripeInvoiceId: string; stripePaymentIntentId: string; now: string }
): Promise<StripeGiftRecord | null> {
  return db.prepare(
    `UPDATE stripe_gifts
        SET stripe_payment_intent_id = ?, updated_at = ?
      WHERE stripe_invoice_id = ?
        AND (stripe_payment_intent_id IS NULL OR stripe_payment_intent_id = ?)
      RETURNING *`
  ).bind(
    input.stripePaymentIntentId,
    input.now,
    input.stripeInvoiceId,
    input.stripePaymentIntentId
  ).first<StripeGiftRecord>();
}

function stripeClaimStaleBefore(now: string): string {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) {
    throw new Error("Stripe processing claim timestamp is invalid");
  }
  return new Date(timestamp - STRIPE_PROCESSING_CLAIM_LEASE_MS).toISOString();
}
