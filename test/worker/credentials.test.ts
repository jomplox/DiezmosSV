import { describe, expect, it, vi } from "vitest";
import { bootstrapCloudflareWriterToken, buildCredentialSecretPatch, credentialStatus } from "../../src/worker/services/credentials";
import type { CredentialUpdateInput } from "../../src/worker/services/credentials";
import type { Env } from "../../src/worker/types";

describe("credential status", () => {
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
      EMISOR_CONFIG_JSON: "{\"nombre\":\"Iglesia Ejemplo\"}",
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
    expect(JSON.stringify(status)).not.toContain("Iglesia Ejemplo");
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
          CLOUDFLARE_SCRIPT_NAME: "diezmossv-staging-example",
          CLOUDFLARE_API_BASE_URL: "https://cf.test"
        }),
        "cf-writer-token"
      );

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://cf.test/accounts/account-id/workers/scripts/diezmossv-staging-example/secrets-bulk");
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
    ARCHIVE: {} as R2Bucket,
    ...values
  };
}
