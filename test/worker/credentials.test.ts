import { describe, expect, it } from "vitest";
import { buildCredentialSecretPatch, credentialStatus } from "../../src/worker/services/credentials";
import type { Env } from "../../src/worker/types";

describe("credential status", () => {
  it("reports test and production MH credential readiness without revealing values", () => {
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
      EMISOR_CONFIG_JSON: "{}",
      WOMPI_API_SECRET: "wompi-secret",
      EMAIL: { send: async () => ({ messageId: "message-1" }) } as SendEmail,
      EMAIL_FROM: "dte@example.org"
    }));

    expect(status.target).toEqual({
      appEnv: "staging",
      scriptName: "diezmossv-staging-resource-example",
      writerConfigured: true
    });
    expect(status.groups.mhTest.ready).toBe(true);
    expect(status.groups.mhProduction.ready).toBe(true);
    expect(status.groups.signer.ready).toBe(true);
    expect(status.groups.issuer.ready).toBe(true);
    expect(status.groups.email.ready).toBe(true);
    expect(JSON.stringify(status)).not.toContain("secret-token");
    expect(JSON.stringify(status)).not.toContain("test-password");
    expect(JSON.stringify(status)).not.toContain("cert-password");
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
      emailFrom: "dte@example.org"
    });

    expect(patch).toEqual({
      MH_USER_PROD: { type: "secret_text", name: "MH_USER_PROD", text: "06140707001011" },
      MH_PASSWORD_PROD: { type: "secret_text", name: "MH_PASSWORD_PROD", text: "prod-password" },
      EMAIL_FROM: { type: "secret_text", name: "EMAIL_FROM", text: "dte@example.org" }
    });
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
