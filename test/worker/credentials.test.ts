import { describe, expect, it, vi } from "vitest";
import {
  StripeCredentialValidationError,
  bootstrapCloudflareWriterToken,
  buildCredentialSecretPatch,
  buildStripeCredentialSecretPatch,
  buildStripeWebhookPromotionPatch,
  buildStripeWebhookStagePatch,
  credentialStatus
} from "../../src/worker/services/credentials";
import type { CredentialUpdateInput } from "../../src/worker/services/credentials";
import type { Env } from "../../src/worker/types";

describe("credential status", () => {
  it("reports every Stripe runtime value without serializing protected values", () => {
    const status = credentialStatus(env({
      APP_ENV: "staging",
      STRIPE_RESTRICTED_KEY: "rk_test_private",
      STRIPE_PUBLISHABLE_KEY: "pk_test_private",
      STRIPE_WEBHOOK_SECRET: "whsec_active_private",
      STRIPE_WEBHOOK_SECRET_NEXT: "whsec_next_private",
      STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: "pmc_private",
      STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_private",
      STRIPE_US_LEGAL_NAME: "Private Legal Name",
      STRIPE_US_EIN: "12-3456789",
      STRIPE_US_TIME_ZONE: "America/New_York",
      STRIPE_US_PHONE: "+1 555 010 0100",
      STRIPE_US_WEBSITE: "https://example.org",
      STRIPE_US_MAILING_ADDRESS: "100 Test Avenue\nNew York, NY 10001, USA",
      STRIPE_US_SIGNER_NAME: "Test Signer",
      STRIPE_US_SIGNER_TITLE: "Treasurer",
      STRIPE_API_PROXY_URL: "http://127.0.0.1:8791"
    }));

    expect(status.groups.stripe.ready).toBe(true);
    expect(status.groups.stripe.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "STRIPE_RESTRICTED_KEY", configured: true, protected: true }),
      expect.objectContaining({ name: "STRIPE_PUBLISHABLE_KEY", configured: true, protected: true }),
      expect.objectContaining({ name: "STRIPE_WEBHOOK_SECRET", configured: true, protected: true }),
      expect.objectContaining({ name: "STRIPE_WEBHOOK_SECRET_NEXT", configured: true, protected: true }),
      expect.objectContaining({ name: "STRIPE_PAYMENT_METHOD_CONFIGURATION_ID", configured: true, protected: true }),
      expect.objectContaining({ name: "STRIPE_BILLING_PORTAL_CONFIGURATION_ID", configured: true, protected: true }),
      expect.objectContaining({ name: "STRIPE_US_LEGAL_NAME", configured: true, protected: true }),
      expect.objectContaining({ name: "STRIPE_US_EIN", configured: true, protected: true }),
      expect.objectContaining({
        name: "STRIPE_US_TIME_ZONE",
        configured: true,
        displayValue: "America/New_York"
      }),
      expect.objectContaining({ name: "STRIPE_US_PHONE", configured: true, protected: true }),
      expect.objectContaining({ name: "STRIPE_US_WEBSITE", configured: true, protected: true }),
      expect.objectContaining({ name: "STRIPE_US_MAILING_ADDRESS", configured: true, protected: true }),
      expect.objectContaining({ name: "STRIPE_US_SIGNER_NAME", configured: true, protected: true }),
      expect.objectContaining({ name: "STRIPE_US_SIGNER_TITLE", configured: true, protected: true })
    ]));
    expect(status.stripeOperational).toEqual({
      appEnv: "staging",
      mode: "Pruebas",
      mockMode: false,
      localProxyConfigured: true
    });
    const serialized = JSON.stringify(status);
    for (const protectedValue of [
      "rk_test_private", "pk_test_private", "whsec_active_private", "whsec_next_private",
      "pmc_private", "bpc_private", "Private Legal Name", "12-3456789",
      "+1 555 010 0100", "https://example.org", "100 Test Avenue", "Test Signer", "Treasurer"
    ]) {
      expect(serialized).not.toContain(protectedValue);
    }
  });

  it("labels the exact local Stripe mock flag as simulated readiness", () => {
    const status = credentialStatus(env({ APP_ENV: "local", STRIPE_MOCK_MODE: "1" }));

    expect(status.groups.stripe.ready).toBe(true);
    expect(status.stripeOperational).toMatchObject({ mode: "Simulado", mockMode: true });
  });

  it("reports readiness, exposes allowlisted operational values, and keeps deployment credentials write-only", () => {
    const status = credentialStatus(env({
      APP_ENV: "staging",
      CLOUDFLARE_SCRIPT_NAME: "diezmossv-staging-example",
      CLOUDFLARE_API_TOKEN: "secret-token",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      MH_USER_TEST: "0614",
      MH_PASSWORD_TEST: "test-password",
      MH_USER_PROD: "0614",
      MH_PASSWORD_PROD: "prod-password",
      MH_CERT_XML_PART_1: "<CertificadoMH>",
      MH_CERT_XML_PART_2: "</CertificadoMH>",
      MH_CERT_PASSWORD: "cert-password",
      EMISOR_CONFIG_JSON: "{\"nombre\":\"MISION EXAMPLEORGANIZATION\"}",
      WOMPI_API_SECRET: "wompi-secret",
      EMAIL: { send: async () => ({ messageId: "message-1" }) } as SendEmail,
      EMAIL_PROVIDER_URL: "https://mail.example/send",
      EMAIL_API_KEY: "email-key",
      EMAIL_FROM: "dte@example.org"
    }));

    expect(status.target).toEqual({
      appEnv: "staging",
      scriptName: "diezmossv-staging-example",
      writerConfigured: true,
      writerMissing: []
    });
    expect(status.groups.mhTest.ready).toBe(true);
    expect(status.groups.mhProduction).toBeUndefined();
    expect(status.groups.signer.ready).toBe(true);
    expect(status.groups.mhTest.label).toBe("Ministerio de Hacienda ambiente de pruebas");
    expect(status.groups.signer.label).toBe("Certificado firmador del Ministerio de Hacienda");
    expect(status.groups.issuer.ready).toBe(true);
    expect(status.groups.email.ready).toBe(true);
    expect(status.groups.mhTest.items).toContainEqual({
      name: "MH_USER_TEST",
      label: "Usuario API TEST",
      configured: true,
      protected: true
    });
    expect(status.groups.issuer.items).toContainEqual({
      name: "EMISOR_CONFIG_JSON",
      label: "Configuración JSON",
      configured: true,
      protected: true
    });
    expect(status.groups.email.items).toContainEqual({
      name: "EMAIL_PROVIDER_URL",
      label: "Endpoint POST JSON alternativo administrado por el despliegue",
      configured: true,
      displayValue: "https://mail.example/send"
    });
    expect(status.groups.email.items).toContainEqual({
      name: "EMAIL_FROM",
      label: "Remitente",
      configured: true,
      displayValue: "dte@example.org"
    });
    expect(JSON.stringify(status)).not.toContain("secret-token");
    expect(JSON.stringify(status)).not.toContain("test-password");
    expect(JSON.stringify(status)).not.toContain("cert-password");
    expect(JSON.stringify(status)).not.toContain("<CertificadoMH>");
    expect(JSON.stringify(status)).not.toContain("wompi-secret");
    expect(JSON.stringify(status)).not.toContain("email-key");
    expect(JSON.stringify(status)).not.toContain("0614");
    expect(JSON.stringify(status)).not.toContain("MISION EXAMPLEORGANIZATION");
  });

  it.each([
    "http://mail.example/send",
    "https://user:password@mail.example/send",
    "not-a-url"
  ])("reports an unsafe email provider destination as not ready: %s", (providerUrl) => {
    const status = credentialStatus(env({
      EMAIL_PROVIDER_URL: providerUrl,
      EMAIL_API_KEY: "email-key",
      EMAIL_FROM: "dte@example.org"
    }));

    expect(status.groups.email.ready).toBe(false);
  });

  it("requires the Cloudflare binding as well as the arbitrary-recipient marker", () => {
    const withoutBinding = credentialStatus(env({
      EMAIL_ARBITRARY_RECIPIENTS: "true",
      EMAIL_FROM: "dte@example.org"
    }));
    const withBinding = credentialStatus(env({
      EMAIL: { send: async () => ({ messageId: "message-1" }) } as SendEmail,
      EMAIL_ARBITRARY_RECIPIENTS: "true",
      EMAIL_FROM: "dte@example.org"
    }));

    expect(withoutBinding.groups.email.ready).toBe(false);
    expect(withBinding.groups.email.ready).toBe(true);
  });

  it("exposes only the production MH credential lane on a production deployment", () => {
    const status = credentialStatus(env({
      APP_ENV: "production",
      MH_USER_TEST: "test-user-must-not-be-visible",
      MH_PASSWORD_TEST: "test-password-must-not-be-visible",
      MH_USER_PROD: "prod-user",
      MH_PASSWORD_PROD: "prod-password"
    }));

    expect(status.groups.mhTest).toBeUndefined();
    expect(status.groups.mhProduction).toMatchObject({ ready: true });
    expect(JSON.stringify(status)).not.toContain("test-user-must-not-be-visible");
  });

  it("exposes no MH credential lane when APP_ENV is missing or unknown", () => {
    for (const appEnv of [undefined, "preview"] as const) {
      const status = credentialStatus(env({ APP_ENV: appEnv, MH_USER_TEST: "test-user", MH_USER_PROD: "prod-user" }));

      expect(status.groups.mhTest).toBeUndefined();
      expect(status.groups.mhProduction).toBeUndefined();
    }
  });

  it("exposes the signer certificate expiry when the certificate carries a validity block", () => {
    const notAfterSeconds = 1794097629;
    const certXml = `<CertificadoMH><activo>true</activo><certificado><basicEstructure><validity><notAfter><epochSecond>${notAfterSeconds}</epochSecond></notAfter></validity></basicEstructure></certificado></CertificadoMH>`;
    const status = credentialStatus(env({ MH_CERT_XML: certXml }));

    expect(status.certificateExpiresAt).toBe(new Date(notAfterSeconds * 1000).toISOString());
  });

  it("reports a null certificate expiry without throwing when no certificate secret is configured", () => {
    const status = credentialStatus(env({}));

    expect(status.certificateExpiresAt).toBeNull();
  });

  it("reports a null certificate expiry without throwing when the configured certificate has no validity block", () => {
    const status = credentialStatus(env({ MH_CERT_XML: "<CertificadoMH><activo>true</activo></CertificadoMH>" }));

    expect(status.certificateExpiresAt).toBeNull();
  });
});

describe("credential secret patch", () => {
  it("maps only nonblank Stripe replacements and never permits direct active-webhook replacement", () => {
    const patch = buildStripeCredentialSecretPatch({
      restrictedKey: " rk_test_new ",
      publishableKey: "pk_test_new",
      paymentMethodConfigurationId: "pmc_new",
      billingPortalConfigurationId: "bpc_new",
      legalName: " Example Nonprofit ",
      ein: "12-3456789",
      timeZone: "America/Chicago",
      organizationPhone: "+1 (786) 505-8446",
      organizationWebsite: "https://www.elim.click",
      organizationMailingAddress: "2885 Sanford Ave SW, PMB 41357\nGrandville, MI 49418, USA",
      signerName: "Mathieu Guély",
      signerTitle: "Treasurer",
      activeWebhookSecret: "whsec_must_be_ignored"
    } as never, env({ APP_ENV: "staging" }));

    expect(patch).toEqual({
      STRIPE_RESTRICTED_KEY: { type: "secret_text", name: "STRIPE_RESTRICTED_KEY", text: "rk_test_new" },
      STRIPE_PUBLISHABLE_KEY: { type: "secret_text", name: "STRIPE_PUBLISHABLE_KEY", text: "pk_test_new" },
      STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: { type: "secret_text", name: "STRIPE_PAYMENT_METHOD_CONFIGURATION_ID", text: "pmc_new" },
      STRIPE_BILLING_PORTAL_CONFIGURATION_ID: { type: "secret_text", name: "STRIPE_BILLING_PORTAL_CONFIGURATION_ID", text: "bpc_new" },
      STRIPE_US_LEGAL_NAME: { type: "secret_text", name: "STRIPE_US_LEGAL_NAME", text: "Example Nonprofit" },
      STRIPE_US_EIN: { type: "secret_text", name: "STRIPE_US_EIN", text: "12-3456789" },
      STRIPE_US_TIME_ZONE: { type: "secret_text", name: "STRIPE_US_TIME_ZONE", text: "America/Chicago" },
      STRIPE_US_PHONE: { type: "secret_text", name: "STRIPE_US_PHONE", text: "+1 (786) 505-8446" },
      STRIPE_US_WEBSITE: { type: "secret_text", name: "STRIPE_US_WEBSITE", text: "https://www.elim.click" },
      STRIPE_US_MAILING_ADDRESS: { type: "secret_text", name: "STRIPE_US_MAILING_ADDRESS", text: "2885 Sanford Ave SW, PMB 41357\nGrandville, MI 49418, USA" },
      STRIPE_US_SIGNER_NAME: { type: "secret_text", name: "STRIPE_US_SIGNER_NAME", text: "Mathieu Guély" },
      STRIPE_US_SIGNER_TITLE: { type: "secret_text", name: "STRIPE_US_SIGNER_TITLE", text: "Treasurer" }
    });
    expect(patch).not.toHaveProperty("STRIPE_WEBHOOK_SECRET");
    expect(patch).not.toHaveProperty("STRIPE_WEBHOOK_SECRET_NEXT");
  });

  it("validates Stripe prefixes, key mode, legal identity, and timezone against submitted and existing peers", () => {
    const staging = env({ APP_ENV: "staging", STRIPE_RESTRICTED_KEY: "rk_test_existing" });
    expect(buildStripeCredentialSecretPatch({ publishableKey: "pk_test_new" }, staging))
      .toEqual({ STRIPE_PUBLISHABLE_KEY: expect.objectContaining({ text: "pk_test_new" }) });

    for (const input of [
      { restrictedKey: "sk_test_broad" },
      { restrictedKey: "rk_live_wrong" },
      { publishableKey: "pk_live_wrong" },
      { paymentMethodConfigurationId: "acct_not_pmc" },
      { billingPortalConfigurationId: "pmc_not_bpc" },
      { legalName: "A".repeat(201) },
      { ein: "00-0000000" },
      { timeZone: "Mars/Olympus_Mons" },
      { organizationPhone: "short" },
      { organizationWebsite: "http://example.org" },
      { organizationMailingAddress: "one line only" },
      { signerName: "A".repeat(121) },
      { signerTitle: "A".repeat(121) }
    ]) {
      expect(() => buildStripeCredentialSecretPatch(input, staging)).toThrow(StripeCredentialValidationError);
    }
    expect(() => buildStripeCredentialSecretPatch(
      { restrictedKey: "rk_test_new" },
      env({ APP_ENV: "staging", STRIPE_PUBLISHABLE_KEY: "pk_live_existing" })
    )).toThrow(StripeCredentialValidationError);
    expect(() => buildStripeCredentialSecretPatch(
      { restrictedKey: "rk_test_new", publishableKey: "pk_live_new" },
      staging
    )).toThrow(StripeCredentialValidationError);
    expect(() => buildStripeCredentialSecretPatch(
      { restrictedKey: "rk_test_new" },
      env({ APP_ENV: "preview" })
    )).toThrow(StripeCredentialValidationError);
    expect(buildStripeCredentialSecretPatch(
      { timeZone: "America/New_York" },
      env({ APP_ENV: "staging", STRIPE_PUBLISHABLE_KEY: "pk_live_stale" })
    )).toEqual({
      STRIPE_US_TIME_ZONE: expect.objectContaining({ text: "America/New_York" })
    });
  });

  it("applies the renderer-safe Stripe contact maxima at the admin boundary", () => {
    const staging = env({ APP_ENV: "staging" });
    const maximum = {
      legalName: `LEGAL ${"L".repeat(74)}`,
      organizationWebsite: `https://example.org/${"w".repeat(80)}`,
      organizationMailingAddress: [1, 2, 3, 4].map((line) => `ADDRESS-${line} ${"A".repeat(70)}`).join("\n"),
      signerName: `SIGNER ${"S".repeat(53)}`,
      signerTitle: `TITLE ${"T".repeat(54)}`
    };
    expect(buildStripeCredentialSecretPatch(maximum, staging)).toMatchObject({
      STRIPE_US_LEGAL_NAME: expect.objectContaining({ text: maximum.legalName }),
      STRIPE_US_MAILING_ADDRESS: expect.objectContaining({ text: maximum.organizationMailingAddress })
    });
    for (const input of [
      { legalName: "L".repeat(81) },
      { organizationWebsite: `https://example.org/${"w".repeat(81)}` },
      { organizationMailingAddress: `A${"a".repeat(80)}\nSecond line` },
      { signerName: "S".repeat(61) },
      { signerTitle: "T".repeat(61) }
    ]) expect(() => buildStripeCredentialSecretPatch(input, staging)).toThrow(StripeCredentialValidationError);
  });

  it("refuses to blank a configured organization value and ignores blanks for unconfigured ones", () => {
    const configured = env({
      APP_ENV: "staging",
      STRIPE_US_LEGAL_NAME: "Example Nonprofit",
      STRIPE_US_EIN: "12-3456789",
      STRIPE_US_TIME_ZONE: "America/Chicago",
      STRIPE_US_PHONE: "+1 555 010 0100",
      STRIPE_US_WEBSITE: "https://example.org",
      STRIPE_US_MAILING_ADDRESS: "100 Test Avenue\nNew York, NY 10001, USA",
      STRIPE_US_SIGNER_NAME: "Test Signer",
      STRIPE_US_SIGNER_TITLE: "Treasurer"
    });
    const submitted = {
      legalName: "Example Nonprofit",
      ein: "12-3456789",
      timeZone: "America/Chicago",
      organizationPhone: "+1 555 010 0100",
      organizationWebsite: "https://example.org",
      organizationMailingAddress: "100 Test Avenue\nNew York, NY 10001, USA",
      signerName: "Test Signer",
      signerTitle: "Treasurer"
    };

    for (const [field, code] of [
      ["legalName", "blank_us_legal_name"],
      ["ein", "blank_us_ein"],
      ["timeZone", "blank_us_time_zone"],
      ["organizationPhone", "blank_us_phone"],
      ["organizationWebsite", "blank_us_website"],
      ["organizationMailingAddress", "blank_us_mailing_address"],
      ["signerName", "blank_us_signer_name"],
      ["signerTitle", "blank_us_signer_title"]
    ] as const) {
      expect(() => buildStripeCredentialSecretPatch({ ...submitted, [field]: "   " }, configured))
        .toThrow(expect.objectContaining({ name: "StripeCredentialValidationError", code }));
    }

    // Un despliegue a medio configurar guarda lo que sí tiene sin que los campos vacíos estorben.
    expect(buildStripeCredentialSecretPatch(
      { legalName: "Example Nonprofit" },
      env({ APP_ENV: "staging" })
    )).toEqual({
      STRIPE_US_LEGAL_NAME: expect.objectContaining({ text: "Example Nonprofit" })
    });

    // Un campo ausente no es un campo vaciado: una pestaña con el paquete anterior
    // a la precarga no envía ninguno de los ocho y su rotación debe seguir pasando.
    expect(buildStripeCredentialSecretPatch({ restrictedKey: "rk_test_rotated" }, configured)).toEqual({
      STRIPE_RESTRICTED_KEY: expect.objectContaining({ text: "rk_test_rotated" })
    });
  });

  it("writes only the organization values that actually changed and never the unchanged ones", () => {
    const configured = env({
      APP_ENV: "staging",
      STRIPE_RESTRICTED_KEY: "rk_test_existing",
      STRIPE_PUBLISHABLE_KEY: "pk_test_existing",
      STRIPE_US_LEGAL_NAME: "Example Nonprofit",
      STRIPE_US_EIN: "12-3456789",
      STRIPE_US_TIME_ZONE: "America/Chicago",
      STRIPE_US_PHONE: "+1 555 010 0100",
      STRIPE_US_WEBSITE: "https://example.org",
      STRIPE_US_MAILING_ADDRESS: "100 Test Avenue\nNew York, NY 10001, USA",
      STRIPE_US_SIGNER_NAME: "Test Signer",
      STRIPE_US_SIGNER_TITLE: "Treasurer"
    });
    const unchanged = {
      legalName: " Example Nonprofit ",
      ein: "12-3456789",
      timeZone: "America/Chicago",
      organizationPhone: "+1 555 010 0100",
      organizationWebsite: "https://example.org",
      organizationMailingAddress: "100 Test Avenue\nNew York, NY 10001, USA",
      signerName: "Test Signer",
      signerTitle: "Treasurer"
    };

    expect(buildStripeCredentialSecretPatch(unchanged, configured)).toEqual({});
    expect(buildStripeCredentialSecretPatch(
      { ...unchanged, organizationWebsite: "https://example.com" },
      configured
    )).toEqual({
      STRIPE_US_WEBSITE: expect.objectContaining({ text: "https://example.com" })
    });
    // Las credenciales de escritura no se precargan: en blanco no tocan nada y
    // cualquier valor enviado se escribe aunque coincida con el secreto vigente.
    expect(buildStripeCredentialSecretPatch(
      { ...unchanged, restrictedKey: "rk_test_existing", publishableKey: "  " },
      configured
    )).toEqual({
      STRIPE_RESTRICTED_KEY: expect.objectContaining({ text: "rk_test_existing" })
    });
  });

  it("stages only a syntactically valid next webhook secret", () => {
    expect(buildStripeWebhookStagePatch(" whsec_next ")).toEqual({
      STRIPE_WEBHOOK_SECRET_NEXT: {
        type: "secret_text",
        name: "STRIPE_WEBHOOK_SECRET_NEXT",
        text: "whsec_next"
      }
    });
    expect(() => buildStripeWebhookStagePatch("not-a-secret")).toThrow(StripeCredentialValidationError);
    expect(() => buildStripeWebhookPromotionPatch(env({
      STRIPE_WEBHOOK_SECRET: "whsec_",
      STRIPE_WEBHOOK_SECRET_NEXT: "whsec_next"
    }))).toThrow(StripeCredentialValidationError);
  });

  it("maps entered test credentials and certificate into Cloudflare secret names", () => {
    const patch = buildCredentialSecretPatch({
      environment: "test",
      mhUser: "06140707001011",
      mhPassword: "api-password",
      certificateXml: "abcdef",
      certificatePassword: "cert-password",
      emisorConfigJson: "{\"nombre\":\"Iglesia\"}",
      wompiSecret: "wompi-secret"
    });

    expect(patch).toEqual({
      MH_USER_TEST: { type: "secret_text", name: "MH_USER_TEST", text: "06140707001011" },
      MH_PASSWORD_TEST: { type: "secret_text", name: "MH_PASSWORD_TEST", text: "api-password" },
      MH_CERT_XML: null,
      MH_CERT_XML_PART_1: { type: "secret_text", name: "MH_CERT_XML_PART_1", text: "abc" },
      MH_CERT_XML_PART_2: { type: "secret_text", name: "MH_CERT_XML_PART_2", text: "def" },
      MH_CERT_PASSWORD: { type: "secret_text", name: "MH_CERT_PASSWORD", text: "cert-password" },
      EMISOR_CONFIG_JSON: { type: "secret_text", name: "EMISOR_CONFIG_JSON", text: "{\"nombre\":\"Iglesia\"}" },
      WOMPI_API_SECRET: { type: "secret_text", name: "WOMPI_API_SECRET", text: "wompi-secret" }
    });
  });

  it("maps production API credentials without overwriting blank fields", () => {
    const patch = buildCredentialSecretPatch({
      environment: "production",
      mhUser: "06140707001011",
      mhPassword: "prod-password",
      certificateXml: "   ",
      certificatePassword: "",
      emisorConfigJson: "",
      emailApiKey: "email-key",
      emailFrom: "dte@example.org"
    });

    expect(patch).toEqual({
      MH_USER_PROD: { type: "secret_text", name: "MH_USER_PROD", text: "06140707001011" },
      MH_PASSWORD_PROD: { type: "secret_text", name: "MH_PASSWORD_PROD", text: "prod-password" },
      EMAIL_API_KEY: { type: "secret_text", name: "EMAIL_API_KEY", text: "email-key" },
      EMAIL_FROM: { type: "secret_text", name: "EMAIL_FROM", text: "dte@example.org" }
    });
  });

  it("never writes an email provider destination from application input", () => {
    const patch = buildCredentialSecretPatch({
      environment: "production",
      emailApiKey: "new-key",
      emailFrom: "dte@example.org",
      emailApiUrl: "https://owner.example/send"
    } as CredentialUpdateInput & { emailApiUrl: string });

    expect(patch).toEqual({
      EMAIL_API_KEY: {
        type: "secret_text",
        name: "EMAIL_API_KEY",
        text: "new-key"
      },
      EMAIL_FROM: {
        type: "secret_text",
        name: "EMAIL_FROM",
        text: "dte@example.org"
      }
    });
    expect(patch).not.toHaveProperty("EMAIL_API_URL");
    expect(patch).not.toHaveProperty("EMAIL_PROVIDER_URL");
  });
});

describe("credential writer bootstrap", () => {
  it("stores the Cloudflare writer token using the supplied token for authorization", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await bootstrapCloudflareWriterToken(
        env({
          CLOUDFLARE_ACCOUNT_ID: "account-id",
          CLOUDFLARE_SCRIPT_NAME: "diezmossv-staging-example"
        }),
        "cf-writer-token"
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/account-id/workers/scripts/diezmossv-staging-example/secrets-bulk");
      expect(init.method).toBe("PATCH");
      expect(init.redirect).toBe("error");
      expect(init.headers).toMatchObject({
        Authorization: "Bearer cf-writer-token",
        "Content-Type": "application/json"
      });
      expect(JSON.parse(String(init.body))).toEqual({
        secrets: {
          CLOUDFLARE_API_TOKEN: {
            type: "secret_text",
            name: "CLOUDFLARE_API_TOKEN",
            text: "cf-writer-token"
          }
        }
      });
      expect(result).toEqual({ updated: ["CLOUDFLARE_API_TOKEN"], deleted: [] });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects a configurable Cloudflare API origin before sending the writer token", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(bootstrapCloudflareWriterToken(
        env({
          CLOUDFLARE_ACCOUNT_ID: "account-id",
          CLOUDFLARE_SCRIPT_NAME: "diezmossv-staging-example",
          CLOUDFLARE_API_BASE_URL: "https://attacker.example"
        }),
        "cf-writer-token"
      )).rejects.toThrow(/Cloudflare.*configur/i);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

function env(values: Partial<Env>): Env {
  return {
    DB: {} as D1Database,
    ISSUANCE_QUEUE: {} as Queue,
    ASSETS: {} as Fetcher,
    ARCHIVE: {} as R2Bucket,
    ...values
  };
}
