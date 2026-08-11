import {
  isCat008DistrictCode,
  isCat012DepartmentCode,
  isCat013MunicipalityCode,
  isCat020CountryCode,
  normalizeCat020CountryCode
} from "../../shared/catalogs";
import { formatDui, isValidDui } from "../../shared/dui";
import { formatNit, isValidNitFormat } from "../../shared/nit";
import type { DonationGiftType, DonationIntentDocumentType, DonationIntentRecord, Env } from "../types";
import { addHours, nowIso } from "../utils/dates";
import { base64UrlFromBytes, sha256Hex, utf8Bytes } from "../utils/encoding";
import { newId } from "../utils/ids";
import { Repository } from "../storage/repository";
import { WompiApiError, WompiApiService } from "./wompiApi";

// Public donor-checkout limits. Amounts arrive as dollars (string or number) and
// are stored as integer cents; the DTE side already rounds the same way.
const MIN_AMOUNT_CENTS = 100; // $1.00
const MAX_AMOUNT_CENTS = 500_000; // $5,000.00
const MAX_FREE_DOCUMENT = 20;
const MIN_IDENTITY_DOCUMENT = 5; // pasaporte (03) / carnet de residente (02)
const MAX_IDENTITY_DOCUMENT = 20;
const MIN_PHONE = 8;
const MAX_PHONE = 30;
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

// The donor's fiscal data: identity + address, the razón social for NIT (36) donors,
// and the CAT-020 país on the foreign path. Name and email are collected on Wompi's
// hosted sheet (which requires and now asks only for those two), so they are not here.
// This is the payload the /datos completion endpoint accepts and the full create embeds.
export interface ValidatedDonorData {
  donorDocumentType: DonationIntentDocumentType;
  donorDocument: string;
  donorName: string | null;
  donorPhone: string | null;
  direccionDepartamento: string;
  direccionMunicipio: string;
  direccionDistrito: string;
  direccionComplemento: string | null;
  donorPais: string | null;
}

// The full donor-checkout body: amount + gift type + the donor's fiscal data.
export interface ValidatedIntentInput extends ValidatedDonorData {
  amountCents: number;
  // Diezmo vs Ofrenda. The /donar SV form client-validates this as required and
  // always sends it; the server ACCEPTS absent (null) so legacy callers and the US
  // (Stripe) path — which never sends it — keeps working. Present-but-invalid is
  // rejected (invalid_gift_type).
  giftType: DonationGiftType | null;
}

// A draft intent carries only the amount and (optionally) the gift type — the values
// known when the SV donor ENTERS Paso 2, so the Wompi link can be minted in the
// background before the fiscal data exists. The donor data is attached later via the
// /datos completion endpoint.
export interface ValidatedDraftIntentInput {
  amountCents: number;
  giftType: DonationGiftType | null;
}

// Parses dollars (string like "25.50" or a number) into integer cents inside the
// donor-checkout range. Sub-cent precision is rounded to the nearest cent
// (Math.round) rather than rejected — friendlier for donor input. Throws
// IntentValidationError("invalid_amount", …) on any non-finite, non-positive, or
// out-of-range value.
function parseAmountCents(value: unknown): number {
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

// Diezmo/Ofrenda: absent (null/undefined/"") is allowed and stays null — legacy and
// US paths never send it. Present-but-invalid is rejected so a malformed client cannot
// slip an arbitrary tipo into the payment sheet or the CDE apéndice.
function parseGiftType(value: unknown): DonationGiftType | null {
  if (value == null || value === "") {
    return null;
  }
  if (!isGiftType(value)) {
    throw new IntentValidationError("invalid_gift_type", "Seleccione el tipo de aportación: diezmo u ofrenda.");
  }
  return value;
}

// A draft body (background link mint on Paso 1→2): only amount + optional gift type.
// The donor data is attached later by /datos, so it is neither present nor validated
// here. Amount validation and the gift-type rule are IDENTICAL to the full create.
export function validateDraftIntentInput(body: Record<string, unknown>): ValidatedDraftIntentInput {
  return {
    amountCents: parseAmountCents(body.amount),
    giftType: parseGiftType(body.giftType)
  };
}

// Validates just the donor's fiscal data (identity + address + optional razón
// social / país). Shared verbatim by the full create and the /datos completion, so
// both raise the same codes and messages. Name and email are neither accepted nor
// validated (the donor enters them on Wompi's sheet) — except the razón social,
// required for NIT (36) donors so the comprobante can name the empresa.
export function validateDonorData(body: Record<string, unknown>): ValidatedDonorData {
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
      throw new IntentValidationError("invalid_identity_document", "Ingrese su documento (entre 5 y 20 caracteres).");
    }
    donorDocument = rawDocument.toUpperCase(); // stored uppercase
  } else {
    if (!rawDocument || rawDocument.length > MAX_FREE_DOCUMENT) {
      throw new IntentValidationError("invalid_document", "Ingrese el documento del donante (máximo 20 caracteres).");
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
  if (donorPhone && (donorPhone.length < MIN_PHONE || donorPhone.length > MAX_PHONE)) {
    throw new IntentValidationError("invalid_phone", "Ingrese un teléfono de 8 a 30 caracteres.");
  }

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

  // Optional: Wompi's hosted sheet forces the donor's address, so /donar stopped asking
  // and a domestic intent normally arrives without one — the CDE resolves it from the
  // payment webhook instead. Still capped when present, because an oversize value would
  // pass here, take the donor's payment, and only then fail fe-cd-v2 at CDE build time.
  const direccionComplemento = requireString(body.complemento) || null;
  if (direccionComplemento && direccionComplemento.length > MAX_COMPLEMENTO) {
    throw new IntentValidationError("invalid_complemento", "La dirección no debe exceder 200 caracteres.");
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
    donorDocumentType,
    donorDocument,
    donorName,
    donorPhone,
    direccionDepartamento,
    direccionMunicipio,
    direccionDistrito,
    direccionComplemento,
    donorPais
  };
}

// Full server-side validation of a donor-checkout body: amount + gift type + the
// donor's fiscal data. Every branch throws an IntentValidationError with its own
// code so the route can map it to a 400.
export function validateIntentInput(body: Record<string, unknown>): ValidatedIntentInput {
  return {
    amountCents: parseAmountCents(body.amount),
    giftType: parseGiftType(body.giftType),
    ...validateDonorData(body)
  };
}

// The /datos completion runs the exact same donor-data validation as the full create;
// this alias names it at the route without duplicating the rules.
export const validateDatosInput = validateDonorData;

// The donor-data field names a create body carries. A body with NONE of them (only
// amount + optional gift type) is a DRAFT create (background link mint on Paso 1→2);
// a body with ANY of them is a full create. Absence — not emptiness — is the signal, so
// a client that (wrongly) sends an empty donorDocument still takes the full-create path
// and gets the proper validation error rather than a silent draft.
const DONOR_DATA_KEYS = [
  "donorDocumentType",
  "donorDocument",
  "donorName",
  "donorPhone",
  "departamento",
  "municipio",
  "distrito",
  "complemento",
  "pais"
] as const;

export function isDraftIntentBody(body: Record<string, unknown>): boolean {
  return DONOR_DATA_KEYS.every((key) => body[key] === undefined);
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

export interface CreatedDraftIntent {
  intentId: string;
  datosToken: string;
}

// Signals that the Wompi API rejected link creation; the route maps this to a 502
// and leaves the intent PENDING (it expires harmlessly on the cron sweep).
export class IntentLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntentLinkError";
  }
}

// The default document type for a DRAFT intent. donor_document_type stays NOT NULL
// (its CHECK cannot be widened without another table rebuild), so a draft — which has
// no document type yet — stores a placeholder that the /datos completion overwrites
// with the donor's real type. It is never surfaced while donor_document is NULL: the
// correlation guard skips such rows, and the admin panel shows document data from the
// completed CDE, not the draft.
const DRAFT_DOCUMENT_TYPE: DonationIntentDocumentType = "13";

// Mints the single-use Wompi link for a freshly persisted PENDING intent, attaches it
// (→ LINK_CREATED), and audits — recording amount + document TYPE only, never the
// document number. Throws IntentLinkError if Wompi fails, after the PENDING row is
// already persisted so it can expire on the cron sweep. Shared by the full create and
// the background draft create so both mint links identically.
async function mintLinkForIntent(env: Env, repo: Repository, intent: DonationIntentRecord): Promise<CreatedIntent> {
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
    summary: `Intención de donación por ${(intent.amount_cents / 100).toFixed(2)} USD`,
    metadata: { amountCents: intent.amount_cents, donorDocumentType: intent.donor_document_type }
  });

  return {
    intentId: intent.id,
    urlEnlace: link.urlEnlace,
    urlEnlaceLargo: link.urlEnlaceLargo
  };
}

// Orchestrates one full intent: persist PENDING with the donor's fiscal data, mint the
// link, and return the three link fields (response shape unchanged). This is the
// fallback path for a client without a usable premint draft.
export async function createDonationIntent(
  env: Env,
  repo: Repository,
  input: ValidatedIntentInput,
  clientIp: string,
  rateLimitClaimId: string
): Promise<CreatedIntent> {
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
    expiresAt: addHours(start, INTENT_VALIDITY_HOURS),
    datosTokenHash: null,
    rateLimitClaimId
  });

  return mintLinkForIntent(env, repo, intent);
}

// Orchestrates a DRAFT intent: persist PENDING with amount + gift type only (donor
// document + address NULL), then mint the link exactly as the full create does
// (identificadorEnlaceComercio = intent id). The donor's fiscal data is attached later
// via applyIntentDatos with a fast D1-only call, keeping the ~6 s Wompi mint off the
// donor's Paso 2 submit.
export async function createDraftDonationIntent(
  env: Env,
  repo: Repository,
  input: ValidatedDraftIntentInput,
  clientIp: string,
  rateLimitClaimId: string
): Promise<CreatedDraftIntent> {
  const start = nowIso();
  const datosToken = base64UrlFromBytes(crypto.getRandomValues(new Uint8Array(32)));
  const datosTokenHash = await sha256Hex(utf8Bytes(datosToken));
  const intent = await repo.createDonationIntent({
    id: newId("di"),
    amountCents: input.amountCents,
    donorName: null,
    // Placeholder type (see DRAFT_DOCUMENT_TYPE): never surfaced while the document is NULL.
    donorDocumentType: DRAFT_DOCUMENT_TYPE,
    donorDocument: null,
    donorEmail: null,
    donorPhone: null,
    direccionDepartamento: null,
    direccionMunicipio: null,
    direccionDistrito: null,
    direccionComplemento: null,
    donorPais: null,
    giftType: input.giftType,
    clientIp,
    expiresAt: addHours(start, INTENT_VALIDITY_HOURS),
    datosTokenHash,
    rateLimitClaimId
  });

  const created = await mintLinkForIntent(env, repo, intent);
  return { intentId: created.intentId, datosToken };
}

// Signals that /datos either targets an unknown id (404) or failed the generic
// capability/state CAS (409). The generic result avoids distinguishing wrong,
// consumed, paid, expired, completed, and already-populated intents.
export class IntentDatosError extends Error {
  constructor(
    readonly code: "intent_not_found" | "intent_datos_unavailable",
    readonly httpStatus: 404 | 409,
    message: string
  ) {
    super(message);
    this.name = "IntentDatosError";
  }
}

// Attaches the donor's fiscal data to a minted draft (fast D1-only, no Wompi call). It
// NEVER changes amount or gift type — those were locked when the link was minted.
// Only an unpaid, unpopulated LINK_CREATED row with the one-time capability can change.
export async function applyIntentDatos(
  repo: Repository,
  intentId: string,
  datosToken: string,
  data: ValidatedDonorData
): Promise<CreatedIntent> {
  const datosTokenHash = await sha256Hex(utf8Bytes(datosToken.trim()));
  const completed = await repo.applyIntentDatosWithCapability(intentId, datosTokenHash, data);
  if (!completed) {
    const intent = await repo.getDonationIntent(intentId);
    if (!intent) {
      throw new IntentDatosError("intent_not_found", 404, "No se encontró la intención de donación.");
    }
    throw new IntentDatosError("intent_datos_unavailable", 409, "La intención ya no puede aceptar datos fiscales.");
  }
  await repo.createAudit({
    action: "DONATION_INTENT_DATOS_ATTACHED",
    entityType: "donation_intent",
    entityId: intentId,
    summary: `Datos fiscales adjuntados a la intención ${intentId}`,
    metadata: { donorDocumentType: data.donorDocumentType }
  });
  return {
    intentId: completed.id,
    urlEnlace: completed.urlEnlace,
    urlEnlaceLargo: completed.urlEnlaceLargo
  };
}
