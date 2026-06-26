import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildCdeDocument } from "../../src/worker/domain/dteBuilder";
import { signMhDocument } from "../../src/worker/domain/signer";
import { MhClient } from "../../src/worker/services/mhClient";
import type { EmisorConfig, Env, WompiWebhook } from "../../src/worker/types";

const runLive = process.env.RUN_MH_LIVE === "1" ? it : it.skip;

describe("MH live TEST integration", () => {
  runLive("signs and transmits a CDE to the TEST environment", async () => {
    const envVars = loadDevVars();
    const referencePath = process.env.MH_REFERENCE_DTE_JSON;
    if (!referencePath) {
      throw new Error("MH_REFERENCE_DTE_JSON is required for RUN_MH_LIVE=1");
    }

    const reference = JSON.parse(fs.readFileSync(referencePath, "utf8")) as ReferenceCde;
    const mode = process.env.MH_LIVE_DOCUMENT_MODE ?? "reference";
    const testDocument = mode === "builder" ? buildBuilderDocument(reference, envVars) : buildReferenceDocument(reference);
    const signedJws = await signMhDocument(testDocument, mhCertificateXml(envVars), required(envVars, "MH_CERT_PASSWORD"));
    const mh = new MhClient(testEnv(envVars));
    const result = await mh.transmitDte({
      ambiente: "00",
      version: identification(testDocument).version,
      tipoDte: "15",
      codigoGeneracion: identification(testDocument).codigoGeneracion,
      signedJws
    });

    console.log(
      JSON.stringify(
        {
          mode,
          accepted: result.accepted,
          estado: result.estado,
          selloPresent: Boolean(result.selloRecibido),
          codigoGeneracion: identification(testDocument).codigoGeneracion,
          numeroControl: identification(testDocument).numeroControl,
          observaciones: result.observaciones
        },
        null,
        2
      )
    );
    expect(result.accepted).toBe(true);
    expect(result.selloRecibido).toBeTruthy();
  });
});

function buildReferenceDocument(reference: ReferenceCde): ReferenceCde {
  const document = unsignedReference(reference);
  delete document.Firma;
  delete document.Sello;
  document.identificacion.ambiente = "00";
  document.identificacion.codigoGeneracion = randomUUID().toUpperCase();
  document.identificacion.numeroControl = `DTE-15-${controlPrefix(reference)}-${sequence()}`;
  const emitted = mhNow();
  document.identificacion.fecEmi = emitted.date;
  document.identificacion.horEmi = emitted.time;
  return document;
}

function buildBuilderDocument(reference: ReferenceCde, envVars: Record<string, string>): Record<string, unknown> {
  const config = JSON.parse(required(envVars, "EMISOR_CONFIG_JSON")) as EmisorConfig;
  const payload = wompiPayloadFromReference(unsignedReference(reference));
  return buildCdeDocument(payload, config, {
    sequence: Number(sequence()),
    issuedAt: new Date()
  });
}

function wompiPayloadFromReference(reference: ReferenceCde): WompiWebhook {
  const donor = asRecord(reference.donante);
  const body = asRecord(Array.isArray(reference.cuerpoDocumento) ? reference.cuerpoDocumento[0] : null);
  const resumen = asRecord(reference.resumen);
  const donorNameValue = stringValue(donor.nombre, "Donante");
  return {
    IdCuenta: "mh-live-test",
    FechaTransaccion: new Date().toISOString(),
    Monto: String(numberValue(resumen.valorTotal, numberValue(body.valor, 1))),
    IdTransaccion: `MH-LIVE-${Date.now()}`,
    ResultadoTransaccion: "ExitosaAprobada",
    CodigoAutorizacion: "MH-LIVE",
    Cantidad: numberValue(body.cantidad, 1),
    EsProductiva: false,
    Aplicativo: { Nombre: "MH live test" },
    EnlacePago: { NombreProducto: stringValue(body.descripcion, "Diezmos y ofrendas") },
    Cliente: {
      DocumentoIdentidad: stringValue(donor.numDocumento, "SIN-DOCUMENTO"),
      Nombre: donorNameValue,
      Apellidos: "",
      Direccion: stringValue(asRecord(donor.direccion).complemento, ""),
      EMail: stringValue(donor.correo, ""),
      Celular: stringValue(donor.telefono, ""),
      CodigoPais: stringValue(donor.codPais, "SV")
    },
    IdExterno: stringValue(body.codigo, "DONACION")
  };
}

function unsignedReference(reference: ReferenceCde): ReferenceCde {
  if (typeof reference.Firma !== "string") {
    return structuredClone(reference);
  }
  const [, payload] = reference.Firma.split(".");
  if (!payload) {
    return structuredClone(reference);
  }
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ReferenceCde;
}

function controlPrefix(reference: ReferenceCde): string {
  const parts = reference.identificacion.numeroControl.split("-");
  if (parts.length < 4) {
    throw new Error("Reference numeroControl does not include a control prefix");
  }
  return parts[2];
}

function sequence(): string {
  return String(Date.now()).padStart(15, "0").slice(-15);
}

function identification(document: Record<string, unknown>): ReferenceCde["identificacion"] {
  const value = document.identificacion;
  if (!value || typeof value !== "object") {
    throw new Error("Document is missing identificacion");
  }
  return value as ReferenceCde["identificacion"];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function mhNow(): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/El_Salvador",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  })
    .formatToParts(new Date())
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`
  };
}

function loadDevVars(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  if (!fs.existsSync(".dev.vars")) {
    return env;
  }
  const lines = fs.readFileSync(".dev.vars", "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line || line.trimStart().startsWith("#")) {
      continue;
    }
    const index = line.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = line.slice(0, index);
    const raw = line.slice(index + 1);
    env[key] = raw.startsWith('"') ? JSON.parse(raw) : raw;
  }
  return env;
}

function required(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (!value) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function mhCertificateXml(env: Record<string, string>): string {
  if (env.MH_CERT_XML) {
    return env.MH_CERT_XML;
  }
  if (env.MH_CERT_XML_PART_1 && env.MH_CERT_XML_PART_2) {
    return `${env.MH_CERT_XML_PART_1}${env.MH_CERT_XML_PART_2}`;
  }
  throw new Error("MH_CERT_XML is required");
}

function testEnv(envVars: Record<string, string>): Env {
  const statement = {
    bind: () => statement,
    first: async () => null,
    run: async () => ({})
  };
  return {
    DB: { prepare: () => statement } as unknown as D1Database,
    ISSUANCE_QUEUE: {} as Queue,
    ASSETS: {} as Fetcher,
    MOCK_EXTERNAL_SERVICES: "false",
    MH_USER_TEST: required(envVars, "MH_USER_TEST"),
    MH_PASSWORD_TEST: required(envVars, "MH_PASSWORD_TEST"),
    MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
    MH_AUTH_URL_PROD: "https://api.dtes.mh.gob.sv/seguridad/auth",
    MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte",
    MH_RECEPCION_URL_PROD: "https://api.dtes.mh.gob.sv/fesv/recepciondte"
  };
}

interface ReferenceCde {
  identificacion: {
    version: number;
    ambiente: "00" | "01";
    tipoDte: string;
    numeroControl: string;
    codigoGeneracion: string;
    fecEmi: string;
    horEmi: string;
  };
  Firma?: string;
  Sello?: string;
  donante?: unknown;
  cuerpoDocumento?: unknown;
  resumen?: unknown;
  [key: string]: unknown;
}
