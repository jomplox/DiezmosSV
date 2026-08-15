import Stripe from "stripe";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStripeGateway,
  StripeWebhookSignatureError
} from "../../src/worker/services/stripeClient";
import {
  STRIPE_API_VERSION,
  buildStripeCheckoutSessionParams,
  integrationIdentifierForRequest,
  resolveStripeConfiguration
} from "../../src/worker/services/stripeDonations";
import { sha256Hex, utf8Bytes } from "../../src/worker/utils/encoding";

const requestId = "0c2e2165-edb7-4e4b-bc50-95a7fa3cdfe5";

function repeatedlyDecodeFormKey(key: string): string {
  let decoded = key;
  for (let attempts = 0; attempts < 8; attempts += 1) {
    try {
      const next = decodeURIComponent(decoded.replace(/\+/g, " "));
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function receiptEmailSerializedKeyPaths(serializedBody: string): string[] {
  return serializedBody.split("&").flatMap((entry) => {
    const rawKey = entry.split("=", 1)[0] ?? "";
    const key = repeatedlyDecodeFormKey(rawKey);
    const segments = key.match(/[^.\[\]]+/g) ?? [];
    return segments.some((segment) => repeatedlyDecodeFormKey(segment).toLowerCase() === "receipt_email")
      ? [key]
      : [];
  });
}

function receiptEmailBoundaryEvidence(serializedBody: string) {
  if (serializedBody.trim().length === 0) return { passes: false, paths: [] };
  const paths = receiptEmailSerializedKeyPaths(serializedBody);
  return { passes: paths.length === 0, paths };
}

function serializedStripeFetchBody(body: BodyInit | null | undefined): string {
  if (body == null) throw new Error("Stripe fetch request body is missing");

  const serialized = typeof body === "string"
    ? body
    : body instanceof URLSearchParams
      ? body.toString()
      : null;
  if (serialized === null) throw new Error("Stripe fetch request body type is unsupported");
  if (serialized.trim().length === 0) throw new Error("Stripe fetch request body is empty");
  return serialized;
}

describe("Stripe SDK boundary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails closed when serialized Stripe request evidence is empty", () => {
    expect(receiptEmailBoundaryEvidence("")).toEqual({ passes: false, paths: [] });
  });

  it("normalizes the supported Stripe fetch request body shapes", () => {
    expect(serializedStripeFetchBody("mode=payment")).toBe("mode=payment");
    expect(serializedStripeFetchBody(new URLSearchParams({ mode: "subscription" })))
      .toBe("mode=subscription");
  });

  it("rejects missing Stripe fetch request bodies", () => {
    for (const body of [undefined, null]) {
      expect(() => serializedStripeFetchBody(body)).toThrow("Stripe fetch request body is missing");
    }
  });

  it("rejects empty Stripe fetch request bodies", () => {
    for (const body of ["", new URLSearchParams()]) {
      expect(() => serializedStripeFetchBody(body)).toThrow("Stripe fetch request body is empty");
    }
  });

  it("rejects unsupported Stripe fetch request body shapes", () => {
    expect(() => serializedStripeFetchBody(new Uint8Array([1])))
      .toThrow("Stripe fetch request body type is unsupported");
  });

  it("creates and retrieves deterministic sandbox Checkout and Portal URLs", async () => {
    const gateway = createStripeGateway(resolveStripeConfiguration({
      APP_ENV: "local",
      STRIPE_MOCK_MODE: "1"
    }));
    const params = buildStripeCheckoutSessionParams({
      checkoutId: "stripe_checkout_fixture",
      requestId,
      amountCents: 5000,
      frequency: "MONTHLY",
      giftType: "TITHE",
      organizationName: "Organización de Prueba",
      appOrigin: "http://127.0.0.1:8787",
      paymentMethodConfigurationId: "pmc_mock",
      integrationIdentifier: await integrationIdentifierForRequest(requestId)
    });

    const created = await gateway.createCheckoutSession(params, `stripe-checkout:${requestId}`);
    expect(created).toMatchObject({
      id: "cs_test_stripe_checkout_fixture",
      clientReferenceId: "stripe_checkout_fixture",
      url: null,
      clientSecret: "cs_test_stripe_checkout_fixture_secret_mock",
      livemode: false,
      status: "open",
      paymentStatus: "unpaid",
      expiresAt: 1786370400
    });
    expect(await gateway.retrieveCheckoutSession(created.id)).toEqual(created);
    expect(await gateway.createBillingPortalSession({
      customerId: "cus_fixture",
      configurationId: "bpc_mock",
      returnUrl: "http://127.0.0.1:8787/donar/stripe/resultado?session_id=cs_test_fixture"
    })).toEqual({
      url: "https://billing.stripe.test/session/cus_fixture"
    });
  });

  it("verifies the exact raw webhook body with Stripe's signature scheme", async () => {
    const payload = JSON.stringify({
      id: "evt_fixture",
      object: "event",
      api_version: STRIPE_API_VERSION,
      created: 1786363200,
      data: { object: { id: "cs_test_fixture", object: "checkout.session" } },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "checkout.session.completed"
    });
    const secret = "whsec_fixture";
    const signature = Stripe.webhooks.generateTestHeaderString({
      payload,
      secret,
      timestamp: 1786363200
    });
    const gateway = createStripeGateway({
      ...resolveStripeConfiguration({ APP_ENV: "local", STRIPE_MOCK_MODE: "1" }),
      webhookSecret: secret
    });

    await expect(gateway.constructWebhookEvent(
      payload,
      signature,
      1786363200
    )).resolves.toMatchObject({ event: { id: "evt_fixture", livemode: false } });
    await expect(gateway.constructWebhookEvent(
      `${payload} `,
      signature,
      1786363200
    )).rejects.toBeInstanceOf(StripeWebhookSignatureError);
  });

  it("accepts active and staged webhook signatures without revealing which secret matched", async () => {
    const payload = JSON.stringify({
      id: "evt_rotation_fixture",
      object: "event",
      api_version: STRIPE_API_VERSION,
      created: 1786363200,
      data: { object: { id: "cs_test_fixture", object: "checkout.session" } },
      livemode: false,
      pending_webhooks: 1,
      request: null,
      type: "checkout.session.completed"
    });
    const active = "whsec_active_fixture";
    const next = "whsec_next_fixture";
    const configuration = {
      ...resolveStripeConfiguration({ APP_ENV: "local", STRIPE_MOCK_MODE: "1" }),
      webhookSecret: active,
      webhookSecretNext: next
    };
    const gateway = createStripeGateway(configuration);
    const activeSignature = Stripe.webhooks.generateTestHeaderString({ payload, secret: active, timestamp: 1786363200 });
    const nextSignature = Stripe.webhooks.generateTestHeaderString({ payload, secret: next, timestamp: 1786363200 });

    await expect(gateway.constructWebhookEvent(payload, activeSignature, 1786363200))
      .resolves.toMatchObject({
        event: { id: "evt_rotation_fixture" },
        verification: { slot: "ACTIVE", generation: await sha256Hex(utf8Bytes(active)) }
      });
    await expect(gateway.constructWebhookEvent(payload, nextSignature, 1786363200))
      .resolves.toMatchObject({
        event: { id: "evt_rotation_fixture" },
        verification: { slot: "NEXT", generation: await sha256Hex(utf8Bytes(next)) }
      });
    const rejection = await gateway.constructWebhookEvent(payload, "t=1,v1=forged", 1786363200)
      .catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(StripeWebhookSignatureError);
    expect(String(rejection)).not.toContain("active");
    expect(String(rejection)).not.toContain("next");
  });

  it("routes Stripe API calls through the configured local-only bridge", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      id: "cs_test_proxy_fixture",
      object: "checkout.session",
      client_reference_id: "stripe_checkout_proxy",
      client_secret: "cs_test_proxy_fixture_secret_fixture",
      url: null,
      livemode: false,
      status: "open",
      payment_status: "unpaid",
      mode: "payment",
      amount_total: 5000,
      currency: "usd",
      customer: null,
      subscription: null,
      payment_intent: null,
      customer_details: null,
      customer_email: null,
      metadata: {},
      expires_at: 1786370400
    }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Request-Id": "req_proxy_fixture" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const gateway = createStripeGateway(resolveStripeConfiguration({
      APP_ENV: "local",
      STRIPE_RESTRICTED_KEY: "rk_test_fixture",
      STRIPE_PUBLISHABLE_KEY: "pk_test_fixture",
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
      STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: "pmc_fixture",
      STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_fixture",
      STRIPE_US_LEGAL_NAME: "Example Nonprofit",
      STRIPE_US_EIN: "12-3456789",
      STRIPE_US_PHONE: "+1 (555) 010-0200",
      STRIPE_US_WEBSITE: "https://example.org",
      STRIPE_US_MAILING_ADDRESS: "100 Example Street\nExample City, NY 10001, USA",
      STRIPE_US_SIGNER_NAME: "Example Treasurer",
      STRIPE_US_SIGNER_TITLE: "Treasurer",
      STRIPE_API_PROXY_URL: "http://127.0.0.1:8791"
    }));
    const params = buildStripeCheckoutSessionParams({
      checkoutId: "stripe_checkout_proxy",
      requestId,
      amountCents: 5000,
      frequency: "ONCE",
      giftType: "TITHE",
      organizationName: "Organización de Prueba",
      appOrigin: "http://127.0.0.1:8787",
      paymentMethodConfigurationId: "pmc_fixture",
      integrationIdentifier: await integrationIdentifierForRequest(requestId)
    });

    await expect(gateway.createCheckoutSession(params, `stripe-checkout:${requestId}`))
      .resolves.toMatchObject({
        id: "cs_test_proxy_fixture",
        clientReferenceId: "stripe_checkout_proxy",
        amountTotal: 5000
      });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:8791/v1/checkout/sessions");
  });

  it("keeps every serialized one-time and monthly Checkout request free of receipt-email paths", async () => {
    const serializedBodies: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      serializedBodies.push(serializedStripeFetchBody(init?.body));
      return new Response(JSON.stringify({
        id: "cs_test_serialized_fixture",
        object: "checkout.session",
        client_reference_id: "stripe_checkout_serialized",
        client_secret: "cs_test_serialized_fixture_secret_fixture",
        url: null,
        livemode: false,
        status: "open",
        payment_status: "unpaid",
        mode: "payment",
        amount_total: 5000,
        currency: "usd",
        customer: null,
        subscription: null,
        payment_intent: null,
        customer_details: null,
        customer_email: null,
        metadata: {},
        expires_at: 1786370400
      }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Request-Id": "req_serialized_fixture" }
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const gateway = createStripeGateway(resolveStripeConfiguration({
      APP_ENV: "local",
      STRIPE_RESTRICTED_KEY: "rk_test_fixture",
      STRIPE_PUBLISHABLE_KEY: "pk_test_fixture",
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
      STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: "pmc_fixture",
      STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_fixture",
      STRIPE_US_LEGAL_NAME: "Example Nonprofit",
      STRIPE_US_EIN: "12-3456789",
      STRIPE_US_PHONE: "+1 (555) 010-0200",
      STRIPE_US_WEBSITE: "https://example.org",
      STRIPE_US_MAILING_ADDRESS: "100 Example Street\nExample City, NY 10001, USA",
      STRIPE_US_SIGNER_NAME: "Example Treasurer",
      STRIPE_US_SIGNER_TITLE: "Treasurer",
      STRIPE_API_PROXY_URL: "http://127.0.0.1:8791"
    }));
    const integrationIdentifier = await integrationIdentifierForRequest(requestId);
    const oneTime = buildStripeCheckoutSessionParams({
      checkoutId: "stripe_checkout_serialized",
      requestId,
      amountCents: 5000,
      frequency: "ONCE",
      giftType: "TITHE",
      organizationName: "Organización de Prueba",
      appOrigin: "http://127.0.0.1:8787",
      paymentMethodConfigurationId: "pmc_fixture",
      integrationIdentifier
    });
    const monthly = buildStripeCheckoutSessionParams({
      checkoutId: "stripe_checkout_serialized_monthly",
      requestId,
      amountCents: 5000,
      frequency: "MONTHLY",
      giftType: "TITHE",
      organizationName: "Organización de Prueba",
      appOrigin: "http://127.0.0.1:8787",
      paymentMethodConfigurationId: "pmc_fixture",
      integrationIdentifier
    });

    for (const params of [oneTime, monthly]) {
      await gateway.createCheckoutSession(params, `stripe-checkout:${params.client_reference_id}`);
    }
    expect(serializedBodies.length).toBe(2);
    expect(serializedBodies.every((body) => body.trim().length > 0)).toBe(true);
    expect(serializedBodies.map((body) => new URLSearchParams(body).get("mode")))
      .toEqual(["payment", "subscription"]);
    expect(serializedBodies.map(receiptEmailBoundaryEvidence)).toEqual([
      { passes: true, paths: [] },
      { passes: true, paths: [] }
    ]);

    for (const [label, receiptParameter, expectedPath] of [
      ["case", { Receipt_Email: true }, "Receipt_Email"],
      ["nested case", { payment_intent_data: { Receipt_Email: true } }, "payment_intent_data[Receipt_Email]"],
      ["encoded brackets", { "customer%5Bmetadata%5D%5Breceipt_email%5D": true }, "customer[metadata][receipt_email]"],
      ["encoded underscore", { "customer[metadata][receipt%5Femail]": true }, "customer[metadata][receipt_email]"],
      ["dot path", { "payment_intent_data.receipt_email": true }, "payment_intent_data.receipt_email"],
      ["array path", { "receipt_email[]": true }, "receipt_email[]"]
    ] as const) {
      await gateway.createCheckoutSession(
        { ...oneTime, ...receiptParameter } as unknown as Stripe.Checkout.SessionCreateParams,
        `stripe-checkout:${label}`
      );
      expect(receiptEmailBoundaryEvidence(serializedBodies.at(-1)!))
        .toEqual({ passes: false, paths: [expectedPath] });
    }
  });
});
