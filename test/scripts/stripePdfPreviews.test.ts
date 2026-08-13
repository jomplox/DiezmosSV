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

  it("renders production receipt and annual statement previews with unmistakable sample values", async () => {
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
    expect(receiptText).toContain("Preview Receipt Donor 413");
    expect(receiptText).toContain("pi_preview_receipt_413");
    expect(receiptText).toContain("Preview Receipt Legal Foundation");
    expect(receiptText).toContain("preview-receipt@example.org");

    const annualText = execFileSync("pdftotext", ["-layout", previews.annualPath, "-"], { encoding: "utf8" });
    expect(annualText).toContain("Preview Annual Donor 517");
    expect(annualText).toContain("pi_preview_annual_517");
    expect(annualText).toContain("Preview Annual Legal Foundation");
    expect(annualText).toContain("preview-annual@example.org");
  });
});
