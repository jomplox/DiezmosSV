import type { DatabaseSync } from "node:sqlite";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { sendAnnualCertificates } from "../../src/worker/services/certificate";
import { Repository } from "../../src/worker/storage/repository";
import { emisorConfig } from "./support/dteFixtures";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { migratedDatabase } from "./support/migratedDatabase";
import { SqliteD1 } from "./support/sqliteD1";

const DONOR_EMAIL = "race@example.org";

describe("annual-certificate dossier consistency with real SQLite", () => {
  it("fails closed when a two-document target becomes empty after selection", async () => {
    const database = migratedDatabase();
    try {
      seedCertificateDocument(database, {
        id: "race_down_1",
        amountCents: 100,
        issuedAt: "2025-02-01T16:00:00.000Z"
      });
      seedCertificateDocument(database, {
        id: "race_down_2",
        amountCents: 200,
        issuedAt: "2025-03-01T16:00:00.000Z"
      });
      const harness = buildHarness(database);
      const originalTargets = harness.repository.listAnnualCertificateDonorTargets.bind(harness.repository);
      let aggregateBeforeMutation: unknown;
      harness.repository.listAnnualCertificateDonorTargets = async (...args) => {
        const targets = await originalTargets(...args);
        aggregateBeforeMutation = targets[0];
        database.prepare(
          "UPDATE dte_documents SET fiscal_operation_claim_id = 'claimed-after-aggregate' WHERE donor_email = ?"
        ).run(DONOR_EMAIL);
        return targets;
      };
      const pdfCreate = vi.spyOn(PDFDocument, "create");
      let result;

      try {
        result = await sendAnnualCertificates(harness.workerEnv, harness.repository, 2025, "reviewer", {});

        expect(pdfCreate).not.toHaveBeenCalled();
      } finally {
        pdfCreate.mockRestore();
      }

      expect(aggregateBeforeMutation).toMatchObject({ count: 2, totalCents: 300, hasTestEnvironment: false });
      expect(eligibleDocumentCount(database)).toBe(0);
      expect(result).toMatchObject({ processed: 1, sent: 0, skipped: 0, failed: 1 });
      expect(harness.emailSend).not.toHaveBeenCalled();
      expect(auditCount(database, "DONOR_CERTIFICATE_SENT")).toBe(0);
      expect(auditCount(database, "DONOR_CERTIFICATE_FAILED")).toBe(1);
      expect(documentReadCount(harness.d1)).toBe(1);
    } finally {
      database.close();
    }
  });

  it("fails closed when a second accepted document appears below the dossier cap", async () => {
    const database = migratedDatabase();
    try {
      seedCertificateDocument(database, {
        id: "race_insert_1",
        amountCents: 100,
        issuedAt: "2025-02-01T16:00:00.000Z"
      });
      const harness = buildHarness(database);
      const originalTargets = harness.repository.listAnnualCertificateDonorTargets.bind(harness.repository);
      let aggregateBeforeMutation: unknown;
      harness.repository.listAnnualCertificateDonorTargets = async (...args) => {
        const targets = await originalTargets(...args);
        aggregateBeforeMutation = targets[0];
        seedCertificateDocument(database, {
          id: "race_insert_2",
          amountCents: 200,
          issuedAt: "2025-03-01T16:00:00.000Z"
        });
        return targets;
      };
      const pdfCreate = vi.spyOn(PDFDocument, "create");
      let result;

      try {
        result = await sendAnnualCertificates(harness.workerEnv, harness.repository, 2025, "reviewer", {});

        expect(pdfCreate).not.toHaveBeenCalled();
      } finally {
        pdfCreate.mockRestore();
      }

      expect(aggregateBeforeMutation).toMatchObject({ count: 1, totalCents: 100, hasTestEnvironment: false });
      expect(eligibleDocumentCount(database)).toBe(2);
      expect(eligibleDocumentTotal(database)).toBe(300);
      expect(result).toMatchObject({ processed: 1, sent: 0, skipped: 0, failed: 1 });
      expect(harness.emailSend).not.toHaveBeenCalled();
      expect(auditCount(database, "DONOR_CERTIFICATE_SENT")).toBe(0);
      expect(auditCount(database, "DONOR_CERTIFICATE_FAILED")).toBe(1);
      expect(documentReadCount(harness.d1)).toBe(1);
    } finally {
      database.close();
    }
  });
});

function buildHarness(database: DatabaseSync) {
  const d1 = new SqliteD1(database);
  const repository = new Repository(d1.database);
  const emailSend = vi.fn(async () => ({ messageId: "accepted-by-provider" }));
  const workerEnv = env(new InMemoryD1(), {
    DB: d1.database,
    MOCK_EXTERNAL_SERVICES: "false",
    EMAIL_FROM: "sender@example.org",
    EMAIL: { send: emailSend } as unknown as SendEmail,
    EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
  });
  return { d1, repository, emailSend, workerEnv };
}

function documentReadCount(d1: SqliteD1): number {
  return d1.statements.filter((statement) => statement.sql.includes("annual_certificate_documents")).length;
}

function auditCount(database: DatabaseSync, action: string): number {
  return Number(database.prepare(
    "SELECT COUNT(*) AS count FROM audit_logs WHERE action = ? AND entity_id = ?"
  ).get(action, `2025:${DONOR_EMAIL}`)?.count ?? 0);
}

function eligibleDocumentCount(database: DatabaseSync): number {
  return Number(database.prepare(
    "SELECT COUNT(*) AS count FROM dte_documents WHERE donor_email = ? AND fiscal_operation_claim_id IS NULL"
  ).get(DONOR_EMAIL)?.count ?? 0);
}

function eligibleDocumentTotal(database: DatabaseSync): number {
  return Number(database.prepare(
    "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM dte_documents WHERE donor_email = ? AND fiscal_operation_claim_id IS NULL"
  ).get(DONOR_EMAIL)?.total ?? 0);
}

function controlNumber(id: string): string {
  const serial = id.replace(/\W/g, "").padStart(15, "0").slice(-15);
  return `DTE-15-M001P001-${serial}`;
}

function seedCertificateDocument(
  database: DatabaseSync,
  input: { id: string; amountCents: number; issuedAt: string }
): void {
  const numeroControl = controlNumber(input.id);
  const plainJson = JSON.stringify({
    identificacion: { version: 2, fecEmi: input.issuedAt.slice(0, 10), horEmi: "10:00:00", tipoMoneda: "USD" },
    emisor: { nombre: "MISION EXAMPLEORGANIZATION", numDocumento: "10000003520015" },
    receptor: { nombre: "Race Donor", correo: DONOR_EMAIL, tipoDocumento: "13", numDocumento: "100000001" },
    cuerpoDocumento: [{ cantidad: 1, descripcion: "DONACIÓN", valor: input.amountCents / 100 }],
    resumen: { valorTotal: input.amountCents / 100, totalLetras: null }
  });
  database.prepare(
    `INSERT INTO dte_documents (
       id, environment, codigo_generacion, numero_control, status, plain_json,
       signed_jws, sello_recibido, mh_estado, amount_cents, issued_at,
       accepted_at, donor_email, donor_name, fiscal_operation_claim_id,
       created_at, updated_at
     ) VALUES (?, '01', ?, ?, 'ACCEPTED', ?, 'signed', 'seal', 'PROCESADO', ?, ?, ?, ?, 'Race Donor', NULL, ?, ?)`
  ).run(
    input.id,
    `generation-${input.id}`,
    numeroControl,
    plainJson,
    input.amountCents,
    input.issuedAt,
    input.issuedAt,
    DONOR_EMAIL,
    input.issuedAt,
    input.issuedAt
  );
}
