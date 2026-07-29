import { CHECKOUT_WINDOW_MINUTES } from "../../shared/checkout";
import { isMockMode, requireSecret } from "../config";
import { Repository } from "../storage/repository";
import type { DonationIntentRecord, Env, WompiPaymentLink } from "../types";
import { addHours, addMinutes, nowIso } from "../utils/dates";

const TOKEN_URL = "https://id.wompi.sv/connect/token";
const ENLACE_PAGO_URL = "https://api.wompi.sv/EnlacePago";
const LINK_VALIDITY_HOURS = 1;
// Shown to the donor on Wompi's hosted sheet; mirrors the /donar brand title.
const PRODUCT_NAME = "Diezmos y Ofrendas";
// Deactivation vigencia window: fully in the past yet >=5 minutes wide (Wompi's
// minimum). OFFSET pushes fechaFin safely before now; SPAN is the window width.
const PAST_VIGENCIA_OFFSET_MINUTES = 60;
const PAST_VIGENCIA_SPAN_MINUTES = 6;
// app_settings key holding the cached client-credentials token as JSON
// { token, expiresAt }. Cached across invocations so "Preparando el pago…" does
// not pay for a token round-trip on every donation.
const TOKEN_CACHE_KEY = "wompi_api_token";
// Refresh margin: treat a token that expires within this window as already stale,
// and shrink the stored lifetime by the same amount so we never present a token
// that Wompi is about to reject at the boundary.
const TOKEN_REFRESH_MARGIN_SECONDS = 60;

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

interface CachedToken {
  token: string;
  expiresAt: string;
}

export class WompiApiService {
  private readonly repo: Repository;

  constructor(private readonly env: Env) {
    // The service constructs its own Repository from env.DB (mirroring
    // pipeline/auth) so it can cache the OAuth token in app_settings.
    this.repo = new Repository(env.DB);
  }

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
      // Cards only: no puntoAgricola, cuotas, bitcoin, quickpay, or nequi.
      formaPago: this.linkFormaPago(),
      // esMontoEditable/esCantidadEditable false pins the amount: the donor cannot
      // change the monto or quantity on Wompi's hosted sheet, so the paid amount
      // always matches the intent (and the CDE we later emit).
      configuracion: this.linkConfiguracion()
    };

    const response = await this.authorizedFetch(ENLACE_PAGO_URL, "POST", body);
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
  async deactivatePaymentLink(intent: Pick<DonationIntentRecord, "id" | "wompi_id_enlace" | "amount_cents" | "gift_type">): Promise<void> {
    // Mock mode: no network, mirroring createPaymentLink's short-circuit.
    if (isMockMode(this.env)) {
      return;
    }
    // Nothing to deactivate if the intent never got a link (e.g. it expired while
    // still PENDING because link creation failed).
    if (intent.wompi_id_enlace == null) {
      return;
    }

    const end = nowIso();
    const start = addMinutes(end, -PAST_VIGENCIA_SPAN_MINUTES - PAST_VIGENCIA_OFFSET_MINUTES);
    const body = {
      idEnlace: intent.wompi_id_enlace,
      identificadorEnlaceComercio: intent.id,
      monto: centsToAmount(intent.amount_cents),
      // Mirror the create nombreProducto: the PUT replaces the whole object, so a
      // mismatch would rename the link.
      nombreProducto: this.productName(),
      vigencia: {
        // Fully in the past (both ends before now) so Wompi marks the link unusable,
        // yet the span is >=5 minutes so it passes the minimum-vigencia validation.
        fechaInicio: start,
        fechaFin: addMinutes(end, -PAST_VIGENCIA_OFFSET_MINUTES)
      },
      // The PUT replaces the whole object, so formaPago and configuracion must be
      // resent or Wompi would re-enable every payment method / re-email the donor.
      formaPago: this.linkFormaPago(),
      configuracion: this.linkConfiguracion()
    };

    const response = await this.authorizedFetch(`${ENLACE_PAGO_URL}/${intent.wompi_id_enlace}`, "PUT", body);
    if (!response.ok) {
      throw new WompiApiError(`Wompi rechazó la desactivación del enlace de pago: ${response.status} ${await response.text()}`);
    }
  }

  // The donor sees this on Wompi's hosted sheet, so it reads as the ministry the
  // entrega belongs to — the same brand title the /donar wizard carries — not as a
  // product being bought. Links are minted per donation, so there is nothing to
  // disambiguate here: the diezmo/ofrenda distinction rides the intent's gift_type
  // onto the CDE apéndice, and the legal cuerpoDocumento.descripcion stays "DONACIÓN".
  private productName(): string {
    return PRODUCT_NAME;
  }

  // Cards-only forma de pago. The permitir/permite prefixes are intentionally
  // inconsistent — they mirror the Wompi EnlaceFormaPago schema exactly.
  private linkFormaPago(): {
    permitirTarjetaCreditoDebido: boolean;
    permitirPagoConPuntoAgricola: boolean;
    permitirPagoEnCuotasAgricola: boolean;
    permitirPagoEnBitcoin: boolean;
    permitePagoQuickPay: boolean;
    permitePagoNequi: boolean;
  } {
    return {
      permitirTarjetaCreditoDebido: true,
      permitirPagoConPuntoAgricola: false,
      permitirPagoEnCuotasAgricola: false,
      permitirPagoEnBitcoin: false,
      permitePagoQuickPay: false,
      permitePagoNequi: false
    };
  }

  private linkConfiguracion(): {
    urlRedirect: string;
    urlWebhook: string;
    esMontoEditable: false;
    esCantidadEditable: false;
    notificarTransaccionCliente: false;
    duracionInterfazIntentoMinutos: number;
  } {
    const origin = requireSecret(this.env, "APP_ORIGIN");
    return {
      urlRedirect: `${origin}/donar/gracias`,
      urlWebhook: `${origin}/webhooks/wompi`,
      esMontoEditable: false,
      esCantidadEditable: false,
      // We send the donor their CDE email ourselves; Wompi must not email them.
      notificarTransaccionCliente: false,
      // Set explicitly rather than inheriting Wompi's undocumented default: production
      // 3DS makes the bank challenge mandatory, and /donar polls for exactly this long.
      duracionInterfazIntentoMinutos: CHECKOUT_WINDOW_MINUTES
    };
  }

  // Performs an authenticated Wompi request using the cached token when possible.
  // A 401 with a cached token means the token was revoked server-side: invalidate
  // the cache and retry ONCE with a freshly-minted token.
  private async authorizedFetch(url: string, method: "POST" | "PUT", body: unknown): Promise<Response> {
    const { token, fromCache } = await this.acquireToken();
    const response = await this.sendAuthorized(url, method, body, token);
    if (response.status === 401 && fromCache) {
      await this.repo.setSetting(TOKEN_CACHE_KEY, "");
      const fresh = await this.acquireToken();
      return this.sendAuthorized(url, method, body, fresh.token);
    }
    return response;
  }

  private sendAuthorized(url: string, method: "POST" | "PUT", body: unknown, token: string): Promise<Response> {
    return fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
  }

  // Returns a usable token, reusing the cache when it is not expiring soon.
  // `fromCache` tells authorizedFetch whether a 401 is worth a fresh-token retry.
  private async acquireToken(): Promise<{ token: string; fromCache: boolean }> {
    const cached = await this.readCachedToken();
    if (cached && !this.isExpiringSoon(cached.expiresAt)) {
      return { token: cached.token, fromCache: true };
    }
    const token = await this.requestToken();
    return { token, fromCache: false };
  }

  private async readCachedToken(): Promise<CachedToken | null> {
    const raw = await this.repo.getSetting(TOKEN_CACHE_KEY);
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<CachedToken>;
      if (typeof parsed.token === "string" && parsed.token && typeof parsed.expiresAt === "string") {
        return { token: parsed.token, expiresAt: parsed.expiresAt };
      }
    } catch {
      // Corrupt cache value: treat as a miss and refetch.
    }
    return null;
  }

  private isExpiringSoon(expiresAt: string): boolean {
    const remainingMs = new Date(expiresAt).getTime() - Date.now();
    return !(remainingMs > TOKEN_REFRESH_MARGIN_SECONDS * 1000);
  }

  // Fetches a fresh client-credentials token and caches it with a safety margin
  // shaved off its lifetime (expiresAt = now + (expires_in - margin)s).
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
    const lifetimeSeconds = Math.max(0, (data.expires_in ?? 0) - TOKEN_REFRESH_MARGIN_SECONDS);
    const expiresAt = new Date(Date.now() + lifetimeSeconds * 1000).toISOString();
    await this.repo.setSetting(TOKEN_CACHE_KEY, JSON.stringify({ token: data.access_token, expiresAt } satisfies CachedToken));
    return data.access_token;
  }
}

// Wompi's monto is a decimal amount in USD; we store integer cents. Round-trip
// through cents keeps floating-point noise out (e.g. 2550 -> 25.5, not 25.4999).
function centsToAmount(cents: number): number {
  return Math.round(cents) / 100;
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
