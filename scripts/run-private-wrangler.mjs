import { spawn } from "node:child_process";
import { join } from "node:path";
import {
  preparePrivateWranglerConfig,
  resolvePrivateWranglerConfig
} from "./private-wrangler-config.mjs";

let preparedConfig;
try {
  preparedConfig = preparePrivateWranglerConfig(
    resolvePrivateWranglerConfig()
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: run-private-wrangler <wrangler command> [arguments]");
  process.exit(1);
}

const wrangler = join(
  process.cwd(),
  "node_modules",
  ".bin",
  process.platform === "win32" ? "wrangler.cmd" : "wrangler"
);
const child = spawn(wrangler, [`--config=${preparedConfig.configPath}`, ...args], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});

child.once("error", (error) => {
  preparedConfig.cleanup();
  console.error(`Unable to start Wrangler: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  preparedConfig.cleanup();
  if (signal) {
    console.error(`Wrangler stopped by signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
