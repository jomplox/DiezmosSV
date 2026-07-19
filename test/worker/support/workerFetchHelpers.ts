import { hexFromBytes, utf8Bytes } from "../../../src/worker/utils/encoding";

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
  });
}

export async function signWompiBody(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Bytes(body)));
  return hexFromBytes(digest);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hexFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
