import type { Env } from "../types";
import { UUID_V4_PATTERN } from "../utils/guards";

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
