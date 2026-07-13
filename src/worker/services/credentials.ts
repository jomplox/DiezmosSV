import { certificateExpiry } from "../domain/signer";
import { getMhCertificateXml } from "../config";
import type { Env } from "../types";
import { deploymentEnvironmentPolicy } from "./environmentPolicy";

type CredentialEnvironment = "test" | "production";

export interface CredentialUpdateInput {
  environment: CredentialEnvironment;
  mhUser?: string;
  mhPassword?: string;
  certificateXml?: string;
  certificatePassword?: string;
  emisorConfigJson?: string;
  wompiSecret?: string;
  emailApiKey?: string;
  emailFrom?: string;
}

export interface SecretStatusItem {
  name: string;
  label: string;
  configured: boolean;
  displayValue?: string;
  protected?: boolean;
}

export interface SecretStatusGroup {
  label: string;
  ready: boolean;
  items: SecretStatusItem[];
}

export interface CredentialStatus {
  target: {
    appEnv: string;
    scriptName: string | null;
    writerConfigured: boolean;
    writerMissing: string[];
  };
  groups: Record<string, SecretStatusGroup>;
  certificateExpiresAt: string | null;
}

interface SecretText {
  type: "secret_text";
  name: string;
  text: string;
}

export type SecretPatch = Record<string, SecretText | null>;

export class CredentialWriterConfigError extends Error {
  constructor(message = "El escritor de secretos de Cloudflare no está configurado para este Worker") {
    super(message);
    this.name = "CredentialWriterConfigError";
  }
}

export function credentialStatus(env: Env): CredentialStatus {
  const writerMissing = cloudflareWriterMissing(env);
  const mhTest = group("Ministerio de Hacienda ambiente de pruebas", [
    visibleItem(env, "MH_USER_TEST", "Usuario API TEST"),
    protectedItem(env, "MH_PASSWORD_TEST", "Contraseña API TEST")
  ]);
  const mhProduction = group("Ministerio de Hacienda ambiente producción", [
    visibleItem(env, "MH_USER_PROD", "Usuario API PROD"),
    protectedItem(env, "MH_PASSWORD_PROD", "Contraseña API PROD")
  ]);
  const signer = group("Certificado firmador del Ministerio de Hacienda", [
    { name: "MH_CERT_XML_PART_1 + MH_CERT_XML_PART_2", label: "Archivo .crt/.xml", configured: hasSignerCertificate(env), protected: true },
    protectedItem(env, "MH_CERT_PASSWORD", "Contraseña de llave privada")
  ]);
  const issuer = group("Emisor", [
    visibleItem(env, "EMISOR_CONFIG_JSON", "Configuración JSON")
  ]);
  const wompi = group("Webhook entrante de Wompi", [
    protectedItem(env, "WOMPI_API_SECRET", "Firma del webhook entrante")
  ]);
  const emailProviderUrl = visibleItem(env, "EMAIL_PROVIDER_URL", "Endpoint POST JSON de respaldo administrado por el despliegue");
  const emailApiKey = protectedItem(env, "EMAIL_API_KEY", "Token bearer de respaldo");
  const emailFrom = visibleItem(env, "EMAIL_FROM", "Remitente");
  const email = {
    label: "Correo",
    ready: emailFrom.configured && (isTrue(env.EMAIL_ARBITRARY_RECIPIENTS) || hasHttpProvider(env)),
    items: [
      { name: "EMAIL", label: "Vinculación de correo Cloudflare", configured: Boolean(env.EMAIL) },
      { name: "EMAIL_ARBITRARY_RECIPIENTS", label: "Cloudflare a donantes externos", configured: isTrue(env.EMAIL_ARBITRARY_RECIPIENTS), displayValue: isTrue(env.EMAIL_ARBITRARY_RECIPIENTS) ? "true" : undefined },
      emailProviderUrl,
      emailApiKey,
      emailFrom
    ]
  };
  const allowedAmbiente = deploymentEnvironmentPolicy(env).allowedAmbiente;
  const mhGroups: Record<string, SecretStatusGroup> = allowedAmbiente === "00"
    ? { mhTest }
    : allowedAmbiente === "01"
      ? { mhProduction }
      : {};

  return {
    target: {
      appEnv: env.APP_ENV ?? "unknown",
      scriptName: nonEmpty(env.CLOUDFLARE_SCRIPT_NAME) ? env.CLOUDFLARE_SCRIPT_NAME.trim() : null,
      writerConfigured: writerMissing.length === 0,
      writerMissing
    },
    groups: { ...mhGroups, signer, issuer, wompi, email },
    certificateExpiresAt: readCertificateExpiresAt(env)
  };
}

// Absent/misconfigured cert secrets must never break the credentials status
// response: getMhCertificateXml throws when MH_CERT_XML(_PART_*) are missing.
function readCertificateExpiresAt(env: Env): string | null {
  try {
    return certificateExpiry(getMhCertificateXml(env)).expiresAt;
  } catch {
    return null;
  }
}

export function buildCredentialSecretPatch(input: CredentialUpdateInput): SecretPatch {
  const patch: SecretPatch = {};
  const mhUserName = input.environment === "production" ? "MH_USER_PROD" : "MH_USER_TEST";
  const mhPasswordName = input.environment === "production" ? "MH_PASSWORD_PROD" : "MH_PASSWORD_TEST";

  putIfPresent(patch, mhUserName, input.mhUser);
  putIfPresent(patch, mhPasswordName, input.mhPassword);
  putIfPresent(patch, "MH_CERT_PASSWORD", input.certificatePassword);
  putIfPresent(patch, "EMISOR_CONFIG_JSON", input.emisorConfigJson);
  putIfPresent(patch, "WOMPI_API_SECRET", input.wompiSecret);
  putIfPresent(patch, "EMAIL_API_KEY", input.emailApiKey);
  putIfPresent(patch, "EMAIL_FROM", input.emailFrom);

  const certificateXml = trim(input.certificateXml);
  if (certificateXml) {
    const splitAt = Math.ceil(certificateXml.length / 2);
    patch.MH_CERT_XML = null;
    patch.MH_CERT_XML_PART_1 = secret("MH_CERT_XML_PART_1", certificateXml.slice(0, splitAt));
    patch.MH_CERT_XML_PART_2 = secret("MH_CERT_XML_PART_2", certificateXml.slice(splitAt));
  }

  return patch;
}

export async function patchCloudflareWorkerSecrets(env: Env, patch: SecretPatch): Promise<{ updated: string[]; deleted: string[] }> {
  if (!hasCloudflareWriter(env)) {
    throw new CredentialWriterConfigError();
  }
  return patchCloudflareWorkerSecretsWithToken(env, patch, env.CLOUDFLARE_API_TOKEN!.trim());
}

export async function bootstrapCloudflareWriterToken(env: Env, token: string): Promise<{ updated: string[]; deleted: string[] }> {
  const trimmed = token.trim();
  if (!trimmed) {
    throw new CredentialWriterConfigError("Ingrese el token API de Cloudflare.");
  }
  const missing = cloudflareWriterTargetMissing(env);
  if (missing.length > 0) {
    throw new CredentialWriterConfigError(`Faltan ${missing.join(", ")} para guardar secretos en Cloudflare.`);
  }
  return patchCloudflareWorkerSecretsWithToken(env, { CLOUDFLARE_API_TOKEN: secret("CLOUDFLARE_API_TOKEN", trimmed) }, trimmed);
}

async function patchCloudflareWorkerSecretsWithToken(env: Env, patch: SecretPatch, apiToken: string): Promise<{ updated: string[]; deleted: string[] }> {
  const response = await fetch(`${env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4"}/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID!.trim())}/workers/scripts/${encodeURIComponent(env.CLOUDFLARE_SCRIPT_NAME!.trim())}/secrets-bulk`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ secrets: patch })
  });
  const body = (await response.json().catch(() => ({}))) as { success?: boolean; errors?: Array<{ message?: string }> };
  if (!response.ok || body.success !== true) {
    const detail = body.errors?.map((error) => error.message).filter(Boolean).join("; ");
    throw new Error(`Falló la actualización de secretos en Cloudflare: ${detail || response.status}`);
  }
  return {
    updated: Object.entries(patch).filter(([, value]) => value !== null).map(([name]) => name),
    deleted: Object.entries(patch).filter(([, value]) => value === null).map(([name]) => name)
  };
}

function group(label: string, items: SecretStatusItem[]): SecretStatusGroup {
  return {
    label,
    ready: items.every((status) => status.configured),
    items
  };
}

function protectedItem(env: Env, name: keyof Env, label: string): SecretStatusItem {
  return { name: String(name), label, configured: nonEmpty(env[name]), protected: true };
}

function visibleItem(env: Env, name: keyof Env, label: string): SecretStatusItem {
  const value = env[name];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return {
    name: String(name),
    label,
    configured: trimmed.length > 0,
    displayValue: trimmed.length > 0 ? trimmed : undefined
  };
}

function hasSignerCertificate(env: Env): boolean {
  return nonEmpty(env.MH_CERT_XML) || (nonEmpty(env.MH_CERT_XML_PART_1) && nonEmpty(env.MH_CERT_XML_PART_2));
}

function hasCloudflareWriter(env: Env): boolean {
  return cloudflareWriterMissing(env).length === 0;
}

function cloudflareWriterMissing(env: Env): string[] {
  const missing = cloudflareWriterTargetMissing(env);
  if (!nonEmpty(env.CLOUDFLARE_API_TOKEN)) missing.push("CLOUDFLARE_API_TOKEN");
  return missing;
}

function cloudflareWriterTargetMissing(env: Env): string[] {
  const missing: string[] = [];
  if (!nonEmpty(env.CLOUDFLARE_ACCOUNT_ID)) missing.push("CLOUDFLARE_ACCOUNT_ID");
  if (!nonEmpty(env.CLOUDFLARE_SCRIPT_NAME)) missing.push("CLOUDFLARE_SCRIPT_NAME");
  return missing;
}

function hasHttpProvider(env: Env): boolean {
  const raw = env.EMAIL_PROVIDER_URL?.trim();
  if (!raw || !nonEmpty(env.EMAIL_API_KEY)) return false;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

function isTrue(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "true";
}

function putIfPresent(patch: SecretPatch, name: string, value: string | undefined): void {
  const trimmed = trim(value);
  if (trimmed) {
    patch[name] = secret(name, trimmed);
  }
}

function secret(name: string, text: string): SecretText {
  return { type: "secret_text", name, text };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function trim(value: string | undefined): string {
  return value?.trim() ?? "";
}
