import type { EmisorConfig, Env } from "./types";

export function isMockMode(env: Env): boolean {
  return env.MOCK_EXTERNAL_SERVICES !== "false";
}

export function getEmisorConfig(env: Env): EmisorConfig {
  if (!env.EMISOR_CONFIG_JSON) {
    throw new Error("EMISOR_CONFIG_JSON is required");
  }
  return JSON.parse(env.EMISOR_CONFIG_JSON) as EmisorConfig;
}

export function requireSecret(env: Env, key: keyof Env): string {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${String(key)} is required`);
  }
  return value;
}

export function mhEndpoint(env: Env, name: "auth" | "recepcion" | "contingencia" | "anulacion", ambiente: "00" | "01"): string {
  const suffix = ambiente === "01" ? "PROD" : "TEST";
  const key = `MH_${name.toUpperCase()}_URL_${suffix}` as keyof Env;
  return requireSecret(env, key);
}
