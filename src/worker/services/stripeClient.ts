import Stripe from "stripe";
import {
  STRIPE_API_VERSION,
  type StripeRuntimeConfiguration
} from "./stripeDonations";

const MOCK_EXPIRES_AT = 1_786_370_400;

export interface StripeCheckoutSnapshot {
  id: string;
  url: string | null;
  clientSecret: string | null;
  livemode: boolean;
  status: "complete" | "expired" | "open" | null;
  paymentStatus: "no_payment_required" | "paid" | "unpaid";
  mode: "payment" | "setup" | "subscription";
  amountTotal: number | null;
  currency: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  paymentIntentId: string | null;
  donorName: string | null;
  donorEmail: string | null;
  metadata: Record<string, string>;
  expiresAt: number;
}

export interface StripeGateway {
  createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
    idempotencyKey: string
  ): Promise<StripeCheckoutSnapshot>;
  retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSnapshot>;
  createBillingPortalSession(input: {
    customerId: string;
    configurationId: string;
    returnUrl: string;
  }): Promise<{ url: string }>;
  constructWebhookEvent(
    rawBody: string,
    signature: string,
    receivedAtSeconds?: number
  ): Promise<Stripe.Event>;
}

export class StripeWebhookSignatureError extends Error {
  constructor() {
    super("Stripe webhook signature rejected");
    this.name = "StripeWebhookSignatureError";
  }
}

export function createStripeGateway(configuration: StripeRuntimeConfiguration): StripeGateway {
  const proxy = configuration.apiProxyUrl ? new URL(configuration.apiProxyUrl) : null;
  const stripe = new Stripe(configuration.apiKey, {
    apiVersion: STRIPE_API_VERSION,
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
    telemetry: false,
    ...(proxy ? {
      host: proxy.hostname,
      port: proxy.port,
      protocol: "http" as const
    } : {})
  });
  return configuration.mock
    ? new MockStripeGateway(stripe, webhookSecrets(configuration))
    : new ApiStripeGateway(stripe, webhookSecrets(configuration));
}

function webhookSecrets(configuration: StripeRuntimeConfiguration): string[] {
  return configuration.webhookSecretNext
    ? [configuration.webhookSecret, configuration.webhookSecretNext]
    : [configuration.webhookSecret];
}

class ApiStripeGateway implements StripeGateway {
  constructor(
    private readonly stripe: Stripe,
    private readonly webhookSecrets: string[]
  ) {}

  async createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
    idempotencyKey: string
  ): Promise<StripeCheckoutSnapshot> {
    const session = await this.stripe.checkout.sessions.create(params, { idempotencyKey });
    return checkoutSnapshot(session);
  }

  async retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSnapshot> {
    return checkoutSnapshot(await this.stripe.checkout.sessions.retrieve(sessionId));
  }

  async createBillingPortalSession(input: {
    customerId: string;
    configurationId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const session = await this.stripe.billingPortal.sessions.create({
      customer: input.customerId,
      configuration: input.configurationId,
      locale: "es",
      return_url: input.returnUrl
    });
    return { url: session.url };
  }

  async constructWebhookEvent(
    rawBody: string,
    signature: string,
    receivedAtSeconds?: number
  ): Promise<Stripe.Event> {
    for (const webhookSecret of this.webhookSecrets) {
      try {
        return await this.stripe.webhooks.constructEventAsync(
          rawBody,
          signature,
          webhookSecret,
          Stripe.webhooks.DEFAULT_TOLERANCE,
          Stripe.createSubtleCryptoProvider(),
          receivedAtSeconds
        );
      } catch {
        // The caller receives one generic rejection after all configured rotation
        // candidates fail. Never log or expose which secret matched.
      }
    }
    throw new StripeWebhookSignatureError();
  }
}

class MockStripeGateway extends ApiStripeGateway {
  private readonly sessions = new Map<string, StripeCheckoutSnapshot>();

  async createCheckoutSession(
    params: Stripe.Checkout.SessionCreateParams,
    _idempotencyKey: string
  ): Promise<StripeCheckoutSnapshot> {
    const checkoutId = params.client_reference_id;
    if (!checkoutId) {
      throw new Error("Mock Stripe Checkout requires a client reference");
    }
    const id = `cs_test_${checkoutId}`;
    const existing = this.sessions.get(id);
    if (existing) {
      return existing;
    }
    const firstLineItem = params.line_items?.[0];
    const snapshot: StripeCheckoutSnapshot = {
      id,
      url: null,
      clientSecret: `${id}_secret_mock`,
      livemode: false,
      status: "open",
      paymentStatus: "unpaid",
      mode: checkoutMode(params.mode),
      amountTotal: firstLineItem?.price_data?.unit_amount ?? null,
      currency: firstLineItem?.price_data?.currency ?? null,
      customerId: null,
      subscriptionId: null,
      paymentIntentId: null,
      donorName: null,
      donorEmail: null,
      metadata: stringMetadata(params.metadata),
      expiresAt: MOCK_EXPIRES_AT
    };
    this.sessions.set(id, snapshot);
    return snapshot;
  }

  async retrieveCheckoutSession(sessionId: string): Promise<StripeCheckoutSnapshot> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }
    if (!/^cs_test_stripe_checkout_[A-Za-z0-9_-]+$/.test(sessionId)) {
      throw new Error("Mock Stripe Checkout Session was not found");
    }
    return {
      id: sessionId,
      url: null,
      clientSecret: `${sessionId}_secret_mock`,
      livemode: false,
      status: "open",
      paymentStatus: "unpaid",
      mode: "payment",
      amountTotal: null,
      currency: "usd",
      customerId: null,
      subscriptionId: null,
      paymentIntentId: null,
      donorName: null,
      donorEmail: null,
      metadata: {},
      expiresAt: MOCK_EXPIRES_AT
    };
  }

  async createBillingPortalSession(input: {
    customerId: string;
    configurationId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    if (!input.configurationId.startsWith("bpc_") || !input.returnUrl) {
      throw new Error("Mock Stripe Portal configuration rejected");
    }
    return { url: `https://billing.stripe.test/session/${encodeURIComponent(input.customerId)}` };
  }
}

function checkoutSnapshot(session: Stripe.Checkout.Session): StripeCheckoutSnapshot {
  return {
    id: session.id,
    url: session.url,
    clientSecret: session.client_secret,
    livemode: session.livemode,
    status: session.status,
    paymentStatus: checkoutPaymentStatus(session.payment_status),
    mode: checkoutMode(session.mode),
    amountTotal: session.amount_total,
    currency: session.currency,
    customerId: externalId(session.customer),
    subscriptionId: externalId(session.subscription),
    paymentIntentId: externalId(session.payment_intent),
    donorName: session.customer_details?.name ?? null,
    donorEmail: session.customer_details?.email ?? session.customer_email ?? null,
    metadata: stringMetadata(session.metadata),
    expiresAt: session.expires_at
  };
}

function externalId(value: string | { id: string } | null): string | null {
  return typeof value === "string" ? value : value?.id ?? null;
}

function checkoutMode(value: string | null | undefined): StripeCheckoutSnapshot["mode"] {
  if (value === "setup" || value === "subscription") {
    return value;
  }
  return "payment";
}

function checkoutPaymentStatus(value: string): StripeCheckoutSnapshot["paymentStatus"] {
  if (value === "paid" || value === "no_payment_required") {
    return value;
  }
  return "unpaid";
}

function stringMetadata(
  metadata: Stripe.Metadata | Stripe.MetadataParam | null | undefined
): Record<string, string> {
  if (!metadata) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value === "string") {
      result[key] = value;
    } else if (typeof value === "number") {
      result[key] = String(value);
    }
  }
  return result;
}
