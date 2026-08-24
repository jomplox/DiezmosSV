import { describe, expect, it } from "vitest";
import {
  getEmisorConfig,
  getMhCertificateXml,
  isMockMode,
  mhEndpoint,
  resolveMhTestAuthFallbackEndpoint
} from "../../src/worker/config";
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

describe("MH endpoints", () => {
  it.each([
    ["auth", "00", "MH_AUTH_URL_TEST", "https://apitest.dtes.mh.gob.sv/seguridad/auth"],
    ["recepcion", "00", "MH_RECEPCION_URL_TEST", "https://apitest.dtes.mh.gob.sv/fesv/recepciondte"],
    ["anulacion", "00", "MH_ANULACION_URL_TEST", "https://apitest.dtes.mh.gob.sv/fesv/anulardte"],
    ["auth", "01", "MH_AUTH_URL_PROD", "https://api.dtes.mh.gob.sv/seguridad/auth"],
    ["recepcion", "01", "MH_RECEPCION_URL_PROD", "https://api.dtes.mh.gob.sv/fesv/recepciondte"],
    ["anulacion", "01", "MH_ANULACION_URL_PROD", "https://api.dtes.mh.gob.sv/fesv/anulardte"]
  ] as const)("accepts the %s endpoint for MH lane %s", (name, ambiente, key, endpoint) => {
    expect(mhEndpoint(env({ [key]: endpoint }), name, ambiente)).toBe(endpoint);
  });

  it.each([
    ["HTTP", "auth", "00", "MH_AUTH_URL_TEST", "http://apitest.dtes.mh.gob.sv/seguridad/auth"],
    ["production lane", "recepcion", "00", "MH_RECEPCION_URL_TEST", "https://api.dtes.mh.gob.sv/fesv/recepciondte"],
    ["wrong service path", "anulacion", "01", "MH_ANULACION_URL_PROD", "https://api.dtes.mh.gob.sv/fesv/recepciondte"]
  ] as const)("rejects an %s %s endpoint outside the requested lane", (_label, name, ambiente, key, endpoint) => {
    expect(() => mhEndpoint(env({ [key]: endpoint }), name, ambiente)).toThrow(/MH endpoint/i);
  });

  it.each([
    ["an omitted value", undefined, null],
    ["an empty value", "", null],
    ["the official TEST endpoint", "https://apitest.dtes.mh.gob.sv/seguridad/auth", null],
    [
      "the official central endpoint",
      "https://api.dtes.mh.gob.sv/seguridad/auth",
      "https://api.dtes.mh.gob.sv/seguridad/auth"
    ]
  ] as const)("resolves %s as a safe TEST authentication fallback", (_label, value, expected) => {
    expect(resolveMhTestAuthFallbackEndpoint(env({ MH_AUTH_URL_TEST_FALLBACK: value }))).toBe(expected);
  });

  it.each([
    "https://credentials.example/collect",
    "http://api.dtes.mh.gob.sv/seguridad/auth",
    "https://user:password@api.dtes.mh.gob.sv/seguridad/auth",
    "https://api.dtes.mh.gob.sv:444/seguridad/auth",
    "https://api.dtes.mh.gob.sv/seguridad/auth?next=evil",
    "https://api.dtes.mh.gob.sv/seguridad/auth#fragment",
    " https://api.dtes.mh.gob.sv/seguridad/auth",
    "https://api.dtes.mh.gob.sv/seguridad/auth "
  ])("rejects a non-official TEST authentication fallback before credentials can be sent: %s", (value) => {
    expect(() => resolveMhTestAuthFallbackEndpoint(env({ MH_AUTH_URL_TEST_FALLBACK: value })))
      .toThrow(/MH_AUTH_URL_TEST_FALLBACK/);
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
