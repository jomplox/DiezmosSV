import { CAT020_COUNTRIES } from "../../shared/catalogs";
import {
  validateFiscalReceptorCorrection,
  type FiscalReceptorCorrection
} from "../../shared/fiscalCorrection";
import {
  assertCdeIssuerMatchesConfig,
  buildCdeDocument,
  type IntentDonorOverride
} from "../domain/dteBuilder";
import { validateCde } from "../domain/schema";
import {
  decodeMhJwsPayload,
  parseMhCertificate,
  verifyMhJws
} from "../domain/signer";
import {
  donorName,
  normalizeWompiWebhook
} from "../domain/wompi";
import { resolveDonationIntentBinding } from "./donationIntentBinding";
import type { Repository } from "../storage/repository";
import type {
  Ambiente,
  DonationIntentRecord,
  DteDocumentRecord,
  EmisorConfig,
  FiscalCorrectionData,
  WompiWebhook
} from "../types";
import { generationCode, numeroControl } from "../utils/ids";

const CONFIGURATION_GUIDANCE =
  "Revise Configuración y la evidencia técnica antes de volver a intentar.";
const INTENT_BINDING_GUIDANCE =
  "La intención de donación no coincide con este evento Wompi. Revise el vínculo antes de reintentar.";
const LOCAL_RECEPTOR_FAILURE_CODE_PATTERN =
  /(?:^|_)(?:DONOR|RECEPTOR)(?:_|$)/;
const MH_RECEPTOR_FIELD_PATH_PATTERN =
  /(?:#\/receptor(?:\/|$)|\breceptor\.[A-Za-z])/i;

export async function effectiveWompiCorrectionData(
  repo: Repository,
  eventId: string
): Promise<FiscalCorrectionData | null> {
  const event = await repo.getWompiEventById(eventId);
  if (!event) return null;

  const payload = normalizeWompiWebhook(JSON.parse(event.raw_body));
  const binding = await resolveDonationIntentBinding(repo, payload);
  const intent = binding.kind === "bound" ? binding.intent : null;
  const failureReason = safeFailureReason(
    event.issuance_error_message,
    event.issuance_error_code,
    "La emisión no pudo crear el CDE."
  );
  const correctable = binding.kind !== "unbound" && requiresFiscalReceptorCorrection(
    event.issuance_error_code,
    failureReason
  );
  return {
    receptor: effectiveWompiReceptor(payload, intent),
    targetStatus: event.issuance_status ?? "FAILED",
    failureReason,
    correctable,
    guidance: binding.kind === "unbound"
      ? INTENT_BINDING_GUIDANCE
      : correctable
        ? null
        : CONFIGURATION_GUIDANCE,
    activeCorrection: null
  };
}

export function effectiveDocumentCorrectionData(
  document: DteDocumentRecord
): FiscalCorrectionData {
  const source = parseDocument(document.plain_json);
  const failureReason = documentFailureReason(document);
  const correctable = requiresFiscalReceptorCorrection(
    document.mh_estado,
    failureReason
  );
  return {
    receptor: receptorFromDocument(source),
    targetStatus: document.status,
    failureReason,
    correctable,
    guidance: correctable ? null : CONFIGURATION_GUIDANCE,
    activeCorrection: null
  };
}

export function buildCorrectedWompiCandidate(input: {
  payload: WompiWebhook;
  intent: DonationIntentRecord | null;
  correction: FiscalReceptorCorrection;
  config: EmisorConfig;
  environment: Ambiente;
  sequence: number;
  codigoGeneracion?: string;
}): Record<string, unknown> {
  const correction = normalizeCorrection(input.correction);
  const candidate = buildCdeDocument(input.payload, input.config, {
    sequence: input.sequence,
    codigoGeneracion: input.codigoGeneracion,
    environment: input.environment,
    issuedAt: new Date(input.payload.FechaTransaccion),
    donorOverride: correctionOverride(correction, input.intent)
  });
  applyCorrectedReceptor(candidate, correction);
  assertCdeIssuerMatchesConfig(candidate, input.config);
  validateCde(candidate);
  return candidate;
}

export function buildCorrectedDirectCandidate(input: {
  sourceDocument: DteDocumentRecord;
  correction: FiscalReceptorCorrection;
  config: EmisorConfig;
  sequence: number;
}): Record<string, unknown> {
  const source = parseDocument(input.sourceDocument.plain_json);
  applyCorrectedReceptor(source, normalizeCorrection(input.correction));
  source.identificacion = {
    ...record(source.identificacion),
    ambiente: input.sourceDocument.environment,
    tipoDte: "15",
    numeroControl: numeroControl(input.config.controlPrefix, input.sequence),
    codigoGeneracion: generationCode()
  };
  validateCde(source);
  return source;
}

export async function assertDirectCorrectionSourceTrusted(input: {
  sourceDocument: DteDocumentRecord;
  config: EmisorConfig;
  certificateXml: () => string;
}): Promise<void> {
  const source = parseDocument(input.sourceDocument.plain_json);
  if (input.sourceDocument.signed_jws) {
    try {
      const certXml = input.certificateXml();
      const certificate = await parseMhCertificate(certXml);
      if (
        await verifyMhJws(input.sourceDocument.signed_jws, certXml)
        && sameFiscalContent(
          decodeMhJwsPayload(input.sourceDocument.signed_jws),
          source
        )
        && sameNit(record(source.emisor).numDocumento, certificate.nit)
      ) {
        return;
      }
    } catch {
      // Missing or invalid historical proof falls back to the current issuer.
    }
  }
  assertCdeIssuerMatchesConfig(source, input.config);
}

function sameNit(left: unknown, right: unknown): boolean {
  const leftDigits = typeof left === "string" ? left.replace(/\D/g, "") : "";
  const rightDigits = typeof right === "string" ? right.replace(/\D/g, "") : "";
  return leftDigits.length > 0 && leftDigits === rightDigits;
}

export function sameFiscalContent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => sameFiscalContent(value, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key, index) => key === rightKeys[index]
        && sameFiscalContent(leftRecord[key], rightRecord[key])
    );
}

function normalizeCorrection(
  correction: FiscalReceptorCorrection
): FiscalReceptorCorrection {
  return validateFiscalReceptorCorrection(
    correction as unknown as Record<string, unknown>
  );
}

function correctionOverride(
  correction: FiscalReceptorCorrection,
  intent: DonationIntentRecord | null
): IntentDonorOverride {
  return {
    tipoDocumento: correction.tipoDocumento,
    numDocumento: correction.numDocumento,
    nombre: correction.nombre,
    correo: correction.correo,
    telefono: correction.telefono,
    direccion: {
      departamento: correction.departamento,
      municipio: correction.municipio,
      distrito: correction.distrito,
      complemento: correction.complemento
    },
    codPais: correction.codPais,
    codDomiciliado: correction.codDomiciliado,
    ...(intent?.gift_type ? { giftType: intent.gift_type } : {})
  };
}

function applyCorrectedReceptor(
  document: Record<string, unknown>,
  correction: FiscalReceptorCorrection
): void {
  document.receptor = {
    tipoDocumento: correction.tipoDocumento,
    numDocumento: correction.numDocumento,
    nrc: correction.nrc,
    nombre: correction.nombre,
    codActividad: correction.codActividad,
    descActividad: correction.descActividad,
    direccion: correction.codDomiciliado === 2
      ? null
      : {
          departamento: correction.departamento,
          municipio: correction.municipio,
          distrito: correction.distrito,
          complemento: correction.complemento
        },
    telefono: correction.telefono,
    correo: correction.correo,
    codDomiciliado: correction.codDomiciliado,
    codPais: correction.codPais
  };

  const appendix = Array.isArray(document.apendice)
    ? document.apendice.filter((entry) => !isForeignAddressEntry(entry))
    : [];
  if (correction.codDomiciliado === 2) {
    appendix.push({
      campo: "DireccionExtranjera",
      etiqueta: "Dirección en el extranjero",
      valor: `${countryLabel(correction.codPais)}: ${correction.complemento}`.slice(0, 150)
    });
  }
  document.apendice = appendix;
}

function effectiveWompiReceptor(
  payload: WompiWebhook,
  intent: DonationIntentRecord | null
): FiscalReceptorCorrection {
  const rawDocument = clean(payload.Cliente?.DocumentoIdentidad) ?? "SIN-DOCUMENTO";
  const rawCountry = clean(payload.Cliente?.CodigoPais)?.toUpperCase() ?? "SV";
  const foreign = intent?.donor_pais != null || rawCountry !== "SV";
  const departamento = intent?.direccion_departamento
    ?? clean(payload.Cliente?.CodigoRegion)?.toUpperCase()
    ?? (foreign ? "00" : "00");
  return {
    tipoDocumento: intent?.donor_document_type
      ?? (/^\d{8}-?\d$/.test(rawDocument) ? "13" : "37"),
    numDocumento: intent?.donor_document ?? rawDocument,
    nrc: null,
    nombre: intent?.donor_name ?? donorName(payload),
    codActividad: null,
    descActividad: null,
    correo: clean(payload.Cliente?.EMail)?.toLowerCase() ?? null,
    telefono: intent?.donor_phone ?? clean(payload.Cliente?.Celular),
    codDomiciliado: foreign ? 2 : 1,
    codPais: intent?.donor_pais ?? rawCountry,
    departamento: foreign ? "00" : departamento,
    municipio: foreign ? "00" : intent?.direccion_municipio ?? "00",
    distrito: foreign ? "00" : intent?.direccion_distrito ?? "00",
    complemento: intent?.direccion_complemento
      ?? clean(payload.Cliente?.Direccion)
      ?? "No proporcionada por el donante"
  };
}

function receptorFromDocument(
  document: Record<string, unknown>
): FiscalReceptorCorrection {
  const receptor = record(document.receptor);
  const direccion = record(receptor.direccion);
  const codDomiciliado = receptor.codDomiciliado === 2 ? 2 : 1;
  return {
    tipoDocumento: stringValue(receptor.tipoDocumento),
    numDocumento: stringValue(receptor.numDocumento),
    nrc: nullableString(receptor.nrc),
    nombre: stringValue(receptor.nombre),
    codActividad: nullableString(receptor.codActividad),
    descActividad: nullableString(receptor.descActividad),
    correo: nullableString(receptor.correo),
    telefono: nullableString(receptor.telefono),
    codDomiciliado,
    codPais: stringValue(receptor.codPais),
    departamento: codDomiciliado === 2 ? "00" : stringValue(direccion.departamento),
    municipio: codDomiciliado === 2 ? "00" : stringValue(direccion.municipio),
    distrito: codDomiciliado === 2 ? "00" : stringValue(direccion.distrito),
    complemento: codDomiciliado === 2
      ? foreignAddressFromAppendix(document)
      : stringValue(direccion.complemento)
  };
}

function documentFailureReason(document: DteDocumentRecord): string {
  try {
    const observations = JSON.parse(document.mh_observaciones_json);
    if (Array.isArray(observations)) {
      const joined = observations
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 4)
        .join("; ");
      if (joined) return joined.slice(0, 500);
    }
  } catch {
    // Fall through to the bounded MH state below.
  }
  return safeFailureReason(document.mh_estado, null, "MH rechazó el CDE.");
}

function safeFailureReason(
  message: string | null | undefined,
  code: string | null | undefined,
  fallback: string
): string {
  return (clean(message) ?? clean(code) ?? fallback).slice(0, 500);
}

export function requiresFiscalReceptorCorrection(
  code: string | null | undefined,
  reason: string
): boolean {
  return LOCAL_RECEPTOR_FAILURE_CODE_PATTERN.test(code ?? "")
    || MH_RECEPTOR_FIELD_PATH_PATTERN.test(reason);
}

function foreignAddressFromAppendix(document: Record<string, unknown>): string {
  const appendix = Array.isArray(document.apendice) ? document.apendice : [];
  const entry = appendix.find(isForeignAddressEntry);
  const value = nullableString(record(entry).valor) ?? "Dirección extranjera no disponible";
  const separator = value.indexOf(":");
  return separator >= 0 ? value.slice(separator + 1).trim() : value;
}

function isForeignAddressEntry(value: unknown): boolean {
  return record(value).campo === "DireccionExtranjera";
}

function countryLabel(code: string): string {
  return CAT020_COUNTRIES.find((country) => country.code === code)?.label ?? code;
}

function parseDocument(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("El JSON original del CDE no es un objeto.");
  }
  return structuredClone(parsed) as Record<string, unknown>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function clean(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
