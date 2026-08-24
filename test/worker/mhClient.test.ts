import { afterEach, describe, expect, it, vi } from "vitest";
import { MhClient, MhPreDispatchError, MhUnavailableError } from "../../src/worker/services/mhClient";
import { EnvironmentNotAllowedError } from "../../src/worker/services/environmentPolicy";
import type { Env } from "../../src/worker/types";

const MH_SECRET_USER = "mh user+canary@example.test";
const MH_SECRET_USER_PERCENT = "mh%20user%2Bcanary%40example.test";
const MH_SECRET_USER_FORM = "mh+user%2Bcanary%40example.test";
const MH_SECRET_PASSWORD = "PW canary+&=/%?";
const MH_SECRET_PASSWORD_PERCENT = "PW%20canary%2B%26%3D%2F%25%3F";
const MH_SECRET_PASSWORD_FORM = "PW+canary%2B%26%3D%2F%25%3F";
const MH_BEARER_CREDENTIAL = "cache token+credential/%? canary";
const MH_BEARER_CREDENTIAL_PERCENT = "cache%20token%2Bcredential%2F%25%3F%20canary";
const MH_BEARER_CREDENTIAL_FORM = "cache+token%2Bcredential%2F%25%3F+canary";
const MH_SECRET_TOKEN = `bEaReR ${MH_BEARER_CREDENTIAL}`;
const MH_SECRET_TOKEN_PERCENT = "bEaReR%20cache%20token%2Bcredential%2F%25%3F%20canary";
const MH_SECRET_TOKEN_FORM = "bEaReR+cache+token%2Bcredential%2F%25%3F+canary";
const MH_SECRET_TOKEN_PERCENT_SEPARATOR = `bEaReR%20${MH_BEARER_CREDENTIAL}`;
const MH_SECRET_TOKEN_FORM_SEPARATOR = `bEaReR+${MH_BEARER_CREDENTIAL}`;
const MH_OWS_SECRET_TOKEN = ` \t${MH_SECRET_TOKEN}\t `;
const MH_OWS_SECRET_TOKEN_PERCENT = "%20%09bEaReR%20cache%20token%2Bcredential%2F%25%3F%20canary%09%20";
const MH_OWS_SECRET_TOKEN_FORM = "+%09bEaReR+cache+token%2Bcredential%2F%25%3F+canary%09+";
const MH_NUMERIC_USER = "73194620581734";
const MH_NUMERIC_PASSWORD = "86420975318642";

const MH_SECRET_VARIANTS = [
  MH_SECRET_USER,
  MH_SECRET_USER_PERCENT,
  MH_SECRET_USER_FORM,
  MH_SECRET_PASSWORD,
  MH_SECRET_PASSWORD_PERCENT,
  MH_SECRET_PASSWORD_FORM,
  MH_BEARER_CREDENTIAL,
  MH_BEARER_CREDENTIAL_PERCENT,
  MH_BEARER_CREDENTIAL_FORM,
  MH_SECRET_TOKEN,
  MH_SECRET_TOKEN_PERCENT,
  MH_SECRET_TOKEN_FORM,
  MH_SECRET_TOKEN_PERCENT_SEPARATOR,
  MH_SECRET_TOKEN_FORM_SEPARATOR,
  MH_OWS_SECRET_TOKEN,
  MH_OWS_SECRET_TOKEN_PERCENT,
  MH_OWS_SECRET_TOKEN_FORM,
  MH_NUMERIC_USER,
  MH_NUMERIC_PASSWORD
];

describe("MH client", () => {
  afterEach(() => {
    vi.restoreAllMocks();
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

  it("rejects a hostile TEST fallback after code 106 without sending credentials to it", async () => {
    const environment = testEnv();
    environment.MH_USER_TEST = MH_SECRET_USER;
    environment.MH_PASSWORD_TEST = MH_SECRET_PASSWORD;
    environment.MH_AUTH_URL_TEST_FALLBACK = "https://credentials.example/collect";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        status: "ERROR",
        body: { codigoMsg: "106", descripcionMsg: "CREDENCIALES INVÁLIDAS" }
      }))
      .mockResolvedValueOnce(jsonResponse({
        status: "OK",
        body: { token: "Bearer stolen-credential-proof" },
        tokenType: "Bearer"
      }))
      .mockResolvedValueOnce(jsonResponse({ estado: "PROCESADO", selloRecibido: "UNREACHABLE" }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await transmitTestDte(new MhClient(environment)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MhPreDispatchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://apitest.dtes.mh.gob.sv/seguridad/auth");
    expectNoMhSecrets(serializeError(error));
  });

  it("treats the official TEST endpoint as a no-op fallback after code 106", async () => {
    const environment = testEnv();
    environment.MH_AUTH_URL_TEST_FALLBACK = "https://apitest.dtes.mh.gob.sv/seguridad/auth";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      status: "ERROR",
      body: { codigoMsg: "106", descripcionMsg: "CREDENCIALES INVÁLIDAS" }
    }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await transmitTestDte(new MhClient(environment)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MhPreDispatchError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://apitest.dtes.mh.gob.sv/seguridad/auth");
  });

  it("bounds both MH authentication and transmission below the DTE lease", async () => {
    const timeoutSignals: AbortSignal[] = [];
    const timeoutDurations: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((duration) => {
      timeoutDurations.push(duration);
      const signal = new AbortController().signal;
      timeoutSignals.push(signal);
      return signal;
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(jsonResponse({ estado: "PROCESADO", selloRecibido: "TESTSEAL" }));
    vi.stubGlobal("fetch", fetchMock);

    await new MhClient(testEnv()).transmitDte({
      ambiente: "00",
      version: 2,
      tipoDte: "15",
      codigoGeneracion: "11111111-2222-4333-8444-555555555555",
      signedJws: "signed-test-document"
    });

    expect(timeoutDurations).toHaveLength(2);
    expect(timeoutDurations.every((duration) => duration > 0 && duration < 5 * 60 * 1000)).toBe(true);
    expect(fetchMock.mock.calls[0][1]?.signal).toBe(timeoutSignals[0]);
    expect(fetchMock.mock.calls[1][1]?.signal).toBe(timeoutSignals[1]);
  });

  it("classifies an aborted MH authentication as pre-dispatch", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("timed out", "AbortError")));

    await expect(new MhClient(testEnv()).transmitDte({
      ambiente: "00",
      version: 2,
      tipoDte: "15",
      codigoGeneracion: "11111111-2222-4333-8444-555555555555",
      signedJws: "signed-test-document"
    })).rejects.toBeInstanceOf(MhPreDispatchError);
  });

  it("normalizes an aborted MH transmission as temporary unavailability", async () => {
    vi.stubGlobal("fetch", vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockRejectedValueOnce(new DOMException("timed out", "AbortError")));

    await expect(new MhClient(testEnv()).transmitDte({
      ambiente: "00",
      version: 2,
      tipoDte: "15",
      codigoGeneracion: "11111111-2222-4333-8444-555555555555",
      signedJws: "signed-test-document"
    })).rejects.toBeInstanceOf(MhUnavailableError);
  });

  it("keeps a plain-text authentication rejection and echoed form credentials out of the pre-dispatch error", async () => {
    const environment = testEnv();
    environment.MH_USER_TEST = MH_SECRET_USER;
    environment.MH_PASSWORD_TEST = MH_SECRET_PASSWORD;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      `credential echo ${MH_SECRET_USER} ${MH_SECRET_USER_PERCENT} ${MH_SECRET_USER_FORM} ${MH_SECRET_PASSWORD} ${MH_SECRET_PASSWORD_PERCENT} ${MH_SECRET_PASSWORD_FORM}`,
      { status: 401 }
    )));

    const error = await transmitTestDte(new MhClient(environment)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MhPreDispatchError);
    expect((error as Error).message).toBe("Falló la autenticación con el Ministerio de Hacienda (HTTP 401)");
    expect((error as MhPreDispatchError).cause).toBeInstanceOf(Error);
    expect(((error as MhPreDispatchError).cause as Error).message).toBe(
      "Falló la autenticación con el Ministerio de Hacienda (HTTP 401)"
    );
    expectNoMhSecrets(serializeError(error));
  });

  it("discards provider codes and descriptions when a successful authentication response has no token", async () => {
    const environment = testEnv();
    environment.MH_USER_TEST = MH_SECRET_USER;
    environment.MH_PASSWORD_TEST = MH_SECRET_PASSWORD;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      status: "ERROR",
      body: {
        codigoMsg: `AUTH-${MH_SECRET_USER}-${MH_SECRET_USER_FORM}`,
        descripcionMsg: `Credential ${MH_SECRET_PASSWORD} ${MH_SECRET_PASSWORD_PERCENT} ${MH_SECRET_PASSWORD_FORM}`
      }
    })));

    const error = await transmitTestDte(new MhClient(environment)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MhPreDispatchError);
    expect((error as Error).message).toBe(
      "La autenticación con el Ministerio de Hacienda no devolvió body.token"
    );
    expectNoMhSecrets(serializeError(error));
  });

  it("uses the same bounded token-missing error for a non-object authentication body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(null)));

    const error = await transmitTestDte(new MhClient(testEnv())).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(MhPreDispatchError);
    expect((error as Error).message).toBe(
      "La autenticación con el Ministerio de Hacienda no devolvió body.token"
    );
  });

  it("stores the supported Bearer token type instead of provider-controlled authentication text", async () => {
    const lookupStatement = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({})
    };
    const writeStatement = {
      bind: vi.fn().mockReturnThis(),
      first: vi.fn().mockResolvedValue(null),
      run: vi.fn().mockResolvedValue({})
    };
    const environment = testEnv();
    environment.MH_USER_TEST = MH_SECRET_USER;
    environment.MH_PASSWORD_TEST = MH_SECRET_PASSWORD;
    environment.DB = {
      prepare: vi.fn((sql: string) => sql.includes("SELECT token, token_type")
        ? lookupStatement
        : writeStatement)
    } as unknown as D1Database;
    vi.stubGlobal("fetch", vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        status: "OK",
        body: { token: "Bearer safe-auth-token" },
        tokenType: `provider ${MH_SECRET_USER} ${MH_SECRET_PASSWORD}`
      }))
      .mockResolvedValueOnce(jsonResponse({
        estado: "PROCESADO",
        selloRecibido: "SAFE-SEAL",
        observaciones: []
      })));

    const result = await transmitTestDte(new MhClient(environment));

    expect(result.accepted).toBe(true);
    expect(writeStatement.bind).toHaveBeenCalledWith(
      "00",
      "Bearer safe-auth-token",
      "Bearer",
      expect.any(String),
      expect.any(String)
    );
    const [ambiente, _token, tokenType, expiresAt, updatedAt] = writeStatement.bind.mock.calls[0];
    expectNoMhSecrets(JSON.stringify({ ambiente, tokenType, expiresAt, updatedAt }));
  });

  it("sanitizes credentials and authorization recursively before returning a terminal rejection", async () => {
    const environment = testEnv();
    environment.MH_USER_TEST = MH_SECRET_USER;
    environment.MH_PASSWORD_TEST = MH_SECRET_PASSWORD;
    vi.stubGlobal("fetch", vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        status: "OK",
        body: { token: MH_SECRET_TOKEN },
        tokenType: "Bearer"
      }))
      .mockResolvedValueOnce(jsonResponse({
        estado: "RECHAZADO",
        selloRecibido: null,
        observaciones: [
          `user=${MH_SECRET_USER}; encoded=${MH_SECRET_USER_PERCENT}`,
          `pwd=${MH_SECRET_PASSWORD}; form=${MH_SECRET_PASSWORD_FORM}`,
          `authorization=${MH_SECRET_TOKEN}`
        ],
        descripcionMsg: `nested ${MH_SECRET_PASSWORD_PERCENT}`,
        estadoDetalle: `provider state echoed ${MH_SECRET_USER_FORM}`,
        selloEcho: `provider seal echoed ${MH_SECRET_TOKEN}`,
        text: `provider text echoed ${MH_SECRET_PASSWORD}`,
        nested: [{ arrayValue: `prefix-${MH_SECRET_TOKEN}-suffix` }],
        [`provider-${MH_SECRET_PASSWORD}-key`]: "nested object key"
      }, { status: 400 })));

    const result = await transmitTestDte(new MhClient(environment));

    expect(result).toMatchObject({
      accepted: false,
      estado: "RECHAZADO",
      selloRecibido: null
    });
    expect(result.observaciones).toHaveLength(3);
    expect(result.observaciones[2]).toBe("authorization=[REDACTED]");
    expectNoMhSecrets(JSON.stringify(result));
  });

  it("redacts exact all-numeric credential echoes before observations stringify provider scalars", async () => {
    const environment = testEnv();
    environment.MH_USER_TEST = MH_NUMERIC_USER;
    environment.MH_PASSWORD_TEST = MH_NUMERIC_PASSWORD;
    vi.stubGlobal("fetch", vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        status: "OK",
        body: { token: "Bearer numeric-sanitizer-token" },
        tokenType: "Bearer"
      }))
      .mockResolvedValueOnce(jsonResponse({
        estado: "RECHAZADO",
        selloRecibido: null,
        observaciones: [
          Number(MH_NUMERIC_USER),
          Number(MH_NUMERIC_PASSWORD),
          42,
          false
        ],
        nested: {
          userEcho: Number(MH_NUMERIC_USER),
          passwordEcho: Number(MH_NUMERIC_PASSWORD),
          unrelatedNumber: 7,
          unrelatedBoolean: false
        }
      }, { status: 400 })));

    const result = await transmitTestDte(new MhClient(environment));
    const raw = result.raw as {
      nested: Record<string, unknown>;
    };

    expect(result).toMatchObject({
      accepted: false,
      estado: "RECHAZADO",
      selloRecibido: null,
      observaciones: ["[REDACTED]", "[REDACTED]", "42", "false"]
    });
    expect(raw.nested).toEqual({
      userEcho: "[REDACTED]",
      passwordEcho: "[REDACTED]",
      unrelatedNumber: 7,
      unrelatedBoolean: false
    });
    expectNoMhSecrets(JSON.stringify(result));
  });

  it("redacts an exact boolean credential echo while preserving an unrelated boolean", async () => {
    const environment = testEnv();
    environment.MH_PASSWORD_TEST = "false";
    vi.stubGlobal("fetch", vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        status: "OK",
        body: { token: "Bearer boolean-sanitizer-token" },
        tokenType: "Bearer"
      }))
      .mockResolvedValueOnce(jsonResponse({
        estado: "RECHAZADO",
        selloRecibido: null,
        observaciones: [false, true],
        nested: { passwordEcho: false, unrelatedBoolean: true }
      }, { status: 400 })));

    const result = await transmitTestDte(new MhClient(environment));
    const raw = result.raw as { nested: Record<string, unknown> };

    expect(result.observaciones).toEqual(["[REDACTED]", "true"]);
    expect(raw.nested).toEqual({
      passwordEcho: "[REDACTED]",
      unrelatedBoolean: true
    });
  });

  it.each([
    {
      ambiente: "00" as const,
      appEnv: "staging" as const,
      receptionUrl: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte"
    },
    {
      ambiente: "01" as const,
      appEnv: "production" as const,
      receptionUrl: "https://api.dtes.mh.gob.sv/fesv/recepciondte"
    }
  ])("sanitizes cached Bearer credential and authorization variants in lane $ambiente", async ({
    ambiente,
    appEnv,
    receptionUrl
  }) => {
    const { environment, cacheStatement } = cachedTokenEnv(ambiente, appEnv);
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      estado: "PROCESADO",
      selloRecibido: `SEAL-${MH_BEARER_CREDENTIAL}`,
      observaciones: [
        `credential=${MH_BEARER_CREDENTIAL}`,
        `credential-percent=${MH_BEARER_CREDENTIAL_PERCENT}`,
        `credential-form=${MH_BEARER_CREDENTIAL_FORM}`,
        `authorization=${MH_SECRET_TOKEN}`,
        `authorization-percent=${MH_SECRET_TOKEN_PERCENT}`,
        `authorization-form=${MH_SECRET_TOKEN_FORM}`,
        `separator-percent=${MH_SECRET_TOKEN_PERCENT_SEPARATOR}`,
        `separator-form=${MH_SECRET_TOKEN_FORM_SEPARATOR}`
      ],
      text: `plain ${MH_BEARER_CREDENTIAL_FORM}`,
      nested: [{ value: `prefix-${MH_SECRET_TOKEN_PERCENT}-suffix` }],
      [`provider-${MH_BEARER_CREDENTIAL_PERCENT}-key`]: MH_SECRET_TOKEN_FORM
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await transmitTestDte(new MhClient(environment), ambiente);

    expect(result).toMatchObject({
      accepted: true,
      estado: "PROCESADO",
      selloRecibido: "SEAL-[REDACTED]"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(receptionUrl);
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: MH_SECRET_TOKEN });
    expect(cacheStatement.first).toHaveBeenCalledTimes(1);
    expect(cacheStatement.run).not.toHaveBeenCalled();
    expectNoMhSecrets(JSON.stringify(result));
  });

  it("sanitizes cached authorization after Fetch removes outer HTTP whitespace", async () => {
    const { environment, cacheStatement } = cachedTokenEnv("00", "staging", MH_OWS_SECRET_TOKEN);
    let sentAuthorization: string | null = null;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      sentAuthorization = new Request(input, init).headers.get("Authorization");
      return jsonResponse({
        estado: "RECHAZADO",
        selloRecibido: null,
        observaciones: [
          `credential=${MH_BEARER_CREDENTIAL}`,
          `credential-percent=${MH_BEARER_CREDENTIAL_PERCENT}`,
          `credential-form=${MH_BEARER_CREDENTIAL_FORM}`,
          `authorization=${MH_SECRET_TOKEN}`,
          `authorization-percent=${MH_SECRET_TOKEN_PERCENT}`,
          `authorization-form=${MH_SECRET_TOKEN_FORM}`,
          `stored-authorization=${MH_OWS_SECRET_TOKEN}`,
          `stored-percent=${MH_OWS_SECRET_TOKEN_PERCENT}`,
          `stored-form=${MH_OWS_SECRET_TOKEN_FORM}`
        ],
        nested: [{ [`provider-${MH_BEARER_CREDENTIAL_PERCENT}-key`]: `prefix-${MH_SECRET_TOKEN_FORM}-suffix` }]
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await transmitTestDte(new MhClient(environment));

    expect(result).toMatchObject({
      accepted: false,
      estado: "RECHAZADO",
      selloRecibido: null
    });
    expect(sentAuthorization).toBe(MH_SECRET_TOKEN);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cacheStatement.first).toHaveBeenCalledTimes(1);
    expect(cacheStatement.run).not.toHaveBeenCalled();
    expectNoMhSecrets(JSON.stringify(result));
  });

  it("bounds an arbitrary indeterminate estado and sanitizes a plain-text reception response", async () => {
    const environment = testEnv();
    environment.MH_USER_TEST = MH_SECRET_USER;
    environment.MH_PASSWORD_TEST = MH_SECRET_PASSWORD;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({
        status: "OK",
        body: { token: MH_SECRET_TOKEN },
        tokenType: "Bearer"
      }))
      .mockResolvedValueOnce(jsonResponse({
        estado: `PENDIENTE ${MH_SECRET_USER} ${MH_SECRET_PASSWORD_FORM} ${MH_SECRET_TOKEN}`,
        observaciones: [`still pending ${MH_SECRET_PASSWORD}`]
      }));
    vi.stubGlobal("fetch", fetchMock);

    const indeterminate = await transmitTestDte(new MhClient(environment)).catch((caught: unknown) => caught);

    expect(indeterminate).toBeInstanceOf(MhUnavailableError);
    expect((indeterminate as Error).message).toBe(
      "Ministerio de Hacienda devolvió un resultado no definitivo: ESTADO_NO_RECONOCIDO"
    );
    expectNoMhSecrets(serializeError(indeterminate));

    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        status: "OK",
        body: { token: MH_SECRET_TOKEN },
        tokenType: "Bearer"
      }))
      .mockResolvedValueOnce(new Response(
        `plain response ${MH_SECRET_USER_FORM} ${MH_SECRET_PASSWORD_PERCENT} ${MH_SECRET_TOKEN}`,
        { status: 422 }
      ));

    const plainText = await transmitTestDte(new MhClient(environment)).catch((caught: unknown) => caught);

    expect(plainText).toBeInstanceOf(MhUnavailableError);
    expect((plainText as Error).message).toBe(
      "Ministerio de Hacienda devolvió un resultado no definitivo: RECIBIDO (HTTP 422)"
    );
    expectNoMhSecrets(serializeError(plainText));
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

function cachedTokenEnv(
  ambiente: "00" | "01",
  appEnv: "staging" | "production",
  token = MH_SECRET_TOKEN
): {
  environment: Env;
  cacheStatement: {
    bind: ReturnType<typeof vi.fn>;
    first: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
  };
} {
  const cacheStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue({
      token,
      token_type: "Bearer",
      expires_at: "2099-01-01T00:00:00.000Z"
    }),
    run: vi.fn().mockResolvedValue({})
  };
  const environment = testEnv();
  environment.DB = { prepare: vi.fn().mockReturnValue(cacheStatement) } as unknown as D1Database;
  environment.APP_ENV = appEnv;
  if (ambiente === "00") {
    environment.MH_USER_TEST = MH_SECRET_USER;
    environment.MH_PASSWORD_TEST = MH_SECRET_PASSWORD;
  } else {
    environment.MH_USER_PROD = MH_SECRET_USER;
    environment.MH_PASSWORD_PROD = MH_SECRET_PASSWORD;
    environment.MH_AUTH_URL_PROD = "https://api.dtes.mh.gob.sv/seguridad/auth";
    environment.MH_RECEPCION_URL_PROD = "https://api.dtes.mh.gob.sv/fesv/recepciondte";
  }
  return { environment, cacheStatement };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" }
  });
}

async function transmitTestDte(client: MhClient, ambiente: "00" | "01" = "00") {
  return client.transmitDte({
    ambiente,
    version: 2,
    tipoDte: "15",
    codigoGeneracion: "11111111-2222-4333-8444-555555555555",
    signedJws: "signed-test-document"
  });
}

function serializeError(error: unknown): string {
  if (!(error instanceof Error)) return JSON.stringify(error);
  const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
  return JSON.stringify({
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: cause instanceof Error
      ? { name: cause.name, message: cause.message, stack: cause.stack }
      : cause
  });
}

function expectNoMhSecrets(evidence: string): void {
  for (const secret of MH_SECRET_VARIANTS) {
    expect(evidence).not.toContain(secret);
  }
}
