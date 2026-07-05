import { describe, expect, it, vi } from "vitest";
import { bootstrapCloudflareWriterToken, buildCredentialSecretPatch, credentialStatus } from "../../src/worker/services/credentials";
import type { Env } from "../../src/worker/types";

describe("credential status", () => {
  it("reports readiness, exposes inspectable config values, and protects secrets", () => {
    const status = credentialStatus(env({
      APP_ENV: "staging",
      CLOUDFLARE_SCRIPT_NAME: "diezmossv-staging-resource-example",
      CLOUDFLARE_API_TOKEN: "secret-token",
      CLOUDFLARE_ACCOUNT_ID: "account-id",
      MH_USER_TEST: "0614",
      MH_PASSWORD_TEST: "test-password",
      MH_USER_PROD: "0614",
      MH_PASSWORD_PROD: "prod-password",
      MH_CERT_XML_PART_1: "<CertificadoMH>",
      MH_CERT_XML_PART_2: "</CertificadoMH>",
      MH_CERT_PASSWORD: "cert-password",
      EMISOR_CONFIG_JSON: "{\"nombre\":\"Iglesia Ejemplo\"}",
      WOMPI_API_SECRET: "wompi-secret",
      EMAIL: { send: async () => ({ messageId: "message-1" }) } as SendEmail,
      EMAIL_ARBITRARY_RECIPIENTS: "true",
      EMAIL_API_URL: "https://mail.example/send",
      EMAIL_API_KEY: "email-key",
      EMAIL_FROM: "dte@example.org"
    }));

    expect(status.target).toEqual({
      appEnv: "staging",
      scriptName: "diezmossv-staging-resource-example",
      writerConfigured: true,
      writerMissing: []
    });
    expect(status.groups.mhTest.ready).toBe(true);
    expect(status.groups.mhProduction.ready).toBe(true);
    expect(status.groups.signer.ready).toBe(true);
    expect(status.groups.mhTest.label).toBe("Ministerio de Hacienda ambiente de pruebas");
    expect(status.groups.mhProduction.label).toBe("Ministerio de Hacienda ambiente producción");
    expect(status.groups.signer.label).toBe("Certificado firmador del Ministerio de Hacienda");
    expect(status.groups.issuer.ready).toBe(true);
    expect(status.groups.email.ready).toBe(true);
    expect(status.groups.mhTest.items).toContainEqual({
      name: "MH_USER_TEST",
      label: "Usuario API TEST",
      configured: true,
      displayValue: "0614"
    });
    expect(status.groups.issuer.items).toContainEqual({
      name: "EMISOR_CONFIG_JSON",
      label: "Configuración JSON",
      configured: true,
      displayValue: "{\"nombre\":\"Iglesia Ejemplo\"}"
    });
    expect(status.groups.email.items).toContainEqual({
      name: "EMAIL_API_URL",
      label: "Endpoint POST JSON de respaldo",
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
  });
});

describe("credential secret patch", () => {
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
      emailApiUrl: "https://mail.example/send",
      emailApiKey: "email-key",
      emailFrom: "dte@example.org"
    });

    expect(patch).toEqual({
      MH_USER_PROD: { type: "secret_text", name: "MH_USER_PROD", text: "06140707001011" },
      MH_PASSWORD_PROD: { type: "secret_text", name: "MH_PASSWORD_PROD", text: "prod-password" },
      EMAIL_API_URL: { type: "secret_text", name: "EMAIL_API_URL", text: "https://mail.example/send" },
      EMAIL_API_KEY: { type: "secret_text", name: "EMAIL_API_KEY", text: "email-key" },
      EMAIL_FROM: { type: "secret_text", name: "EMAIL_FROM", text: "dte@example.org" }
    });
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
          CLOUDFLARE_SCRIPT_NAME: "diezmossv-staging-resource-example",
          CLOUDFLARE_API_BASE_URL: "https://cf.test"
        }),
        "cf-writer-token"
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://cf.test/accounts/account-id/workers/scripts/diezmossv-staging-resource-example/secrets-bulk");
      expect(init.method).toBe("PATCH");
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
});

function env(values: Partial<Env>): Env {
  return {
    DB: {} as D1Database,
    ISSUANCE_QUEUE: {} as Queue,
    ASSETS: {} as Fetcher,
    ...values
  };
}
