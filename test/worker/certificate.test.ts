import { execFileSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, PDFPage } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { makeDocument } from "./fixtures";
import {
  ANNUAL_CERTIFICATE_DOSSIER_DOCUMENT_LIMIT,
  ANNUAL_CERTIFICATE_PREVIEW_PAGE_SIZE,
  buildAnnualCertificatePreview,
  CertificateDossierLimitError,
  certificateYearError,
  elSalvadorYearWindow,
  renderCertificateDossierPdf,
  renderCertificatePdf,
  sendAnnualCertificates,
  type DonorCertificateSummary
} from "../../src/worker/services/certificate";
import type { AnnualCertificateDonorTarget, Repository } from "../../src/worker/storage/repository";
import type { DteDocumentRecord } from "../../src/worker/types";
import { emisorConfig } from "./support/dteFixtures";
import { env, InMemoryD1 } from "./support/inMemoryD1";

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

describe("buildAnnualCertificatePreview", () => {
  it("returns 50 donors plus truthful keyset continuation from a 51-row sentinel", async () => {
    const targets = Array.from({ length: ANNUAL_CERTIFICATE_PREVIEW_PAGE_SIZE + 1 }, (_, index) =>
      target(`donor${String(index).padStart(3, "0")}@example.org`)
    );
    const repo = new PreviewRepositoryFake(targets);

    const first = await buildAnnualCertificatePreview(repo as unknown as Repository, 2025, null, null);

    expect(first.donors).toHaveLength(ANNUAL_CERTIFICATE_PREVIEW_PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe("donor049@example.org");
    expect(repo.calls).toEqual([
      expect.objectContaining({ afterGroupKey: null, limit: ANNUAL_CERTIFICATE_PREVIEW_PAGE_SIZE, unsentEmailOnly: false })
    ]);

    repo.targets = [target("donor050@example.org")];
    const second = await buildAnnualCertificatePreview(repo as unknown as Repository, 2025, null, first.nextCursor);
    expect(second.donors.map((donor) => donor.groupKey)).toEqual(["donor050@example.org"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(repo.calls[1]).toMatchObject({ afterGroupKey: "donor049@example.org" });
  });

  it("maps bounded aggregate rows without loading full DTE documents", async () => {
    const repo = new PreviewRepositoryFake([
      target("ana@example.org", {
        donorName: "Ana",
        count: 26,
        totalCents: 12_501,
        hasTestEnvironment: true
      }),
      target("Sin Correo", { donorName: "Sin Correo", donorEmail: null })
    ]);

    const preview = await buildAnnualCertificatePreview(repo as unknown as Repository, 2025, "  ana  ", null);

    expect(preview).toEqual({
      year: 2025,
      donors: [
        {
          groupKey: "ana@example.org",
          donorName: "Ana",
          donorEmail: "ana@example.org",
          hasEmail: true,
          count: 26,
          totalLabel: "$125.01",
          hasTestEnvironment: true,
          dossierTooLarge: true
        },
        {
          groupKey: "Sin Correo",
          donorName: "Sin Correo",
          donorEmail: null,
          hasEmail: false,
          count: 1,
          totalLabel: "$1.00",
          hasTestEnvironment: false,
          dossierTooLarge: false
        }
      ],
      hasMore: false,
      nextCursor: null
    });
    expect(repo.calls[0]).toMatchObject({ search: "ana" });
    expect(repo.documentReads).toBe(0);
  });
});

describe("sendAnnualCertificates dossier bound", () => {
  it("rejects a 26th returned row before PDF/email even when the summary count is stale at 25", async () => {
    const documents = Array.from({ length: ANNUAL_CERTIFICATE_DOSSIER_DOCUMENT_LIMIT + 1 }, (_, index) =>
      dteRecord({
        id: `stale-count-${index}`,
        issued_at: `2025-03-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
        plain_json: "not-json-so-rendering-would-fail"
      })
    );
    const audits: Array<Record<string, unknown>> = [];
    const repo = {
      listAnnualCertificateDonorTargets: vi.fn().mockResolvedValue([
        target("stale-count@example.org", { count: ANNUAL_CERTIFICATE_DOSSIER_DOCUMENT_LIMIT })
      ]),
      listAnnualCertificateDonorDocuments: vi.fn().mockResolvedValue(documents),
      countAuditEntries: vi.fn().mockResolvedValue(0),
      getSetting: vi.fn().mockResolvedValue(null),
      createAudit: vi.fn().mockImplementation(async (audit: Record<string, unknown>) => {
        audits.push(audit);
      })
    };
    const emailSend = vi.fn();
    const workerEnv = env(new InMemoryD1(), {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "sender@example.org",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      EMAIL: { send: emailSend } as unknown as SendEmail
    });

    await expect(sendAnnualCertificates(
      workerEnv,
      repo as unknown as Repository,
      2025,
      "user_admin",
      { donor: "stale-count@example.org" }
    )).rejects.toBeInstanceOf(CertificateDossierLimitError);

    expect(repo.listAnnualCertificateDonorDocuments).toHaveBeenCalledWith(
      elSalvadorYearWindow(2025),
      "stale-count@example.org",
      26
    );
    expect(emailSend).not.toHaveBeenCalled();
    expect(audits).toContainEqual(expect.objectContaining({
      action: "DONOR_CERTIFICATE_FAILED",
      summary: expect.stringMatching(/límite de 25 comprobantes/i)
    }));
  });
});

describe("sendAnnualCertificates dossier snapshot", () => {
  it.each([
    {
      label: "the bounded read becomes empty",
      aggregate: { count: 0, totalCents: 0, hasTestEnvironment: false },
      documents: []
    },
    {
      label: "only the document count changes",
      aggregate: { count: 1, totalCents: 100, hasTestEnvironment: false },
      documents: [
        dteRecord({ id: "count-1", amount_cents: 40 }),
        dteRecord({ id: "count-2", amount_cents: 60 })
      ]
    },
    {
      label: "only the amount total changes",
      aggregate: { count: 1, totalCents: 100, hasTestEnvironment: false },
      documents: [dteRecord({ id: "amount-1", amount_cents: 101 })]
    },
    {
      label: "only the environment flag changes",
      aggregate: { count: 1, totalCents: 100, hasTestEnvironment: false },
      documents: [dteRecord({ id: "environment-1", environment: "00" })]
    }
  ])("fails closed before PDF/email when $label", async ({ aggregate, documents }) => {
    const harness = certificateSendHarness([
      target("snapshot@example.org", { donorName: "Snapshot", ...aggregate })
    ], new Map([["snapshot@example.org", documents]]));
    const pdfCreate = vi.spyOn(PDFDocument, "create");
    let result;

    try {
      result = await sendAnnualCertificates(harness.workerEnv, harness.repo, 2025, "user_admin", {});

      expect(pdfCreate).not.toHaveBeenCalled();
    } finally {
      pdfCreate.mockRestore();
    }

    expect(result).toMatchObject({ processed: 1, sent: 0, skipped: 0, failed: 1 });
    expect(harness.emailSend).not.toHaveBeenCalled();
    expect(harness.listDocuments).toHaveBeenCalledTimes(1);
    expect(harness.audits.filter((audit) => audit.action === "DONOR_CERTIFICATE_FAILED")).toHaveLength(1);
    expect(harness.audits.filter((audit) => audit.action === "DONOR_CERTIFICATE_SENT")).toHaveLength(0);
  });

  it("keeps an unchanged dossier on the successful send path", async () => {
    const harness = certificateSendHarness([
      target("stable@example.org", { donorName: "Stable", count: 1, totalCents: 100, hasTestEnvironment: false })
    ], new Map([["stable@example.org", [dteRecord({ id: "stable-1", donor_email: "stable@example.org" })]]]));

    const result = await sendAnnualCertificates(harness.workerEnv, harness.repo, 2025, "user_admin", {});

    expect(result).toMatchObject({ processed: 1, sent: 1, skipped: 0, failed: 0 });
    expect(harness.emailSend).toHaveBeenCalledTimes(1);
    expect(harness.listDocuments).toHaveBeenCalledTimes(1);
    expect(harness.audits.filter((audit) => audit.action === "DONOR_CERTIFICATE_SENT")).toHaveLength(1);
    expect(harness.audits.filter((audit) => audit.action === "DONOR_CERTIFICATE_FAILED")).toHaveLength(0);
  });

  it("audits one changed dossier once and continues to a later bulk target without retrying", async () => {
    const harness = certificateSendHarness([
      target("a-race@example.org", { donorName: "A Race", count: 1, totalCents: 100 }),
      target("b-next@example.org", { donorName: "B Next", count: 1, totalCents: 100 })
    ], new Map([
      ["a-race@example.org", [dteRecord({ id: "race-amount", donor_email: "a-race@example.org", amount_cents: 200 })]],
      ["b-next@example.org", [dteRecord({ id: "next-stable", donor_email: "b-next@example.org" })]]
    ]));
    const drawnText: string[] = [];
    const originalDrawText = PDFPage.prototype.drawText;
    const drawText = vi.spyOn(PDFPage.prototype, "drawText").mockImplementation(function (this: PDFPage, text, options) {
      drawnText.push(text);
      return originalDrawText.call(this, text, options);
    });
    let result;

    try {
      result = await sendAnnualCertificates(harness.workerEnv, harness.repo, 2025, "user_admin", {});
    } finally {
      drawText.mockRestore();
    }

    expect(result).toMatchObject({ processed: 2, sent: 1, skipped: 0, failed: 1 });
    expect(harness.emailSend).toHaveBeenCalledTimes(1);
    expect(harness.emailSend.mock.calls[0]?.[0]).toMatchObject({ to: "b-next@example.org" });
    expect(drawnText).not.toContain("A Race");
    expect(drawnText).toContain("B Next");
    expect(harness.listDocuments.mock.calls.map((call) => call[1])).toEqual([
      "a-race@example.org",
      "b-next@example.org"
    ]);
    expect(harness.audits.filter((audit) => audit.action === "DONOR_CERTIFICATE_FAILED")).toHaveLength(1);
    expect(harness.audits.filter((audit) => audit.action === "DONOR_CERTIFICATE_SENT")).toHaveLength(1);
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
  it("appends every ACCEPTED DTE after the summary page, one per page, in issued_at/id order", async () => {
    const donor: DonorCertificateSummary = {
      ...summary(),
      documents: [
        dteRecord({ id: "d2", numero_control: "DTE-15-0002", issued_at: "2025-05-10T16:00:00.000Z", accepted_at: "2025-02-01T16:10:00.000Z" }),
        dteRecord({ id: "d1", numero_control: "DTE-15-0001", issued_at: "2025-02-01T16:00:00.000Z", accepted_at: "2025-05-10T16:10:00.000Z" })
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

    // accepted_at points the other way; extraction proves ascending issued_at order.
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

function target(groupKey: string, overrides: Partial<AnnualCertificateDonorTarget> = {}): AnnualCertificateDonorTarget {
  return {
    groupKey,
    donorName: groupKey,
    donorEmail: groupKey.includes("@") ? groupKey : null,
    count: 1,
    totalCents: 100,
    hasTestEnvironment: false,
    ...overrides
  };
}

class PreviewRepositoryFake {
  readonly calls: Array<Record<string, unknown>> = [];
  documentReads = 0;

  constructor(public targets: AnnualCertificateDonorTarget[]) {}

  async listAnnualCertificateDonorTargets(
    _range: { startIso: string; endIso: string },
    options: Record<string, unknown>
  ): Promise<AnnualCertificateDonorTarget[]> {
    this.calls.push(options);
    return this.targets;
  }

  async listAnnualCertificateDonorDocuments(): Promise<DteDocumentRecord[]> {
    this.documentReads += 1;
    return [];
  }
}

function certificateSendHarness(
  targets: AnnualCertificateDonorTarget[],
  documentsByGroup: Map<string, DteDocumentRecord[]>
) {
  const audits: Array<Record<string, unknown>> = [];
  const listDocuments = vi.fn(async (
    _range: { startIso: string; endIso: string },
    groupKey: string
  ) => documentsByGroup.get(groupKey) ?? []);
  const repo = {
    listAnnualCertificateDonorTargets: vi.fn().mockResolvedValue(targets),
    listAnnualCertificateDonorDocuments: listDocuments,
    countAuditEntries: vi.fn().mockResolvedValue(0),
    getSetting: vi.fn().mockResolvedValue(null),
    createAudit: vi.fn().mockImplementation(async (audit: Record<string, unknown>) => {
      audits.push(audit);
    })
  } as unknown as Repository;
  const emailSend = vi.fn(async (_message: unknown) => ({ messageId: "certificate-snapshot-test" }));
  const workerEnv = env(new InMemoryD1(), {
    MOCK_EXTERNAL_SERVICES: "false",
    EMAIL_FROM: "sender@example.org",
    EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
    EMAIL: { send: emailSend } as unknown as SendEmail
  });
  return { audits, emailSend, listDocuments, repo, workerEnv };
}
