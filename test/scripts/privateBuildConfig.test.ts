import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
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
    "builds %s while injecting only the public campaign into the client environment",
    async (target) => {
      const fixture = deploymentFixture(target);
      const { calls, spawnImpl } = recordingSpawn(0);
      const inheritedEnv = {
        DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath,
        INHERITED_TEST_VALUE: "available-to-build",
        PATH: "/fixture/bin",
        CI: "true",
        NODE_OPTIONS: "--max-old-space-size=2048",
        npm_config_cache: "/fixture/npm-cache",
        HTTP_PROXY: "http://proxy.example.invalid",
        HTTPS_PROXY: "https://proxy.example.invalid",
        NO_PROXY: "localhost,127.0.0.1",
        NODE_EXTRA_CA_CERTS: "/fixture/extra-ca.pem",
        SSL_CERT_FILE: "/fixture/ca-bundle.pem",
        VITE_GIVEBUTTER_CAMPAIGN: "ambient-campaign-override",
        VITE_PRIVATE_SENTINEL: "uppercase-private-canary",
        ViTe_MIXED_SENTINEL: "mixed-case-private-canary"
      };
      const originalEnv = { ...inheritedEnv };
      let capturedStdout = "";
      let capturedStderr = "";
      const stdoutWrite = process.stdout.write;
      const stderrWrite = process.stderr.write;
      process.stdout.write = ((chunk: string | Uint8Array) => {
        capturedStdout += String(chunk);
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        capturedStderr += String(chunk);
        return true;
      }) as typeof process.stderr.write;

      try {
        await expect(
          runPrivateBuild({
            target,
            env: inheritedEnv,
            repositoryRoot: fixture.repositoryRoot,
            spawnImpl,
            platform: "linux"
          })
        ).resolves.toBe(0);
      } finally {
        process.stdout.write = stdoutWrite;
        process.stderr.write = stderrWrite;
      }

      expect(calls).toHaveLength(1);
      const [call] = calls;
      expect(call.command).toBe("npm");
      expect(call.args).toEqual(["run", "build"]);
      expect(call.options.env.VITE_GIVEBUTTER_CAMPAIGN).toBe("campaign-fixture");
      expect(call.options.env.INHERITED_TEST_VALUE).toBe("available-to-build");
      expect(call.options.env.PATH).toBe("/fixture/bin");
      expect(call.options.env.CI).toBe("true");
      expect(call.options.env.NODE_OPTIONS).toBe("--max-old-space-size=2048");
      expect(call.options.env.npm_config_cache).toBe("/fixture/npm-cache");
      expect(call.options.env.HTTP_PROXY).toBe("http://proxy.example.invalid");
      expect(call.options.env.HTTPS_PROXY).toBe("https://proxy.example.invalid");
      expect(call.options.env.NO_PROXY).toBe("localhost,127.0.0.1");
      expect(call.options.env.NODE_EXTRA_CA_CERTS).toBe("/fixture/extra-ca.pem");
      expect(call.options.env.SSL_CERT_FILE).toBe("/fixture/ca-bundle.pem");
      expect({
        uppercase: call.options.env.VITE_PRIVATE_SENTINEL,
        mixedCase: call.options.env.ViTe_MIXED_SENTINEL
      }).toEqual({ uppercase: undefined, mixedCase: undefined });
      expect(call.options.env.DIEZMOSSV_APP_ORIGIN).toBeUndefined();
      expect(call.options.env.DIEZMOSSV_DONOR_LOGO_FILE).toBeUndefined();
      expect(call.options.env.DIEZMOSSV_OPERATOR_EMAIL).toBeUndefined();
      expect(inheritedEnv).toEqual(originalEnv);
      expect({
        stdoutContainsCampaign: capturedStdout.includes("campaign-fixture"),
        stderrContainsCampaign: capturedStderr.includes("campaign-fixture"),
        stdoutEmpty: capturedStdout.length === 0,
        stderrEmpty: capturedStderr.length === 0
      }).toEqual({
        stdoutContainsCampaign: false,
        stderrContainsCampaign: false,
        stdoutEmpty: true,
        stderrEmpty: true
      });
    }
  );

  it("uses an explicit Windows command interpreter with constant npm arguments", async () => {
    const fixture = deploymentFixture("staging");
    const { calls, spawnImpl } = recordingSpawn(0);
    const commandInterpreter = "C:\\Windows Tools\\System32\\cmd.exe";

    await expect(
      runPrivateBuild({
        target: "staging",
        env: {
          DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath,
          ComSpec: commandInterpreter,
          VITE_GIVEBUTTER_CAMPAIGN: "ambient-campaign-override",
          ViTe_WINDOWS_PRIVATE_SENTINEL: "windows-private-canary"
        },
        repositoryRoot: fixture.repositoryRoot,
        spawnImpl,
        platform: "win32"
      })
    ).resolves.toBe(0);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.command).toBe(commandInterpreter);
    expect(call.args).toEqual(["/d", "/c", "npm.cmd", "run", "build"]);
    expect(call.options.shell).not.toBe(true);
    expect(call.options.env.ComSpec).toBe(commandInterpreter);
    expect(call.options.env.VITE_GIVEBUTTER_CAMPAIGN).toBe("campaign-fixture");
    expect(call.options.env.ViTe_WINDOWS_PRIVATE_SENTINEL).toBeUndefined();
    expect({
      argumentsContainCampaign: call.args.some((argument) => argument.includes("campaign-fixture")),
      argumentsContainConfigPath: call.args.some((argument) =>
        argument.includes(fixture.configPath)
      )
    }).toEqual({ argumentsContainCampaign: false, argumentsContainConfigPath: false });
  });

  it("falls back to cmd.exe when Windows ComSpec is unavailable", async () => {
    const fixture = deploymentFixture("production");
    const { calls, spawnImpl } = recordingSpawn(0);

    await expect(
      runPrivateBuild({
        target: "production",
        env: { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath },
        repositoryRoot: fixture.repositoryRoot,
        spawnImpl,
        platform: "win32"
      })
    ).resolves.toBe(0);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "cmd.exe",
      args: ["/d", "/c", "npm.cmd", "run", "build"]
    });
    expect(calls[0].options.shell).not.toBe(true);
  });

  it.each(["staging", "production"] as const)(
    "keeps inherited Vite canaries out of a disposable %s bundle",
    async (target) => {
      const fixture = disposableViteFixture(target);
      const canaryName = "VITE_PRIVATE_BUNDLE_CANARY";
      const canaryValue = "private-bundle-canary-value";

      await expect(
        runPrivateBuild({
          target,
          env: {
            ...process.env,
            DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath,
            VITE_GIVEBUTTER_CAMPAIGN: "ambient-campaign-override",
            [canaryName]: canaryValue
          },
          repositoryRoot: fixture.repositoryRoot
        })
      ).resolves.toBe(0);

      const bundle = readTextTree(join(fixture.repositoryRoot, "dist"));
      expect({
        approvedCampaignPresent: bundle.includes("campaign-fixture"),
        canaryNamePresent: bundle.includes(canaryName),
        canaryValuePresent: bundle.includes(canaryValue)
      }).toEqual({
        approvedCampaignPresent: true,
        canaryNamePresent: false,
        canaryValuePresent: false
      });
    }
  );

  it.each(["linux", "win32"] as const)(
    "returns a non-zero %s build exit status",
    async (platform) => {
      const fixture = deploymentFixture("staging");
      const { spawnImpl } = recordingSpawn(17);

      await expect(
        runPrivateBuild({
          target: "staging",
          env: { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath },
          repositoryRoot: fixture.repositoryRoot,
          spawnImpl,
          platform
        })
      ).resolves.toBe(17);
    }
  );

  it.each(["linux", "win32"] as const)(
    "returns the conventional exit status when the %s build is terminated by a signal",
    async (platform) => {
      const fixture = deploymentFixture("staging");
      const { spawnImpl } = recordingSpawn(null, "SIGTERM");

      await expect(
        runPrivateBuild({
          target: "staging",
          env: { DIEZMOSSV_DEPLOY_CONFIG: fixture.configPath },
          repositoryRoot: fixture.repositoryRoot,
          spawnImpl,
          platform
        })
      ).resolves.toBe(143);
    }
  );
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

function disposableViteFixture(target: "staging" | "production"): Fixture {
  const fixture = deploymentFixture(target);
  mkdirSync(join(fixture.repositoryRoot, "src"));
  symlinkSync(
    join(process.cwd(), "node_modules"),
    join(fixture.repositoryRoot, "node_modules"),
    "dir"
  );
  writeFileSync(
    join(fixture.repositoryRoot, "package.json"),
    JSON.stringify({ private: true, type: "module", scripts: { build: "vite build" } })
  );
  writeFileSync(
    join(fixture.repositoryRoot, "index.html"),
    '<div id="app"></div><script type="module" src="/src/main.js"></script>\n'
  );
  writeFileSync(
    join(fixture.repositoryRoot, "src", "main.js"),
    [
      "globalThis.__PRIVATE_BUILD_ENV__ = {",
      "  campaign: import.meta.env.VITE_GIVEBUTTER_CAMPAIGN,",
      "  snapshot: import.meta.env",
      "};",
      ""
    ].join("\n")
  );
  return fixture;
}

function readTextTree(root: string): string {
  return readdirSync(root, { withFileTypes: true })
    .map((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? readTextTree(path) : readFileSync(path, "utf8");
    })
    .join("\n");
}

function recordingSpawn(exitCode: number | null, signal: NodeJS.Signals | null = null) {
  const calls: Array<{
    command: string;
    args: string[];
    options: {
      env: Record<string, string | undefined>;
      shell?: boolean;
    };
  }> = [];
  const spawnImpl = ((command: string, args: string[], options: {
    env: Record<string, string | undefined>;
    shell?: boolean;
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
