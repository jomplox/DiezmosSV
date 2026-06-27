import { base64ToBytes, base64UrlFromBytes, base64UrlFromString, hexFromBytes, utf8Bytes } from "../utils/encoding";

export interface ParsedMhCertificate {
  nit: string;
  publicKeyBase64: string;
  privateKeyBase64: string;
  privateKeyPasswordHash: string;
  active: boolean;
}

export async function signMhDocument(document: unknown, certXml: string, password: string): Promise<string> {
  const certificate = await parseMhCertificate(certXml);
  if (!certificate.active) {
    throw new Error("El certificado MH no está activo");
  }
  const passwordHash = await sha512Hex(password);
  if (passwordHash !== certificate.privateKeyPasswordHash.toLowerCase()) {
    throw new Error("La contraseña de la llave privada MH no coincide");
  }

  const header = base64UrlFromString(JSON.stringify({ alg: "RS512" }));
  const payload = base64UrlFromString(JSON.stringify(document, null, 2));
  const signingInput = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    base64ToBytes(certificate.privateKeyBase64),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8Bytes(signingInput));
  return `${signingInput}.${base64UrlFromBytes(new Uint8Array(signature))}`;
}

export async function verifyMhJws(jws: string, certXml: string): Promise<boolean> {
  const certificate = await parseMhCertificate(certXml);
  const [encodedHeader, encodedPayload, encodedSignature] = jws.split(".");
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "spki",
    base64ToBytes(certificate.publicKeyBase64),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-512" },
    false,
    ["verify"]
  );
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(encodedSignature),
    utf8Bytes(`${encodedHeader}.${encodedPayload}`)
  );
}

export async function parseMhCertificate(certXml: string): Promise<ParsedMhCertificate> {
  const privateBlock = extractTag(certXml, "privateKey");
  const publicBlock = extractTag(certXml, "publicKey");
  return {
    nit: extractTag(certXml, "nit"),
    publicKeyBase64: extractTag(publicBlock, "encodied"),
    privateKeyBase64: extractTag(privateBlock, "encodied"),
    privateKeyPasswordHash: extractTag(privateBlock, "clave").toLowerCase(),
    active: extractTag(certXml, "activo").toLowerCase() === "true"
  };
}

async function sha512Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-512", utf8Bytes(value));
  return hexFromBytes(new Uint8Array(digest));
}

function extractTag(xml: string, tag: string): string {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!match) {
    throw new Error(`Missing <${tag}> in MH certificate XML`);
  }
  return match[1].trim();
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return base64ToBytes(padded);
}
