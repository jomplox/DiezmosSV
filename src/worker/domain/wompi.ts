import type { Ambiente, WompiWebhook } from "../types";
import { bytesToBase64, hexFromBytes, timingSafeEqual, utf8Bytes } from "../utils/encoding";
import { isRecord } from "../utils/guards";

type JsonRecord = Record<string, unknown>;

export class WompiPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WompiPayloadError";
  }
}

export function normalizeWompiWebhook(input: unknown): WompiWebhook {
  if (!isRecord(input)) {
    throw new WompiPayloadError("El webhook Wompi debe ser un objeto JSON");
  }
  const transactionId = requiredString(input, "IdTransaccion", "idTransaccion");
  const result = requiredString(input, "ResultadoTransaccion", "resultadoTransaccion");
  const amount = requiredString(input, "Monto", "monto");
  const transactionDate = requiredString(input, "FechaTransaccion", "fechaTransaccion");
  const production = requiredBoolean(input, "EsProductiva", "esProductiva");
  const accountId = optionalString(input, "IdCuenta", "idCuenta") ?? "";
  const quantity = optionalNumber(input, "Cantidad", "cantidad");
  const app = optionalRecord(input, "Aplicativo", "aplicativo");
  const link = optionalRecord(input, "EnlacePago", "enlacePago");
  const client = optionalRecord(input, "Cliente", "cliente");

  const payload: WompiWebhook = {
    IdCuenta: accountId,
    FechaTransaccion: transactionDate,
    Monto: amount,
    IdTransaccion: transactionId,
    ResultadoTransaccion: result,
    CodigoAutorizacion: optionalString(input, "CodigoAutorizacion", "codigoAutorizacion") ?? null,
    IdIntentoPago: optionalString(input, "IdIntentoPago", "idIntentoPago") ?? null,
    Cantidad: quantity ?? null,
    EsProductiva: production,
    Tarjeta: optionalString(input, "Tarjeta", "tarjeta"),
    EsInternacional: optionalBoolean(input, "EsInternacional", "esInternacional"),
    IdExterno: optionalString(input, "IdExterno", "idExterno")
  };

  if (app) {
    payload.Aplicativo = {
      Nombre: optionalString(app, "Nombre", "nombre"),
      Url: optionalString(app, "Url", "URL", "url"),
      Id: optionalString(app, "Id", "id")
    };
  }
  if (link) {
    payload.EnlacePago = {
      Id: optionalNumber(link, "Id", "id"),
      IdentificadorEnlaceComercio: optionalString(link, "IdentificadorEnlaceComercio", "identificadorEnlaceComercio"),
      NombreProducto: optionalString(link, "NombreProducto", "nombreProducto"),
      DescripcionProducto: optionalString(link, "DescripcionProducto", "descripcionProducto")
    };
  }
  if (client) {
    payload.Cliente = {
      DocumentoIdentidad: optionalString(client, "DocumentoIdentidad", "documentoIdentidad"),
      Nombre: optionalString(client, "Nombre", "nombre"),
      Apellidos: optionalString(client, "Apellidos", "apellidos"),
      Direccion: optionalString(client, "Direccion", "direccion"),
      EMail: optionalString(client, "EMail", "Email", "email", "eMail", "Correo", "correo"),
      Celular: optionalString(client, "Celular", "celular", "Telefono", "telefono"),
      NombreRegion: optionalString(client, "NombreRegion", "nombreRegion"),
      NombrePais: optionalString(client, "NombrePais", "nombrePais"),
      CodigoPais: optionalString(client, "CodigoPais", "codigoPais"),
      CodigoRegion: optionalString(client, "CodigoRegion", "codigoRegion")
    };
  }

  return payload;
}

export function isApprovedDonation(payload: WompiWebhook): boolean {
  return payload.ResultadoTransaccion === "ExitosaAprobada";
}

export function ambienteFromWompi(payload: WompiWebhook): Ambiente {
  return payload.EsProductiva ? "01" : "00";
}

export function donorName(payload: WompiWebhook): string {
  const first = payload.Cliente?.Nombre?.trim() ?? "";
  const last = payload.Cliente?.Apellidos?.trim() ?? "";
  const fullName = `${first} ${last}`.trim();
  return fullName || "Donante";
}

export function amountCents(payload: WompiWebhook): number {
  const amount = Number.parseFloat(payload.Monto);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("El monto debe ser un valor decimal positivo");
  }
  return Math.round(amount * 100);
}

export async function verifyWompiHash(rawBody: string, receivedHash: string | null, secret: string): Promise<boolean> {
  if (!receivedHash) {
    return false;
  }
  const key = await crypto.subtle.importKey("raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Bytes(rawBody)));
  const expectedHex = hexFromBytes(digest);
  const expectedBase64 = bytesToBase64(digest);
  const normalized = receivedHash.trim().replace(/^sha256=/i, "");
  return timingSafeEqual(normalized.toLowerCase(), expectedHex) || timingSafeEqual(normalized, expectedBase64);
}

export function wompiHashHeader(request: Request): string | null {
  return request.headers.get("wompi_hash") ?? request.headers.get("x-wompi-hash");
}

function requiredString(record: JsonRecord, ...keys: string[]): string {
  const value = optionalString(record, ...keys);
  if (!value) {
    throw new WompiPayloadError(`Webhook Wompi inválido: falta ${keys[0]}`);
  }
  return value;
}

function optionalString(record: JsonRecord, ...keys: string[]): string | undefined {
  const value = read(record, keys);
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function requiredBoolean(record: JsonRecord, ...keys: string[]): boolean {
  const value = optionalBoolean(record, ...keys);
  if (typeof value !== "boolean") {
    throw new WompiPayloadError(`Webhook Wompi inválido: falta ${keys[0]}`);
  }
  return value;
}

function optionalBoolean(record: JsonRecord, ...keys: string[]): boolean | undefined {
  const value = read(record, keys);
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "si", "sí"].includes(normalized)) return true;
    if (["false", "0", "no"].includes(normalized)) return false;
  }
  return undefined;
}

function optionalNumber(record: JsonRecord, ...keys: string[]): number | undefined {
  const value = read(record, keys);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const numberValue = Number(value.trim());
    return Number.isFinite(numberValue) ? numberValue : undefined;
  }
  return undefined;
}

function optionalRecord(record: JsonRecord, ...keys: string[]): JsonRecord | undefined {
  const value = read(record, keys);
  return isRecord(value) ? value : undefined;
}

function read(record: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return record[key];
    }
  }
  return undefined;
}
