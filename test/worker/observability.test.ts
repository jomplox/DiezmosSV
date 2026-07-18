import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { logWorkerError } from "../../src/worker/services/observability";
import type { Env } from "../../src/worker/types";

const workerDirectory = resolve(process.cwd(), "src/worker");

function workerSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? workerSourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("Worker observability", () => {
  it("logs one fixed, normalized error event", () => {
    const error = Object.assign(new TypeError("Payment failed"), { code: "MH-503" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logWorkerError({ APP_ENV: "Staging / Canary" } as Env, "Payment Retry Failed", error);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      event: "payment_retry_failed",
      app_env: "staging_canary",
      error_name: "typeerror",
      error_code: "mh_503"
    });
    spy.mockRestore();
  });

  it("never logs error messages, stacks, addresses, URLs, document IDs, or arbitrary properties", () => {
    const error = Object.assign(
      new Error("ana@example.org https://private.example/token/abc document dte_123"),
      {
        code: "DTE_FAILED",
        address: "10.0.0.42",
        documentId: "dte_123",
        details: { authorization: "Bearer secret-token" }
      }
    );
    error.stack = "Error: ana@example.org at https://private.example/token/abc";
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logWorkerError({ APP_ENV: "production" } as Env, "worker_failure", error);

    const logged = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(logged).toEqual({
      event: "worker_failure",
      app_env: "production",
      error_name: "error",
      error_code: "dte_failed"
    });
    expect(JSON.stringify(logged)).not.toContain("ana@example.org");
    expect(JSON.stringify(logged)).not.toContain("private.example");
    expect(JSON.stringify(logged)).not.toContain("10.0.0.42");
    expect(JSON.stringify(logged)).not.toContain("dte_123");
    expect(JSON.stringify(logged)).not.toContain("secret-token");
    spy.mockRestore();
  });

  it("keeps direct console.error calls inside the observability helper", () => {
    const directCalls = workerSourceFiles(workerDirectory)
      .filter((path) => !path.endsWith("/services/observability.ts"))
      .flatMap((path) => readFileSync(path, "utf8").includes("console.error") ? [path] : []);

    expect(directCalls).toEqual([]);
  });

  it("enables Workers Logs in root, staging, and production", () => {
    const wrangler = readFileSync(resolve(process.cwd(), "wrangler.toml"), "utf8");

    expect(wrangler).toMatch(/\[observability\]\s+enabled = true\s+head_sampling_rate = 1/);
    expect(wrangler).toMatch(/\[env\.staging\.observability\]\s+enabled = true\s+head_sampling_rate = 1/);
    expect(wrangler).toMatch(/\[env\.production\.observability\]\s+enabled = true\s+head_sampling_rate = 1/);
  });
});
