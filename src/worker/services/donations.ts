import { isCat008DistrictCode, isCat012DepartmentCode, isCat013MunicipalityCode } from "../../shared/catalogs";
import { formatDui, isValidDui } from "../../shared/dui";
import type { Env } from "../types";
import { addHours, nowIso } from "../utils/dates";
import { newId } from "../utils/ids";
import { Repository } from "../storage/repository";
import { WompiApiError, WompiApiService } from "./wompiApi";

// Public donor-checkout limits. Amounts arrive as dollars (string or number) and
// are stored as integer cents; the DTE side already rounds the same way.
const MIN_AMOUNT_CENTS = 100; // $1.00
const MAX_AMOUNT_CENTS = 500_000; // $5,000.00
const MAX_DONOR_NAME = 200;
const MAX_FREE_DOCUMENT = 50;
const MAX_EMAIL = 200;
const MAX_COMPLEMENTO = 300;
const INTENT_VALIDITY_HOURS = 1; // matches the Wompi link vigencia (Task 1).

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

export interface ValidatedIntentInput {
  amountCents: number;
  donorName: string;
  donorDocumentType: "13" | "37";
  donorDocument: string;
  donorEmail: string;
  donorPhone: string | null;
  direccionDepartamento: string;
  direccionMunicipio: string;
  direccionDistrito: string;
  direccionComplemento: string;
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

function isTrivialEmail(value: string): boolean {
  return value.length <= MAX_EMAIL && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// Full server-side validation of a donor-checkout body. Every branch throws an
// IntentValidationError with its own code so the route can map it to a 400.
export function validateIntentInput(body: Record<string, unknown>): ValidatedIntentInput {
  const amountCents = parseAmountCents(body.amount);

  const donorName = requireString(body.donorName);
  if (!donorName || donorName.length > MAX_DONOR_NAME) {
    throw new IntentValidationError("invalid_donor_name", "Ingrese el nombre del donante (máximo 200 caracteres).");
  }

  const donorDocumentType = body.donorDocumentType;
  if (donorDocumentType !== "13" && donorDocumentType !== "37") {
    throw new IntentValidationError("invalid_document_type", "Seleccione DUI (13) u otro documento (37).");
  }

  const rawDocument = requireString(body.donorDocument);
  let donorDocument: string;
  if (donorDocumentType === "13") {
    if (!isValidDui(rawDocument)) {
      throw new IntentValidationError("invalid_dui", "DUI inválido: revise el número y el dígito verificador.");
    }
    donorDocument = formatDui(rawDocument); // stored canonically as XXXXXXXX-X
  } else {
    if (!rawDocument || rawDocument.length > MAX_FREE_DOCUMENT) {
      throw new IntentValidationError("invalid_document", "Ingrese el documento del donante (máximo 50 caracteres).");
    }
    donorDocument = rawDocument;
  }

  const donorEmail = requireString(body.donorEmail);
  if (!isTrivialEmail(donorEmail)) {
    throw new IntentValidationError("invalid_email", "Ingrese un correo electrónico válido.");
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
    throw new IntentValidationError("invalid_complemento", "Ingrese la dirección (máximo 300 caracteres).");
  }

  return {
    amountCents,
    donorName,
    donorDocumentType,
    donorDocument,
    donorEmail,
    donorPhone,
    direccionDepartamento,
    direccionMunicipio,
    direccionDistrito,
    direccionComplemento
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
    donorName: input.donorName,
    donorDocumentType: input.donorDocumentType,
    donorDocument: input.donorDocument,
    donorEmail: input.donorEmail,
    donorPhone: input.donorPhone,
    direccionDepartamento: input.direccionDepartamento,
    direccionMunicipio: input.direccionMunicipio,
    direccionDistrito: input.direccionDistrito,
    direccionComplemento: input.direccionComplemento,
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
