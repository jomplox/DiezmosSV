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
  it("keeps the fiscal cutover quiescence gate before every remote migration and deploy", () => {
    for (const script of [
      "cf:migrate:staging",
      "cf:deploy:staging",
      "cf:migrate:prod",
      "cf:deploy:prod"
    ] as const) {
      expect(packageJson.scripts[script], `script ${script}`).toMatch(
        /^node scripts\/assert-fiscal-cutover\.mjs && /
      );
    }
    expect(existsSync(resolve(import.meta.dirname, "../../scripts/assert-fiscal-cutover.mjs"))).toBe(true);
  });

  it("still runs the D1 preflight before every remote migration", () => {
    for (const script of ["cf:migrate:staging", "cf:migrate:prod"] as const) {
      expect(packageJson.scripts[script]).toContain(
        "&& node scripts/d1-migration-preflight.mjs "
      );
      expect(packageJson.scripts[script]).toMatch(
        /node scripts\/d1-migration-preflight\.mjs .* && wrangler d1 migrations apply /
      );
    }
  });

  it("keeps the applied cutover migration's backfill content unchanged", () => {
    expect(lifecycleMigration).toContain("WHERE status = 'ACCEPTED'");
    expect(lifecycleMigration).toContain("post_accept_finalized_at = COALESCE(accepted_at, updated_at, created_at)");
  });
});
