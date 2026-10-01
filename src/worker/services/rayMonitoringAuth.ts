import type { Env } from "../types";
import { base64ToBytes, utf8Bytes } from "../utils/encoding";
import { isRecord } from "../utils/guards";

export class RayMonitorAuthError extends Error {
  constructor(readonly code: "monitor_disabled" | "monitor_unauthorized" | "monitor_auth_unavailable", readonly status: 401 | 503) {
    super(code);
  }
}

interface AccessKey extends JsonWebKey { kid: string; }
const keyCache = new Map<string, { expiresAt: number; keys: Promise<AccessKey[]> }>();

function decodePart(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid JWT encoding");
  return base64ToBytes(value.replace(/-/g, "+").replace(/_/g, "/"));
}

async function fetchKeys(issuer: string): Promise<AccessKey[]> {
  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (!response.ok || !response.body) throw new Error("Access certificates unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) throw new Error("Access certificates too large");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(body) || !Array.isArray(body.keys) || body.keys.length > 20) throw new Error("Invalid Access certificates");
  const keys = body.keys.filter((key): key is AccessKey => isRecord(key) && key.kty === "RSA" && key.alg === "RS256" && key.use === "sig" && typeof key.kid === "string" && typeof key.n === "string" && typeof key.e === "string");
  if (!keys.length) throw new Error("Missing Access certificates");
  return keys;
}

function keysFor(issuer: string, now: number): Promise<AccessKey[]> {
  const cached = keyCache.get(issuer);
  if (cached && cached.expiresAt > now) return cached.keys;
  if (keyCache.size >= 4) keyCache.delete(keyCache.keys().next().value!);
  const entry = { expiresAt: now + 60_000, keys: fetchKeys(issuer) };
  // Cache failed lookups briefly too; attacker-controlled kids never trigger refresh.
  entry.keys = entry.keys.catch((error: unknown) => { entry.expiresAt = now + 5000; throw error; });
  keyCache.set(issuer, entry);
  return entry.keys;
}

export async function authorizeRayMonitor(request: Request, env: Env, now: number): Promise<string> {
  const team = env.RAY_MONITOR_ACCESS_TEAM_DOMAIN;
  const audience = env.RAY_MONITOR_ACCESS_AUD;
  const clientId = env.RAY_MONITOR_ACCESS_CLIENT_ID;
  const cutoff = env.RAY_MONITOR_NOT_AFTER;
  const notAfter = typeof cutoff === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(cutoff) ? Date.parse(cutoff) : NaN;
  if ((env.APP_ENV !== "production" && env.APP_ENV !== "staging")
    || !team || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(team)
    || !audience || audience.length > 256 || !clientId || clientId.length > 256
    || !Number.isFinite(notAfter) || new Date(notAfter).toISOString() !== cutoff || notAfter <= now || !env.RAY_MONITOR_RATE_LIMITER) {
    throw new RayMonitorAuthError("monitor_disabled", 503);
  }
  const issuer = `https://${team}`;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  let signature: Uint8Array;
  let signed: string;
  try {
    if (!token || token.length > 8192) throw new Error("Missing token");
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");
    const parsedHeader: unknown = JSON.parse(new TextDecoder().decode(decodePart(parts[0])));
    const parsedClaims: unknown = JSON.parse(new TextDecoder().decode(decodePart(parts[1])));
    if (!isRecord(parsedHeader) || !isRecord(parsedClaims)) throw new Error("Invalid token");
    header = parsedHeader;
    claims = parsedClaims;
    signature = decodePart(parts[2]);
    signed = `${parts[0]}.${parts[1]}`;
    const seconds = Math.floor(now / 1000);
    if (header.alg !== "RS256" || typeof header.kid !== "string" || header.kid.length > 256
      || claims.type !== "app" || claims.sub !== "" || "email" in claims
      || claims.iss !== issuer || claims.common_name !== clientId
      || !Array.isArray(claims.aud) || claims.aud.length !== 1 || claims.aud[0] !== audience
      || typeof claims.exp !== "number" || !Number.isSafeInteger(claims.exp) || claims.exp <= seconds
      || typeof claims.iat !== "number" || !Number.isSafeInteger(claims.iat) || claims.iat > seconds || claims.iat >= claims.exp
      || (claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isSafeInteger(claims.nbf) || claims.nbf > seconds))) {
      throw new Error("Invalid token claims");
    }
  } catch {
    throw new RayMonitorAuthError("monitor_unauthorized", 401);
  }
  let keys: AccessKey[];
  try { keys = await keysFor(issuer, now); } catch { throw new RayMonitorAuthError("monitor_auth_unavailable", 503); }
  try {
    const jwk = keys.find(key => key.kid === header.kid);
    if (!jwk) throw new Error("Unknown key");
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, utf8Bytes(signed))) throw new Error("Invalid signature");
  } catch {
    throw new RayMonitorAuthError("monitor_unauthorized", 401);
  }
  const expiresAt = Math.min(notAfter, (claims.exp as number) * 1000);
  if (expiresAt <= Date.now()) throw new RayMonitorAuthError("monitor_unauthorized", 401);
  return new Date(expiresAt).toISOString();
}
