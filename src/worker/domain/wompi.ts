import type { Ambiente, WompiWebhook } from "../types";
import { bytesToBase64, hexFromBytes, timingSafeEqual, utf8Bytes } from "../utils/encoding";
import { isRecord } from "../utils/guards";

type JsonRecord = Record<string, unknown>;

interface ReconciliationIntent {
  id: string;
  wompi_id_enlace: number | null;
  amount_cents: number;
}

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

export function wompiWebhookFromPaymentLink(
  intent: ReconciliationIntent,
  input: unknown
): WompiWebhook | null {
  if (intent.wompi_id_enlace === null) {
    throw new WompiPayloadError("La intención no tiene un enlace Wompi para reconciliar");
  }
  if (!isRecord(input)) {
    throw new WompiPayloadError("La consulta del enlace Wompi no devolvió un objeto JSON");
  }
  const linkId = optionalNumber(input, "idEnlace", "IdEnlace");
  if (!Number.isInteger(linkId) || linkId !== intent.wompi_id_enlace) {
    throw new WompiPayloadError("La respuesta Wompi no coincide con el enlace de la intención");
  }
  const intentId = optionalString(input, "nombreEnlace", "NombreEnlace");
  if (intentId !== intent.id) {
    throw new WompiPayloadError("La respuesta Wompi no coincide con la intención");
  }

  const rawTransactions = read(input, ["transacciones", "Transacciones"]);
  if (rawTransactions == null) {
    return null;
  }
  if (!Array.isArray(rawTransactions)) {
    throw new WompiPayloadError("La lista de transacciones Wompi es inválida");
  }
  const transactions = rawTransactions.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new WompiPayloadError("La consulta Wompi contiene una transacción inválida");
    }
    return candidate;
  });
  const approved = transactions.filter(
    (candidate) => optionalBoolean(candidate, "esAprobada", "EsAprobada") === true
  );
  if (approved.length === 0) {
    return null;
  }
  if (approved.length > 1) {
    throw new WompiPayloadError("El enlace Wompi contiene más de una transacción aprobada");
  }

  const transaction = approved[0];
  const transactionId = requiredString(transaction, "idTransaccion", "IdTransaccion");
  const transactionDate = requiredString(transaction, "fechaTransaccion", "FechaTransaccion");
  if (!Number.isFinite(Date.parse(transactionDate))) {
    throw new WompiPayloadError("La transacción aprobada no tiene una fecha válida");
  }
  const transactionAmount = optionalNumber(transaction, "monto", "Monto");
  if (
    transactionAmount === undefined
    || transactionAmount <= 0
    || Math.round(transactionAmount * 100) !== intent.amount_cents
  ) {
    throw new WompiPayloadError("El monto aprobado no coincide con la intención");
  }
  const production = requiredBoolean(transaction, "esReal", "EsReal");
  const additional = optionalRecord(transaction, "datosAdicionales", "DatosAdicionales") ?? {};

  return normalizeWompiWebhook({
    IdCuenta: "",
    FechaTransaccion: transactionDate,
    Monto: transactionAmount,
    IdTransaccion: transactionId,
    ResultadoTransaccion: "ExitosaAprobada",
    CodigoAutorizacion: optionalString(transaction, "codigoAutorizacion", "CodigoAutorizacion"),
    IdIntentoPago: null,
    Cantidad: 1,
    EsProductiva: production,
    IdExterno: optionalString(transaction, "idExterno", "IdExterno") ?? null,
    EnlacePago: {
      Id: linkId,
      IdentificadorEnlaceComercio: intent.id,
      NombreProducto: optionalString(input, "nombreProducto", "NombreProducto")
    },
    Cliente: {
      Nombre: optionalString(additional, "Nombre", "nombre"),
      Apellidos: optionalString(additional, "Apellidos", "apellidos"),
      Direccion: optionalString(additional, "Direccion", "direccion"),
      EMail: optionalString(additional, "EMail", "Email", "email"),
      Celular: optionalString(additional, "Celular", "celular"),
      NombreRegion: optionalString(additional, "NombreRegion", "nombreRegion"),
      NombrePais: optionalString(additional, "NombrePais", "nombrePais"),
      CodigoPais: optionalString(additional, "CodigoPais", "codigoPais"),
      CodigoRegion: optionalString(additional, "CodigoRegion", "codigoRegion")
    }
  });
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
