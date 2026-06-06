import type { Ambiente, WompiWebhook } from "../types";
import { bytesToBase64, hexFromBytes, timingSafeEqual, utf8Bytes } from "../utils/encoding";

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
    throw new Error("Monto must be a positive decimal value");
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
