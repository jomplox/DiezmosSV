import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it } from "vitest";
import { renderStripeUsPdfPreviews } from "../../scripts/render-stripe-us-pdf-previews";

describe("Stripe U.S. PDF preview command", () => {
  const directories: string[] = [];

  afterEach(() => {
    directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  });

  it("renders production receipt and annual statement previews as U.S. Letter with unmistakable sample values", async () => {
    const directory = mkdtempSync(join(tmpdir(), "stripe-us-pdf-previews-"));
    directories.push(directory);

    const previews = await renderStripeUsPdfPreviews(directory, {
      legalName: "Friends of Misión Cristiana Elim",
      ein: "82-0889012",
      organizationName: "Misión Cristiana Elim",
      supportEmail: "fmce@example.org",
      organizationPhone: "+1 (786) 505-8446",
      organizationWebsite: "https://www.elim.click",
      organizationMailingAddress: [
        "2885 Sanford Ave SW, PMB 41357",
        "Grandville, MI 49418, USA"
      ],
      signerName: "Mathieu Guély",
      signerTitle: "Treasurer"
    });

    expect(previews).toEqual({
      receiptPath: join(directory, "stripe-us-single-gift-receipt.pdf"),
      annualPath: join(directory, "stripe-us-annual-giving-statement.pdf")
    });
    for (const preview of [previews.receiptPath, previews.annualPath]) {
      expect(readFileSync(preview).subarray(0, 4).toString()).toBe("%PDF");
      const pdf = await PDFDocument.load(readFileSync(preview));
      expect(pdf.getPageCount()).toBe(1);
      expect(pdf.getPage(0).getMediaBox()).toEqual({ x: 0, y: 0, width: 612, height: 792 });
    }

    const receiptText = execFileSync("pdftotext", ["-layout", previews.receiptPath, "-"], { encoding: "utf8" });
    const normalizedReceiptText = receiptText.replace(/\s+/gu, " ");
    expect(receiptText).toContain("SAMPLE PREVIEW DONOR");
    expect(receiptText).toContain("pi_sample_receipt_2025_0413");
    expect(normalizedReceiptText).toContain("Friends of Misión Cristiana Elim");
    expect(receiptText).toContain("EIN 82-0889012");
    expect(receiptText).toContain("fmce@example.org");
    expect(receiptText).toContain("PAYMENT METHOD: Stripe");
    expect(receiptText).toContain("PAYMENT ID: pi_sample_receipt_2025_0413");
    expect(receiptText).not.toMatch(/12-3456789|giving@example\.org|555-01/u);

    const annualText = execFileSync("pdftotext", ["-layout", previews.annualPath, "-"], { encoding: "utf8" });
    const normalizedAnnualText = annualText.replace(/\s+/gu, " ");
    expect(annualText).toContain("SAMPLE PREVIEW DONOR");
    expect(annualText).toContain("pi_sample_annual_2025");
    expect(normalizedAnnualText).toContain("Misión Cristiana Elim");
    expect(annualText).not.toContain("Friends of Misión Cristiana Elim");
    expect(annualText).toContain("EIN 82-0889012");
    expect(annualText).toContain("fmce@example.org · +1 (786) 505-8446");
    expect(annualText).toContain("PAYMENT METHOD");
    expect(annualText).not.toMatch(/12-3456789|giving@example\.org|\+1 \(616\) 555-0143/u);
    for (let index = 1; index <= 5; index += 1) {
      expect(annualText).toContain(`pi_sample_annual_2025_${String(index).padStart(2, "0")}`);
    }
    expect(`${receiptText}\n${annualText}`).not.toMatch(/L{8}|A{8}|w{8}|2{8}/u);
  });
});
