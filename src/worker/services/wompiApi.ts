import { getEmisorConfig, isMockMode, requireSecret } from "../config";
import type { DonationIntentRecord, Env, WompiPaymentLink } from "../types";
import { addHours, nowIso } from "../utils/dates";

const TOKEN_URL = "https://id.wompi.sv/connect/token";
const ENLACE_PAGO_URL = "https://api.wompi.sv/EnlacePago";
const LINK_VALIDITY_HOURS = 1;

// Thrown on any non-2xx from Wompi (token or link creation). The message carries
// only the HTTP status + response text — never the client credentials.
export class WompiApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WompiApiError";
  }
}

interface WompiTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

interface WompiEnlacePagoResponse {
  idEnlace: number;
  urlEnlace: string;
  urlEnlaceLargo: string;
}

export class WompiApiService {
  constructor(private readonly env: Env) {}

  async createPaymentLink(intent: DonationIntentRecord): Promise<WompiPaymentLink> {
    // Mock mode: deterministic fake link, no network. Mirrors MhClient's
    // isMockMode short-circuit so local dev and CI never reach Wompi.
    if (isMockMode(this.env)) {
      return {
        idEnlace: mockLinkId(intent.id),
        urlEnlace: `https://mock.wompi.sv/enlace/${intent.id}`,
        urlEnlaceLargo: `https://mock.wompi.sv/enlace-largo/${intent.id}`
      };
    }

    const origin = requireSecret(this.env, "APP_ORIGIN");
    const nombreComercial = displayName(this.env);

    // No token caching in v1: donation frequency is low enough that one token per
    // link creation is fine, and it keeps the service stateless.
    const token = await this.requestToken();

    const start = nowIso();
    const body = {
      identificadorEnlaceComercio: intent.id,
      monto: centsToAmount(intent.amount_cents),
      nombreProducto: `Donación ${nombreComercial}`,
      limitesDeUso: {
        cantidadMaximaPagosExitosos: 1
      },
      vigencia: {
        fechaInicio: start,
        fechaFin: addHours(start, LINK_VALIDITY_HOURS)
      },
      configuracion: {
        urlRedirect: `${origin}/donar/gracias`,
        urlWebhook: `${origin}/webhooks/wompi`
      }
    };

    const response = await fetch(ENLACE_PAGO_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new WompiApiError(`Wompi rechazó la creación del enlace de pago: ${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as WompiEnlacePagoResponse;
    return { idEnlace: data.idEnlace, urlEnlace: data.urlEnlace, urlEnlaceLargo: data.urlEnlaceLargo };
  }

  private async requestToken(): Promise<string> {
    const form = new URLSearchParams();
    form.set("grant_type", "client_credentials");
    form.set("audience", "wompi_api");
    form.set("client_id", requireSecret(this.env, "WOMPI_CLIENT_ID"));
    form.set("client_secret", requireSecret(this.env, "WOMPI_CLIENT_SECRET"));
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form
    });
    if (!response.ok) {
      // Report status + body only; the credentials in `form` never appear here.
      throw new WompiApiError(`Wompi rechazó la autenticación: ${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as WompiTokenResponse;
    if (!data.access_token) {
      throw new WompiApiError("Wompi no devolvió access_token en la respuesta de autenticación");
    }
    return data.access_token;
  }
}

// Wompi's monto is a decimal amount in USD; we store integer cents. Round-trip
// through cents keeps floating-point noise out (e.g. 2550 -> 25.5, not 25.4999).
function centsToAmount(cents: number): number {
  return Math.round(cents) / 100;
}

function displayName(env: Env): string {
  const config = getEmisorConfig(env);
  const name = config.nombreComercial?.trim() || config.nombre.trim();
  return name;
}

// Deterministic positive integer derived from the intent id, so mock links carry
// a stable numeric idEnlace without any randomness across runs.
function mockLinkId(intentId: string): number {
  let hash = 0;
  for (let i = 0; i < intentId.length; i += 1) {
    hash = (hash * 31 + intentId.charCodeAt(i)) % 1_000_000_007;
  }
  return hash + 1;
}
