import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migratedDatabase, migratedDatabaseThrough } from "./support/migratedDatabase";

const migrationPath = resolve(
  import.meta.dirname,
  "../../migrations/0034_stripe_annual_statements.sql"
);

describe("Stripe U.S. annual statement persistence", () => {
  const databases: ReturnType<typeof migratedDatabase>[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it("upgrades 0033 with an immutable delivery and snapshot state machine", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const database = migratedDatabaseThrough("0033");
    databases.push(database);
    expect(tableNames(database)).not.toContain("stripe_annual_statement_deliveries");

    database.exec(readFileSync(migrationPath, "utf8"));

    expect(columnNames(database, "stripe_annual_statement_deliveries")).toEqual(expect.arrayContaining([
      "year",
      "livemode",
      "donor_key",
      "donor_name",
      "donor_email",
      "snapshot_hash",
      "snapshot_json",
      "revision",
      "supersedes_delivery_id",
      "status",
      "attempt_count",
      "processing_claim_id",
      "dispatch_started_at",
      "provider_id_hash",
      "failure_code",
      "retry_safe",
      "sent_at",
      "created_at",
      "updated_at"
    ]));
  });

  it("allows a repeated snapshot at a later revision while enforcing revision identity, lineage, and terminal evidence", () => {
    const database = migratedDatabase();
    databases.push(database);
    insertDelivery(database, { id: "delivery_1", snapshotHash: "1".repeat(64), revision: 1 });

    expect(() => insertDelivery(database, {
      id: "duplicate_snapshot",
      snapshotHash: "1".repeat(64),
      revision: 2,
      supersedesDeliveryId: "delivery_1"
    })).not.toThrow();
    expect(() => insertDelivery(database, {
      id: "duplicate_revision",
      snapshotHash: "2".repeat(64),
      revision: 1
    })).toThrow(/UNIQUE constraint failed/);
    expect(() => insertDelivery(database, {
      id: "bad_lineage",
      donorKey: "other@example.org",
      snapshotHash: "3".repeat(64),
      revision: 1,
      supersedesDeliveryId: "missing"
    })).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => insertDelivery(database, {
      id: "processing_without_claim",
      donorKey: "processing@example.org",
      snapshotHash: "4".repeat(64),
      status: "PROCESSING"
    })).toThrow(/CHECK constraint failed/);
    expect(() => insertDelivery(database, {
      id: "sent_without_evidence",
      donorKey: "sent@example.org",
      snapshotHash: "5".repeat(64),
      status: "SENT"
    })).toThrow(/CHECK constraint failed/);
  });
});

function tableNames(database: ReturnType<typeof migratedDatabase>): string[] {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function columnNames(database: ReturnType<typeof migratedDatabase>, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${JSON.stringify(table)})`).all() as Array<{ name: string }>)
    .map((row) => row.name);
}

function insertDelivery(
  database: ReturnType<typeof migratedDatabase>,
  overrides: {
    id: string;
    donorKey?: string;
    snapshotHash: string;
    revision?: number;
    supersedesDeliveryId?: string | null;
    status?: string;
  }
): void {
  database.prepare(
    `INSERT INTO stripe_annual_statement_deliveries (
       id, year, livemode, donor_key, donor_name, donor_email,
       snapshot_hash, snapshot_json, revision, supersedes_delivery_id,
       status, processing_claim_id, provider_id_hash, sent_at
     ) VALUES (?, 2025, 0, ?, 'Ana', ?, ?, '{}', ?, ?, ?, ?, ?, ?)`
  ).run(
    overrides.id,
    overrides.donorKey ?? "ana@example.org",
    overrides.donorKey ?? "ana@example.org",
    overrides.snapshotHash,
    overrides.revision ?? 1,
    overrides.supersedesDeliveryId ?? null,
    overrides.status ?? "PENDING",
    overrides.status === "PROCESSING" ? null : null,
    overrides.status === "SENT" ? null : null,
    overrides.status === "SENT" ? null : null
  );
}
