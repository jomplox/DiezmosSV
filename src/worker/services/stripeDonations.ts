import type Stripe from "stripe";
import {
  STRIPE_US_LEGAL_NAME_MAX_LENGTH,
  STRIPE_US_MAILING_ADDRESS_LINE_MAX_LENGTH,
  STRIPE_US_SIGNER_NAME_MAX_LENGTH,
  STRIPE_US_SIGNER_TITLE_MAX_LENGTH,
  STRIPE_US_WEBSITE_MAX_LENGTH,
  stripeUsConfiguredLegalNameForDisplay
} from "../../shared/stripeUsConfiguration";
import type { StripeGiftFrequency, StripeGiftType } from "../storage/repository/stripeDonations";
import { sha256Hex, utf8Bytes } from "../utils/encoding";

const MIN_AMOUNT_CENTS = 100;
const MAX_AMOUNT_CENTS = 500_000;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EIN_PATTERN = /^\d{2}-\d{7}$/;

export const STRIPE_API_VERSION = "2026-07-29.dahlia" as const;

export class StripeDonationValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "StripeDonationValidationError";
  }
}

export class StripeConfigurationError extends Error {
  constructor(readonly code: string) {
    super(`Stripe configuration rejected: ${code}`);
    this.name = "StripeConfigurationError";
  }
}

export interface ValidatedStripeCheckoutInput {
  requestId: string;
  amountCents: number;
  frequency: StripeGiftFrequency;
  giftType: Exclude<StripeGiftType, "UNSPECIFIED">;
}

export interface StripeRuntimeConfiguration {
  apiKey: string;
  apiProxyUrl: string | null;
  publishableKey: string;
  webhookSecret: string;
  webhookSecretNext: string | null;
  paymentMethodConfigurationId: string;
  billingPortalConfigurationId: string;
  legalName: string;
  ein: string;
  organizationPhone: string;
  organizationWebsite: string;
  organizationMailingAddress: string[];
  signerName: string;
  signerTitle: string;
  livemode: boolean;
  mock: boolean;
}

export interface StripeConfigurationEnv {
  APP_ENV?: string;
  STRIPE_RESTRICTED_KEY?: string;
  STRIPE_API_PROXY_URL?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_WEBHOOK_SECRET_NEXT?: string;
  STRIPE_PAYMENT_METHOD_CONFIGURATION_ID?: string;
  STRIPE_BILLING_PORTAL_CONFIGURATION_ID?: string;
  STRIPE_US_LEGAL_NAME?: string;
  STRIPE_US_EIN?: string;
  STRIPE_US_PHONE?: string;
  STRIPE_US_WEBSITE?: string;
  STRIPE_US_MAILING_ADDRESS?: string;
  STRIPE_US_SIGNER_NAME?: string;
  STRIPE_US_SIGNER_TITLE?: string;
  STRIPE_MOCK_MODE?: string;
}

export function validateStripeCheckoutInput(body: unknown): ValidatedStripeCheckoutInput {
  if (!isRecord(body)) {
    throw new StripeDonationValidationError("invalid_body", "Revise los datos de su entrega.");
  }
  const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
  if (!REQUEST_ID_PATTERN.test(requestId)) {
    throw new StripeDonationValidationError(
      "invalid_request_id",
      "No pudimos preparar su entrega. Actualice la página e inténtelo de nuevo."
    );
  }
  const amountText = typeof body.amount === "string" ? body.amount.trim() : null;
  const amount = typeof body.amount === "number"
    ? body.amount
    : amountText !== null && /^\d+(?:\.\d{1,2})?$/.test(amountText)
      ? Number(amountText)
      : Number.NaN;
  const scaledAmount = amount * 100;
  const amountCents = Math.round(scaledAmount);
  const hasWholeCents = typeof body.amount !== "number"
    || Math.abs(scaledAmount - amountCents) < 1e-7;
  if (
    !Number.isFinite(amount)
    || !Number.isSafeInteger(amountCents)
    || !hasWholeCents
    || amountCents < MIN_AMOUNT_CENTS
    || amountCents > MAX_AMOUNT_CENTS
  ) {
    throw new StripeDonationValidationError(
      "invalid_amount",
      "El monto debe estar entre $1.00 y $5,000.00."
    );
  }
  const frequency = body.frequency === "once"
    ? "ONCE"
    : body.frequency === "monthly"
      ? "MONTHLY"
      : null;
  if (!frequency) {
    throw new StripeDonationValidationError(
      "invalid_frequency",
      "Seleccione si desea realizar una entrega única o mensual."
    );
  }
  const giftType = body.giftType === "tithe"
    ? "TITHE"
    : body.giftType === "offering"
      ? "OFFERING"
      : null;
  if (!giftType) {
    throw new StripeDonationValidationError(
      "invalid_gift_type",
      "Seleccione si su entrega es diezmo u ofrenda."
    );
  }
  return { requestId, amountCents, frequency, giftType };
}

export async function integrationIdentifierForRequest(requestId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`diezmossv-stripe:${requestId}`)
  ));
  let suffix = "";
  for (const byte of digest.subarray(0, 8)) {
    suffix += String.fromCharCode(97 + (byte % 26));
  }
  return `diezmossv_${suffix}`;
}

export function buildStripeCheckoutSessionParams(input: {
  checkoutId: string;
  requestId: string;
  amountCents: number;
  frequency: StripeGiftFrequency;
  giftType: Exclude<StripeGiftType, "UNSPECIFIED">;
  organizationName: string;
  appOrigin: string;
  paymentMethodConfigurationId: string;
  integrationIdentifier: string;
}): Stripe.Checkout.SessionCreateParams {
  const origin = normalizedAppOrigin(input.appOrigin);
  const frequency = input.frequency === "MONTHLY" ? "monthly" : "once";
  const metadata: Stripe.MetadataParam = {
    checkout_id: input.checkoutId,
    frequency,
    gift_type: input.giftType === "TITHE" ? "tithe" : "offering",
    lane: "eeuu_501c3"
  };
  const priceData: Stripe.Checkout.SessionCreateParams.LineItem.PriceData = {
    currency: "usd",
    unit_amount: input.amountCents,
    product_data: {
      name: `Donación a ${cleanOrganizationName(input.organizationName)}`,
      description: input.frequency === "MONTHLY" ? "Entrega mensual" : "Entrega única"
    }
  };
  if (input.frequency === "MONTHLY") {
    priceData.recurring = { interval: "month" };
  }

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: input.frequency === "MONTHLY" ? "subscription" : "payment",
    ui_mode: "embedded_page",
    locale: "es-419",
    redirect_on_completion: "always",
    submit_type: "donate",
    branding_settings: {
      background_color: "#ffffff",
      button_color: "#000000",
      border_style: "rounded"
    },
    client_reference_id: input.checkoutId,
    integration_identifier: input.integrationIdentifier,
    payment_method_configuration: input.paymentMethodConfigurationId,
    billing_address_collection: "required",
    name_collection: { individual: { enabled: true } },
    phone_number_collection: { enabled: true },
    return_url: `${origin}/donar/stripe/resultado?session_id={CHECKOUT_SESSION_ID}`,
    metadata,
    line_items: [{ quantity: 1, price_data: priceData }]
  };
  if (input.frequency === "MONTHLY") {
    params.subscription_data = { metadata };
  } else {
    params.customer_creation = "always";
    params.payment_intent_data = { metadata };
  }
  return params;
}

export async function stripeCheckoutRequestFingerprint(
  params: Stripe.Checkout.SessionCreateParams,
  configuration: StripeRuntimeConfiguration
): Promise<string> {
  const accountKeyDigest = await sha256Hex(utf8Bytes(configuration.apiKey));
  const canonical = stableJson({
    api_version: STRIPE_API_VERSION,
    account_key_sha256: accountKeyDigest,
    api_proxy_url: configuration.apiProxyUrl,
    publishable_key: configuration.publishableKey,
    livemode: configuration.livemode,
    mock: configuration.mock,
    params
  });
  return `v2:${await sha256Hex(utf8Bytes(canonical))}`;
}

export function resolveStripeConfiguration(
  env: StripeConfigurationEnv
): StripeRuntimeConfiguration {
  const appEnv = stringValue(env.APP_ENV).toLowerCase();
  if (!new Set(["local", "staging", "production"]).has(appEnv)) {
    throw new StripeConfigurationError("invalid_app_environment");
  }
  const mock = stringValue(env.STRIPE_MOCK_MODE) === "1";
  if (mock) {
    if (appEnv === "production") {
      throw new StripeConfigurationError("mock_mode_forbidden");
    }
    return {
      apiKey: "rk_test_mock",
      apiProxyUrl: null,
      publishableKey: "pk_test_mock",
      webhookSecret: "whsec_mock",
      webhookSecretNext: optionalWebhookSecret(env.STRIPE_WEBHOOK_SECRET_NEXT),
      paymentMethodConfigurationId: "pmc_mock",
      billingPortalConfigurationId: "bpc_mock",
      legalName: "Nonprofit Test Fixture",
      ein: "00-0000000",
      organizationPhone: "+1 555 555 0100",
      organizationWebsite: "https://example.org",
      organizationMailingAddress: ["100 Example Avenue", "New York, NY 10001, USA"],
      signerName: "Authorized Representative",
      signerTitle: "Treasurer",
      livemode: false,
      mock: true
    };
  }

  const apiKey = requiredValue(env.STRIPE_RESTRICTED_KEY, "missing_restricted_key");
  const apiProxyUrl = resolveLocalStripeApiProxy(env.STRIPE_API_PROXY_URL, appEnv);
  const publishableKey = requiredValue(env.STRIPE_PUBLISHABLE_KEY, "missing_publishable_key");
  const livemode = appEnv === "production";
  if (!apiKey.startsWith("rk_")) {
    throw new StripeConfigurationError("restricted_key_required");
  }
  if (livemode ? !apiKey.startsWith("rk_live_") : !apiKey.startsWith("rk_test_")) {
    throw new StripeConfigurationError("key_environment_mismatch");
  }
  if (livemode ? !publishableKey.startsWith("pk_live_") : !publishableKey.startsWith("pk_test_")) {
    throw new StripeConfigurationError("publishable_key_environment_mismatch");
  }
  const webhookSecret = requiredValue(env.STRIPE_WEBHOOK_SECRET, "missing_webhook_secret");
  if (!webhookSecret.startsWith("whsec_") || webhookSecret.length <= "whsec_".length) {
    throw new StripeConfigurationError("invalid_webhook_secret");
  }
  const webhookSecretNext = optionalWebhookSecret(env.STRIPE_WEBHOOK_SECRET_NEXT);
  const paymentMethodConfigurationId = requiredValue(
    env.STRIPE_PAYMENT_METHOD_CONFIGURATION_ID,
    "missing_payment_method_configuration"
  );
  if (!paymentMethodConfigurationId.startsWith("pmc_")) {
    throw new StripeConfigurationError("invalid_payment_method_configuration");
  }
  const billingPortalConfigurationId = requiredValue(
    env.STRIPE_BILLING_PORTAL_CONFIGURATION_ID,
    "missing_billing_portal_configuration"
  );
  if (!billingPortalConfigurationId.startsWith("bpc_")) {
    throw new StripeConfigurationError("invalid_billing_portal_configuration");
  }
  const configuredLegalName = requiredValue(env.STRIPE_US_LEGAL_NAME, "missing_legal_name");
  if (configuredLegalName.length > STRIPE_US_LEGAL_NAME_MAX_LENGTH) {
    throw new StripeConfigurationError("invalid_legal_name");
  }
  const legalName = stripeUsConfiguredLegalNameForDisplay(env.STRIPE_US_LEGAL_NAME);
  const ein = requiredValue(env.STRIPE_US_EIN, "missing_ein");
  if (!EIN_PATTERN.test(ein) || ein === "00-0000000") {
    throw new StripeConfigurationError("invalid_ein");
  }
  const organizationPhone = requiredValue(env.STRIPE_US_PHONE, "missing_us_phone");
  if (organizationPhone.length < 7 || organizationPhone.length > 40 || hasControlCharacters(organizationPhone)) {
    throw new StripeConfigurationError("invalid_us_phone");
  }
  const organizationWebsite = validatedOrganizationWebsite(env.STRIPE_US_WEBSITE);
  const organizationMailingAddress = validatedMailingAddress(env.STRIPE_US_MAILING_ADDRESS);
  const signerName = requiredValue(env.STRIPE_US_SIGNER_NAME, "missing_us_signer_name");
  if (signerName.length > STRIPE_US_SIGNER_NAME_MAX_LENGTH || hasControlCharacters(signerName)) {
    throw new StripeConfigurationError("invalid_us_signer_name");
  }
  const signerTitle = requiredValue(env.STRIPE_US_SIGNER_TITLE, "missing_us_signer_title");
  if (signerTitle.length > STRIPE_US_SIGNER_TITLE_MAX_LENGTH || hasControlCharacters(signerTitle)) {
    throw new StripeConfigurationError("invalid_us_signer_title");
  }
  return {
    apiKey,
    apiProxyUrl,
    publishableKey,
    webhookSecret,
    webhookSecretNext,
    paymentMethodConfigurationId,
    billingPortalConfigurationId,
    legalName,
    ein,
    organizationPhone,
    organizationWebsite,
    organizationMailingAddress,
    signerName,
    signerTitle,
    livemode,
    mock: false
  };
}

function validatedOrganizationWebsite(value: string | undefined): string {
  const configured = requiredValue(value, "missing_us_website");
  if (configured.length > STRIPE_US_WEBSITE_MAX_LENGTH || hasControlCharacters(configured)) {
    throw new StripeConfigurationError("invalid_us_website");
  }
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error("invalid");
    }
  } catch {
    throw new StripeConfigurationError("invalid_us_website");
  }
  return configured;
}

function validatedMailingAddress(value: string | undefined): string[] {
  const configured = requiredValue(value, "missing_us_mailing_address");
  if (configured.length > 600 || hasControlCharacters(configured.replace(/\r?\n/gu, ""))) {
    throw new StripeConfigurationError("invalid_us_mailing_address");
  }
  const lines = configured.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2 || lines.length > 4 || lines.some((line) => line.length > STRIPE_US_MAILING_ADDRESS_LINE_MAX_LENGTH)) {
    throw new StripeConfigurationError("invalid_us_mailing_address");
  }
  return lines;
}

function hasControlCharacters(value: string): boolean {
  return /[\u0000-\u001f\u007f-\u009f]/u.test(value);
}

function resolveLocalStripeApiProxy(value: string | undefined, appEnv: string): string | null {
  const configured = stringValue(value);
  if (!configured) {
    return null;
  }
  if (appEnv !== "local") {
    throw new StripeConfigurationError("local_api_proxy_forbidden");
  }
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new StripeConfigurationError("invalid_local_api_proxy");
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "http:"
    || !new Set(["127.0.0.1", "localhost"]).has(parsed.hostname)
    || !Number.isInteger(port)
    || port < 1024
    || port > 65_535
    || parsed.username
    || parsed.password
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new StripeConfigurationError("invalid_local_api_proxy");
  }
  return parsed.origin;
}

function normalizedAppOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new StripeConfigurationError("invalid_app_origin");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  if ((parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:"))
    || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new StripeConfigurationError("invalid_app_origin");
  }
  return parsed.origin;
}

function cleanOrganizationName(value: string): string {
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || normalized.length > 120) {
    throw new StripeConfigurationError("invalid_organization_name");
  }
  return normalized;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function requiredValue(value: unknown, code: string): string {
  const normalized = stringValue(value);
  if (!normalized) {
    throw new StripeConfigurationError(code);
  }
  return normalized;
}

function optionalWebhookSecret(value: unknown): string | null {
  const secret = stringValue(value) || null;
  if (secret && (!secret.startsWith("whsec_") || secret.length <= "whsec_".length)) {
    throw new StripeConfigurationError("invalid_next_webhook_secret");
  }
  return secret;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
