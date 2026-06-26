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

export function getMhCertificateXml(env: Env): string {
  if (typeof env.MH_CERT_XML === "string" && env.MH_CERT_XML.length > 0) {
    return env.MH_CERT_XML;
  }

  const part1 = env.MH_CERT_XML_PART_1;
  const part2 = env.MH_CERT_XML_PART_2;
  if (part1 || part2) {
    if (typeof part1 === "string" && part1.length > 0 && typeof part2 === "string" && part2.length > 0) {
      return `${part1}${part2}`;
    }
    throw new Error("MH_CERT_XML_PART_1 and MH_CERT_XML_PART_2 are required when MH_CERT_XML is not set");
  }

  throw new Error("MH_CERT_XML is required");
}

export function mhEndpoint(env: Env, name: "auth" | "recepcion" | "contingencia" | "anulacion", ambiente: "00" | "01"): string {
  const suffix = ambiente === "01" ? "PROD" : "TEST";
  const key = `MH_${name.toUpperCase()}_URL_${suffix}` as keyof Env;
  return requireSecret(env, key);
}
