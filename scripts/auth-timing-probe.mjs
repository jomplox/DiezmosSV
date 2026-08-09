import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const repositoryRoot = process.cwd();
const wrangler = resolve(repositoryRoot, "node_modules/.bin/wrangler");
const workerMain = resolve(repositoryRoot, "src/worker/index.ts");
const authImplementation = resolve(repositoryRoot, "src/worker/services/auth.ts");
const migrationsDirectory = resolve(repositoryRoot, "migrations");
const databaseName = "diezmossv-auth-timing-db";
const taskRootPrefix = "diezmossv-auth-timing-";
const taskRootMarkerName = ".diezmossv-auth-timing-owner";
const taskRootOwnershipToken = `diezmossv-auth-timing:${process.pid}:${randomUUID()}`;
const childEnvironmentAllowedKeys = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_COLLATE",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_MONETARY",
  "LC_NUMERIC",
  "LC_TIME",
  "TERM",
  "COLORTERM",
  "SHELL",
  "TZ"
];
const windowsChildEnvironmentAllowedKeys = ["SystemRoot", "ComSpec", "PATHEXT"];
const warmupsPerClass = numberOption("AUTH_TIMING_WARMUPS_PER_CLASS", 50, 1, 1_000);
const samplesPerClass = numberOption("AUTH_TIMING_SAMPLES_PER_CLASS", 500, 20, 10_000);
// Successful requests are observational only; the invalid-class equivalence gate below
// retains the required 500 samples per class by default.
const successSamplesPerClass = numberOption("AUTH_TIMING_SUCCESS_SAMPLES_PER_CLASS", 100, 20, 10_000);
const resetEveryRounds = numberOption("AUTH_TIMING_RESET_EVERY_ROUNDS", 10, 1, 10_000);
const commandTimeoutMs = numberOption("AUTH_TIMING_COMMAND_TIMEOUT_MS", 120_000, 1_000, 600_000);
const requestTimeoutMs = numberOption("AUTH_TIMING_REQUEST_TIMEOUT_MS", 10_000, 250, 60_000);
const cleanupGraceMs = numberOption("AUTH_TIMING_CLEANUP_GRACE_MS", 5_000, 250, 30_000);
const smokeMode = smokeModeOption();
const knownPassword = "Known#Password2026";
const wrongPassword = "Wrong#Password2026";
const knownSalt = "known-salt";
// The stored-credential format and its work factor are deliberately not restated in
// this script. They are read from the implementation at runtime so this file carries
// no copy that can drift from the application or outlive it.
const storedFormat = await loadStoredPasswordFormat();
const knownFirst = await derivedDigest(knownPassword, knownSalt);
const knownSecond = await derivedDigest(knownFirst, `${knownSalt}${storedFormat.chainSaltSuffix}`);
const currentStoredHash = storedFormat.format(storedFormat.chainScheme, knownSecond);
const legacyStoredHash = storedFormat.format(storedFormat.legacyScheme, knownFirst);

const invalidClasses = [
  { name: "missing", storedHash: null, disabled: false },
  { name: "disabled", storedHash: currentStoredHash, disabled: true },
  { name: "current", storedHash: currentStoredHash, disabled: false },
  { name: "versioned-legacy", storedHash: legacyStoredHash, disabled: false },
  { name: "countless-legacy", storedHash: knownFirst, disabled: false }
];
const successClasses = [
  { name: "current-success", storedHash: currentStoredHash },
  { name: "legacy-upgrade-success", storedHash: legacyStoredHash }
];

const activityAbort = new AbortController();
const ownedProcesses = new Set();
let port;
let origin;
let taskRoot;
let persistDir;
let miniflareCacheDir;
let configFile;
let seedFile;
let resetFile;
let cleanupPromise;
let workerRecord;
let workerOutput = "";
let interruptedSignal;
let resolveInterrupt;
const interrupt = new Promise((resolveSignal) => { resolveInterrupt = resolveSignal; });
process.exitCode = await main();

async function main() {
  const signalHandlers = installSignalHandlers();
  let exitCode = 0;
  let work;
  try {
    port = await configuredOrAvailablePort();
    origin = `http://127.0.0.1:${port}`;
    taskRoot = await createTaskRoot();
    persistDir = join(taskRoot, "d1");
    miniflareCacheDir = join(taskRoot, "miniflare-cache");
    configFile = join(taskRoot, "wrangler.toml");
    seedFile = join(taskRoot, "seed.sql");
    resetFile = join(taskRoot, "reset.sql");

    work = runProbe().then(
      (result) => ({ kind: "success", result }),
      (error) => ({ kind: "failure", error })
    );
    const outcome = await Promise.race([work, interrupt]);
    if (outcome.kind === "interrupt") {
      exitCode = signalExitCode(outcome.signal);
    } else if (outcome.kind === "success") {
      console.log(JSON.stringify(outcome.result, null, 2));
      if (!outcome.result.pass) exitCode = 1;
    } else {
      console.error(errorMessage(outcome.error));
      if (workerOutput.trim()) console.error(workerOutput.trim());
      exitCode = 1;
    }
  } catch (error) {
    console.error(errorMessage(error));
    exitCode = 1;
  }

  if (taskRoot) {
    try {
      await cleanup();
    } catch (error) {
      console.error(errorMessage(error));
      exitCode = 1;
    }
  }
  if (interruptedSignal && work) {
    await withBoundedTimeout(work, cleanupGraceMs, () => null);
    if (exitCode === 0) exitCode = signalExitCode(interruptedSignal);
  }
  removeSignalHandlers(signalHandlers);
  return exitCode;
}

async function runProbe() {
  assertNotInterrupted();
  await Promise.all([access(wrangler), access(workerMain), access(migrationsDirectory)]);
  const childDirectories = syntheticChildDirectories(taskRoot);
  await Promise.all([
    mkdir(persistDir, { recursive: true, mode: 0o700 }),
    mkdir(miniflareCacheDir, { recursive: true, mode: 0o700 }),
    ...Object.values(childDirectories).map((directory) =>
      mkdir(directory, { recursive: true, mode: 0o700 })
    )
  ]);
  await writeFile(configFile, syntheticWranglerConfig(), { mode: 0o600 });

  const commandEnv = syntheticWranglerEnvironment(
    process.env,
    childDirectories,
    miniflareCacheDir
  );
  await runCommand(wrangler, [
    "d1", "migrations", "apply", databaseName,
    "--config", configFile,
    "--local",
    "--persist-to", persistDir
  ], commandEnv, "D1 migration apply");

  await writeFile(seedFile, syntheticSeedSql(), { mode: 0o600 });
  await writeFile(
    resetFile,
    "DELETE FROM sessions;\nDELETE FROM login_rate_limits;\nDELETE FROM audit_logs WHERE action IN ('LOGIN', 'LOGIN_FAILED');\n",
    { mode: 0o600 }
  );
  await runCommand(wrangler, [
    "d1", "execute", databaseName,
    "--config", configFile,
    "--local",
    "--persist-to", persistDir,
    "--file", seedFile
  ], commandEnv, "synthetic D1 seed");

  assertNotInterrupted();
  workerRecord = spawnOwned(wrangler, [
    "dev",
    "--config", configFile,
    "--local",
    "--port", String(port),
    "--ip", "127.0.0.1",
    "--persist-to", persistDir
  ], commandEnv, "local Wrangler/workerd");
  workerRecord.child.stdout.on("data", (chunk) => appendWorkerOutput(chunk));
  workerRecord.child.stderr.on("data", (chunk) => appendWorkerOutput(chunk));
  await waitForWorker();

  if (smokeMode === "normal" || smokeMode === "failure") {
    // Keep the real listener observable long enough for the cleanup regression to
    // sample its exact descendants, then exercise one real failed login.
    await abortableDelay(750);
    const response = await login(
      "smoke-missing@auth-timing.invalid",
      wrongPassword,
      "198.18.0.1"
    );
    if (response.status !== 401) {
      throw new Error(`normal smoke request returned ${response.status}, expected 401`);
    }
    if (smokeMode === "failure") {
      throw new Error("controlled timing-probe smoke failure");
    }
    return {
      runtime: "external local wrangler dev/workerd with isolated synthetic D1",
      smoke: "normal-cleanup",
      pass: true,
      scope: "Synthetic local-runtime cleanup smoke only."
    };
  }

  await runInvalidRounds("warmup", warmupsPerClass, false, commandEnv);
  await resetSyntheticState(commandEnv);
  const invalidSamples = await runInvalidRounds("sample", samplesPerClass, true, commandEnv);
  await resetSyntheticState(commandEnv);
  const successSamples = await runSuccessRounds(successSamplesPerClass, commandEnv);

  const invalidStats = Object.fromEntries(
    invalidClasses.map(({ name }) => [name, distribution(invalidSamples.get(name) ?? [])])
  );
  const successStats = Object.fromEntries(
    successClasses.map(({ name }) => [name, distribution(successSamples.get(name) ?? [])])
  );
  const missing = invalidStats.missing;
  const medianLimitMs = Math.max(3, missing.medianMs * 0.10);
  const p95LimitMs = Math.max(5, missing.p95Ms * 0.15);
  const comparisons = Object.fromEntries(
    invalidClasses
      .filter(({ name }) => name !== "missing")
      .map(({ name }) => {
        const stats = invalidStats[name];
        const medianDeltaMs = Math.abs(stats.medianMs - missing.medianMs);
        const p95DeltaMs = Math.abs(stats.p95Ms - missing.p95Ms);
        return [name, {
          medianDeltaMs,
          p95DeltaMs,
          medianPass: medianDeltaMs <= medianLimitMs,
          p95Pass: p95DeltaMs <= p95LimitMs
        }];
      })
  );
  const pass = Object.values(comparisons).every((value) => value.medianPass && value.p95Pass);

  return {
    runtime: "external local wrangler dev/workerd with isolated synthetic D1",
    warmupsPerInvalidClass: warmupsPerClass,
    samplesPerInvalidClass: samplesPerClass,
    samplesPerSuccessClass: successSamplesPerClass,
    invalidStats,
    successStats,
    thresholds: { medianLimitMs, p95LimitMs },
    comparisons,
    pass,
    scope: "Relative local timing only; Cloudflare PBKDF2/CPU acceptance requires the release-stage remote probe."
  };
}

async function runInvalidRounds(phase, rounds, collect, commandEnv) {
  const samples = new Map(invalidClasses.map(({ name }) => [name, []]));
  const random = seededRandom(phase === "warmup" ? 0x31_48_15_92 : 0x27_18_28_18);
  for (let round = 0; round < rounds; round += 1) {
    assertNotInterrupted();
    for (const entry of shuffled(invalidClasses, random)) {
      const email = `${entry.name}-${phase}-${round}@auth-timing.invalid`;
      const started = performance.now();
      const response = await login(email, wrongPassword, syntheticIp(phase, round, entry.name));
      const elapsed = performance.now() - started;
      if (response.status !== 401) {
        throw new Error(`${entry.name} ${phase} request returned ${response.status}, expected 401`);
      }
      if (collect) samples.get(entry.name).push(elapsed);
    }
    if ((round + 1) % resetEveryRounds === 0) {
      await resetSyntheticState(commandEnv);
    }
  }
  return samples;
}

async function runSuccessRounds(rounds, commandEnv) {
  const samples = new Map(successClasses.map(({ name }) => [name, []]));
  const random = seededRandom(0x16_18_03_39);
  for (let round = 0; round < rounds; round += 1) {
    assertNotInterrupted();
    for (const entry of shuffled(successClasses, random)) {
      const email = `${entry.name}-sample-${round}@auth-timing.invalid`;
      const started = performance.now();
      const response = await login(email, knownPassword, syntheticIp("success", round, entry.name));
      const elapsed = performance.now() - started;
      if (response.status !== 200) {
        throw new Error(`${entry.name} request returned ${response.status}, expected 200`);
      }
      samples.get(entry.name).push(elapsed);
    }
    if ((round + 1) % resetEveryRounds === 0) {
      await resetSyntheticState(commandEnv);
    }
  }
  return samples;
}

async function login(email, password, ip) {
  return request(`${origin}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip
    },
    body: JSON.stringify({ email, password })
  });
}

async function request(url, init = {}, timeoutMs = requestTimeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([activityAbort.signal, timeoutSignal]);
  const response = await fetch(url, { ...init, signal });
  const body = await response.text();
  return { status: response.status, ok: response.ok, body };
}

async function resetSyntheticState(commandEnv) {
  await runCommand(wrangler, [
    "d1", "execute", databaseName,
    "--config", configFile,
    "--local",
    "--persist-to", persistDir,
    "--file", resetFile
  ], commandEnv, "synthetic state reset");
}

function syntheticSeedSql() {
  const rows = [];
  for (const phase of [
    { name: "warmup", rounds: warmupsPerClass },
    { name: "sample", rounds: samplesPerClass }
  ]) {
    for (let round = 0; round < phase.rounds; round += 1) {
      for (const entry of invalidClasses) {
        if (entry.storedHash === null) continue;
        rows.push(userInsert(
          `${entry.name}-${phase.name}-${round}`,
          `${entry.name}-${phase.name}-${round}@auth-timing.invalid`,
          entry.storedHash,
          entry.disabled
        ));
      }
    }
  }
  for (let round = 0; round < successSamplesPerClass; round += 1) {
    for (const entry of successClasses) {
      rows.push(userInsert(
        `${entry.name}-sample-${round}`,
        `${entry.name}-sample-${round}@auth-timing.invalid`,
        entry.storedHash,
        false
      ));
    }
  }
  return `${rows.join("\n")}\n`;
}

function userInsert(id, email, storedHash, disabled) {
  const disabledAt = disabled ? "'2026-08-08T00:00:00.000Z'" : "NULL";
  return `INSERT INTO users (id, email, name, role, password_hash, password_salt, disabled_at) VALUES ('${id}', '${email}', 'Synthetic timing account', 'VIEWER', '${storedHash}', '${knownSalt}', ${disabledAt});`;
}

function syntheticWranglerConfig() {
  return [
    'name = "diezmossv-auth-timing-local"',
    `main = ${JSON.stringify(workerMain)}`,
    'compatibility_date = "2026-06-02"',
    'compatibility_flags = ["nodejs_compat"]',
    "",
    "[vars]",
    'APP_ENV = "local"',
    `APP_ORIGIN = ${JSON.stringify(origin)}`,
    'MOCK_EXTERNAL_SERVICES = "true"',
    "",
    "[[d1_databases]]",
    'binding = "DB"',
    `database_name = ${JSON.stringify(databaseName)}`,
    'database_id = "00000000-0000-0000-0000-000000000000"',
    `migrations_dir = ${JSON.stringify(migrationsDirectory)}`,
    ""
  ].join("\n");
}

function syntheticChildDirectories(root) {
  const environmentRoot = join(root, "child-environment");
  return {
    home: join(environmentRoot, "home"),
    temporary: join(environmentRoot, "tmp"),
    xdgConfig: join(environmentRoot, "xdg-config"),
    xdgCache: join(environmentRoot, "xdg-cache"),
    xdgData: join(environmentRoot, "xdg-data"),
    xdgState: join(environmentRoot, "xdg-state")
  };
}

function syntheticWranglerEnvironment(sourceEnvironment, directories, cacheDirectory) {
  const environment = {};
  const allowedKeys = process.platform === "win32"
    ? [...childEnvironmentAllowedKeys, ...windowsChildEnvironmentAllowedKeys]
    : childEnvironmentAllowedKeys;
  for (const key of allowedKeys) {
    const value = sourceEnvironment[key];
    if (typeof value === "string" && value !== "") {
      environment[key] = value;
    }
  }
  if (!environment.PATH) {
    throw new Error("The auth timing probe requires PATH for the local Node/Wrangler toolchain");
  }
  return {
    ...environment,
    HOME: directories.home,
    USERPROFILE: directories.home,
    TMPDIR: directories.temporary,
    TMP: directories.temporary,
    TEMP: directories.temporary,
    XDG_CONFIG_HOME: directories.xdgConfig,
    XDG_CACHE_HOME: directories.xdgCache,
    XDG_DATA_HOME: directories.xdgData,
    XDG_STATE_HOME: directories.xdgState,
    ...(process.platform === "win32" ? {
      APPDATA: directories.xdgConfig,
      LOCALAPPDATA: directories.xdgData
    } : {}),
    MINIFLARE_CACHE_DIR: cacheDirectory,
    WRANGLER_SEND_METRICS: "false",
    WRANGLER_SEND_ERROR_REPORTS: "false",
    CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "false",
    NO_COLOR: "1"
  };
}

function distribution(values) {
  if (values.length === 0) throw new Error("Timing distribution is empty");
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    medianMs: quantile(sorted, 0.5),
    p95Ms: quantile(sorted, 0.95)
  };
}

function quantile(sorted, fraction) {
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

function shuffled(values, random) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const selected = Math.floor(random() * (index + 1));
    [copy[index], copy[selected]] = [copy[selected], copy[index]];
  }
  return copy;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function syntheticIp(phase, round, className) {
  const phaseOffset = phase === "warmup" ? 0 : phase === "sample" ? 10_000 : 20_000;
  const classOffset = [...invalidClasses, ...successClasses].findIndex((entry) => entry.name === className);
  const ordinal = phaseOffset + round * 8 + classOffset + 1;
  const third = Math.floor(ordinal / 254);
  return `198.${18 + Math.floor(third / 256)}.${third % 256}.${(ordinal % 254) + 1}`;
}

async function waitForWorker() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    assertNotInterrupted();
    if (workerRecord.child.exitCode !== null || workerRecord.child.signalCode !== null) {
      throw new Error(`Local Worker exited before becoming ready (${exitLabel(await workerRecord.exit)})`);
    }
    try {
      const response = await request(`${origin}/api/health`, {}, Math.min(1_000, requestTimeoutMs));
      if (response.ok) return;
    } catch (error) {
      if (activityAbort.signal.aborted) throw error;
    }
    await abortableDelay(250);
  }
  throw new Error("Timed out waiting for the local Worker timing target");
}

async function runCommand(command, args, env, label) {
  assertNotInterrupted();
  const record = spawnOwned(command, args, env, label);
  let output = "";
  record.child.stdout.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); });
  record.child.stderr.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); });
  const result = await withBoundedTimeout(
    record.exit,
    commandTimeoutMs,
    () => ({ timedOut: true })
  );
  if (result.timedOut) {
    await terminateOwned(record);
    ownedProcesses.delete(record);
    throw new Error(`${label} timed out after ${commandTimeoutMs} ms`);
  }
  if (result.error) {
    ownedProcesses.delete(record);
    throw new Error(`${label} failed to start: ${result.error.message}`);
  }
  if (result.code !== 0) {
    await ensureOwnedGroupGone(record);
    ownedProcesses.delete(record);
    throw new Error(`${label} failed (${exitLabel(result)})\n${output.trim()}`);
  }
  await ensureOwnedGroupGone(record);
  ownedProcesses.delete(record);
}

function spawnOwned(command, args, env, label) {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    detached: process.platform !== "win32",
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let settled = false;
  const exit = new Promise((resolveExit) => {
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      resolveExit({ code: null, signal: null, error });
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      resolveExit({ code, signal, error: null });
    });
  });
  const record = { child, exit, label, pid: child.pid ?? null };
  ownedProcesses.add(record);
  return record;
}

async function ensureOwnedGroupGone(record) {
  if (await waitUntilOwnedGone(record, 1_000)) return;
  await terminateOwned(record);
  throw new Error(`${record.label} left a descendant process after its wrapper exited`);
}

async function terminateOwned(record) {
  if (!ownedProcessAlive(record)) return;
  signalOwned(record, "SIGTERM");
  if (await waitUntilOwnedGone(record, cleanupGraceMs)) return;
  signalOwned(record, "SIGKILL");
  if (await waitUntilOwnedGone(record, cleanupGraceMs)) return;
  throw new Error(`Unable to reap the owned ${record.label} process group`);
}

async function waitUntilOwnedGone(record, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!ownedProcessAlive(record)) return true;
    await delay(50);
  }
  return !ownedProcessAlive(record);
}

function ownedProcessAlive(record) {
  if (record.pid === null) return false;
  if (process.platform === "win32") {
    return record.child.exitCode === null && record.child.signalCode === null;
  }
  try {
    process.kill(-record.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function signalOwned(record, signal) {
  if (record.pid === null) return;
  try {
    if (process.platform === "win32") record.child.kill(signal);
    else process.kill(-record.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    if (!activityAbort.signal.aborted) {
      activityAbort.abort(new Error("Auth timing probe cleanup"));
    }
    const records = [...ownedProcesses];
    const results = await Promise.allSettled(records.map((record) => terminateOwned(record)));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      throw new Error(`Auth timing cleanup could not reap ${failures.length} owned process group(s)`);
    }
    ownedProcesses.clear();
    await assertOwnedTaskRoot(taskRoot);
    await rm(taskRoot, { recursive: true, force: true });
  })();
  return cleanupPromise;
}

function installSignalHandlers() {
  const handlers = new Map();
  for (const signal of process.platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGHUP", "SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (interruptedSignal) return;
      interruptedSignal = signal;
      if (!activityAbort.signal.aborted) {
        activityAbort.abort(new Error(`Auth timing probe interrupted by ${signal}`));
      }
      resolveInterrupt({ kind: "interrupt", signal });
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  return handlers;
}

function removeSignalHandlers(handlers) {
  for (const [signal, handler] of handlers) process.off(signal, handler);
}

function appendWorkerOutput(chunk) {
  workerOutput = `${workerOutput}${String(chunk)}`.slice(-8_000);
}

function assertNotInterrupted() {
  if (activityAbort.signal.aborted) {
    throw activityAbort.signal.reason instanceof Error
      ? activityAbort.signal.reason
      : new Error("Auth timing probe interrupted");
  }
}

async function abortableDelay(milliseconds) {
  return delay(milliseconds, undefined, { signal: activityAbort.signal });
}

async function createTaskRoot() {
  const configured = process.env.AUTH_TIMING_TASK_ROOT?.trim();
  if (configured && !isAbsolute(configured)) {
    throw new Error("AUTH_TIMING_TASK_ROOT must be absolute");
  }

  const temporaryBase = await realpath(resolve(tmpdir()));
  let target;
  if (configured) {
    const configuredTarget = resolve(configured);
    const canonicalParent = await realpath(dirname(configuredTarget));
    target = join(canonicalParent, basename(configuredTarget));
    await assertSafeTaskRoot(target, temporaryBase);
    // mkdir without recursive is intentional: an existing path is never adopted.
    await mkdir(target, { mode: 0o700 });
  } else {
    // Validate the destination boundary before creating anything. The final random
    // suffix cannot change any of these parent/root safety properties.
    await assertSafeTaskRoot(join(temporaryBase, `${taskRootPrefix}candidate`), temporaryBase);
    target = await mkdtemp(join(temporaryBase, taskRootPrefix));
  }

  try {
    await writeFile(join(target, taskRootMarkerName), taskRootOwnershipToken, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
  } catch (error) {
    // The directory was freshly created above, so this exact path is ours even if
    // marker creation failed. No child process has been spawned at this point.
    await rm(target, { recursive: true, force: true });
    throw error;
  }
  return target;
}

async function assertSafeTaskRoot(target, temporaryBase) {
  const canonicalTemporaryBase = temporaryBase ?? await realpath(resolve(tmpdir()));
  const canonicalHome = await realpath(resolve(homedir()));
  const canonicalRepository = await realpath(repositoryRoot);
  if (!basename(target).startsWith(taskRootPrefix)) {
    throw new Error(`AUTH_TIMING_TASK_ROOT basename must start with ${taskRootPrefix}`);
  }
  if (!isStrictlyInside(canonicalTemporaryBase, target)) {
    throw new Error("AUTH_TIMING_TASK_ROOT must be strictly inside the process temporary directory");
  }
  if (isInside(canonicalHome, target)) {
    throw new Error("AUTH_TIMING_TASK_ROOT must not be the home directory or one of its descendants");
  }
  if (isInside(canonicalRepository, target)) {
    throw new Error("AUTH_TIMING_TASK_ROOT must be outside the repository");
  }
}

async function assertOwnedTaskRoot(target) {
  await assertSafeTaskRoot(target);
  const marker = await readFile(join(target, taskRootMarkerName), "utf8");
  if (marker !== taskRootOwnershipToken) {
    throw new Error("Refusing to remove an auth timing root without its exact ownership marker");
  }
}

function isInside(root, target) {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function isStrictlyInside(root, target) {
  return root !== target && isInside(root, target);
}

async function configuredOrAvailablePort() {
  const configured = process.env.AUTH_TIMING_PORT?.trim();
  if (configured) {
    const parsed = Number(configured);
    if (!Number.isInteger(parsed) || parsed < 1_024 || parsed > 65_535) {
      throw new Error("AUTH_TIMING_PORT must be an integer from 1024 through 65535");
    }
    return parsed;
  }
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const selected = typeof address === "object" && address ? address.port : null;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  if (selected === null) throw new Error("Unable to allocate a local timing-probe port");
  return selected;
}

// Reads the stored-credential parameters straight from the implementation instead of
// duplicating them here. A rename or a work-factor change fails loudly rather than
// leaving the probe measuring a shape the application no longer writes.
async function loadStoredPasswordFormat() {
  const source = await readFile(authImplementation, "utf8");
  const iterations = sourceNumberConstant(source, "PASSWORD_PBKDF2_ITERATIONS");
  return {
    iterations,
    chainScheme: sourceStringConstant(source, "PASSWORD_HASH_CHAIN_SCHEME"),
    legacyScheme: sourceStringConstant(source, "PASSWORD_HASH_LEGACY_SCHEME"),
    chainSaltSuffix: sourceStringConstant(source, "PASSWORD_CHAIN_SALT_SUFFIX"),
    format: (scheme, digest) => [scheme, iterations, digest].join("$")
  };
}

function sourceStringConstant(source, name) {
  const match = new RegExp(`\\bconst ${name} = "([^"\\n]*)";`).exec(source);
  if (!match) {
    throw new Error(`Unable to read ${name} from ${authImplementation}`);
  }
  return match[1];
}

function sourceNumberConstant(source, name) {
  const match = new RegExp(`\\bconst ${name} = ([0-9_]+);`).exec(source);
  const parsed = match ? Number(match[1].replaceAll("_", "")) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Unable to read ${name} from ${authImplementation}`);
  }
  return parsed;
}

async function derivedDigest(secret, salt) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(salt), iterations: storedFormat.iterations, hash: "SHA-256" },
    key,
    256
  );
  return [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function numberOption(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return parsed;
}

function smokeModeOption() {
  const value = process.env.AUTH_TIMING_SMOKE_MODE?.trim();
  if (!value) return null;
  if (value !== "normal" && value !== "failure") {
    throw new Error("AUTH_TIMING_SMOKE_MODE supports only normal or failure");
  }
  return value;
}

function withBoundedTimeout(promise, milliseconds, onTimeout) {
  let timer;
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout(onTimeout()), milliseconds);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function signalExitCode(signal) {
  if (signal === "SIGHUP") return 129;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}

function exitLabel(result) {
  return result.signal ?? result.code ?? "unknown exit";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
