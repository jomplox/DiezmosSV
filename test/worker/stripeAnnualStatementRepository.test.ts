import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimStripeAnnualStatementDelivery,
  finalizeStripeAnnualStatementDelivery,
  listStripeAnnualStatementDonorGifts,
  listStripeAnnualStatementDonorTargets,
  markStripeAnnualStatementDispatchStarted,
  reserveStripeAnnualStatementDelivery
} from "../../src/worker/storage/repository/stripeAnnualStatements";
import { migratedDatabase } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";

const RANGE_2025_NEW_YORK = {
  startIso: "2025-01-01T05:00:00.000Z",
  endIso: "2026-01-01T05:00:00.000Z"
};

describe("Stripe annual statement repository", () => {
  let database: ReturnType<typeof migratedDatabase>;
  let db: D1Database;

  beforeEach(() => {
    database = migratedDatabase();
    db = sqliteD1(database);
  });

  afterEach(() => database.close());

  it("groups normalized email, isolates livemode and year, and never merges missing-email names", async () => {
    seedGift(database, { id: "before", donorEmail: "ana@example.org", settledAt: "2025-01-01T04:59:59.999Z" });
    seedGift(database, { id: "ana_1", donorEmail: " Ana@Example.ORG ", donorName: "Ana Primera", amountCents: 10_000, settledAt: RANGE_2025_NEW_YORK.startIso });
    seedGift(database, { id: "ana_2", donorEmail: "ana@example.org", donorName: "Ana Segunda", amountCents: 5_000, refundedAmountCents: 3_000, status: "PARTIALLY_REFUNDED", settledAt: "2025-07-01T12:00:00.000Z" });
    seedGift(database, { id: "no_email_1", donorEmail: null, donorName: "Mismo Nombre", settledAt: "2025-03-01T12:00:00.000Z" });
    seedGift(database, { id: "no_email_2", donorEmail: null, donorName: "Mismo Nombre", settledAt: "2025-04-01T12:00:00.000Z" });
    seedGift(database, { id: "live", donorEmail: "live@example.org", livemode: true, settledAt: "2025-05-01T12:00:00.000Z" });
    seedGift(database, { id: "after", donorEmail: "ana@example.org", settledAt: RANGE_2025_NEW_YORK.endIso });

    const targets = await listStripeAnnualStatementDonorTargets(db, RANGE_2025_NEW_YORK, {
      livemode: false,
      afterDonorKey: null,
      limit: 50
    });

    expect(targets).toEqual([
      {
        donorKey: "ana@example.org",
        donorName: "Ana Primera",
        donorEmail: "ana@example.org",
        count: 2,
        grossCents: 15_000,
        refundedCents: 3_000,
        netCents: 12_000
      },
      expect.objectContaining({ donorKey: "gift:no_email_1", donorName: "Mismo Nombre", donorEmail: null, count: 1 }),
      expect.objectContaining({ donorKey: "gift:no_email_2", donorName: "Mismo Nombre", donorEmail: null, count: 1 })
    ]);

    const gifts = await listStripeAnnualStatementDonorGifts(
      db,
      RANGE_2025_NEW_YORK,
      false,
      "ana@example.org"
    );
    expect(gifts.map((gift) => ({
      id: gift.id,
      giftType: gift.gift_type,
      gross: gift.amount_cents,
      refunded: gift.refunded_amount_cents,
      net: gift.net_amount_cents
    }))).toEqual([
      { id: "ana_1", giftType: "TITHE", gross: 10_000, refunded: 0, net: 10_000 },
      { id: "ana_2", giftType: "TITHE", gross: 5_000, refunded: 3_000, net: 2_000 }
    ]);
  });

  it("rejects an impossible negative-net gift even when another gift offsets the donor aggregate", async () => {
    seedGift(database, {
      id: "negative_net",
      donorEmail: "corrupt@example.org",
      amountCents: 100,
      settledAt: "2025-04-01T12:00:00.000Z"
    });
    seedGift(database, {
      id: "positive_offset",
      donorEmail: "corrupt@example.org",
      amountCents: 1_000,
      settledAt: "2025-05-01T12:00:00.000Z"
    });
    database.exec("PRAGMA ignore_check_constraints = ON");
    database.prepare(
      "UPDATE stripe_gifts SET refunded_amount_cents = 200, status = 'REFUNDED' WHERE id = 'negative_net'"
    ).run();
    database.exec("PRAGMA ignore_check_constraints = OFF");

    await expect(listStripeAnnualStatementDonorTargets(db, RANGE_2025_NEW_YORK, {
      livemode: false,
      afterDonorKey: null,
      limit: 50
    })).rejects.toThrow(/negative net amount/i);
  });

  it("uses a stable bounded keyset cursor and a single-donor exact read", async () => {
    for (let index = 0; index < 55; index += 1) {
      seedGift(database, {
        id: `gift_${index}`,
        donorEmail: `donor${String(index).padStart(2, "0")}@example.org`,
        settledAt: "2025-06-01T12:00:00.000Z"
      });
    }

    const first = await listStripeAnnualStatementDonorTargets(db, RANGE_2025_NEW_YORK, {
      livemode: false,
      afterDonorKey: null,
      limit: 50
    });
    expect(first).toHaveLength(51);
    expect(first[49].donorKey).toBe("donor49@example.org");

    const second = await listStripeAnnualStatementDonorTargets(db, RANGE_2025_NEW_YORK, {
      livemode: false,
      afterDonorKey: "donor49@example.org",
      limit: 50
    });
    expect(second.map((target) => target.donorKey)).toEqual([
      "donor50@example.org",
      "donor51@example.org",
      "donor52@example.org",
      "donor53@example.org",
      "donor54@example.org"
    ]);

    const exact = await listStripeAnnualStatementDonorTargets(db, RANGE_2025_NEW_YORK, {
      livemode: false,
      afterDonorKey: null,
      limit: 1,
      donorKey: "donor03@example.org"
    });
    expect(exact.map((target) => target.donorKey)).toEqual(["donor03@example.org"]);
  });

  it("filters before grouping and cursor pagination with literal LIKE characters", async () => {
    seedGift(database, { id: "ana_name", donorEmail: "ana@example.org", donorName: "Ana Search", settledAt: "2025-06-01T12:00:00.000Z" });
    seedGift(database, { id: "ana_renamed", donorEmail: "ana@example.org", donorName: "Ana Actualizada", amountCents: 2_000, settledAt: "2025-07-01T12:00:00.000Z" });
    seedGift(database, { id: "email_match", donorEmail: "contains-needle@example.org", donorName: "Otra", settledAt: "2025-06-01T12:00:00.000Z" });
    seedGift(database, { id: "accented", donorEmail: "angela@example.org", donorName: "Ángela", settledAt: "2025-06-01T12:00:00.000Z" });
    seedGift(database, { id: "cursor_alpha", donorEmail: "alpha@example.org", donorName: "Alpha Match", settledAt: "2025-06-01T12:00:00.000Z" });
    seedGift(database, { id: "cursor_beta", donorEmail: "beta@example.org", donorName: "Beta Match", settledAt: "2025-06-01T12:00:00.000Z" });
    seedGift(database, { id: "percent", donorEmail: "percent@example.org", donorName: "100% Literal", settledAt: "2025-06-01T12:00:00.000Z" });
    seedGift(database, { id: "underscore", donorEmail: "underscore@example.org", donorName: "A_B Literal", settledAt: "2025-06-01T12:00:00.000Z" });
    seedGift(database, { id: "slash", donorEmail: "slash@example.org", donorName: "C\\D Literal", settledAt: "2025-06-01T12:00:00.000Z" });
    seedGift(database, { id: "nonmatch", donorEmail: "other@example.org", donorName: "No coincide", settledAt: "2025-06-01T12:00:00.000Z" });

    const targets = await listStripeAnnualStatementDonorTargets(db, RANGE_2025_NEW_YORK, {
      livemode: false,
      afterDonorKey: null,
      limit: 50,
      query: "NEEDLE"
    });
    expect(targets.map((target) => target.donorKey)).toEqual(["contains-needle@example.org"]);

    const renamed = await listStripeAnnualStatementDonorTargets(db, RANGE_2025_NEW_YORK, {
      livemode: false,
      afterDonorKey: null,
      limit: 50,
      query: "search"
    });
    expect(renamed).toEqual([expect.objectContaining({ donorKey: "ana@example.org", count: 2, grossCents: 3_000, netCents: 3_000 })]);

    const accented = await listStripeAnnualStatementDonorTargets(db, RANGE_2025_NEW_YORK, {
      livemode: false,
      afterDonorKey: null,
      limit: 50,
      query: "ángELA"
    });
    expect(accented.map((target) => target.donorKey)).toEqual(["angela@example.org"]);

    for (const [query, donorKey] of [["%", "percent@example.org"], ["_", "underscore@example.org"], ["\\", "slash@example.org"]]) {
      const literal = await listStripeAnnualStatementDonorTargets(db, RANGE_2025_NEW_YORK, {
        livemode: false,
        afterDonorKey: null,
        limit: 50,
        query
      });
      expect(literal.map((target) => target.donorKey)).toEqual([donorKey]);
    }

    const after = await listStripeAnnualStatementDonorTargets(db, RANGE_2025_NEW_YORK, {
      livemode: false,
      afterDonorKey: "ana@example.org",
      limit: 50,
      query: "search"
    });
    expect(after).toEqual([]);

    const cursor = await listStripeAnnualStatementDonorTargets(db, RANGE_2025_NEW_YORK, {
      livemode: false,
      afterDonorKey: "alpha@example.org",
      limit: 50,
      query: "match"
    });
    expect(cursor.map((target) => target.donorKey)).toEqual(["beta@example.org"]);
  });

  it("keeps the 50-row sentinel and keyset cursor after Unicode search filtering", async () => {
    for (let index = 0; index < 51; index += 1) {
      const sequence = String(index).padStart(2, "0");
      seedGift(database, {
        id: `accent_page_${sequence}`,
        donorEmail: `accent${sequence}@example.org`,
        donorName: `Ángela ${sequence}`,
        settledAt: "2025-06-01T12:00:00.000Z"
      });
    }

    const first = await listStripeAnnualStatementDonorTargets(db, RANGE_2025_NEW_YORK, {
      livemode: false,
      afterDonorKey: null,
      limit: 50,
      query: "ÁNGELA"
    });
    expect(first).toHaveLength(51);
    expect(first[49].donorKey).toBe("accent49@example.org");

    const next = await listStripeAnnualStatementDonorTargets(db, RANGE_2025_NEW_YORK, {
      livemode: false,
      afterDonorKey: first[49].donorKey,
      limit: 50,
      query: "ángela"
    });
    expect(next.map((target) => target.donorKey)).toEqual(["accent50@example.org"]);
  });

  it("converges concurrent identical reservations and creates corrected revision lineage", async () => {
    seedGift(database, {
      id: "delivery_gift",
      donorEmail: "ana@example.org",
      donorName: "Ana",
      amountCents: 1_000,
      settledAt: "2025-06-01T12:00:00.000Z"
    });
    const base = reservation({
      id: "delivery_a",
      snapshotHash: "a".repeat(64),
      snapshotJson: repositorySnapshotJson("delivery_gift")
    });
    const [first, duplicate] = await Promise.all([
      reserveStripeAnnualStatementDelivery(db, base),
      reserveStripeAnnualStatementDelivery(db, { ...base, id: "delivery_duplicate" })
    ]);
    expect(first.id).toBe(duplicate.id);
    expect(first.revision).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM stripe_annual_statement_deliveries").get())
      .toEqual({ count: 1 });

    const claim = await claimStripeAnnualStatementDelivery(db, {
      id: first.id,
      claimId: "claim_a",
      emailContentJson: repositoryEmailContentJson(),
      now: "2026-01-10T12:00:00.000Z"
    });
    expect(claim).toMatchObject({ status: "PROCESSING", attempt_count: 1 });
    expect(await markStripeAnnualStatementDispatchStarted(
      db,
      dispatchAuthorization(first, "claim_a", "2026-01-10T12:00:01.000Z")
    )).toBe(true);
    expect(await finalizeStripeAnnualStatementDelivery(db, {
      id: first.id,
      claimId: "claim_a",
      outcome: "SENT",
      providerIdHash: `sha256:${"b".repeat(64)}`,
      failureCode: null,
      retrySafe: false,
      now: "2026-01-10T12:00:02.000Z"
    })).toBe(true);

    const corrected = await reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_b",
      snapshotHash: "c".repeat(64),
      snapshotJson: '{"version":2}'
    }));
    expect(corrected).toMatchObject({
      revision: 2,
      supersedes_delivery_id: first.id,
      status: "PENDING"
    });
  });

  it("fails closed when the same snapshot hash is paired with different immutable contents", async () => {
    await reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_collision_a",
      snapshotHash: "e".repeat(64),
      snapshotJson: '{"version":1}'
    }));

    await expect(reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_collision_b",
      snapshotHash: "e".repeat(64),
      snapshotJson: '{"version":2}'
    }))).rejects.toThrow(/snapshot identity conflicts/i);
  });

  it("fences an unknown post-dispatch outcome from every automatic retry", async () => {
    seedGift(database, {
      id: "review_gift",
      donorEmail: "ana@example.org",
      donorName: "Ana",
      amountCents: 1_000,
      settledAt: "2025-06-01T12:00:00.000Z"
    });
    const row = await reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_review",
      snapshotHash: "d".repeat(64),
      snapshotJson: repositorySnapshotJson("review_gift")
    }));
    expect(await claimStripeAnnualStatementDelivery(db, {
      id: row.id,
      claimId: "claim_review",
      emailContentJson: repositoryEmailContentJson(),
      now: "2026-01-10T12:00:00.000Z"
    })).not.toBeNull();
    expect(await markStripeAnnualStatementDispatchStarted(
      db,
      dispatchAuthorization(row, "claim_review", "2026-01-10T12:00:01.000Z")
    )).toBe(true);
    expect(await finalizeStripeAnnualStatementDelivery(db, {
      id: row.id,
      claimId: "claim_review",
      outcome: "REVIEW",
      failureCode: "EMAIL_DISPATCH_UNKNOWN",
      retrySafe: false,
      now: "2026-01-10T12:00:02.000Z"
    })).toBe(true);

    expect(await claimStripeAnnualStatementDelivery(db, {
      id: row.id,
      claimId: "claim_again",
      emailContentJson: repositoryEmailContentJson(),
      now: "2026-01-10T12:01:00.000Z"
    })).toBeNull();
    const same = await reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_same_again",
      snapshotHash: "d".repeat(64),
      snapshotJson: repositorySnapshotJson("review_gift")
    }));
    expect(same).toMatchObject({ id: row.id, status: "REVIEW", retry_safe: 0 });

    await expect(reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_changed_while_review",
      snapshotHash: "f".repeat(64),
      snapshotJson: '{"version":2}'
    }))).rejects.toThrow(/unresolved review/i);
    expect(database.prepare("SELECT COUNT(*) AS count FROM stripe_annual_statement_deliveries").get())
      .toEqual({ count: 1 });
  });

  it("atomically refuses dispatch authorization after the reserved gift snapshot changes", async () => {
    seedGift(database, {
      id: "authorization_gift",
      donorEmail: "ana@example.org",
      donorName: "Ana",
      amountCents: 1_000,
      settledAt: "2025-06-01T12:00:00.000Z"
    });
    const snapshotJson = JSON.stringify({
      version: 2,
      donor: { key: "ana@example.org", name: "Ana", email: "ana@example.org" },
      document: {
        settings: {
          brandingDisplayName: null,
          brandingAccentColor: null,
          brandingSupportEmail: null,
          brandingLogo: null,
          brandingDonorLogo: null,
          emailSenderName: null,
          emailReplyTo: null
        }
      },
      items: [{
        sourceId: "pi_authorization_gift",
        settledAt: "2025-06-01T12:00:00.000Z",
        giftType: "TITHE",
        frequency: "ONCE",
        grossAmountCents: 1_000,
        refundedAmountCents: 0,
        netAmountCents: 1_000
      }]
    });
    const row = await reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_authorization",
      snapshotHash: "9".repeat(64),
      snapshotJson
    }));
    expect(await claimStripeAnnualStatementDelivery(db, {
      id: row.id,
      claimId: "claim_authorization",
      emailContentJson: repositoryEmailContentJson(),
      now: "2026-01-10T12:00:00.000Z"
    })).not.toBeNull();
    database.prepare(
      "UPDATE stripe_gifts SET refunded_amount_cents = 100, status = 'PARTIALLY_REFUNDED' WHERE id = 'authorization_gift'"
    ).run();

    const authorization = {
      id: row.id,
      claimId: "claim_authorization",
      snapshotHash: "9".repeat(64),
      snapshotJson,
      range: RANGE_2025_NEW_YORK,
      livemode: false,
      donorKey: "ana@example.org",
      now: "2026-01-10T12:00:01.000Z"
    };
    expect(await markStripeAnnualStatementDispatchStarted(db, authorization)).toBe(false);
    expect(database.prepare(
      "SELECT status, processing_claim_id, dispatch_started_at FROM stripe_annual_statement_deliveries WHERE id = ?"
    ).get(row.id)).toEqual({
      status: "PROCESSING",
      processing_claim_id: "claim_authorization",
      dispatch_started_at: null
    });
  });

  it("reclaims stale pre-provider work without converting it to REVIEW", async () => {
    const row = await reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_stale_pre_provider",
      snapshotHash: "8".repeat(64)
    }));
    expect(await claimStripeAnnualStatementDelivery(db, {
      id: row.id,
      claimId: "claim_interrupted_before_provider",
      emailContentJson: repositoryEmailContentJson(),
      now: "2026-01-10T12:00:00.000Z"
    })).not.toBeNull();

    expect(await claimStripeAnnualStatementDelivery(db, {
      id: row.id,
      claimId: "claim_recovered",
      emailContentJson: repositoryEmailContentJson(),
      now: "2026-01-10T12:06:00.000Z"
    })).toMatchObject({
      status: "PROCESSING",
      processing_claim_id: "claim_recovered",
      dispatch_started_at: null,
      attempt_count: 2
    });
  });

  it("serializes concurrent changed-hash reservations for one donor-year", async () => {
    const [first, second] = await Promise.allSettled([
      reserveStripeAnnualStatementDelivery(db, reservation({
        id: "delivery_concurrent_a",
        snapshotHash: "a".repeat(64),
        snapshotJson: '{"version":2,"amount":1000}'
      })),
      reserveStripeAnnualStatementDelivery(db, reservation({
        id: "delivery_concurrent_b",
        snapshotHash: "b".repeat(64),
        snapshotJson: '{"version":2,"amount":900}'
      }))
    ]);

    expect([first.status, second.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM stripe_annual_statement_deliveries").get())
      .toEqual({ count: 1 });
  });

  it("allocates a new revision when a prior hash returns after an intervening SENT correction", async () => {
    const firstA = await reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_a_failed",
      snapshotHash: "a".repeat(64),
      snapshotJson: '{"version":2,"state":"A"}'
    }));
    expect(await claimStripeAnnualStatementDelivery(db, {
      id: firstA.id,
      claimId: "claim_a_failed",
      emailContentJson: repositoryEmailContentJson(),
      now: "2026-01-10T11:01:00.000Z"
    })).not.toBeNull();
    expect(await finalizeStripeAnnualStatementDelivery(db, {
      id: firstA.id,
      claimId: "claim_a_failed",
      outcome: "FAILED",
      failureCode: "confirmed_not_sent",
      retrySafe: false,
      now: "2026-01-10T11:02:00.000Z"
    })).toBe(true);

    const sentB = await reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_b_sent",
      snapshotHash: "b".repeat(64),
      snapshotJson: '{"version":2,"state":"B"}'
    }));
    expect(await claimStripeAnnualStatementDelivery(db, {
      id: sentB.id,
      claimId: "claim_b_sent",
      emailContentJson: repositoryEmailContentJson(),
      now: "2026-01-10T11:03:00.000Z"
    })).not.toBeNull();
    database.prepare(
      "UPDATE stripe_annual_statement_deliveries SET dispatch_started_at = ? WHERE id = ?"
    ).run("2026-01-10T11:03:01.000Z", sentB.id);
    expect(await finalizeStripeAnnualStatementDelivery(db, {
      id: sentB.id,
      claimId: "claim_b_sent",
      outcome: "SENT",
      providerIdHash: `sha256:${"c".repeat(64)}`,
      failureCode: null,
      retrySafe: false,
      now: "2026-01-10T11:03:02.000Z"
    })).toBe(true);

    const returnedA = await reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_a_returned",
      snapshotHash: "a".repeat(64),
      snapshotJson: '{"version":2,"state":"A"}'
    }));
    expect(returnedA).toMatchObject({
      id: "delivery_a_returned",
      revision: 3,
      supersedes_delivery_id: sentB.id,
      status: "PENDING"
    });
  });

  it("reuses the latest SENT evidence when a later different snapshot failed before dispatch", async () => {
    const sentA = await reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_a_sent",
      snapshotHash: "a".repeat(64),
      snapshotJson: '{"version":2,"state":"A"}'
    }));
    expect(await claimStripeAnnualStatementDelivery(db, {
      id: sentA.id,
      claimId: "claim_a_sent",
      emailContentJson: repositoryEmailContentJson(),
      now: "2026-01-10T11:01:00.000Z"
    })).not.toBeNull();
    database.prepare(
      "UPDATE stripe_annual_statement_deliveries SET dispatch_started_at = ? WHERE id = ?"
    ).run("2026-01-10T11:01:01.000Z", sentA.id);
    expect(await finalizeStripeAnnualStatementDelivery(db, {
      id: sentA.id,
      claimId: "claim_a_sent",
      outcome: "SENT",
      providerIdHash: `sha256:${"b".repeat(64)}`,
      failureCode: null,
      retrySafe: false,
      now: "2026-01-10T11:01:02.000Z"
    })).toBe(true);

    const failedB = await reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_b_failed",
      snapshotHash: "c".repeat(64),
      snapshotJson: '{"version":2,"state":"B"}'
    }));
    await expect(reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_a_fenced",
      snapshotHash: "a".repeat(64),
      snapshotJson: '{"version":2,"state":"A"}'
    }))).rejects.toThrow(/active delivery/i);
    expect(await claimStripeAnnualStatementDelivery(db, {
      id: failedB.id,
      claimId: "claim_b_failed",
      emailContentJson: repositoryEmailContentJson(),
      now: "2026-01-10T11:02:00.000Z"
    })).not.toBeNull();
    expect(await finalizeStripeAnnualStatementDelivery(db, {
      id: failedB.id,
      claimId: "claim_b_failed",
      outcome: "FAILED",
      failureCode: "confirmed_not_sent",
      retrySafe: false,
      now: "2026-01-10T11:02:01.000Z"
    })).toBe(true);
    expect(database.prepare(
      "SELECT status, dispatch_started_at, provider_id_hash FROM stripe_annual_statement_deliveries WHERE id = ?"
    ).get(failedB.id)).toEqual({
      status: "FAILED",
      dispatch_started_at: null,
      provider_id_hash: null
    });

    const returnedA = await reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_a_returned_after_failure",
      snapshotHash: "a".repeat(64),
      snapshotJson: '{"version":2,"state":"A"}'
    }));
    expect(returnedA).toMatchObject({
      id: sentA.id,
      revision: 1,
      status: "SENT",
      provider_id_hash: `sha256:${"b".repeat(64)}`
    });
    expect(database.prepare(
      "SELECT id, revision, status FROM stripe_annual_statement_deliveries ORDER BY revision"
    ).all()).toEqual([
      { id: sentA.id, revision: 1, status: "SENT" },
      { id: failedB.id, revision: 2, status: "FAILED" }
    ]);
  });

  it.each(["FAILED", "PENDING"] as const)(
    "reuses SENT evidence instead of a legacy same-hash %s pre-dispatch revision",
    async (tailStatus) => {
      const history = seedLegacyAnnualDedupHistory(database, tailStatus);

      const returned = await reserveStripeAnnualStatementDelivery(db, reservation({
        id: `delivery_a_after_legacy_${tailStatus.toLowerCase()}`,
        snapshotHash: history.snapshotHash,
        snapshotJson: history.snapshotJson
      }));

      expect(returned).toMatchObject({
        id: history.sentId,
        revision: 1,
        status: "SENT",
        provider_id_hash: `sha256:${"b".repeat(64)}`
      });
      expect(database.prepare(
        `SELECT status, failure_code, retry_safe
           FROM stripe_annual_statement_deliveries WHERE id = ?`
      ).get(history.tailId)).toEqual({
        status: "FAILED",
        failure_code: "duplicate_sent_snapshot_suppressed",
        retry_safe: 0
      });
      expect(await claimStripeAnnualStatementDelivery(db, {
        id: history.tailId,
        claimId: `claim_legacy_${tailStatus.toLowerCase()}`,
        emailContentJson: repositoryEmailContentJson(),
        now: "2026-01-10T11:05:00.000Z"
      })).toBeNull();
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM stripe_annual_statement_deliveries"
      ).get()).toEqual({ count: 3 });
    }
  );

  it("atomically supersedes stale pre-provider work but preserves a non-stale concurrent fence", async () => {
    const stale = await reserveStripeAnnualStatementDelivery(db, {
      ...reservation({ id: "delivery_stale_a", snapshotHash: "d".repeat(64) }),
      now: "2026-01-10T11:00:00.000Z"
    });
    const corrected = await reserveStripeAnnualStatementDelivery(db, {
      ...reservation({ id: "delivery_stale_b", snapshotHash: "e".repeat(64) }),
      now: "2026-01-10T11:06:00.000Z"
    });
    expect(corrected).toMatchObject({ revision: 2, status: "PENDING" });
    expect(database.prepare(
      "SELECT status, failure_code FROM stripe_annual_statement_deliveries WHERE id = ?"
    ).get(stale.id)).toEqual({ status: "FAILED", failure_code: "superseded_stale_pre_dispatch" });

    await expect(reserveStripeAnnualStatementDelivery(db, {
      ...reservation({ id: "delivery_non_stale", snapshotHash: "f".repeat(64) }),
      now: "2026-01-10T11:07:00.000Z"
    })).rejects.toThrow(/active delivery/i);
  });

  it("uses an indexed year-range access path instead of scanning all Stripe gifts", () => {
    for (let index = 0; index < 250; index += 1) {
      seedGift(database, {
        id: `historic_${index}`,
        donorEmail: `historic${index}@example.org`,
        settledAt: "2020-06-01T12:00:00.000Z"
      });
    }
    seedGift(database, {
      id: "in_range_index_fixture",
      donorEmail: "indexed@example.org",
      settledAt: "2025-06-01T12:00:00.000Z"
    });
    database.exec("ANALYZE");
    const plan = database.prepare(
      `EXPLAIN QUERY PLAN
       SELECT gift.id
         FROM stripe_gifts AS gift
         JOIN stripe_checkout_sessions AS checkout ON checkout.id = gift.checkout_id
        WHERE gift.settled_at >= ? AND gift.settled_at < ?
          AND checkout.livemode = 0
          AND gift.status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')
        ORDER BY gift.settled_at, gift.id
        LIMIT 51`
    ).all(RANGE_2025_NEW_YORK.startIso, RANGE_2025_NEW_YORK.endIso) as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join("\n"))
      .toMatch(/SEARCH gift USING INDEX idx_stripe_gifts_annual_range/i);
  });
});

function reservation(overrides: { id: string; snapshotHash: string; snapshotJson?: string }) {
  return {
    id: overrides.id,
    year: 2025,
    livemode: false,
    donorKey: "ana@example.org",
    donorName: "Ana",
    donorEmail: "ana@example.org",
    snapshotHash: overrides.snapshotHash,
    snapshotJson: overrides.snapshotJson ?? '{"version":1}',
    now: "2026-01-10T11:00:00.000Z"
  };
}

function repositorySnapshotJson(giftId: string): string {
  return JSON.stringify({
    version: 2,
    donor: { key: "ana@example.org", name: "Ana", email: "ana@example.org" },
    document: {
      settings: {
        brandingDisplayName: null,
        brandingAccentColor: null,
        brandingSupportEmail: null,
        brandingLogo: null,
        brandingDonorLogo: null,
        emailSenderName: null,
        emailReplyTo: null
      }
    },
    items: [{
      sourceId: `pi_${giftId}`,
      settledAt: "2025-06-01T12:00:00.000Z",
      giftType: "TITHE",
      frequency: "ONCE",
      grossAmountCents: 1_000,
      refundedAmountCents: 0,
      netAmountCents: 1_000
    }]
  });
}

function seedLegacyAnnualDedupHistory(
  database: ReturnType<typeof migratedDatabase>,
  tailStatus: "FAILED" | "PENDING"
): { sentId: string; tailId: string; snapshotHash: string; snapshotJson: string } {
  const sentId = `delivery_legacy_sent_${tailStatus.toLowerCase()}`;
  const failedCorrectionId = `delivery_legacy_changed_${tailStatus.toLowerCase()}`;
  const tailId = `delivery_legacy_returned_${tailStatus.toLowerCase()}`;
  const snapshotHash = "a".repeat(64);
  const snapshotJson = '{"version":2,"state":"A"}';
  database.prepare(
    `INSERT INTO stripe_annual_statement_deliveries (
       id, year, livemode, donor_key, donor_name, donor_email,
       snapshot_hash, snapshot_json, revision, supersedes_delivery_id,
       status, attempt_count, dispatch_started_at, provider_id_hash,
       failure_code, retry_safe, sent_at, created_at, updated_at
     ) VALUES
       (?, 2025, 0, 'ana@example.org', 'Ana', 'ana@example.org', ?, ?, 1, NULL,
        'SENT', 1, '2026-01-10T10:00:01.000Z', ?, NULL, 0,
        '2026-01-10T10:00:02.000Z', '2026-01-10T10:00:00.000Z', '2026-01-10T10:00:02.000Z'),
       (?, 2025, 0, 'ana@example.org', 'Ana', 'ana@example.org', ?, ?, 2, ?,
        'FAILED', 1, NULL, NULL, 'confirmed_not_sent', 0,
        NULL, '2026-01-10T10:01:00.000Z', '2026-01-10T10:01:01.000Z'),
       (?, 2025, 0, 'ana@example.org', 'Ana', 'ana@example.org', ?, ?, 3, ?,
        ?, ?, NULL, NULL, ?, ?,
        NULL, '2026-01-10T10:02:00.000Z', '2026-01-10T10:02:01.000Z')`
  ).run(
    sentId,
    snapshotHash,
    snapshotJson,
    `sha256:${"b".repeat(64)}`,
    failedCorrectionId,
    "c".repeat(64),
    '{"version":2,"state":"B"}',
    sentId,
    tailId,
    snapshotHash,
    snapshotJson,
    sentId,
    tailStatus,
    tailStatus === "FAILED" ? 1 : 0,
    tailStatus === "FAILED" ? "snapshot_changed_before_dispatch" : null,
    tailStatus === "FAILED" ? 1 : 0
  );
  return { sentId, tailId, snapshotHash, snapshotJson };
}

function dispatchAuthorization(
  row: Awaited<ReturnType<typeof reserveStripeAnnualStatementDelivery>>,
  claimId: string,
  now: string
) {
  return {
    id: row.id,
    claimId,
    snapshotHash: row.snapshot_hash,
    snapshotJson: row.snapshot_json,
    range: RANGE_2025_NEW_YORK,
    livemode: false,
    donorKey: row.donor_key,
    now
  };
}

function repositoryEmailContentJson(): string {
  return JSON.stringify({
    version: 1,
    subject: "Constancia anual",
    text: "Cuerpo anual",
    html: "<p>Cuerpo anual</p>"
  });
}

function seedGift(
  database: ReturnType<typeof migratedDatabase>,
  input: {
    id: string;
    donorEmail: string | null;
    donorName?: string;
    livemode?: boolean;
    amountCents?: number;
    refundedAmountCents?: number;
    status?: "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED";
    settledAt: string;
  }
): void {
  const checkoutId = `checkout_${input.id}`;
  database.prepare(
    `INSERT INTO stripe_checkout_sessions (
       id, request_id, request_fingerprint, frequency, gift_type, amount_cents,
       livemode, status, payment_status
     ) VALUES (?, ?, ?, 'ONCE', 'TITHE', ?, ?, 'COMPLETE', 'PAID')`
  ).run(checkoutId, `request_${input.id}`, `fingerprint_${input.id}`, input.amountCents ?? 1_000, input.livemode ? 1 : 0);
  database.prepare(
    `INSERT INTO stripe_gifts (
       id, source_type, source_id, checkout_id, stripe_payment_intent_id,
       frequency, gift_type, amount_cents, donor_name, donor_email, settled_at,
       status, refunded_amount_cents
     ) VALUES (?, 'PAYMENT_INTENT', ?, ?, ?, 'ONCE', 'TITHE', ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    `pi_${input.id}`,
    checkoutId,
    `pi_${input.id}`,
    input.amountCents ?? 1_000,
    input.donorName ?? "Donante",
    input.donorEmail,
    input.settledAt,
    input.status ?? "PAID",
    input.refundedAmountCents ?? 0
  );
}
