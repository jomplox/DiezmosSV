import type Stripe from "stripe";
import type { StripeGiftFrequency, StripeGiftType } from "../storage/repository/stripeDonations";

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
  paymentMethodConfigurationId: string;
  billingPortalConfigurationId: string;
  legalName: string;
  ein: string;
  livemode: boolean;
  mock: boolean;
}

export interface StripeConfigurationEnv {
  APP_ENV?: string;
  STRIPE_RESTRICTED_KEY?: string;
  STRIPE_API_PROXY_URL?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PAYMENT_METHOD_CONFIGURATION_ID?: string;
  STRIPE_BILLING_PORTAL_CONFIGURATION_ID?: string;
  STRIPE_US_LEGAL_NAME?: string;
  STRIPE_US_EIN?: string;
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
      paymentMethodConfigurationId: "pmc_mock",
      billingPortalConfigurationId: "bpc_mock",
      legalName: "Nonprofit Test Fixture",
      ein: "00-0000000",
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
  if (!webhookSecret.startsWith("whsec_")) {
    throw new StripeConfigurationError("invalid_webhook_secret");
  }
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
  const legalName = requiredValue(env.STRIPE_US_LEGAL_NAME, "missing_legal_name");
  if (legalName.length > 200) {
    throw new StripeConfigurationError("invalid_legal_name");
  }
  const ein = requiredValue(env.STRIPE_US_EIN, "missing_ein");
  if (!EIN_PATTERN.test(ein) || ein === "00-0000000") {
    throw new StripeConfigurationError("invalid_ein");
  }
  return {
    apiKey,
    apiProxyUrl,
    publishableKey,
    webhookSecret,
    paymentMethodConfigurationId,
    billingPortalConfigurationId,
    legalName,
    ein,
    livemode,
    mock: false
  };
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

function requiredValue(value: unknown, code: string): string {
  const normalized = stringValue(value);
  if (!normalized) {
    throw new StripeConfigurationError(code);
  }
  return normalized;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
