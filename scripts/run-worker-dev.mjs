import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertPrivateEnvFile } from "./assert-private-env-file.mjs";

const configured = process.env.DIEZMOSSV_ENV_FILE?.trim();
const envFile = configured
  ? (isAbsolute(configured) ? configured : resolve(process.cwd(), configured))
  : join(homedir(), "Library", "Application Support", "DiezmosSV", "private", "env", "local-operator.env");

try {
  // The checked-in CI fixture contains mock-only values and is intentionally 0644 so
  // Git can reproduce it. No other readable path (including another .dev.vars.ci in
  // a different cwd) receives this exception.
  const ciFixture = fileURLToPath(new URL("../.dev.vars.ci", import.meta.url));
  assertPrivateEnvFile(envFile, { allowReadableFixturePath: ciFixture });
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const wrangler = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
console.log(`Using Worker environment file: ${envFile}`);
const child = spawn(wrangler, ["dev", "--env-file", envFile, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit"
});

child.once("error", (error) => {
  console.error(`Unable to start Wrangler: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  if (signal) {
    console.error(`Wrangler stopped by signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
