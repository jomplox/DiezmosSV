import type { Env } from "../types";

const TOKEN_MAX_LENGTH = 64;

type ErrorEvent = {
  event: string;
  app_env: string;
  error_name: string;
  error_code: string;
};

type OperationalAlertEvent = {
  event: "operational_alert";
  app_env: string;
  alert_kind: string;
  entity_type: string;
};

export function logWorkerError(env: Env, event: string, error: unknown): void {
  const errorRecord = error instanceof Error ? error as Error & { code?: unknown } : null;
  const output: ErrorEvent = {
    event: normalizedToken(event),
    app_env: normalizedToken(env.APP_ENV),
    error_name: normalizedToken(errorRecord?.name),
    error_code: normalizedToken(errorRecord?.code)
  };
  console.error(output);
}

export function logOperationalAlert(env: Env, alertKind: string, entityType: string): void {
  const output: OperationalAlertEvent = {
    event: "operational_alert",
    app_env: normalizedToken(env.APP_ENV),
    alert_kind: normalizedToken(alertKind),
    entity_type: normalizedToken(entityType)
  };
  console.error(output);
}

function normalizedToken(value: unknown): string {
  if (typeof value !== "string" && typeof value !== "number") {
    return "unknown";
  }
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, TOKEN_MAX_LENGTH);
  return normalized || "unknown";
}
