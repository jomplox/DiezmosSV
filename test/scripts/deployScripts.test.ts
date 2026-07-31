import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")
) as { scripts: Record<string, string> };
const lifecycleMigration = readFileSync(
  resolve(import.meta.dirname, "../../migrations/0021_security_lifecycle_guards.sql"),
  "utf8"
);

describe("remote deploy and migration scripts", () => {
  it("keeps routine staging scripts free of the one-time cutover guard", () => {
    for (const script of ["cf:migrate:staging", "cf:deploy:staging"] as const) {
      expect(packageJson.scripts[script], `script ${script}`).not.toContain(
        "assert-fiscal-cutover"
      );
      expect(packageJson.scripts[script], `script ${script}`).not.toContain(
        "FISCAL_CUTOVER_QUIESCED"
      );
    }
  });

  it("keeps production migration and deployment guarded", () => {
    for (const script of ["cf:migrate:prod", "cf:deploy:prod"] as const) {
      expect(packageJson.scripts[script], `script ${script}`).toMatch(
        /^node scripts\/assert-fiscal-cutover\.mjs && /
      );
    }
  });

  it("guards the explicit staging cutover before migration and deployment", () => {
    expect(packageJson.scripts["cf:cutover:staging"]).toBe(
      "node scripts/assert-fiscal-cutover.mjs && npm run cf:migrate:staging && npm run cf:deploy:staging"
    );
    expect(
      existsSync(resolve(import.meta.dirname, "../../scripts/assert-fiscal-cutover.mjs"))
    ).toBe(true);
  });

  it("still runs the D1 preflight before every remote migration", () => {
    for (const script of ["cf:migrate:staging", "cf:migrate:prod"] as const) {
      expect(packageJson.scripts[script]).toMatch(
        /^(node scripts\/assert-fiscal-cutover\.mjs && )?node scripts\/d1-migration-preflight\.mjs --binding DB .* && node scripts\/run-private-wrangler\.mjs d1 migrations apply DB /
      );
    }
  });

  it("routes every remote Wrangler command through the private config wrapper", () => {
    for (const script of [
      "cf:whoami",
      "cf:migrate:staging",
      "cf:deploy:staging",
      "cf:tail:staging",
      "cf:migrate:prod",
      "cf:deploy:prod",
      "cf:tail:prod"
    ] as const) {
      expect(packageJson.scripts[script], `script ${script}`).toContain(
        "scripts/run-private-wrangler.mjs"
      );
      expect(packageJson.scripts[script], `script ${script}`).not.toMatch(
        /(?:^|&& )wrangler /
      );
    }
  });

  it("keeps the applied cutover migration's backfill content unchanged", () => {
    expect(lifecycleMigration).toContain("WHERE status = 'ACCEPTED'");
    expect(lifecycleMigration).toContain("post_accept_finalized_at = COALESCE(accepted_at, updated_at, created_at)");
  });
});
