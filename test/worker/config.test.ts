import { describe, expect, it } from "vitest";
import { getEmisorConfig, getMhCertificateXml, isMockMode } from "../../src/worker/config";
import type { Env } from "../../src/worker/types";
import { emisorConfig } from "./fixtures";

describe("mock mode", () => {
  it("performs real external calls when MOCK_EXTERNAL_SERVICES is unset", () => {
    expect(isMockMode(env({}))).toBe(false);
  });

  it("only mocks external services when MOCK_EXTERNAL_SERVICES is exactly \"true\"", () => {
    expect(isMockMode(env({ MOCK_EXTERNAL_SERVICES: "true" }))).toBe(true);
  });

  it("performs real external calls when MOCK_EXTERNAL_SERVICES is \"false\"", () => {
    expect(isMockMode(env({ MOCK_EXTERNAL_SERVICES: "false" }))).toBe(false);
  });

  it("rejects shared mock mode in production", () => {
    expect(() => isMockMode(env({ APP_ENV: "production", MOCK_EXTERNAL_SERVICES: "true" }))).toThrow(/mock/i);
  });
});

describe("worker config", () => {
  it("uses the single MH certificate secret when present", () => {
    expect(getMhCertificateXml(env({ MH_CERT_XML: "full-cert" }))).toBe("full-cert");
  });

  it("assembles the MH certificate from split Cloudflare secrets", () => {
    expect(getMhCertificateXml(env({ MH_CERT_XML_PART_1: "first-", MH_CERT_XML_PART_2: "second" }))).toBe("first-second");
  });

  it("requires both split certificate parts", () => {
    expect(() => getMhCertificateXml(env({ MH_CERT_XML_PART_1: "first" }))).toThrow(/PART_1 y MH_CERT_XML_PART_2/);
  });

  it("accepts a schema-shaped CDE issuer configuration", () => {
    expect(getEmisorConfig(env({ EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig) }))).toEqual(emisorConfig);
  });

  it("rejects non-NIT document types for the issuer", () => {
    expect(() => getEmisorConfig(env({ EMISOR_CONFIG_JSON: JSON.stringify({ ...emisorConfig, tipoDocumento: "03" }) }))).toThrow(/emisor\.tipoDocumento.*NIT/i);
  });

  it("reports malformed issuer JSON with a friendly config message", () => {
    expect(() => getEmisorConfig(env({ EMISOR_CONFIG_JSON: '{\\"tipoDocumento\\":\\"36\\"}' }))).toThrow(
      /EMISOR_CONFIG_JSON invalido: no es JSON válido/
    );
  });

  it("rejects issuer municipality values outside the authoritative catalog", () => {
    expect(() =>
      getEmisorConfig(
        env({
          EMISOR_CONFIG_JSON: JSON.stringify({
            ...emisorConfig,
            direccion: { ...emisorConfig.direccion, departamento: "06", municipio: "99", distrito: "01" }
          })
        })
      )
    ).toThrow(/CAT-013/i);
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
