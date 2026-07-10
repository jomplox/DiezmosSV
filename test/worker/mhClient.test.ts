import { afterEach, describe, expect, it, vi } from "vitest";
import { MhClient } from "../../src/worker/services/mhClient";
import { EnvironmentNotAllowedError } from "../../src/worker/services/environmentPolicy";
import type { Env } from "../../src/worker/types";

describe("MH client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses central auth when test auth rejects a valid test API credential", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "ERROR", body: { codigoMsg: "106", descripcionMsg: "CREDENCIALES INVÁLIDAS" } }))
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(jsonResponse({ estado: "PROCESADO", selloRecibido: "TESTSEAL" }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new MhClient(testEnv());

    const result = await client.transmitDte({
      ambiente: "00",
      version: 2,
      tipoDte: "15",
      codigoGeneracion: "11111111-2222-4333-8444-555555555555",
      signedJws: "signed-test-document"
    });

    expect(result.accepted).toBe(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      "https://api.dtes.mh.gob.sv/seguridad/auth",
      "https://apitest.dtes.mh.gob.sv/fesv/recepciondte"
    ]);
    expect(fetchMock.mock.calls[1][1]?.body?.toString()).toBe("user=10000000000001&pwd=test-api-password");
    expect(fetchMock.mock.calls[2][1]?.headers).toMatchObject({ Authorization: "Bearer test-token" });
  });

  it("rejects an incompatible ambiente before mock mode, token lookup, or fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const environment = testEnv();
    environment.MOCK_EXTERNAL_SERVICES = "true";

    const error = await new MhClient(environment)
      .transmitDte({
        ambiente: "01",
        version: 2,
        tipoDte: "15",
        codigoGeneracion: "11111111-2222-4333-8444-555555555555",
        signedJws: "signed-production-document"
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnvironmentNotAllowedError);
    expect(environment.DB.prepare).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function testEnv(): Env {
  const statement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(null),
    run: vi.fn().mockResolvedValue({})
  };
  return {
    DB: { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database,
    ISSUANCE_QUEUE: {} as Queue,
    ASSETS: {} as Fetcher,
    ARCHIVE: {} as R2Bucket,
    APP_ENV: "staging",
    MOCK_EXTERNAL_SERVICES: "false",
    MH_USER_TEST: "10000000000001",
    MH_PASSWORD_TEST: "test-api-password",
    MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
    MH_AUTH_URL_TEST_FALLBACK: "https://api.dtes.mh.gob.sv/seguridad/auth",
    MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte"
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
