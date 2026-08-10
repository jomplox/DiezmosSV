#!/usr/bin/env node
import {
  loadOperatorCredentials,
  loadPrivateDeployConfig
} from "./private-deploy-config.mjs";
import { migrateRuntimeBrandingLogo } from "./runtime-branding-logo.mjs";

try {
  const { target, apply } = parseArgs(process.argv.slice(2));
  const config = loadPrivateDeployConfig({ target });
  const credentials = loadOperatorCredentials({ target });
  if (!apply) {
    process.stdout.write("Private runtime logo inputs validated; no remote request was sent.\n");
  } else {
    const result = await migrateRuntimeBrandingLogo(config, credentials);
    process.stdout.write(result.changed
      ? "Runtime donor logo migration and postflight passed.\n"
      : "Runtime donor logo already matches; no write was sent.\n");
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Runtime donor logo migration failed"}\n`);
  process.exitCode = 1;
}

function parseArgs(args) {
  const targetIndex = args.indexOf("--env");
  const target = targetIndex >= 0 ? args[targetIndex + 1] : undefined;
  const apply = args.includes("--apply");
  const expectedLength = apply ? 3 : 2;
  if (
    args.length !== expectedLength ||
    targetIndex < 0 ||
    !["staging", "production"].includes(target) ||
    args.some((arg) => !["--env", "staging", "production", "--apply"].includes(arg))
  ) {
    throw new Error("Usage: migrate-runtime-branding-logo --env staging|production [--apply]");
  }
  return { target, apply };
}
