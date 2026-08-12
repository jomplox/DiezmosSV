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
    const base = reservation({ id: "delivery_a", snapshotHash: "a".repeat(64), snapshotJson: '{"version":1}' });
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
      now: "2026-01-10T12:00:00.000Z"
    });
    expect(claim).toMatchObject({ status: "PROCESSING", attempt_count: 1 });
    expect(await markStripeAnnualStatementDispatchStarted(db, {
      id: first.id,
      claimId: "claim_a",
      now: "2026-01-10T12:00:01.000Z"
    })).toBe(true);
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
    const row = await reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_review",
      snapshotHash: "d".repeat(64)
    }));
    expect(await claimStripeAnnualStatementDelivery(db, {
      id: row.id,
      claimId: "claim_review",
      now: "2026-01-10T12:00:00.000Z"
    })).not.toBeNull();
    expect(await markStripeAnnualStatementDispatchStarted(db, {
      id: row.id,
      claimId: "claim_review",
      now: "2026-01-10T12:00:01.000Z"
    })).toBe(true);
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
      now: "2026-01-10T12:01:00.000Z"
    })).toBeNull();
    const same = await reserveStripeAnnualStatementDelivery(db, reservation({
      id: "delivery_same_again",
      snapshotHash: "d".repeat(64)
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
