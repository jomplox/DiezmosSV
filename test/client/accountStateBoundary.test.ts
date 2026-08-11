import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");

describe("authenticated account state boundary", () => {
  it("uses one complete account-state reset on login, logout, and session expiry", () => {
    expect(appSource).toContain("function resetAccountState()");
    expect(appSource).toMatch(/async function login[\s\S]*?resetAccountState\(\);[\s\S]*?setToken\(result\.token\)/);
    expect(appSource).toMatch(/async function logout[\s\S]*?resetAccountState\(\);[\s\S]*?setToken\(""\)/);
    expect(appSource).toMatch(/function expireSession[\s\S]*?resetAccountState\(\);[\s\S]*?setToken\(""\)/);

    for (const reset of [
      "setDocuments([])",
      "setAudit([])",
      "setUsers([])",
      "setCredentials(null)",
      "setEmailTemplates(null)",
      "setAdvancedDteOpen(false)",
      "setDonationIntents([])",
      "setBackups([])",
      "setAnalytics(null)",
      "setStripeStatementPreview(null)"
    ]) {
      expect(appSource).toContain(reset);
    }
  });

  it("defense-in-depth guards privileged panels by the current account role", () => {
    expect(appSource).toContain('view === "credentials" && can(user, "OWNER")');
    expect(appSource).toContain('advancedDteOpen && can(user, "OPERATOR")');
  });

  it("invalidates the independent Stripe statement lane at the account boundary", () => {
    expect(appSource).toContain("stripeStatementOperationClaimsRef.current.clear()");
    expect(appSource).toContain("stripeStatementSearchInputGenerationRef.current += 1");
    expect(appSource).toContain("invalidateStripeStatementPreview(certificateResetYear, \"\")");
    expect(appSource).toContain("resetStripeStatementBulkTraversal(certificateResetYear)");
  });
});
