import { isMockMode, mhEndpoint, requireSecret } from "../config";
import type { Ambiente, Env, MhResponse } from "../types";
import { nowIso } from "../utils/dates";
import { generationCode } from "../utils/ids";
import { assertDeploymentAllowsAmbiente } from "./environmentPolicy";

const MH_REQUEST_TIMEOUT_MS = 60 * 1000;
const MH_REDACTION = "[REDACTED]";
const PUBLIC_INDETERMINATE_ESTADOS = new Set([
  "ACEPTADO",
  "NO PROCESADO",
  "PROCESADO",
  "RECIBIDO",
  "RECHAZADO"
]);

export class MhClient {
  constructor(private readonly env: Env) {}

  async transmitDte(input: { ambiente: Ambiente; version: number; tipoDte: string; codigoGeneracion: string; signedJws: string }): Promise<MhResponse> {
    assertDeploymentAllowsAmbiente(this.env, input.ambiente);
    if (isMockMode(this.env)) {
      return mockAccepted(input.codigoGeneracion);
    }
    const token = await this.getPreDispatchToken(input.ambiente);
    const response = await fetchMh(mhEndpoint(this.env, "recepcion", input.ambiente), {
      method: "POST",
      headers: this.jsonHeaders(token),
      body: JSON.stringify({
        ambiente: input.ambiente,
        idEnvio: Date.now(),
        version: input.version,
        tipoDte: input.tipoDte,
        codigoGeneracion: input.codigoGeneracion,
        documento: input.signedJws
      })
    });
    return parseMhResponse(response, this.providerRedactions(input.ambiente, token));
  }

  async transmitInvalidacion(input: { ambiente: Ambiente; version: number; signedJws: string }): Promise<MhResponse> {
    assertDeploymentAllowsAmbiente(this.env, input.ambiente);
    if (isMockMode(this.env)) {
      return mockAccepted(generationCode());
    }
    const token = await this.getPreDispatchToken(input.ambiente);
    const response = await fetchMh(mhEndpoint(this.env, "anulacion", input.ambiente), {
      method: "POST",
      headers: this.jsonHeaders(token),
      body: JSON.stringify({
        ambiente: input.ambiente,
        idEnvio: Date.now(),
        version: input.version,
        documento: input.signedJws
      })
    });
    return parseMhResponse(response, this.providerRedactions(input.ambiente, token));
  }

  // Los métodos de contingencia (evento y lotes) se eliminaron: el Anexo de
  // validaciones del evento de contingencia (campo 35) excluye el tipo 15 (CDE),
  // por lo que este emisor nunca transmite en esa modalidad.

  private async getToken(ambiente: Ambiente): Promise<string> {
    const cached = await this.env.DB.prepare("SELECT token, token_type, expires_at FROM mh_tokens WHERE environment = ?")
      .bind(ambiente)
      .first<{ token: string; token_type: string; expires_at: string }>();
    if (cached && new Date(cached.expires_at).getTime() > Date.now() + 5 * 60 * 1000) {
      return cached.token;
    }

    const credentials = this.credentials(ambiente);
    const primaryAuthUrl = mhEndpoint(this.env, "auth", ambiente);
    let data = await this.authenticate(primaryAuthUrl, credentials);
    let token = data.body?.token;

    // Some Ministerio de Hacienda test accounts are provisioned through the central auth service while still transmitting to TEST endpoints.
    if (!token && ambiente === "00" && isInvalidCredentials(data)) {
      const centralAuthUrl = this.env.MH_AUTH_URL_TEST_FALLBACK?.trim();
      if (centralAuthUrl && centralAuthUrl !== primaryAuthUrl) {
        data = await this.authenticate(centralAuthUrl, credentials);
        token = data.body?.token;
      }
    }

    if (!token) {
      throw new Error("La autenticación con el Ministerio de Hacienda no devolvió body.token");
    }
    const expiresAt = new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString();
    await this.env.DB.prepare(
      `INSERT INTO mh_tokens (environment, token, token_type, expires_at, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(environment) DO UPDATE SET token = excluded.token, token_type = excluded.token_type, expires_at = excluded.expires_at, updated_at = excluded.updated_at`
    )
      .bind(ambiente, token, data.tokenType ?? "Bearer", expiresAt, nowIso())
      .run();
    return token;
  }

  private async getPreDispatchToken(ambiente: Ambiente): Promise<string> {
    try {
      return await this.getToken(ambiente);
    } catch (error) {
      throw new MhPreDispatchError(error instanceof Error ? error.message : String(error), error);
    }
  }

  private async authenticate(url: string, credentials: { user: string; password: string }): Promise<MhAuthResponse> {
    const form = new URLSearchParams();
    form.set("user", credentials.user);
    form.set("pwd", credentials.password);
    const response = await fetchMh(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.env.MH_USER_AGENT ?? "DiezmosSV/1.0"
      },
      body: form
    });
    if (!response.ok) {
      throw new Error(`Falló la autenticación con el Ministerio de Hacienda (HTTP ${response.status})`);
    }
    const text = await response.text();
    if (!text) return {};
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as MhAuthResponse
        : {};
    } catch {
      return {};
    }
  }

  private jsonHeaders(token: string): HeadersInit {
    return {
      Authorization: token,
      "Content-Type": "application/json",
      "User-Agent": this.env.MH_USER_AGENT ?? "DiezmosSV/1.0"
    };
  }

  private credentials(ambiente: Ambiente): { user: string; password: string } {
    if (ambiente === "01") {
      return {
        user: requireSecret(this.env, "MH_USER_PROD"),
        password: requireSecret(this.env, "MH_PASSWORD_PROD")
      };
    }
    return {
      user: requireSecret(this.env, "MH_USER_TEST"),
      password: requireSecret(this.env, "MH_PASSWORD_TEST")
    };
  }

  private providerRedactions(ambiente: Ambiente, authorization: string): string[] {
    const user = ambiente === "01" ? this.env.MH_USER_PROD : this.env.MH_USER_TEST;
    const password = ambiente === "01" ? this.env.MH_PASSWORD_PROD : this.env.MH_PASSWORD_TEST;
    return providerRedactions(user, password, authorization);
  }
}

async function fetchMh(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(MH_REQUEST_TIMEOUT_MS)
    });
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error
      ? String(error.name)
      : "";
    if (name === "AbortError" || name === "TimeoutError") {
      throw new MhUnavailableError("Ministerio de Hacienda no disponible: tiempo de espera agotado");
    }
    throw error;
  }
}

interface MhAuthResponse {
  body?: {
    codigoMsg?: string;
    descripcionMsg?: string;
    token?: string;
  };
  tokenType?: string;
}

function isInvalidCredentials(data: MhAuthResponse): boolean {
  return data.body?.codigoMsg === "106";
}

async function parseMhResponse(response: Response, redactions: string[]): Promise<MhResponse> {
  const raw = sanitizeProviderValue(await safeJson(response), redactions);
  const body = raw as Record<string, unknown>;
  const estado = String(body.estado ?? body.status ?? "RECIBIDO");
  const rawSeal = typeof body.selloRecibido === "string" ? body.selloRecibido.trim() : "";
  const selloRecibido = rawSeal || null;
  const observaciones = Array.isArray(body.observaciones) ? body.observaciones.map(String) : [];
  const normalizedEstado = estado.trim().toUpperCase();
  const accepted = (normalizedEstado === "PROCESADO" || normalizedEstado === "ACEPTADO") && selloRecibido !== null;
  const rejected = normalizedEstado === "RECHAZADO" && selloRecibido === null;
  if (!response.ok) {
    if (response.status === 408 || response.status === 429 || (response.status >= 500 && response.status < 600)) {
      throw new MhUnavailableError(`Ministerio de Hacienda no disponible: ${response.status}`);
    }
    // A 3xx/4xx transport status is terminal only when MH supplies its exact,
    // internally consistent rejection verdict. Empty, malformed, accepted-on-error,
    // and contradictory bodies leave the already-dispatched fiscal outcome unknown.
    if (!rejected) {
      throw new MhUnavailableError(
        `Ministerio de Hacienda devolvió un resultado no definitivo: ${publicIndeterminateEstado(normalizedEstado)} (HTTP ${response.status})`
      );
    }
  }
  if (!accepted && !rejected) {
    // A successful HTTP transport is not itself a terminal fiscal verdict. Empty,
    // malformed, contradictory, substring-like (for example NO PROCESADO),
    // intermediate, and undocumented 2xx bodies leave the external outcome unknown.
    // A positive verdict without its required seal is equally non-definitive.
    throw new MhUnavailableError(
      `Ministerio de Hacienda devolvió un resultado no definitivo: ${publicIndeterminateEstado(normalizedEstado)}`
    );
  }
  return {
    accepted: response.ok && accepted,
    estado,
    selloRecibido,
    observaciones,
    raw
  };
}

function providerRedactions(
  user: string | undefined,
  password: string | undefined,
  authorization: string
): string[] {
  const values = new Set<string>();
  for (const credential of [user, password]) {
    addProviderRedactionVariants(values, credential);
  }
  addProviderRedactionVariants(values, authorization);
  const transmittedAuthorization = authorization.replace(/^[ \t]+|[ \t]+$/g, "");
  addProviderRedactionVariants(values, transmittedAuthorization);
  const bearer = transmittedAuthorization.match(/^(Bearer)[ \t]+(.+)$/i);
  const bearerCredential = bearer?.[2]?.replace(/^[ \t]+|[ \t]+$/g, "");
  if (bearer && bearerCredential) {
    addProviderRedactionVariants(values, bearerCredential);
    values.add(`${bearer[1]}%20${bearerCredential}`);
    values.add(`${bearer[1]}+${bearerCredential}`);
  }
  return [...values].filter(Boolean).sort((left, right) => right.length - left.length);
}

function addProviderRedactionVariants(values: Set<string>, value: string | undefined): void {
  if (!value) return;
  values.add(value);
  values.add(encodeURIComponent(value));
  values.add(new URLSearchParams({ value }).toString().slice("value=".length));
}

function sanitizeProviderValue(value: unknown, redactions: string[]): unknown {
  if (typeof value === "string") {
    return sanitizeProviderText(value, redactions);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeProviderValue(entry, redactions));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        sanitizeProviderText(key, redactions),
        sanitizeProviderValue(entry, redactions)
      ])
    );
  }
  return value;
}

function sanitizeProviderText(value: string, redactions: string[]): string {
  let sanitized = value;
  for (const secret of redactions) {
    sanitized = sanitized.split(secret).join(MH_REDACTION);
  }
  return sanitized;
}

function publicIndeterminateEstado(normalizedEstado: string): string {
  return PUBLIC_INDETERMINATE_ESTADOS.has(normalizedEstado)
    ? normalizedEstado
    : "ESTADO_NO_RECONOCIDO";
}

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function mockAccepted(codigoGeneracion: string): MhResponse {
  const compact = codigoGeneracion.replace(/-/g, "").toUpperCase();
  const sello = `MOCK${compact}${"0".repeat(40)}`.slice(0, 40);
  return {
    accepted: true,
    estado: "PROCESADO",
    selloRecibido: sello,
    observaciones: [],
    raw: { mock: true }
  };
}

export class MhUnavailableError extends Error {
  name = "MhUnavailableError";
}

// Only this error proves that the fiscal POST was never attempted. Once fetch()
// starts, transport failures and retryable HTTP responses are outcome-ambiguous:
// MH may have processed the legal document, so callers must retain their claim.
export class MhPreDispatchError extends Error {
  name = "MhPreDispatchError";

  constructor(message: string, readonly cause: unknown) {
    super(message);
  }
}
