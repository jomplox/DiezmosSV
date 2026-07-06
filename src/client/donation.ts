import { CAT012_DEPARTMENTS, CAT020_COUNTRIES } from "../shared/catalogs";
import { isValidDui } from "../shared/dui";
import { isValidNitFormat } from "../shared/nit";

// Public donor-checkout view logic, extracted so the source-contract tests can
// import the pure helpers. The two routes render WITHOUT a session and never
// touch the auth bootstrap flow (see App.tsx path branching).

export const DONAR_WOMPI_SCRIPT_URL = "https://pagos.wompi.sv/js/wompi.pagos.js";
export const DONAR_INTENT_PATH = "/api/donations/intent";

// Poll the intent status every ~5s while the widget modal is open; stop after
// ~3 minutes with a neutral closing message (covers slow MH, contingency mode,
// and abandoned checkouts — never implies failure).
export const DONAR_POLL_INTERVAL_MS = 5_000;
export const DONAR_POLL_TIMEOUT_MS = 180_000;
// If the Wompi script never loads or the widget button never renders within this
// window, fall back to the full-page hosted flow (window.location.href).
export const DONAR_SCRIPT_TIMEOUT_MS = 4_000;
// Poll the widget host this often (up to DONAR_SCRIPT_TIMEOUT_MS) for the button
// Wompi injects, then auto-click it once so the payment modal opens immediately.
export const DONAR_AUTOCLICK_INTERVAL_MS = 150;

export const DONAR_AMOUNT_CHIPS = [5, 10, 25, 50] as const;
export const DONAR_MIN_AMOUNT = 1;

export const DONAR_THANK_YOU_TITLE = "Su donación fue recibida.";
export const DONAR_THANK_YOU_BODY =
  "Recibirá su comprobante (CDE) por correo cuando el Ministerio de Hacienda lo confirme.";
export const DONAR_FALLBACK_MESSAGE =
  "Si completó el pago, recibirá su comprobante (CDE) por correo electrónico. Puede cerrar esta página.";

// postMessage payload the thank-you page sends to its opener (the /donar view)
// when it detects it is running inside the widget iframe modal.
export const DONAR_COMPLETED_MESSAGE = "diezmos:donation-completed";

// All five CAT-022 receptor document types the /donar form accepts.
export type DonorDocumentType = "13" | "36" | "37" | "03" | "02";

// The 00 codes across CAT-008/012/013 are "Otro (Para extranjeros)": a foreign
// donor stores 00/00/00 geography plus their CAT-020 country (donor_pais).
export const DONAR_FOREIGN_GEOGRAPHY_CODE = "00";

// Countries offered on the foreign-residence select. "SV" is excluded: a donor who
// resides in El Salvador must pick their real departamento/municipio/distrito.
export const DONAR_FOREIGN_COUNTRIES = CAT020_COUNTRIES.filter((option) => option.code !== "SV");

// Domestic departamento choices: the "00 — Otro (Para extranjeros)" pseudo-code is
// reachable only through the extranjero toggle, never as a domestic selection (it
// would trip the server's foreign-path validation without a país).
export const DONAR_DOMESTIC_DEPARTMENTS = CAT012_DEPARTMENTS.filter((option) => option.code !== DONAR_FOREIGN_GEOGRAPHY_CODE);

// Name and email are collected on Wompi's hosted sheet, not on the /donar form, so
// the form input carries documento, teléfono, dirección, and monto — plus the
// razón social (NIT donors only: the comprobante must name the empresa, not the
// cardholder) and the foreign-residence fields.
export interface DonationFormInput {
  amount: string;
  donorDocumentType: DonorDocumentType;
  donorDocument: string;
  donorName: string;
  donorPhone: string;
  foreignResident: boolean;
  pais: string;
  departamento: string;
  municipio: string;
  distrito: string;
  complemento: string;
}

export function isDonarPath(pathname: string): boolean {
  return pathname === "/donar" || pathname === "/donar/";
}

export function isDonarGraciasPath(pathname: string): boolean {
  return pathname === "/donar/gracias" || pathname === "/donar/gracias/";
}

// Mirrors the server-side validation codes (src/worker/services/donations.ts) but
// with donor-facing usted-form messages shown inline. Each CAT-022 document type
// carries its own rule: DUI check digit (13), NIT 14-digit format (36, plus a
// required razón social), pasaporte/carnet 5-30 chars (03/02), and free text for
// Otro (37). Name and email are NOT validated here — the donor enters them on
// Wompi's hosted sheet (razón social is the one exception, for NIT donors).
export function donationFormValidationMessage(input: DonationFormInput): string {
  const amount = Number.parseFloat(input.amount.trim());
  if (!input.amount.trim() || !Number.isFinite(amount)) {
    return "Ingrese un monto válido en dólares.";
  }
  if (amount < DONAR_MIN_AMOUNT) {
    return "El monto mínimo de donación es $1.00.";
  }

  if (input.donorDocumentType === "13") {
    if (!isValidDui(input.donorDocument)) {
      return "Revise el número de DUI.";
    }
  } else if (input.donorDocumentType === "36") {
    if (!isValidNitFormat(input.donorDocument)) {
      return "Revise el número de NIT (14 dígitos).";
    }
    if (!input.donorName.trim()) {
      return "Ingrese la razón social.";
    }
    if (input.donorName.trim().length > 200) {
      return "La razón social no debe exceder 200 caracteres.";
    }
  } else if (input.donorDocumentType === "03" || input.donorDocumentType === "02") {
    const documentLength = input.donorDocument.trim().length;
    if (documentLength < 5 || documentLength > 30) {
      return "Ingrese su documento (entre 5 y 30 caracteres).";
    }
  } else if (!input.donorDocument.trim()) {
    return "Ingrese su documento.";
  } else if (input.donorDocument.trim().length > 50) {
    return "El documento no debe exceder 50 caracteres.";
  }

  if (input.foreignResident) {
    if (!input.pais) {
      return "Seleccione su país de residencia.";
    }
  } else {
    if (!input.departamento) {
      return "Seleccione un departamento.";
    }
    if (!input.municipio) {
      return "Seleccione un municipio.";
    }
    if (!input.distrito) {
      return "Seleccione un distrito.";
    }
  }
  if (!input.complemento.trim()) {
    return "Ingrese su dirección.";
  }

  return "";
}

// Maps the validated form to the POST /api/donations/intent body. The razón
// social travels only for NIT (36) donors; the foreign path replaces the three
// geography codes with 00/00/00 and carries the CAT-020 país.
export function donationIntentBody(form: DonationFormInput): Record<string, unknown> {
  return {
    amount: form.amount.trim(),
    donorDocumentType: form.donorDocumentType,
    donorDocument: form.donorDocument.trim(),
    donorName: form.donorDocumentType === "36" ? form.donorName.trim() : undefined,
    donorPhone: form.donorPhone.trim() || undefined,
    departamento: form.foreignResident ? DONAR_FOREIGN_GEOGRAPHY_CODE : form.departamento,
    municipio: form.foreignResident ? DONAR_FOREIGN_GEOGRAPHY_CODE : form.municipio,
    distrito: form.foreignResident ? DONAR_FOREIGN_GEOGRAPHY_CODE : form.distrito,
    pais: form.foreignResident ? form.pais : undefined,
    complemento: form.complemento.trim()
  };
}

// The widget consumes urlEnlaceLargo (which already carries a query string), so
// the esWidget flag is appended with `&`.
export function widgetUrlFrom(urlEnlaceLargo: string): string {
  return `${urlEnlaceLargo}&esWidget=1`;
}

export interface GraciasDisplay {
  identificadorEnlaceComercio: string;
  idTransaccion: string;
  monto: string;
}

// Display-only parse of Wompi's redirect query string. NOTHING security-relevant
// depends on these values (the hash parameter is not verified in v1).
export function graciasDisplayFromSearch(search: string): GraciasDisplay {
  const params = new URLSearchParams(search);
  return {
    identificadorEnlaceComercio: params.get("identificadorEnlaceComercio")?.trim() ?? "",
    idTransaccion: params.get("idTransaccion")?.trim() ?? "",
    monto: params.get("monto")?.trim() ?? ""
  };
}
