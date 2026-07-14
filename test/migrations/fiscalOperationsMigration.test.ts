import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");

describe("migration 0020 fiscal operation claims", () => {
  it("upgrades a 0019 database without losing limiter claims or indexes", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");

    for (const filename of migrationFiles().filter((name) => name < "0020_")) {
      database.exec(readFileSync(resolve(migrationsDirectory, filename), "utf8"));
    }

    database.prepare(
      `INSERT INTO security_rate_limit_claims (id, scope, key_hash, claimed_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("claim_intent", "donation_intent", "hash-intent", "2026-07-14T12:00:00.000Z", "2026-07-14T13:00:00.000Z");
    database.prepare(
      `INSERT INTO security_rate_limit_claims (id, scope, key_hash, claimed_at, expires_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run("claim_reset", "password_reset", "hash-reset", "2026-07-14T12:00:00.000Z", "2026-07-14T13:00:00.000Z");

    database.exec(readFileSync(resolve(migrationsDirectory, "0020_fiscal_operation_claims.sql"), "utf8"));

    const columns = database.prepare("PRAGMA table_info(dte_documents)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "fiscal_operation_claim_id",
      "fiscal_operation_claimed_at",
      "fiscal_operation_kind",
      "fiscal_operation_event_id"
    ]));
    const wompiColumns = database.prepare("PRAGMA table_info(wompi_events)").all() as Array<{ name: string }>;
    expect(wompiColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "issuance_claim_id",
      "issuance_claimed_at"
    ]));

    const preserved = database
      .prepare("SELECT id, scope FROM security_rate_limit_claims ORDER BY id")
      .all();
    expect(preserved).toEqual([
      { id: "claim_intent", scope: "donation_intent" },
      { id: "claim_reset", scope: "password_reset" }
    ]);

    expect(() => database.prepare(
      `INSERT INTO security_rate_limit_claims (id, scope, key_hash, claimed_at, expires_at)
       VALUES (?, 'donation_datos', ?, ?, ?)`
    ).run("claim_datos", "hash-datos", "2026-07-14T12:00:00.000Z", "2026-07-14T13:00:00.000Z")).not.toThrow();

    const limiterIndexes = database.prepare("PRAGMA index_list(security_rate_limit_claims)").all() as Array<{ name: string }>;
    expect(limiterIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_security_rate_limit_claims_scope_key_claimed",
      "idx_security_rate_limit_claims_expires_at"
    ]));
    const documentIndexes = database.prepare("PRAGMA index_list(dte_documents)").all() as Array<{ name: string }>;
    expect(documentIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_dte_documents_fiscal_claims",
      "idx_dte_documents_unique_wompi_event"
    ]));
    const wompiIndexes = database.prepare("PRAGMA index_list(wompi_events)").all() as Array<{ name: string }>;
    expect(wompiIndexes.map((index) => index.name)).toContain("idx_wompi_events_issuance_claims");

    database.close();
  });
});

describe("migration 0021 security lifecycle guards", () => {
  it("adds recoverable acceptance and monotonic account lifecycle state", () => {
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");
    for (const filename of migrationFiles().filter((name) => name < "0021_")) {
      database.exec(readFileSync(resolve(migrationsDirectory, filename), "utf8"));
    }
    database.prepare(
      `INSERT INTO users (id, email, name, role, password_hash, password_salt)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run("user_existing", "existing@example.org", "Existing", "OPERATOR", "hash", "salt");
    database.prepare(
      `INSERT INTO dte_documents (
         id, environment, codigo_generacion, numero_control, status, plain_json,
         amount_cents, issued_at, accepted_at, created_at, updated_at
       ) VALUES (?, '00', ?, ?, 'ACCEPTED', '{}', 2500, ?, ?, ?, ?)`
    ).run(
      "doc_historical_accepted",
      "11111111-1111-4111-8111-111111111111",
      "DTE-15-M001P001-000000000000001",
      "2026-06-01T12:00:00.000Z",
      "2026-06-01T12:00:01.000Z",
      "2026-06-01T12:00:00.000Z",
      "2026-06-01T12:00:01.000Z"
    );

    database.exec(readFileSync(resolve(migrationsDirectory, "0021_security_lifecycle_guards.sql"), "utf8"));

    const documentColumns = database.prepare("PRAGMA table_info(dte_documents)").all() as Array<{ name: string }>;
    const userColumns = database.prepare("PRAGMA table_info(users)").all() as Array<{ name: string }>;
    expect(documentColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "post_accept_finalized_at",
      "post_accept_finalization_claim_id",
      "post_accept_finalization_claimed_at",
      "post_accept_email_dispatch_started_at"
    ]));
    expect(userColumns.map((column) => column.name)).toContain("auth_generation");
    expect(database.prepare("SELECT auth_generation FROM users WHERE id = ?").get("user_existing")).toEqual({ auth_generation: 0 });
    expect(database.prepare(
      `SELECT post_accept_finalized_at, post_accept_finalization_claim_id,
              post_accept_finalization_claimed_at, post_accept_email_dispatch_started_at
         FROM dte_documents WHERE id = ?`
    ).get("doc_historical_accepted")).toEqual({
      post_accept_finalized_at: "2026-06-01T12:00:01.000Z",
      post_accept_finalization_claim_id: null,
      post_accept_finalization_claimed_at: null,
      post_accept_email_dispatch_started_at: null
    });
    expect(database.prepare(
      "SELECT id FROM dte_documents WHERE status = 'ACCEPTED' AND post_accept_finalized_at IS NULL"
    ).all()).toEqual([]);

    const documentIndexes = database.prepare("PRAGMA index_list(dte_documents)").all() as Array<{ name: string }>;
    expect(documentIndexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      "idx_dte_documents_post_accept_pending",
      "idx_dte_documents_post_accept_claims"
    ]));
    database.close();
  });
});

function migrationFiles(): string[] {
  return readdirSync(migrationsDirectory)
    .filter((filename) => /^\d{4}_.+\.sql$/.test(filename))
    .sort();
}
