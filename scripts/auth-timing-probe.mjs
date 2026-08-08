import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const root = process.cwd();
const wrangler = resolve(root, "node_modules/.bin/wrangler");
const ciEnvFile = resolve(root, ".dev.vars.ci");
const databaseName = "diezmossv-local-db-example";
const warmupsPerClass = numberOption("AUTH_TIMING_WARMUPS_PER_CLASS", 50, 1);
const samplesPerClass = numberOption("AUTH_TIMING_SAMPLES_PER_CLASS", 500, 20);
// Successful requests are observational only; the invalid-class equivalence gate below
// retains the required 500 samples per class by default.
const successSamplesPerClass = numberOption("AUTH_TIMING_SUCCESS_SAMPLES_PER_CLASS", 100, 20);
const resetEveryRounds = numberOption("AUTH_TIMING_RESET_EVERY_ROUNDS", 10, 1);
const knownPassword = "Known#Password2026";
const wrongPassword = "Wrong#Password2026";
const knownSalt = "known-salt";
const knownFirst = "2a48b73a4b58947ff6b4a5a9535702d5cc2a43e524c7d71b6bb89353147fc467";
const knownSecond = "e2943461247a19a80553d387e3bdd3430becc228e3375d09b651c3e0bf59dd31";

const invalidClasses = [
  { name: "missing", storedHash: null, disabled: false },
  { name: "disabled", storedHash: `pbkdf2-chain-v1$100000$${knownSecond}`, disabled: true },
  { name: "current", storedHash: `pbkdf2-chain-v1$100000$${knownSecond}`, disabled: false },
  { name: "versioned-legacy", storedHash: `pbkdf2$100000$${knownFirst}`, disabled: false },
  { name: "countless-legacy", storedHash: knownFirst, disabled: false }
];
const successClasses = [
  { name: "current-success", storedHash: `pbkdf2-chain-v1$100000$${knownSecond}` },
  { name: "legacy-upgrade-success", storedHash: `pbkdf2$100000$${knownFirst}` }
];

let worker;
let workerOutput = "";
const taskRoot = await mkdtemp(join(tmpdir(), "diezmossv-auth-timing-"));
const persistDir = join(taskRoot, "d1");
const miniflareCacheDir = join(taskRoot, "miniflare-cache");
const seedFile = join(taskRoot, "seed.sql");
const resetFile = join(taskRoot, "reset.sql");

try {
  await Promise.all([
    access(wrangler),
    access(ciEnvFile),
    access(resolve(root, "dist/client"))
  ]);
  await Promise.all([
    mkdir(persistDir, { recursive: true, mode: 0o700 }),
    mkdir(miniflareCacheDir, { recursive: true, mode: 0o700 })
  ]);

  const commandEnv = {
    ...process.env,
    MINIFLARE_CACHE_DIR: miniflareCacheDir,
    WRANGLER_SEND_METRICS: "false",
    NO_COLOR: "1"
  };
  await run(wrangler, [
    "d1", "migrations", "apply", databaseName, "--local", "--persist-to", persistDir
  ], commandEnv);

  await writeFile(seedFile, syntheticSeedSql(), { mode: 0o600 });
  await writeFile(
    resetFile,
    "DELETE FROM sessions;\nDELETE FROM login_rate_limits;\nDELETE FROM audit_logs WHERE action IN ('LOGIN', 'LOGIN_FAILED');\n",
    { mode: 0o600 }
  );
  await run(wrangler, [
    "d1", "execute", databaseName, "--local", "--persist-to", persistDir, "--file", seedFile
  ], commandEnv);

  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  worker = spawn(wrangler, [
    "dev",
    "--env-file", ciEnvFile,
    "--port", String(port),
    "--ip", "127.0.0.1",
    "--persist-to", persistDir
  ], {
    cwd: root,
    env: {
      ...commandEnv,
      DIEZMOSSV_ENV_FILE: ciEnvFile
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  worker.stdout.on("data", (chunk) => appendWorkerOutput(chunk));
  worker.stderr.on("data", (chunk) => appendWorkerOutput(chunk));
  await waitForWorker(origin);

  await runInvalidRounds(origin, "warmup", warmupsPerClass, false, commandEnv);
  await resetSyntheticState(commandEnv);
  const invalidSamples = await runInvalidRounds(origin, "sample", samplesPerClass, true, commandEnv);
  await resetSyntheticState(commandEnv);
  const successSamples = await runSuccessRounds(origin, successSamplesPerClass, commandEnv);

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

  console.log(JSON.stringify({
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
  }, null, 2));
  if (!pass) process.exitCode = 1;
} catch (error) {
  const detail = workerOutput.trim();
  console.error(error instanceof Error ? error.message : String(error));
  if (detail) console.error(detail);
  process.exitCode = 1;
} finally {
  if (worker && worker.exitCode === null) {
    worker.kill("SIGTERM");
    await Promise.race([waitForExit(worker), delay(5_000)]);
    if (worker.exitCode === null) worker.kill("SIGKILL");
  }
  await rm(taskRoot, { recursive: true, force: true });
}

async function runInvalidRounds(origin, phase, rounds, collect, commandEnv) {
  const samples = new Map(invalidClasses.map(({ name }) => [name, []]));
  const random = seededRandom(phase === "warmup" ? 0x31_48_15_92 : 0x27_18_28_18);
  for (let round = 0; round < rounds; round += 1) {
    for (const entry of shuffled(invalidClasses, random)) {
      const email = `${entry.name}-${phase}-${round}@auth-timing.invalid`;
      const started = performance.now();
      const response = await login(origin, email, wrongPassword, syntheticIp(phase, round, entry.name));
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

async function runSuccessRounds(origin, rounds, commandEnv) {
  const samples = new Map(successClasses.map(({ name }) => [name, []]));
  const random = seededRandom(0x16_18_03_39);
  for (let round = 0; round < rounds; round += 1) {
    for (const entry of shuffled(successClasses, random)) {
      const email = `${entry.name}-sample-${round}@auth-timing.invalid`;
      const started = performance.now();
      const response = await login(origin, email, knownPassword, syntheticIp("success", round, entry.name));
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

async function login(origin, email, password, ip) {
  const response = await fetch(`${origin}/api/auth/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip
    },
    body: JSON.stringify({ email, password })
  });
  await response.text();
  return response;
}

async function resetSyntheticState(commandEnv) {
  await run(wrangler, [
    "d1", "execute", databaseName, "--local", "--persist-to", persistDir, "--file", resetFile
  ], commandEnv);
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

function numberOption(name, fallback, minimum) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be an integer >= ${minimum}`);
  }
  return parsed;
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
  if (port === null) throw new Error("Unable to allocate a local timing-probe port");
  return port;
}

async function waitForWorker(origin) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (worker.exitCode !== null) {
      throw new Error(`Local Worker exited before becoming ready (code ${worker.exitCode})`);
    }
    try {
      const response = await fetch(`${origin}/api/health`);
      if (response.ok) return;
    } catch {
      // Wrangler has not opened the listening socket yet.
    }
    await delay(250);
  }
  throw new Error("Timed out waiting for the local Worker timing target");
}

function appendWorkerOutput(chunk) {
  workerOutput = `${workerOutput}${String(chunk)}`.slice(-8_000);
}

async function run(command, args, env) {
  const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); });
  child.stderr.on("data", (chunk) => { output = `${output}${String(chunk)}`.slice(-8_000); });
  const [code, signal] = await waitForExit(child);
  if (code !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${signal ?? code})\n${output.trim()}`);
  }
}

function waitForExit(child) {
  if (child.exitCode !== null) return Promise.resolve([child.exitCode, null]);
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", (code, signal) => resolveExit([code, signal]));
  });
}
