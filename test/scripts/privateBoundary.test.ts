import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { describe, expect, it } from "vitest";

const checker = resolve(import.meta.dirname, "../../scripts/check-private-boundary.mjs");
const gitIgnore = resolve(import.meta.dirname, "../../.gitignore");
const sentinel = "SENTINEL_PRIVATE_VALUE_MUST_NOT_APPEAR";

// A reserved-by-RFC-2606 hostname stands in for whatever real host an operator
// configures. It is written literally: the checker only knows the hosts it is
// configured with, and it is not configured with this one in this repository, so
// the test can be honest about the value it plants.
const forbiddenHost = "forbidden-tenant.invalid";
const unconfiguredHost = "other-tenant.invalid";

// Cloudflare's public *.workers.dev suffix and the example-worker-* names are
// always-on rules, not configuration, so a literal copy in this file would make
// the repository fail its own check. They are assembled at run time for that
// reason only - no private value is being hidden here.
const workersDevSuffix = ["workers", "dev"].join(".");
const exampleWorkerName = `example-worker-${"production"}`;

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
    expect(output(result)).toContain(path);
    expect(output(result)).not.toContain(sentinel);
  });

  it("allows committed demo/example files and a sanitized webhook example", () => {
    const cwd = fixture({
      ".dev.vars.ci": sentinel,
      ".dev.vars.example": sentinel,
      "examples/wompi-webhook.sample.json": sentinel
    });

    const result = run(cwd);

    expect(result.status).toBe(0);
    expect(output(result)).not.toContain(sentinel);
  });

  it("passes a clean checkout fixture", () => {
    expect(run(fixture({
      "README.md": "safe",
      "DTE/reference/schema.json": "safe",
      "examples/archive/public-sample.json": "safe"
    })).status).toBe(0);
  });

  it.each([
    ["", "Users", "example", "Documents", "private-artifact.png"].join("/"),
    ["", "home", "example", "private", "config.json"].join("/")
  ])("rejects a user-home absolute path in tracked text without printing it: %s", (privatePath) => {
    const cwd = trackedFixture({ "docs/plan.md": `owner file: ${privatePath}` });
    const result = run(cwd);

    expect(result.status).not.toBe(0);
    expect(output(result)).toContain("docs/plan.md");
    expect(output(result)).not.toContain(privatePath);
  });

  it.each([
    ["https://example.org", "Users", "example", "guide"].join("/"),
    "/api/branding/logo?v=example",
    "docs/examples/local-path.md"
  ])("allows ordinary tracked URL and repository-path examples: %s", (examplePath) => {
    expect(run(trackedFixture({ "docs/plan.md": examplePath })).status).toBe(0);
  });

  it.each([
    `https://tenant.${workersDevSuffix}/admin`,
    `https://api.cloudflare.com/client/v4/accounts/${"1000000019abcdef".repeat(2)}/workers/scripts/private`
  ])("rejects a tracked implementation endpoint without printing it: %s", (endpoint) => {
    const cwd = trackedFixture({ "README.md": `private endpoint: ${endpoint}` });
    const result = run(cwd);

    expect(result.status).not.toBe(0);
    expect(output(result)).toContain("README.md");
    expect(output(result)).not.toContain(endpoint);
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
    expect(output(result)).toContain("wrangler.toml");
    expect(output(result)).not.toContain("live-database");
  });

  it("accepts a tracked Wrangler config that only names example resources", () => {
    const cwd = trackedFixture({
      "wrangler.toml": [
        'database_name = "diezmos-example"',
        'database_id = "00000000-0000-0000-0000-000000000000"',
        'bucket_name = "example-archive"',
        'queue = "example-queue"'
      ].join("\n")
    });

    expect(run(cwd).status).toBe(0);
  });

  it.each([
    `tenant.${workersDevSuffix}`,
    exampleWorkerName
  ])("rejects a tracked raw implementation identifier without printing it: %s", (identifier) => {
    const cwd = trackedFixture({ "README.md": `private identifier: ${identifier}` });
    const result = run(cwd);

    expect(result.status).not.toBe(0);
    expect(output(result)).toContain("README.md");
    expect(output(result)).not.toContain(identifier);
  });

  describe("configured forbidden hosts", () => {
    it.each([
      forbiddenHost,
      `api.${forbiddenHost}`,
      `https://${forbiddenHost}/donar`,
      `https://deep.sub.${forbiddenHost}/admin`
    ])("rejects a host configured through the environment variable: %s", (planted) => {
      const cwd = trackedFixture({ "README.md": `endpoint: ${planted}` });
      const result = run(cwd, { PRIVATE_BOUNDARY_FORBIDDEN_HOSTS: forbiddenHost });

      expect(result.status).not.toBe(0);
      expect(output(result)).toContain("README.md");
      expect(output(result)).not.toContain(forbiddenHost);
    });

    it("rejects a host configured through the default host file", () => {
      const cwd = trackedFixture({ "docs/deploy.md": `see https://${forbiddenHost}/admin` });
      writeFileSync(join(cwd, ".private-boundary-hosts"), `# operator list\n${forbiddenHost}\n`);

      const result = run(cwd);

      expect(result.status).not.toBe(0);
      expect(output(result)).toContain("docs/deploy.md");
      expect(output(result)).not.toContain(forbiddenHost);
    });

    it("rejects a host configured through an out-of-tree host file", () => {
      const cwd = trackedFixture({ "README.md": `endpoint: ${forbiddenHost}` });
      const listPath = join(
        mkdtempSync(join(tmpdir(), "diezmos-private-boundary-hosts-")),
        "hosts.txt"
      );
      writeFileSync(listPath, `${forbiddenHost}\n`);

      const result = run(cwd, { PRIVATE_BOUNDARY_FORBIDDEN_HOSTS_FILE: listPath });

      expect(result.status).not.toBe(0);
      expect(output(result)).toContain("README.md");
      expect(output(result)).not.toContain(forbiddenHost);
    });

    it("parses multi-entry lists from both sources", () => {
      const cwd = trackedFixture({ "README.md": `endpoint: ${forbiddenHost}` });
      writeFileSync(
        join(cwd, ".private-boundary-hosts"),
        `# ignored comment\nfile-only.invalid\n\n  spaced.invalid  \n`
      );

      const result = run(cwd, {
        PRIVATE_BOUNDARY_FORBIDDEN_HOSTS: `first.invalid, ${forbiddenHost} ;second.invalid`
      });

      expect(result.status).not.toBe(0);
      expect(output(result)).toContain("README.md");
      expect(output(result)).not.toContain(forbiddenHost);
    });

    it("matches a host listed only in the file when the environment lists others", () => {
      const cwd = trackedFixture({ "README.md": "endpoint: file-only.invalid" });
      writeFileSync(join(cwd, ".private-boundary-hosts"), "file-only.invalid\n");

      const result = run(cwd, { PRIVATE_BOUNDARY_FORBIDDEN_HOSTS: forbiddenHost });

      expect(result.status).not.toBe(0);
      expect(output(result)).toContain("README.md");
    });

    it("accepts a host that is not configured", () => {
      const cwd = trackedFixture({
        "README.md": `public endpoint: https://${unconfiguredHost}/donar`
      });

      const result = run(cwd, { PRIVATE_BOUNDARY_FORBIDDEN_HOSTS: forbiddenHost });

      expect(result.status).toBe(0);
      expect(output(result)).toContain("clean");
    });

    it("accepts a hostname that merely ends with a configured host's label", () => {
      const cwd = trackedFixture({
        "README.md": `public endpoint: https://not${forbiddenHost}/donar`
      });

      expect(run(cwd, { PRIVATE_BOUNDARY_FORBIDDEN_HOSTS: forbiddenHost }).status).toBe(0);
    });

    it("warns instead of silently passing when no host is configured", () => {
      const cwd = trackedFixture({ "README.md": `endpoint: https://${forbiddenHost}/donar` });

      const result = run(cwd);

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("WARNING no forbidden hosts configured");
      expect(output(result)).not.toContain(forbiddenHost);
    });

    it("does not warn once a host is configured", () => {
      const cwd = trackedFixture({ "README.md": "safe" });

      const result = run(cwd, { PRIVATE_BOUNDARY_FORBIDDEN_HOSTS: forbiddenHost });

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("WARNING");
      expect(output(result)).not.toContain(forbiddenHost);
    });

    it("ignores untracked files carrying a configured host", () => {
      const cwd = trackedFixture({ "README.md": "safe" });
      writeFileSync(join(cwd, "notes.local.md"), `scratch: ${forbiddenHost}`);

      expect(run(cwd, { PRIVATE_BOUNDARY_FORBIDDEN_HOSTS: forbiddenHost }).status).toBe(0);
    });
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
    "examples/archive/deeper/DTE-private.pdf",
    ".private-boundary-hosts"
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

function run(cwd: string, env: Record<string, string> = {}): SpawnSyncReturns<string> {
  const baseEnv = { ...process.env };
  delete baseEnv.PRIVATE_BOUNDARY_FORBIDDEN_HOSTS;
  delete baseEnv.PRIVATE_BOUNDARY_FORBIDDEN_HOSTS_FILE;

  return spawnSync(process.execPath, [checker], {
    cwd,
    encoding: "utf8",
    env: { ...baseEnv, ...env }
  });
}

function output(result: SpawnSyncReturns<string>): string {
  return result.stdout + result.stderr;
}
