import { execFileSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, PDFPage } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { makeDocument } from "./fixtures";
import {
  aggregateAnnualDonors,
  buildAnnualCertificatePreview,
  certificateYearError,
  elSalvadorYearWindow,
  renderCertificateDossierPdf,
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
      accepted({ id: "d1", donor_email: "ana@example.org", donor_name: "Ana", amount_cents: 2500, issued_at: "2025-02-01T10:00:00.000Z", accepted_at: "2025-02-01T10:05:00.000Z", numero_control: "DTE-15-0001" }),
      accepted({ id: "d2", donor_email: "ana@example.org", donor_name: "Ana Lopez", amount_cents: 7501, issued_at: "2025-05-10T10:00:00.000Z", accepted_at: "2025-05-10T10:05:00.000Z", numero_control: "DTE-15-0002" }),
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
    // The dossier source records ride along, ordered by accepted_at (tie-break issued_at, id),
    // and the INVALIDATED document never appears among them.
    expect(ana!.documents.map((document) => document.id)).toEqual(["d1", "d2"]);
    expect(ana!.documents.every((document) => document.status === "ACCEPTED")).toBe(true);

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

describe("buildAnnualCertificatePreview", () => {
  it("computes summary counts over the FULL year and caps donors to 50 with matchCount/truncated", async () => {
    // 60 unique donors so the preview must cap at 50.
    const rows = Array.from({ length: 60 }, (_, index) => {
      const seq = String(index).padStart(3, "0");
      return accepted({
        id: `d${seq}`,
        donor_email: `donor${seq}@example.org`,
        donor_name: `Donor ${seq}`,
        amount_cents: 100,
        issued_at: `2025-01-01T10:00:00.000Z`,
        numero_control: `DTE-15-${seq}`
      });
    });
    const preview = await buildAnnualCertificatePreview(new Repository(new FakeAggregationDb(rows) as unknown as D1Database), 2025);

    // Summary reflects the full unfiltered year.
    expect(preview.donorCount).toBe(60);
    expect(preview.withEmail).toBe(60);
    expect(preview.withoutEmail).toBe(0);
    expect(preview.totalLabel).toBe("$60.00");
    // Donors capped; new fields describe the full match set.
    expect(preview.donors).toHaveLength(50);
    expect(preview.matchCount).toBe(60);
    expect(preview.truncated).toBe(true);
  });

  it("filters donors by a deaccented, case-insensitive substring of name OR email, keeping full-year summary", async () => {
    const rows = [
      accepted({ id: "a", donor_email: "donor@example.org", donor_name: "Example Person", amount_cents: 500, issued_at: "2025-02-01T10:00:00.000Z", numero_control: "DTE-15-A" }),
      accepted({ id: "b", donor_email: "maria@example.org", donor_name: "ExamplePerson4", amount_cents: 700, issued_at: "2025-03-01T10:00:00.000Z", numero_control: "DTE-15-B" }),
      accepted({ id: "c", donor_email: "legacy-contact-5@example.com", donor_name: "ExamplePerson6", amount_cents: 300, issued_at: "2025-04-01T10:00:00.000Z", numero_control: "DTE-15-C" })
    ];
    const repo = new Repository(new FakeAggregationDb(rows) as unknown as D1Database);

    // "jose" (no accent) matches "Example Person" (accented) via deaccented compare.
    const byName = await buildAnnualCertificatePreview(repo, 2025, "example person");
    expect(byName.donors.map((donor) => donor.donorName)).toEqual(["Example Person"]);
    expect(byName.matchCount).toBe(1);
    expect(byName.truncated).toBe(false);
    // Summary counts still span the whole year, not just the filtered subset.
    expect(byName.donorCount).toBe(3);
    expect(byName.withEmail).toBe(3);
    expect(byName.totalLabel).toBe("$15.00");

    // Substring on the email domain matches across donors.
    const byEmail = await buildAnnualCertificatePreview(repo, 2025, "example.org");
    expect(byEmail.matchCount).toBe(2);
    expect(byEmail.donors.map((donor) => donor.groupKey).sort()).toEqual(["donor@example.org", "maria@example.org"]);

    // An empty/whitespace q behaves as no filter.
    const noFilter = await buildAnnualCertificatePreview(repo, 2025, "   ");
    expect(noFilter.matchCount).toBe(3);
    expect(noFilter.donors).toHaveLength(3);
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

  it("paginates high-frequency donors without losing rows, the total, or issue date", async () => {
    const donations = Array.from({ length: 40 }, (_, index) => ({
      issuedAt: `2025-01-${String((index % 28) + 1).padStart(2, "0")}T16:00:00.000Z`,
      dateLabel: `${String((index % 28) + 1).padStart(2, "0")}/01/2025`,
      numeroControl: `DTE-15-${String(index + 1).padStart(4, "0")}`,
      amountCents: 100
    }));
    const drawnText: Array<{ text: string; y: number }> = [];
    const originalDrawText = PDFPage.prototype.drawText;
    const drawText = vi.spyOn(PDFPage.prototype, "drawText").mockImplementation(function (this: PDFPage, text, options) {
      drawnText.push({ text, y: options?.y ?? 0 });
      return originalDrawText.call(this, text, options);
    });
    let pdf: Uint8Array;
    try {
      pdf = await renderCertificatePdf({
        year: 2025,
        donor: { ...summary(), count: donations.length, totalCents: 4000, donations },
        emisor: { nombre: "MISION EXAMPLEORGANIZATION", numDocumento: "10000003520015" },
        issuedOnLabel: "05/07/2026"
      });
    } finally {
      drawText.mockRestore();
    }

    const document = await PDFDocument.load(pdf);
    expect(document.getPageCount()).toBeGreaterThan(1);
    for (const donation of donations) {
      expect(drawnText.some(({ text }) => text === donation.numeroControl)).toBe(true);
    }
    expect(drawnText.find(({ text }) => text === "Total (40 donaciones)")?.y).toBeGreaterThan(90);
    expect(drawnText.find(({ text }) => text === "$40.00")?.y).toBeGreaterThan(90);
    expect(drawnText.find(({ text }) => text === "Fecha de emisión de la constancia: 05/07/2026")?.y).toBeGreaterThan(90);
  });
});


// pdf-lib deflates content streams on save; inflate them so color operators
// ("r g b rg") are assertable as text.
function inflatedPdfStreams(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf);
  const marker = Buffer.from("stream\n");
  const endMarker = Buffer.from("endstream");
  let out = "";
  let cursor = 0;
  while (true) {
    const start = raw.indexOf(marker, cursor);
    if (start === -1) break;
    const dataStart = start + marker.length;
    const end = raw.indexOf(endMarker, dataStart);
    if (end === -1) break;
    try {
      out += inflateSync(raw.subarray(dataStart, end)).toString("latin1");
    } catch {
      out += raw.subarray(dataStart, end).toString("latin1");
    }
    cursor = end + endMarker.length;
  }
  return out;
}

describe("renderCertificatePdf branding", () => {
  it("paints the constancia with the branding accent color instead of the fixed teal", async () => {
    // #336699 -> pdf-lib color operands 0.2 0.4 0.6 (exact: 51/255, 102/255, 153/255).
    const pdf = await renderCertificatePdf({
      year: 2025,
      donor: summary(),
      emisor: { nombre: "MISION EXAMPLEORGANIZATION", numDocumento: "10000003520015" },
      issuedOnLabel: "05/07/2026",
      accentColor: "#336699"
    });
    const streams = inflatedPdfStreams(pdf);
    expect(streams).toContain("0.2 0.4 0.6");
    // The historical teal must be gone when a custom accent is set.
    expect(streams).not.toContain("0.06 0.46 0.43");
  });

  it("keeps the historical teal when no accent is configured", async () => {
    const pdf = await renderCertificatePdf({
      year: 2025,
      donor: summary(),
      emisor: { nombre: "MISION EXAMPLEORGANIZATION", numDocumento: "10000003520015" },
      issuedOnLabel: "05/07/2026"
    });
    expect(inflatedPdfStreams(pdf)).toContain("0.06 0.46 0.43");
  });
});

describe("renderCertificateDossierPdf", () => {
  it("appends every ACCEPTED DTE after the summary page, one per page, in accepted_at order", async () => {
    const donor: DonorCertificateSummary = {
      ...summary(),
      documents: [
        dteRecord({ id: "d2", numero_control: "DTE-15-0002", accepted_at: "2025-05-10T16:10:00.000Z" }),
        dteRecord({ id: "d1", numero_control: "DTE-15-0001", accepted_at: "2025-02-01T16:10:00.000Z" })
      ]
    };
    const pdf = await renderCertificateDossierPdf({
      year: 2025,
      donor,
      emisor: { nombre: "MISION EXAMPLEORGANIZATION", numDocumento: "10000003520015" },
      issuedOnLabel: "05/07/2026"
    });

    const dir = mkdtempSync(join(tmpdir(), "diezmos-dossier-"));
    const pdfPath = join(dir, "dossier.pdf");
    const txtPath = join(dir, "dossier.txt");
    writeFileSync(pdfPath, pdf);
    execFileSync("pdftotext", ["-layout", pdfPath, txtPath]);
    const text = readFileSync(txtPath, "utf8");
    const pageInfo = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
    const pages = Number(pageInfo.match(/Pages:\s+(\d+)/)?.[1] ?? 0);

    // 1 summary page + 2 DTE pages.
    expect(pages).toBe(3);
    // Every appended DTE renders its comprobante layout.
    expect(text).toContain("COMPROBANTE DE DONACIÓN");

    // Per-page extraction proves ascending accepted_at order: d1 (Feb) before d2 (May).
    const perPage = execFileSync("pdftotext", ["-layout", "-f", "2", "-l", "2", pdfPath, "-"], { encoding: "utf8" });
    const perPage3 = execFileSync("pdftotext", ["-layout", "-f", "3", "-l", "3", pdfPath, "-"], { encoding: "utf8" });
    expect(perPage).toContain("DTE-15-0001");
    expect(perPage3).toContain("DTE-15-0002");
  });

  it("fails with a Spanish message when a DTE cannot be rendered", async () => {
    const donor: DonorCertificateSummary = {
      ...summary(),
      documents: [dteRecord({ id: "bad", plain_json: "not json at all" })]
    };
    await expect(
      renderCertificateDossierPdf({
        year: 2025,
        donor,
        emisor: { nombre: "MISION EXAMPLEORGANIZATION", numDocumento: "10000003520015" },
        issuedOnLabel: "05/07/2026"
      })
    ).rejects.toThrow(/comprobante/i);
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
    ],
    documents: []
  };
}

// A fully-formed DTE record whose plain_json renderDtePdf can consume.
function dteRecord(overrides: Partial<DteDocumentRecord>): DteDocumentRecord {
  return {
    ...accepted({}),
    plain_json: JSON.stringify({
      identificacion: { version: 2, fecEmi: "2025-02-01", horEmi: "10:00:00", tipoMoneda: "USD" },
      emisor: { nombre: "MISION EXAMPLEORGANIZATION", numDocumento: "10000003520015" },
      receptor: { nombre: "Ana Prueba", correo: "ana@example.org", tipoDocumento: "13", numDocumento: "100000001" },
      cuerpoDocumento: [{ cantidad: 1, descripcion: "DONACIÓN", valor: 100 }],
      resumen: { valorTotal: 100, totalLetras: null }
    }),
    ...overrides
  };
}

function accepted(overrides: Partial<DteDocumentRecord>): DteDocumentRecord {
  return makeDocument({
    id: "doc",
    wompi_event_id: null,
    environment: "01",
    plain_json: "{}",
    sello_recibido: "SELLO",
    donor_email: "donor@example.org",
    donor_name: "Donor",
    amount_cents: 100,
    issued_at: "2025-01-01T10:00:00.000Z",
    accepted_at: "2025-01-01T10:01:00.000Z",
    post_accept_finalized_at: null,
    created_at: "2025-01-01T10:00:00.000Z",
    updated_at: "2025-01-01T10:01:00.000Z",
    ...overrides
  });
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
