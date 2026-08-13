import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource =
  readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8") +
  readFileSync(resolve(import.meta.dirname, "../../src/client/exportsPanel.tsx"), "utf8");

describe("Stripe annual statement UI contract", () => {
  it("keeps the U.S. reporting lane explicitly separate from the Salvadoran CDE dossier", () => {
    expect(appSource).toContain("El Salvador — CDE");
    expect(appSource).toContain("EE. UU. — Stripe");
    expect(appSource).toContain("501(c)(3) acknowledgment");
    expect(appSource).toContain("no es un expediente CDE salvadoreño");
  });

  it("uses the dedicated Stripe endpoints without giving the browser a livemode selector", () => {
    expect(appSource).toContain("/api/statements/stripe/annual?year=");
    expect(appSource).toContain("/api/statements/stripe/annual/send?year=");
    expect(appSource).toContain("stripeStatementPreviewPath");
    expect(appSource).not.toContain("stripeStatementLivemode");
  });

  it("owns Stripe preview, bulk, search, and operation state independently", () => {
    for (const name of [
      "stripeStatementPreviewCursor",
      "stripeStatementPreviewRequestRef",
      "stripeStatementBulkTraversalRef",
      "stripeStatementOperationClaimsRef",
      "stripeStatementSearchInputGenerationRef",
      "loadMoreStripeStatementPreview",
      "sendStripeAnnualStatements"
    ]) {
      expect(appSource).toContain(name);
    }
  });

  it("shares an annual-report operation lock with the Salvadoran lane", () => {
    expect(appSource).toContain("annualReportOperationClaimsRef");
    expect(appSource).toContain("claimAnnualReportOperation");
    expect(appSource).toContain("releaseAnnualReportOperation");
    expect(appSource).toContain("annualReportBusy");
    expect(appSource).toContain("annualReportOperationClaimsRef.current.size > 0");
    expect(appSource.match(/busy={annualReportBusy}/g)).toHaveLength(2);

    const stripeClaimStart = appSource.indexOf("function claimStripeStatementOperation");
    const stripeClaimEnd = appSource.indexOf("function ownsStripeStatementOperation", stripeClaimStart);
    expect(appSource.slice(stripeClaimStart, stripeClaimEnd)).toContain("claimAnnualReportOperation");

    const svClaimStart = appSource.indexOf("function claimCertificateOperation");
    const svClaimEnd = appSource.indexOf("function ownsCertificateOperation", svClaimStart);
    expect(appSource.slice(svClaimStart, svClaimEnd)).toContain("claimAnnualReportOperation");
  });

  it("commits each fulfilled export lane before surfacing a different preview failure", () => {
    const exportsStart = appSource.indexOf('if (view === "exports" && can(user, "ADMIN"))');
    const exportsEnd = appSource.indexOf("function automaticRefreshControl", exportsStart);
    const exportsSource = appSource.slice(exportsStart, exportsEnd);
    expect(exportsSource).toContain("const previewFailure");
    expect(exportsSource).toContain("commitStripeStatementPreview");
    expect(exportsSource).toContain("throw previewFailure");
    expect(exportsSource.indexOf("commitRefreshState(control")).toBeLessThan(exportsSource.indexOf("throw previewFailure"));
  });
});
