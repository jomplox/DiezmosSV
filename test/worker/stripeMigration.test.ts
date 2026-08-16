import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { claimStripeAnnualStatementDelivery } from "../../src/worker/storage/repository/stripeAnnualStatements";
import { migratedDatabase, migratedDatabaseThrough, migrationFiles } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");

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
const paymentMethodMigrationPath = resolve(
  import.meta.dirname,
  "../../migrations/0040_stripe_payment_method_evidence.sql"
);
const annualEmailEvidenceMigrationPath = resolve(
  import.meta.dirname,
  "../../migrations/0041_stripe_annual_email_evidence.sql"
);
const portalCapabilityMigrationPath = resolve(
  import.meta.dirname,
  "../../migrations/0044_stripe_portal_capability.sql"
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
      "payment_method_type",
      "payment_method_wallet",
      "payment_method_charge_id",
      "payment_method_event_id",
      "portal_capability_hash",
      "portal_capability_expires_at",
      "portal_capability_revoked_at",
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
      "processed_at",
      "stripe_payment_intent_id",
      "payment_method_type",
      "payment_method_wallet",
      "payment_method_charge_id",
      "payment_method_amount_cents"
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
      "payment_method_type",
      "payment_method_wallet",
      "payment_method_charge_id",
      "payment_method_event_id",
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
    expect(columnNames(database, "stripe_invoice_settlements")).toEqual(expect.arrayContaining([
      "payment_method_type",
      "payment_method_wallet",
      "payment_method_charge_id",
      "payment_method_event_id",
      "payment_method_payment_intent_id",
      "payment_method_amount_cents",
      "payment_method_livemode"
    ]));
  });

  it("upgrades existing Stripe checkouts with empty portal capability state", () => {
    const database = track(openDatabases, migratedDatabaseThrough("0043"));
    insertCheckout(database, "checkout_portal_upgrade", "request_portal_upgrade", "fingerprint_portal_upgrade");

    database.exec(readFileSync(portalCapabilityMigrationPath, "utf8"));

    expect(database.prepare(
      `SELECT portal_capability_hash, portal_capability_expires_at,
              portal_capability_revoked_at
         FROM stripe_checkout_sessions
        WHERE id = ?`
    ).get("checkout_portal_upgrade")).toEqual({
      portal_capability_hash: null,
      portal_capability_expires_at: null,
      portal_capability_revoked_at: null
    });
  });

  it("upgrades 0039 gifts as legacy evidence and makes newly attached methods immutable", () => {
    const database = track(openDatabases, migratedDatabaseThrough("0039"));
    insertCheckout(database, "checkout_method_upgrade", "request_method_upgrade", "fingerprint_method_upgrade");
    insertGift(database, "gift_method_upgrade", "pi_method_upgrade", "checkout_method_upgrade");

    database.exec(readFileSync(paymentMethodMigrationPath, "utf8"));
    expect(database.prepare(
      "SELECT payment_method_type FROM stripe_gifts WHERE id = 'gift_method_upgrade'"
    ).get()).toEqual({ payment_method_type: "legacy_stripe" });

    expect(database.prepare(
      `UPDATE stripe_gifts
          SET payment_method_type = 'card', payment_method_wallet = 'apple_pay',
              payment_method_charge_id = 'ch_method_upgrade',
              payment_method_event_id = 'evt_method_upgrade'
        WHERE id = 'gift_method_upgrade'`
    ).run().changes).toBe(1);
    expect(() => database.prepare(
      "UPDATE stripe_gifts SET payment_method_type = 'link' WHERE id = 'gift_method_upgrade'"
    ).run()).toThrow(/stripe_payment_method_immutable/);
    expect(() => database.prepare(
      `INSERT INTO stripe_gifts (
         id, source_type, source_id, frequency, gift_type, amount_cents,
         settled_at, status, payment_method_type
       ) VALUES ('gift_bad_method', 'PAYMENT_INTENT', 'pi_bad_method', 'ONCE',
         'TITHE', 5000, '2026-08-13T12:00:00.000Z', 'PAID', 'Card!')`
    ).run()).toThrow(/CHECK constraint failed/);
  });

  it("adds immutable annual email evidence without rewriting the legal statement snapshot", async () => {
    const database = track(openDatabases, migratedDatabaseThrough("0040"));
    database.prepare(
      `INSERT INTO stripe_annual_statement_deliveries (
         id, year, livemode, donor_key, donor_name, donor_email,
         snapshot_hash, snapshot_json, revision, supersedes_delivery_id,
         status, attempt_count, failure_code, retry_safe, created_at, updated_at
       ) VALUES (?, 2025, 0, 'ana@example.org', 'Ana', 'ana@example.org',
         ?, '{"version":2}', 1, NULL, 'FAILED', 1, 'EMAIL_PRE_DISPATCH_FAILED', 1, ?, ?)`
    ).run(
      "annual_email_upgrade",
      "a".repeat(64),
      "2026-01-10T12:00:00.000Z",
      "2026-01-10T12:00:00.000Z"
    );
    database.prepare(
      `INSERT INTO stripe_annual_statement_deliveries (
         id, year, livemode, donor_key, donor_name, donor_email,
         snapshot_hash, snapshot_json, revision, supersedes_delivery_id,
         status, attempt_count, processing_claim_id, lease_expires_at,
         retry_safe, created_at, updated_at
       ) VALUES (?, 2025, 0, 'bea@example.org', 'Bea', 'bea@example.org',
         ?, '{"version":2}', 1, NULL, 'PROCESSING', 1, 'legacy_claim', ?, 0, ?, ?)`
    ).run(
      "annual_email_stale_processing",
      "b".repeat(64),
      "2026-01-10T11:00:00.000Z",
      "2026-01-10T10:00:00.000Z",
      "2026-01-10T10:00:00.000Z"
    );

    database.exec(readFileSync(annualEmailEvidenceMigrationPath, "utf8"));
    expect(columnNames(database, "stripe_annual_statement_deliveries")).toContain("email_content_json");
    expect(database.prepare(
      "SELECT snapshot_json, email_content_json FROM stripe_annual_statement_deliveries WHERE id = ?"
    ).get("annual_email_upgrade")).toEqual({ snapshot_json: '{"version":2}', email_content_json: null });

    const evidence = JSON.stringify({ version: 1, subject: "Asunto", text: "Cuerpo", html: "<p>Cuerpo</p>" });
    expect(database.prepare(
      "UPDATE stripe_annual_statement_deliveries SET email_content_json = ? WHERE id = ?"
    ).run(evidence, "annual_email_upgrade").changes).toBe(1);
    expect(() => database.prepare(
      "UPDATE stripe_annual_statement_deliveries SET email_content_json = ? WHERE id = ?"
    ).run(JSON.stringify({ version: 1, subject: "Otro", text: "Otro", html: "Otro" }), "annual_email_upgrade"))
      .toThrow(/stripe_annual_statement_email_content_immutable/);

    const reclaimed = await claimStripeAnnualStatementDelivery(sqliteD1(database), {
      id: "annual_email_stale_processing",
      claimId: "replacement_claim",
      emailContentJson: evidence,
      now: "2026-01-10T12:00:00.000Z"
    });
    expect(reclaimed).toMatchObject({
      status: "PROCESSING",
      processing_claim_id: "replacement_claim",
      email_content_json: evidence
    });
  });

  it("backfills email evidence on a legacy row the provider already saw", async () => {
    const evidence = JSON.stringify({ version: 1, subject: "Asunto", text: "Cuerpo", html: "<p>Cuerpo</p>" });
    const legacyFailure = {
      id: "annual_email_legacy_dispatched",
      donorKey: "caro@example.org",
      snapshotHash: "c".repeat(64),
      dispatchStartedAt: "2026-01-01T00:00:00.000Z"
    };

    // 0041 alone wedges this row: its exemption also demanded a null
    // dispatch_started_at, which no retry-safe FAILED row carries.
    const wedged = track(openDatabases, migratedDatabaseThrough("0041"));
    insertRetrySafeAnnualFailure(wedged, legacyFailure);
    await expect(claimStripeAnnualStatementDelivery(sqliteD1(wedged), {
      id: legacyFailure.id,
      claimId: "wedged_claim",
      emailContentJson: evidence,
      now: "2026-02-01T12:00:00.000Z"
    })).rejects.toThrow(/stripe_annual_statement_email_content_immutable/);

    const database = track(openDatabases, migratedDatabase());
    insertRetrySafeAnnualFailure(database, legacyFailure);
    const claimed = await claimStripeAnnualStatementDelivery(sqliteD1(database), {
      id: legacyFailure.id,
      claimId: "repaired_claim",
      emailContentJson: evidence,
      now: "2026-02-01T12:00:00.000Z"
    });
    expect(claimed).toMatchObject({
      status: "PROCESSING",
      processing_claim_id: "repaired_claim",
      email_content_json: evidence
    });

    // Write-once still holds for the row that now carries evidence, and the
    // status guard still keeps content out of a SENT row.
    expect(() => database.prepare(
      "UPDATE stripe_annual_statement_deliveries SET email_content_json = ? WHERE id = ?"
    ).run(JSON.stringify({ version: 1, subject: "Otro", text: "Otro", html: "Otro" }), legacyFailure.id))
      .toThrow(/stripe_annual_statement_email_content_immutable/);
    expect(() => database.prepare(
      "UPDATE stripe_annual_statement_deliveries SET email_content_json = NULL WHERE id = ?"
    ).run(legacyFailure.id)).toThrow(/stripe_annual_statement_email_content_immutable/);
    database.prepare(
      `INSERT INTO stripe_annual_statement_deliveries (
         id, year, livemode, donor_key, donor_name, donor_email,
         snapshot_hash, snapshot_json, revision, status, attempt_count,
         dispatch_started_at, provider_id_hash, sent_at, created_at, updated_at
       ) VALUES ('annual_email_sent', 2025, 0, 'dora@example.org', 'Dora', 'dora@example.org',
         ?, '{"version":2}', 1, 'SENT', 1, ?, 'provider_hash', ?, ?, ?)`
    ).run(
      "d".repeat(64),
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:01.000Z"
    );
    expect(() => database.prepare(
      "UPDATE stripe_annual_statement_deliveries SET email_content_json = ? WHERE id = 'annual_email_sent'"
    ).run(evidence)).toThrow(/stripe_annual_statement_email_content_immutable/);
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

  it("rejects explicit gift type downgrades while tolerating unchanged historical rows", () => {
    const database = track(openDatabases, migratedDatabaseThrough("0032"));
    insertLegacyCheckout(database, "legacy_checkout_guard", "legacy_request_guard", "legacy_fingerprint_guard");
    insertLegacyGift(database, "legacy_gift_guard", "legacy_pi_guard", "legacy_checkout_guard");
    for (const filename of migrationFiles()) {
      const prefix = filename.slice(0, 4);
      if (prefix > "0032" && prefix <= "0037") {
        database.exec(readFileSync(resolve(migrationsDirectory, filename), "utf8"));
      }
    }

    expect(database.prepare(
      "UPDATE stripe_gifts SET gift_type = 'UNSPECIFIED' WHERE id = 'legacy_gift_guard'"
    ).run().changes).toBe(1);
    expect(database.prepare(
      "UPDATE stripe_checkout_sessions SET gift_type = 'UNSPECIFIED' WHERE id = 'legacy_checkout_guard'"
    ).run().changes).toBe(1);

    insertCheckout(database, "checkout_guard", "request_guard", "fingerprint_guard");
    insertGift(database, "gift_tithe_guard", "pi_tithe_guard", "checkout_guard", { giftType: "TITHE" });
    insertGift(database, "gift_offering_guard", "pi_offering_guard", "checkout_guard", { giftType: "OFFERING" });
    for (const id of ["gift_tithe_guard", "gift_offering_guard"]) {
      expect(() => database.prepare(
        "UPDATE stripe_gifts SET gift_type = 'UNSPECIFIED' WHERE id = ?"
      ).run(id)).toThrow(/stripe_gift_type_downgrade/);
    }
    expect(() => database.prepare(
      "UPDATE stripe_checkout_sessions SET gift_type = 'UNSPECIFIED' WHERE id = 'checkout_guard'"
    ).run()).toThrow(/stripe_gift_type_downgrade/);
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
  const hasRevision = Boolean(database.prepare(
    "SELECT 1 FROM pragma_table_info('stripe_acknowledgment_deliveries') WHERE name = 'revision'"
  ).get());
  if (!hasRevision) {
    database.prepare(
      `INSERT INTO stripe_acknowledgment_deliveries (
         id, gift_id, status, attempt_count
       ) VALUES (?, ?, 'PENDING', 0)`
    ).run(id, giftId);
    return;
  }
  database.prepare(
    `INSERT INTO stripe_acknowledgment_deliveries (
       id, gift_id, revision, kind, evidence_refunded_amount_cents,
       status, attempt_count
     ) VALUES (?, ?, 1, 'ORIGINAL', 0, 'PENDING', 0)`
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

function insertRetrySafeAnnualFailure(
  database: DatabaseSync,
  row: { id: string; donorKey: string; snapshotHash: string; dispatchStartedAt: string }
): void {
  database.prepare(
    `INSERT INTO stripe_annual_statement_deliveries (
       id, year, livemode, donor_key, donor_name, donor_email,
       snapshot_hash, snapshot_json, revision, supersedes_delivery_id,
       status, attempt_count, dispatch_started_at, failure_code, retry_safe,
       created_at, updated_at
     ) VALUES (?, 2025, 0, ?, 'Legacy Donor', ?, ?, '{"version":2}', 1, NULL,
       'FAILED', 1, ?, 'EMAIL_NOT_SENT', 1, ?, ?)`
  ).run(
    row.id,
    row.donorKey,
    row.donorKey,
    row.snapshotHash,
    row.dispatchStartedAt,
    row.dispatchStartedAt,
    row.dispatchStartedAt
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
