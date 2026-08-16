import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { describe, expect, it } from "vitest";

const smokeScript = resolve(import.meta.dirname, "../../scripts/staging-smoke.mjs");
const smokeSource = readFileSync(smokeScript, "utf8");
const stagingUatSource = readFileSync(resolve(import.meta.dirname, "../../docs/cloudflare-staging-uat.md"), "utf8");
const repositoryRoot = resolve(import.meta.dirname, "../..");

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

describe("staging smoke provenance", () => {
  it("uses one run UUID across the admin and signed-webhook paths", () => {
    expect(smokeSource.match(/const smokeRunId = randomUUID\(\);/g)).toHaveLength(1);
    expect(smokeSource).toContain("`SMOKE-WEBHOOK-${smokeRunId}`");
    expect(smokeSource).toContain("smokeRunId");
    expect(smokeSource).toMatch(/runAdminPath\([^)]*smokeRunId/);
    expect(smokeSource).toMatch(/runWebhookPath\([^)]*smokeRunId/);
  });
});

describe("staging smoke private environment file", () => {
  it("rejects a relative credential path instead of resolving it inside the caller's checkout", () => {
    const directory = mkdtempSync(join(tmpdir(), "diezmos-staging-smoke-relative-"));
    const envFile = join(directory, "staging-smoke.env");
    writeValidSmokeEnv(envFile);

    const result = spawnSync(process.execPath, [smokeScript, "--dry-run"], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, DIEZMOSSV_ENV_FILE: "staging-smoke.env" }
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("absolute path");
  });

  it("rejects an absolute credential file stored anywhere inside the repository", () => {
    const directory = mkdtempSync(join(repositoryRoot, ".staging-smoke-private-test-"));
    try {
      const envFile = join(directory, "staging-smoke.env");
      writeValidSmokeEnv(envFile);

      const result = runSmoke(envFile, ["--dry-run"]);

      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("outside the repository");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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

  it("rejects a smoke URL that differs from the approved private deploy origin", () => {
    const directory = mkdtempSync(join(tmpdir(), "diezmos-staging-smoke-"));
    const envFile = join(directory, "staging-smoke.env");
    writeValidSmokeEnv(envFile);
    writeFileSync(
      envFile,
      readFileSync(envFile, "utf8").replace(
        "https://staging.example.org",
        "https://attacker.example"
      ),
      { mode: 0o600 }
    );

    const result = runSmoke(envFile, ["--dry-run"]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("approved staging origin");
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

  it("allows an admin-only dry run without a Wompi signing secret", () => {
    const directory = mkdtempSync(join(tmpdir(), "diezmos-staging-smoke-"));
    const envFile = join(directory, "staging-smoke.env");
    writeFileSync(
      envFile,
      [
        "STAGING_URL=https://staging.example.org",
        "STAGING_EMAIL=operator@example.org",
        "STAGING_PASSWORD=SENTINEL_STAGING_PASSWORD",
        "SMOKE_DONOR_DOCUMENT=10000000-1",
        "SMOKE_DONOR_EMAIL=smoke@example.org",
        "SMOKE_PATHS=admin"
      ].join("\n"),
      { mode: 0o600 }
    );

    const result = runSmoke(envFile, ["--dry-run"]);
    const output = result.stdout + result.stderr;

    expect(result.status).toBe(0);
    expect(output).toContain('"admin"');
    expect(output).not.toContain("Missing required env: WOMPI_API_SECRET");
  });

  it("rejects an invalid smoke DUI before any staging request", () => {
    const directory = mkdtempSync(join(tmpdir(), "diezmos-staging-smoke-"));
    const envFile = join(directory, "staging-smoke.env");
    writeFileSync(
      envFile,
      [
        "STAGING_URL=https://staging.example.org",
        "STAGING_EMAIL=operator@example.org",
        "STAGING_PASSWORD=SENTINEL_STAGING_PASSWORD",
        "WOMPI_API_SECRET=SENTINEL_WOMPI_SECRET",
        "SMOKE_DONOR_DOCUMENT=01234567-0",
        "SMOKE_DONOR_EMAIL=smoke@example.org"
      ].join("\n"),
      { mode: 0o600 }
    );

    const result = runSmoke(envFile, ["--dry-run"]);
    const output = result.stdout + result.stderr;

    expect(result.status).not.toBe(0);
    expect(output).toContain("SMOKE_DONOR_DOCUMENT must be a valid Salvadoran DUI");
    expect(output).not.toContain("01234567-0");
  });

  it("documents the out-of-tree smoke env file without inline credentials or donor identity", () => {
    expect(stagingUatSource).toContain("DIEZMOSSV_ENV_FILE");
    expect(stagingUatSource).not.toMatch(/^(?:STAGING_PASSWORD|STAGING_BOOTSTRAP_TOKEN|WOMPI_API_SECRET|SMOKE_DONOR_DOCUMENT|SMOKE_DONOR_EMAIL)=/m);
  });
});

describe("staging smoke supported routes", () => {
  it("does not call the removed contingency sweep route", () => {
    expect(smokeSource).not.toContain("/api/contingency/sweep");
    expect(stagingUatSource).not.toContain("contingency sweep");
  });
});

function runSmoke(envFile: string, args: string[]): SpawnSyncReturns<string> {
  const privateRoot = dirname(envFile);
  const logoPath = join(privateRoot, "staging-logo.png");
  const configPath = join(privateRoot, "staging-deploy.env");
  writeFileSync(
    logoPath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    { mode: 0o600 }
  );
  writeFileSync(configPath, [
    "DIEZMOSSV_DEPLOY_TARGET=staging",
    "DIEZMOSSV_WORKER_NAME=diezmos-sv-staging",
    "DIEZMOSSV_GITHUB_REPOSITORY=jomplox/DiezmosSV",
    "DIEZMOSSV_CLOUDFLARE_ACCOUNT_ID=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "DIEZMOSSV_APP_ENV=staging",
    "DIEZMOSSV_D1_DATABASE_NAME=diezmos-sv-staging-db",
    "DIEZMOSSV_D1_DATABASE_ID=11111111-1111-1111-1111-111111111111",
    "DIEZMOSSV_R2_BUCKET_NAME=diezmos-sv-staging-archive",
    "DIEZMOSSV_QUEUE_NAME=diezmos-sv-staging-issuance",
    "DIEZMOSSV_QUEUE_DLQ_NAME=diezmos-sv-staging-issuance-dlq",
    "DIEZMOSSV_WORKERS_DEV=true",
    "VITE_GIVEBUTTER_CAMPAIGN=campaign-fixture",
    "DIEZMOSSV_APP_ORIGIN=https://staging.example.org",
    `DIEZMOSSV_DONOR_LOGO_FILE=${logoPath}`,
    ""
  ].join("\n"), { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DIEZMOSSV_ENV_FILE: envFile,
    DIEZMOSSV_DEPLOY_CONFIG: configPath
  };
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

function writeValidSmokeEnv(path: string): void {
  writeFileSync(
    path,
    [
      "STAGING_URL=https://staging.example.org",
      "STAGING_EMAIL=operator@example.org",
      "STAGING_PASSWORD=SENTINEL_STAGING_PASSWORD",
      "WOMPI_API_SECRET=SENTINEL_WOMPI_SECRET",
      "SMOKE_DONOR_DOCUMENT=10000000-1"
    ].join("\n"),
    { mode: 0o600 }
  );
}
