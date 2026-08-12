import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { migratedDatabase, migratedDatabaseThrough } from "./support/migratedDatabase";

const migrationPath = resolve(
  import.meta.dirname,
  "../../migrations/0032_stripe_us_donations.sql"
);
const giftTypeMigrationPath = resolve(
  import.meta.dirname,
  "../../migrations/0033_stripe_gift_type.sql"
);
const retentionGenerationMigrationPath = resolve(
  import.meta.dirname,
  "../../migrations/0036_stripe_retention_generations.sql"
);

describe("Stripe U.S. donation persistence", () => {
  const openDatabases: DatabaseSync[] = [];
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const database of openDatabases.splice(0)) {
      database.close();
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
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

  it("tracks inserts, updates, and deletes around trigger install and backfill", () => {
    const seed = migratedDatabaseThrough("0035");
    const directory = mkdtempSync(join(tmpdir(), "stripe-retention-migration-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "migration.sqlite");
    seed.exec(`VACUUM INTO '${databasePath.replaceAll("'", "''")}'`);
    seed.close();
    const database = track(openDatabases, new DatabaseSync(databasePath));
    const writer = track(openDatabases, new DatabaseSync(databasePath));
    database.exec("PRAGMA foreign_keys = ON");
    writer.exec("PRAGMA foreign_keys = ON");
    const migration = readFileSync(retentionGenerationMigrationPath, "utf8");
    const triggerStart = migration.indexOf(
      "CREATE TRIGGER stripe_checkout_retention_generation_insert"
    );
    const backfillStart = migration.indexOf("-- Idempotent backfills cover rows");
    expect(triggerStart).toBeGreaterThan(0);
    expect(backfillStart).toBeGreaterThan(triggerStart);
    database.exec(migration.slice(0, triggerStart));
    insertCheckout(
      writer,
      "checkout_before_tracking_triggers",
      "request_before_tracking_triggers",
      "fingerprint_before_tracking_triggers"
    );
    insertWebhook(writer, "webhook_before_tracking_triggers");
    insertGift(
      writer,
      "gift_before_tracking_triggers",
      "pi_before_tracking_triggers",
      "checkout_before_tracking_triggers"
    );
    insertAcknowledgment(
      writer,
      "ack_before_tracking_triggers",
      "gift_before_tracking_triggers"
    );
    insertAnnualStatement(writer, "annual_before_tracking_triggers", "before@example.org");
    database.exec(migration.slice(triggerStart, backfillStart));
    insertCheckout(
      writer,
      "checkout_after_triggers_before_backfill",
      "request_after_triggers_before_backfill",
      "fingerprint_after_triggers_before_backfill"
    );
    insertWebhook(writer, "webhook_after_triggers_before_backfill");
    insertGift(
      writer,
      "gift_after_triggers_before_backfill",
      "pi_after_triggers_before_backfill",
      "checkout_after_triggers_before_backfill"
    );
    insertAcknowledgment(
      writer,
      "ack_after_triggers_before_backfill",
      "gift_after_triggers_before_backfill"
    );
    insertAnnualStatement(
      writer,
      "annual_after_triggers_before_backfill",
      "after@example.org"
    );
    writer.prepare(
      "UPDATE stripe_webhook_events SET id = ? WHERE id = ?"
    ).run("webhook_before_tracking_triggers_updated", "webhook_before_tracking_triggers");
    insertWebhook(writer, "webhook_deleted_before_backfill");
    writer.prepare("DELETE FROM stripe_webhook_events WHERE id = ?")
      .run("webhook_deleted_before_backfill");
    database.exec(migration.slice(backfillStart));

    const tracked = database.prepare(
      `SELECT table_name || ':' || row_id AS tracked
         FROM stripe_retention_generations
        ORDER BY tracked`
    ).all().map((row) => row.tracked);
    expect(tracked).toEqual([
      "stripe_acknowledgment_deliveries:ack_after_triggers_before_backfill",
      "stripe_acknowledgment_deliveries:ack_before_tracking_triggers",
      "stripe_annual_statement_deliveries:annual_after_triggers_before_backfill",
      "stripe_annual_statement_deliveries:annual_before_tracking_triggers",
      "stripe_checkout_sessions:checkout_after_triggers_before_backfill",
      "stripe_checkout_sessions:checkout_before_tracking_triggers",
      "stripe_gifts:gift_after_triggers_before_backfill",
      "stripe_gifts:gift_before_tracking_triggers",
      "stripe_webhook_events:webhook_after_triggers_before_backfill",
      "stripe_webhook_events:webhook_before_tracking_triggers_updated"
    ]);
  });

  it("orders an interleaved annual correction after its unbackfilled ancestry", () => {
    const seed = migratedDatabaseThrough("0035");
    insertAnnualStatement(seed, "annual_migration_root", "lineage@example.org");
    insertAnnualStatement(seed, "annual_migration_parent", "lineage@example.org", {
      revision: 2,
      supersedesDeliveryId: "annual_migration_root"
    });
    const directory = mkdtempSync(join(tmpdir(), "stripe-retention-lineage-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "migration.sqlite");
    seed.exec(`VACUUM INTO '${databasePath.replaceAll("'", "''")}'`);
    seed.close();
    const database = track(openDatabases, new DatabaseSync(databasePath));
    const writer = track(openDatabases, new DatabaseSync(databasePath));
    database.exec("PRAGMA foreign_keys = ON");
    writer.exec("PRAGMA foreign_keys = ON");
    const migration = readFileSync(retentionGenerationMigrationPath, "utf8");
    const backfillStart = migration.indexOf("-- Idempotent backfills cover rows");
    expect(backfillStart).toBeGreaterThan(0);

    database.exec(migration.slice(0, backfillStart));
    insertAnnualStatement(writer, "annual_migration_child", "lineage@example.org", {
      revision: 3,
      supersedesDeliveryId: "annual_migration_parent"
    });

    expect(annualGenerations(database)).toEqual([
      "annual_migration_root",
      "annual_migration_parent",
      "annual_migration_child"
    ]);
    database.exec(migration.slice(backfillStart));
    expect(annualGenerations(database)).toEqual([
      "annual_migration_root",
      "annual_migration_parent",
      "annual_migration_child"
    ]);
  });

  it("preserves annual lineage order across ancestor mutations and delete-reinsert", () => {
    const database = track(openDatabases, migratedDatabase());
    insertAnnualStatement(database, "annual_mutation_root", "mutation@example.org");
    insertAnnualStatement(database, "annual_mutation_child", "mutation@example.org", {
      revision: 2,
      supersedesDeliveryId: "annual_mutation_root"
    });
    const originalGenerations = annualGenerationRows(database);
    expect(originalGenerations.map((row) => row.id)).toEqual([
      "annual_mutation_root",
      "annual_mutation_child"
    ]);

    database.prepare(
      "UPDATE stripe_annual_statement_deliveries SET created_at = ? WHERE id = ?"
    ).run("2026-12-31T00:00:00.000Z", "annual_mutation_root");
    expect(annualGenerationRows(database)).toEqual(originalGenerations);
    expect(() => database.prepare(
      "UPDATE stripe_annual_statement_deliveries SET id = ? WHERE id = ?"
    ).run("annual_mutation_root_renamed", "annual_mutation_root")).toThrow(/FOREIGN KEY/);
    expect(() => database.prepare(
      "UPDATE stripe_annual_statement_deliveries SET supersedes_delivery_id = ? WHERE id = ?"
    ).run("annual_mutation_child", "annual_mutation_root")).toThrow(
      /stripe_annual_statement_snapshot_immutable/
    );
    expect(() => database.prepare(
      "DELETE FROM stripe_annual_statement_deliveries WHERE id = ?"
    ).run("annual_mutation_root")).toThrow(/FOREIGN KEY/);
    expect(annualGenerationRows(database)).toEqual(originalGenerations);

    insertAnnualStatement(database, "annual_mutation_grandchild", "mutation@example.org", {
      revision: 3,
      supersedesDeliveryId: "annual_mutation_child"
    });
    const oldLastGeneration = annualGenerationRows(database).at(-1)!.generation;
    database.prepare(
      "DELETE FROM stripe_annual_statement_deliveries WHERE id IN (?, ?, ?)"
    ).run(
      "annual_mutation_grandchild",
      "annual_mutation_child",
      "annual_mutation_root"
    );
    insertAnnualStatement(database, "annual_mutation_root", "mutation@example.org");
    insertAnnualStatement(database, "annual_mutation_child", "mutation@example.org", {
      revision: 2,
      supersedesDeliveryId: "annual_mutation_root"
    });
    insertAnnualStatement(database, "annual_mutation_grandchild", "mutation@example.org", {
      revision: 3,
      supersedesDeliveryId: "annual_mutation_child"
    });
    const reinserted = annualGenerationRows(database);
    expect(reinserted.map((row) => row.id)).toEqual([
      "annual_mutation_root",
      "annual_mutation_child",
      "annual_mutation_grandchild"
    ]);
    expect(reinserted[0].generation).toBeGreaterThan(oldLastGeneration);
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

  it("marks 0032 rows UNSPECIFIED but rejects omitted or UNSPECIFIED gift types for new rows", () => {
    const database = track(openDatabases, migratedDatabaseThrough("0032"));
    insertLegacyCheckout(database, "legacy_checkout", "legacy_request", "legacy_fingerprint");
    insertLegacyGift(database, "legacy_gift", "legacy_pi", "legacy_checkout");
    expect(existsSync(giftTypeMigrationPath)).toBe(true);
    database.exec(readFileSync(giftTypeMigrationPath, "utf8"));

    expect(database.prepare("SELECT gift_type FROM stripe_checkout_sessions WHERE id = 'legacy_checkout'").get())
      .toEqual({ gift_type: "UNSPECIFIED" });
    expect(database.prepare("SELECT gift_type FROM stripe_gifts WHERE id = 'legacy_gift'").get())
      .toEqual({ gift_type: "UNSPECIFIED" });
    expect(() => database.prepare(
      `INSERT INTO stripe_checkout_sessions (id, request_id, request_fingerprint, frequency, amount_cents, livemode, status, payment_status)
       VALUES ('new_omitted', 'new_request', 'new_fingerprint', 'ONCE', 5000, 0, 'CREATING', 'UNPAID')`
    ).run()).toThrow(/gift_type_required/);
    expect(() => database.prepare(
      `INSERT INTO stripe_checkout_sessions (id, request_id, request_fingerprint, frequency, amount_cents, livemode, status, payment_status, gift_type)
       VALUES ('new_unspecified', 'new_request_two', 'new_fingerprint_two', 'ONCE', 5000, 0, 'CREATING', 'UNPAID', 'UNSPECIFIED')`
    ).run()).toThrow(/gift_type_required/);
    expect(() => database.prepare(
      `INSERT INTO stripe_gifts (id, source_type, source_id, frequency, amount_cents, settled_at, status, gift_type)
       VALUES ('new_invalid', 'PAYMENT_INTENT', 'pi_invalid', 'ONCE', 5000, '2026-08-10T12:00:00.000Z', 'PAID', 'OTHER')`
    ).run()).toThrow(/CHECK constraint failed/);
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
  overrides: { frequency?: string; currency?: string; amountCents?: number; giftType?: string } = {}
): void {
  database.prepare(
    `INSERT INTO stripe_checkout_sessions (
       id, request_id, request_fingerprint, frequency, amount_cents, currency,
       livemode, status, payment_status, gift_type
     ) VALUES (?, ?, ?, ?, ?, ?, 0, 'CREATING', 'UNPAID', ?)`
  ).run(
    id,
    requestId,
    fingerprint,
    overrides.frequency ?? "ONCE",
    overrides.amountCents ?? 5000,
    overrides.currency ?? "usd",
    overrides.giftType ?? "TITHE"
  );
}

function insertLegacyCheckout(database: DatabaseSync, id: string, requestId: string, fingerprint: string): void {
  database.prepare(
    `INSERT INTO stripe_checkout_sessions (
       id, request_id, request_fingerprint, frequency, amount_cents, currency,
       livemode, status, payment_status
     ) VALUES (?, ?, ?, 'ONCE', 5000, 'usd', 0, 'CREATING', 'UNPAID')`
  ).run(id, requestId, fingerprint);
}

function insertLegacyGift(database: DatabaseSync, id: string, sourceId: string, checkoutId: string): void {
  database.prepare(
    `INSERT INTO stripe_gifts (
       id, source_type, source_id, checkout_id, stripe_payment_intent_id,
       frequency, amount_cents, currency, settled_at, status, refunded_amount_cents
     ) VALUES (?, 'PAYMENT_INTENT', ?, ?, ?, 'ONCE', 5000, 'usd',
       '2026-08-10T12:00:00.000Z', 'PAID', 0)`
  ).run(id, sourceId, checkoutId, sourceId);
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
  overrides: { refundedAmountCents?: number; giftType?: string } = {}
): void {
  database.prepare(
    `INSERT INTO stripe_gifts (
       id, source_type, source_id, checkout_id, stripe_payment_intent_id,
       frequency, amount_cents, currency, settled_at, status, refunded_amount_cents, gift_type
     ) VALUES (?, 'PAYMENT_INTENT', ?, ?, ?, 'ONCE', 5000, 'usd',
       '2026-08-10T12:00:00.000Z', 'PAID', ?, ?)`
  ).run(id, sourceId, checkoutId, sourceId, overrides.refundedAmountCents ?? 0, overrides.giftType ?? "TITHE");
}

function insertAcknowledgment(database: DatabaseSync, id: string, giftId: string): void {
  database.prepare(
    `INSERT INTO stripe_acknowledgment_deliveries (
       id, gift_id, status, attempt_count
     ) VALUES (?, ?, 'PENDING', 0)`
  ).run(id, giftId);
}

function insertAnnualStatement(
  database: DatabaseSync,
  id: string,
  donorEmail: string,
  options: { revision?: number; supersedesDeliveryId?: string } = {}
): void {
  database.prepare(
    `INSERT INTO stripe_annual_statement_deliveries (
       id, year, livemode, donor_key, donor_name, donor_email,
       snapshot_hash, snapshot_json, revision, supersedes_delivery_id, status
     ) VALUES (?, 2025, 0, ?, 'Migration Donor', ?, ?, '{}', ?, ?, 'PENDING')`
  ).run(
    id,
    donorEmail,
    donorEmail,
    id.padEnd(64, "0").slice(0, 64),
    options.revision ?? 1,
    options.supersedesDeliveryId ?? null
  );
}

function annualGenerations(database: DatabaseSync): string[] {
  return annualGenerationRows(database).map((row) => row.id);
}

function annualGenerationRows(
  database: DatabaseSync
): Array<{ id: string; generation: number }> {
  return database.prepare(
    `SELECT row_id AS id, generation
       FROM stripe_retention_generations
      WHERE table_name = 'stripe_annual_statement_deliveries'
      ORDER BY generation`
  ).all().map((row) => ({
    id: String(row.id),
    generation: Number(row.generation)
  }));
}
