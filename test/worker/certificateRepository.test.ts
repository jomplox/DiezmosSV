import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Repository } from "../../src/worker/storage/repository";
import { migratedDatabase } from "./support/migratedDatabase";
import { SqliteD1 } from "./support/sqliteD1";

const range = {
  startIso: "2025-01-01T06:00:00.000Z",
  endIso: "2026-01-01T06:00:00.000Z"
};

describe("annual certificate bounded repository reads", () => {
  it("fetches at most a 51-summary sentinel page and resumes strictly after the displayed cursor", async () => {
    const database = migratedDatabase();
    for (let index = 0; index < 55; index += 1) {
      const sequence = String(index).padStart(3, "0");
      seedCertificateDocument(database, {
        id: `page_${sequence}`,
        donorEmail: `donor${sequence}@example.org`,
        donorName: `Donor ${sequence}`,
        issuedAt: `2025-02-01T12:${String(index % 60).padStart(2, "0")}:00.000Z`
      });
    }
    const d1 = new SqliteD1(database);
    const repository = new Repository(d1.database);

    const first = await repository.listAnnualCertificateDonorTargets(range, {
      afterGroupKey: null,
      limit: 999,
      search: null,
      unsentEmailOnly: false,
      year: 2025
    });
    expect(first).toHaveLength(51);
    expect(first[0].groupKey).toBe("donor000@example.org");
    expect(first[50].groupKey).toBe("donor050@example.org");

    const second = await repository.listAnnualCertificateDonorTargets(range, {
      afterGroupKey: first[49].groupKey,
      limit: 50,
      search: null,
      unsentEmailOnly: false,
      year: 2025
    });
    expect(second.map((target) => target.groupKey)).toEqual([
      "donor050@example.org",
      "donor051@example.org",
      "donor052@example.org",
      "donor053@example.org",
      "donor054@example.org"
    ]);

    const statements = d1.statements.filter((statement) => statement.sql.includes("annual_certificate_targets"));
    expect(statements).toHaveLength(2);
    expect(statements.every((statement) => /LIMIT\s+\?/i.test(statement.sql))).toBe(true);
    expect(statements[0].args.at(-1)).toBe(51);
    expect(statements[1].args.at(-1)).toBe(51);
    database.close();
  });

  it("uses FTS only to choose recipient keys, then returns each match's complete annual aggregate", async () => {
    const database = migratedDatabase();
    seedCertificateDocument(database, {
      id: "search_early",
      donorEmail: "jose@example.org",
      donorName: "José Álvarez",
      issuedAt: "2025-01-10T12:00:00.000Z",
      amountCents: 2500
    });
    seedCertificateDocument(database, {
      id: "search_later",
      donorEmail: "jose@example.org",
      donorName: "Nombre que no coincide",
      issuedAt: "2025-09-10T12:00:00.000Z",
      amountCents: 7501
    });
    seedCertificateDocument(database, {
      id: "search_other",
      donorEmail: "beto@example.org",
      donorName: "Beto",
      issuedAt: "2025-04-10T12:00:00.000Z",
      amountCents: 400
    });
    const d1 = new SqliteD1(database);
    const repository = new Repository(d1.database);

    const targets = await repository.listAnnualCertificateDonorTargets(range, {
      afterGroupKey: null,
      limit: 50,
      search: "jose",
      unsentEmailOnly: false,
      year: 2025
    });

    expect(targets).toEqual([
      {
        groupKey: "jose@example.org",
        donorName: "José Álvarez",
        donorEmail: "jose@example.org",
        count: 2,
        totalCents: 10001,
        hasTestEnvironment: false
      }
    ]);
    const statement = d1.statements.find((candidate) => candidate.sql.includes("annual_certificate_targets"));
    expect(statement?.sql).toContain("dte_document_search MATCH ?");
    expect(statement?.args).toContain("jose*");
    database.close();
  });

  it("excludes no-email and already-sent targets before the 11-row bulk sentinel", async () => {
    const database = migratedDatabase();
    seedCertificateDocument(database, {
      id: "bulk_no_email",
      donorEmail: null,
      donorName: "A Sin Correo",
      issuedAt: "2025-01-02T12:00:00.000Z"
    });
    for (let index = 0; index < 13; index += 1) {
      const sequence = String(index).padStart(2, "0");
      seedCertificateDocument(database, {
        id: `bulk_${sequence}`,
        donorEmail: `bulk${sequence}@example.org`,
        donorName: `Bulk ${sequence}`,
        issuedAt: `2025-03-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`
      });
    }
    database.prepare(
      `INSERT INTO audit_logs (id, actor_type, action, entity_type, entity_id, summary)
       VALUES ('bulk_sent', 'SYSTEM', 'DONOR_CERTIFICATE_SENT', 'donor_certificate',
               '2025:bulk00@example.org', 'already sent')`
    ).run();
    const d1 = new SqliteD1(database);
    const repository = new Repository(d1.database);

    const targets = await repository.listAnnualCertificateDonorTargets(range, {
      afterGroupKey: null,
      limit: 10,
      search: null,
      unsentEmailOnly: true,
      year: 2025
    });

    const statement = d1.statements.find((candidate) => candidate.sql.includes("annual_certificate_targets"));
    expect(statement?.sql).toContain("DONOR_CERTIFICATE_SENT");
    expect(statement?.args).toEqual([range.startIso, range.endIso, "2025", 11]);
    expect(statement?.args.at(-1)).toBe(11);
    expect(targets).toHaveLength(11);
    expect(targets.every((target) => target.donorEmail !== null)).toBe(true);
    expect(targets.map((target) => target.groupKey)).not.toContain("bulk00@example.org");
    database.close();
  });

  it("reads at most 26 ordered full DTE rows for one exact canonical recipient", async () => {
    const database = migratedDatabase();
    for (let index = 0; index < 30; index += 1) {
      seedCertificateDocument(database, {
        id: `dossier_${String(index).padStart(2, "0")}`,
        donorEmail: "dossier@example.org",
        donorName: "Dossier",
        issuedAt: `2025-05-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`
      });
    }
    seedCertificateDocument(database, {
      id: "dossier_claimed",
      donorEmail: "dossier@example.org",
      donorName: "Dossier",
      issuedAt: "2025-02-01T12:00:00.000Z",
      claimId: "in-flight"
    });
    const d1 = new SqliteD1(database);
    const repository = new Repository(d1.database);

    const documents = await repository.listAnnualCertificateDonorDocuments(
      range,
      "dossier@example.org",
      999
    );

    expect(documents).toHaveLength(26);
    expect(documents[0].id).toBe("dossier_00");
    expect(documents[25].id).toBe("dossier_25");
    expect(documents.map((document) => document.id)).not.toContain("dossier_claimed");
    const statement = d1.statements.find((candidate) => candidate.sql.includes("annual_certificate_documents"));
    expect(statement?.sql).toMatch(/ORDER BY\s+issued_at ASC,\s*id ASC[\s\S]*LIMIT\s+\?/i);
    expect(statement?.args.at(-1)).toBe(26);
    database.close();
  });
});

function seedCertificateDocument(
  database: DatabaseSync,
  input: {
    id: string;
    donorEmail: string | null;
    donorName: string | null;
    issuedAt: string;
    amountCents?: number;
    environment?: "00" | "01";
    claimId?: string | null;
  }
): void {
  const serial = input.id.replace(/\W/g, "").padStart(15, "0").slice(-15);
  database.prepare(
    `INSERT INTO dte_documents (
       id, environment, codigo_generacion, numero_control, status, plain_json,
       signed_jws, sello_recibido, mh_estado, amount_cents, issued_at,
       accepted_at, donor_email, donor_name, fiscal_operation_claim_id,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'ACCEPTED', '{}', 'signed', 'seal', 'PROCESADO', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    input.environment ?? "01",
    `generation-${input.id}`,
    `DTE-15-M001P001-${serial}`,
    input.amountCents ?? 100,
    input.issuedAt,
    input.issuedAt,
    input.donorEmail,
    input.donorName,
    input.claimId ?? null,
    input.issuedAt,
    input.issuedAt
  );
  database.prepare(
    `INSERT INTO dte_document_search (
       document_id, codigo_generacion, codigo_generacion_compact,
       numero_control, numero_control_compact, numero_control_serial,
       donor_email, donor_name
     ) SELECT id, codigo_generacion, lower(replace(codigo_generacion, '-', '')),
              numero_control, lower(replace(numero_control, '-', '')),
              ?, donor_email, donor_name
         FROM dte_documents WHERE id = ?`
  ).run(serial.replace(/^0+/, "") || serial, input.id);
}
