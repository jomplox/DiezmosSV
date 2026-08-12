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

export interface StripeCredentialUpdateInput {
  restrictedKey?: string;
  publishableKey?: string;
  paymentMethodConfigurationId?: string;
  billingPortalConfigurationId?: string;
  legalName?: string;
  ein?: string;
  timeZone?: string;
}

interface SecretStatusItem {
  name: string;
  label: string;
  configured: boolean;
  displayValue?: string;
  protected?: boolean;
}

interface SecretStatusGroup {
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
  stripeOperational: {
    appEnv: string;
    mode: "Simulado" | "Pruebas" | "Producción";
    mockMode: boolean;
    localProxyConfigured: boolean;
  };
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

export class StripeCredentialValidationError extends Error {
  constructor(readonly code: string) {
    super(`Stripe credential update rejected: ${code}`);
    this.name = "StripeCredentialValidationError";
  }
}

export function credentialStatus(env: Env): CredentialStatus {
  const writerMissing = cloudflareWriterMissing(env);
  const mhTest = group("Ministerio de Hacienda ambiente de pruebas", [
    protectedItem(env, "MH_USER_TEST", "Usuario API TEST"),
    protectedItem(env, "MH_PASSWORD_TEST", "Contraseña API TEST")
  ]);
  const mhProduction = group("Ministerio de Hacienda ambiente producción", [
    protectedItem(env, "MH_USER_PROD", "Usuario API PROD"),
    protectedItem(env, "MH_PASSWORD_PROD", "Contraseña API PROD")
  ]);
  const signer = group("Certificado firmador del Ministerio de Hacienda", [
    { name: "MH_CERT_XML_PART_1 + MH_CERT_XML_PART_2", label: "Archivo .crt/.xml", configured: hasSignerCertificate(env), protected: true },
    protectedItem(env, "MH_CERT_PASSWORD", "Contraseña de llave privada")
  ]);
  const issuer = group("Emisor", [
    protectedItem(env, "EMISOR_CONFIG_JSON", "Configuración JSON")
  ]);
  const wompi = group("Webhook entrante de Wompi", [
    protectedItem(env, "WOMPI_API_SECRET", "Firma del webhook entrante")
  ]);
  const emailProviderUrl = visibleItem(env, "EMAIL_PROVIDER_URL", "Endpoint POST JSON alternativo administrado por el despliegue");
  const emailApiKey = protectedItem(env, "EMAIL_API_KEY", "Token bearer alternativo");
  const emailFrom = visibleItem(env, "EMAIL_FROM", "Remitente");
  const email = {
    label: "Correo",
    ready: emailFrom.configured && (
      (Boolean(env.EMAIL) && isTrue(env.EMAIL_ARBITRARY_RECIPIENTS)) || hasHttpProvider(env)
    ),
    items: [
      { name: "EMAIL", label: "Vinculación de correo Cloudflare", configured: Boolean(env.EMAIL) },
      { name: "EMAIL_ARBITRARY_RECIPIENTS", label: "Cloudflare a donantes externos", configured: isTrue(env.EMAIL_ARBITRARY_RECIPIENTS), displayValue: isTrue(env.EMAIL_ARBITRARY_RECIPIENTS) ? "true" : undefined },
      emailProviderUrl,
      emailApiKey,
      emailFrom
    ]
  };
  const stripeItems = [
    protectedItem(env, "STRIPE_RESTRICTED_KEY", "Clave restringida"),
    protectedItem(env, "STRIPE_PUBLISHABLE_KEY", "Clave publicable"),
    protectedItem(env, "STRIPE_WEBHOOK_SECRET", "Secreto activo del webhook"),
    protectedItem(env, "STRIPE_WEBHOOK_SECRET_NEXT", "Secreto siguiente del webhook"),
    protectedItem(env, "STRIPE_PAYMENT_METHOD_CONFIGURATION_ID", "Configuración de métodos de entrega"),
    protectedItem(env, "STRIPE_BILLING_PORTAL_CONFIGURATION_ID", "Configuración del portal de entregas mensuales"),
    protectedItem(env, "STRIPE_US_LEGAL_NAME", "Nombre legal de la 501(c)(3)"),
    protectedItem(env, "STRIPE_US_EIN", "EIN de la 501(c)(3)"),
    visibleItem(env, "STRIPE_US_TIME_ZONE", "Zona horaria de EE. UU.")
  ];
  const stripeRequiredNames = new Set(stripeItems.map((item) => item.name).filter((name) => name !== "STRIPE_WEBHOOK_SECRET_NEXT"));
  const stripeMockMode = trim(env.STRIPE_MOCK_MODE) === "1";
  const stripe = {
    label: "Stripe EE. UU.",
    ready: stripeMockMode || stripeItems.every((item) => !stripeRequiredNames.has(item.name) || item.configured),
    items: stripeItems
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
    groups: { ...mhGroups, signer, issuer, wompi, stripe, email },
    certificateExpiresAt: readCertificateExpiresAt(env),
    stripeOperational: {
      appEnv: env.APP_ENV ?? "unknown",
      mode: stripeMockMode ? "Simulado" : env.APP_ENV === "production" ? "Producción" : "Pruebas",
      mockMode: stripeMockMode,
      localProxyConfigured: nonEmpty(env.STRIPE_API_PROXY_URL)
    }
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

export function buildStripeCredentialSecretPatch(
  input: StripeCredentialUpdateInput,
  env: Env
): SecretPatch {
  const patch: SecretPatch = {};
  const restrictedKey = trim(input.restrictedKey);
  const publishableKey = trim(input.publishableKey);
  const paymentMethodConfigurationId = trim(input.paymentMethodConfigurationId);
  const billingPortalConfigurationId = trim(input.billingPortalConfigurationId);
  const legalName = trim(input.legalName);
  const ein = trim(input.ein);
  const timeZone = trim(input.timeZone);
  const appEnv = trim(env.APP_ENV);
  if (!new Set(["local", "staging", "production"]).has(appEnv)) {
    throw new StripeCredentialValidationError("invalid_app_environment");
  }
  const expectedMode = appEnv === "production" ? "live" : "test";

  if (restrictedKey && !hasPrefixedValue(restrictedKey, `rk_${expectedMode}_`)) {
    throw new StripeCredentialValidationError("invalid_restricted_key");
  }
  if (publishableKey && !hasPrefixedValue(publishableKey, `pk_${expectedMode}_`)) {
    throw new StripeCredentialValidationError("invalid_publishable_key");
  }
  if (restrictedKey || publishableKey) {
    const effectiveRestrictedKey = restrictedKey || trim(env.STRIPE_RESTRICTED_KEY);
    const effectivePublishableKey = publishableKey || trim(env.STRIPE_PUBLISHABLE_KEY);
    if (effectiveRestrictedKey && !hasPrefixedValue(effectiveRestrictedKey, `rk_${expectedMode}_`)) {
      throw new StripeCredentialValidationError("restricted_key_environment_mismatch");
    }
    if (effectivePublishableKey && !hasPrefixedValue(effectivePublishableKey, `pk_${expectedMode}_`)) {
      throw new StripeCredentialValidationError("publishable_key_environment_mismatch");
    }
  }
  if (paymentMethodConfigurationId && !hasPrefixedValue(paymentMethodConfigurationId, "pmc_")) {
    throw new StripeCredentialValidationError("invalid_payment_method_configuration");
  }
  if (billingPortalConfigurationId && !hasPrefixedValue(billingPortalConfigurationId, "bpc_")) {
    throw new StripeCredentialValidationError("invalid_billing_portal_configuration");
  }
  if (legalName && (legalName.length > 200 || /[\u0000-\u001f\u007f-\u009f]/u.test(legalName))) {
    throw new StripeCredentialValidationError("invalid_legal_name");
  }
  if (ein && (!/^\d{2}-\d{7}$/.test(ein) || ein === "00-0000000")) {
    throw new StripeCredentialValidationError("invalid_ein");
  }
  if (timeZone && !isIanaTimeZone(timeZone)) {
    throw new StripeCredentialValidationError("invalid_time_zone");
  }

  putIfPresent(patch, "STRIPE_RESTRICTED_KEY", restrictedKey);
  putIfPresent(patch, "STRIPE_PUBLISHABLE_KEY", publishableKey);
  putIfPresent(patch, "STRIPE_PAYMENT_METHOD_CONFIGURATION_ID", paymentMethodConfigurationId);
  putIfPresent(patch, "STRIPE_BILLING_PORTAL_CONFIGURATION_ID", billingPortalConfigurationId);
  putIfPresent(patch, "STRIPE_US_LEGAL_NAME", legalName);
  putIfPresent(patch, "STRIPE_US_EIN", ein);
  putIfPresent(patch, "STRIPE_US_TIME_ZONE", timeZone);
  return patch;
}

export function buildStripeWebhookStagePatch(value: string): SecretPatch {
  const nextSecret = trim(value);
  if (!nextSecret.startsWith("whsec_") || nextSecret.length <= "whsec_".length) {
    throw new StripeCredentialValidationError("invalid_webhook_secret");
  }
  return { STRIPE_WEBHOOK_SECRET_NEXT: secret("STRIPE_WEBHOOK_SECRET_NEXT", nextSecret) };
}

export function buildStripeWebhookPromotionPatch(env: Env): SecretPatch {
  const activeSecret = trim(env.STRIPE_WEBHOOK_SECRET);
  const nextSecret = trim(env.STRIPE_WEBHOOK_SECRET_NEXT);
  if (!activeSecret || !nextSecret) {
    throw new StripeCredentialValidationError("missing_staged_webhook_secret");
  }
  const staged = buildStripeWebhookStagePatch(nextSecret).STRIPE_WEBHOOK_SECRET_NEXT;
  return {
    STRIPE_WEBHOOK_SECRET: secret("STRIPE_WEBHOOK_SECRET", staged!.text),
    STRIPE_WEBHOOK_SECRET_NEXT: secret("STRIPE_WEBHOOK_SECRET_NEXT", activeSecret)
  };
}

export function buildStripeWebhookCancellationPatch(): SecretPatch {
  return { STRIPE_WEBHOOK_SECRET_NEXT: null };
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

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function hasPrefixedValue(value: string, prefix: string): boolean {
  return value.startsWith(prefix) && value.length > prefix.length;
}

function trim(value: string | undefined): string {
  return value?.trim() ?? "";
}
