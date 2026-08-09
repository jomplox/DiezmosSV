import type { DatabaseSync } from "node:sqlite";
import { PDFDocument, PDFPage } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { sendAnnualCertificates } from "../../src/worker/services/certificate";
import { Repository } from "../../src/worker/storage/repository";
import { emisorConfig } from "./support/dteFixtures";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { migratedDatabase } from "./support/migratedDatabase";
import { SqliteD1 } from "./support/sqliteD1";

const DONOR_EMAIL = "race@example.org";
const REPLACEMENT_DONOR_EMAIL = "review-race@example.org";
const NEXT_DONOR_EMAIL = "z-next@example.org";

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

  it("fails a same-aggregate identity replacement once and continues to the next bulk donor", async () => {
    const database = migratedDatabase();
    const drawnText: string[] = [];
    const originalDrawText = PDFPage.prototype.drawText;
    const drawText = vi.spyOn(PDFPage.prototype, "drawText").mockImplementation(function (this: PDFPage, text, options) {
      drawnText.push(text);
      return originalDrawText.call(this, text, options);
    });
    try {
      seedCertificateDocument(database, {
        id: "old_row",
        donorEmail: REPLACEMENT_DONOR_EMAIL,
        donorName: "Old Donor",
        amountCents: 100,
        issuedAt: "2025-02-01T16:00:00.000Z"
      });
      seedCertificateDocument(database, {
        id: "next_row",
        donorEmail: NEXT_DONOR_EMAIL,
        donorName: "Next Donor",
        amountCents: 100,
        issuedAt: "2025-04-01T16:00:00.000Z"
      });
      const harness = buildHarness(database);
      const originalTargets = harness.repository.listAnnualCertificateDonorTargets.bind(harness.repository);
      let aggregateBeforeMutation: unknown;
      harness.repository.listAnnualCertificateDonorTargets = async (...args) => {
        const targets = await originalTargets(...args);
        aggregateBeforeMutation = targets.find((target) => target.groupKey === REPLACEMENT_DONOR_EMAIL);
        database.prepare(
          "UPDATE dte_documents SET fiscal_operation_claim_id = 'claimed-after-aggregate' WHERE id = 'old_row'"
        ).run();
        seedCertificateDocument(database, {
          id: "replacement_row",
          donorEmail: REPLACEMENT_DONOR_EMAIL,
          donorName: "Replacement Donor",
          amountCents: 100,
          issuedAt: "2025-03-01T16:00:00.000Z"
        });
        return targets;
      };

      const result = await sendAnnualCertificates(harness.workerEnv, harness.repository, 2025, "reviewer", {});

      expect(aggregateBeforeMutation).toMatchObject({
        donorName: "Old Donor",
        donorEmail: REPLACEMENT_DONOR_EMAIL,
        count: 1,
        totalCents: 100,
        hasTestEnvironment: false
      });
      expect(result).toMatchObject({ processed: 2, sent: 1, skipped: 0, failed: 1 });
      expect(harness.emailSend).toHaveBeenCalledTimes(1);
      expect(harness.emailSend.mock.calls[0]?.[0]).toMatchObject({ to: NEXT_DONOR_EMAIL });
      expect(drawnText).not.toContain("Old Donor");
      expect(drawnText).not.toContain("Replacement Donor");
      expect(drawnText).not.toContain("REPLACEMENT DONOR");
      expect(drawnText).not.toContain(controlNumber("replacement_row"));
      expect(drawnText).toContain("Next Donor");
      expect(auditCount(database, "DONOR_CERTIFICATE_SENT", REPLACEMENT_DONOR_EMAIL)).toBe(0);
      expect(auditCount(database, "DONOR_CERTIFICATE_FAILED", REPLACEMENT_DONOR_EMAIL)).toBe(1);
      expect(auditCount(database, "DONOR_CERTIFICATE_SENT", NEXT_DONOR_EMAIL)).toBe(1);
      expect(documentReadCountFor(harness.d1, REPLACEMENT_DONOR_EMAIL)).toBe(1);
      expect(documentReadCountFor(harness.d1, NEXT_DONOR_EMAIL)).toBe(1);
    } finally {
      drawText.mockRestore();
      database.close();
    }
  });
});

function buildHarness(database: DatabaseSync) {
  const d1 = new SqliteD1(database);
  const repository = new Repository(d1.database);
  const emailSend = vi.fn(async (_message: unknown) => ({ messageId: "accepted-by-provider" }));
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

function documentReadCountFor(d1: SqliteD1, donorEmail: string): number {
  return d1.statements.filter(
    (statement) => statement.sql.includes("annual_certificate_documents") && statement.args[2] === donorEmail
  ).length;
}

function auditCount(database: DatabaseSync, action: string, donorEmail = DONOR_EMAIL): number {
  return Number(database.prepare(
    "SELECT COUNT(*) AS count FROM audit_logs WHERE action = ? AND entity_id = ?"
  ).get(action, `2025:${donorEmail}`)?.count ?? 0);
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
  input: { id: string; donorEmail?: string; donorName?: string; amountCents: number; issuedAt: string }
): void {
  const donorEmail = input.donorEmail ?? DONOR_EMAIL;
  const donorName = input.donorName ?? "Race Donor";
  const numeroControl = controlNumber(input.id);
  const plainJson = JSON.stringify({
    identificacion: { version: 2, fecEmi: input.issuedAt.slice(0, 10), horEmi: "10:00:00", tipoMoneda: "USD" },
    emisor: { nombre: "MISION EXAMPLEORGANIZATION", numDocumento: "10000003520015" },
    receptor: { nombre: donorName, correo: donorEmail, tipoDocumento: "13", numDocumento: "100000001" },
    cuerpoDocumento: [{ cantidad: 1, descripcion: "DONACIÓN", valor: input.amountCents / 100 }],
    resumen: { valorTotal: input.amountCents / 100, totalLetras: null }
  });
  database.prepare(
    `INSERT INTO dte_documents (
       id, environment, codigo_generacion, numero_control, status, plain_json,
       signed_jws, sello_recibido, mh_estado, amount_cents, issued_at,
       accepted_at, donor_email, donor_name, fiscal_operation_claim_id,
       created_at, updated_at
     ) VALUES (?, '01', ?, ?, 'ACCEPTED', ?, 'signed', 'seal', 'PROCESADO', ?, ?, ?, ?, ?, NULL, ?, ?)`
  ).run(
    input.id,
    `generation-${input.id}`,
    numeroControl,
    plainJson,
    input.amountCents,
    input.issuedAt,
    input.issuedAt,
    donorEmail,
    donorName,
    input.issuedAt,
    input.issuedAt
  );
}
