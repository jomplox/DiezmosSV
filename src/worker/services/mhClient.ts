import { isMockMode, mhEndpoint, requireSecret } from "../config";
import type { Ambiente, Env, MhResponse } from "../types";
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

  private async getToken(ambiente: Ambiente): Promise<string> {
    const cached = await this.env.DB.prepare("SELECT token, token_type, expires_at FROM mh_tokens WHERE environment = ?")
      .bind(ambiente)
      .first<{ token: string; token_type: string; expires_at: string }>();
    if (cached && new Date(cached.expires_at).getTime() > Date.now() + 5 * 60 * 1000) {
      return cached.token;
    }

    const form = new URLSearchParams();
    const credentials = this.credentials(ambiente);
    form.set("user", credentials.user);
    form.set("pwd", credentials.password);
    const response = await fetch(mhEndpoint(this.env, "auth", ambiente), {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": this.env.MH_USER_AGENT ?? "DiezmosSV/1.0"
      },
      body: form
    });
    if (!response.ok) {
      throw new Error(`MH auth failed: ${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as { body?: { token?: string }; tokenType?: string };
    const token = data.body?.token;
    if (!token) {
      throw new Error("MH auth response did not include body.token");
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

async function parseMhResponse(response: Response): Promise<MhResponse> {
  const raw = await safeJson(response);
  if (!response.ok) {
    if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
      throw new MhUnavailableError(`MH unavailable: ${response.status}`);
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
