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
  // The FISCAL_CUTOVER_QUIESCED acknowledgment gate protected the one-time
  // 0020/0021 claims cutover, which is complete on staging; production will be
  // provisioned fresh with the full migration lineage and no traffic to drain.
  // The gate must never return: it blocked every routine deploy with a stale
  // quiesce procedure.
  it("keeps every remote script free of the retired cutover gate", () => {
    for (const [name, command] of Object.entries(packageJson.scripts)) {
      expect(command, `script ${name}`).not.toContain("assert-fiscal-cutover");
      expect(command, `script ${name}`).not.toContain("FISCAL_CUTOVER_QUIESCED");
    }
    expect(existsSync(resolve(import.meta.dirname, "../../scripts/assert-fiscal-cutover.mjs"))).toBe(false);
  });

  it("still runs the D1 preflight before every remote migration", () => {
    for (const script of ["cf:migrate:staging", "cf:migrate:prod"] as const) {
      expect(packageJson.scripts[script]).toMatch(/^node scripts\/d1-migration-preflight\.mjs /);
    }
  });

  it("keeps the applied cutover migration's backfill content unchanged", () => {
    expect(lifecycleMigration).toContain("WHERE status = 'ACCEPTED'");
    expect(lifecycleMigration).toContain("post_accept_finalized_at = COALESCE(accepted_at, updated_at, created_at)");
  });
});
