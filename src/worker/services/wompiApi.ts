import { getEmisorConfig, isMockMode, requireSecret } from "../config";
import type { DonationIntentRecord, Env, WompiPaymentLink } from "../types";
import { addHours, addMinutes, nowIso } from "../utils/dates";

const TOKEN_URL = "https://id.wompi.sv/connect/token";
const ENLACE_PAGO_URL = "https://api.wompi.sv/EnlacePago";
const LINK_VALIDITY_HOURS = 1;
// Deactivation vigencia window: fully in the past yet >=5 minutes wide (Wompi's
// minimum). OFFSET pushes fechaFin safely before now; SPAN is the window width.
const PAST_VIGENCIA_OFFSET_MINUTES = 60;
const PAST_VIGENCIA_SPAN_MINUTES = 6;

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

    // No token caching in v1: donation frequency is low enough that one token per
    // link creation is fine, and it keeps the service stateless.
    const token = await this.requestToken();

    const start = nowIso();
    const body = {
      identificadorEnlaceComercio: intent.id,
      monto: centsToAmount(intent.amount_cents),
      nombreProducto: this.productName(),
      limitesDeUso: {
        cantidadMaximaPagosExitosos: 1
      },
      vigencia: {
        fechaInicio: start,
        fechaFin: addHours(start, LINK_VALIDITY_HOURS)
      },
      // esMontoEditable/esCantidadEditable false pins the amount: the donor cannot
      // change the monto or quantity on Wompi's hosted sheet, so the paid amount
      // always matches the intent (and the CDE we later emit).
      configuracion: this.linkConfiguracion()
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

  // Deactivates an expired link by replacing its whole object with a fully-past
  // vigencia window. Wompi's (undocumented) PUT /EnlacePago/{id} makes a link with a
  // past vigencia usable: false. The window must span >=5 minutes ("El tiempo de
  // vigencia mínimo es de 5 minutos") — we use 6 to stay clear of the boundary. The
  // PUT replaces the entire object, so we resend the full create body (identifier,
  // monto, nombreProducto, configuracion) or those fields would be nulled.
  async deactivatePaymentLink(intent: Pick<DonationIntentRecord, "id" | "wompi_id_enlace" | "amount_cents">): Promise<void> {
    // Mock mode: no network, mirroring createPaymentLink's short-circuit.
    if (isMockMode(this.env)) {
      return;
    }
    // Nothing to deactivate if the intent never got a link (e.g. it expired while
    // still PENDING because link creation failed).
    if (intent.wompi_id_enlace == null) {
      return;
    }

    const token = await this.requestToken();

    const end = nowIso();
    const start = addMinutes(end, -PAST_VIGENCIA_SPAN_MINUTES - PAST_VIGENCIA_OFFSET_MINUTES);
    const body = {
      idEnlace: intent.wompi_id_enlace,
      identificadorEnlaceComercio: intent.id,
      monto: centsToAmount(intent.amount_cents),
      nombreProducto: this.productName(),
      vigencia: {
        // Fully in the past (both ends before now) so Wompi marks the link unusable,
        // yet the span is >=5 minutes so it passes the minimum-vigencia validation.
        fechaInicio: start,
        fechaFin: addMinutes(end, -PAST_VIGENCIA_OFFSET_MINUTES)
      },
      configuracion: this.linkConfiguracion()
    };

    const response = await fetch(`${ENLACE_PAGO_URL}/${intent.wompi_id_enlace}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      throw new WompiApiError(`Wompi rechazó la desactivación del enlace de pago: ${response.status} ${await response.text()}`);
    }
  }

  private productName(): string {
    return `Donación ${displayName(this.env)}`;
  }

  private linkConfiguracion(): { urlRedirect: string; urlWebhook: string; esMontoEditable: false; esCantidadEditable: false } {
    const origin = requireSecret(this.env, "APP_ORIGIN");
    return {
      urlRedirect: `${origin}/donar/gracias`,
      urlWebhook: `${origin}/webhooks/wompi`,
      esMontoEditable: false,
      esCantidadEditable: false
    };
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
