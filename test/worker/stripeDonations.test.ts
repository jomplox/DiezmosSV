import { describe, expect, it } from "vitest";
import {
  StripeConfigurationError,
  StripeDonationValidationError,
  buildStripeCheckoutSessionParams,
  integrationIdentifierForRequest,
  resolveStripeConfiguration,
  validateStripeCheckoutInput
} from "../../src/worker/services/stripeDonations";

const requestId = "0c2e2165-edb7-4e4b-bc50-95a7fa3cdfe5";

describe("Stripe Checkout donation contract", () => {
  it("validates one-time and monthly USD gifts using the established amount bounds", () => {
    expect(validateStripeCheckoutInput({
      requestId,
      amount: "50.25",
      frequency: "once",
      giftType: "tithe"
    })).toEqual({ requestId, amountCents: 5025, frequency: "ONCE", giftType: "TITHE" });
    expect(validateStripeCheckoutInput({
      requestId,
      amount: 25,
      frequency: "monthly",
      giftType: "offering"
    })).toEqual({ requestId, amountCents: 2500, frequency: "MONTHLY", giftType: "OFFERING" });

    for (const body of [
      { requestId: "not-a-uuid", amount: 50, frequency: "once" },
      { requestId, amount: 0, frequency: "once" },
      { requestId, amount: "25junk", frequency: "once" },
      { requestId, amount: "1.001", frequency: "once" },
      { requestId, amount: 1.001, frequency: "once" },
      { requestId, amount: 5000.01, frequency: "once" },
      { requestId, amount: 50, frequency: "weekly", giftType: "tithe" },
      { requestId, amount: 50, frequency: "once" },
      { requestId, amount: 50, frequency: "once", giftType: "UNSPECIFIED" }
    ]) {
      expect(() => validateStripeCheckoutInput(body)).toThrow(StripeDonationValidationError);
    }
  });

  it("builds a Spanish Embedded Checkout one-time donation Session with dynamic methods", async () => {
    const integrationIdentifier = await integrationIdentifierForRequest(requestId);
    const params = buildStripeCheckoutSessionParams({
      checkoutId: "stripe_checkout_fixture",
      requestId,
      amountCents: 5025,
      frequency: "ONCE",
      giftType: "TITHE",
      organizationName: "Organización de Prueba",
      appOrigin: "https://donations.example.invalid",
      paymentMethodConfigurationId: "pmc_fixture",
      integrationIdentifier
    });

    expect(params).toMatchObject({
      mode: "payment",
      locale: "es-419",
      ui_mode: "embedded_page",
      redirect_on_completion: "always",
      submit_type: "donate",
      branding_settings: {
        background_color: "#ffffff",
        button_color: "#000000",
        border_style: "rounded"
      },
      client_reference_id: "stripe_checkout_fixture",
      payment_method_configuration: "pmc_fixture",
      billing_address_collection: "required",
      customer_creation: "always",
      name_collection: { individual: { enabled: true } },
      phone_number_collection: { enabled: true },
      return_url: "https://donations.example.invalid/donar/stripe/resultado?session_id={CHECKOUT_SESSION_ID}",
      metadata: {
        checkout_id: "stripe_checkout_fixture",
        frequency: "once",
        gift_type: "tithe",
        lane: "eeuu_501c3"
      },
      payment_intent_data: {
        metadata: {
          checkout_id: "stripe_checkout_fixture",
          frequency: "once",
          gift_type: "tithe",
          lane: "eeuu_501c3"
        }
      },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: 5025,
          product_data: {
            name: "Donación a Organización de Prueba",
            description: "Entrega única"
          }
        }
      }]
    });
    expect(params.integration_identifier).toMatch(/^diezmossv_[a-z]{8}$/);
    expect(params).not.toHaveProperty("success_url");
    expect(params).not.toHaveProperty("cancel_url");
    expect(params).not.toHaveProperty("origin_context");
    expect(params).not.toHaveProperty("payment_method_types");
    expect(JSON.stringify(params)).not.toMatch(/affirm|afterpay|clearpay|klarna/i);
  });

  it("uses subscription mode and inline monthly pricing without creating a payment Customer option", async () => {
    const params = buildStripeCheckoutSessionParams({
      checkoutId: "stripe_checkout_monthly",
      requestId,
      amountCents: 10000,
      frequency: "MONTHLY",
      giftType: "OFFERING",
      organizationName: "Organización de Prueba",
      appOrigin: "https://donations.example.invalid/",
      paymentMethodConfigurationId: "pmc_fixture",
      integrationIdentifier: await integrationIdentifierForRequest(requestId)
    });

    expect(params.mode).toBe("subscription");
    expect(params).not.toHaveProperty("customer_creation");
    expect(params).not.toHaveProperty("payment_intent_data");
    expect(params.subscription_data).toEqual({
      metadata: {
        checkout_id: "stripe_checkout_monthly",
        frequency: "monthly",
        gift_type: "offering",
        lane: "eeuu_501c3"
      }
    });
    expect(params.line_items?.[0]?.price_data).toMatchObject({
      currency: "usd",
      unit_amount: 10000,
      recurring: { interval: "month" },
      product_data: { description: "Entrega mensual" }
    });
  });

  it("derives a stable integration identifier without exposing the request UUID", async () => {
    const first = await integrationIdentifierForRequest(requestId);
    const replay = await integrationIdentifierForRequest(requestId);
    const different = await integrationIdentifierForRequest("993b9407-9e16-4915-90ec-7f95855b8fab");

    expect(first).toBe(replay);
    expect(first).not.toContain(requestId);
    expect(different).not.toBe(first);
  });

  it("fails closed across restricted-key, environment, webhook, legal, and configuration boundaries", () => {
    const valid = {
      APP_ENV: "staging",
      STRIPE_RESTRICTED_KEY: "rk_test_fixture",
      STRIPE_PUBLISHABLE_KEY: "pk_test_fixture",
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
      STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: "pmc_fixture",
      STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_fixture",
      STRIPE_US_LEGAL_NAME: "Example Nonprofit",
      STRIPE_US_EIN: "12-3456789"
    };
    expect(resolveStripeConfiguration(valid)).toEqual({
      apiKey: "rk_test_fixture",
      publishableKey: "pk_test_fixture",
      webhookSecret: "whsec_fixture",
      webhookSecretNext: null,
      paymentMethodConfigurationId: "pmc_fixture",
      billingPortalConfigurationId: "bpc_fixture",
      legalName: "Example Nonprofit",
      ein: "12-3456789",
      apiProxyUrl: null,
      livemode: false,
      mock: false
    });

    expect(resolveStripeConfiguration({
      ...valid,
      STRIPE_WEBHOOK_SECRET_NEXT: "whsec_next_fixture"
    }).webhookSecretNext).toBe("whsec_next_fixture");
    expect(() => resolveStripeConfiguration({
      ...valid,
      STRIPE_WEBHOOK_SECRET_NEXT: "invalid"
    })).toThrow(StripeConfigurationError);

    for (const override of [
      { STRIPE_RESTRICTED_KEY: "sk_test_not_restricted" },
      { STRIPE_RESTRICTED_KEY: "rk_live_wrong_environment" },
      { STRIPE_PUBLISHABLE_KEY: "invalid" },
      { STRIPE_PUBLISHABLE_KEY: "pk_live_wrong_environment" },
      { STRIPE_WEBHOOK_SECRET: "invalid" },
      { STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: "invalid" },
      { STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "invalid" },
      { STRIPE_US_LEGAL_NAME: "" },
      { STRIPE_US_LEGAL_NAME: "A".repeat(201) },
      { STRIPE_US_EIN: "invalid" },
      { STRIPE_US_EIN: "00-0000000" }
    ]) {
      expect(() => resolveStripeConfiguration({ ...valid, ...override }))
        .toThrow(StripeConfigurationError);
    }
    expect(() => resolveStripeConfiguration({
      ...valid,
      APP_ENV: "production"
    })).toThrow(StripeConfigurationError);
    expect(resolveStripeConfiguration({
      ...valid,
      APP_ENV: "production",
      STRIPE_RESTRICTED_KEY: "rk_live_fixture",
      STRIPE_PUBLISHABLE_KEY: "pk_live_fixture"
    }).livemode).toBe(true);
  });

  it("allows an HTTP loopback Stripe API bridge only in local development", () => {
    const valid = {
      APP_ENV: "local",
      STRIPE_RESTRICTED_KEY: "rk_test_fixture",
      STRIPE_PUBLISHABLE_KEY: "pk_test_fixture",
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
      STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: "pmc_fixture",
      STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_fixture",
      STRIPE_US_LEGAL_NAME: "Example Nonprofit",
      STRIPE_US_EIN: "12-3456789"
    };

    expect(resolveStripeConfiguration({
      ...valid,
      STRIPE_API_PROXY_URL: "http://127.0.0.1:8791"
    }).apiProxyUrl).toBe("http://127.0.0.1:8791");

    for (const override of [
      { APP_ENV: "staging", STRIPE_API_PROXY_URL: "http://127.0.0.1:8791" },
      { STRIPE_API_PROXY_URL: "https://127.0.0.1:8791" },
      { STRIPE_API_PROXY_URL: "http://localhost:8791/path" },
      { STRIPE_API_PROXY_URL: "http://example.com:8791" },
      { STRIPE_API_PROXY_URL: "http://user:secret@127.0.0.1:8791" }
    ]) {
      expect(() => resolveStripeConfiguration({ ...valid, ...override }))
        .toThrow(StripeConfigurationError);
    }
  });

  it("carries a syntactically valid staged webhook secret into mock verification overlap", () => {
    expect(resolveStripeConfiguration({
      APP_ENV: "local",
      STRIPE_MOCK_MODE: "1",
      STRIPE_WEBHOOK_SECRET_NEXT: "whsec_next_fixture"
    }).webhookSecretNext).toBe("whsec_next_fixture");
    expect(() => resolveStripeConfiguration({
      APP_ENV: "local",
      STRIPE_MOCK_MODE: "1",
      STRIPE_WEBHOOK_SECRET_NEXT: "invalid"
    })).toThrow(StripeConfigurationError);
  });

  it("permits deterministic mock mode only outside production", () => {
    expect(resolveStripeConfiguration({
      APP_ENV: "local",
      STRIPE_MOCK_MODE: "1"
    })).toMatchObject({ mock: true, livemode: false, publishableKey: "pk_test_mock" });
    expect(() => resolveStripeConfiguration({
      APP_ENV: "production",
      STRIPE_MOCK_MODE: "1"
    })).toThrow(StripeConfigurationError);
  });
});
