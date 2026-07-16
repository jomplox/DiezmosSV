import { homedir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Playwright drives a REAL local Cloudflare Worker (SPA + API in one process),
// not vite. The webServer below builds the client, applies local D1 migrations,
// and starts `wrangler dev` on port 8787 through the private env-file runner.
// CI sets DIEZMOSSV_ENV_FILE=.dev.vars.ci; local runs can point at any approved
// out-of-tree operator env without copying it into the checkout.
//
// Set PW_PERSIST_TO=<dir> to point wrangler at an isolated state directory
// (recommended locally so the smoke test starts from a fresh D1 and never
// clobbers your dev checkout's local database). CI leaves it unset: a fresh
// runner has no .wrangler state, so the bootstrap path is exercised naturally.
const isCI = !!process.env.CI;
const persistTo = process.env.PW_PERSIST_TO;
const persistFlag = persistTo ? ` --persist-to ${persistTo}` : "";
const miniflareCacheDir = process.env.MINIFLARE_CACHE_DIR
  ?? (persistTo
    ? join(persistTo, "miniflare-cache")
    : join(homedir(), "Library", "Application Support", "DiezmosSV", "private", "cache", "miniflare"));

const migrateCommand = `npx wrangler d1 migrations apply diezmossv-local-db-example --local${persistFlag}`;
const devCommand = `npm run dev:worker -- --port 8787 --ip 127.0.0.1${persistFlag}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1,
  reporter: isCI ? [["list"], ["html", { open: "never" }]] : "list",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:8787",
    trace: "on-first-retry"
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],
  webServer: {
    // Build the SPA, apply local migrations, then serve SPA + API from wrangler.
    command: `npm run build && ${migrateCommand} && ${devCommand}`,
    url: "http://127.0.0.1:8787/",
    reuseExistingServer: !isCI,
    timeout: 180_000,
    env: { MINIFLARE_CACHE_DIR: miniflareCacheDir },
    stdout: "pipe",
    stderr: "pipe"
  }
});
