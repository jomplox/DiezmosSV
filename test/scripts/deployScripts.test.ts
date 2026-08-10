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

  it("routes each deployment build through the private configuration wrapper", () => {
    expect(packageJson.scripts["build:private"]).toBe("node scripts/run-private-build.mjs");
    expect(packageJson.scripts["cf:deploy:staging"]).toContain(
      "npm run build:private -- --env staging"
    );
    expect(packageJson.scripts["cf:deploy:prod"]).toContain(
      "npm run build:private -- --env production"
    );
    expect(packageJson.scripts["cf:deploy:prod"]).not.toContain(
      "assert-donation-lane-config"
    );
    expect(
      existsSync(resolve(import.meta.dirname, "../../scripts/assert-donation-lane-config.mjs"))
    ).toBe(true);
    expect(
      existsSync(resolve(import.meta.dirname, "../../scripts/run-private-build.mjs"))
    ).toBe(true);
  });

  it("blocks deployment unless the private runtime donor logo matches", () => {
    expect(packageJson.scripts["cf:deploy:staging"]).toBe(
      "node scripts/assert-runtime-branding-logo.mjs --env staging && npm run build:private -- --env staging && node scripts/run-private-wrangler.mjs deploy --env staging --keep-vars"
    );
    expect(packageJson.scripts["cf:deploy:prod"]).toBe(
      "node scripts/assert-fiscal-cutover.mjs && node scripts/assert-runtime-branding-logo.mjs --env production && npm run build:private -- --env production && node scripts/run-private-wrangler.mjs deploy --env production --keep-vars"
    );
    expect(packageJson.scripts["cf:branding:check"]).toBe(
      "node scripts/assert-runtime-branding-logo.mjs"
    );
    expect(packageJson.scripts["cf:branding:migrate"]).toBe(
      "node scripts/migrate-runtime-branding-logo.mjs"
    );
    expect(
      existsSync(resolve(import.meta.dirname, "../../scripts/assert-runtime-branding-logo.mjs"))
    ).toBe(true);
    expect(
      existsSync(resolve(import.meta.dirname, "../../scripts/migrate-runtime-branding-logo.mjs"))
    ).toBe(true);
  });

  it("guards the explicit staging cutover before migration and deployment", () => {
    expect(packageJson.scripts["cf:cutover:staging"]).toBe(
      "node scripts/assert-fiscal-cutover.mjs && npm run cf:migrate:staging && npm run cf:deploy:staging"
    );
    expect(
      existsSync(resolve(import.meta.dirname, "../../scripts/assert-fiscal-cutover.mjs"))
    ).toBe(true);
  });

  it("runs preflight and compatibility migration in the exact staging order", () => {
    expect(packageJson.scripts["cf:migrate:staging"]).toBe(
      "node scripts/d1-migration-preflight.mjs --binding DB --env staging && node scripts/d1-schema-compatibility.mjs migrate --binding DB --env staging"
    );
  });

  it("keeps the fiscal assertion first, then preflight and compatibility migration in production", () => {
    expect(packageJson.scripts["cf:migrate:prod"]).toBe(
      "node scripts/assert-fiscal-cutover.mjs && node scripts/d1-migration-preflight.mjs --binding DB --env production && node scripts/d1-schema-compatibility.mjs migrate --binding DB --env production"
    );
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
        script.startsWith("cf:migrate:")
          ? "scripts/d1-schema-compatibility.mjs"
          : "scripts/run-private-wrangler.mjs"
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
