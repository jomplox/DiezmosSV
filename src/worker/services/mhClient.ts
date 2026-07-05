import { isMockMode, mhEndpoint, requireSecret } from "../config";
import type { Ambiente, Env, MhLoteConsultaResponse, MhLoteSubmitResponse, MhResponse } from "../types";
import { nowIso } from "../utils/dates";
import { generationCode } from "../utils/ids";

export class MhClient {
  constructor(private readonly env: Env) {}

  async transmitDte(input: { ambiente: Ambiente; version: number; tipoDte: string; codigoGeneracion: string; signedJws: string }): Promise<MhResponse> {
    if (isMockMode(this.env)) {
      return mockAccepted(input.codigoGeneracion);
    }
    const token = await this.getToken(input.ambiente);
    const response = await fetch(mhEndpoint(this.env, "recepcion", input.ambiente), {
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
    return parseMhResponse(response);
  }

  async transmitInvalidacion(input: { ambiente: Ambiente; version: number; signedJws: string }): Promise<MhResponse> {
    if (isMockMode(this.env)) {
      return mockAccepted(generationCode());
    }
    const token = await this.getToken(input.ambiente);
    const response = await fetch(mhEndpoint(this.env, "anulacion", input.ambiente), {
      method: "POST",
      headers: this.jsonHeaders(token),
      body: JSON.stringify({
        ambiente: input.ambiente,
        idEnvio: Date.now(),
        version: input.version,
        documento: input.signedJws
      })
    });
    return parseMhResponse(response);
  }

  async transmitContingencia(input: { ambiente: Ambiente; signedJws: string }): Promise<MhResponse> {
    if (isMockMode(this.env)) {
      return mockAccepted(generationCode());
    }
    const token = await this.getToken(input.ambiente);
    const response = await fetch(mhEndpoint(this.env, "contingencia", input.ambiente), {
      method: "POST",
      headers: this.jsonHeaders(token),
      body: JSON.stringify({
        nit: this.credentials(input.ambiente).user,
        documento: input.signedJws
      })
    });
    return parseMhResponse(response);
  }

  async transmitLote(input: { ambiente: Ambiente; idEnvio: string; nitEmisor: string; documentos: string[] }): Promise<MhLoteSubmitResponse> {
    if (isMockMode(this.env)) {
      return {
        accepted: true,
        estado: "PROCESADO",
        codigoLote: `MOCK-${input.idEnvio}`,
        observaciones: [],
        raw: { mock: true }
      };
    }
    const token = await this.getToken(input.ambiente);
    const response = await fetch(loteReceptionEndpoint(this.env, input.ambiente), {
      method: "POST",
      headers: this.jsonHeaders(token),
      body: JSON.stringify({
        ambiente: input.ambiente,
        idEnvio: input.idEnvio,
        version: 2,
        nitEmisor: input.nitEmisor,
        documentos: input.documentos
      })
    });
    return parseLoteSubmitResponse(response);
  }

  async consultarLote(input: { ambiente: Ambiente; codigoLote: string }): Promise<MhLoteConsultaResponse> {
    if (isMockMode(this.env)) {
      return {
        estado: "PROCESADO",
        procesados: [],
        rechazados: [],
        observaciones: [],
        raw: { mock: true }
      };
    }
    const token = await this.getToken(input.ambiente);
    const response = await fetch(loteConsultaEndpoint(this.env, input.ambiente, input.codigoLote), {
      method: "GET",
      headers: this.jsonHeaders(token)
    });
    return parseLoteConsultaResponse(response);
  }

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
      const centralAuthUrl = mhEndpoint(this.env, "auth", "01");
      if (centralAuthUrl !== primaryAuthUrl) {
        data = await this.authenticate(centralAuthUrl, credentials);
        token = data.body?.token;
      }
    }

    if (!token) {
      const code = data.body?.codigoMsg ? ` ${data.body.codigoMsg}` : "";
      const message = data.body?.descripcionMsg ? `: ${data.body.descripcionMsg}` : "";
      throw new Error(`La autenticación con el Ministerio de Hacienda no devolvió body.token${code}${message}`);
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

  private async authenticate(url: string, credentials: { user: string; password: string }): Promise<MhAuthResponse> {
    const form = new URLSearchParams();
    form.set("user", credentials.user);
    form.set("pwd", credentials.password);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.env.MH_USER_AGENT ?? "DiezmosSV/1.0"
      },
      body: form
    });
    if (!response.ok) {
      throw new Error(`Falló la autenticación con el Ministerio de Hacienda: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as MhAuthResponse;
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
        user: this.env.MH_USER_PROD ?? requireSecret(this.env, "MH_USER"),
        password: this.env.MH_PASSWORD_PROD ?? requireSecret(this.env, "MH_PASSWORD")
      };
    }
    return {
      user: this.env.MH_USER_TEST ?? requireSecret(this.env, "MH_USER"),
      password: this.env.MH_PASSWORD_TEST ?? requireSecret(this.env, "MH_PASSWORD")
    };
  }
}

function loteReceptionEndpoint(env: Env, ambiente: Ambiente): string {
  return mhEndpoint(env, "recepcion", ambiente).replace(/\/recepciondte\/?$/, "/recepcionlote");
}

function loteConsultaEndpoint(env: Env, ambiente: Ambiente, codigoLote: string): string {
  return mhEndpoint(env, "recepcion", ambiente).replace(/\/recepciondte\/?$/, `/recepcion/consultadtelote/${codigoLote}`);
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

async function parseMhResponse(response: Response): Promise<MhResponse> {
  const raw = await safeJson(response);
  if (!response.ok) {
    if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
      throw new MhUnavailableError(`Ministerio de Hacienda no disponible: ${response.status}`);
    }
    return {
      accepted: false,
      estado: `HTTP_${response.status}`,
      selloRecibido: null,
      observaciones: [JSON.stringify(raw)],
      raw
    };
  }
  const body = raw as Record<string, unknown>;
  const estado = String(body.estado ?? body.status ?? "RECIBIDO");
  const selloRecibido = typeof body.selloRecibido === "string" ? body.selloRecibido : null;
  const observaciones = Array.isArray(body.observaciones) ? body.observaciones.map(String) : [];
  return {
    accepted: estado.toUpperCase().includes("PROCESADO") || estado.toUpperCase().includes("ACEPTADO") || Boolean(selloRecibido),
    estado,
    selloRecibido,
    observaciones,
    raw
  };
}

async function parseLoteSubmitResponse(response: Response): Promise<MhLoteSubmitResponse> {
  const raw = await safeJson(response);
  if (!response.ok) {
    if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
      throw new MhUnavailableError(`Ministerio de Hacienda no disponible: ${response.status}`);
    }
    return {
      accepted: false,
      estado: `HTTP_${response.status}`,
      codigoLote: null,
      observaciones: [JSON.stringify(raw)],
      raw
    };
  }
  const body = raw as Record<string, unknown>;
  const estado = String(body.estado ?? body.status ?? "RECIBIDO");
  const codigoLote = typeof body.codigoLote === "string" ? body.codigoLote : null;
  const observaciones = Array.isArray(body.observaciones) ? body.observaciones.map(String) : [];
  return {
    accepted: Boolean(codigoLote) && !estado.toUpperCase().includes("RECHAZ"),
    estado,
    codigoLote,
    observaciones,
    raw
  };
}

async function parseLoteConsultaResponse(response: Response): Promise<MhLoteConsultaResponse> {
  const raw = await safeJson(response);
  if (!response.ok) {
    if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
      throw new MhUnavailableError(`Ministerio de Hacienda no disponible: ${response.status}`);
    }
    return {
      estado: `HTTP_${response.status}`,
      procesados: [],
      rechazados: [],
      observaciones: [JSON.stringify(raw)],
      raw
    };
  }
  const body = raw as Record<string, unknown>;
  return {
    estado: String(body.estado ?? body.status ?? "PROCESADO"),
    procesados: Array.isArray(body.procesados) ? body.procesados.filter(isRecord) : [],
    rechazados: Array.isArray(body.rechazados) ? body.rechazados.filter(isRecord) : [],
    observaciones: Array.isArray(body.observaciones) ? body.observaciones.map(String) : [],
    raw
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
