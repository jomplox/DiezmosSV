import { CAT012_DEPARTMENTS, CAT020_COUNTRIES } from "../shared/catalogs";
import { isValidDui } from "../shared/dui";
import { isValidNitFormat } from "../shared/nit";

// Public donor-checkout view logic, extracted so the source-contract tests can
// import the pure helpers. The two routes render WITHOUT a session and never
// touch the auth bootstrap flow (see App.tsx path branching).

export const DONAR_INTENT_PATH = "/api/donations/intent";

// Poll the intent status every ~5s while the embedded checkout is open; stop after
// ~3 minutes with a neutral closing message (covers slow MH, deferred
// transmission while MH is down, and abandoned checkouts — never implies failure).
export const DONAR_POLL_INTERVAL_MS = 5_000;
export const DONAR_POLL_TIMEOUT_MS = 180_000;
// If the embedded checkout iframe has not loaded within this window, surface the
// hosted-checkout CTA (the iframe keeps loading underneath — never a redirect).
export const DONAR_SCRIPT_TIMEOUT_MS = 4_000;

export const DONAR_AMOUNT_CHIPS = [5, 10, 25, 50] as const;
export const DONAR_MIN_AMOUNT = 1;

// ── Step wizard (Givebutter-style structure, monochrome Gotham skin) ─────────
//
// The single long form became one concern per screen. SV door: Paso 1 monto,
// Paso 2 datos, Paso 3 pago (Wompi handoff). US door: Paso 1 monto (Única |
// Mensual), Paso 2 the embedded Givebutter giving form.
export const DONAR_STEP_COUNT_SV = 3;
export const DONAR_STEP_COUNT_US = 2;
// Wizard chrome. The step indicator is plain "Paso n de m" (Gotham Book, gray).
export const DONAR_CONTINUE_LABEL = "Continuar";
export const DONAR_BACK_LABEL = "← Atrás";
export const DONAR_EDIT_LABEL = "Editar";
// The hero amount input: "$" prefix + giant centered numerals. This IS the
// amount control — the old small "Otro monto" afterthought field is gone.
export const DONAR_HERO_PLACEHOLDER = "0.00";

export function donarStepIndicator(step: number, total: number): string {
  return `Paso ${step} de ${total}`;
}

// The Paso 3 summary figure ("Diezmo · $125.00"). Only rendered after Paso 1
// validated the amount, but degrades to $0.00 rather than NaN just in case.
export function donarAmountDisplay(amount: string): string {
  const parsed = Number.parseFloat(amount.trim());
  return `$${(Number.isFinite(parsed) ? parsed : 0).toFixed(2)}`;
}

// ── US donors → Givebutter / Friends of Misión ExampleOrganization (FMCE) ────────────
//
// A US-resident donor gets NO Salvadoran CDE (useless to a US taxpayer); their
// gift belongs on the US 501(c)(3)'s books and yields a US-deductible receipt from
// Givebutter. When "Resido en el extranjero" is checked AND país === "US", the SV
// fiscal fields collapse and the embedded Givebutter giving form takes over. No
// backend involvement: no intent, no webhook, no migration.
//
// Widget account code EXAMPLEACCT00001 (dashboard account 000000), campaign "example-campaign" ("Mis Diezmos y Ofrendas",
// https://givebutter.com/example-campaign). The campaign attribute is UNVERIFIED for the
// vanity slug (docs say six-character code); the controller can swap this constant
// for the dashboard short code if the empirical probe shows the slug is rejected.
export const GIVEBUTTER_ACCOUNT_ID = "EXAMPLEACCT00001";
export const GIVEBUTTER_CAMPAIGN = "example-campaign";
export const GIVEBUTTER_SCRIPT_URL = "https://widgets.givebutter.com/latest.umd.cjs?acct=EXAMPLEACCT00001";
// The CAT-020 código for Estados Unidos: the only foreign country that routes to
// Givebutter (every other país stays on the Wompi + CDE path).
export const GIVEBUTTER_US_COUNTRY_CODE = "US";
// Same probe budget as the Wompi widget: if the custom element has not rendered a
// child (iframe/shadow content) within this window, show the hosted-page fallback.
export const GIVEBUTTER_RENDER_TIMEOUT_MS = 4_000;

// The US door funds the SAME mother church as the SV door — FMCE is only the US
// giving vehicle, never a different beneficiary. The copy says so explicitly.
export const GIVEBUTTER_INTRO =
  "Su diezmo u ofrenda apoya a Misión ExampleOrganization en El Salvador. Se procesa en EE. UU. a través de Friends of Misión ExampleOrganization (501(c)(3)) y recibirá un recibo deducible de impuestos en EE. UU. por correo.";
// "GiveButter" is the brand style (capital G, capital B) and is the anchor text — no
// raw URL is ever shown to the donor.
export const GIVEBUTTER_FALLBACK_HINT = "¿Problemas con el formulario? Done en GiveButter";
export const GIVEBUTTER_FALLBACK_CTA = "Donar en GiveButter";
export const GIVEBUTTER_MONTHLY_LABEL = "Donación mensual";
// The monthly toggle restyled as the Paso 1 segmented control (Única | Mensual).
// GIVEBUTTER_MONTHLY_LABEL stays as the radiogroup's accessible name.
export const GIVEBUTTER_FREQ_ONCE_LABEL = "Única";
export const GIVEBUTTER_FREQ_MONTHLY_LABEL = "Mensual";
// Shown under the EE. UU. door's Givebutter block: the widget is English-only.
export const GIVEBUTTER_ENGLISH_NOTICE = "El formulario de pago se muestra en inglés.";

// ── Two-door donation landing ───────────────────────────────────────────────
//
// /donar opens on a chooser: the donor picks where their gift goes before any
// form appears. Card 1 (El Salvador y el mundo) opens the existing SV fiscal
// (Wompi + CDE) form; Card 2 (EE. UU.) opens the Givebutter block directly,
// skipping the extranjero mechanics. A "Cambiar opción" link returns here.
export type DonarDoor = "sv" | "eeuu";

export const DONAR_LANDING_HEADING = "Diezmos y Ofrendas";
// Residence-based framing: the doors differ by the donor's residence / payment rail /
// tax receipt, NEVER by beneficiary. Both fund Misión ExampleOrganization in El Salvador.
export const DONAR_LANDING_SUBTITLE = "Elija según su lugar de residencia.";
export const DONAR_LANDING_UNIFIER =
  "Todos los diezmos y ofrendas apoyan la obra de Misión ExampleOrganization en El Salvador.";
export const DONAR_DOOR_SV_LABEL = "El Salvador y el mundo";
// Per-door descriptor: the real differentiator is the tax receipt, not the destination.
export const DONAR_DOOR_SV_DESC = "Comprobante de donación DTE salvadoreño";
export const DONAR_DOOR_EEUU_LABEL = "EE. UU.";
export const DONAR_DOOR_EEUU_DESC = "Recibo oficial deducible de impuestos (IRS 501(c)(3))";
export const DONAR_CHANGE_DOOR_LABEL = "← Cambiar opción";

// Optional deep-link: /donar?ruta=sv or ?ruta=eeuu preselects a door. Read once
// on mount; the chooser writes it back via history.replaceState so a refresh
// keeps the door. Any other value (or absence) leaves the donor on the chooser.
export const DONAR_ROUTE_PARAM = "ruta";
export const DONAR_ROUTE_SV = "sv";
export const DONAR_ROUTE_EEUU = "eeuu";

export function doorFromSearch(search: string): DonarDoor | null {
  const value = new URLSearchParams(search).get(DONAR_ROUTE_PARAM);
  if (value === DONAR_ROUTE_SV) {
    return "sv";
  }
  if (value === DONAR_ROUTE_EEUU) {
    return "eeuu";
  }
  return null;
}

// The ?ruta value for a chosen door (null clears it). Used to compose the query
// via history.replaceState WITHOUT clobbering the Givebutter amount/frequency
// prefill the US path already writes.
export function routeParamForDoor(door: DonarDoor | null): string | null {
  if (door === "sv") {
    return DONAR_ROUTE_SV;
  }
  if (door === "eeuu") {
    return DONAR_ROUTE_EEUU;
  }
  return null;
}

// True when the donor is a US resident, i.e. the Givebutter path should replace the
// SV fiscal form. Amount is orthogonal (checked separately before mounting).
export function isUsDonation(form: Pick<DonationFormInput, "foreignResident" | "pais">): boolean {
  return form.foreignResident && form.pais === GIVEBUTTER_US_COUNTRY_CODE;
}

// Normalizes the entered monto to a plain dollar string for the widget/URL prefill.
// Returns "" for a blank/invalid amount so the caller can omit the query param.
export function givebutterAmountParam(amount: string): string {
  const parsed = Number.parseFloat(amount.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "";
  }
  // Whole dollars render without a trailing ".00"; cents are preserved.
  return Number.isInteger(parsed) ? String(parsed) : String(parsed);
}

// Query params the Givebutter widget reads from the HOST page URL (written via
// history.replaceState before mounting, removed when leaving the US path). Monthly
// maps to frequency=monthly; a one-time gift carries no frequency param.
export function givebutterPrefillParams(input: { amount: string; monthly: boolean }): Record<string, string> {
  const params: Record<string, string> = {};
  const amount = givebutterAmountParam(input.amount);
  if (amount) {
    params.amount = amount;
  }
  if (input.monthly) {
    params.frequency = "monthly";
  }
  return params;
}

// The mandatory hosted-page fallback link. Works with the vanity slug in all cases
// (Givebutter resolves the slug in share URLs), so it is safe even if the embedded
// custom element ends up needing the six-character code.
export function givebutterHostedUrl(input: { amount: string; monthly: boolean }): string {
  const params = new URLSearchParams(givebutterPrefillParams(input));
  const query = params.toString();
  return query ? `https://givebutter.com/${GIVEBUTTER_CAMPAIGN}?${query}` : `https://givebutter.com/${GIVEBUTTER_CAMPAIGN}`;
}

export const DONAR_THANK_YOU_TITLE = "Dios le bendiga. Su aportación fue recibida.";
export const DONAR_THANK_YOU_BODY =
  "Recibirá su comprobante (CDE) por correo cuando el Ministerio de Hacienda lo confirme.";
export const DONAR_FALLBACK_MESSAGE =
  "Si completó el pago, recibirá su comprobante (CDE) por correo electrónico. Puede cerrar esta página.";

// Paso 3 handoff states: spinner copy while the embedded Wompi widget prepares,
// and the manual hosted-checkout CTA when it takes longer than the render budget.
// Leaving the page is always donor-initiated — never an automatic redirect.
export const DONAR_WIDGET_LOADING_MESSAGE = "Preparando el pago seguro…";
export const DONAR_WIDGET_DELAYED_MESSAGE =
  "El pago está tardando más de lo esperado. Puede continuar en la página segura de Wompi:";
export const DONAR_WIDGET_FALLBACK_CTA = "Continuar al pago en Wompi";

// postMessage payload the thank-you page sends to its opener (the /donar view)
// when it detects it is running inside the widget iframe modal.
export const DONAR_COMPLETED_MESSAGE = "diezmos:donation-completed";

// All five CAT-022 receptor document types the /donar form accepts.
export type DonorDocumentType = "13" | "36" | "37" | "03" | "02";

// Diezmo vs Ofrenda, the REQUIRED first field on the SV (Wompi/CDE) form. "" is the
// unselected state (the form client-validates it as required before submitting).
export type DonarGiftType = "DIEZMO" | "OFRENDA";
export const DONAR_GIFT_TYPE_DIEZMO = "DIEZMO" as const;
export const DONAR_GIFT_TYPE_OFRENDA = "OFRENDA" as const;
// Chip labels (monochrome chips, like the monto chips; active inverts to black).
export const DONAR_GIFT_TYPE_LABEL: Record<DonarGiftType, string> = {
  DIEZMO: "Diezmo",
  OFRENDA: "Ofrenda"
};
export const DONAR_GIFT_TYPE_FIELD_LABEL = "Tipo";

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
  // Diezmo vs Ofrenda: "" until the donor picks a chip. Required on the SV path.
  giftType: DonarGiftType | "";
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

// The amount rule alone: shared by both doors' Paso 1 (the US door has no gift
// type, so its Paso 1 gates on this only).
export function donationAmountValidationMessage(amount: string): string {
  const parsed = Number.parseFloat(amount.trim());
  if (!amount.trim() || !Number.isFinite(parsed)) {
    return "Ingrese un monto válido en dólares.";
  }
  if (parsed < DONAR_MIN_AMOUNT) {
    return "El monto mínimo de donación es $1.00.";
  }
  return "";
}

// Paso 1 (SV door): diezmo/ofrenda choice + amount. The wizard's "Continuar"
// advances only when this returns "".
export function donationStep1ValidationMessage(input: Pick<DonationFormInput, "giftType" | "amount">): string {
  // The SV form requires the donor to state whether the gift is a diezmo or an
  // ofrenda before anything else. (The US/Givebutter path renders no fiscal form and
  // never reaches this validator.)
  if (input.giftType !== "DIEZMO" && input.giftType !== "OFRENDA") {
    return "Seleccione si es diezmo u ofrenda.";
  }
  return donationAmountValidationMessage(input.amount);
}

// Mirrors the server-side validation codes (src/worker/services/donations.ts) but
// with donor-facing usted-form messages shown inline. Each CAT-022 document type
// carries its own rule: DUI check digit (13), NIT 14-digit format (36, plus a
// required razón social), pasaporte/carnet 5-30 chars (03/02), and free text for
// Otro (37). Name and email are NOT validated here — the donor enters them on
// Wompi's hosted sheet (razón social is the one exception, for NIT donors).
// Paso 2 (SV door): identity + address. Ignores the Paso-1 fields entirely.
export function donationStep2ValidationMessage(input: DonationFormInput): string {
  if (input.donorDocumentType === "13") {
    if (!isValidDui(input.donorDocument)) {
      return "Revise el número de DUI.";
    }
  } else if (input.donorDocumentType === "36") {
    // Donor-facing framing: the select labels 36 as "Empresa", so the copy asks for
    // the empresa's NIT (a natural person's document is the DUI post-reform).
    if (!isValidNitFormat(input.donorDocument)) {
      return "Ingrese el NIT de la empresa (14 dígitos).";
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
  // MH's fe-cd-v2 schema caps direccion.complemento at 200 characters; mirror the
  // server cap so the donor hears it before paying, not at CDE build time.
  if (input.complemento.trim().length > 200) {
    return "La dirección no debe exceder 200 caracteres.";
  }

  return "";
}

// The whole-form validator is exactly Paso 1 then Paso 2 — same messages, same
// order as the pre-wizard single-form validator (and the server mirror).
export function donationFormValidationMessage(input: DonationFormInput): string {
  return donationStep1ValidationMessage(input) || donationStep2ValidationMessage(input);
}

// Maps the validated form to the POST /api/donations/intent body. The razón
// social travels only for NIT (36) donors; the foreign path replaces the three
// geography codes with 00/00/00 and carries the CAT-020 país.
export function donationIntentBody(form: DonationFormInput): Record<string, unknown> {
  return {
    amount: form.amount.trim(),
    // Diezmo/Ofrenda: sent only when chosen (the SV form always sends it after
    // client validation); omitted otherwise so the server keeps its null default.
    giftType: form.giftType || undefined,
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
