import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";

const configured = process.env.DIEZMOSSV_ENV_FILE?.trim();
const envFile = configured
  ? (isAbsolute(configured) ? configured : resolve(process.cwd(), configured))
  : join(homedir(), "Library", "Application Support", "DiezmosSV", "private", "env", "local-operator.env");

let stat;
try {
  stat = lstatSync(envFile);
} catch (error) {
  if (error?.code === "ENOENT") {
    console.error(`Environment file not found: ${envFile}`);
    process.exit(1);
  }
  throw error;
}
if (!stat.isFile() || stat.isSymbolicLink()) {
  console.error(`Environment path must be a regular non-symlink file: ${envFile}`);
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
