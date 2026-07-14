import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const stagingSmokeScript = resolve(import.meta.dirname, "../../scripts/staging-smoke.mjs");
const workerDevScript = resolve(import.meta.dirname, "../../scripts/run-worker-dev.mjs");
const repositoryRoot = resolve(import.meta.dirname, "../..");

describe("private environment file permissions", () => {
  it("rejects a group/world-readable staging smoke env file before loading it", () => {
    const directory = mkdtempSync(join(tmpdir(), "diezmos-staging-permissions-"));
    const envFile = join(directory, "staging-smoke.env");
    writeFileSync(
      envFile,
      [
        "STAGING_URL=https://staging.example.org",
        "STAGING_EMAIL=operator@example.org",
        "STAGING_PASSWORD=secret",
        "WOMPI_API_SECRET=secret",
        "SMOKE_DONOR_DOCUMENT=10000000-1"
      ].join("\n"),
      { mode: 0o600 }
    );
    chmodSync(envFile, 0o644);

    const result = spawnSync(process.execPath, [stagingSmokeScript, "--dry-run"], {
      encoding: "utf8",
      env: { ...process.env, DIEZMOSSV_ENV_FILE: envFile }
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("owner-only permissions");
  });

  it("rejects a group/world-readable Worker dev env file before starting Wrangler", () => {
    const directory = mkdtempSync(join(tmpdir(), "diezmos-worker-permissions-"));
    const envFile = join(directory, "local-operator.env");
    const binDirectory = join(directory, "node_modules", ".bin");
    mkdirSync(binDirectory, { recursive: true });
    writeFileSync(envFile, "APP_ENV=local\n", { mode: 0o600 });
    chmodSync(envFile, 0o644);
    const wrangler = join(binDirectory, "wrangler");
    writeFileSync(wrangler, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = spawnSync(process.execPath, [workerDevScript], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, DIEZMOSSV_ENV_FILE: envFile }
    });

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("owner-only permissions");
  });

  it("continues to accept an owner-only Worker dev env file", () => {
    const directory = mkdtempSync(join(tmpdir(), "diezmos-worker-permissions-"));
    const envFile = join(directory, "local-operator.env");
    const binDirectory = join(directory, "node_modules", ".bin");
    mkdirSync(binDirectory, { recursive: true });
    writeFileSync(envFile, "APP_ENV=local\n", { mode: 0o600 });
    const wrangler = join(binDirectory, "wrangler");
    writeFileSync(wrangler, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    const result = spawnSync(process.execPath, [workerDevScript], {
      cwd: directory,
      encoding: "utf8",
      env: { ...process.env, DIEZMOSSV_ENV_FILE: envFile }
    });

    expect(result.status).toBe(0);
  });

  it("accepts only the exact checked-in non-secret CI fixture despite its Git-readable mode", () => {
    const result = spawnSync(process.execPath, [workerDevScript, "--help"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, DIEZMOSSV_ENV_FILE: ".dev.vars.ci" }
    });

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).toContain("Using Worker environment file:");
    expect(result.stdout + result.stderr).not.toContain("owner-only permissions");
  });
});
