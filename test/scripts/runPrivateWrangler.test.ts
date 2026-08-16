import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrivateWranglerRunner } from "../../scripts/run-private-wrangler.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("private Wrangler release provenance", () => {
  it("verifies the selected target before spawning a deploy", async () => {
    const fixture = wranglerFixture();
    const spawnCalls: string[][] = [];
    const assertProvenanceImpl = vi.fn(() => {
      expect(spawnCalls).toHaveLength(0);
      return { sha: "a".repeat(40) };
    });
    const runner = createPrivateWranglerRunner({
      repositoryRoot: fixture.repositoryRoot,
      configPath: fixture.configPath,
      env: { ...process.env, DIEZMOSSV_APPROVED_SHA: "a".repeat(40) },
      assertProvenanceImpl,
      spawnImpl: fakeSpawn(spawnCalls)
    });

    try {
      await expect(runner.run(["deploy", "--env", "staging"])).resolves.toBe("");
      expect(assertProvenanceImpl).toHaveBeenCalledWith(expect.objectContaining({
        target: "staging",
        repositoryRoot: fixture.repositoryRoot
      }));
      expect(spawnCalls).toHaveLength(1);
    } finally {
      runner.cleanup();
    }
  });

  it("rejects a remote deploy without an explicit staging or production target", async () => {
    const fixture = wranglerFixture();
    const spawnCalls: string[][] = [];
    const runner = createPrivateWranglerRunner({
      repositoryRoot: fixture.repositoryRoot,
      configPath: fixture.configPath,
      assertProvenanceImpl: vi.fn(),
      spawnImpl: fakeSpawn(spawnCalls)
    });
    try {
      await expect(runner.run(["deploy"])).rejects.toThrow(/explicit.*target/i);
      expect(spawnCalls).toHaveLength(0);
    } finally {
      runner.cleanup();
    }
  });

  it("still gates a remote command preceded by a global option value", async () => {
    const fixture = wranglerFixture();
    const spawnCalls: string[][] = [];
    const assertProvenanceImpl = vi.fn(() => ({ sha: "a".repeat(40) }));
    const runner = createPrivateWranglerRunner({
      repositoryRoot: fixture.repositoryRoot,
      configPath: fixture.configPath,
      assertProvenanceImpl,
      spawnImpl: fakeSpawn(spawnCalls)
    });
    try {
      await expect(runner.run([
        "--cwd",
        fixture.repositoryRoot,
        "deploy",
        "--env",
        "staging"
      ])).resolves.toBe("");
      expect(assertProvenanceImpl).toHaveBeenCalledTimes(1);
      expect(assertProvenanceImpl).toHaveBeenCalledWith(expect.objectContaining({
        target: "staging"
      }));
    } finally {
      runner.cleanup();
    }
  });
});

function wranglerFixture() {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "diezmos-runner-repository-"));
  const privateRoot = mkdtempSync(join(tmpdir(), "diezmos-runner-private-"));
  roots.push(repositoryRoot, privateRoot);
  const configPath = join(privateRoot, "wrangler.toml");
  writeFileSync(configPath, [
    'send_email = [{ name = "EMAIL" }]',
    "[env.staging]",
    'send_email = [{ name = "EMAIL" }]',
    "[env.production]",
    'send_email = [{ name = "EMAIL" }]'
  ].join("\n"), { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return { repositoryRoot, configPath };
}

function fakeSpawn(calls: string[][]) {
  return ((_command: string, args: string[]) => {
    calls.push(args);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", 0, null));
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
}
