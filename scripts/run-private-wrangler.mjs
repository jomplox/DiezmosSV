import { spawn } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  preparePrivateWranglerConfig,
  resolvePrivateWranglerConfig
} from "./private-wrangler-config.mjs";

class WranglerCommandError extends Error {
  constructor(message, { kind, exitCode, signal } = {}) {
    super(message);
    this.kind = kind;
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export function createSignalCleanupHandler({ cleanup, terminate, exit }) {
  let handled = false;
  return (signal) => {
    if (handled) return;
    handled = true;
    cleanup();
    terminate(signal);
    exit(signal === "SIGINT" ? 130 : 143);
  };
}

export function createPrivateWranglerRunner({
  repositoryRoot = process.cwd(),
  env = process.env,
  configPath,
  migrationsDirOverride,
  spawnImpl = spawn
} = {}) {
  const preparedConfig = preparePrivateWranglerConfig(
    configPath ?? resolvePrivateWranglerConfig({ env, repositoryRoot }),
    { repositoryRoot, migrationsDirOverride }
  );
  const executable = join(
    repositoryRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler"
  );
  let activeChild;
  let cleaned = false;

  return {
    configPath: preparedConfig.configPath,
    run(args, { capture = false } = {}) {
      if (cleaned) {
        return Promise.reject(new Error("The private Wrangler runner is closed"));
      }
      if (activeChild) {
        return Promise.reject(new Error("The private Wrangler runner is already active"));
      }

      return new Promise((resolve, reject) => {
        const child = spawnImpl(
          executable,
          [`--config=${preparedConfig.configPath}`, ...args],
          {
            cwd: repositoryRoot,
            env,
            stdio: capture ? ["inherit", "pipe", "pipe"] : "inherit"
          }
        );
        activeChild = child;
        let stdout = "";
        let stderr = "";
        if (capture) {
          child.stdout?.on("data", (chunk) => {
            stdout += String(chunk);
          });
          child.stderr?.on("data", (chunk) => {
            stderr += String(chunk);
          });
        }

        let settled = false;
        const settle = (callback) => {
          if (settled) return;
          settled = true;
          activeChild = undefined;
          callback();
        };
        child.once("error", (error) => {
          settle(() =>
            reject(
              new WranglerCommandError(`Unable to start Wrangler: ${error.message}`, {
                kind: "spawn"
              })
            )
          );
        });
        child.once("close", (code, signal) => {
          settle(() => {
            if (signal) {
              reject(
                new WranglerCommandError(`Wrangler stopped by signal ${signal}`, {
                  kind: "signal",
                  signal
                })
              );
              return;
            }
            if (code !== 0) {
              reject(
                new WranglerCommandError(
                  stderr.trim() || `Wrangler exited with status ${code ?? 1}`,
                  { kind: "status", exitCode: code ?? 1 }
                )
              );
              return;
            }
            resolve(capture ? stdout : "");
          });
        });
      });
    },
    terminate(signal) {
      activeChild?.kill(signal);
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      preparedConfig.cleanup();
    }
  };
}

async function runCli() {
  let runner;
  try {
    runner = createPrivateWranglerRunner();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: run-private-wrangler <wrangler command> [arguments]");
    runner.cleanup();
    process.exitCode = 1;
    return;
  }

  const signalHandler = createSignalCleanupHandler({
    cleanup: runner.cleanup,
    terminate: (signal) => runner.terminate(signal),
    exit: (code) => process.exit(code)
  });
  process.once("SIGINT", signalHandler);
  process.once("SIGTERM", signalHandler);
  try {
    await runner.run(args);
  } catch (error) {
    if (error instanceof WranglerCommandError && error.kind === "status") {
      process.exitCode = error.exitCode;
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", signalHandler);
    process.removeListener("SIGTERM", signalHandler);
    runner.cleanup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
