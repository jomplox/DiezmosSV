export function utf8Bytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, "");
  const binary = atob(normalized);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64UrlFromBytes(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64UrlFromString(value: string): string {
  return base64UrlFromBytes(utf8Bytes(value));
}

export function hexFromBytes(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(left: string, right: string): boolean {
  const leftBytes = utf8Bytes(left);
  const rightBytes = utf8Bytes(right);
  if (leftBytes.byteLength !== rightBytes.byteLength) {
    return false;
  }
  let result = 0;
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    result |= leftBytes[index] ^ rightBytes[index];
  }
  return result === 0;
}
