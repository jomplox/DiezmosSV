import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const smokeSource = readFileSync(resolve(import.meta.dirname, "../../scripts/staging-smoke.mjs"), "utf8");

describe("staging smoke disposable VIEWER password", () => {
  it("derives the password from randomBytes instead of the timestamp", () => {
    expect(smokeSource).toMatch(/import\s*\{[^}]*\brandomBytes\b[^}]*\}\s*from\s*"node:crypto"/);
    expect(smokeSource).toContain('randomBytes(18).toString("base64url")');
    // The old timestamp-derived password made the secret trivially guessable from the
    // logged, timestamped VIEWER email.
    expect(smokeSource).not.toContain("password: `Smoke-${suffix}!`");
  });

  it("never logs or reports the disposable password", () => {
    expect(smokeSource).not.toMatch(/(logStep|console\.\w+|results\.push)\([^\n]*\bpassword\b/);
  });
});
