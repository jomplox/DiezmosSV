import {
  isCat008DistrictCode,
  isCat012DepartmentCode,
  isCat013MunicipalityCode,
  isCat020CountryCode,
  normalizeCat020CountryCode
} from "../../shared/catalogs";
import { formatDui, isValidDui } from "../../shared/dui";
import { formatNit, isValidNitFormat } from "../../shared/nit";
import type { DonationGiftType, DonationIntentDocumentType, Env } from "../types";
import { addHours, nowIso } from "../utils/dates";
import { newId } from "../utils/ids";
import { Repository } from "../storage/repository";
import { WompiApiError, WompiApiService } from "./wompiApi";

// Public donor-checkout limits. Amounts arrive as dollars (string or number) and
// are stored as integer cents; the DTE side already rounds the same way.
const MIN_AMOUNT_CENTS = 100; // $1.00
const MAX_AMOUNT_CENTS = 500_000; // $5,000.00
const MAX_FREE_DOCUMENT = 50;
const MIN_IDENTITY_DOCUMENT = 5; // pasaporte (03) / carnet de residente (02)
const MAX_IDENTITY_DOCUMENT = 30;
const MAX_RAZON_SOCIAL = 200;
// MH's fe-cd-v2 schema caps direccion.complemento at 200 characters. The intent
// limit must never exceed it: a longer complemento would pass here, take the
// donor's payment, and then fail schema validation at CDE build time.
const MAX_COMPLEMENTO = 200;
const INTENT_VALIDITY_HOURS = 1; // matches the Wompi link vigencia (Task 1).

// The 00 codes across CAT-008/012/013 are "Otro (Para extranjeros)": the marker
// for the foreign-donor path, which additionally requires a CAT-020 país.
const FOREIGN_GEOGRAPHY_CODE = "00";

const INTENT_DOCUMENT_TYPES: readonly DonationIntentDocumentType[] = ["36", "13", "37", "03", "02"];

function isIntentDocumentType(value: unknown): value is DonationIntentDocumentType {
  return typeof value === "string" && (INTENT_DOCUMENT_TYPES as readonly string[]).includes(value);
}

const GIFT_TYPES: readonly DonationGiftType[] = ["DIEZMO", "OFRENDA"];

function isGiftType(value: unknown): value is DonationGiftType {
  return typeof value === "string" && (GIFT_TYPES as readonly string[]).includes(value);
}

// Per-IP throttle: at most 5 intent creations per rolling 15 minutes.
export const INTENT_THROTTLE_WINDOW_MINUTES = 15;
export const INTENT_THROTTLE_LIMIT = 5;

// A validation failure carries a distinct machine code plus a Spanish usted-form
// message; the route serializes it to a 400 body.
export class IntentValidationError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "IntentValidationError";
  }
}

// Name and email are collected on Wompi's hosted sheet (which requires and now asks
// only for those two), so the intent carries identity + address only — plus the
// razón social for NIT (36) donors and the CAT-020 país on the foreign path.
export interface ValidatedIntentInput {
  amountCents: number;
  donorDocumentType: DonationIntentDocumentType;
  donorDocument: string;
  donorName: string | null;
  donorPhone: string | null;
  direccionDepartamento: string;
  direccionMunicipio: string;
  direccionDistrito: string;
  direccionComplemento: string;
  donorPais: string | null;
  // Diezmo vs Ofrenda. The /donar SV form client-validates this as required and
  // always sends it; the server ACCEPTS absent (null) so legacy callers and the US
  // (Givebutter) path — which never send it — keep working. Present-but-invalid is
  // rejected (invalid_gift_type).
  giftType: DonationGiftType | null;
}

// Parses dollars (string like "25.50" or a number) into integer cents inside the
// donor-checkout range. Sub-cent precision is rounded to the nearest cent
// (Math.round) rather than rejected — friendlier for donor input. Throws
// IntentValidationError("invalid_amount", …) on any non-finite, non-positive, or
// out-of-range value.
export function parseAmountCents(value: unknown): number {
  const amount = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value.trim()) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new IntentValidationError("invalid_amount", "Ingrese un monto válido en dólares.");
  }
  const cents = Math.round(amount * 100);
  if (cents < MIN_AMOUNT_CENTS || cents > MAX_AMOUNT_CENTS) {
    throw new IntentValidationError("invalid_amount", "El monto debe estar entre $1.00 y $5,000.00.");
  }
  return cents;
}

function requireString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

// Full server-side validation of a donor-checkout body. Every branch throws an
// IntentValidationError with its own code so the route can map it to a 400. Name and
// email are neither accepted nor validated (the donor enters them on Wompi's sheet)
// — except the razón social, required for NIT (36) donors so the comprobante can
// name the empresa instead of the cardholder.
export function validateIntentInput(body: Record<string, unknown>): ValidatedIntentInput {
  const amountCents = parseAmountCents(body.amount);

  // Diezmo/Ofrenda: absent (null/undefined/"") is allowed and stays null — legacy and
  // US paths never send it. Present-but-invalid is rejected so a malformed client
  // cannot slip an arbitrary tipo into the payment sheet or the CDE apéndice.
  let giftType: DonationGiftType | null = null;
  if (body.giftType != null && body.giftType !== "") {
    if (!isGiftType(body.giftType)) {
      throw new IntentValidationError("invalid_gift_type", "Seleccione el tipo de aportación: diezmo u ofrenda.");
    }
    giftType = body.giftType;
  }

  const donorDocumentType = body.donorDocumentType;
  if (!isIntentDocumentType(donorDocumentType)) {
    throw new IntentValidationError(
      "invalid_document_type",
      "Seleccione un tipo de documento válido: DUI, Empresa, Otro, Pasaporte o Carnet de Residente."
    );
  }

  const rawDocument = requireString(body.donorDocument);
  let donorDocument: string;
  if (donorDocumentType === "13") {
    if (!isValidDui(rawDocument)) {
      throw new IntentValidationError("invalid_dui", "DUI inválido: revise el número y el dígito verificador.");
    }
    donorDocument = formatDui(rawDocument); // stored canonically as XXXXXXXX-X
  } else if (donorDocumentType === "36") {
    // Format-only (14 digits): MH validates the NIT server-side, and a homebrew
    // check digit would reject valid NITs (see src/shared/nit.ts). The message is
    // framed for empresas — the /donar select labels this type "Empresa".
    if (!isValidNitFormat(rawDocument)) {
      throw new IntentValidationError("invalid_nit", "Ingrese el NIT de la empresa (14 dígitos).");
    }
    donorDocument = formatNit(rawDocument); // stored canonically as XXXX-XXXXXX-XXX-X
  } else if (donorDocumentType === "03" || donorDocumentType === "02") {
    if (rawDocument.length < MIN_IDENTITY_DOCUMENT || rawDocument.length > MAX_IDENTITY_DOCUMENT) {
      throw new IntentValidationError("invalid_identity_document", "Ingrese su documento (entre 5 y 30 caracteres).");
    }
    donorDocument = rawDocument.toUpperCase(); // stored uppercase
  } else {
    if (!rawDocument || rawDocument.length > MAX_FREE_DOCUMENT) {
      throw new IntentValidationError("invalid_document", "Ingrese el documento del donante (máximo 50 caracteres).");
    }
    donorDocument = rawDocument;
  }

  // Razón social: required for NIT (36) intents only — the CDE receptor must carry
  // the empresa's legal name. For every other type it is bound null so the webhook
  // cardholder name still wins on the correlated CDE.
  let donorName: string | null = null;
  if (donorDocumentType === "36") {
    const razonSocial = requireString(body.donorName);
    if (!razonSocial || razonSocial.length > MAX_RAZON_SOCIAL) {
      throw new IntentValidationError("invalid_razon_social", "Ingrese la razón social (máximo 200 caracteres).");
    }
    donorName = razonSocial;
  }

  const donorPhone = requireString(body.donorPhone) || null;

  const direccionDepartamento = requireString(body.departamento);
  if (!isCat012DepartmentCode(direccionDepartamento)) {
    throw new IntentValidationError("invalid_departamento", "Seleccione un departamento válido.");
  }

  const direccionMunicipio = requireString(body.municipio);
  if (!isCat013MunicipalityCode(direccionMunicipio, direccionDepartamento)) {
    throw new IntentValidationError("invalid_municipio", "Seleccione un municipio válido para el departamento.");
  }

  const direccionDistrito = requireString(body.distrito);
  if (!isCat008DistrictCode(direccionDistrito, direccionDepartamento)) {
    throw new IntentValidationError("invalid_distrito", "Seleccione un distrito válido para el departamento.");
  }

  const direccionComplemento = requireString(body.complemento);
  if (!direccionComplemento || direccionComplemento.length > MAX_COMPLEMENTO) {
    throw new IntentValidationError("invalid_complemento", "Ingrese la dirección (máximo 200 caracteres).");
  }

  // Foreign path: the 00 departamento ("Otro (Para extranjeros)") requires a real
  // CAT-020 país that is NOT El Salvador — an SV resident must use their actual
  // departamento/municipio/distrito. Domestic intents carry no país.
  let donorPais: string | null = null;
  if (direccionDepartamento === FOREIGN_GEOGRAPHY_CODE) {
    const rawPais = requireString(body.pais);
    if (!rawPais || !isCat020CountryCode(rawPais)) {
      throw new IntentValidationError("invalid_pais", "Seleccione un país válido.");
    }
    const pais = normalizeCat020CountryCode(rawPais);
    if (pais === "SV") {
      throw new IntentValidationError("invalid_pais_sv", "Si reside en El Salvador, seleccione su departamento, municipio y distrito.");
    }
    donorPais = pais;
  }

  return {
    amountCents,
    donorDocumentType,
    donorDocument,
    donorName,
    donorPhone,
    direccionDepartamento,
    direccionMunicipio,
    direccionDistrito,
    direccionComplemento,
    donorPais,
    giftType
  };
}

export function intentThrottleSinceIso(): string {
  return new Date(Date.now() - INTENT_THROTTLE_WINDOW_MINUTES * 60_000).toISOString();
}

// Header may be absent behind some proxies / in direct tests; collapse that to a
// single shared "unknown" bucket rather than skipping the throttle, so an omitted
// header cannot be used to bypass the per-IP limit.
export function clientIpFrom(request: Request): string {
  return request.headers.get("cf-connecting-ip")?.trim() || "unknown";
}

export interface CreatedIntent {
  intentId: string;
  urlEnlace: string;
  urlEnlaceLargo: string;
}

// Signals that the Wompi API rejected link creation; the route maps this to a 502
// and leaves the intent PENDING (it expires harmlessly on the cron sweep).
export class IntentLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntentLinkError";
  }
}

// Orchestrates one intent: persist PENDING, mint the single-use Wompi link, attach
// it (LINK_CREATED), and audit — recording amount + document TYPE only, never the
// document number. Throws IntentLinkError if Wompi fails, after the PENDING row is
// already persisted so it can expire.
export async function createDonationIntent(env: Env, repo: Repository, input: ValidatedIntentInput, clientIp: string): Promise<CreatedIntent> {
  const start = nowIso();
  const intent = await repo.createDonationIntent({
    id: newId("di"),
    amountCents: input.amountCents,
    // Name and email are collected on Wompi's sheet, not the form — except the
    // razón social validated for NIT (36) intents, which rides in donor_name.
    donorName: input.donorName,
    donorDocumentType: input.donorDocumentType,
    donorDocument: input.donorDocument,
    donorEmail: null,
    donorPhone: input.donorPhone,
    direccionDepartamento: input.direccionDepartamento,
    direccionMunicipio: input.direccionMunicipio,
    direccionDistrito: input.direccionDistrito,
    direccionComplemento: input.direccionComplemento,
    donorPais: input.donorPais,
    giftType: input.giftType,
    clientIp,
    expiresAt: addHours(start, INTENT_VALIDITY_HOURS)
  });

  let link;
  try {
    link = await new WompiApiService(env).createPaymentLink(intent);
  } catch (error) {
    if (error instanceof WompiApiError) {
      throw new IntentLinkError(error.message);
    }
    throw error;
  }

  await repo.attachIntentLink(intent.id, link);
  await repo.createAudit({
    action: "DONATION_INTENT_CREATED",
    entityType: "donation_intent",
    entityId: intent.id,
    summary: `Intención de donación por ${(input.amountCents / 100).toFixed(2)} USD`,
    metadata: { amountCents: input.amountCents, donorDocumentType: input.donorDocumentType }
  });

  return { intentId: intent.id, urlEnlace: link.urlEnlace, urlEnlaceLargo: link.urlEnlaceLargo };
}
