import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const guardScript = resolve(import.meta.dirname, "../../scripts/assert-fiscal-cutover.mjs");
const cutoverGuide = readFileSync(resolve(import.meta.dirname, "../../docs/fiscal-claim-cutover.md"), "utf8");
const lifecycleMigration = readFileSync(resolve(import.meta.dirname, "../../migrations/0021_security_lifecycle_guards.sql"), "utf8");
const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")
) as { scripts: Record<string, string> };

describe("fiscal claim migration cutover", () => {
  it("blocks a remote migration without an explicit quiescence acknowledgement", () => {
    const env = { ...process.env };
    delete env.FISCAL_CUTOVER_QUIESCED;

    const result = spawnSync(process.execPath, [guardScript, "staging"], { encoding: "utf8", env });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toMatch(/quiesc|drain/i);
  });

  it("allows the migration only after the operator confirms the documented gate", () => {
    const result = spawnSync(process.execPath, [guardScript, "production"], {
      encoding: "utf8",
      env: { ...process.env, FISCAL_CUTOVER_QUIESCED: "1" }
    });

    expect(result.status).toBe(0);
  });

  it("guards every standard remote migration and deploy command", () => {
    expect(packageJson.scripts["cf:migrate:staging"]).toMatch(/^node scripts\/assert-fiscal-cutover\.mjs staging &&/);
    expect(packageJson.scripts["cf:migrate:prod"]).toMatch(/^node scripts\/assert-fiscal-cutover\.mjs production &&/);
    expect(packageJson.scripts["cf:deploy:staging"]).toMatch(/^node scripts\/assert-fiscal-cutover\.mjs staging &&/);
    expect(packageJson.scripts["cf:deploy:prod"]).toMatch(/^node scripts\/assert-fiscal-cutover\.mjs production &&/);
  });

  it("backfills historical acceptances and verifies finalization ownership at cutover", () => {
    expect(lifecycleMigration).toContain("WHERE status = 'ACCEPTED'");
    expect(lifecycleMigration).toContain("post_accept_finalized_at = COALESCE(accepted_at, updated_at, created_at)");
    expect(cutoverGuide).toContain("post_accept_finalization_claim_id");
    expect(cutoverGuide).toContain("post_accept_finalization_claimed_at");
    expect(cutoverGuide).toContain("post_accept_email_dispatch_started_at");
    expect(cutoverGuide).toContain("post_accept_finalized_at IS NULL");
  });

  it("requires a full mutating-traffic drain, including account and recovery routes", () => {
    expect(cutoverGuide).toMatch(/login/i);
    expect(cutoverGuide).toContain("/api/auth/password-reset/request");
    expect(cutoverGuide).toContain("/api/auth/password-reset/confirm");
    expect(cutoverGuide).toContain("/api/users/");

    const env = { ...process.env };
    delete env.FISCAL_CUTOVER_QUIESCED;
    const result = spawnSync(process.execPath, [guardScript, "staging"], { encoding: "utf8", env });
    expect(result.stdout + result.stderr).toMatch(/account|login|password.reset/i);
  });
});
