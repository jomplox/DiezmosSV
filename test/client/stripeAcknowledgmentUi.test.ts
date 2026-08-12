import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source =
  readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8") +
  readFileSync(resolve(import.meta.dirname, "../../src/client/credentialsPanel.tsx"), "utf8") +
  readFileSync(resolve(import.meta.dirname, "../../src/client/types.ts"), "utf8");

describe("Stripe acknowledgment owner reconciliation UI", () => {
  it("loads sanitized failed/review evidence and exposes explicit owner resolutions", () => {
    expect(source).toContain("/api/settings/stripe/acknowledgments");
    expect(source).toContain("stripeAcknowledgmentReconciliation");
    expect(source).toContain("Confirmar que se envió");
    expect(source).toContain("Confirmar que no se envió");
    expect(source).toContain("Requiere conciliación");
    expect(source).not.toContain("acknowledgment.donorEmail");
    expect(source).not.toContain("acknowledgment.donorName");
  });
});
