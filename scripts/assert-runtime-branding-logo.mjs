#!/usr/bin/env node
import { loadPrivateDeployConfig } from "./private-deploy-config.mjs";
import { verifyRuntimeBrandingLogo } from "./runtime-branding-logo.mjs";

try {
  const target = parseTarget(process.argv.slice(2));
  const config = loadPrivateDeployConfig({ target });
  await verifyRuntimeBrandingLogo(config);
  process.stdout.write("Runtime donor logo verification passed.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Runtime donor logo verification failed"}\n`);
  process.exitCode = 1;
}

function parseTarget(args) {
  if (args.length !== 2 || args[0] !== "--env" || !["staging", "production"].includes(args[1])) {
    throw new Error("Usage: assert-runtime-branding-logo --env staging|production");
  }
  return args[1];
}
