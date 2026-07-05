import { afterEach, describe, expect, it, vi } from "vitest";
import { WompiApiError, WompiApiService } from "../../src/worker/services/wompiApi";
import type { DonationIntentRecord, Env } from "../../src/worker/types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Wompi API service", () => {
  it("mints a single-use payment link with an OAuth token and returns the link fields", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ access_token: "wompi-access-token", expires_in: 3600, token_type: "Bearer" }))
      .mockResolvedValueOnce(jsonResponse({ idEnlace: 987654, urlEnlace: "https://api.wompi.sv/enlace/987654" }));
    vi.stubGlobal("fetch", fetchMock);

    const service = new WompiApiService(realEnv());
    const link = await service.createPaymentLink(intent());

    expect(link).toEqual({ idEnlace: 987654, urlEnlace: "https://api.wompi.sv/enlace/987654" });

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
      configuracion: { urlRedirect: string; urlWebhook: string };
      vigencia: { fechaInicio: string; fechaFin: string };
    };
    expect(body).toMatchObject({
      identificadorEnlaceComercio: "di_test",
      monto: 25.5,
      nombreProducto: "Donación Iglesia Demo",
      limitesDeUso: { cantidadMaximaPagosExitosos: 1 },
      configuracion: {
        urlRedirect: "https://app.example.org/donar/gracias",
        urlWebhook: "https://app.example.org/webhooks/wompi"
      }
    });
    expect(new Date(body.vigencia.fechaFin).getTime() - new Date(body.vigencia.fechaInicio).getTime()).toBe(60 * 60 * 1000);
  });

  it("returns a deterministic mock link without any fetch in mock mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const service = new WompiApiService(mockEnv());
    const link = await service.createPaymentLink(intent());

    expect(link.urlEnlace).toBe("https://mock.wompi.sv/enlace/di_test");
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
    wompi_id_enlace: null,
    wompi_url_enlace: null,
    client_ip: null,
    created_at: "2026-07-05T12:00:00.000Z",
    updated_at: "2026-07-05T12:00:00.000Z",
    expires_at: "2026-07-05T13:00:00.000Z",
    ...overrides
  };
}

function realEnv(): Env {
  return {
    DB: {} as D1Database,
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
