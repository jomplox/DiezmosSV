import type { Env } from "../types";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function stagingSmokeRunId(env: Env, value: unknown): string | null {
  if (env.APP_ENV?.trim().toLowerCase() !== "staging" || typeof value !== "string") {
    return null;
  }
  const runId = value.trim().toLowerCase();
  return UUID_V4_PATTERN.test(runId) ? runId : null;
}

export function stagingSmokeRunIdFromTransaction(
  env: Env,
  transactionId: unknown
): string | null {
  if (typeof transactionId !== "string" || !transactionId.startsWith("SMOKE-WEBHOOK-")) {
    return null;
  }
  return stagingSmokeRunId(env, transactionId.slice("SMOKE-WEBHOOK-".length));
}
