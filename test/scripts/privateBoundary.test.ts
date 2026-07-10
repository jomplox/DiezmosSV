import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const checker = resolve(import.meta.dirname, "../../scripts/check-private-boundary.mjs");
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
    "examples/DTE-private.json",
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
    expect(run(fixture({ "README.md": "safe" })).status).toBe(0);
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

function run(cwd: string): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [checker], { cwd, encoding: "utf8" });
}
