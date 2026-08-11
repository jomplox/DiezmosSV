import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migratedDatabase, migratedDatabaseThrough } from "./support/migratedDatabase";

const migrationPath = resolve(
  import.meta.dirname,
  "../../migrations/0032_stripe_us_donations.sql"
);

describe("Stripe U.S. donation persistence", () => {
  const openDatabases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of openDatabases.splice(0)) {
      database.close();
    }
  });

  it("adds the four durable Stripe tables on a fresh database", () => {
    const database = track(openDatabases, migratedDatabase());

    expect(tableNames(database)).toEqual(expect.arrayContaining([
      "stripe_acknowledgment_deliveries",
      "stripe_checkout_sessions",
      "stripe_gifts",
      "stripe_webhook_events"
    ]));

    expect(columnNames(database, "stripe_checkout_sessions")).toEqual(expect.arrayContaining([
      "request_id",
      "request_fingerprint",
      "stripe_session_id",
      "frequency",
      "amount_cents",
      "currency",
      "livemode",
      "status",
      "payment_status",
      "stripe_customer_id",
      "stripe_subscription_id",
      "subscription_status",
      "stripe_payment_intent_id",
      "rate_limit_claim_id",
      "expires_at",
      "completed_at"
    ]));
    expect(columnNames(database, "stripe_webhook_events")).not.toContain("raw_body");
    expect(columnNames(database, "stripe_webhook_events")).toEqual(expect.arrayContaining([
      "event_type",
      "livemode",
      "status",
      "attempt_count",
      "processing_claim_id",
      "failure_code",
      "received_at",
      "processed_at"
    ]));
    expect(columnNames(database, "stripe_gifts")).toEqual(expect.arrayContaining([
      "source_type",
      "source_id",
      "checkout_id",
      "frequency",
      "amount_cents",
      "currency",
      "donor_name",
      "donor_email",
      "settled_at",
      "status",
      "refunded_amount_cents"
    ]));
    expect(columnNames(database, "stripe_acknowledgment_deliveries")).toEqual(expect.arrayContaining([
      "gift_id",
      "status",
      "attempt_count",
      "processing_claim_id",
      "dispatch_started_at",
      "provider_id_hash",
      "failure_code",
      "sent_at"
    ]));
  });

  it("upgrades the exact 0031 schema without mutating historical migrations", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const database = track(openDatabases, migratedDatabaseThrough("0031"));
    expect(tableNames(database)).not.toContain("stripe_checkout_sessions");

    database.exec(readFileSync(migrationPath, "utf8"));

    expect(tableNames(database)).toEqual(expect.arrayContaining([
      "stripe_acknowledgment_deliveries",
      "stripe_checkout_sessions",
      "stripe_gifts",
      "stripe_webhook_events"
    ]));
  });

  it("enforces idempotency, lifecycle, and amount invariants in SQLite", () => {
    const database = track(openDatabases, migratedDatabase());
    insertCheckout(database, "checkout_one", "request_one", "fingerprint_one");

    expect(() => insertCheckout(
      database,
      "checkout_duplicate_request",
      "request_one",
      "fingerprint_two"
    )).toThrow(/UNIQUE constraint failed/);
    expect(() => insertCheckout(
      database,
      "checkout_bad_frequency",
      "request_two",
      "fingerprint_three",
      { frequency: "WEEKLY" }
    )).toThrow(/CHECK constraint failed/);
    expect(() => insertCheckout(
      database,
      "checkout_bad_currency",
      "request_three",
      "fingerprint_four",
      { currency: "eur" }
    )).toThrow(/CHECK constraint failed/);
    expect(() => insertCheckout(
      database,
      "checkout_bad_amount",
      "request_four",
      "fingerprint_five",
      { amountCents: 0 }
    )).toThrow(/CHECK constraint failed/);

    insertWebhook(database, "evt_once");
    expect(() => insertWebhook(database, "evt_once")).toThrow(/UNIQUE constraint failed/);
    expect(() => insertWebhook(database, "evt_invalid", "UNKNOWN")).toThrow(/CHECK constraint failed/);

    insertGift(database, "gift_one", "pi_one", "checkout_one");
    expect(() => insertGift(database, "gift_duplicate", "pi_one", "checkout_one"))
      .toThrow(/UNIQUE constraint failed/);
    expect(() => insertGift(
      database,
      "gift_over_refunded",
      "pi_two",
      "checkout_one",
      { refundedAmountCents: 5001 }
    )).toThrow(/CHECK constraint failed/);

    insertAcknowledgment(database, "ack_one", "gift_one");
    expect(() => insertAcknowledgment(database, "ack_duplicate", "gift_one"))
      .toThrow(/UNIQUE constraint failed/);
    expect(() => insertAcknowledgment(database, "ack_bad", "missing_gift"))
      .toThrow(/FOREIGN KEY constraint failed/);
  });
});

function track(databases: DatabaseSync[], database: DatabaseSync): DatabaseSync {
  databases.push(database);
  return database;
}

function tableNames(database: DatabaseSync): string[] {
  return (database.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
  ).all() as Array<{ name: string }>).map(({ name }) => name);
}

function columnNames(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>)
    .map(({ name }) => name);
}

function insertCheckout(
  database: DatabaseSync,
  id: string,
  requestId: string,
  fingerprint: string,
  overrides: { frequency?: string; currency?: string; amountCents?: number } = {}
): void {
  database.prepare(
    `INSERT INTO stripe_checkout_sessions (
       id, request_id, request_fingerprint, frequency, amount_cents, currency,
       livemode, status, payment_status
     ) VALUES (?, ?, ?, ?, ?, ?, 0, 'CREATING', 'UNPAID')`
  ).run(
    id,
    requestId,
    fingerprint,
    overrides.frequency ?? "ONCE",
    overrides.amountCents ?? 5000,
    overrides.currency ?? "usd"
  );
}

function insertWebhook(database: DatabaseSync, id: string, status = "PROCESSING"): void {
  database.prepare(
    `INSERT INTO stripe_webhook_events (
       id, event_type, livemode, status, attempt_count, processing_claim_id
     ) VALUES (?, 'checkout.session.completed', 0, ?, 1, 'claim_one')`
  ).run(id, status);
}

function insertGift(
  database: DatabaseSync,
  id: string,
  sourceId: string,
  checkoutId: string,
  overrides: { refundedAmountCents?: number } = {}
): void {
  database.prepare(
    `INSERT INTO stripe_gifts (
       id, source_type, source_id, checkout_id, stripe_payment_intent_id,
       frequency, amount_cents, currency, settled_at, status, refunded_amount_cents
     ) VALUES (?, 'PAYMENT_INTENT', ?, ?, ?, 'ONCE', 5000, 'usd',
       '2026-08-10T12:00:00.000Z', 'PAID', ?)`
  ).run(id, sourceId, checkoutId, sourceId, overrides.refundedAmountCents ?? 0);
}

function insertAcknowledgment(database: DatabaseSync, id: string, giftId: string): void {
  database.prepare(
    `INSERT INTO stripe_acknowledgment_deliveries (
       id, gift_id, status, attempt_count
     ) VALUES (?, ?, 'PENDING', 0)`
  ).run(id, giftId);
}
