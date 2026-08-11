import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

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

  it("routes each deployment build through the private branding configuration wrapper", () => {
    expect(packageJson.scripts["build:private"]).toBe("node scripts/run-private-build.mjs");
    expect(packageJson.scripts["cf:deploy:staging"]).toContain(
      "npm run build:private -- --env staging"
    );
    expect(packageJson.scripts["cf:deploy:prod"]).toContain(
      "npm run build:private -- --env production"
    );
    expect(
      existsSync(resolve(import.meta.dirname, "../../scripts/assert-donation-lane-config.mjs"))
    ).toBe(false);
    expect(
      existsSync(resolve(import.meta.dirname, "../../scripts/run-private-build.mjs"))
    ).toBe(true);
  });

  it("wires the branding gate into both deploy scripts", () => {
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
      "node scripts/assert-fiscal-cutover.mjs && node scripts/assert-runtime-branding-logo.mjs --env staging && npm run cf:migrate:staging && npm run cf:deploy:staging"
    );
    expect(
      existsSync(resolve(import.meta.dirname, "../../scripts/assert-fiscal-cutover.mjs"))
    ).toBe(true);
  });

  it("asserts branding before the cutover chain touches the database", () => {
    const steps = packageJson.scripts["cf:cutover:staging"].split(" && ");
    const brandingStep = steps.findIndex((step) =>
      step.includes("assert-runtime-branding-logo")
    );
    const migrationStep = steps.findIndex((step) => step.includes("cf:migrate:staging"));

    expect(brandingStep).toBeGreaterThanOrEqual(0);
    expect(migrationStep).toBeGreaterThan(brandingStep);
  });

  it("aborts the rest of a composed chain when a leading gate exits non-zero", async () => {
    const root = mkdtempSync(join(tmpdir(), "diezmos-chain-"));
    roots.push(root);
    const marker = join(root, "later-step-ran");
    const laterStep = `node -e 'require("node:fs").writeFileSync(process.argv[1], "ran")' '${marker}'`;

    const blocked = await runChain(`node -e 'process.exit(1)' && ${laterStep}`);
    expect(blocked).toBe(1);
    expect(existsSync(marker)).toBe(false);

    // Positive control: the same harness runs the later step when the gate passes, so a
    // missing marker above means short-circuiting, not a broken chain.
    const allowed = await runChain(`node -e 'process.exit(0)' && ${laterStep}`);
    expect(allowed).toBe(0);
    expect(existsSync(marker)).toBe(true);
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

// npm runs a script string through the shell, so `A && B` is what actually stops B when
// the gate A fails. This exercises that semantics rather than asserting it.
function runChain(chain: string): Promise<number | null> {
  const child = spawn(chain, { shell: true, stdio: "ignore" });
  return new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
}
