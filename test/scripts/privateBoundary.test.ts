import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { describe, expect, it } from "vitest";

const checker = resolve(import.meta.dirname, "../../scripts/check-private-boundary.mjs");
const gitIgnore = resolve(import.meta.dirname, "../../.gitignore");
const sentinel = "SENTINEL_PRIVATE_VALUE_MUST_NOT_APPEAR";

describe("private artifact boundary checker", () => {
  it.each([
    ".dev.vars",
    ".dev.vars.backup",
    "tools/.dev.vars",
    "fixtures/.dev.vars.backup",
    "DTE/Credentials/live.key",
    "WompiWebhookSample.json",
    "DTE/F960_private.csv",
    "DTE/exports/2026/F960_private.xlsx",
    "DTE/exports/private.pdf",
    "DTE/exports/page_OCR.md",
    "DTE/exports/page_by_PaddleOCR-v3.md",
    "examples/DTE-private.json",
    "examples/archive/DTE-private.json",
    "examples/archive/deeper/DTE-private.pdf",
    "node_modules/.cache/wrangler/wrangler-account.json",
    "node_modules/.mf/cf.json"
  ])("rejects %s without printing its contents", (path) => {
    const cwd = fixture({ [path]: sentinel });
    const result = run(cwd);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(path);
    expect(result.stdout + result.stderr).not.toContain(sentinel);
  });

  it("allows committed demo/example files and a sanitized webhook example", () => {
    const cwd = fixture({
      ".dev.vars.ci": sentinel,
      ".dev.vars.example": sentinel,
      "examples/wompi-webhook.sample.json": sentinel
    });

    const result = run(cwd);

    expect(result.status).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(sentinel);
  });

  it("passes a clean checkout fixture", () => {
    expect(run(fixture({
      "README.md": "safe",
      "DTE/reference/schema.json": "safe",
      "examples/archive/public-sample.json": "safe"
    })).status).toBe(0);
  });

  it.each([
    `https://tenant.${"workers.dev"}/admin`,
    `https://tenant.${"elim" + ".example"}/donar`,
    `https://api.cloudflare.com/client/v4/accounts/${"1000000019abcdef".repeat(2)}/workers/scripts/private`
  ])("rejects a tracked implementation endpoint without printing it: %s", (endpoint) => {
    const cwd = trackedFixture({ "README.md": `private endpoint: ${endpoint}` });
    const result = run(cwd);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("README.md");
    expect(result.stdout + result.stderr).not.toContain(endpoint);
  });

  it("rejects live resource identifiers in a tracked Wrangler config", () => {
    const cwd = trackedFixture({
      "wrangler.toml": [
        'database_name = "live-database"',
        'database_id = "11111111-1111-1111-1111-111111111111"',
        'bucket_name = "live-archive"',
        'queue = "live-queue"'
      ].join("\n")
    });
    const result = run(cwd);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("wrangler.toml");
    expect(result.stdout + result.stderr).not.toContain("live-database");
  });

  it.each([
    `tenant.${"workers.dev"}`,
    `tenant.${"elim" + ".example"}`,
    `example-worker-${"production"}`
  ])("rejects a tracked raw implementation identifier without printing it: %s", (identifier) => {
    const cwd = trackedFixture({ "README.md": `private identifier: ${identifier}` });
    const result = run(cwd);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("README.md");
    expect(result.stdout + result.stderr).not.toContain(identifier);
  });

  it.each([
    "DTE/private.csv",
    "DTE/exports/2026/private.csv",
    "DTE/exports/private.xlsx",
    "DTE/exports/private.pdf",
    "DTE/exports/page_OCR.md",
    "DTE/exports/page_by_PaddleOCR-v3.md",
    "examples/DTE-private.json",
    "examples/archive/DTE-private.json",
    "examples/archive/deeper/DTE-private.pdf"
  ])("keeps Git ignore coverage aligned at every depth: %s", (path) => {
    const cwd = fixture({ [path]: sentinel });
    copyFileSync(gitIgnore, join(cwd, ".gitignore"));
    expect(spawnSync("git", ["init", "--quiet"], { cwd, encoding: "utf8" }).status).toBe(0);

    const ignored = spawnSync("git", ["check-ignore", "--no-index", "--", path], {
      cwd,
      encoding: "utf8"
    });

    expect(ignored.status).toBe(0);
  });
});

function fixture(files: Record<string, string>): string {
  const cwd = mkdtempSync(join(tmpdir(), "diezmos-private-boundary-"));
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(cwd, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, contents);
  }
  return cwd;
}

function trackedFixture(files: Record<string, string>): string {
  const cwd = fixture(files);
  expect(spawnSync("git", ["init", "--quiet"], { cwd, encoding: "utf8" }).status).toBe(0);
  expect(spawnSync("git", ["add", "--", ...Object.keys(files)], {
    cwd,
    encoding: "utf8"
  }).status).toBe(0);
  return cwd;
}

function run(cwd: string): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [checker], { cwd, encoding: "utf8" });
}
