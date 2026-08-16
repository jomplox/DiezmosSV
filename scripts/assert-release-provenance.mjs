#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { experimental_readRawConfig } from "wrangler";
import {
  assertDistinctDeploymentResources,
  loadPrivateDeployConfig
} from "./private-deploy-config.mjs";
import {
  assertPrivateWranglerTargetManifest,
  resolvePrivateWranglerConfig
} from "./private-wrangler-config.mjs";

const SUCCESSFUL_CHECK_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);

export function assertReleaseProvenance({
  target,
  env = process.env,
  repositoryRoot = process.cwd(),
  selectedConfig,
  otherConfig,
  rawWranglerConfig,
  execFileSyncImpl = execFileSync
} = {}) {
  if (target !== "staging" && target !== "production") {
    throw new Error("Release target must be staging or production");
  }
  const selected = selectedConfig ?? loadTargetConfig(target, target, env, repositoryRoot);
  const otherTarget = target === "staging" ? "production" : "staging";
  const other = otherConfig ?? loadTargetConfig(otherTarget, target, env, repositoryRoot);
  assertDistinctDeploymentResources(
    target === "staging" ? selected : other,
    target === "production" ? selected : other
  );

  const rawConfig = rawWranglerConfig ?? experimental_readRawConfig({
    config: resolvePrivateWranglerConfig({ env, repositoryRoot })
  }).rawConfig;
  assertPrivateWranglerTargetManifest(rawConfig, target, selected);

  const approvedSha = env.DIEZMOSSV_APPROVED_SHA?.trim() ?? "";
  if (!/^[a-f0-9]{40}$/i.test(approvedSha)) {
    throw new Error("Release provenance requires an explicit approved SHA");
  }
  const headSha = runText(execFileSyncImpl, "git", ["rev-parse", "HEAD"], repositoryRoot).trim();
  if (headSha !== approvedSha) {
    throw new Error("The current HEAD does not match the approved SHA");
  }
  const dirty = runText(
    execFileSyncImpl,
    "git",
    ["status", "--porcelain=v1", "--untracked-files=no"],
    repositoryRoot
  );
  if (dirty.trim()) {
    throw new Error("Release provenance requires a clean tracked worktree");
  }

  const checksText = runText(
    execFileSyncImpl,
    "gh",
    [
      "api",
      `repos/${selected.githubRepository}/commits/${approvedSha}/check-runs?per_page=100`
    ],
    repositoryRoot
  );
  assertSuccessfulChecks(checksText);
  return { sha: approvedSha };
}

function loadTargetConfig(target, selectedTarget, env, repositoryRoot) {
  const specific = env[`DIEZMOSSV_${target.toUpperCase()}_DEPLOY_CONFIG`]?.trim();
  const targetEnv = { ...env };
  if (specific) {
    targetEnv.DIEZMOSSV_DEPLOY_CONFIG = specific;
  } else if (target !== selectedTarget) {
    delete targetEnv.DIEZMOSSV_DEPLOY_CONFIG;
  }
  return loadPrivateDeployConfig({ target, env: targetEnv, repositoryRoot });
}

function runText(execFileSyncImpl, command, args, cwd) {
  try {
    return String(execFileSyncImpl(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }));
  } catch {
    throw new Error("Release provenance command failed");
  }
}

function assertSuccessfulChecks(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("GitHub checks could not be verified");
  }
  const count = body?.total_count;
  const checks = body?.check_runs;
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 100 ||
    !Array.isArray(checks) ||
    checks.length !== count ||
    checks.some(
      (check) =>
        check?.status !== "completed" ||
        !SUCCESSFUL_CHECK_CONCLUSIONS.has(check?.conclusion)
    )
  ) {
    throw new Error("GitHub checks for the approved SHA are not all successful");
  }
}

function parseTarget(argv) {
  if (argv.length !== 2 || argv[0] !== "--env" || !["staging", "production"].includes(argv[1])) {
    throw new Error("Usage: assert-release-provenance --env staging|production");
  }
  return argv[1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = assertReleaseProvenance({ target: parseTarget(process.argv.slice(2)) });
    process.stdout.write(`Release provenance verified for ${result.sha}.\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Release provenance failed"}\n`);
    process.exitCode = 1;
  }
}
