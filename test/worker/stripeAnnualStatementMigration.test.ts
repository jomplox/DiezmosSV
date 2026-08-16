import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  migratedDatabase,
  migratedDatabaseThrough,
  migrationFiles
} from "./support/migratedDatabase";

const migrationPath = resolve(
  import.meta.dirname,
  "../../migrations/0034_stripe_annual_statements.sql"
);
const emailEvidenceDispatchGuardMigrationPath = resolve(
  import.meta.dirname,
  "../../migrations/0043_stripe_annual_email_evidence_dispatch_guard.sql"
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

  it("shows 0042 lets a mixed-version Worker finalize SENT without annual email evidence", () => {
    const database = migratedDatabaseThrough("0042");
    databases.push(database);
    insertDelivery(database, {
      id: "legacy_null_evidence_sent",
      donorKey: "legacy-null@example.org",
      snapshotHash: "6".repeat(64)
    });

    claimWithoutEmailEvidence(database, "legacy_null_evidence_sent");
    expect(startDispatch(database, "legacy_null_evidence_sent")).toBe(1);
    expect(finalizeSent(database, "legacy_null_evidence_sent")).toBe(1);
    expect(deliveryState(database, "legacy_null_evidence_sent")).toEqual({
      status: "SENT",
      dispatch_started_at: "2026-01-10T12:00:01.000Z",
      email_content_json: null
    });
  });

  it("blocks mixed-version dispatch and SENT finalization without annual email evidence", () => {
    const database = migratedDatabase();
    databases.push(database);
    insertDelivery(database, {
      id: "guarded_null_evidence_dispatch",
      donorKey: "guarded-dispatch@example.org",
      snapshotHash: "7".repeat(64)
    });
    claimWithoutEmailEvidence(database, "guarded_null_evidence_dispatch");

    expect(() => startDispatch(database, "guarded_null_evidence_dispatch"))
      .toThrow(/stripe_annual_statement_dispatch_requires_email_content/);
    expect(deliveryState(database, "guarded_null_evidence_dispatch")).toEqual({
      status: "PROCESSING",
      dispatch_started_at: null,
      email_content_json: null
    });

    insertPostDispatchLegacyDelivery(database, {
      id: "guarded_null_evidence_sent",
      donorKey: "guarded-sent@example.org",
      snapshotHash: "8".repeat(64)
    });
    expect(() => finalizeSent(database, "guarded_null_evidence_sent"))
      .toThrow(/stripe_annual_statement_sent_requires_email_content/);
    expect(deliveryState(database, "guarded_null_evidence_sent")).toEqual({
      status: "PROCESSING",
      dispatch_started_at: "2026-01-10T12:00:01.000Z",
      email_content_json: null
    });
  });

  it("allows evidence-backed dispatch and SENT while keeping the evidence immutable", () => {
    const database = migratedDatabase();
    databases.push(database);
    const evidence = JSON.stringify({
      version: 1,
      subject: "Constancia anual",
      text: "Adjuntamos su constancia anual.",
      html: "<p>Adjuntamos su constancia anual.</p>"
    });
    insertDelivery(database, {
      id: "evidence_backed_sent",
      donorKey: "evidence@example.org",
      snapshotHash: "9".repeat(64)
    });
    claimWithEmailEvidence(database, "evidence_backed_sent", evidence);

    expect(startDispatch(database, "evidence_backed_sent")).toBe(1);
    expect(finalizeSent(database, "evidence_backed_sent")).toBe(1);
    expect(deliveryState(database, "evidence_backed_sent")).toEqual({
      status: "SENT",
      dispatch_started_at: "2026-01-10T12:00:01.000Z",
      email_content_json: evidence
    });
    expect(() => database.prepare(
      "UPDATE stripe_annual_statement_deliveries SET email_content_json = '{}' WHERE id = ?"
    ).run("evidence_backed_sent")).toThrow(/stripe_annual_statement_email_content_immutable/);
  });

  it("upgrades 0042 legacy post-dispatch rows and still lets operators move them to REVIEW", () => {
    expect(migrationFiles().at(-1)).toBe(
      "0044_stripe_portal_capability.sql"
    );
    expect(existsSync(emailEvidenceDispatchGuardMigrationPath)).toBe(true);
    const database = migratedDatabaseThrough("0042");
    databases.push(database);
    insertPostDispatchLegacyDelivery(database, {
      id: "legacy_null_evidence_review",
      donorKey: "legacy-review@example.org",
      snapshotHash: "a".repeat(64)
    });

    database.exec(readFileSync(emailEvidenceDispatchGuardMigrationPath, "utf8"));
    expect(database.prepare(
      `UPDATE stripe_annual_statement_deliveries
          SET status = 'REVIEW', processing_claim_id = NULL,
              lease_expires_at = NULL, failure_code = 'EMAIL_DISPATCH_UNKNOWN',
              retry_safe = 0, updated_at = '2026-01-10T12:00:02.000Z'
        WHERE id = ?`
    ).run("legacy_null_evidence_review").changes).toBe(1);
    expect(deliveryState(database, "legacy_null_evidence_review")).toEqual({
      status: "REVIEW",
      dispatch_started_at: "2026-01-10T12:00:01.000Z",
      email_content_json: null
    });
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

function claimWithoutEmailEvidence(
  database: ReturnType<typeof migratedDatabase>,
  id: string
): void {
  database.prepare(
    `UPDATE stripe_annual_statement_deliveries
        SET status = 'PROCESSING', processing_claim_id = 'legacy_claim',
            lease_expires_at = '2026-01-10T12:05:00.000Z',
            attempt_count = attempt_count + 1,
            updated_at = '2026-01-10T12:00:00.000Z'
      WHERE id = ?`
  ).run(id);
}

function claimWithEmailEvidence(
  database: ReturnType<typeof migratedDatabase>,
  id: string,
  evidence: string
): void {
  database.prepare(
    `UPDATE stripe_annual_statement_deliveries
        SET status = 'PROCESSING', processing_claim_id = 'legacy_claim',
            lease_expires_at = '2026-01-10T12:05:00.000Z',
            attempt_count = attempt_count + 1, email_content_json = ?,
            updated_at = '2026-01-10T12:00:00.000Z'
      WHERE id = ?`
  ).run(evidence, id);
}

function startDispatch(
  database: ReturnType<typeof migratedDatabase>,
  id: string
): number {
  return Number(database.prepare(
    `UPDATE stripe_annual_statement_deliveries
        SET dispatch_started_at = '2026-01-10T12:00:01.000Z',
            updated_at = '2026-01-10T12:00:01.000Z'
      WHERE id = ? AND status = 'PROCESSING' AND dispatch_started_at IS NULL`
  ).run(id).changes);
}

function finalizeSent(
  database: ReturnType<typeof migratedDatabase>,
  id: string
): number {
  return Number(database.prepare(
    `UPDATE stripe_annual_statement_deliveries
        SET status = 'SENT', processing_claim_id = NULL, lease_expires_at = NULL,
            provider_id_hash = 'provider_hash', failure_code = NULL,
            retry_safe = 0, sent_at = '2026-01-10T12:00:02.000Z',
            updated_at = '2026-01-10T12:00:02.000Z'
      WHERE id = ? AND status = 'PROCESSING'`
  ).run(id).changes);
}

function insertPostDispatchLegacyDelivery(
  database: ReturnType<typeof migratedDatabase>,
  input: { id: string; donorKey: string; snapshotHash: string }
): void {
  database.prepare(
    `INSERT INTO stripe_annual_statement_deliveries (
       id, year, livemode, donor_key, donor_name, donor_email,
       snapshot_hash, snapshot_json, revision, status, attempt_count,
       processing_claim_id, lease_expires_at, dispatch_started_at,
       created_at, updated_at
     ) VALUES (?, 2025, 0, ?, 'Ana', ?, ?, '{}', 1, 'PROCESSING', 1,
       'legacy_claim', '2026-01-10T12:05:00.000Z',
       '2026-01-10T12:00:01.000Z', '2026-01-10T12:00:00.000Z',
       '2026-01-10T12:00:01.000Z')`
  ).run(input.id, input.donorKey, input.donorKey, input.snapshotHash);
}

function deliveryState(
  database: ReturnType<typeof migratedDatabase>,
  id: string
): { status: string; dispatch_started_at: string | null; email_content_json: string | null } {
  return database.prepare(
    `SELECT status, dispatch_started_at, email_content_json
       FROM stripe_annual_statement_deliveries WHERE id = ?`
  ).get(id) as {
    status: string;
    dispatch_started_at: string | null;
    email_content_json: string | null;
  };
}
