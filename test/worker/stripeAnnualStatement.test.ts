import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, PDFPage } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  buildStripeAnnualStatementPreview,
  buildStripeAnnualStatementSnapshot,
  renderStripeAnnualStatementPdf,
  sendStripeAnnualStatements,
  stripeAnnualStatementEmailContent,
  stripeUsCurrentYear,
  stripeUsYearWindow,
  type RenderStripeAnnualStatementPdfInput,
  type StripeAnnualStatementDocumentEvidence
} from "../../src/worker/services/stripeAnnualStatement";
import * as stripePdfAssets from "../../src/worker/services/stripePdfAssets";
import { Repository } from "../../src/worker/storage/repository";
import type { StripeAnnualStatementGift } from "../../src/worker/storage/repository/stripeAnnualStatements";
import type { Env } from "../../src/worker/types";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { migratedDatabase } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";

const temporaryDirectories: string[] = [];
type AnnualDrawTextCall = Parameters<PDFPage["drawText"]>;
type PositionedAnnualDrawTextOptions = NonNullable<AnnualDrawTextCall[1]> & {
  font: NonNullable<NonNullable<AnnualDrawTextCall[1]>["font"]>;
  x: number;
  y: number;
};

afterEach(() => {
  vi.restoreAllMocks();
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe("Stripe U.S. annual statement calendar", () => {
  it("fails closed without a valid configured IANA zone outside Stripe mock mode", () => {
    expect(() => stripeUsYearWindow({}, 2025)).toThrow(/STRIPE_US_TIME_ZONE/);
    expect(() => stripeUsYearWindow({ STRIPE_US_TIME_ZONE: "Not/AZone" }, 2025)).toThrow(/STRIPE_US_TIME_ZONE/);
  });

  it("uses America/New_York in deterministic mock mode and respects local year edges", () => {
    expect(stripeUsYearWindow({ STRIPE_MOCK_MODE: "1" }, 2025)).toEqual({
      timeZone: "America/New_York",
      startIso: "2025-01-01T05:00:00.000Z",
      endIso: "2026-01-01T05:00:00.000Z"
    });
  });

  it("derives the current statement year in the validated U.S. timezone", () => {
    const boundary = new Date("2026-01-01T00:30:00.000Z");

    expect(stripeUsCurrentYear({ STRIPE_MOCK_MODE: "1" }, boundary)).toBe(2025);
    expect(stripeUsCurrentYear({ STRIPE_US_TIME_ZONE: "America/Los_Angeles" }, boundary)).toBe(2025);
    expect(() => stripeUsCurrentYear({ STRIPE_US_TIME_ZONE: "Not/AZone" }, boundary)).toThrow(/STRIPE_US_TIME_ZONE/);
  });
});

describe("Stripe U.S. annual statement snapshot and rendering", () => {
  it("embeds the approved logo asset for annual legal statements", () => {
    const assets = stripePdfAssets as Record<string, unknown>;
    const bytes = assets.STRIPE_ANNUAL_FMCE_LOGO_BYTES as Uint8Array;

    expect(assets.STRIPE_ANNUAL_FMCE_LOGO_SHA256)
      .toBe("ac235e246a9d15381b32501f49eec7e8f8fb60a52214e0fde9a6595e5c67e19c");
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe("ac235e246a9d15381b32501f49eec7e8f8fb60a52214e0fde9a6595e5c67e19c");
    expect(pngDimensions(bytes)).toEqual({ width: 2393, height: 672 });
  });

  it("rejects annual snapshots that claim any logo other than the immutable FMCE PNG", async () => {
    const invalidLogos = [
      null,
      { format: "jpeg", hash: "ac235e246a9d15381b32501f49eec7e8f8fb60a52214e0fde9a6595e5c67e19c" },
      { format: "png", hash: "0".repeat(64) }
    ];

    for (const logo of invalidLogos) {
      const document = {
        ...statementDocument(),
        logo
      } as unknown as StripeAnnualStatementDocumentEvidence;
      await expect(buildStripeAnnualStatementSnapshot({
        year: 2025,
        livemode: false,
        donorKey: "logo-evidence@example.org",
        donorName: "Logo Evidence Donor",
        donorEmail: "logo-evidence@example.org",
        document,
        gifts: [gift({ id: "gift_logo_evidence" })]
      })).rejects.toThrow(/immutable FMCE PNG/i);
    }
  });

  it("keeps the fixed approved logo beside the title on U.S. Letter", async () => {
    const drawImage = vi.spyOn(PDFPage.prototype, "drawImage");
    const drawText = vi.spyOn(PDFPage.prototype, "drawText");
    const snapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "logo@example.org",
      donorName: "Logo Donor",
      donorEmail: "logo@example.org",
      document: statementDocument(),
      gifts: [gift({ id: "gift_logo" })]
    });
    const bytes = await renderStripeAnnualStatementPdf({
      snapshot,
      issuedOn: "2026-01-10T12:00:00.000Z",
      corrected: false
    });
    const pdf = await PDFDocument.load(bytes);
    const metadataDirectory = mkdtempSync(join(tmpdir(), "stripe-annual-version-"));
    temporaryDirectories.push(metadataDirectory);
    const metadataPath = join(metadataDirectory, "statement.pdf");
    writeFileSync(metadataPath, bytes);
    expect(execFileSync("pdfinfo", [metadataPath], { encoding: "utf8" }))
      .toContain("Producer:        stripe-annual-statement-pdf:v6");
    expect(pdf.getPages().map((page) => page.getMediaBox()))
      .toEqual([{ x: 0, y: 0, width: 612, height: 792 }]);

    expect(drawImage).toHaveBeenCalledTimes(1);
    const logoCall = drawImage.mock.calls[0];
    if (!logoCall) throw new Error("Annual-statement logo was not drawn");
    const [logo, logoOptions] = logoCall;
    if (!logoOptions) throw new Error("Annual-statement logo dimensions were not supplied");
    expect({ width: logo.width, height: logo.height }).toEqual({ width: 2393, height: 672 });
    expect(logoOptions.width).toBeGreaterThanOrEqual(180);
    expect(logoOptions.height).toBeGreaterThanOrEqual(50);
    expect(logoOptions.width! / logoOptions.height!).toBeCloseTo(2393 / 672, 8);
    const title = drawText.mock.calls.find(([text]) => text === "Annual Giving Statement");
    expect(logoOptions.x! + logoOptions.width!).toBeLessThanOrEqual(title?.[1]?.x ?? 0);
    expectTypeOf<"logo" extends keyof RenderStripeAnnualStatementPdfInput ? true : false>()
      .toEqualTypeOf<false>();
  });

  it("hashes normalized identity and ordered durable refund facts, including a zero-net refund", async () => {
    const gifts = [
      gift({ id: "gift_b", settled_at: "2025-07-01T12:00:00.000Z", gift_type: "OFFERING", frequency: "MONTHLY", amount_cents: 5_000, refunded_amount_cents: 5_000, status: "REFUNDED" }),
      gift({ id: "gift_a", settled_at: "2025-01-02T12:00:00.000Z", amount_cents: 10_000 })
    ];
    const snapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "ana@example.org",
      donorName: " Ana ",
      donorEmail: " ANA@Example.ORG ",
      document: statementDocument(),
      gifts
    });

    expect(snapshot.donor).toEqual({
      key: "ana@example.org",
      name: "Ana",
      email: "ana@example.org",
      phone: "+1 281 974 9002",
      address: {
        line1: "332 Tangle Birch Court",
        line2: null,
        city: "Montgomery",
        state: "TX",
        postalCode: "77316",
        country: "US"
      }
    });
    expect(snapshot.items.map((item) => ({ id: item.sourceId, net: item.netAmountCents }))).toEqual([
      { id: "pi_gift_a", net: 10_000 },
      { id: "pi_gift_b", net: 0 }
    ]);
    expect(snapshot.totals).toEqual({ count: 2, grossAmountCents: 15_000, refundedAmountCents: 5_000, netAmountCents: 10_000 });
    expect(snapshot.hash).toMatch(/^[a-f0-9]{64}$/);

    const changed = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "ana@example.org",
      donorName: "Ana",
      donorEmail: "ana@example.org",
      document: statementDocument(),
      gifts: gifts.map((row) => row.id === "gift_a" ? { ...row, refunded_amount_cents: 100, status: "PARTIALLY_REFUNDED", net_amount_cents: 9_900 } : row)
    });
    expect(changed.hash).not.toBe(snapshot.hash);

    const changedEmailEvidence = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "ana@example.org",
      donorName: "Ana",
      donorEmail: "ana@example.org",
      document: {
        ...statementDocument(),
        email: {
          ...statementDocument().email,
          organizationName: "Updated Email Organization",
          supportEmail: "updated-support@example.org",
          logoUrl: "https://example.org/api/branding/logo?v=updated",
          senderName: "Updated Sender",
          replyToAddress: "updated-replies@example.org"
        }
      },
      gifts
    });
    expect(changedEmailEvidence.hash).not.toBe(snapshot.hash);
    expect(JSON.parse(changedEmailEvidence.canonicalJson).document.email).toEqual({
      organizationName: "Updated Email Organization",
      supportEmail: "updated-support@example.org",
      logoUrl: "https://example.org/api/branding/logo?v=updated",
      senderName: "Updated Sender",
      replyToAddress: "updated-replies@example.org"
    });

    const changedConfiguration = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "ana@example.org",
      donorName: "Ana",
      donorEmail: "ana@example.org",
      document: statementDocument({ legalName: "Friends of Example Church — Updated" }),
      gifts
    });
    expect(changedConfiguration.hash).not.toBe(snapshot.hash);
    expect(JSON.parse(changedConfiguration.canonicalJson)).toMatchObject({
      document: {
        rendererVersion: expect.any(String),
        legalName: "Friends of Example Church — Updated",
        ein: "12-3456789",
        timeZone: "America/New_York"
      }
    });
  });

  it("renders the U.S. legal identity, refund-aware itemization, substantiation, and neutral disclaimer", async () => {
    const snapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "ana@example.org",
      donorName: "Ana",
      donorEmail: "ana@example.org",
      document: statementDocument(),
      gifts: [
        gift({ id: "gift_tithe", settled_at: "2025-01-02T12:00:00.000Z", gift_type: "TITHE", amount_cents: 10_000 }),
        gift({ id: "gift_refund", settled_at: "2025-07-01T12:00:00.000Z", gift_type: "OFFERING", amount_cents: 5_000, refunded_amount_cents: 5_000, status: "REFUNDED" })
      ]
    });
    const bytes = await renderStripeAnnualStatementPdf({
      snapshot,
      issuedOn: "2026-01-10T12:00:00.000Z",
      corrected: true
    });
    const directory = mkdtempSync(join(tmpdir(), "stripe-annual-"));
    temporaryDirectories.push(directory);
    const pdfPath = join(directory, "statement.pdf");
    writeFileSync(pdfPath, bytes);
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });
    const normalizedText = text.replace(/\s+/g, " ");

    expect(text).toContain("Annual Giving Statement");
    expect(text).toContain("CORRECTED STATEMENT");
    expect(text).toContain("ExamplePerson1");
    expect(text).not.toContain("Friends of Example Church, Inc.");
    expect(text).toContain("EIN 12-3456789");
    expect(text).toContain("pi_gift_tithe");
    expect(text).toContain("pi_gift_refund");
    expect(text).toContain("$100.00");
    expect(text).toContain("$0.00");
    expect(normalizedText).toContain("No goods or services were provided to you in exchange for these contributions.");
    expect(normalizedText).toContain("Amounts shown are net of refunds and other adjustments");
    expect(normalizedText).toContain("does not constitute tax advice");
    expect(text).not.toMatch(/Ministerio de Hacienda|\bMH\b|\bCDE\b|deducible garantizada/i);
    expect(readFileSync(pdfPath).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("matches the supplied two-page annual giving statement composition", async () => {
    const drawText = vi.spyOn(PDFPage.prototype, "drawText");
    const drawSvgPath = vi.spyOn(PDFPage.prototype, "drawSvgPath");
    const amounts = [34700, 17000, 21600, 17000, 18300, 18500, 28650, 85100, 17000, 22100, 21100, 38400, 21800, 14800, 33200, 16000, 22000];
    const dates = ["01-03", "01-16", "02-02", "02-20", "03-01", "03-16", "04-05", "06-22", "07-03", "07-18", "08-01", "08-31", "09-16", "10-03", "11-06", "11-18", "12-04"];
    const snapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "annual@example.org",
      donorName: "Herlinda Trejo",
      donorEmail: "annual@example.org",
      document: statementDocument({
        legalName: "Friends of Misión Cristiana Elim",
        ein: "82-0889012",
        organizationContact: {
          phone: "+1 (786) 505-8446",
          website: "https://www.elim.click",
          mailingAddress: [
            "2885 Sanford Ave SW, PMB 41357",
            "Grandville, MI 49418, USA"
          ]
        },
        email: {
          organizationName: "Misión Cristiana Elim",
          supportEmail: "fmce@example.org",
          logoUrl: null,
          senderName: "Misión Cristiana Elim",
          replyToAddress: "fmce@example.org"
        }
      }),
      gifts: amounts.map((amount_cents, index) => gift({
        id: `gift_${index + 1}`,
        source_id: String(32180 + index),
        stripe_payment_intent_id: String(32180 + index),
        settled_at: `2025-${dates[index]}T12:00:00.000Z`,
        amount_cents,
        donor_phone: "+1 281 974 9002",
        donor_address_json: JSON.stringify({
          line1: "332 Tangle Birch Court",
          line2: null,
          city: "Montgomery",
          state: "TX",
          postalCode: "77316",
          country: "US"
        })
      }))
    });
    const bytes = await renderStripeAnnualStatementPdf({
      snapshot,
      issuedOn: "2026-06-05T12:00:00.000Z",
      corrected: false
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getPages().map((page) => page.getMediaBox())).toEqual([
      { x: 0, y: 0, width: 612, height: 792 },
      { x: 0, y: 0, width: 612, height: 792 }
    ]);

    const directory = mkdtempSync(join(tmpdir(), "stripe-annual-layout-"));
    temporaryDirectories.push(directory);
    const pdfPath = join(directory, "statement.pdf");
    writeFileSync(pdfPath, bytes);
    const pageOne = execFileSync("pdftotext", ["-f", "1", "-l", "1", "-layout", pdfPath, "-"], { encoding: "utf8" });
    const pageTwo = execFileSync("pdftotext", ["-f", "2", "-l", "2", "-layout", pdfPath, "-"], { encoding: "utf8" });
    const normalizedPageOne = pageOne.replace(/\s+/g, " ");
    for (const label of [
      "Annual Giving Statement",
      "FROM",
      "PREPARED FOR",
      "CONTRIBUTION PERIOD",
      "TOTAL TAX-DEDUCTIBLE CONTRIBUTIONS",
      "Tax-Deductible Contribution Acknowledgment",
      "CONTRIBUTIONS",
      "DATE",
      "AMOUNT",
      "DONATION ID",
      "PAYMENT METHOD",
      "Page 1 of 2"
    ]) {
      expect(pageOne).toContain(label);
    }
    expect(pageOne).toContain("January 1, 2025 – December 31, 2025");
    expect(pageOne).toContain("Misión Cristiana Elim");
    expect(pageOne).not.toContain("Friends of Misión Cristiana Elim");
    expect(normalizedPageOne).toContain("No goods or services were provided to you in exchange for these contributions.");
    expect(pageOne).toContain("Malaquías 3:10");
    expect(pageOne).toContain("fmce@example.org · +1 (786) 505-8446");
    expect(pageOne).toContain("https://www.elim.click");
    expect(pageOne).toContain("2885 Sanford Ave SW, PMB 41357");
    expect(pageOne).toContain("332 Tangle Birch Court");
    expect(pageOne).toContain("Montgomery, TX 77316, United States");
    expect(pageOne).toContain("+1 281 974 9002");
    expect(pageOne).toContain("32180");
    expect(pageOne).not.toContain("32185");
    expect(pageTwo).toContain("32185");
    expect(pageTwo).toContain("TOTAL — 17");
    expect(pageTwo).toContain("CONTRIBUTIONS");
    expect(pageTwo).toContain("Page 2 of 2");
    expect(pageTwo).not.toMatch(/Ministerio de Hacienda|\bMH\b|\bCDE\b/i);

    expect(drawSvgPath).toHaveBeenCalledTimes(2);
    expect(drawText.mock.calls).toContainEqual([
      "DATE",
      expect.objectContaining({ x: 52.854, size: 8 })
    ]);
    expect(drawText.mock.calls).toContainEqual([
      "DONATION ID",
      expect.objectContaining({ x: 250.945, size: 8 })
    ]);
    expect(drawText.mock.calls).toContainEqual([
      "PAYMENT METHOD",
      expect.objectContaining({ x: 407.332, size: 8 })
    ]);
    expect(drawText.mock.calls).toContainEqual([
      "TOTAL — 17",
      expect.objectContaining({ x: 52.854, size: 9.9 })
    ]);
    expect(drawText.mock.calls).toContainEqual([
      "CONTRIBUTIONS",
      expect.objectContaining({ x: 52.854, size: 9.9 })
    ]);
    expect(drawText.mock.calls).toContainEqual([
      "$4,472.50",
      expect.objectContaining({ x: 326.176, size: 20 })
    ]);
    expect(drawText.mock.calls).toContainEqual([
      "USD",
      expect.objectContaining({ size: 9 })
    ]);
    expect(drawText.mock.calls).toContainEqual([
      "Page 2 of 2",
      expect.objectContaining({ y: 24.5, size: 7.5 })
    ]);
  });

  it.each([
    { count: 4, pages: 1 },
    { count: 5, pages: 1 },
    { count: 6, pages: 2 },
    { count: 17, pages: 2 }
  ])("keeps $count complete contribution rows and totals above footer clearance", async ({ count, pages }) => {
    const drawRectangle = vi.spyOn(PDFPage.prototype, "drawRectangle");
    const gifts = Array.from({ length: count }, (_, index) => gift({
      id: `gift_clearance_${index + 1}`,
      source_id: `pi_clearance_${String(index + 1).padStart(2, "0")}`,
      settled_at: `2025-${String((index % 12) + 1).padStart(2, "0")}-01T12:00:00.000Z`
    }));
    const snapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "clearance@example.org",
      donorName: "Footer Clearance",
      donorEmail: "clearance@example.org",
      document: statementDocument(),
      gifts
    });
    const bytes = await renderStripeAnnualStatementPdf({
      snapshot,
      issuedOn: "2026-01-10T12:00:00.000Z",
      corrected: false
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(pages);
    const totals = drawRectangle.mock.calls
      .map(([options]) => options)
      .filter((options) => options?.height === 36.223);
    expect(totals).toHaveLength(1);
    expect(totals[0]?.y).toBeGreaterThanOrEqual(45.5);

    const directory = mkdtempSync(join(tmpdir(), "stripe-annual-clearance-"));
    temporaryDirectories.push(directory);
    const pdfPath = join(directory, "statement.pdf");
    writeFileSync(pdfPath, bytes);
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });
    for (const row of gifts) expect(text).toContain(row.source_id);
  });

  it("preserves maximum renderer-safe contact fields and all four address lines", async () => {
    const organizationName = `LEGAL ${"L".repeat(74)}`;
    const supportEmail = `${"e".repeat(87)}@example.org`;
    const phone = `+1${"2".repeat(38)}`;
    const website = `https://example.org/${"w".repeat(80)}`;
    const address = [1, 2, 3, 4].map((line) => `ADDRESS-${line} ${"A".repeat(70)}`);
    const drawText = vi.spyOn(PDFPage.prototype, "drawText");
    const snapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "max-contact@example.org",
      donorName: "Maximum Contact Donor",
      donorEmail: "max-contact@example.org",
      document: statementDocument({
        legalName: "Friends of Maximum Contact Ministry",
        organizationContact: { phone, website, mailingAddress: address },
        email: {
          organizationName,
          supportEmail,
          logoUrl: null,
          senderName: "Maximum Contact Ministry",
          replyToAddress: supportEmail
        }
      }),
      gifts: [gift({ id: "gift_max_contact", source_id: "pi_max_contact" })]
    });
    const bytes = await renderStripeAnnualStatementPdf({ snapshot, issuedOn: "2026-01-10T12:00:00.000Z", corrected: false });
    const directory = mkdtempSync(join(tmpdir(), "stripe-annual-max-contact-"));
    temporaryDirectories.push(directory);
    const pdfPath = join(directory, "statement.pdf");
    writeFileSync(pdfPath, bytes);
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" }).replace(/\s+/gu, " ");
    for (const marker of ["LEGAL", "example.org", "+122222", "ADDRESS-1", "ADDRESS-2", "ADDRESS-3", "ADDRESS-4"]) {
      expect(text).toContain(marker);
    }
    for (const [drawn, options] of drawText.mock.calls) {
      if (
        !options?.font
        || typeof options.x !== "number"
        || typeof options.y !== "number"
        || options.y < 45.5
        || !String(drawn).match(/LEGAL|example\.org|ADDRESS-|^\+1/)
      ) continue;
      expect(options.x).toBeGreaterThanOrEqual(45.354);
      expect(options.x + options.font.widthOfTextAtSize(String(drawn), options.size ?? 12)).toBeLessThanOrEqual(566.646);
      expect(options.y).toBeGreaterThanOrEqual(45.5);
    }
    const fromCalls = drawText.mock.calls.filter(([, options]) =>
      options?.x === 45.354 && typeof options.y === "number" && options.y > 450
    );
    expect(fromCalls.length).toBeGreaterThanOrEqual(10);
    for (const [drawn, options] of fromCalls) {
      expect(options?.y, String(drawn)).toBeGreaterThanOrEqual(520);
    }
  });

  it("keeps both maximum-length statement-organization repetitions inside the annual acknowledgment panel", async () => {
    const organizationName = `LEGAL-PANEL ${"L".repeat(68)}`;
    expect(organizationName).toHaveLength(80);
    const drawText = vi.spyOn(PDFPage.prototype, "drawText");
    const snapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "legal-panel@example.org",
      donorName: "Legal Panel Donor",
      donorEmail: "legal-panel@example.org",
      document: statementDocument({
        email: {
          organizationName,
          supportEmail: "legacy-contact-1@example.com",
          logoUrl: null,
          senderName: organizationName,
          replyToAddress: null
        }
      }),
      gifts: [gift({ id: "gift_legal_panel", source_id: "pi_legal_panel" })]
    });
    await renderStripeAnnualStatementPdf({
      snapshot,
      issuedOn: "2026-01-10T12:00:00.000Z",
      corrected: false
    });

    const calls = drawText.mock.calls;
    const text = (index: number): string => String(calls[index]?.[0]);
    const options = (index: number): PositionedAnnualDrawTextOptions => {
      const value = calls[index]?.[1];
      if (!value?.font || typeof value.x !== "number" || typeof value.y !== "number") {
        throw new Error(`Annual acknowledgment geometry missing for ${text(index)}`);
      }
      return value as PositionedAnnualDrawTextOptions;
    };
    const requiredIndex = (predicate: (value: string, index: number) => boolean, label: string): number => {
      const index = calls.findIndex(([value], callIndex) => predicate(String(value), callIndex));
      if (index < 0) throw new Error(`Annual acknowledgment draw call missing: ${label}`);
      return index;
    };
    const headerIndex = requiredIndex((value) => value === "Tax-Deductible Contribution Acknowledgment", "panel heading");
    const firstStart = requiredIndex((value, index) => index > headerIndex && value.startsWith("LEGAL-PANEL"), "first legal paragraph");
    const secondStart = requiredIndex((value, index) => index > firstStart && value.startsWith("This letter is"), "second legal paragraph");
    const thirdStart = requiredIndex((value, index) => index > secondStart && value.startsWith("Please retain"), "third legal paragraph");
    const panelEnd = requiredIndex((value, index) => index > thirdStart && value.startsWith("Le expresamos"), "first text after panel");
    const groups = [
      calls.slice(firstStart, secondStart),
      calls.slice(secondStart, thirdStart),
      calls.slice(thirdStart, panelEnd)
    ];
    expect(groups[0]!.map(([value]) => String(value)).join(" ").match(/LEGAL-PANEL/gu))
      .toHaveLength(2);

    const top = (callIndex: number): number => {
      const value = options(callIndex);
      return value.y + value.font.heightAtSize(value.size ?? 12);
    };
    const minBaseline = (start: number, end: number): number =>
      Math.min(...calls.slice(start, end).map((_, offset) => options(start + offset).y));
    const maxTop = (start: number, end: number): number =>
      Math.max(...calls.slice(start, end).map((_, offset) => top(start + offset)));

    expect(maxTop(firstStart, secondStart)).toBeLessThanOrEqual(491);
    expect(minBaseline(firstStart, secondStart)).toBeGreaterThanOrEqual(maxTop(secondStart, thirdStart) + 1.5);
    expect(minBaseline(secondStart, thirdStart)).toBeGreaterThanOrEqual(maxTop(thirdStart, panelEnd) + 1.5);
    expect(minBaseline(thirdStart, panelEnd)).toBeGreaterThanOrEqual(370.184);
    for (let index = firstStart; index < panelEnd; index += 1) {
      const value = options(index);
      expect(value.x, text(index)).toBeGreaterThanOrEqual(58.104);
      expect(value.x + value.font.widthOfTextAtSize(text(index), value.size ?? 12), text(index))
        .toBeLessThanOrEqual(553.896);
    }
  });

  it("renders unsupported Unicode deterministically without changing source identity", async () => {
    const snapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "unicode@example.org",
      donorName: "李 😊 García",
      donorEmail: "unicode@example.org",
      document: statementDocument({ legalName: "Iglesia 李 😊" }),
      gifts: [gift({ id: "gift_unicode", donor_name: "李 😊 García", donor_email: "unicode@example.org" })]
    });

    expect(snapshot.donor.name).toBe("李 😊 García");
    await expect(renderStripeAnnualStatementPdf({
      snapshot,
      issuedOn: "2026-01-10T12:00:00.000Z",
      corrected: false
    })).resolves.toBeInstanceOf(Uint8Array);
  });

  it("keeps maximum-length legal and donor identity text inside printable bounds", async () => {
    const organizationName = `LEGALMAX ${"L".repeat(191)}`;
    const donorName = `DONORMAX ${"D".repeat(191)}`;
    const donorEmail = `EMAILMAX${"e".repeat(234)}@example.org`;
    const snapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: donorEmail,
      donorName,
      donorEmail,
      document: statementDocument({
        email: {
          organizationName,
          supportEmail: "legacy-contact-1@example.com",
          logoUrl: null,
          senderName: organizationName,
          replyToAddress: null
        }
      }),
      gifts: [gift({ id: "gift_max_identity", donor_name: donorName, donor_email: donorEmail })]
    });
    const drawText = vi.spyOn(PDFPage.prototype, "drawText");
    try {
      await renderStripeAnnualStatementPdf({
        snapshot,
        issuedOn: "2026-01-10T12:00:00.000Z",
        corrected: true
      });
      const identityCalls = drawText.mock.calls.filter(([text]) =>
        /LEGALMAX|DONORMAX|EMAILMAX/.test(String(text))
      );
      expect(identityCalls.length).toBeGreaterThanOrEqual(3);
      for (const [text, options] of identityCalls) {
        if (!options?.font || typeof options.x !== "number") {
          throw new Error("Identity draw call was missing its font or x coordinate");
        }
        const size = options.size ?? 12;
        const font = options.font;
        expect(options.x).toBeGreaterThanOrEqual(42);
        expect(options.x + font.widthOfTextAtSize(String(text), size)).toBeLessThanOrEqual(570);
      }
    } finally {
      drawText.mockRestore();
    }
  });

  it("builds distinct U.S. Spanish email copy for original and corrected statements", () => {
    const original = stripeAnnualStatementEmailContent({
      donorName: "Ana",
      year: 2025,
      count: 2,
      netTotalCents: 10_000,
      corrected: false,
      branding: { organizationName: "Example Church" }
    });
    const corrected = stripeAnnualStatementEmailContent({
      donorName: "Ana",
      year: 2025,
      count: 2,
      netTotalCents: 9_900,
      corrected: true,
      branding: { organizationName: "Example Church" }
    });
    expect(original.subject).toBe("Constancia anual de donaciones 2025 — EE. UU.");
    expect(corrected.subject).toBe("Constancia anual corregida de donaciones 2025 — EE. UU.");
    expect(corrected.text).toContain("reemplaza la constancia anterior");
    for (const content of [original, corrected]) {
      expect(content.text).toContain("No se proporcionaron bienes ni servicios");
      expect(content.text).not.toMatch(/Ministerio de Hacienda|\bMH\b|\bCDE\b|validez fiscal/i);
    }
  });
});

describe("Stripe U.S. annual statement preview and delivery", () => {
  let database: ReturnType<typeof migratedDatabase>;
  let repo: Repository;
  let workerEnv: Env;
  let emailSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    database = migratedDatabase();
    const db = sqliteD1(database);
    repo = new Repository(db);
    emailSend = vi.fn().mockResolvedValue({ messageId: "annual-provider-id" });
    workerEnv = env(new InMemoryD1(), {
      DB: db,
      APP_ENV: "local",
      STRIPE_MOCK_MODE: "1",
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "sender@example.org",
      EMAIL: { send: emailSend } as unknown as SendEmail
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    database.close();
  });

  it("returns a 50-row preview with an opaque no-email row and stable continuation", async () => {
    for (let index = 0; index < 50; index += 1) seedGift(database, gift({ id: `gift_${String(index).padStart(2, "0")}`, donor_email: `donor${String(index).padStart(2, "0")}@example.org` }));
    seedGift(database, gift({ id: "gift_no_email", donor_email: null, donor_name: "Sin Correo" }));

    const preview = await buildStripeAnnualStatementPreview(workerEnv, repo, 2025, false);
    expect(preview.donors).toHaveLength(50);
    expect(preview.hasMore).toBe(true);
    expect(preview.nextCursor).toBe("donor49@example.org");

    const next = await buildStripeAnnualStatementPreview(workerEnv, repo, 2025, false, preview.nextCursor);
    expect(next.donors).toEqual([expect.objectContaining({ donorKey: "gift:gift_no_email", hasEmail: false })]);
  });

  it("wires durable fields into the attached Stripe annual statement PDF", async () => {
    seedGift(database, gift({
      id: "annual_wiring_one",
      source_id: "pi_annual_source_sentinel_1",
      stripe_payment_intent_id: "pi_annual_source_sentinel_1",
      donor_name: "Annual Donor Sentinel",
      donor_email: "annual-sentinel@example.org",
      donor_phone: "+1 555 010 9191",
      donor_address_json: JSON.stringify({
        line1: "91 Annual Statement Lane",
        line2: "Suite 2",
        city: "Austin",
        state: "TX",
        postalCode: "78791",
        country: "US"
      }),
      settled_at: "2025-03-04T12:00:00.000Z",
      amount_cents: 12_345
    }));
    seedGift(database, gift({
      id: "annual_wiring_two",
      source_id: "pi_annual_source_sentinel_2",
      stripe_payment_intent_id: "pi_annual_source_sentinel_2",
      donor_name: "Annual Donor Sentinel",
      donor_email: "annual-sentinel@example.org",
      donor_phone: "+1 555 010 9191",
      donor_address_json: JSON.stringify({
        line1: "91 Annual Statement Lane",
        line2: "Suite 2",
        city: "Austin",
        state: "TX",
        postalCode: "78791",
        country: "US"
      }),
      settled_at: "2025-11-14T12:00:00.000Z",
      amount_cents: 23_456,
      refunded_amount_cents: 1_234,
      status: "PARTIALLY_REFUNDED"
    }));
    database.prepare(
      "INSERT INTO app_settings (key, value) VALUES (?, ?), (?, ?)"
    ).run(
      "branding_display_name",
      "Annual Organization Sentinel",
      "branding_support_email",
      "annual-support-sentinel@example.org"
    );
    const configuredEnv: Env = {
      ...workerEnv,
      STRIPE_MOCK_MODE: undefined,
      STRIPE_RESTRICTED_KEY: "rk_test_annual_field_wiring",
      STRIPE_PUBLISHABLE_KEY: "pk_test_annual_field_wiring",
      STRIPE_WEBHOOK_SECRET: "whsec_annual_field_wiring",
      STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: "pmc_annual_field_wiring",
      STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_annual_field_wiring",
      STRIPE_US_LEGAL_NAME: "Annual Legal Name Sentinel",
      STRIPE_US_EIN: "98-7654321",
      STRIPE_US_TIME_ZONE: "America/New_York",
      STRIPE_US_PHONE: "+1 555 010 9292",
      STRIPE_US_WEBSITE: "https://annual-sentinel.example.org",
      STRIPE_US_MAILING_ADDRESS: "92 Annual Organization Road\nAustin, TX 78792, USA",
      STRIPE_US_SIGNER_NAME: "Annual Signer Sentinel",
      STRIPE_US_SIGNER_TITLE: "Annual Treasurer"
    };

    await expect(sendStripeAnnualStatements(configuredEnv, repo, 2025, false, "user_operator", {
      donor: "annual-sentinel@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).resolves.toMatchObject({ sent: 1, failed: 0, review: 0 });

    const message = emailSend.mock.calls[0]?.[0] as {
      to?: string;
      attachments?: Array<{ content: Uint8Array }>;
    };
    expect(message.to).toBe("annual-sentinel@example.org");
    const pdfBytes = message.attachments?.[0]?.content;
    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    const pdf = await PDFDocument.load(pdfBytes!);
    expect(pdf.getPageCount()).toBe(1);
    const directory = mkdtempSync(join(tmpdir(), "stripe-annual-wiring-"));
    temporaryDirectories.push(directory);
    const pdfPath = join(directory, "annual-statement.pdf");
    writeFileSync(pdfPath, pdfBytes!);
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });
    const normalizedText = text.replace(/\s+/g, " ");

    for (const expected of [
      "Annual Donor Sentinel",
      "+1 555 010 9191",
      "91 Annual Statement Lane",
      "Suite 2",
      "Austin, TX 78791, United States",
      "pi_annual_source_sentinel_1",
      "pi_annual_source_sentinel_2",
      "03/04/2025",
      "11/14/2025",
      "$123.45",
      "$222.22",
      "TOTAL — 2",
      "$345.67 USD",
      "EIN 98-7654321",
      "Annual Organization Sentinel",
      "annual-support-sentinel@example.org",
      "+1 555 010 9292",
      "https://annual-sentinel.example.org",
      "92 Annual Organization Road",
      "Austin, TX 78792, USA",
      "Tax Year 2025"
    ]) {
      expect(normalizedText).toContain(expected);
    }
    expect(normalizedText).not.toContain("Annual Legal Name Sentinel");
    expect(normalizedText).toMatch(/Statement No\. AGS-2025-[A-F0-9]{8}/);
  });

  it("keeps mutable email branding separate from immutable annual artwork evidence", async () => {
    seedGift(database, gift({ id: "gift_branding_boundary", donor_email: "branding-boundary@example.org" }));
    const emailLogo = JSON.stringify({
      contentType: "image/jpeg",
      size: 321,
      version: "runtime-email-logo-v99"
    });
    const donorLogo = JSON.stringify({
      contentType: "image/png",
      size: 654,
      version: "runtime-donor-logo-v42"
    });
    database.prepare(
      "INSERT INTO app_settings (key, value) VALUES (?, ?), (?, ?), (?, ?)"
    ).run(
      "branding_display_name",
      "Runtime Branded Ministry",
      "branding_logo",
      emailLogo,
      "branding_donor_logo",
      donorLogo
    );

    await expect(sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "branding-boundary@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).resolves.toMatchObject({ sent: 1, failed: 0, review: 0 });

    const row = database.prepare(
      "SELECT snapshot_json FROM stripe_annual_statement_deliveries"
    ).get() as { snapshot_json: string };
    const snapshot = JSON.parse(row.snapshot_json) as {
      document: {
        logo: unknown;
        email: { organizationName: string; logoUrl: string | null };
        settings: { brandingLogo: string | null; brandingDonorLogo: string | null };
      };
    };
    expect(snapshot.document.logo).toEqual({
      format: "png",
      hash: "ac235e246a9d15381b32501f49eec7e8f8fb60a52214e0fde9a6595e5c67e19c"
    });
    expect(snapshot.document.email).toMatchObject({
      organizationName: "Runtime Branded Ministry",
      logoUrl: expect.stringContaining("/api/branding/logo?v=runtime-email-logo-v99")
    });
    expect(snapshot.document.settings).toMatchObject({
      brandingLogo: emailLogo,
      brandingDonorLogo: donorLogo
    });
  });

  it("threads a trimmed preview query to the grouped Stripe donor search", async () => {
    seedGift(database, gift({ id: "gift_match", donor_email: "match@example.org", donor_name: "Ana Matching" }));
    seedGift(database, gift({ id: "gift_nonmatch", donor_email: "other@example.org", donor_name: "No coincide" }));

    const preview = await buildStripeAnnualStatementPreview(workerEnv, repo, 2025, false, null, "  MATCHING  ");

    expect(preview.donors).toEqual([expect.objectContaining({ donorKey: "match@example.org", donorName: "Ana Matching" })]);
  });

  it("deduplicates an identical send and emits a corrected revision after a durable refund", async () => {
    seedGift(database, gift({ id: "gift_send", amount_cents: 10_000 }));

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", { donor: "ana@example.org", now: "2026-01-10T12:00:00.000Z" }))
      .toMatchObject({ sent: 1, skipped: 0, failed: 0, review: 0 });
    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", { donor: "ana@example.org", now: "2026-01-10T12:01:00.000Z" }))
      .toMatchObject({ sent: 0, skipped: 1 });

    database.prepare("UPDATE stripe_gifts SET refunded_amount_cents = 2500, status = 'PARTIALLY_REFUNDED' WHERE id = 'gift_send'").run();
    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", { donor: "ana@example.org", now: "2026-01-10T12:02:00.000Z" }))
      .toMatchObject({ sent: 1, skipped: 0 });

    expect(database.prepare(
      "SELECT revision, supersedes_delivery_id, status FROM stripe_annual_statement_deliveries ORDER BY revision"
    ).all()).toEqual([
      { revision: 1, supersedes_delivery_id: null, status: "SENT" },
      { revision: 2, supersedes_delivery_id: expect.any(String), status: "SENT" }
    ]);
    expect(emailSend).toHaveBeenCalledTimes(2);
    expect((emailSend.mock.calls[1][0] as { subject: string }).subject).toContain("corregida");
  });

  it("does not redispatch a SENT snapshot after a different snapshot failed before provider entry", async () => {
    seedGift(database, gift({ id: "gift_returned_snapshot", amount_cents: 10_000 }));

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 1, skipped: 0, failed: 0, review: 0 });

    database.prepare(
      "UPDATE stripe_gifts SET refunded_amount_cents = 2500, status = 'PARTIALLY_REFUNDED' WHERE id = 'gift_returned_snapshot'"
    ).run();
    vi.spyOn(repo, "markStripeAnnualStatementDispatchStarted")
      .mockRejectedValueOnce(new Error("simulated safe failure before provider entry"));
    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:01:00.000Z"
    })).toMatchObject({ sent: 0, skipped: 0, failed: 1, review: 0 });
    expect(database.prepare(
      `SELECT revision, status, dispatch_started_at, provider_id_hash
         FROM stripe_annual_statement_deliveries ORDER BY revision`
    ).all()).toEqual([
      {
        revision: 1,
        status: "SENT",
        dispatch_started_at: "2026-01-10T12:00:00.000Z",
        provider_id_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      },
      {
        revision: 2,
        status: "FAILED",
        dispatch_started_at: null,
        provider_id_hash: null
      }
    ]);

    const originalDelivery = database.prepare(
      `SELECT id, donor_key, donor_name, donor_email, snapshot_hash, snapshot_json
         FROM stripe_annual_statement_deliveries WHERE revision = 1`
    ).get() as {
      id: string;
      donor_key: string;
      donor_name: string;
      donor_email: string;
      snapshot_hash: string;
      snapshot_json: string;
    };
    database.prepare(
      `INSERT INTO stripe_annual_statement_deliveries (
         id, year, livemode, donor_key, donor_name, donor_email,
         snapshot_hash, snapshot_json, revision, supersedes_delivery_id,
         status, attempt_count, failure_code, retry_safe, created_at, updated_at
       ) VALUES (
         'delivery_legacy_returned_snapshot', 2025, 0, ?, ?, ?, ?, ?, 3, ?,
         'FAILED', 1, 'snapshot_changed_before_dispatch', 1, ?, ?
       )`
    ).run(
      originalDelivery.donor_key,
      originalDelivery.donor_name,
      originalDelivery.donor_email,
      originalDelivery.snapshot_hash,
      originalDelivery.snapshot_json,
      originalDelivery.id,
      "2026-01-10T12:01:30.000Z",
      "2026-01-10T12:01:30.000Z"
    );

    database.prepare(
      "UPDATE stripe_gifts SET refunded_amount_cents = 0, status = 'PAID' WHERE id = 'gift_returned_snapshot'"
    ).run();
    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:02:00.000Z"
    })).toMatchObject({ sent: 0, skipped: 1, failed: 0, review: 0 });
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(database.prepare(
      "SELECT revision, status, failure_code, retry_safe FROM stripe_annual_statement_deliveries ORDER BY revision"
    ).all()).toEqual([
      { revision: 1, status: "SENT", failure_code: null, retry_safe: 0 },
      { revision: 2, status: "FAILED", failure_code: "EMAIL_PRE_DISPATCH_FAILED", retry_safe: 1 },
      {
        revision: 3,
        status: "FAILED",
        failure_code: "duplicate_sent_snapshot_suppressed",
        retry_safe: 0
      }
    ]);
  });

  it("takes a fresh per-donor lease timestamp when a slow bulk send crosses the stale threshold", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T12:00:00.000Z"));
    seedGift(database, gift({ id: "gift_slow_first", donor_email: "ana@example.org" }));
    seedGift(database, gift({ id: "gift_slow_second", donor_email: "bea@example.org", donor_name: "Bea" }));
    emailSend
      .mockImplementationOnce(async () => {
        vi.setSystemTime(new Date("2026-01-10T12:06:00.000Z"));
        return { messageId: "annual-provider-first" };
      })
      .mockResolvedValueOnce({ messageId: "annual-provider-second" });

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator"))
      .toMatchObject({ sent: 2, failed: 0, review: 0 });
    expect(database.prepare(
      "SELECT donor_key, created_at, lease_expires_at FROM stripe_annual_statement_deliveries ORDER BY donor_key"
    ).all()).toEqual([
      {
        donor_key: "ana@example.org",
        created_at: "2026-01-10T12:00:00.000Z",
        lease_expires_at: null
      },
      {
        donor_key: "bea@example.org",
        created_at: "2026-01-10T12:06:00.000Z",
        lease_expires_at: null
      }
    ]);
  });

  it("prints the fresh delivery claim date instead of a stale reservation date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-10T12:00:00.000Z"));
    seedGift(database, gift({ id: "gift_fresh_issue_date" }));
    const reserve = repo.reserveStripeAnnualStatementDelivery.bind(repo);
    vi.spyOn(repo, "reserveStripeAnnualStatementDelivery").mockImplementation(async (input) => {
      const delivery = await reserve(input);
      vi.setSystemTime(new Date("2026-01-11T12:00:00.000Z"));
      return delivery;
    });

    await expect(sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator"))
      .resolves.toMatchObject({ sent: 1, failed: 0, review: 0 });
    const message = emailSend.mock.calls[0][0] as {
      attachments: Array<{ content: Uint8Array }>;
    };
    const directory = mkdtempSync(join(tmpdir(), "stripe-annual-issue-date-"));
    temporaryDirectories.push(directory);
    const pdfPath = join(directory, "statement.pdf");
    writeFileSync(pdfPath, message.attachments[0].content);
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });

    expect(text).toContain("Generated January 11, 2026");
    expect(text).not.toContain("Generated January 10, 2026");
  });

  it("records dispatch-start evidence before deterministic mock acceptance", async () => {
    seedGift(database, gift({ id: "gift_mock_dispatch" }));
    workerEnv = { ...workerEnv, MOCK_EXTERNAL_SERVICES: "true", EMAIL: undefined };

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 1, failed: 0, review: 0 });
    expect(database.prepare(
      "SELECT status, dispatch_started_at, provider_id_hash FROM stripe_annual_statement_deliveries"
    ).get()).toEqual({
      status: "SENT",
      dispatch_started_at: "2026-01-10T12:00:00.000Z",
      provider_id_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    });
  });

  it("moves an ambiguous post-dispatch outcome to REVIEW and never retries it", async () => {
    seedGift(database, gift({ id: "gift_review" }));
    emailSend.mockRejectedValue(Object.assign(new Error("private provider response"), { code: "E_UNKNOWN" }));

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", { donor: "ana@example.org", now: "2026-01-10T12:00:00.000Z" }))
      .toMatchObject({ sent: 0, review: 1 });
    expect(database.prepare("SELECT status, retry_safe, failure_code FROM stripe_annual_statement_deliveries").get())
      .toEqual({ status: "REVIEW", retry_safe: 0, failure_code: "E_UNKNOWN" });

    emailSend.mockResolvedValue({ messageId: "must-not-send" });
    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", { donor: "ana@example.org", now: "2026-01-10T12:01:00.000Z" }))
      .toMatchObject({ sent: 0, skipped: 0, review: 1 });
    expect(emailSend).toHaveBeenCalledTimes(1);
  });

  it("fences every changed snapshot while a donor-year provider outcome is in REVIEW", async () => {
    seedGift(database, gift({ id: "gift_review_changed", amount_cents: 10_000 }));
    emailSend.mockRejectedValueOnce(Object.assign(new Error("private provider response"), { code: "E_UNKNOWN" }));

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 0, review: 1 });

    database.prepare("UPDATE stripe_gifts SET refunded_amount_cents = 2500, status = 'PARTIALLY_REFUNDED' WHERE id = 'gift_review_changed'").run();
    emailSend.mockResolvedValue({ messageId: "must-not-send-changed-review" });
    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:01:00.000Z"
    })).toMatchObject({ sent: 0, review: 1, failed: 0 });
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM stripe_annual_statement_deliveries").get())
      .toEqual({ count: 1 });
  });

  it("blocks every legacy duplicate PENDING revision from provider dispatch", async () => {
    const originalGift = gift({ id: "gift_duplicate_pending", amount_cents: 10_000 });
    seedGift(database, originalGift);
    const document = statementDocument({
      legalName: "Nonprofit Test Fixture",
      ein: "00-0000000"
    });
    const originalSnapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "ana@example.org",
      donorName: "Ana",
      donorEmail: "ana@example.org",
      document,
      gifts: [originalGift]
    });
    const changedSnapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "ana@example.org",
      donorName: "Ana",
      donorEmail: "ana@example.org",
      document,
      gifts: [{
        ...originalGift,
        status: "PARTIALLY_REFUNDED",
        refunded_amount_cents: 100,
        net_amount_cents: 9_900
      }]
    });
    insertPendingStatement(database, "delivery_pending_original", 1, originalSnapshot);
    insertPendingStatement(database, "delivery_pending_changed", 2, changedSnapshot);

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 0, skipped: 1, failed: 0, review: 0 });

    database.prepare(
      "UPDATE stripe_gifts SET refunded_amount_cents = 100, status = 'PARTIALLY_REFUNDED' WHERE id = 'gift_duplicate_pending'"
    ).run();
    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:01:00.000Z"
    })).toMatchObject({ sent: 0, skipped: 1, failed: 0, review: 0 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT id, status, attempt_count, failure_code FROM stripe_annual_statement_deliveries ORDER BY revision"
    ).all()).toEqual([
      {
        id: "delivery_pending_original",
        status: "FAILED",
        attempt_count: 0,
        failure_code: "superseded_stale_pre_dispatch"
      },
      {
        id: "delivery_pending_changed",
        status: "FAILED",
        attempt_count: 0,
        failure_code: "superseded_stale_pre_dispatch"
      }
    ]);
  });

  it("rechecks the immutable snapshot immediately before dispatch and fails safely when it changed", async () => {
    seedGift(database, gift({ id: "gift_race", amount_cents: 10_000 }));
    const originalRead = repo.listStripeAnnualStatementDonorGifts.bind(repo);
    let reads = 0;
    vi.spyOn(repo, "listStripeAnnualStatementDonorGifts").mockImplementation(async (...args) => {
      const rows = await originalRead(...args);
      reads += 1;
      return reads === 2
        ? rows.map((row) => ({
            ...row,
            status: "PARTIALLY_REFUNDED" as const,
            refunded_amount_cents: 100,
            net_amount_cents: row.amount_cents - 100
          }))
        : rows;
    });

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 0, failed: 1, review: 0 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT status, failure_code, retry_safe, dispatch_started_at FROM stripe_annual_statement_deliveries"
    ).get()).toEqual({
      status: "FAILED",
      failure_code: "snapshot_changed_before_dispatch",
      retry_safe: 1,
      dispatch_started_at: null
    });
  });

  it("includes freshly reread donor identity in the pre-dispatch snapshot recheck", async () => {
    seedGift(database, gift({ id: "gift_identity_race", donor_name: "Ana Original" }));
    const originalRead = repo.listStripeAnnualStatementDonorGifts.bind(repo);
    let reads = 0;
    vi.spyOn(repo, "listStripeAnnualStatementDonorGifts").mockImplementation(async (...args) => {
      const rows = await originalRead(...args);
      reads += 1;
      return reads === 2 ? rows.map((row) => ({ ...row, donor_name: "Ana Corregida" })) : rows;
    });

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 0, failed: 1 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT status, failure_code FROM stripe_annual_statement_deliveries"
    ).get()).toEqual({ status: "FAILED", failure_code: "snapshot_changed_before_dispatch" });
  });

  it("rechecks the snapshot after PDF rendering and immediately before provider dispatch", async () => {
    seedGift(database, gift({ id: "gift_render_race", amount_cents: 10_000 }));
    const originalSave = PDFDocument.prototype.save;
    vi.spyOn(PDFDocument.prototype, "save").mockImplementation(async function (this: PDFDocument, ...args) {
      database.prepare(
        "UPDATE stripe_gifts SET refunded_amount_cents = 100, status = 'PARTIALLY_REFUNDED' WHERE id = 'gift_render_race'"
      ).run();
      return originalSave.apply(this, args);
    });

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 0, failed: 1, review: 0 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT status, failure_code, dispatch_started_at FROM stripe_annual_statement_deliveries"
    ).get()).toEqual({
      status: "FAILED",
      failure_code: "snapshot_changed_before_dispatch",
      dispatch_started_at: null
    });
  });

  it("atomically fences a refund committed after the last snapshot read before provider entry", async () => {
    seedGift(database, gift({ id: "gift_post_read_race", amount_cents: 10_000 }));
    const originalMark = repo.markStripeAnnualStatementDispatchStarted.bind(repo);
    vi.spyOn(repo, "markStripeAnnualStatementDispatchStarted").mockImplementation(async (input) => {
      database.prepare(
        "UPDATE stripe_gifts SET refunded_amount_cents = 100, status = 'PARTIALLY_REFUNDED' WHERE id = 'gift_post_read_race'"
      ).run();
      return originalMark(input);
    });

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 0, failed: 1, review: 0 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT status, failure_code, retry_safe, dispatch_started_at FROM stripe_annual_statement_deliveries"
    ).get()).toEqual({
      status: "FAILED",
      failure_code: "snapshot_changed_before_dispatch",
      retry_safe: 1,
      dispatch_started_at: null
    });
  });

  it("keeps a failed pre-provider authorization callback retry-safe", async () => {
    seedGift(database, gift({ id: "gift_pre_provider_callback_failure" }));
    vi.spyOn(repo, "markStripeAnnualStatementDispatchStarted")
      .mockRejectedValueOnce(new Error("simulated worker interruption before authorization committed"));

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 0, failed: 1, review: 0 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT status, retry_safe, dispatch_started_at FROM stripe_annual_statement_deliveries"
    ).get()).toEqual({ status: "FAILED", retry_safe: 1, dispatch_started_at: null });

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:01:00.000Z"
    })).toMatchObject({ sent: 1, failed: 0, review: 0 });
    expect(emailSend).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["organization name", "branding_display_name", "Original Church", "Updated Church"],
    ["accent color", "branding_accent_color", "#0f766e", "#123456"],
    ["support email", "branding_support_email", "old-support@example.org", "new-support@example.org"],
    [
      "email logo metadata",
      "branding_logo",
      JSON.stringify({ contentType: "image/png", size: 10, version: "logo-old" }),
      JSON.stringify({ contentType: "image/png", size: 10, version: "logo-new" })
    ],
    [
      "PDF donor-logo metadata",
      "branding_donor_logo",
      JSON.stringify({ contentType: "image/png", size: 10, version: "donor-logo-old" }),
      JSON.stringify({ contentType: "image/png", size: 10, version: "donor-logo-new" })
    ],
    ["sender name", "email_sender_name", "Original Sender", "Updated Sender"],
    ["reply-to address", "email_reply_to", "old-replies@example.org", "new-replies@example.org"]
  ])("fences a %s mutation completed during final dispatch authorization", async (_label, key, initial, changed) => {
    seedGift(database, gift({ id: `gift_branding_race_${key}` }));
    database.prepare(
      "INSERT INTO app_settings (key, value) VALUES (?, ?)"
    ).run(key, initial);
    const originalMark = repo.markStripeAnnualStatementDispatchStarted.bind(repo);
    vi.spyOn(repo, "markStripeAnnualStatementDispatchStarted").mockImplementation(async (input) => {
      database.prepare("UPDATE app_settings SET value = ? WHERE key = ?").run(changed, key);
      return originalMark(input);
    });

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 0, failed: 1, review: 0 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT status, failure_code, retry_safe, dispatch_started_at FROM stripe_annual_statement_deliveries"
    ).get()).toEqual({
      status: "FAILED",
      failure_code: "snapshot_changed_before_dispatch",
      retry_safe: 1,
      dispatch_started_at: null
    });
  });

  it("completes final asynchronous validation before marking ambiguous provider entry", async () => {
    seedGift(database, gift({ id: "gift_provider_boundary_order" }));
    const order: string[] = [];
    const originalRead = repo.listStripeAnnualStatementDonorGifts.bind(repo);
    let reads = 0;
    vi.spyOn(repo, "listStripeAnnualStatementDonorGifts").mockImplementation(async (...args) => {
      const rows = await originalRead(...args);
      reads += 1;
      if (reads === 2) order.push("final-validation");
      return rows;
    });
    const originalMark = repo.markStripeAnnualStatementDispatchStarted.bind(repo);
    vi.spyOn(repo, "markStripeAnnualStatementDispatchStarted").mockImplementation(async (input) => {
      order.push("dispatch-marker");
      return originalMark(input);
    });
    emailSend.mockImplementation(async () => {
      order.push("provider-entry");
      return { messageId: "provider-boundary-order" };
    });

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 1, failed: 0, review: 0 });
    expect(order).toEqual(["final-validation", "dispatch-marker", "provider-entry"]);
  });

  it("keeps a durable SENT outcome authoritative when its follow-up audit write fails", async () => {
    seedGift(database, gift({ id: "gift_sent_audit" }));
    const createAudit = vi.spyOn(repo, "createAudit")
      .mockRejectedValueOnce(new Error("audit unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 1, failed: 0, review: 0 });
    expect(database.prepare("SELECT status, sent_at FROM stripe_annual_statement_deliveries").get())
      .toEqual({ status: "SENT", sent_at: "2026-01-10T12:00:00.000Z" });
    expect(createAudit).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
      event: "stripe_annual_statement_audit_failed"
    }));
  });

  it("keeps a durable FAILED outcome authoritative when its follow-up audit write fails", async () => {
    seedGift(database, gift({ id: "gift_failed_audit", amount_cents: 10_000 }));
    const originalRead = repo.listStripeAnnualStatementDonorGifts.bind(repo);
    let reads = 0;
    vi.spyOn(repo, "listStripeAnnualStatementDonorGifts").mockImplementation(async (...args) => {
      const rows = await originalRead(...args);
      reads += 1;
      return reads === 2
        ? rows.map((row) => ({
            ...row,
            status: "PARTIALLY_REFUNDED" as const,
            refunded_amount_cents: 100,
            net_amount_cents: row.amount_cents - 100
          }))
        : rows;
    });
    vi.spyOn(repo, "createAudit").mockRejectedValue(new Error("audit unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).resolves.toMatchObject({ sent: 0, failed: 1, review: 0 });
    expect(database.prepare("SELECT status, failure_code FROM stripe_annual_statement_deliveries").get())
      .toEqual({ status: "FAILED", failure_code: "snapshot_changed_before_dispatch" });
    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
      event: "stripe_annual_statement_audit_failed"
    }));
  });

  it("keeps a durable REVIEW outcome authoritative when its follow-up audit write fails", async () => {
    seedGift(database, gift({ id: "gift_review_audit" }));
    emailSend.mockRejectedValue(Object.assign(new Error("private provider response"), { code: "E_UNKNOWN" }));
    vi.spyOn(repo, "createAudit").mockRejectedValue(new Error("audit unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).resolves.toMatchObject({ sent: 0, failed: 0, review: 1 });
    expect(database.prepare("SELECT status, failure_code FROM stripe_annual_statement_deliveries").get())
      .toEqual({ status: "REVIEW", failure_code: "E_UNKNOWN" });
    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
      event: "stripe_annual_statement_audit_failed"
    }));
  });
});

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const buffer = Buffer.from(bytes);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function statementDocument(overrides: Partial<{
  legalName: string;
  ein: string;
  timeZone: string;
  organizationContact: {
    phone: string;
    website: string;
    mailingAddress: string[];
  };
  email: {
    organizationName: string;
    supportEmail: string;
    logoUrl: string | null;
    senderName: string;
    replyToAddress: string | null;
  };
}> = {}): StripeAnnualStatementDocumentEvidence {
  return {
    rendererVersion: "stripe-annual-statement-pdf:v6" as const,
    legalName: overrides.legalName ?? "Friends of Example Church, Inc.",
    ein: overrides.ein ?? "12-3456789",
    timeZone: overrides.timeZone ?? "America/New_York",
    accentColor: "#0f766e",
    logo: {
      format: "png" as const,
      hash: "ac235e246a9d15381b32501f49eec7e8f8fb60a52214e0fde9a6595e5c67e19c"
    },
    email: overrides.email ?? {
      organizationName: "ExamplePerson1",
      supportEmail: "legacy-contact-1@example.com",
      logoUrl: null,
      senderName: "ExamplePerson1",
      replyToAddress: null
    },
    organizationContact: overrides.organizationContact ?? {
      phone: "+1 555 555 0100",
      website: "https://example.org",
      mailingAddress: ["100 Example Avenue", "New York, NY 10001, USA"]
    },
    settings: {
      brandingDisplayName: null,
      brandingAccentColor: null,
      brandingSupportEmail: null,
      brandingLogo: null,
      brandingDonorLogo: null,
      emailSenderName: null,
      emailReplyTo: null
    }
  };
}

function gift(overrides: Partial<StripeAnnualStatementGift> & { id: string }): StripeAnnualStatementGift {
  const amountCents = overrides.amount_cents ?? 1_000;
  const refundedCents = overrides.refunded_amount_cents ?? 0;
  return {
    id: overrides.id,
    source_type: "PAYMENT_INTENT",
    source_id: overrides.source_id ?? `pi_${overrides.id}`,
    checkout_id: overrides.checkout_id ?? `checkout_${overrides.id}`,
    stripe_payment_intent_id: overrides.stripe_payment_intent_id ?? `pi_${overrides.id}`,
    stripe_invoice_id: null,
    stripe_subscription_id: null,
    frequency: overrides.frequency ?? "ONCE",
    gift_type: overrides.gift_type ?? "TITHE",
    amount_cents: amountCents,
    currency: "usd",
    donor_name: overrides.donor_name ?? "Ana",
    donor_email: overrides.donor_email === undefined ? "ana@example.org" : overrides.donor_email,
    donor_phone: overrides.donor_phone === undefined ? "+1 281 974 9002" : overrides.donor_phone,
    donor_address_json: overrides.donor_address_json === undefined
      ? JSON.stringify({
          line1: "332 Tangle Birch Court",
          line2: null,
          city: "Montgomery",
          state: "TX",
          postalCode: "77316",
          country: "US"
        })
      : overrides.donor_address_json,
    settled_at: overrides.settled_at ?? "2025-06-01T12:00:00.000Z",
    status: overrides.status ?? "PAID",
    refunded_amount_cents: refundedCents,
    net_amount_cents: overrides.net_amount_cents ?? amountCents - refundedCents,
    created_at: overrides.created_at ?? "2025-06-01T12:00:00.000Z",
    updated_at: overrides.updated_at ?? "2025-06-01T12:00:00.000Z"
  };
}

function seedGift(database: ReturnType<typeof migratedDatabase>, row: StripeAnnualStatementGift): void {
  database.prepare(
    `INSERT INTO stripe_checkout_sessions (
       id, request_id, request_fingerprint, frequency, gift_type, amount_cents,
       livemode, status, payment_status
     ) VALUES (?, ?, ?, ?, ?, ?, 0, 'COMPLETE', 'PAID')`
  ).run(row.checkout_id, `request_${row.id}`, `fingerprint_${row.id}`, row.frequency, row.gift_type, row.amount_cents);
  database.prepare(
    `INSERT INTO stripe_gifts (
       id, source_type, source_id, checkout_id, stripe_payment_intent_id,
       frequency, gift_type, amount_cents, donor_name, donor_email,
       donor_phone, donor_address_json, settled_at, status, refunded_amount_cents
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.source_type,
    row.source_id,
    row.checkout_id,
    row.stripe_payment_intent_id,
    row.frequency,
    row.gift_type,
    row.amount_cents,
    row.donor_name,
    row.donor_email,
    row.donor_phone,
    row.donor_address_json,
    row.settled_at,
    row.status,
    row.refunded_amount_cents
  );
}

function insertPendingStatement(
  database: ReturnType<typeof migratedDatabase>,
  id: string,
  revision: number,
  snapshot: Awaited<ReturnType<typeof buildStripeAnnualStatementSnapshot>>
): void {
  database.prepare(
    `INSERT INTO stripe_annual_statement_deliveries (
       id, year, livemode, donor_key, donor_name, donor_email,
       snapshot_hash, snapshot_json, revision, status, created_at, updated_at
     ) VALUES (?, 2025, 0, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`
  ).run(
    id,
    snapshot.donor.key,
    snapshot.donor.name,
    snapshot.donor.email,
    snapshot.hash,
    snapshot.canonicalJson,
    revision,
    "2026-01-10T11:00:00.000Z",
    "2026-01-10T11:00:00.000Z"
  );
}
