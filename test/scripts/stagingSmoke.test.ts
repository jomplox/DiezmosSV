import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const smokeScript = resolve(import.meta.dirname, "../../scripts/staging-smoke.mjs");
const smokeSource = readFileSync(smokeScript, "utf8");
const stagingUatSource = readFileSync(resolve(import.meta.dirname, "../../docs/cloudflare-staging-uat.md"), "utf8");

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

describe("staging smoke private environment file", () => {
  it("loads required values from DIEZMOSSV_ENV_FILE without printing secrets", () => {
    const directory = mkdtempSync(join(tmpdir(), "diezmos-staging-smoke-"));
    const envFile = join(directory, "staging-smoke.env");
    writeFileSync(
      envFile,
      [
        "STAGING_URL=https://staging.example.org",
        "STAGING_EMAIL=operator@example.org",
        "STAGING_PASSWORD=SENTINEL_STAGING_PASSWORD",
        "WOMPI_API_SECRET=SENTINEL_WOMPI_SECRET",
        "SMOKE_DONOR_DOCUMENT=10000000-1",
        "SMOKE_DONOR_EMAIL=smoke@example.org"
      ].join("\n"),
      { mode: 0o600 }
    );

    const result = runSmoke(envFile, ["--dry-run"]);
    const output = result.stdout + result.stderr;

    expect(result.status).toBe(0);
    expect(output).toContain("https://staging.example.org");
    expect(output).not.toContain("SENTINEL_STAGING_PASSWORD");
    expect(output).not.toContain("SENTINEL_WOMPI_SECRET");
    expect(output).not.toContain("smoke@example.org");
    expect(output).not.toContain("donorEmail");
    expect(output).not.toContain("donorDocument");
  });

  it("rejects a symlinked environment file", () => {
    const directory = mkdtempSync(join(tmpdir(), "diezmos-staging-smoke-"));
    const target = join(directory, "target.env");
    const link = join(directory, "staging-smoke.env");
    writeFileSync(target, "STAGING_URL=https://staging.example.org\n", { mode: 0o600 });
    symlinkSync(target, link);

    const result = runSmoke(link, ["--dry-run"]);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("regular non-symlink file");
  });

  it("documents the out-of-tree smoke env file without inline credentials or donor identity", () => {
    expect(stagingUatSource).toContain("DIEZMOSSV_ENV_FILE");
    expect(stagingUatSource).not.toMatch(/^(?:STAGING_PASSWORD|STAGING_BOOTSTRAP_TOKEN|WOMPI_API_SECRET|SMOKE_DONOR_DOCUMENT|SMOKE_DONOR_EMAIL)=/m);
  });
});

function runSmoke(envFile: string, args: string[]): ReturnType<typeof spawnSync> {
  const env = { ...process.env, DIEZMOSSV_ENV_FILE: envFile };
  for (const key of [
    "STAGING_URL",
    "STAGING_EMAIL",
    "STAGING_PASSWORD",
    "WOMPI_API_SECRET",
    "SMOKE_DONOR_DOCUMENT",
    "SMOKE_DONOR_EMAIL"
  ]) {
    delete env[key];
  }
  return spawnSync(process.execPath, [smokeScript, ...args], { encoding: "utf8", env });
}
