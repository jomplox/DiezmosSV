import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const probePath = resolve(repositoryRoot, "scripts/auth-timing-probe.mjs");
const hostileCanary = "host-only-auth-timing-canary";
const interruptionSignals = process.platform === "win32"
  ? [{ signal: "SIGINT" as const, exitCode: 130 }, { signal: "SIGTERM" as const, exitCode: 143 }]
  : [
      { signal: "SIGHUP" as const, exitCode: 129 },
      { signal: "SIGINT" as const, exitCode: 130 },
      { signal: "SIGTERM" as const, exitCode: 143 }
    ];
const invalidOverrides: Array<{ name: string; env: Record<string, string>; message: string }> = [
  {
    name: "sample count",
    env: { AUTH_TIMING_SAMPLES_PER_CLASS: "10001" },
    message: "AUTH_TIMING_SAMPLES_PER_CLASS must be an integer from 20 through 10000"
  },
  {
    name: "port",
    env: { AUTH_TIMING_PORT: "65536" },
    message: "AUTH_TIMING_PORT must be an integer from 1024 through 65535"
  }
];

describe("auth timing probe cleanup", () => {
  it.each(interruptionSignals)("reaps its exact process tree, listener, and synthetic state after $signal", async ({ signal, exitCode }) => {
    const fixture = await launchProbe();
    let observed = processTree(fixture.child.pid!);
    try {
      await waitForPath(fixture.taskRoot);
      await waitForHealth(fixture);
      observed = processTree(fixture.child.pid!);
      expect(observed.pids.size).toBeGreaterThan(1);

      process.kill(fixture.child.pid!, signal);
      const result = await withTimeout(fixture.exit, 20_000, `probe did not exit after ${signal}`);

      expect(result, fixture.output()).toEqual({ code: exitCode, signal: null });
      await expectReleased(fixture, observed);
    } finally {
      await forceFixtureCleanup(fixture, observed);
    }
  }, 120_000);

  it("leaves no owned resources after a normal real-runtime smoke completion", async () => {
    const fixture = await launchProbe({ AUTH_TIMING_SMOKE_MODE: "normal" });
    let observed = processTree(fixture.child.pid!);
    try {
      await waitForPath(fixture.taskRoot);
      await waitForHealth(fixture);
      observed = processTree(fixture.child.pid!);
      const result = await withTimeout(fixture.exit, 20_000, "normal smoke probe did not exit");

      expect(result, fixture.output()).toEqual({ code: 0, signal: null });
      await expectReleased(fixture, observed);
    } finally {
      await forceFixtureCleanup(fixture, observed);
    }
  }, 120_000);

  it("leaves no owned resources after a controlled real-runtime failure", async () => {
    const fixture = await launchProbe({ AUTH_TIMING_SMOKE_MODE: "failure" });
    let observed = processTree(fixture.child.pid!);
    try {
      await waitForPath(fixture.taskRoot);
      await waitForHealth(fixture);
      observed = processTree(fixture.child.pid!);
      const result = await withTimeout(fixture.exit, 20_000, "failure smoke probe did not exit");

      expect(result, fixture.output()).toEqual({ code: 1, signal: null });
      expect(fixture.output()).toContain("controlled timing-probe smoke failure");
      await expectReleased(fixture, observed);
    } finally {
      await forceFixtureCleanup(fixture, observed);
    }
  }, 120_000);

  it("keeps hostile inherited Wrangler dev-env flags outside the synthetic Worker", async () => {
    const fixture = await launchProbe({
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "true",
      CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
      APP_ENV: "production",
      AUTH_TIMING_HOST_CANARY: hostileCanary,
      CLOUDFLARE_API_TOKEN: hostileCanary,
      CF_API_KEY: hostileCanary,
      CLOUDFLARE_EMAIL: "host-canary@example.invalid",
      CLOUDFLARE_ACCOUNT_ID: hostileCanary,
      WRANGLER_CONFIG_FILENAME: "/host-canary/wrangler.toml",
      DIEZMOSSV_WRANGLER_CONFIG: "/host-canary/private-wrangler.toml",
      DIEZMOSSV_ENV_FILE: "/host-canary/private.env"
    });
    let observed = processTree(fixture.child.pid!);
    try {
      await waitForPath(fixture.taskRoot);
      await waitForHealth(fixture);
      observed = processTree(fixture.child.pid!);

      const generatedConfig = await readFile(join(fixture.taskRoot, "wrangler.toml"), "utf8");
      expect(generatedConfig).toContain('APP_ENV = "local"');
      expect(generatedConfig).not.toContain(hostileCanary);
      const response = await fetch(`http://127.0.0.1:${fixture.port}/api/health`, {
        signal: AbortSignal.timeout(1_000)
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ ok: true, appEnv: "local" });

      const probeSource = await readFile(probePath, "utf8");
      expect({
        explicitAllowlist: probeSource.includes("const childEnvironmentAllowedKeys = ["),
        inheritedEnvironmentSpread: probeSource.includes("{ ...sourceEnvironment }"),
        nodeOptionsAllowlisted: probeSource.includes('"NODE_OPTIONS"'),
        nodePathAllowlisted: probeSource.includes('"NODE_PATH"'),
        dynamicLoaderAllowlisted: ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH"]
          .some((key) => probeSource.includes(`"${key}"`)),
        proxyAllowlisted: ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]
          .some((key) => probeSource.includes(`"${key}"`)),
        cloudflareCredentialAllowlisted: ["CLOUDFLARE_API_TOKEN", "CF_API_KEY"]
          .some((key) => probeSource.includes(`"${key}"`)),
        loadDevVarsForcedFalse: probeSource.includes(
          'CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false"'
        ),
        includeProcessEnvForcedFalse: probeSource.includes(
          'CLOUDFLARE_INCLUDE_PROCESS_ENV: "false"'
        ),
        metricsForcedFalse: probeSource.includes('WRANGLER_SEND_METRICS: "false"'),
        ownedHome: probeSource.includes("HOME: directories.home"),
        ownedTemporaryDirectory: probeSource.includes("TMPDIR: directories.temporary"),
        ownedXdgConfiguration: probeSource.includes("XDG_CONFIG_HOME: directories.xdgConfig")
      }).toEqual({
        explicitAllowlist: true,
        inheritedEnvironmentSpread: false,
        nodeOptionsAllowlisted: false,
        nodePathAllowlisted: false,
        dynamicLoaderAllowlisted: false,
        proxyAllowlisted: false,
        cloudflareCredentialAllowlisted: false,
        loadDevVarsForcedFalse: true,
        includeProcessEnvForcedFalse: true,
        metricsForcedFalse: true,
        ownedHome: true,
        ownedTemporaryDirectory: true,
        ownedXdgConfiguration: true
      });

      process.kill(fixture.child.pid!, "SIGTERM");
      const result = await withTimeout(fixture.exit, 20_000, "hostile-env probe did not exit after SIGTERM");
      expect(result, fixture.output()).toEqual({ code: 143, signal: null });
      await expectReleased(fixture, observed);
    } finally {
      await forceFixtureCleanup(fixture, observed);
    }
  }, 120_000);

  it("does not execute an inherited conditional Node preload in Wrangler children", async () => {
    const remoteTrap = await startLoopbackTrap();
    try {
      let preloadMarker = "";
      const nodePathCanary = "/host-canary/node-path";
      const environmentObservationCanary = "auth-timing-child-environment-audit";
      const fixture = await launchProbe({
        TERM: environmentObservationCanary,
        NODE_PATH: nodePathCanary,
        HOST_ONLY_PRELOAD_CANARY: hostileCanary,
        CLOUDFLARE_API_TOKEN: hostileCanary,
        WRANGLER_CONFIG_FILENAME: "/host-canary/wrangler.toml",
        DIEZMOSSV_ENV_FILE: "/host-canary/private.env",
        LD_PRELOAD: "",
        DYLD_INSERT_LIBRARIES: "",
        HTTPS_PROXY: remoteTrap.origin,
        CLOUDFLARE_API_BASE_URL: remoteTrap.origin
      }, {
        prepare: async ({ container }) => {
          preloadMarker = join(container, "conditional-preload-executed.txt");
          const preloadPath = join(container, "conditional-wrangler-preload.mjs");
          await writeFile(
            preloadPath,
            conditionalWranglerPreload(preloadMarker, remoteTrap.origin),
            { encoding: "utf8", mode: 0o600 }
          );
          return { NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}` };
        }
      });
      let observed = processTree(fixture.child.pid!);
      try {
        await waitForPath(fixture.taskRoot);
        await waitForHealth(fixture);
        observed = processTree(fixture.child.pid!);

        const generatedConfig = await readFile(join(fixture.taskRoot, "wrangler.toml"), "utf8");
        const response = await fetch(`http://127.0.0.1:${fixture.port}/api/health`, {
          signal: AbortSignal.timeout(1_000)
        });
        const health = await response.json() as { ok?: boolean; appEnv?: string };
        expect({
          configLocal: generatedConfig.includes('APP_ENV = "local"'),
          preloadExecutedInWrangler: await pathExists(preloadMarker),
          healthStatus: response.status,
          appEnv: health.appEnv,
          remoteAttempts: remoteTrap.connections()
        }).toEqual({
          configLocal: true,
          preloadExecutedInWrangler: false,
          healthStatus: 200,
          appEnv: "local",
          remoteAttempts: 0
        });

        const canonicalTaskRoot = await realpath(fixture.taskRoot);
        const childEnvironmentRoot = join(canonicalTaskRoot, "child-environment");
        const ownedDirectories = {
          home: join(childEnvironmentRoot, "home"),
          temporary: join(childEnvironmentRoot, "tmp"),
          xdgConfig: join(childEnvironmentRoot, "xdg-config"),
          xdgCache: join(childEnvironmentRoot, "xdg-cache"),
          xdgData: join(childEnvironmentRoot, "xdg-data"),
          xdgState: join(childEnvironmentRoot, "xdg-state")
        };
        expect(await Promise.all(
          [...Object.values(ownedDirectories), join(canonicalTaskRoot, "miniflare-cache")]
            .map(pathExists)
        )).toEqual([true, true, true, true, true, true, true]);

        const environmentAudit = descendantEnvironmentAudit(
          observed,
          fixture.child.pid!,
          {
            nodeOptions: "NODE_OPTIONS=",
            nodePath: `NODE_PATH=${nodePathCanary}`,
            hostCanary: `HOST_ONLY_PRELOAD_CANARY=${hostileCanary}`,
            cloudflareCredential: `CLOUDFLARE_API_TOKEN=${hostileCanary}`,
            wranglerSelector: "WRANGLER_CONFIG_FILENAME=/host-canary/wrangler.toml",
            privateSelector: "DIEZMOSSV_ENV_FILE=/host-canary/private.env",
            linuxDynamicLoader: "LD_PRELOAD=",
            macDynamicLoader: "DYLD_INSERT_LIBRARIES=",
            proxy: `HTTPS_PROXY=${remoteTrap.origin}`,
            cloudflareApiBase: `CLOUDFLARE_API_BASE_URL=${remoteTrap.origin}`
          },
          {
            home: `HOME=${ownedDirectories.home}`,
            temporary: `TMPDIR=${ownedDirectories.temporary}`,
            xdgConfig: `XDG_CONFIG_HOME=${ownedDirectories.xdgConfig}`,
            xdgCache: `XDG_CACHE_HOME=${ownedDirectories.xdgCache}`,
            xdgData: `XDG_DATA_HOME=${ownedDirectories.xdgData}`,
            xdgState: `XDG_STATE_HOME=${ownedDirectories.xdgState}`,
            miniflareCache: `MINIFLARE_CACHE_DIR=${join(canonicalTaskRoot, "miniflare-cache")}`
          },
          `TERM=${environmentObservationCanary}`
        );
        expect(environmentAudit.descendantCount).toBeGreaterThan(0);
        expect(
          environmentAudit.environmentObservedCount === 0
            || environmentAudit.environmentObservedCount === environmentAudit.descendantCount
        ).toBe(true);
        const forbiddenBindingExpectation = environmentAudit.environmentObservedCount > 0
          ? false
          : null;
        expect(environmentAudit.leaks).toEqual({
          nodeOptions: forbiddenBindingExpectation,
          nodePath: forbiddenBindingExpectation,
          hostCanary: forbiddenBindingExpectation,
          cloudflareCredential: forbiddenBindingExpectation,
          wranglerSelector: forbiddenBindingExpectation,
          privateSelector: forbiddenBindingExpectation,
          linuxDynamicLoader: forbiddenBindingExpectation,
          macDynamicLoader: forbiddenBindingExpectation,
          proxy: forbiddenBindingExpectation,
          cloudflareApiBase: forbiddenBindingExpectation
        });
        const ownedBindingExpectation = environmentAudit.environmentObservedCount > 0
          ? true
          : null;
        expect(environmentAudit.requiredBindings).toEqual({
          home: ownedBindingExpectation,
          temporary: ownedBindingExpectation,
          xdgConfig: ownedBindingExpectation,
          xdgCache: ownedBindingExpectation,
          xdgData: ownedBindingExpectation,
          xdgState: ownedBindingExpectation,
          miniflareCache: ownedBindingExpectation
        });

        process.kill(fixture.child.pid!, "SIGTERM");
        const result = await withTimeout(
          fixture.exit,
          20_000,
          "conditional-preload probe did not exit after SIGTERM"
        );
        expect(result, fixture.output()).toEqual({ code: 143, signal: null });
        await expectReleased(fixture, observed);
      } finally {
        await forceFixtureCleanup(fixture, observed);
      }
    } finally {
      await remoteTrap.close();
      expect(await canConnect(remoteTrap.port)).toBe(false);
    }
  }, 120_000);

  it("refuses to adopt or remove an existing unowned task root", async () => {
    const sentinel = "unowned timing fixture";
    const fixture = await launchProbe({}, {
      prepare: async ({ taskRoot }) => {
        await mkdir(taskRoot, { mode: 0o700 });
        await writeFile(join(taskRoot, "sentinel.txt"), sentinel, "utf8");
      }
    });
    const observed = processTree(fixture.child.pid!);
    try {
      const result = await withTimeout(fixture.exit, 10_000, "unowned-root probe did not exit");

      expect(result, fixture.output()).toEqual({ code: 1, signal: null });
      expect(await readFile(join(fixture.taskRoot, "sentinel.txt"), "utf8")).toBe(sentinel);
      expect(await canConnect(fixture.port)).toBe(false);
    } finally {
      await forceFixtureCleanup(fixture, observed);
    }
  }, 30_000);

  it("refuses a prefixed task root outside the process temporary directory", async () => {
    const fixture = await launchProbe({}, {
      taskRootFor: (container) => resolve(
        container,
        "..",
        `diezmossv-auth-timing-unsafe-${randomUUID()}`
      )
    });
    const observed = processTree(fixture.child.pid!);
    try {
      const result = await withTimeout(fixture.exit, 10_000, "unsafe-root probe did not exit");

      expect(result, fixture.output()).toEqual({ code: 1, signal: null });
      expect(fixture.output()).toContain("strictly inside the process temporary directory");
      await expect(access(fixture.taskRoot)).rejects.toThrow();
      expect(await canConnect(fixture.port)).toBe(false);
    } finally {
      await forceFixtureCleanup(fixture, observed);
      await rm(fixture.taskRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it.each(invalidOverrides)("rejects an out-of-range $name override before creating resources", async ({ env, message }) => {
    const fixture = await launchProbe(env);
    const observed = processTree(fixture.child.pid!);
    try {
      const result = await withTimeout(fixture.exit, 10_000, "invalid-option probe did not exit");

      expect(result, fixture.output()).toEqual({ code: 1, signal: null });
      expect(fixture.output()).toContain(message);
      await expect(access(fixture.taskRoot)).rejects.toThrow();
      expect(await canConnect(fixture.port)).toBe(false);
    } finally {
      await forceFixtureCleanup(fixture, observed);
    }
  }, 30_000);
});

async function launchProbe(
  extraEnv: Record<string, string> = {},
  options: {
    taskRootFor?: (container: string) => string;
    prepare?: (
      fixture: { container: string; taskRoot: string }
    ) => Promise<Record<string, string> | void>;
  } = {}
) {
  const container = await mkdtemp(join(tmpdir(), "diezmossv-auth-timing-cleanup-test-"));
  const taskRoot = options.taskRootFor?.(container) ?? join(container, "diezmossv-auth-timing-owned");
  const preparedEnvironment = await options.prepare?.({ container, taskRoot });
  const port = await availablePort();
  let output = "";
  const child = spawn(process.execPath, [probePath], {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      TMPDIR: container,
      AUTH_TIMING_TASK_ROOT: taskRoot,
      AUTH_TIMING_PORT: String(port),
      AUTH_TIMING_WARMUPS_PER_CLASS: "1",
      AUTH_TIMING_SAMPLES_PER_CLASS: "20",
      AUTH_TIMING_SUCCESS_SAMPLES_PER_CLASS: "20",
      AUTH_TIMING_RESET_EVERY_ROUNDS: "20",
      ...extraEnv,
      ...preparedEnvironment
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); });
  child.stderr.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); });
  const exit = childExit(child);
  return { child, container, taskRoot, port, exit, output: () => output };
}

function conditionalWranglerPreload(markerPath: string, remoteOrigin: string) {
  return `import { appendFileSync } from "node:fs";
if (process.argv.some((value) => value.includes("wrangler"))) {
  appendFileSync(${JSON.stringify(markerPath)}, "wrangler child preload executed\\n", { mode: 0o600 });
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "true";
  process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = "true";
  process.env.APP_ENV = "production";
  process.env.AUTH_TIMING_PRELOAD_CANARY = ${JSON.stringify(hostileCanary)};
  process.env.CLOUDFLARE_API_BASE_URL = ${JSON.stringify(remoteOrigin)};
  process.env.CF_API_BASE_URL = ${JSON.stringify(remoteOrigin)};
  process.env.HTTPS_PROXY = ${JSON.stringify(remoteOrigin)};
}
`;
}

async function pathExists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function descendantEnvironmentAudit(
  observed: ReturnType<typeof processTree>,
  rootPid: number,
  forbiddenNeedles: Record<string, string>,
  requiredNeedles: Record<string, string>,
  observationNeedle: string
) {
  const environments = [...observed.pids]
    .filter((pid) => pid !== rootPid)
    .map((pid) => {
      try {
        const argumentsForPs = process.platform === "darwin"
          ? ["-E", "-ww", "-p", String(pid)]
          : ["eww", "-p", String(pid), "-o", "command="];
        return execFileSync("/bin/ps", argumentsForPs, { encoding: "utf8" });
      } catch {
        return null;
      }
    })
    .filter((value): value is string => value !== null);
  const observedEnvironments = environments.filter((environment) =>
    environment.includes(observationNeedle)
  );
  return {
    descendantCount: environments.length,
    environmentObservedCount: observedEnvironments.length,
    leaks: Object.fromEntries(
      Object.entries(forbiddenNeedles).map(([name, needle]) => [
        name,
        observedEnvironments.length > 0
          ? observedEnvironments.some((environment) => environment.includes(needle))
          : null
      ])
    ),
    requiredBindings: Object.fromEntries(
      Object.entries(requiredNeedles).map(([name, needle]) => [
        name,
        observedEnvironments.length > 0
          ? observedEnvironments.every((environment) => environment.includes(needle))
          : null
      ])
    )
  };
}

async function startLoopbackTrap() {
  let connectionCount = 0;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    connectionCount += 1;
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.end([
      "HTTP/1.1 502 Bad Gateway",
      "Connection: close",
      "Content-Length: 0",
      "",
      ""
    ].join("\r\n"));
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  if (port === null) throw new Error("unable to allocate loopback remote-attempt trap");
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    connections: () => connectionCount,
    close: () => new Promise<void>((resolveClose, rejectClose) => {
      for (const socket of sockets) socket.destroy();
      if (!server.listening) {
        resolveClose();
        return;
      }
      server.close((error) => error ? rejectClose(error) : resolveClose());
    })
  };
}

async function expectReleased(
  fixture: Awaited<ReturnType<typeof launchProbe>>,
  observed: ReturnType<typeof processTree>
) {
  await expect(access(fixture.taskRoot)).rejects.toThrow();
  expect(await canConnect(fixture.port)).toBe(false);
  expect([...observed.pids].filter(isProcessAlive)).toEqual([]);
  expect([...observed.groups].filter(isProcessGroupAlive)).toEqual([]);
}

async function forceFixtureCleanup(
  fixture: Awaited<ReturnType<typeof launchProbe>>,
  observed: ReturnType<typeof processTree>
) {
  const groups = new Set(observed.groups);
  if (fixture.child.pid) {
    const current = processTree(fixture.child.pid);
    for (const group of current.groups) groups.add(group);
    groups.add(fixture.child.pid);
  }
  if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
    fixture.child.kill("SIGTERM");
    await withTimeout(fixture.exit, 15_000, "fixture graceful cleanup timed out").catch(() => undefined);
  }
  if (fixture.child.pid) {
    const current = processTree(fixture.child.pid);
    for (const group of current.groups) groups.add(group);
    groups.add(fixture.child.pid);
  }
  for (const group of groups) signalProcessGroup(group, "SIGKILL");
  if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
    fixture.child.kill("SIGKILL");
  }
  await withTimeout(fixture.exit, 2_000, "fixture cleanup timed out").catch(() => undefined);
  await rm(fixture.container, { recursive: true, force: true });
}

function processTree(rootPid: number) {
  const rows = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8" })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid, group]) => Number.isInteger(pid) && Number.isInteger(ppid) && Number.isInteger(group))
    .map(([pid, ppid, group]) => ({ pid, ppid, group }));
  const pids = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (pids.has(row.ppid) && !pids.has(row.pid)) {
        pids.add(row.pid);
        changed = true;
      }
    }
  }
  const groups = new Set(rows.filter((row) => pids.has(row.pid)).map((row) => row.group));
  return { pids, groups };
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function isProcessGroupAlive(group: number) {
  if (process.platform === "win32") return false;
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalProcessGroup(group: number, signal: NodeJS.Signals) {
  if (process.platform === "win32") return;
  try {
    process.kill(-group, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

async function waitForPath(path: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`probe did not create its configured task root: ${path}`);
}

async function waitForHealth(fixture: Awaited<ReturnType<typeof launchProbe>>) {
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    if (fixture.child.exitCode !== null || fixture.child.signalCode !== null) {
      throw new Error(`probe exited before listening on port ${fixture.port}: ${fixture.output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${fixture.port}/api/health`, {
        signal: AbortSignal.timeout(500)
      });
      if (response.ok) return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`probe did not listen on its configured port ${fixture.port}: ${fixture.output()}`);
}

async function canConnect(port: number) {
  return new Promise<boolean>((resolveConnection) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (connected: boolean) => {
      socket.destroy();
      resolveConnection(connected);
    };
    socket.setTimeout(500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  if (port === null) throw new Error("unable to allocate cleanup-test port");
  return port;
}

function childExit(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      }
    );
  });
}
