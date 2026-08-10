import { EventEmitter } from "node:events";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runPrivateBuild } from "../../scripts/run-private-build.mjs";
import { pngBytes as generatePngBytes } from "../worker/support/rasterFixtures";

const pngBytes = Buffer.from(generatePngBytes(2, 2, { red: 20, green: 60, blue: 200 }));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("private release builds", () => {
  it.each(["staging", "production"] as const)(
    "builds %s with only the configured campaign added to the child environment",
    async (target) => {
      const fixture = deploymentFixture(target);
      const { calls, spawnImpl } = recordingSpawn(0);
      let capturedOutput = "";
      const write = process.stdout.write;
      process.stdout.write = ((chunk: string | Uint8Array) => {
        capturedOutput += String(chunk);
        return true;
      }) as typeof process.stdout.write;

      try {
        await expect(
          runPrivateBuild({
            target,
            env: {
              DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath,
              INHERITED_TEST_VALUE: "available-to-build"
            },
            repositoryRoot: fixture.repositoryRoot,
            spawnImpl
          })
        ).resolves.toBe(0);
      } finally {
        process.stdout.write = write;
      }

      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call.command).toBe(process.platform === "win32" ? "npm.cmd" : "npm");
      expect(call.args).toEqual(["run", "build"]);
      expect(call.options.env.VITE_GIVEBUTTER_CAMPAIGN).toBe("campaign-fixture");
      expect(call.options.env.INHERITED_TEST_VALUE).toBe("available-to-build");
      expect(call.options.env.DIEZMOSSV_APP_ORIGIN).toBeUndefined();
      expect(call.options.env.DIEZMOSSV_DONOR_LOGO_FILE).toBeUndefined();
      expect(call.options.env.DIEZMOSSV_OPERATOR_EMAIL).toBeUndefined();
      expect(capturedOutput).not.toContain("campaign-fixture");
    }
  );

  it("returns a non-zero build exit status", async () => {
    const fixture = deploymentFixture("staging");
    const { spawnImpl } = recordingSpawn(17);

    await expect(
      runPrivateBuild({
        target: "staging",
        env: { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath },
        repositoryRoot: fixture.repositoryRoot,
        spawnImpl
      })
    ).resolves.toBe(17);
  });

  it("returns the conventional exit status when the build is terminated by a signal", async () => {
    const fixture = deploymentFixture("staging");
    const { spawnImpl } = recordingSpawn(null, "SIGTERM");

    await expect(
      runPrivateBuild({
        target: "staging",
        env: { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath },
        repositoryRoot: fixture.repositoryRoot,
        spawnImpl
      })
    ).resolves.toBe(143);
  });
});

interface Fixture {
  repositoryRoot: string;
  configPath: string;
}

function deploymentFixture(target: "staging" | "production"): Fixture {
  const repositoryRoot = temporaryRoot("diezmos-private-build-repository-");
  const privateRoot = temporaryRoot("diezmos-private-build-config-");
  mkdirSync(join(repositoryRoot, "scripts"));
  const logoPath = join(privateRoot, "logo.png");
  writeFileSync(logoPath, pngBytes, { mode: 0o600 });
  chmodSync(logoPath, 0o600);
  const configPath = join(privateRoot, `${target}.env`);
  writeFileSync(
    configPath,
    [
      `DIEZMOSSV_DEPLOY_TARGET=${target}`,
      "VITE_GIVEBUTTER_CAMPAIGN=campaign-fixture",
      `DIEZMOSSV_APP_ORIGIN=https://${target}.example.invalid`,
      `DIEZMOSSV_DONOR_LOGO_FILE=${logoPath}`,
      ""
    ].join("\n"),
    { mode: 0o600 }
  );
  chmodSync(configPath, 0o600);
  return { repositoryRoot, configPath };
}

function recordingSpawn(exitCode: number | null, signal: NodeJS.Signals | null = null) {
  const calls: Array<{
    command: string;
    args: string[];
    options: { env: Record<string, string | undefined> };
  }> = [];
  const spawnImpl = ((command: string, args: string[], options: {
    env: Record<string, string | undefined>;
  }) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", exitCode, signal));
    return child;
  }) as unknown as typeof import("node:child_process").spawn;
  return { calls, spawnImpl };
}

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}
