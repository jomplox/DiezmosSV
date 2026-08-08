import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const probePath = resolve(repositoryRoot, "scripts/auth-timing-probe.mjs");
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
    prepare?: (fixture: { container: string; taskRoot: string }) => Promise<void>;
  } = {}
) {
  const container = await mkdtemp(join(tmpdir(), "diezmossv-auth-timing-cleanup-test-"));
  const taskRoot = options.taskRootFor?.(container) ?? join(container, "diezmossv-auth-timing-owned");
  await options.prepare?.({ container, taskRoot });
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
      ...extraEnv
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); });
  child.stderr.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); });
  const exit = childExit(child);
  return { child, container, taskRoot, port, exit, output: () => output };
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
