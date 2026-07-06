import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  aggregateAnnualDonors,
  certificateYearError,
  elSalvadorYearWindow,
  renderCertificatePdf,
  type DonorCertificateSummary
} from "../../src/worker/services/certificate";
import { Repository } from "../../src/worker/storage/repository";
import type { DteDocumentRecord } from "../../src/worker/types";

describe("elSalvadorYearWindow", () => {
  it("spans the calendar year in El Salvador local time (UTC-6)", () => {
    expect(elSalvadorYearWindow(2025)).toEqual({
      startIso: "2025-01-01T06:00:00.000Z",
      endIso: "2026-01-01T06:00:00.000Z"
    });
  });
});

describe("certificateYearError", () => {
  const now = new Date("2026-07-05T12:00:00.000Z");

  it("accepts the current year and completed years", () => {
    expect(certificateYearError("2026", now)).toBeNull();
    expect(certificateYearError("2025", now)).toBeNull();
  });

  it("rejects future years and malformed input", () => {
    expect(certificateYearError("2027", now)).not.toBeNull();
    expect(certificateYearError("20AB", now)).not.toBeNull();
    expect(certificateYearError("", now)).not.toBeNull();
  });
});

describe("aggregateAnnualDonors", () => {
  it("groups ACCEPTED donations per donor by email, sums integer cents, excludes other statuses and years", async () => {
    const db = new FakeAggregationDb([
      accepted({ id: "d1", donor_email: "ana@example.org", donor_name: "Ana", amount_cents: 2500, issued_at: "2025-02-01T10:00:00.000Z", numero_control: "DTE-15-0001" }),
      accepted({ id: "d2", donor_email: "ana@example.org", donor_name: "Ana Lopez", amount_cents: 7501, issued_at: "2025-05-10T10:00:00.000Z", numero_control: "DTE-15-0002" }),
      accepted({ id: "d3", donor_email: "beto@example.org", donor_name: "Beto", amount_cents: 100, issued_at: "2025-11-30T10:00:00.000Z", numero_control: "DTE-15-0003" }),
      // Excluded: invalidated
      accepted({ id: "d4", donor_email: "ana@example.org", donor_name: "Ana", amount_cents: 9999, issued_at: "2025-06-01T10:00:00.000Z", numero_control: "DTE-15-0004", status: "INVALIDATED" }),
      // Excluded: different year
      accepted({ id: "d5", donor_email: "ana@example.org", donor_name: "Ana", amount_cents: 5000, issued_at: "2024-12-31T10:00:00.000Z", numero_control: "DTE-15-0005" })
    ]);

    const donors = await aggregateAnnualDonors(new Repository(db as unknown as D1Database), 2025);

    expect(donors).toHaveLength(2);
    const ana = donors.find((donor) => donor.groupKey === "ana@example.org");
    expect(ana).toBeDefined();
    expect(ana!.donorEmail).toBe("ana@example.org");
    expect(ana!.count).toBe(2);
    expect(ana!.totalCents).toBe(10001);
    expect(ana!.donations.map((donation) => donation.numeroControl)).toEqual(["DTE-15-0001", "DTE-15-0002"]);
    expect(ana!.hasTestEnvironment).toBe(false);

    const beto = donors.find((donor) => donor.groupKey === "beto@example.org");
    expect(beto!.totalCents).toBe(100);
    expect(beto!.count).toBe(1);
  });

  it("falls back to donor_name when email is missing and flags test environment", async () => {
    const db = new FakeAggregationDb([
      accepted({ id: "n1", donor_email: null, donor_name: "Sin Correo", amount_cents: 500, issued_at: "2025-03-01T10:00:00.000Z", numero_control: "DTE-15-1001", environment: "00" })
    ]);

    const donors = await aggregateAnnualDonors(new Repository(db as unknown as D1Database), 2025);

    expect(donors).toHaveLength(1);
    expect(donors[0].groupKey).toBe("Sin Correo");
    expect(donors[0].donorEmail).toBeNull();
    expect(donors[0].hasTestEnvironment).toBe(true);
  });
});

describe("renderCertificatePdf", () => {
  it("renders the annual certificate content without any MH seal claim", async () => {
    const pdf = await renderCertificatePdf({
      year: 2025,
      donor: summary(),
      emisor: { nombre: "MISION EXAMPLEORGANIZATION", numDocumento: "10000003520015" },
      issuedOnLabel: "05/07/2026"
    });

    const dir = mkdtempSync(join(tmpdir(), "diezmos-cert-"));
    const pdfPath = join(dir, "cert.pdf");
    const txtPath = join(dir, "cert.txt");
    writeFileSync(pdfPath, pdf);
    execFileSync("pdftotext", ["-layout", pdfPath, txtPath]);
    const text = readFileSync(txtPath, "utf8");

    expect(text).toContain("Constancia de Donaciones 2025");
    expect(text).toContain("MISION EXAMPLEORGANIZATION");
    expect(text).toContain("Ana Prueba");
    expect(text).toContain("DTE-15-0001");
    expect(text).toContain("Total");
    expect(text).toContain("125.01");
    expect(text).toContain("Los CDE individuales constituyen los comprobantes fiscales");
    // Informational document: must NOT assert any MH reception seal.
    expect(text).not.toContain("Sello de recepción");
    expect(text).not.toContain("Sello de recepcion");
  });

  it("prints the test-environment warning when any donation is ambiente 00", async () => {
    const pdf = await renderCertificatePdf({
      year: 2025,
      donor: { ...summary(), hasTestEnvironment: true },
      emisor: { nombre: "MISION EXAMPLEORGANIZATION", numDocumento: "10000003520015" },
      issuedOnLabel: "05/07/2026"
    });
    const dir = mkdtempSync(join(tmpdir(), "diezmos-cert-test-"));
    const pdfPath = join(dir, "cert.pdf");
    const txtPath = join(dir, "cert.txt");
    writeFileSync(pdfPath, pdf);
    execFileSync("pdftotext", ["-layout", pdfPath, txtPath]);
    const text = readFileSync(txtPath, "utf8");

    expect(text).toContain("AMBIENTE DE PRUEBAS");
    expect(text).toContain("SIN VALIDEZ FISCAL");
  });
});

function summary(): DonorCertificateSummary {
  return {
    groupKey: "ana@example.org",
    donorName: "Ana Prueba",
    donorEmail: "ana@example.org",
    count: 2,
    totalCents: 12501,
    hasTestEnvironment: false,
    donations: [
      { issuedAt: "2025-02-01T16:00:00.000Z", dateLabel: "01/02/2025", numeroControl: "DTE-15-0001", amountCents: 2500 },
      { issuedAt: "2025-05-10T16:00:00.000Z", dateLabel: "10/05/2025", numeroControl: "DTE-15-0002", amountCents: 10001 }
    ]
  };
}

function accepted(overrides: Partial<DteDocumentRecord>): DteDocumentRecord {
  return {
    id: "doc",
    wompi_event_id: null,
    tipo_dte: "15",
    environment: "01",
    codigo_generacion: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4",
    numero_control: "DTE-15-M001P004-000000000000009",
    status: "ACCEPTED",
    plain_json: "{}",
    signed_jws: null,
    sello_recibido: "SELLO",
    mh_estado: "PROCESADO",
    mh_observaciones_json: "[]",
    donor_email: "donor@example.org",
    donor_name: "Donor",
    amount_cents: 100,
    issued_at: "2025-01-01T10:00:00.000Z",
    accepted_at: "2025-01-01T10:01:00.000Z",
    contingency_period_id: null,
    transmission_deferred_at: null,
    created_at: "2025-01-01T10:00:00.000Z",
    updated_at: "2025-01-01T10:01:00.000Z",
    ...overrides
  };
}

// Minimal D1 fake that only answers the keyset-paged ACCEPTED-in-year query.
class FakeAggregationDb {
  constructor(private readonly rows: DteDocumentRecord[]) {}

  prepare(sql: string) {
    const rows = this.rows;
    let args: unknown[] = [];
    return {
      bind(...bound: unknown[]) {
        args = bound;
        return this;
      },
      async all<T>(): Promise<{ results: T[] }> {
        if (!sql.includes("FROM dte_documents") || !sql.includes("status = 'ACCEPTED'")) {
          return { results: [] };
        }
        const [startIso, endIso] = [String(args[0]), String(args[1])];
        let filtered = rows.filter(
          (row) => row.status === "ACCEPTED" && row.issued_at >= startIso && row.issued_at < endIso
        );
        if (sql.includes("(issued_at, id) > (?, ?)")) {
          const [afterIssued, afterId] = [String(args[2]), String(args[3])];
          filtered = filtered.filter(
            (row) => row.issued_at > afterIssued || (row.issued_at === afterIssued && row.id > afterId)
          );
        }
        filtered.sort((left, right) => left.issued_at.localeCompare(right.issued_at) || left.id.localeCompare(right.id));
        const limit = Number(args.at(-1) ?? 500);
        return { results: filtered.slice(0, limit) as T[] };
      }
    };
  }
}
