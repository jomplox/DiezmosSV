import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  logOperationalAlert,
  logWorkerError
} from "../../src/worker/services/observability";
import type { Env } from "../../src/worker/types";

const workerDirectory = resolve(process.cwd(), "src/worker");

function workerSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? workerSourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function directConsoleErrorCalls(path: string): number {
  const executable = withoutCommentsAndStrings(readFileSync(path, "utf8"));
  return [...executable.matchAll(/(^|[^\w$.])console\s*\.\s*error\s*\(/gm)].length;
}

function withoutCommentsAndStrings(source: string): string {
  let output = "";
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (state === "code" && char === "/" && next === "/") {
      state = "line";
      output += "  ";
      index += 1;
      continue;
    }
    if (state === "code" && char === "/" && next === "*") {
      state = "block";
      output += "  ";
      index += 1;
      continue;
    }
    if (state === "code" && (char === "'" || char === "\"" || char === "`")) {
      state = char === "'" ? "single" : char === "\"" ? "double" : "template";
      output += " ";
      continue;
    }
    if (state === "line" && char === "\n") {
      state = "code";
      output += "\n";
      continue;
    }
    if (state === "block" && char === "*" && next === "/") {
      state = "code";
      output += "  ";
      index += 1;
      continue;
    }
    if (
      (state === "single" || state === "double" || state === "template") &&
      char === "\\"
    ) {
      output += "  ";
      index += 1;
      continue;
    }
    if (
      (state === "single" && char === "'") ||
      (state === "double" && char === "\"") ||
      (state === "template" && char === "`")
    ) {
      state = "code";
      output += " ";
      continue;
    }
    if (state === "code" || char === "\n") {
      output += char;
    } else {
      output += " ";
    }
  }
  return output;
}

function parsedTomlScalars(source: string): Map<string, Map<string, boolean | number>> {
  const tables = new Map<string, Map<string, boolean | number>>();
  let currentTable = "";
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    const tableMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (tableMatch) {
      currentTable = tableMatch[1];
      continue;
    }
    const scalarMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(true|false|-?\d+(?:\.\d+)?)$/);
    if (!scalarMatch) {
      continue;
    }
    const table = tables.get(currentTable) ?? new Map<string, boolean | number>();
    const rawValue = scalarMatch[2];
    table.set(
      scalarMatch[1],
      rawValue === "true" ? true : rawValue === "false" ? false : Number(rawValue)
    );
    tables.set(currentTable, table);
  }
  return tables;
}

function resolvedObservability(
  tables: Map<string, Map<string, boolean | number>>,
  environment?: "staging" | "production"
): Record<string, boolean | number | undefined> {
  const base = environment ? `env.${environment}.observability` : "observability";
  return {
    enabled: tables.get(base)?.get("enabled"),
    head_sampling_rate: tables.get(base)?.get("head_sampling_rate"),
    invocation_logs: tables.get(`${base}.logs`)?.get("invocation_logs"),
    traces_enabled: tables.get(`${base}.traces`)?.get("enabled")
  };
}

describe("Worker observability", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs one fixed, normalized error event", () => {
    const error = Object.assign(new TypeError("Payment failed"), {
      code: "environment_not_allowed"
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logWorkerError({ APP_ENV: "staging" } as Env, "issuance_message_failed", error);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({
      event: "issuance_message_failed",
      app_env: "staging",
      error_name: "typeerror",
      error_code: "environment_not_allowed"
    });
  });

  it("preserves allowlisted Stripe processing categories without logging event data", () => {
    const error = Object.assign(new Error("must not be logged"), {
      code: "checkout_identity_mismatch"
    });
    error.name = "StripeWebhookEventError";
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logWorkerError({ APP_ENV: "production" } as Env, "stripe_webhook_processing_failed", error);

    expect(spy).toHaveBeenCalledWith({
      event: "stripe_webhook_processing_failed",
      app_env: "production",
      error_name: "stripewebhookeventerror",
      error_code: "checkout_identity_mismatch"
    });
    expect(JSON.stringify(spy.mock.calls[0][0])).not.toContain("must not be logged");
  });

  it("maps recognizable secrets and identities in every dynamic error token to unknown", () => {
    const error = Object.assign(
      new Error("ana@example.org https://private.example/token/abc document dte_123"),
      {
        code: "sk_live_credential_123456",
        address: "10.0.0.42",
        documentId: "dte_123",
        details: { authorization: "Bearer secret-token" }
      }
    );
    error.name = "ana@example.org";
    error.stack = "Error: ana@example.org at https://private.example/token/abc";
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logWorkerError(
      { APP_ENV: "https://private.example/env/dte_123" } as Env,
      "worker_failure_ana@example.org",
      error
    );

    const logged = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(logged).toEqual({
      event: "unknown",
      app_env: "unknown",
      error_name: "unknown",
      error_code: "unknown"
    });
    expect(JSON.stringify(logged)).not.toContain("ana@example.org");
    expect(JSON.stringify(logged)).not.toContain("private.example");
    expect(JSON.stringify(logged)).not.toContain("10.0.0.42");
    expect(JSON.stringify(logged)).not.toContain("dte_123");
    expect(JSON.stringify(logged)).not.toContain("credential");
  });

  it("does not throw when Error name and code getters throw", () => {
    const error = Object.create(Error.prototype);
    Object.defineProperties(error, {
      name: {
        get() {
          throw new Error("name getter leaked ana@example.org");
        }
      },
      code: {
        get() {
          throw new Error("code getter leaked sk_live_credential_123456");
        }
      }
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => {
      logWorkerError({ APP_ENV: "production" } as Env, "queue_handler_failed", error);
    }).not.toThrow();
    expect(spy).toHaveBeenCalledWith({
      event: "queue_handler_failed",
      app_env: "production",
      error_name: "unknown",
      error_code: "unknown"
    });
  });

  it("maps arbitrary operational alert metadata to unknown", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logOperationalAlert(
      { APP_ENV: "ana@example.org" } as Env,
      "https://private.example/token/abc",
      "dte_123_sk_live_credential"
    );

    expect(spy).toHaveBeenCalledWith({
      event: "operational_alert",
      app_env: "unknown",
      alert_kind: "unknown",
      entity_type: "unknown"
    });
    const serialized = JSON.stringify(spy.mock.calls[0][0]);
    expect(serialized).not.toContain("ana@example.org");
    expect(serialized).not.toContain("private.example");
    expect(serialized).not.toContain("dte_123");
    expect(serialized).not.toContain("credential");
  });

  it("keeps direct console.error calls inside the observability helper", () => {
    const directCalls = workerSourceFiles(workerDirectory)
      .filter((path) => !path.endsWith("/services/observability.ts"))
      .flatMap((path) => directConsoleErrorCalls(path) > 0 ? [path] : []);

    expect(directCalls).toEqual([]);
  });

  it("keeps custom logs enabled while disabling invocation logs and traces in every environment", () => {
    const wrangler = readFileSync(resolve(process.cwd(), "wrangler.toml"), "utf8");
    const tables = parsedTomlScalars(wrangler);

    for (const environment of [undefined, "staging", "production"] as const) {
      expect(resolvedObservability(tables, environment)).toEqual({
        enabled: true,
        head_sampling_rate: 1,
        invocation_logs: false,
        traces_enabled: false
      });
    }
  });
});
