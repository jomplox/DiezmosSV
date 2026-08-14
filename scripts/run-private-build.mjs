#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { pathToFileURL } from "node:url";
import { loadPrivateDeployConfig } from "./private-deploy-config.mjs";

const PUBLIC_VITE_VARIABLES = [
  ["VITE_GIVEBUTTER_CAMPAIGN", (config) => config.campaign]
];

export async function runPrivateBuild({
  target,
  env = process.env,
  repositoryRoot = process.cwd(),
  spawnImpl = spawn
} = {}) {
  // Validate the owner-only target, campaign, origin, and donor-logo contract
  // before Vite starts. Only the public Givebutter campaign slug enters the
  // client build; Stripe credentials remain runtime-only.
  const config = loadPrivateDeployConfig({ target, env, repositoryRoot });
  const buildEnv = createBuildEnvironment(env, config);

  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
      cwd: repositoryRoot,
      env: buildEnv,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolve(signal ? 128 + (constants.signals[signal] ?? 1) : (status ?? 1));
    });
  });
}

function createBuildEnvironment(inheritedEnv, config) {
  const buildEnv = {};
  for (const [name, value] of Object.entries(inheritedEnv)) {
    if (!name.toLowerCase().startsWith("vite_")) {
      buildEnv[name] = value;
    }
  }
  for (const [name, readConfig] of PUBLIC_VITE_VARIABLES) {
    buildEnv[name] = readConfig(config);
  }
  return buildEnv;
}

async function runCli() {
  try {
    const target = parseTarget(process.argv.slice(2));
    process.exitCode = await runPrivateBuild({ target });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Private build failed"}\n`);
    process.exitCode = 1;
  }
}

function parseTarget(args) {
  if (args.length !== 2 || args[0] !== "--env" || !["staging", "production"].includes(args[1])) {
    throw new Error("Usage: run-private-build --env staging|production");
  }
  return args[1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
