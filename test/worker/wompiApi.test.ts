import { afterEach, describe, expect, it, vi } from "vitest";
import { WompiApiError, WompiApiService } from "../../src/worker/services/wompiApi";
import type { DonationIntentRecord, Env } from "../../src/worker/types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// The cards-only forma de pago every create/deactivate body must carry. The
// permitir/permite prefixes are intentionally inconsistent — they mirror the
// Wompi swagger EnlaceFormaPago schema exactly and must not be "corrected".
const CARDS_ONLY_FORMA_PAGO = {
  permitirTarjetaCreditoDebido: true,
  permitirPagoConPuntoAgricola: false,
  permitirPagoEnCuotasAgricola: false,
  permitirPagoEnBitcoin: false,
  permitePagoQuickPay: false,
  permitePagoNequi: false
};

// Minimal in-memory D1 covering exactly the two app_settings statements
// Repository.getSetting/setSetting issue, so the token cache has real storage.
class FakeD1 {
  readonly settings = new Map<string, string>();
  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

class FakeStatement {
  private args: unknown[] = [];
  constructor(private readonly db: FakeD1, private readonly sql: string) {}
  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }
  async first<T>(): Promise<T | null> {
    if (this.sql.includes("SELECT value FROM app_settings WHERE key = ?")) {
      const value = this.db.settings.get(String(this.args[0]));
      return value === undefined ? null : ({ value } as T);
    }
    return null;
  }
  async run(): Promise<void> {
    if (this.sql.includes("INSERT INTO app_settings")) {
      this.db.settings.set(String(this.args[0]), String(this.args[1]));
    }
  }
}

describe("Wompi API service", () => {
  it("mints a single-use payment link with an OAuth token and returns the link fields", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "wompi-access-token", expires_in: 3600, token_type: "Bearer" }))
      .mockResolvedValueOnce(
        jsonResponse({
          idEnlace: 987654,
          urlEnlace: "https://s.wompi.sv/987654",
          urlEnlaceLargo: "https://pagos.wompi.sv/IntentoPago/Redirect?id=773b3c29-abc"
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const service = new WompiApiService(realEnv());
    const link = await service.createPaymentLink(intent());

    expect(link).toEqual({
      idEnlace: 987654,
      urlEnlace: "https://s.wompi.sv/987654",
      urlEnlaceLargo: "https://pagos.wompi.sv/IntentoPago/Redirect?id=773b3c29-abc"
    });

    // Token request: form-encoded client-credentials with audience wompi_api.
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe("https://id.wompi.sv/connect/token");
    expect(tokenInit?.method).toBe("POST");
    expect((tokenInit?.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const tokenForm = new URLSearchParams(String(tokenInit?.body));
    expect(tokenForm.get("grant_type")).toBe("client_credentials");
    expect(tokenForm.get("audience")).toBe("wompi_api");
    expect(tokenForm.get("client_id")).toBe("test-client-id");
    expect(tokenForm.get("client_secret")).toBe("test-client-secret");

    // Link request: Bearer header + the documented EnlacePago body.
    const [linkUrl, linkInit] = fetchMock.mock.calls[1];
    expect(linkUrl).toBe("https://api.wompi.sv/EnlacePago");
    expect(linkInit?.method).toBe("POST");
    expect(linkInit?.headers).toMatchObject({
      authorization: "Bearer wompi-access-token",
      "Content-Type": "application/json"
    });
    const body = JSON.parse(String(linkInit?.body)) as {
      identificadorEnlaceComercio: string;
      monto: number;
      nombreProducto: string;
      limitesDeUso: { cantidadMaximaPagosExitosos: number };
      formaPago: Record<string, boolean>;
      configuracion: { urlRedirect: string; urlWebhook: string; esMontoEditable: boolean; esCantidadEditable: boolean; notificarTransaccionCliente: boolean };
      vigencia: { fechaInicio: string; fechaFin: string };
    };
    expect(body).toMatchObject({
      identificadorEnlaceComercio: "di_test",
      monto: 25.5,
      nombreProducto: "Diezmos y Ofrendas",
      limitesDeUso: { cantidadMaximaPagosExitosos: 1 },
      // Cards only: no puntoAgricola, cuotas, bitcoin, quickpay, or nequi.
      formaPago: CARDS_ONLY_FORMA_PAGO,
      configuracion: {
        urlRedirect: "https://app.example.org/donar/gracias",
        urlWebhook: "https://app.example.org/webhooks/wompi",
        // The amount is pinned: the donor cannot edit the monto or quantity on Wompi's sheet.
        esMontoEditable: false,
        esCantidadEditable: false,
        // Wompi must NOT email the donor: we send the CDE ourselves.
        notificarTransaccionCliente: false
      }
    });
    expect(new Date(body.vigencia.fechaFin).getTime() - new Date(body.vigencia.fechaInicio).getTime()).toBe(60 * 60 * 1000);
  });

  // The donor sees this on Wompi's hosted sheet. Links are minted per donation, so the
  // name carries the ministry brand rather than the gift type — diezmo vs ofrenda rides
  // the intent's gift_type onto the CDE apéndice, not the link.
  it.each([["DIEZMO"], ["OFRENDA"], [null]])(
    "names every link with the ministry brand (gift_type %s)",
    async (giftType) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ access_token: "wompi-access-token", expires_in: 3600, token_type: "Bearer" }))
        .mockResolvedValueOnce(jsonResponse({ idEnlace: 1, urlEnlace: "https://s.wompi.sv/1", urlEnlaceLargo: "https://pagos.wompi.sv/L?id=1" }));
      vi.stubGlobal("fetch", fetchMock);

      await new WompiApiService(realEnv()).createPaymentLink(intent({ gift_type: giftType as "DIEZMO" | "OFRENDA" | null }));

      const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as { nombreProducto: string };
      expect(body.nombreProducto).toBe("Diezmos y Ofrendas");
    }
  );

  it("returns a deterministic mock link without any fetch in mock mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const service = new WompiApiService(mockEnv());
    const link = await service.createPaymentLink(intent());

    expect(link.urlEnlace).toBe("https://mock.wompi.sv/enlace/di_test");
    expect(link.urlEnlaceLargo).toBe("https://mock.wompi.sv/enlace-largo/di_test");
    expect(link.idEnlace).toBeGreaterThan(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a typed error with the response text on a non-2xx link response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "wompi-access-token", expires_in: 3600, token_type: "Bearer" }))
      .mockResolvedValueOnce(new Response("monto inválido", { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new WompiApiService(realEnv());

    const error = await service.createPaymentLink(intent()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WompiApiError);
    expect((error as WompiApiError).message).toContain("422");
    expect((error as WompiApiError).message).toContain("monto inválido");
    // The secret must never leak into the thrown error.
    expect((error as WompiApiError).message).not.toContain("test-client-secret");
  });

  it("throws a typed error when the token request fails", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response("bad credentials", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new WompiApiService(realEnv());

    const error = await service.createPaymentLink(intent()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WompiApiError);
    expect((error as WompiApiError).message).toContain("401");
    expect((error as WompiApiError).message).not.toContain("test-client-secret");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deactivates a link by PUTting the full body with a past vigencia window", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "wompi-access-token", expires_in: 3600, token_type: "Bearer" }))
      .mockResolvedValueOnce(jsonResponse({ idEnlace: 555, usable: false }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new WompiApiService(realEnv());
    await service.deactivatePaymentLink(intent({ wompi_id_enlace: 555 }));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Token first, then the PUT to the specific link.
    const [linkUrl, linkInit] = fetchMock.mock.calls[1];
    expect(linkUrl).toBe("https://api.wompi.sv/EnlacePago/555");
    expect(linkInit?.method).toBe("PUT");
    expect(linkInit?.headers).toMatchObject({
      authorization: "Bearer wompi-access-token",
      "Content-Type": "application/json"
    });
    const body = JSON.parse(String(linkInit?.body)) as {
      idEnlace: number;
      identificadorEnlaceComercio: string;
      monto: number;
      nombreProducto: string;
      formaPago: Record<string, boolean>;
      configuracion: { urlRedirect: string; urlWebhook: string; esMontoEditable: boolean; esCantidadEditable: boolean; notificarTransaccionCliente: boolean };
      vigencia: { fechaInicio: string; fechaFin: string };
    };
    // Full body: PUT replaces the whole object, so formaPago and configuracion
    // must be present or they null out (Wompi would re-enable every method / re-email).
    expect(body).toMatchObject({
      idEnlace: 555,
      identificadorEnlaceComercio: "di_test",
      monto: 25.5,
      nombreProducto: "Diezmos y Ofrendas",
      formaPago: CARDS_ONLY_FORMA_PAGO,
      configuracion: {
        urlRedirect: "https://app.example.org/donar/gracias",
        urlWebhook: "https://app.example.org/webhooks/wompi",
        esMontoEditable: false,
        esCantidadEditable: false,
        notificarTransaccionCliente: false
      }
    });
    // Vigencia is entirely in the past (deactivates the link) yet spans at least 5 minutes.
    const start = new Date(body.vigencia.fechaInicio).getTime();
    const end = new Date(body.vigencia.fechaFin).getTime();
    expect(end).toBeLessThan(Date.now());
    expect(end - start).toBeGreaterThanOrEqual(5 * 60 * 1000);
  });

  it("mirrors the nombreProducto on deactivation (PUT replaces the whole object)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "wompi-access-token", expires_in: 3600, token_type: "Bearer" }))
      .mockResolvedValueOnce(jsonResponse({ idEnlace: 555, usable: false }));
    vi.stubGlobal("fetch", fetchMock);

    await new WompiApiService(realEnv()).deactivatePaymentLink(intent({ wompi_id_enlace: 555, gift_type: "OFRENDA" }));

    const body = JSON.parse(String(fetchMock.mock.calls[1][1]?.body)) as { nombreProducto: string };
    // Must equal what create sent for the same intent, or the PUT would rename the link.
    expect(body.nombreProducto).toBe("Diezmos y Ofrendas");
  });

  it("does not call fetch when deactivating in mock mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const service = new WompiApiService(mockEnv());
    await service.deactivatePaymentLink(intent({ wompi_id_enlace: 555 }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not call fetch when the intent has no wompi_id_enlace", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const service = new WompiApiService(realEnv());
    await service.deactivatePaymentLink(intent({ wompi_id_enlace: null }));

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws a typed error with the response text on a non-2xx deactivation response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "wompi-access-token", expires_in: 3600, token_type: "Bearer" }))
      .mockResolvedValueOnce(new Response("enlace no encontrado", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new WompiApiService(realEnv());

    const error = await service.deactivatePaymentLink(intent({ wompi_id_enlace: 555 })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WompiApiError);
    expect((error as WompiApiError).message).toContain("404");
    expect((error as WompiApiError).message).toContain("enlace no encontrado");
    expect((error as WompiApiError).message).not.toContain("test-client-secret");
  });
});

const TOKEN_CACHE_KEY = "wompi_api_token";

describe("Wompi API OAuth token cache", () => {
  it("reuses a cached token that is not expiring soon, skipping the token fetch", async () => {
    const db = new FakeD1();
    // A cached token valid for another hour: create must not hit the token URL.
    db.settings.set(
      TOKEN_CACHE_KEY,
      JSON.stringify({ token: "cached-token", expiresAt: new Date(Date.now() + 3600_000).toISOString() })
    );
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse({ idEnlace: 1, urlEnlace: "https://s.wompi.sv/1", urlEnlaceLargo: "https://pagos.wompi.sv/L?id=1" })
    );
    vi.stubGlobal("fetch", fetchMock);

    await new WompiApiService(realEnv(db)).createPaymentLink(intent());

    // Only the EnlacePago call — no token request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [linkUrl, linkInit] = fetchMock.mock.calls[0];
    expect(linkUrl).toBe("https://api.wompi.sv/EnlacePago");
    expect((linkInit?.headers as Record<string, string>).authorization).toBe("Bearer cached-token");
  });

  it("fetches a fresh token on a cache miss and stores it with a 60s safety margin", async () => {
    const db = new FakeD1();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "fresh-token", expires_in: 3600, token_type: "Bearer" }))
      .mockResolvedValueOnce(
        jsonResponse({ idEnlace: 1, urlEnlace: "https://s.wompi.sv/1", urlEnlaceLargo: "https://pagos.wompi.sv/L?id=1" })
      );
    vi.stubGlobal("fetch", fetchMock);

    const before = Date.now();
    await new WompiApiService(realEnv(db)).createPaymentLink(intent());
    const after = Date.now();

    // Token fetch happened, then the link call used the fresh token.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://id.wompi.sv/connect/token");

    const cached = JSON.parse(String(db.settings.get(TOKEN_CACHE_KEY))) as { token: string; expiresAt: string };
    expect(cached.token).toBe("fresh-token");
    // expiresAt ≈ now + (expires_in - 60)s.
    const expiresAtMs = new Date(cached.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(before + (3600 - 60) * 1000);
    expect(expiresAtMs).toBeLessThanOrEqual(after + (3600 - 60) * 1000);
  });

  it("refetches when the cached token is expiring within 60 seconds", async () => {
    const db = new FakeD1();
    // Cached token that expires in 30s — inside the 60s margin, so it must refetch.
    db.settings.set(
      TOKEN_CACHE_KEY,
      JSON.stringify({ token: "stale-token", expiresAt: new Date(Date.now() + 30_000).toISOString() })
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "renewed-token", expires_in: 3600, token_type: "Bearer" }))
      .mockResolvedValueOnce(
        jsonResponse({ idEnlace: 1, urlEnlace: "https://s.wompi.sv/1", urlEnlaceLargo: "https://pagos.wompi.sv/L?id=1" })
      );
    vi.stubGlobal("fetch", fetchMock);

    await new WompiApiService(realEnv(db)).createPaymentLink(intent());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("https://id.wompi.sv/connect/token");
    const [, linkInit] = fetchMock.mock.calls[1];
    expect((linkInit?.headers as Record<string, string>).authorization).toBe("Bearer renewed-token");
    expect(String(db.settings.get(TOKEN_CACHE_KEY))).toContain("renewed-token");
  });

  it("invalidates the cache and retries once with a fresh token on a 401 from create", async () => {
    const db = new FakeD1();
    db.settings.set(
      TOKEN_CACHE_KEY,
      JSON.stringify({ token: "revoked-token", expiresAt: new Date(Date.now() + 3600_000).toISOString() })
    );
    const fetchMock = vi
      .fn()
      // First EnlacePago with the (server-side revoked) cached token → 401.
      .mockResolvedValueOnce(new Response("token inválido", { status: 401 }))
      // Retry: fresh token fetch, then a successful create.
      .mockResolvedValueOnce(jsonResponse({ access_token: "retry-token", expires_in: 3600, token_type: "Bearer" }))
      .mockResolvedValueOnce(
        jsonResponse({ idEnlace: 7, urlEnlace: "https://s.wompi.sv/7", urlEnlaceLargo: "https://pagos.wompi.sv/L?id=7" })
      );
    vi.stubGlobal("fetch", fetchMock);

    const link = await new WompiApiService(realEnv(db)).createPaymentLink(intent());
    expect(link.idEnlace).toBe(7);

    // 3 calls: failed create (cached token), token refetch, successful create.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect((fetchMock.mock.calls[0][1]?.headers as Record<string, string>).authorization).toBe("Bearer revoked-token");
    expect(fetchMock.mock.calls[1][0]).toBe("https://id.wompi.sv/connect/token");
    expect((fetchMock.mock.calls[2][1]?.headers as Record<string, string>).authorization).toBe("Bearer retry-token");
    // The revoked token was replaced in the cache.
    expect(String(db.settings.get(TOKEN_CACHE_KEY))).toContain("retry-token");
  });

  it("does not retry a second time if the fresh token is also rejected with 401", async () => {
    const db = new FakeD1();
    db.settings.set(
      TOKEN_CACHE_KEY,
      JSON.stringify({ token: "revoked-token", expiresAt: new Date(Date.now() + 3600_000).toISOString() })
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("token inválido", { status: 401 }))
      .mockResolvedValueOnce(jsonResponse({ access_token: "retry-token", expires_in: 3600, token_type: "Bearer" }))
      .mockResolvedValueOnce(new Response("token inválido", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await new WompiApiService(realEnv(db)).createPaymentLink(intent()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WompiApiError);
    expect((error as WompiApiError).message).toContain("401");
    // No third create attempt: failed create, refetch, failed retry = 3 calls.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

function intent(overrides: Partial<DonationIntentRecord> = {}): DonationIntentRecord {
  return {
    id: "di_test",
    status: "PENDING",
    amount_cents: 2550,
    donor_name: "Juan Donante",
    donor_document_type: "13",
    donor_document: "000000000",
    donor_email: "juan@example.org",
    donor_phone: null,
    direccion_departamento: "06",
    direccion_municipio: "22",
    direccion_distrito: "01",
    direccion_complemento: "San Salvador",
    donor_pais: null,
    gift_type: null,
    wompi_id_enlace: null,
    wompi_url_enlace: null,
    wompi_url_enlace_largo: null,
    document_id: null,
    client_ip: null,
    datos_token_hash: null,
    rate_limit_claim_id: null,
    paid_at: null,
    created_at: "2026-07-05T12:00:00.000Z",
    updated_at: "2026-07-05T12:00:00.000Z",
    expires_at: "2026-07-05T13:00:00.000Z",
    ...overrides
  };
}

function realEnv(db: FakeD1 = new FakeD1()): Env {
  return {
    DB: db as unknown as D1Database,
    ISSUANCE_QUEUE: {} as Queue,
    ASSETS: {} as Fetcher,
    ARCHIVE: {} as R2Bucket,
    MOCK_EXTERNAL_SERVICES: "false",
    APP_ORIGIN: "https://app.example.org",
    WOMPI_CLIENT_ID: "test-client-id",
    WOMPI_CLIENT_SECRET: "test-client-secret",
    EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
  };
}

function mockEnv(): Env {
  return { ...realEnv(), MOCK_EXTERNAL_SERVICES: "true" };
}

function emisorConfig() {
  return {
    tipoDocumento: "36",
    numDocumento: "10000000000001",
    nrc: null,
    nombre: "Iglesia Demo",
    codActividad: "94910",
    descActividad: "Actividades de organizaciones religiosas",
    nombreComercial: "Iglesia Demo",
    direccion: { departamento: "06", municipio: "22", distrito: "01", complemento: "San Salvador, El Salvador" },
    telefono: "70000003",
    correo: "dte@example.org",
    codEstable: "0001",
    codEstableMH: "0001",
    codPuntoVenta: "01",
    codPuntoVentaMH: "0001",
    controlPrefix: "00010001",
    defaultReceptorTipoDocumento: "13",
    defaultCodPais: "SV",
    defaultDonationType: 1,
    defaultUnidadMedida: 99,
    paymentMethodCode: null,
    responsable: { nombre: "Responsable Legal", tipoDocumento: "13", numeroDocumento: "000000000", tipoEstablecimiento: "02" }
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
