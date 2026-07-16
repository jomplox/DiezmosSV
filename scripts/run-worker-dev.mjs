import { homedir } from "node:os";
import { chmodSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertPrivateEnvFile } from "./assert-private-env-file.mjs";

const configured = process.env.DIEZMOSSV_ENV_FILE?.trim();
const configuredMiniflareCache = process.env.MINIFLARE_CACHE_DIR?.trim();
const miniflareCacheDir = configuredMiniflareCache
  ? (isAbsolute(configuredMiniflareCache) ? configuredMiniflareCache : resolve(process.cwd(), configuredMiniflareCache))
  : join(homedir(), "Library", "Application Support", "DiezmosSV", "private", "cache", "miniflare");
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

try {
  if (isInside(process.cwd(), miniflareCacheDir)) {
    throw new Error("MINIFLARE_CACHE_DIR must be outside the DiezmosSV repository");
  }
  mkdirSync(miniflareCacheDir, { recursive: true, mode: 0o700 });
  chmodSync(miniflareCacheDir, 0o700);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const wrangler = join(process.cwd(), "node_modules", ".bin", process.platform === "win32" ? "wrangler.cmd" : "wrangler");
console.log(`Using Worker environment file: ${envFile}`);
const child = spawn(wrangler, ["dev", "--env-file", envFile, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: { ...process.env, MINIFLARE_CACHE_DIR: miniflareCacheDir },
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

function isInside(root, path) {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
