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

    const previews = await renderStripeUsPdfPreviews(directory);

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
    expect(receiptText).toContain("Ana Morales");
    expect(receiptText).toContain("pi_sample_receipt_2025_0413");
    expect(normalizedReceiptText).toContain("Friends of Misión Cristiana Elim, Inc.");
    expect(receiptText).toContain("giving@example.org");
    expect(receiptText).toContain("United States");

    const annualText = execFileSync("pdftotext", ["-layout", previews.annualPath, "-"], { encoding: "utf8" });
    const normalizedAnnualText = annualText.replace(/\s+/gu, " ");
    expect(annualText).toContain("Ana Morales");
    expect(annualText).toContain("pi_sample_annual_2025");
    expect(normalizedAnnualText).toContain("Friends of Misión Cristiana Elim, Inc.");
    expect(annualText).toContain("giving@example.org");
    expect(annualText).toContain("United States");
    for (let index = 1; index <= 5; index += 1) {
      expect(annualText).toContain(`pi_sample_annual_2025_${String(index).padStart(2, "0")}`);
    }
    expect(`${receiptText}\n${annualText}`).not.toMatch(/L{8}|A{8}|w{8}|2{8}/u);
  });
});
