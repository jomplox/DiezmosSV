import type { DonationIntentRecord, WompiWebhook } from "../types";
import { bytesToBase64, timingSafeEqual, utf8Bytes } from "../utils/encoding";
import { isRecord } from "../utils/guards";
import { normalizeWompiWebhook } from "./wompi";

// n1co is a donor-selected alternative to Wompi on the SV door. Its webhook is
// only a signal: the paid state, amount, and buyer always come from an
// authenticated GET of the order, which is then expressed as the same canonical
// payload the Wompi pipeline already issues CDEs from (marked Proveedor N1CO).

type JsonRecord = Record<string, unknown>;

export const N1CO_SIGNATURE_HEADER = "x-h4b-hmac-sha256";

export class N1coPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "N1coPayloadError";
  }
}

export interface N1coWebhookEvent {
  orderId: number;
  orderReference: string | null;
  orderType: string;
  type: string;
}

type N1coOrderIdentity = Pick<DonationIntentRecord, "id" | "amount_cents"> & {
  n1co_order_id?: number | null;
  n1co_order_code?: string | null;
};

// n1co signs the raw body with HMAC-SHA256 and sends it Base64-encoded (confirmed
// on sandbox deliveries: 44 characters, despite older docs that said hex).
export async function verifyN1coSignature(rawBody: string, received: string | null, secret: string): Promise<boolean> {
  const signature = received?.trim();
  if (!signature || !secret) {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Bytes(rawBody)));
  return timingSafeEqual(signature, bytesToBase64(digest));
}

export function parseN1coWebhookEvent(input: unknown): N1coWebhookEvent {
  if (!isRecord(input)) {
    throw new N1coPayloadError("El evento n1co debe ser un objeto JSON");
  }
  const orderId = positiveInteger(input.orderId);
  const orderType = nonEmptyString(input.orderType);
  const type = nonEmptyString(input.type);
  if (orderId === null || !orderType || !type) {
    throw new N1coPayloadError("El evento n1co no tiene orderId, orderType y type");
  }
  return { orderId, orderReference: nonEmptyString(input.orderReference), orderType, type };
}

// Returns null while the order is unpaid. Throws when the authenticated lookup
// disagrees with the intent: such an order is never turned into fiscal work.
export function n1coWebhookFromOrder(
  intent: N1coOrderIdentity,
  order: unknown,
  context: { observedAt: string; production: boolean }
): WompiWebhook | null {
  if (!isRecord(order)) {
    throw new N1coPayloadError("La consulta de la orden n1co no devolvió un objeto JSON");
  }
  const orderId = positiveInteger(order.orderId);
  if (orderId === null || orderId !== intent.n1co_order_id) {
    throw new N1coPayloadError("La orden n1co no coincide con la intención");
  }
  if (nonEmptyString(order.orderCode) !== intent.n1co_order_code) {
    throw new N1coPayloadError("El código de la orden n1co no coincide con la intención");
  }
  if (nonEmptyString(order.orderReference) !== intent.id) {
    throw new N1coPayloadError("La referencia de la orden n1co no coincide con la intención");
  }
  const status = nonEmptyString(order.orderStatus)?.toUpperCase();
  if (status !== "PAID" && status !== "FINALIZED") {
    return null;
  }
  const store = isRecord(order.store) ? order.store : {};
  const currency = nonEmptyString(store.currencyCode);
  if (currency !== null && currency.toUpperCase() !== "USD") {
    throw new N1coPayloadError("La orden n1co no está en USD");
  }
  const total = typeof order.total === "number" ? order.total : Number(order.total);
  if (!Number.isFinite(total) || total <= 0 || Math.round(total * 100) !== intent.amount_cents) {
    throw new N1coPayloadError("El monto pagado en n1co no coincide con la intención");
  }
  const payment = isRecord(order.payment) ? order.payment : {};
  const buyer = isRecord(payment.buyer) ? payment.buyer : {};
  const name = nonEmptyString(order.name);

  return normalizeWompiWebhook({
    IdCuenta: "",
    FechaTransaccion: context.observedAt,
    Monto: (intent.amount_cents / 100).toFixed(2),
    IdTransaccion: `n1co-${orderId}`,
    ResultadoTransaccion: "ExitosaAprobada",
    CodigoAutorizacion: nonEmptyString(payment.authorizationCode),
    IdIntentoPago: null,
    Cantidad: 1,
    EsProductiva: context.production,
    Proveedor: "N1CO",
    Aplicativo: { Nombre: "n1co" },
    EnlacePago: {
      Id: orderId,
      IdentificadorEnlaceComercio: intent.id,
      ...(name ? { NombreProducto: name } : {})
    },
    Cliente: compact({
      Nombre: nonEmptyString(buyer.name),
      EMail: nonEmptyString(buyer.email),
      Celular: nonEmptyString(buyer.phone)
    })
  });
}

function compact(record: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== null && value !== undefined));
}

function positiveInteger(value: unknown): number | null {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^[1-9][0-9]{0,15}$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
