import { newId } from "../../utils/ids";

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
  creation_outcome_class: "DEFINITE_FAILURE" | "AMBIGUOUS" | null;
  idempotency_generation: number;
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
  checkout_event_created: number;
  checkout_event_rank: number;
  checkout_event_id: string | null;
  subscription_event_created: number;
  subscription_event_rank: number;
  subscription_event_id: string | null;
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
  revision: number;
  kind: "ORIGINAL" | "PARTIAL_REFUND" | "FULL_REFUND";
  evidence_refunded_amount_cents: number;
  snapshot_hash: string | null;
  snapshot_json: string | null;
}

export interface StripeAcknowledgmentReconciliationRecord {
  id: string;
  revision: number;
  kind: "ORIGINAL" | "PARTIAL_REFUND" | "FULL_REFUND";
  status: "FAILED" | "REVIEW";
  amount_cents: number;
  evidence_refunded_amount_cents: number;
  failure_code: string;
  created_at: string;
  updated_at: string;
}

export interface StripeInvoiceSettlementRecord {
  invoice_id: string;
  checkout_id: string | null;
  subscription_id: string | null;
  amount_cents: number | null;
  currency: "usd" | null;
  donor_name: string | null;
  donor_email: string | null;
  settled_at: string | null;
  invoice_livemode: 0 | 1 | null;
  invoice_event_id: string | null;
  invoice_payment_id: string | null;
  payment_intent_id: string | null;
  payment_amount_cents: number | null;
  payment_currency: "usd" | null;
  payment_livemode: 0 | 1 | null;
  payment_event_id: string | null;
  status: "PENDING" | "RECORDED" | "REVIEW";
  gift_id: string | null;
  failure_code: string | null;
  recorded_at: string | null;
  created_at: string;
  updated_at: string;
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
  await db.prepare(
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
  if (record.id === input.id) {
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

export async function attachStripeCheckoutSession(
  db: D1Database,
  input: {
    id: string;
    stripeSessionId: string;
    expiresAt: string;
    now: string;
  }
): Promise<StripeCheckoutRecord | null> {
  const existing = await getStripeCheckoutById(db, input.id);
  if (!existing) return null;
  if (existing.stripe_session_id) {
    return existing.stripe_session_id === input.stripeSessionId ? existing : null;
  }
  await db.prepare(
    `UPDATE stripe_checkout_sessions
        SET stripe_session_id = ?,
            status = CASE WHEN status = 'CREATING' THEN 'OPEN' ELSE status END,
            expires_at = ?,
            error_code = CASE WHEN status = 'CREATING' THEN NULL ELSE error_code END,
            creation_outcome_class = CASE
              WHEN status = 'CREATING' THEN NULL ELSE creation_outcome_class END,
            updated_at = ?
      WHERE id = ? AND stripe_session_id IS NULL`
  ).bind(input.stripeSessionId, input.expiresAt, input.now, input.id).run();
  const attached = await getStripeCheckoutById(db, input.id);
  return attached?.stripe_session_id === input.stripeSessionId ? attached : null;
}

export async function failStripeCheckoutCreation(
  db: D1Database,
  input: {
    id: string;
    errorCode: string;
    outcomeClass: "DEFINITE_FAILURE" | "AMBIGUOUS";
    now: string;
  }
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE stripe_checkout_sessions
        SET status = 'FAILED', error_code = ?, creation_outcome_class = ?, updated_at = ?
      WHERE id = ? AND status = 'CREATING' AND stripe_session_id IS NULL`
  ).bind(input.errorCode, input.outcomeClass, input.now, input.id).run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function reclaimStripeCheckoutCreation(
  db: D1Database,
  input: { id: string; requestFingerprint: string; now: string }
): Promise<StripeCheckoutRecord | null> {
  return db.prepare(
    `UPDATE stripe_checkout_sessions
        SET request_fingerprint = CASE
              WHEN creation_outcome_class = 'DEFINITE_FAILURE' THEN ?
              ELSE request_fingerprint END,
            status = 'CREATING', creation_attempt_count = creation_attempt_count + 1,
            idempotency_generation = idempotency_generation
              + CASE WHEN creation_outcome_class = 'DEFINITE_FAILURE' THEN 1 ELSE 0 END,
            creation_outcome_class = CASE
              WHEN creation_outcome_class = 'DEFINITE_FAILURE' THEN NULL
              ELSE creation_outcome_class END,
            error_code = NULL, updated_at = ?
      WHERE id = ? AND stripe_session_id IS NULL
        AND creation_attempt_count < 3
        AND (creation_outcome_class = 'DEFINITE_FAILURE' OR request_fingerprint = ?)
        AND (
          status = 'FAILED'
          OR (status = 'CREATING' AND updated_at < ?)
        )
      RETURNING *`
  ).bind(
    input.requestFingerprint,
    input.now,
    input.id,
    input.requestFingerprint,
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
    eventCreated: number;
    eventRank: number;
    eventId: string;
    subscriptionEventRank?: number;
    now: string;
  }
): Promise<StripeCheckoutRecord | null> {
  return db.prepare(
    `WITH incoming (
       event_created, event_rank, event_id, next_status, next_payment_status,
       customer_id, subscription_id, subscription_status, subscription_event_rank,
       payment_intent_id, donor_name, donor_email, completed_at, updated_at
     ) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
     UPDATE stripe_checkout_sessions
        SET status = CASE
              WHEN payment_status = 'PAID' OR (SELECT next_payment_status FROM incoming) = 'PAID'
                THEN 'COMPLETE'
              WHEN (SELECT event_created FROM incoming) > checkout_event_created
                OR ((SELECT event_created FROM incoming) = checkout_event_created
                  AND (SELECT event_rank FROM incoming) > checkout_event_rank)
                THEN (SELECT next_status FROM incoming)
              ELSE status
            END,
            payment_status = CASE
              WHEN payment_status = 'PAID' OR (SELECT next_payment_status FROM incoming) = 'PAID'
                THEN 'PAID'
              WHEN (SELECT event_created FROM incoming) > checkout_event_created
                OR ((SELECT event_created FROM incoming) = checkout_event_created
                  AND (SELECT event_rank FROM incoming) > checkout_event_rank)
                THEN (SELECT next_payment_status FROM incoming)
              ELSE payment_status
            END,
            stripe_customer_id = COALESCE((SELECT customer_id FROM incoming), stripe_customer_id),
            stripe_subscription_id = COALESCE((SELECT subscription_id FROM incoming), stripe_subscription_id),
            subscription_status = CASE
              WHEN subscription_status = 'CANCELED' THEN 'CANCELED'
              WHEN (SELECT subscription_status FROM incoming) IS NOT NULL
                AND ((SELECT event_created FROM incoming) > subscription_event_created
                  OR ((SELECT event_created FROM incoming) = subscription_event_created
                    AND (SELECT subscription_event_rank FROM incoming) > subscription_event_rank))
                THEN (SELECT subscription_status FROM incoming)
              ELSE subscription_status
            END,
            stripe_payment_intent_id = COALESCE((SELECT payment_intent_id FROM incoming), stripe_payment_intent_id),
            donor_name = COALESCE((SELECT donor_name FROM incoming), donor_name),
            donor_email = COALESCE((SELECT donor_email FROM incoming), donor_email),
            completed_at = COALESCE((SELECT completed_at FROM incoming), completed_at),
            checkout_event_created = CASE
              WHEN (SELECT event_created FROM incoming) > checkout_event_created
                OR ((SELECT event_created FROM incoming) = checkout_event_created
                  AND (SELECT event_rank FROM incoming) > checkout_event_rank)
                THEN (SELECT event_created FROM incoming)
              ELSE checkout_event_created
            END,
            checkout_event_rank = CASE
              WHEN (SELECT event_created FROM incoming) > checkout_event_created
                OR ((SELECT event_created FROM incoming) = checkout_event_created
                  AND (SELECT event_rank FROM incoming) > checkout_event_rank)
                THEN (SELECT event_rank FROM incoming)
              ELSE checkout_event_rank
            END,
            checkout_event_id = CASE
              WHEN (SELECT event_created FROM incoming) > checkout_event_created
                OR ((SELECT event_created FROM incoming) = checkout_event_created
                  AND (SELECT event_rank FROM incoming) > checkout_event_rank)
                THEN (SELECT event_id FROM incoming)
              ELSE checkout_event_id
            END,
            subscription_event_created = CASE
              WHEN subscription_status IS NOT 'CANCELED'
                AND (SELECT subscription_status FROM incoming) IS NOT NULL
                AND ((SELECT event_created FROM incoming) > subscription_event_created
                  OR ((SELECT event_created FROM incoming) = subscription_event_created
                    AND (SELECT subscription_event_rank FROM incoming) > subscription_event_rank))
                THEN (SELECT event_created FROM incoming)
              ELSE subscription_event_created
            END,
            subscription_event_rank = CASE
              WHEN subscription_status IS NOT 'CANCELED'
                AND (SELECT subscription_status FROM incoming) IS NOT NULL
                AND ((SELECT event_created FROM incoming) > subscription_event_created
                  OR ((SELECT event_created FROM incoming) = subscription_event_created
                    AND (SELECT subscription_event_rank FROM incoming) > subscription_event_rank))
                THEN (SELECT subscription_event_rank FROM incoming)
              ELSE subscription_event_rank
            END,
            subscription_event_id = CASE
              WHEN subscription_status IS NOT 'CANCELED'
                AND (SELECT subscription_status FROM incoming) IS NOT NULL
                AND ((SELECT event_created FROM incoming) > subscription_event_created
                  OR ((SELECT event_created FROM incoming) = subscription_event_created
                    AND (SELECT subscription_event_rank FROM incoming) > subscription_event_rank))
                THEN (SELECT event_id FROM incoming)
              ELSE subscription_event_id
            END,
            updated_at = (SELECT updated_at FROM incoming)
      WHERE stripe_session_id = ?
      RETURNING *`
  ).bind(
    input.eventCreated,
    input.eventRank,
    input.eventId,
    input.status,
    input.paymentStatus,
    input.stripeCustomerId,
    input.stripeSubscriptionId,
    input.subscriptionStatus ?? null,
    input.subscriptionEventRank ?? null,
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
    eventCreated: number;
    eventRank: number;
    eventId: string;
    now: string;
  }
): Promise<StripeCheckoutRecord | null> {
  return db.prepare(
    `UPDATE stripe_checkout_sessions
        SET subscription_status = CASE
              WHEN ? > subscription_event_created
                OR (? = subscription_event_created AND ? > subscription_event_rank)
                THEN ? ELSE subscription_status END,
            subscription_event_created = CASE
              WHEN ? > subscription_event_created
                OR (? = subscription_event_created AND ? > subscription_event_rank)
                THEN ? ELSE subscription_event_created END,
            subscription_event_rank = CASE
              WHEN ? > subscription_event_created
                OR (? = subscription_event_created AND ? > subscription_event_rank)
                THEN ? ELSE subscription_event_rank END,
            subscription_event_id = CASE
              WHEN ? > subscription_event_created
                OR (? = subscription_event_created AND ? > subscription_event_rank)
                THEN ? ELSE subscription_event_id END,
            updated_at = ?
      WHERE stripe_subscription_id = ? AND frequency = 'MONTHLY'
      RETURNING *`
  ).bind(
    input.eventCreated,
    input.eventCreated,
    input.eventRank,
    input.status,
    input.eventCreated,
    input.eventCreated,
    input.eventRank,
    input.eventCreated,
    input.eventCreated,
    input.eventCreated,
    input.eventRank,
    input.eventRank,
    input.eventCreated,
    input.eventCreated,
    input.eventRank,
    input.eventId,
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
    eventCreated: number;
    eventRank: number;
    eventId: string;
    now: string;
  }
): Promise<StripeCheckoutRecord | null> {
  return db.prepare(
    `WITH incoming (
       settled, customer_id, subscription_id, subscription_status,
       donor_name, donor_email, completed_at, event_created, event_rank,
       event_id, updated_at
     ) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
     UPDATE stripe_checkout_sessions
        SET status = CASE WHEN (SELECT settled FROM incoming) = 1 THEN 'COMPLETE' ELSE status END,
            payment_status = CASE WHEN (SELECT settled FROM incoming) = 1 THEN 'PAID' ELSE payment_status END,
            stripe_customer_id = COALESCE((SELECT customer_id FROM incoming), stripe_customer_id),
            stripe_subscription_id = COALESCE(stripe_subscription_id, (SELECT subscription_id FROM incoming)),
            subscription_status = CASE
              WHEN subscription_status = 'CANCELED' THEN 'CANCELED'
              WHEN (SELECT event_created FROM incoming) > subscription_event_created
                OR ((SELECT event_created FROM incoming) = subscription_event_created
                  AND (SELECT event_rank FROM incoming) > subscription_event_rank)
                THEN (SELECT subscription_status FROM incoming)
              ELSE subscription_status
            END,
            donor_name = COALESCE((SELECT donor_name FROM incoming), donor_name),
            donor_email = COALESCE((SELECT donor_email FROM incoming), donor_email),
            completed_at = CASE
              WHEN (SELECT settled FROM incoming) = 1
                THEN COALESCE((SELECT completed_at FROM incoming), completed_at)
              ELSE completed_at
            END,
            subscription_event_created = CASE
              WHEN subscription_status IS NOT 'CANCELED'
                AND ((SELECT event_created FROM incoming) > subscription_event_created
                  OR ((SELECT event_created FROM incoming) = subscription_event_created
                    AND (SELECT event_rank FROM incoming) > subscription_event_rank))
                THEN (SELECT event_created FROM incoming)
              ELSE subscription_event_created
            END,
            subscription_event_rank = CASE
              WHEN subscription_status IS NOT 'CANCELED'
                AND ((SELECT event_created FROM incoming) > subscription_event_created
                  OR ((SELECT event_created FROM incoming) = subscription_event_created
                    AND (SELECT event_rank FROM incoming) > subscription_event_rank))
                THEN (SELECT event_rank FROM incoming)
              ELSE subscription_event_rank
            END,
            subscription_event_id = CASE
              WHEN subscription_status IS NOT 'CANCELED'
                AND ((SELECT event_created FROM incoming) > subscription_event_created
                  OR ((SELECT event_created FROM incoming) = subscription_event_created
                    AND (SELECT event_rank FROM incoming) > subscription_event_rank))
                THEN (SELECT event_id FROM incoming)
              ELSE subscription_event_id
            END,
            updated_at = (SELECT updated_at FROM incoming)
      WHERE id = ? AND frequency = 'MONTHLY'
        AND (stripe_subscription_id IS NULL OR stripe_subscription_id = ?)
      RETURNING *`
  ).bind(
    input.settled ? 1 : 0,
    input.stripeCustomerId,
    input.stripeSubscriptionId,
    input.subscriptionStatus,
    input.donorName,
    input.donorEmail,
    input.completedAt,
    input.eventCreated,
    input.eventRank,
    input.eventId,
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
    verifiedSecretSlot: "ACTIVE" | "NEXT";
    verifiedSecretGeneration: string;
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
       verified_secret_slot, verified_secret_generation, received_at, updated_at
     ) VALUES (?, ?, ?, 'PROCESSING', 1, ?, ?, ?, ?, ?)`
  ).bind(
    input.eventId,
    input.eventType,
    input.livemode ? 1 : 0,
    input.claimId,
    input.verifiedSecretSlot,
    input.verifiedSecretGeneration,
    input.now,
    input.now
  ).run();
  if (Number(inserted.meta?.changes ?? 0) > 0) {
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
            verified_secret_slot = ?, verified_secret_generation = ?,
            updated_at = ?
      WHERE id = ? AND (
        status = 'FAILED'
        OR (status = 'PROCESSING' AND updated_at < ?)
      )`
  ).bind(
    input.claimId,
    input.verifiedSecretSlot,
    input.verifiedSecretGeneration,
    input.now,
    input.eventId,
    stripeClaimStaleBefore(input.now)
  ).run();
  row = await getStripeWebhookEvent(db, input.eventId);
  if (!row) {
    throw new Error("Stripe webhook event reclaim could not be read");
  }
  if (Number(reclaimed.meta?.changes ?? 0) > 0) {
    return { kind: "CLAIMED", attemptCount: row.attempt_count };
  }
  return {
    kind: row.status === "PROCESSED" ? "DUPLICATE" : "BUSY",
    attemptCount: row.attempt_count
  };
}

export async function hasRecentStripeWebhookSecretVerification(
  db: D1Database,
  input: { livemode: boolean; generation: string; receivedAfter: string }
): Promise<boolean> {
  const row = await db.prepare(
    `SELECT id
       FROM stripe_webhook_events
      WHERE status = 'PROCESSED'
        AND livemode = ?
        AND verified_secret_slot = 'NEXT'
        AND verified_secret_generation = ?
        AND received_at >= ?
      ORDER BY received_at DESC, id DESC
      LIMIT 1`
  ).bind(input.livemode ? 1 : 0, input.generation, input.receivedAfter).first<{ id: string }>();
  return row !== null;
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
  return Number(result.meta?.changes ?? 0) > 0;
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
): Promise<{ inserted: boolean; record: StripeGiftRecord; acknowledgmentId: string }> {
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
       id, gift_id, revision, kind, evidence_refunded_amount_cents,
       status, attempt_count, created_at, updated_at
     ) SELECT ?, id, 1, 'ORIGINAL', 0, 'PENDING', 0, ?, ?
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
  const acknowledgment = await db.prepare(
    `SELECT id FROM stripe_acknowledgment_deliveries
      WHERE gift_id = ? AND evidence_refunded_amount_cents = 0`
  ).bind(record.id).first<{ id: string }>();
  if (!acknowledgment) throw new Error("Stripe acknowledgment could not be read");
  return {
    inserted: Number(giftResult.meta?.changes ?? 0) > 0,
    record,
    acknowledgmentId: acknowledgment.id
  };
}

export async function stageStripeInvoicePaid(
  db: D1Database,
  input: {
    invoiceId: string;
    checkoutId: string;
    subscriptionId: string;
    amountCents: number;
    donorName: string | null;
    donorEmail: string | null;
    settledAt: string;
    livemode: boolean;
    eventId: string;
    now: string;
  }
): Promise<StripeInvoiceSettlementRecord> {
  const row = await db.prepare(
    `INSERT INTO stripe_invoice_settlements (
       invoice_id, checkout_id, subscription_id, amount_cents, currency,
       donor_name, donor_email, settled_at, invoice_livemode, invoice_event_id,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'usd', ?, ?, ?, ?, ?, 'PENDING', ?, ?)
     ON CONFLICT(invoice_id) DO UPDATE SET
       checkout_id = excluded.checkout_id,
       subscription_id = excluded.subscription_id,
       amount_cents = excluded.amount_cents,
       currency = excluded.currency,
       donor_name = excluded.donor_name,
       donor_email = excluded.donor_email,
       settled_at = excluded.settled_at,
       invoice_livemode = excluded.invoice_livemode,
       invoice_event_id = excluded.invoice_event_id,
       updated_at = excluded.updated_at
     WHERE stripe_invoice_settlements.status <> 'REVIEW'
       AND (stripe_invoice_settlements.checkout_id IS NULL
         OR stripe_invoice_settlements.checkout_id = excluded.checkout_id)
       AND (stripe_invoice_settlements.subscription_id IS NULL
         OR stripe_invoice_settlements.subscription_id = excluded.subscription_id)
       AND (stripe_invoice_settlements.amount_cents IS NULL
         OR stripe_invoice_settlements.amount_cents = excluded.amount_cents)
       AND (stripe_invoice_settlements.currency IS NULL
         OR stripe_invoice_settlements.currency = excluded.currency)
       AND (stripe_invoice_settlements.invoice_livemode IS NULL
         OR stripe_invoice_settlements.invoice_livemode = excluded.invoice_livemode)
       AND (stripe_invoice_settlements.invoice_event_id IS NULL
         OR stripe_invoice_settlements.invoice_event_id = excluded.invoice_event_id)
     RETURNING *`
  ).bind(
    input.invoiceId,
    input.checkoutId,
    input.subscriptionId,
    input.amountCents,
    input.donorName,
    input.donorEmail,
    input.settledAt,
    input.livemode ? 1 : 0,
    input.eventId,
    input.now,
    input.now
  ).first<StripeInvoiceSettlementRecord>();
  if (!row) throw new Error("Stripe invoice settlement identity conflicts");
  return row;
}

export async function stageStripeInvoicePayment(
  db: D1Database,
  input: {
    invoiceId: string;
    invoicePaymentId: string;
    paymentIntentId: string;
    amountCents: number;
    livemode: boolean;
    eventId: string;
    now: string;
  }
): Promise<StripeInvoiceSettlementRecord> {
  const row = await db.prepare(
    `INSERT INTO stripe_invoice_settlements (
       invoice_id, invoice_payment_id, payment_intent_id,
       payment_amount_cents, payment_currency, payment_livemode, payment_event_id,
       status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'usd', ?, ?, 'PENDING', ?, ?)
     ON CONFLICT(invoice_id) DO UPDATE SET
       invoice_payment_id = excluded.invoice_payment_id,
       payment_intent_id = excluded.payment_intent_id,
       payment_amount_cents = excluded.payment_amount_cents,
       payment_currency = excluded.payment_currency,
       payment_livemode = excluded.payment_livemode,
       payment_event_id = excluded.payment_event_id,
       updated_at = excluded.updated_at
     WHERE stripe_invoice_settlements.status <> 'REVIEW'
       AND (stripe_invoice_settlements.invoice_payment_id IS NULL
         OR stripe_invoice_settlements.invoice_payment_id = excluded.invoice_payment_id)
       AND (stripe_invoice_settlements.payment_intent_id IS NULL
         OR stripe_invoice_settlements.payment_intent_id = excluded.payment_intent_id)
       AND (stripe_invoice_settlements.payment_amount_cents IS NULL
         OR stripe_invoice_settlements.payment_amount_cents = excluded.payment_amount_cents)
       AND (stripe_invoice_settlements.payment_currency IS NULL
         OR stripe_invoice_settlements.payment_currency = excluded.payment_currency)
       AND (stripe_invoice_settlements.payment_livemode IS NULL
         OR stripe_invoice_settlements.payment_livemode = excluded.payment_livemode)
       AND (stripe_invoice_settlements.payment_event_id IS NULL
         OR stripe_invoice_settlements.payment_event_id = excluded.payment_event_id)
     RETURNING *`
  ).bind(
    input.invoiceId,
    input.invoicePaymentId,
    input.paymentIntentId,
    input.amountCents,
    input.livemode ? 1 : 0,
    input.eventId,
    input.now,
    input.now
  ).first<StripeInvoiceSettlementRecord>();
  if (!row) throw new Error("Stripe invoice payment identity conflicts");
  return row;
}

export async function markStripeInvoiceSettlementRecorded(
  db: D1Database,
  input: { invoiceId: string; giftId: string; now: string }
): Promise<void> {
  await db.prepare(
    `UPDATE stripe_invoice_settlements
        SET status = 'RECORDED', gift_id = ?, failure_code = NULL,
            recorded_at = ?, updated_at = ?
      WHERE invoice_id = ? AND status IN ('PENDING', 'RECORDED')
        AND (gift_id IS NULL OR gift_id = ?)`
  ).bind(input.giftId, input.now, input.now, input.invoiceId, input.giftId).run();
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
  await db.prepare(
    `UPDATE stripe_acknowledgment_deliveries
        SET status = 'REVIEW', processing_claim_id = NULL,
            failure_code = 'acknowledgment_retry_exhausted',
            retry_safe = 0, next_attempt_at = NULL, updated_at = ?
      WHERE attempt_count >= 5 AND (
        (status = 'FAILED' AND retry_safe = 1)
        OR (status = 'PROCESSING' AND dispatch_started_at IS NULL AND updated_at < ?)
      )`
  ).bind(input.now, staleBefore).run();
  const claimed = await db.prepare(
    `UPDATE stripe_acknowledgment_deliveries
        SET status = 'PROCESSING', processing_claim_id = ?,
            attempt_count = attempt_count + 1, last_attempt_at = ?,
            dispatch_started_at = NULL, retry_safe = 0,
            next_attempt_at = NULL, updated_at = ?
      WHERE id = (
        SELECT stripe_acknowledgment_deliveries.id
          FROM stripe_acknowledgment_deliveries
          JOIN stripe_gifts AS gift ON gift.id = stripe_acknowledgment_deliveries.gift_id
         WHERE stripe_acknowledgment_deliveries.attempt_count < 5
           AND stripe_acknowledgment_deliveries.evidence_refunded_amount_cents = gift.refunded_amount_cents
           AND COALESCE(stripe_acknowledgment_deliveries.next_attempt_at,
                        stripe_acknowledgment_deliveries.created_at) <= ?
           AND (stripe_acknowledgment_deliveries.status = 'PENDING'
            OR (stripe_acknowledgment_deliveries.status = 'FAILED'
              AND stripe_acknowledgment_deliveries.retry_safe = 1)
            OR (
              stripe_acknowledgment_deliveries.status = 'PROCESSING'
              AND stripe_acknowledgment_deliveries.dispatch_started_at IS NULL
              AND stripe_acknowledgment_deliveries.updated_at < ?
            ))
         ORDER BY COALESCE(stripe_acknowledgment_deliveries.next_attempt_at,
                           stripe_acknowledgment_deliveries.created_at),
                  stripe_acknowledgment_deliveries.created_at,
                  stripe_acknowledgment_deliveries.id
         LIMIT 1
      )
      RETURNING id`
  ).bind(input.claimId, input.now, input.now, input.now, staleBefore).first<{ id: string }>();
  if (!claimed) {
    return null;
  }
  return db.prepare(
    `SELECT delivery.id, delivery.gift_id, delivery.status,
            delivery.attempt_count, delivery.processing_claim_id,
            delivery.dispatch_started_at, delivery.revision, delivery.kind,
            delivery.evidence_refunded_amount_cents,
            delivery.snapshot_hash, delivery.snapshot_json,
            gift.donor_name, gift.donor_email,
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
        AND processing_claim_id = ? AND dispatch_started_at IS NULL
        AND EXISTS (
          SELECT 1 FROM stripe_gifts AS gift
           WHERE gift.id = stripe_acknowledgment_deliveries.gift_id
             AND gift.refunded_amount_cents = stripe_acknowledgment_deliveries.evidence_refunded_amount_cents
        )`
  ).bind(input.now, input.now, input.id, input.claimId).run();
  return Number(result.meta?.changes ?? 0) > 0;
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
    retryAt?: string | null;
    now: string;
  }
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE stripe_acknowledgment_deliveries
        SET status = CASE
              WHEN ? = 'FAILED' AND ? = 1 AND attempt_count >= 5 THEN 'REVIEW'
              ELSE ? END,
            processing_claim_id = NULL, provider_id_hash = ?,
            failure_code = CASE
              WHEN ? = 'FAILED' AND ? = 1 AND attempt_count >= 5
                THEN 'acknowledgment_retry_exhausted'
              ELSE ? END,
            retry_safe = CASE
              WHEN ? = 'FAILED' AND ? = 1 AND attempt_count < 5 THEN 1 ELSE 0 END,
            next_attempt_at = CASE
              WHEN ? = 'FAILED' AND ? = 1 AND attempt_count < 5 THEN ? ELSE NULL END,
            sent_at = ?, updated_at = ?
      WHERE id = ? AND status = 'PROCESSING' AND processing_claim_id = ?`
  ).bind(
    input.outcome,
    input.retrySafe ? 1 : 0,
    input.outcome,
    input.providerIdHash ?? null,
    input.outcome,
    input.retrySafe ? 1 : 0,
    input.failureCode ?? null,
    input.outcome,
    input.retrySafe ? 1 : 0,
    input.outcome,
    input.retrySafe ? 1 : 0,
    input.retryAt ?? null,
    input.outcome === "SENT" ? input.now : null,
    input.now,
    input.id,
    input.claimId
  ).run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function applyStripeRefund(
  db: D1Database,
  input: { stripePaymentIntentId: string; refundedAmountCents: number; now: string }
): Promise<StripeGiftRecord | null> {
  const acknowledgmentId = newId("stripe_ack");
  await db.batch([
    db.prepare(
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
  ),
    db.prepare(
      `UPDATE stripe_acknowledgment_deliveries
          SET status = CASE
                WHEN status = 'PROCESSING' AND dispatch_started_at IS NOT NULL THEN 'REVIEW'
                ELSE 'FAILED' END,
              processing_claim_id = NULL,
              failure_code = CASE
                WHEN status = 'PROCESSING' AND dispatch_started_at IS NOT NULL
                  THEN 'provider_outcome_unknown_after_refund'
                ELSE 'superseded_by_refund' END,
              retry_safe = 0, next_attempt_at = NULL, updated_at = ?
        WHERE gift_id = (
          SELECT id FROM stripe_gifts WHERE stripe_payment_intent_id = ?
        )
          AND evidence_refunded_amount_cents <> (
            SELECT refunded_amount_cents FROM stripe_gifts WHERE stripe_payment_intent_id = ?
          )
          AND (status = 'PENDING'
            OR (status = 'FAILED' AND retry_safe = 1)
            OR status = 'PROCESSING')`
    ).bind(input.now, input.stripePaymentIntentId, input.stripePaymentIntentId),
    db.prepare(
      `INSERT OR IGNORE INTO stripe_acknowledgment_deliveries (
         id, gift_id, revision, kind, supersedes_delivery_id,
         evidence_refunded_amount_cents, status, attempt_count,
         created_at, updated_at
       )
       SELECT ?, gift.id,
              COALESCE((SELECT MAX(revision) + 1
                          FROM stripe_acknowledgment_deliveries
                         WHERE gift_id = gift.id), 1),
              CASE WHEN gift.refunded_amount_cents >= gift.amount_cents
                   THEN 'FULL_REFUND' ELSE 'PARTIAL_REFUND' END,
              (SELECT id FROM stripe_acknowledgment_deliveries
                WHERE gift_id = gift.id AND status = 'SENT'
                ORDER BY revision DESC LIMIT 1),
              gift.refunded_amount_cents, 'PENDING', 0, ?, ?
         FROM stripe_gifts AS gift
        WHERE gift.stripe_payment_intent_id = ?
          AND gift.refunded_amount_cents > 0`
    ).bind(acknowledgmentId, input.now, input.now, input.stripePaymentIntentId)
  ]);
  return db.prepare(
    "SELECT * FROM stripe_gifts WHERE stripe_payment_intent_id = ?"
  ).bind(input.stripePaymentIntentId).first<StripeGiftRecord>();
}

export async function saveStripeAcknowledgmentSnapshot(
  db: D1Database,
  input: { id: string; snapshotHash: string; snapshotJson: string; now: string }
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE stripe_acknowledgment_deliveries
        SET snapshot_hash = ?, snapshot_json = ?, updated_at = ?
      WHERE id = ? AND snapshot_hash IS NULL AND snapshot_json IS NULL
        AND status IN ('PENDING', 'PROCESSING', 'FAILED')`
  ).bind(input.snapshotHash, input.snapshotJson, input.now, input.id).run();
  return Number(result.meta?.changes ?? 0) > 0;
}

export async function getStripeAcknowledgmentEvidenceSource(
  db: D1Database,
  id: string
): Promise<(StripeAcknowledgmentClaim & { status: string; processing_claim_id: string | null }) | null> {
  return db.prepare(
    `SELECT delivery.id, delivery.gift_id, delivery.status,
            delivery.attempt_count, delivery.processing_claim_id,
            delivery.dispatch_started_at, delivery.revision, delivery.kind,
            delivery.evidence_refunded_amount_cents,
            delivery.snapshot_hash, delivery.snapshot_json,
            gift.donor_name, gift.donor_email, gift.frequency, gift.gift_type,
            gift.amount_cents, gift.settled_at
       FROM stripe_acknowledgment_deliveries AS delivery
       JOIN stripe_gifts AS gift ON gift.id = delivery.gift_id
      WHERE delivery.id = ?`
  ).bind(id).first<StripeAcknowledgmentClaim & { status: string; processing_claim_id: string | null }>();
}

export async function getStripeAcknowledgmentForGiftEvidence(
  db: D1Database,
  giftId: string,
  refundedAmountCents: number
): Promise<{ id: string } | null> {
  return db.prepare(
    `SELECT id FROM stripe_acknowledgment_deliveries
      WHERE gift_id = ? AND evidence_refunded_amount_cents = ?`
  ).bind(giftId, refundedAmountCents).first<{ id: string }>();
}

export async function listStripeAcknowledgmentReconciliation(
  db: D1Database
): Promise<StripeAcknowledgmentReconciliationRecord[]> {
  const rows = await db.prepare(
    `SELECT delivery.id, delivery.revision, delivery.kind, delivery.status,
            gift.amount_cents, delivery.evidence_refunded_amount_cents,
            delivery.failure_code, delivery.created_at, delivery.updated_at
       FROM stripe_acknowledgment_deliveries AS delivery
       JOIN stripe_gifts AS gift ON gift.id = delivery.gift_id
      WHERE delivery.status IN ('FAILED', 'REVIEW')
      ORDER BY delivery.updated_at DESC, delivery.id DESC
      LIMIT 50`
  ).all<StripeAcknowledgmentReconciliationRecord>();
  return rows.results ?? [];
}

export async function reconcileStripeAcknowledgment(
  db: D1Database,
  input: {
    id: string;
    resolution: "CONFIRMED_SENT" | "CONFIRMED_NOT_SENT";
    now: string;
  }
): Promise<boolean> {
  const result = await db.prepare(
    `UPDATE stripe_acknowledgment_deliveries
        SET status = CASE WHEN ? = 'CONFIRMED_SENT' THEN 'SENT' ELSE 'FAILED' END,
            processing_claim_id = NULL,
            dispatch_started_at = CASE
              WHEN ? = 'CONFIRMED_SENT' THEN COALESCE(dispatch_started_at, ?) ELSE NULL END,
            provider_id_hash = CASE WHEN ? = 'CONFIRMED_SENT'
              THEN COALESCE(provider_id_hash, 'owner-confirmed') ELSE NULL END,
            failure_code = CASE WHEN ? = 'CONFIRMED_SENT'
              THEN NULL ELSE 'owner_confirmed_not_sent' END,
            retry_safe = CASE WHEN ? = 'CONFIRMED_NOT_SENT' THEN 1 ELSE 0 END,
            next_attempt_at = CASE WHEN ? = 'CONFIRMED_NOT_SENT' THEN ? ELSE NULL END,
            sent_at = CASE WHEN ? = 'CONFIRMED_SENT' THEN COALESCE(sent_at, ?) ELSE NULL END,
            updated_at = ?
      WHERE id = ? AND status IN ('FAILED', 'REVIEW')
        AND (? = 'CONFIRMED_SENT' OR EXISTS (
          SELECT 1 FROM stripe_gifts AS gift
           WHERE gift.id = stripe_acknowledgment_deliveries.gift_id
             AND gift.refunded_amount_cents = stripe_acknowledgment_deliveries.evidence_refunded_amount_cents
        ))`
  ).bind(
    input.resolution,
    input.resolution,
    input.now,
    input.resolution,
    input.resolution,
    input.resolution,
    input.resolution,
    input.now,
    input.resolution,
    input.now,
    input.now,
    input.id,
    input.resolution
  ).run();
  return Number(result.meta?.changes ?? 0) > 0;
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
