import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = resolve(
  import.meta.dirname,
  "../../scripts/check-migration-immutability.mjs"
);
const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function loadChecker() {
  expect(existsSync(scriptPath), "the migration immutability checker exists").toBe(
    true
  );
  return import(scriptPath);
}

function copiedMigrations(): string {
  const root = mkdtempSync(join(tmpdir(), "diezmossv-migrations-"));
  temporaryDirectories.push(root);
  const copy = join(root, "migrations");
  cpSync(migrationsDirectory, copy, { recursive: true });
  return copy;
}

describe("migration immutability checker", () => {
  it("pins the complete canonical name and SHA-256 ledger through the current migration", async () => {
    const { IMMUTABLE_MIGRATION_SHA256, assertImmutableMigrations } =
      await loadChecker();

    expect(Object.keys(IMMUTABLE_MIGRATION_SHA256).at(-1)).toBe(
      "0044_stripe_portal_capability.sql"
    );
    expect(Object.keys(IMMUTABLE_MIGRATION_SHA256)).toEqual([
      "0001_init.sql",
      "0002_contingency_batches.sql",
      "0003_runtime_settings.sql",
      "0004_email_delivery_evidence.sql",
      "0005_nullable_dte_wompi_source.sql",
      "0006_document_list_indexes.sql",
      "0007_dte_document_search_fts.sql",
      "0008_audit_action_index.sql",
      "0009_donation_intents.sql",
      "0010_donation_intents_optional_contact.sql",
      "0011_donation_intents_document_types.sql",
      "0012_donation_intents_gift_type.sql",
      "0013_audit_actor_context.sql",
      "0014_transmission_pending_status.sql",
      "0015_donation_intents_draft_donor.sql",
      "0016_donation_intents_paid_at.sql",
      "0017_donation_intents_datos_capability.sql",
      "0018_security_remediation_limits.sql",
      "0019_security_hardening.sql",
      "0020_fiscal_operation_claims.sql",
      "0021_security_lifecycle_guards.sql",
      "0022_security_boundary_guards.sql",
      "0023_wompi_issuance_lifecycle.sql",
      "0024_add_rate_limit_claim_ids.sql",
      "0025_email_delivery_recovery.sql",
      "0026_classify_legacy_email_rejections.sql",
      "0027_fiscal_corrections.sql",
      "0028_fiscal_correction_reservations.sql",
      "0029_wompi_payment_link_dedup.sql",
      "0030_wompi_reconciliation_lifecycle.sql",
      "0031_repair_wompi_payment_link_backfill.sql",
      "0032_stripe_us_donations.sql",
      "0033_stripe_gift_type.sql",
      "0034_stripe_annual_statements.sql",
      "0035_stripe_provider_chronology.sql",
      "0036_stripe_retention_generations.sql",
      "0037_stripe_delivery_safety.sql",
      "0038_stripe_integrity_fences.sql",
      "0039_stripe_donor_contact_evidence.sql",
      "0040_stripe_payment_method_evidence.sql",
      "0041_stripe_annual_email_evidence.sql",
      "0042_stripe_annual_email_evidence_reclaim.sql",
      "0043_stripe_annual_email_evidence_dispatch_guard.sql",
      "0044_stripe_portal_capability.sql"
    ]);
    expect(() => assertImmutableMigrations(migrationsDirectory)).not.toThrow();
  });

  it("fails if a historical migration is modified", async () => {
    const { assertImmutableMigrations } = await loadChecker();
    const copy = copiedMigrations();
    const target = join(copy, "0029_wompi_payment_link_dedup.sql");
    writeFileSync(target, `${readFileSync(target, "utf8")}\n-- mutation\n`);

    expect(() => assertImmutableMigrations(copy)).toThrow(
      /0029_wompi_payment_link_dedup\.sql.*modified/i
    );
  });

  it("fails if the newest pre-remediation migration is modified", async () => {
    const { assertImmutableMigrations } = await loadChecker();
    const copy = copiedMigrations();
    const target = join(copy, "0043_stripe_annual_email_evidence_dispatch_guard.sql");
    writeFileSync(target, `${readFileSync(target, "utf8")}\n-- mutation\n`);

    expect(() => assertImmutableMigrations(copy)).toThrow(
      /0043_stripe_annual_email_evidence_dispatch_guard\.sql.*modified/i
    );
  });

  it("fails if a historical migration is renamed or removed", async () => {
    const { assertImmutableMigrations } = await loadChecker();
    const renamed = copiedMigrations();
    renameSync(
      join(renamed, "0023_wompi_issuance_lifecycle.sql"),
      join(renamed, "0023_renamed.sql")
    );
    expect(() => assertImmutableMigrations(renamed)).toThrow(
      /0023_wompi_issuance_lifecycle\.sql.*missing/i
    );

    const removed = copiedMigrations();
    rmSync(join(removed, "0004_email_delivery_evidence.sql"));
    expect(() => assertImmutableMigrations(removed)).toThrow(
      /0004_email_delivery_evidence\.sql.*missing/i
    );
  });

  it.each([
    "0001_duplicate.sql",
    "0019_legacy_unexpected.sql",
    "0023_z_unexpected.sql",
    "0029_duplicate.sql"
  ])("rejects unexpected immutable-range migration %s", async (name) => {
    const { assertImmutableMigrations } = await loadChecker();
    const copy = copiedMigrations();
    writeFileSync(join(copy, name), "SELECT 1;\n");

    expect(() => assertImmutableMigrations(copy)).toThrow(
      new RegExp(`(?:unexpected historical migration ${name}|duplicate migration prefix ${name.slice(0, 4)})`, "i")
    );
  });

  it("rejects a duplicate numeric prefix anywhere in the migration directory", async () => {
    const { assertImmutableMigrations } = await loadChecker();
    const copy = copiedMigrations();
    writeFileSync(join(copy, "0032_duplicate.sql"), "SELECT 1;\n");

    expect(() => assertImmutableMigrations(copy)).toThrow(/duplicate migration prefix 0032/i);
  });

  it("accepts only the next unique additive migration prefix", async () => {
    const { assertImmutableMigrations } = await loadChecker();
    const copy = copiedMigrations();
    writeFileSync(join(copy, "0045_future_addition.sql"), "SELECT 1;\n");

    expect(() => assertImmutableMigrations(copy)).not.toThrow();
  });
});
