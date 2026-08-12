import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimNextStripeAcknowledgment,
  claimStripeWebhookEvent,
  completeStripeCheckoutCreation,
  failStripeCheckoutCreation,
  finalizeStripeAcknowledgment,
  finalizeStripeWebhookEvent,
  markStripeAcknowledgmentDispatchStarted,
  reclaimStripeCheckoutCreation,
  recordStripeGiftAndAcknowledgment,
  reserveStripeCheckout,
  type StripeCheckoutRecord
} from "../../src/worker/storage/repository/stripeDonations";
import { migratedDatabase } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";

describe("Stripe donation repository", () => {
  let database: ReturnType<typeof migratedDatabase>;
  let db: D1Database;
  const webhookVerification = {
    verifiedSecretSlot: "ACTIVE" as const,
    verifiedSecretGeneration: "a".repeat(64)
  };

  beforeEach(() => {
    database = migratedDatabase();
    db = sqliteD1(database);
  });

  afterEach(() => database.close());

  it("reserves one Checkout identity and detects a conflicting client replay", async () => {
    const first = await reserveStripeCheckout(db, checkoutInput());
    expect(first.kind).toBe("CREATED");
    expect(first.record).toMatchObject({
      id: "stripe_checkout_one",
      request_id: "0c2e2165-edb7-4e4b-bc50-95a7fa3cdfe5",
      request_fingerprint: "once:tithe:5000",
      gift_type: "TITHE",
      status: "CREATING"
    });

    expect(await reserveStripeCheckout(db, checkoutInput({ id: "unused_second_id" })))
      .toMatchObject({ kind: "EXISTING", record: { id: "stripe_checkout_one" } });
    expect(await reserveStripeCheckout(db, checkoutInput({
      id: "unused_conflict_id",
      requestFingerprint: "monthly:5000",
      frequency: "MONTHLY"
    }))).toMatchObject({ kind: "CONFLICT", record: { id: "stripe_checkout_one" } });
  });

  it("recognizes successful Checkout writes when D1 counts retention-trigger side effects", async () => {
    const triggerCountingDb = withInflatedChanges(db);
    expect(await reserveStripeCheckout(triggerCountingDb, checkoutInput()))
      .toMatchObject({ kind: "CREATED", record: { id: "stripe_checkout_one" } });
    expect(await completeStripeCheckoutCreation(triggerCountingDb, {
      id: "stripe_checkout_one",
      stripeSessionId: "cs_test_trigger_count",
      expiresAt: "2026-08-10T13:00:00.000Z",
      now: "2026-08-10T12:00:01.000Z"
    })).toBe(true);
  });

  it("finalizes Checkout creation only once under the reservation identity", async () => {
    await reserveStripeCheckout(db, checkoutInput());
    expect(await completeStripeCheckoutCreation(db, {
      id: "stripe_checkout_one",
      stripeSessionId: "cs_test_fixture",
      expiresAt: "2026-08-10T13:00:00.000Z",
      now: "2026-08-10T12:00:01.000Z"
    })).toBe(true);
    expect(await completeStripeCheckoutCreation(db, {
      id: "stripe_checkout_one",
      stripeSessionId: "cs_test_different",
      expiresAt: "2026-08-10T13:00:00.000Z",
      now: "2026-08-10T12:00:02.000Z"
    })).toBe(false);

    const row = database.prepare(
      "SELECT * FROM stripe_checkout_sessions WHERE id = 'stripe_checkout_one'"
    ).get() as unknown as StripeCheckoutRecord;
    expect(row).toMatchObject({
      stripe_session_id: "cs_test_fixture",
      status: "OPEN",
      updated_at: "2026-08-10T12:00:01.000Z"
    });
  });

  it("atomically retries a failed Checkout reservation without allowing an unbounded loop", async () => {
    await reserveStripeCheckout(db, checkoutInput());
    expect(await failStripeCheckoutCreation(db, {
      outcomeClass: "AMBIGUOUS",
      id: "stripe_checkout_one",
      errorCode: "temporary_one",
      now: "2026-08-10T12:00:01.000Z"
    })).toBe(true);
    expect(await reclaimStripeCheckoutCreation(db, {
      id: "stripe_checkout_one",
      now: "2026-08-10T12:00:02.000Z"
    })).toMatchObject({ status: "CREATING", creation_attempt_count: 2, error_code: null });
    expect(await failStripeCheckoutCreation(db, {
      outcomeClass: "AMBIGUOUS",
      id: "stripe_checkout_one",
      errorCode: "temporary_two",
      now: "2026-08-10T12:00:03.000Z"
    })).toBe(true);
    expect(await reclaimStripeCheckoutCreation(db, {
      id: "stripe_checkout_one",
      now: "2026-08-10T12:00:04.000Z"
    })).toMatchObject({ status: "CREATING", creation_attempt_count: 3, error_code: null });
    expect(await failStripeCheckoutCreation(db, {
      outcomeClass: "AMBIGUOUS",
      id: "stripe_checkout_one",
      errorCode: "temporary_three",
      now: "2026-08-10T12:00:05.000Z"
    })).toBe(true);
    expect(await reclaimStripeCheckoutCreation(db, {
      id: "stripe_checkout_one",
      now: "2026-08-10T12:00:06.000Z"
    })).toBeNull();
  });

  it("reclaims a Checkout creation claim only after its lease expires", async () => {
    await reserveStripeCheckout(db, checkoutInput());
    expect(await reclaimStripeCheckoutCreation(db, {
      id: "stripe_checkout_one",
      now: "2026-08-10T12:04:59.000Z"
    })).toBeNull();
    expect(await reclaimStripeCheckoutCreation(db, {
      id: "stripe_checkout_one",
      now: "2026-08-10T12:05:01.000Z"
    })).toMatchObject({
      status: "CREATING",
      creation_attempt_count: 2,
      error_code: null,
      updated_at: "2026-08-10T12:05:01.000Z"
    });
  });

  it("claims failed webhook events for retry but fences processing and completed replays", async () => {
    const first = await claimStripeWebhookEvent(db, {
      ...webhookVerification,
      eventId: "evt_fixture",
      eventType: "checkout.session.completed",
      livemode: false,
      claimId: "claim_one",
      now: "2026-08-10T12:00:00.000Z"
    });
    expect(first).toEqual({ kind: "CLAIMED", attemptCount: 1 });
    expect(await claimStripeWebhookEvent(db, {
      ...webhookVerification,
      eventId: "evt_fixture",
      eventType: "checkout.session.completed",
      livemode: false,
      claimId: "claim_busy",
      now: "2026-08-10T12:00:01.000Z"
    })).toEqual({ kind: "BUSY", attemptCount: 1 });

    expect(await finalizeStripeWebhookEvent(db, {
      eventId: "evt_fixture",
      claimId: "claim_one",
      outcome: "FAILED",
      failureCode: "temporary_failure",
      now: "2026-08-10T12:00:02.000Z"
    })).toBe(true);
    expect(await claimStripeWebhookEvent(db, {
      ...webhookVerification,
      eventId: "evt_fixture",
      eventType: "checkout.session.completed",
      livemode: false,
      claimId: "claim_two",
      now: "2026-08-10T12:00:03.000Z"
    })).toEqual({ kind: "CLAIMED", attemptCount: 2 });
    expect(await finalizeStripeWebhookEvent(db, {
      eventId: "evt_fixture",
      claimId: "claim_two",
      outcome: "PROCESSED",
      now: "2026-08-10T12:00:04.000Z"
    })).toBe(true);
    expect(await claimStripeWebhookEvent(db, {
      ...webhookVerification,
      eventId: "evt_fixture",
      eventType: "checkout.session.completed",
      livemode: false,
      claimId: "claim_after_done",
      now: "2026-08-10T12:00:05.000Z"
    })).toEqual({ kind: "DUPLICATE", attemptCount: 2 });
  });

  it("reclaims a signed webhook event after its processing lease expires", async () => {
    expect(await claimStripeWebhookEvent(db, {
      ...webhookVerification,
      eventId: "evt_stale_fixture",
      eventType: "checkout.session.completed",
      livemode: false,
      claimId: "claim_stale_one",
      now: "2026-08-10T12:00:00.000Z"
    })).toEqual({ kind: "CLAIMED", attemptCount: 1 });
    expect(await claimStripeWebhookEvent(db, {
      ...webhookVerification,
      eventId: "evt_stale_fixture",
      eventType: "checkout.session.completed",
      livemode: false,
      claimId: "claim_still_busy",
      now: "2026-08-10T12:04:59.000Z"
    })).toEqual({ kind: "BUSY", attemptCount: 1 });
    expect(await claimStripeWebhookEvent(db, {
      ...webhookVerification,
      eventId: "evt_stale_fixture",
      eventType: "checkout.session.completed",
      livemode: false,
      claimId: "claim_stale_two",
      now: "2026-08-10T12:05:01.000Z"
    })).toEqual({ kind: "CLAIMED", attemptCount: 2 });
  });

  it("records one settled gift and one acknowledgment across webhook replays", async () => {
    await reserveStripeCheckout(db, checkoutInput());
    const input = {
      giftId: "stripe_gift_one",
      acknowledgmentId: "stripe_ack_one",
      sourceType: "PAYMENT_INTENT" as const,
      sourceId: "pi_fixture",
      checkoutId: "stripe_checkout_one",
      stripePaymentIntentId: "pi_fixture",
      stripeInvoiceId: null,
      stripeSubscriptionId: null,
      frequency: "ONCE" as const,
      giftType: "TITHE" as const,
      amountCents: 5000,
      donorName: "Donante Ejemplo",
      donorEmail: "donante@example.org",
      settledAt: "2026-08-10T12:00:00.000Z",
      now: "2026-08-10T12:00:01.000Z"
    };

    expect(await recordStripeGiftAndAcknowledgment(db, input)).toMatchObject({
      inserted: true,
      record: { id: "stripe_gift_one", source_id: "pi_fixture" }
    });
    expect(await recordStripeGiftAndAcknowledgment(db, {
      ...input,
      giftId: "unused_replay_gift",
      acknowledgmentId: "unused_replay_ack"
    })).toMatchObject({
      inserted: false,
      record: { id: "stripe_gift_one", source_id: "pi_fixture" }
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM stripe_gifts").get()).toEqual({ count: 1 });
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM stripe_acknowledgment_deliveries"
    ).get()).toEqual({ count: 1 });
  });

  it("fences acknowledgment dispatch and never auto-retries an unknown outcome", async () => {
    await reserveStripeCheckout(db, checkoutInput());
    await recordStripeGiftAndAcknowledgment(db, {
      giftId: "stripe_gift_one",
      acknowledgmentId: "stripe_ack_one",
      sourceType: "PAYMENT_INTENT",
      sourceId: "pi_fixture",
      checkoutId: "stripe_checkout_one",
      stripePaymentIntentId: "pi_fixture",
      stripeInvoiceId: null,
      stripeSubscriptionId: null,
      frequency: "ONCE",
      giftType: "TITHE",
      amountCents: 5000,
      donorName: "Donante Ejemplo",
      donorEmail: "donante@example.org",
      settledAt: "2026-08-10T12:00:00.000Z",
      now: "2026-08-10T12:00:01.000Z"
    });

    const claim = await claimNextStripeAcknowledgment(db, {
      claimId: "ack_claim_one",
      now: "2026-08-10T12:01:00.000Z"
    });
    expect(claim).toMatchObject({
      id: "stripe_ack_one",
      gift_id: "stripe_gift_one",
      processing_claim_id: "ack_claim_one",
      attempt_count: 1,
      donor_email: "donante@example.org"
    });
    expect(await claimNextStripeAcknowledgment(db, {
      claimId: "ack_claim_busy",
      now: "2026-08-10T12:01:01.000Z"
    })).toBeNull();
    expect(await markStripeAcknowledgmentDispatchStarted(db, {
      id: "stripe_ack_one",
      claimId: "ack_claim_one",
      now: "2026-08-10T12:01:02.000Z"
    })).toBe(true);
    expect(await finalizeStripeAcknowledgment(db, {
      id: "stripe_ack_one",
      claimId: "ack_claim_one",
      outcome: "REVIEW",
      failureCode: "provider_outcome_unknown",
      retrySafe: false,
      now: "2026-08-10T12:01:03.000Z"
    })).toBe(true);
    expect(await claimNextStripeAcknowledgment(db, {
      claimId: "ack_claim_after_review",
      now: "2026-08-10T12:02:00.000Z"
    })).toBeNull();
  });

  it("recovers stale acknowledgment claims only when provider dispatch never started", async () => {
    await reserveStripeCheckout(db, checkoutInput());
    await recordStripeGiftAndAcknowledgment(db, {
      giftId: "stripe_gift_stale",
      acknowledgmentId: "stripe_ack_stale",
      sourceType: "PAYMENT_INTENT",
      sourceId: "pi_stale_fixture",
      checkoutId: "stripe_checkout_one",
      stripePaymentIntentId: "pi_stale_fixture",
      stripeInvoiceId: null,
      stripeSubscriptionId: null,
      frequency: "ONCE",
      giftType: "TITHE",
      amountCents: 5000,
      donorName: "Donante Ejemplo",
      donorEmail: "donante@example.org",
      settledAt: "2026-08-10T12:00:00.000Z",
      now: "2026-08-10T12:00:01.000Z"
    });

    expect(await claimNextStripeAcknowledgment(db, {
      claimId: "ack_stale_one",
      now: "2026-08-10T12:01:00.000Z"
    })).toMatchObject({ attempt_count: 1 });
    expect(await claimNextStripeAcknowledgment(db, {
      claimId: "ack_stale_two",
      now: "2026-08-10T12:06:01.000Z"
    })).toMatchObject({ processing_claim_id: "ack_stale_two", attempt_count: 2 });
    expect(await markStripeAcknowledgmentDispatchStarted(db, {
      id: "stripe_ack_stale",
      claimId: "ack_stale_two",
      now: "2026-08-10T12:06:02.000Z"
    })).toBe(true);
    expect(await claimNextStripeAcknowledgment(db, {
      claimId: "ack_must_not_retry",
      now: "2026-08-10T12:11:03.000Z"
    })).toBeNull();
    expect(database.prepare(
      `SELECT status, processing_claim_id, failure_code, retry_safe
         FROM stripe_acknowledgment_deliveries WHERE id = 'stripe_ack_stale'`
    ).get()).toEqual({
      status: "REVIEW",
      processing_claim_id: null,
      failure_code: "provider_outcome_unknown_after_claim_timeout",
      retry_safe: 0
    });
  });

  it("does not let an older retry-safe acknowledgment starve a newer due delivery", async () => {
    await reserveStripeCheckout(db, checkoutInput());
    for (const [suffix, createdAt] of [["old", "2026-08-10T12:00:01.000Z"], ["new", "2026-08-10T12:00:02.000Z"]] as const) {
      await recordStripeGiftAndAcknowledgment(db, {
        giftId: `stripe_gift_${suffix}`,
        acknowledgmentId: `stripe_ack_${suffix}`,
        sourceType: "PAYMENT_INTENT",
        sourceId: `pi_${suffix}`,
        checkoutId: "stripe_checkout_one",
        stripePaymentIntentId: `pi_${suffix}`,
        stripeInvoiceId: null,
        stripeSubscriptionId: null,
        frequency: "ONCE",
        giftType: "TITHE",
        amountCents: 5000,
        donorName: "Donante Ejemplo",
        donorEmail: `${suffix}@example.org`,
        settledAt: createdAt,
        now: createdAt
      });
    }

    expect(await claimNextStripeAcknowledgment(db, {
      claimId: "ack_claim_old",
      now: "2026-08-10T12:01:00.000Z"
    })).toMatchObject({ id: "stripe_ack_old" });
    expect(await finalizeStripeAcknowledgment(db, {
      id: "stripe_ack_old",
      claimId: "ack_claim_old",
      outcome: "FAILED",
      failureCode: "EMAIL_PRE_DISPATCH_FAILED",
      retrySafe: true,
      retryAt: "2026-08-10T12:06:00.000Z",
      now: "2026-08-10T12:01:00.000Z"
    })).toBe(true);
    expect(await claimNextStripeAcknowledgment(db, {
      claimId: "ack_claim_new",
      now: "2026-08-10T12:01:01.000Z"
    })).toMatchObject({ id: "stripe_ack_new" });
  });

  it("caps retry-safe acknowledgment failures in review after five attempts", async () => {
    await reserveStripeCheckout(db, checkoutInput());
    await recordStripeGiftAndAcknowledgment(db, {
      giftId: "stripe_gift_exhausted",
      acknowledgmentId: "stripe_ack_exhausted",
      sourceType: "PAYMENT_INTENT",
      sourceId: "pi_exhausted",
      checkoutId: "stripe_checkout_one",
      stripePaymentIntentId: "pi_exhausted",
      stripeInvoiceId: null,
      stripeSubscriptionId: null,
      frequency: "ONCE",
      giftType: "TITHE",
      amountCents: 5000,
      donorName: "Donante Ejemplo",
      donorEmail: "exhausted@example.org",
      settledAt: "2026-08-10T12:00:01.000Z",
      now: "2026-08-10T12:00:01.000Z"
    });
    database.prepare(
      "UPDATE stripe_acknowledgment_deliveries SET attempt_count = 4 WHERE id = 'stripe_ack_exhausted'"
    ).run();
    expect(await claimNextStripeAcknowledgment(db, {
      claimId: "ack_claim_five",
      now: "2026-08-10T12:01:00.000Z"
    })).toMatchObject({ attempt_count: 5 });
    expect(await finalizeStripeAcknowledgment(db, {
      id: "stripe_ack_exhausted",
      claimId: "ack_claim_five",
      outcome: "FAILED",
      failureCode: "EMAIL_PRE_DISPATCH_FAILED",
      retrySafe: true,
      retryAt: "2026-08-10T12:21:00.000Z",
      now: "2026-08-10T12:01:00.000Z"
    })).toBe(true);
    expect(database.prepare(
      "SELECT status, failure_code, retry_safe FROM stripe_acknowledgment_deliveries WHERE id = 'stripe_ack_exhausted'"
    ).get()).toEqual({
      status: "REVIEW",
      failure_code: "acknowledgment_retry_exhausted",
      retry_safe: 0
    });
  });
});

function checkoutInput(overrides: Partial<Parameters<typeof reserveStripeCheckout>[1]> = {}) {
  return {
    id: "stripe_checkout_one",
    requestId: "0c2e2165-edb7-4e4b-bc50-95a7fa3cdfe5",
    requestFingerprint: "once:tithe:5000",
    frequency: "ONCE" as const,
    giftType: "TITHE" as const,
    amountCents: 5000,
    livemode: false,
    rateLimitClaimId: "rate_claim_one",
    now: "2026-08-10T12:00:00.000Z",
    ...overrides
  };
}

function withInflatedChanges(db: D1Database): D1Database {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      const mutableStatement = statement as unknown as { run: () => Promise<D1Result> };
      const run = mutableStatement.run.bind(mutableStatement);
      mutableStatement.run = async () => inflateChanges(await run());
      return statement;
    },
    async batch(statements: D1PreparedStatement[]) {
      return (await db.batch(statements)).map(inflateChanges);
    }
  } as D1Database;
}

function inflateChanges(result: D1Result): D1Result {
  const changes = Number(result.meta?.changes ?? 0);
  return changes > 0
    ? { ...result, meta: { ...result.meta, changes: changes + 1 } }
    : result;
}
