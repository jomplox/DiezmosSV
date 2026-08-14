#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { pathToFileURL } from "node:url";
import { loadPrivateDeployConfig } from "./private-deploy-config.mjs";

const PUBLIC_VITE_VARIABLES = [
  ["VITE_GIVEBUTTER_CAMPAIGN", (config) => config.campaign],
  ["VITE_GIVEBUTTER_TITHE_FUND_ID", (config) => config.givebutterFunds?.tithe],
  ["VITE_GIVEBUTTER_OFFERING_FUND_ID", (config) => config.givebutterFunds?.offering]
];

export async function runPrivateBuild({
  target,
  env = process.env,
  repositoryRoot = process.cwd(),
  spawnImpl = spawn,
  platform = process.platform
} = {}) {
  // Validate the owner-only target, campaign, origin, and donor-logo contract
  // before Vite starts. Only validated public Givebutter routing values enter
  // the client build; Stripe credentials remain runtime-only.
  const config = loadPrivateDeployConfig({ target, env, repositoryRoot });
  const buildEnv = createBuildEnvironment(env, config);
  const invocation = buildInvocation(platform, buildEnv);

  return new Promise((resolve, reject) => {
    const child = spawnImpl(invocation.command, invocation.args, {
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

function buildInvocation(platform, env) {
  if (platform !== "win32") {
    return { command: "npm", args: ["run", "build"] };
  }
  const commandInterpreter = Object.entries(env).find(
    ([name, value]) => name.toLowerCase() === "comspec" && value?.trim()
  )?.[1];
  return {
    command: commandInterpreter || "cmd.exe",
    args: ["/d", "/c", "npm.cmd", "run", "build"]
  };
}

function createBuildEnvironment(inheritedEnv, config) {
  const buildEnv = {};
  for (const [name, value] of Object.entries(inheritedEnv)) {
    if (!name.toLowerCase().startsWith("vite_")) {
      buildEnv[name] = value;
    }
  }
  for (const [name, readConfig] of PUBLIC_VITE_VARIABLES) {
    // Set every approved key so Vite cannot revive an absent optional value
    // from a repository-local dotenv file after private validation succeeds.
    buildEnv[name] = readConfig(config) ?? "";
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
