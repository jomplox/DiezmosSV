import type { Env } from "../types";

type CredentialEnvironment = "test" | "production";

export interface CredentialUpdateInput {
  environment: CredentialEnvironment;
  mhUser?: string;
  mhPassword?: string;
  certificateXml?: string;
  certificatePassword?: string;
  emisorConfigJson?: string;
  wompiSecret?: string;
  emailApiUrl?: string;
  emailApiKey?: string;
  emailFrom?: string;
}

export interface SecretStatusItem {
  name: string;
  label: string;
  configured: boolean;
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
  };
  groups: {
    mhTest: SecretStatusGroup;
    mhProduction: SecretStatusGroup;
    signer: SecretStatusGroup;
    issuer: SecretStatusGroup;
    wompi: SecretStatusGroup;
    email: SecretStatusGroup;
  };
}

interface SecretText {
  type: "secret_text";
  name: string;
  text: string;
}

export type SecretPatch = Record<string, SecretText | null>;

export class CredentialWriterConfigError extends Error {
  constructor(message = "Cloudflare secret writer is not configured for this Worker") {
    super(message);
    this.name = "CredentialWriterConfigError";
  }
}

export function credentialStatus(env: Env): CredentialStatus {
  const mhTest = group("MH ambiente de pruebas", [
    item(env, "MH_USER_TEST", "Usuario API TEST"),
    item(env, "MH_PASSWORD_TEST", "Password API TEST")
  ]);
  const mhProduction = group("MH ambiente produccion", [
    item(env, "MH_USER_PROD", "Usuario API PROD"),
    item(env, "MH_PASSWORD_PROD", "Password API PROD")
  ]);
  const signer = group("Certificado firmador", [
    { name: "MH_CERT_XML_PART_1 + MH_CERT_XML_PART_2", label: "Certificado XML", configured: hasSignerCertificate(env) },
    item(env, "MH_CERT_PASSWORD", "Password llave privada")
  ]);
  const issuer = group("Emisor", [
    item(env, "EMISOR_CONFIG_JSON", "Config JSON")
  ]);
  const wompi = group("Wompi", [
    item(env, "WOMPI_API_SECRET", "Webhook HMAC")
  ]);
  const emailFrom = item(env, "EMAIL_FROM", "Remitente");
  const email = {
    label: "Correo",
    ready: emailFrom.configured && (isTrue(env.EMAIL_ARBITRARY_RECIPIENTS) || hasHttpProvider(env)),
    items: [
      { name: "EMAIL", label: "Cloudflare Email Service binding", configured: Boolean(env.EMAIL) },
      { name: "EMAIL_ARBITRARY_RECIPIENTS", label: "Cloudflare a donantes externos", configured: isTrue(env.EMAIL_ARBITRARY_RECIPIENTS) },
      { name: "EMAIL_API_URL + EMAIL_API_KEY", label: "Fallback HTTP sin verificacion de destinatario", configured: hasHttpProvider(env) },
      emailFrom
    ]
  };

  return {
    target: {
      appEnv: env.APP_ENV ?? "unknown",
      scriptName: nonEmpty(env.CLOUDFLARE_SCRIPT_NAME) ? env.CLOUDFLARE_SCRIPT_NAME.trim() : null,
      writerConfigured: hasCloudflareWriter(env)
    },
    groups: { mhTest, mhProduction, signer, issuer, wompi, email }
  };
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
  putIfPresent(patch, "EMAIL_API_URL", input.emailApiUrl);
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
  const response = await fetch(`${env.CLOUDFLARE_API_BASE_URL ?? "https://api.cloudflare.com/client/v4"}/accounts/${encodeURIComponent(env.CLOUDFLARE_ACCOUNT_ID!.trim())}/workers/scripts/${encodeURIComponent(env.CLOUDFLARE_SCRIPT_NAME!.trim())}/secrets-bulk`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN!.trim()}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ secrets: patch })
  });
  const body = (await response.json().catch(() => ({}))) as { success?: boolean; errors?: Array<{ message?: string }> };
  if (!response.ok || body.success !== true) {
    const detail = body.errors?.map((error) => error.message).filter(Boolean).join("; ");
    throw new Error(`Cloudflare secret update failed: ${detail || response.status}`);
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

function item(env: Env, name: keyof Env, label: string): SecretStatusItem {
  return { name: String(name), label, configured: nonEmpty(env[name]) };
}

function hasSignerCertificate(env: Env): boolean {
  return nonEmpty(env.MH_CERT_XML) || (nonEmpty(env.MH_CERT_XML_PART_1) && nonEmpty(env.MH_CERT_XML_PART_2));
}

function hasCloudflareWriter(env: Env): boolean {
  return nonEmpty(env.CLOUDFLARE_ACCOUNT_ID) && nonEmpty(env.CLOUDFLARE_SCRIPT_NAME) && nonEmpty(env.CLOUDFLARE_API_TOKEN);
}

function hasHttpProvider(env: Env): boolean {
  return nonEmpty(env.EMAIL_API_URL) && nonEmpty(env.EMAIL_API_KEY);
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
