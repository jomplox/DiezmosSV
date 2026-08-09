import { CHECKOUT_WINDOW_MS } from "../shared/checkout";
import { CAT012_DEPARTMENTS, CAT020_COUNTRIES } from "../shared/catalogs";
import { isValidDui } from "../shared/dui";
import { formatCents } from "../shared/money";
import { isValidNitFormat } from "../shared/nit";

// Public donor-checkout view logic, extracted so the source-contract tests can
// import the pure helpers. The two routes render WITHOUT a session and never
// touch the auth bootstrap flow (see App.tsx path branching).

export const DONAR_INTENT_PATH = "/api/donations/intent";

// The datos-completion endpoint for a minted draft intent. The wizard mints the Wompi
// link in the background when the SV donor enters Paso 2 (POST DONAR_INTENT_PATH with
// only { amount, giftType }), then attaches the fiscal data here on Paso 2 submit with
// a fast D1-only call, so Paso 3 renders without waiting on Wompi.
export function donarDatosPath(intentId: string): string {
  return `${DONAR_INTENT_PATH}/${intentId}/datos`;
}

// Poll the intent status every ~5s while the embedded checkout is open; stop after
// ~3 minutes with a neutral closing message (covers slow MH, deferred
// transmission while MH is down, and abandoned checkouts — never implies failure).
export const DONAR_POLL_INTERVAL_MS = 5_000;
// Matches the window the Worker sets on the Wompi link, so the page never gives up
// while Wompi still has the donor mid-challenge. See src/shared/checkout.ts.
export const DONAR_POLL_TIMEOUT_MS = CHECKOUT_WINDOW_MS;
// If the embedded checkout iframe has not loaded within this window, surface the
// hosted-checkout CTA (the iframe keeps loading underneath — never a redirect).
export const DONAR_SCRIPT_TIMEOUT_MS = 4_000;
// Wompi posts { message: "close" } at the 3DS HAND-OFF, not at payment, so that signal
// alone must never put "Verificando su entrega…" on screen: the donor is still inside
// the bank challenge, and a spinner claiming to verify an entrega they have not made
// reads as a hung page. Wompi's own iframe narrates the challenge and then its success
// screen; hold our notice back for four poll cycles, by which point a donor who
// finished is already on thanks and only a genuinely stuck entrega is still waiting.
export const DONAR_VERIFYING_NOTICE_DELAY_MS = 20_000;

// A background-minted draft carries a Wompi link minted with a one-hour vigencia on the
// worker (INTENT_VALIDITY_HOURS / LINK_VALIDITY_HOURS). If the donor leaves the tab open
// on Paso 1 and returns much later, that link may be dead. Only reuse a retained draft
// while it is comfortably inside the vigencia; past this conservative window the wizard
// re-mints on the next Paso 1→2 crossing. 45 min keeps a 15-min margin under the hour.
export const DONAR_DRAFT_REUSE_WINDOW_MS = 45 * 60 * 1000;

export const DONAR_AMOUNT_CHIPS = [50, 150, 250, 500] as const;
// The US door's quick amounts bridge toward the Givebutter campaign's own presets
// ($100–$2,000): the chip prefills the embed, so wildly different anchors on two
// consecutive screens read as a mistake. $50 keeps an accessible low option.
export const DONAR_AMOUNT_CHIPS_US = [50, 100, 250, 500] as const;
const DONAR_MIN_AMOUNT = 1;

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

// Working-step labels (steps ≥2): a small caps-tracked line under the brand
// title that orients the donor without competing with the ceremonial header.
// "Su entrega" — never "pago" — per the donor-facing wording rule.
export const DONAR_STEP_TITLE_DATOS = "Sus datos";
export const DONAR_STEP_TITLE_ENTREGA = "Su entrega";

// The Paso 3 summary figure ("Diezmo · $125.00"). Only rendered after Paso 1
// validated the amount, but degrades to $0.00 rather than NaN just in case.
export function donarAmountDisplay(amount: string): string {
  const parsed = Number.parseFloat(amount.trim());
  return formatCents(Math.round((Number.isFinite(parsed) ? parsed : 0) * 100));
}

// ── US donors → Givebutter / configured US nonprofit ───────────────
//
// A US-resident donor gets NO Salvadoran CDE (useless to a US taxpayer); their
// gift belongs on the US 501c3's books and yields a US-deductible receipt from
// Givebutter. When "Resido en el extranjero" is checked AND país === "US", the SV
// fiscal fields collapse and the embedded Givebutter giving form takes over. No
// backend involvement: no intent, no webhook, no migration.
//
// Account code EXAMPLEACCT00001 (dashboard account 000000), campaign "example-campaign"
// ("Mis Diezmos y Ofrendas", https://givebutter.com/example-campaign). The hosted campaign
// page sends x-frame-options: sameorigin, so /donar must iframe Givebutter's
// purpose-built embed URL instead.
export const GIVEBUTTER_ACCOUNT_ID = "EXAMPLEACCT00001";
export const GIVEBUTTER_CAMPAIGN = "example-campaign";
export const GIVEBUTTER_EMBED_BASE_URL = `https://givebutter.com/embed/c/${GIVEBUTTER_CAMPAIGN}`;
// The CAT-020 código for Estados Unidos: the only foreign country that routes to
// Givebutter (every other país stays on the Wompi + CDE path).
export const GIVEBUTTER_US_COUNTRY_CODE = "US";
// Same probe budget as the Wompi widget: if the direct iframe has not loaded
// within this window, show the hosted-page fallback.
export const GIVEBUTTER_RENDER_TIMEOUT_MS = 4_000;

// The US door funds the SAME mother church as the SV door — the 501c3 is only the
// US giving vehicle, never a different beneficiary. Build the attribution from the
// public branding record so a reusable build never ships a demo organization name.
export function givebutterIntro(organizationName: string | null): string {
  const name = organizationName?.trim();
  if (!name) {
    return "Su diezmo u ofrenda apoya a esta iglesia en El Salvador. Se procesa en EE. UU. a través de una organización estadounidense 501c3 y recibirá un recibo deducible de impuestos en EE. UU. por correo.";
  }
  return `Su diezmo u ofrenda apoya a ${name} en El Salvador. Se procesa en EE. UU. a través de Friends of ${name} (501c3) y recibirá un recibo deducible de impuestos en EE. UU. por correo.`;
}
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
export const GIVEBUTTER_ENGLISH_NOTICE = "El formulario se muestra en inglés.";

// ── Two-door donation landing ───────────────────────────────────────────────
//
// /donar opens on a chooser: the donor picks where their gift goes before any
// form appears. Card 1 (El Salvador y el mundo) opens the existing SV fiscal
// (Wompi + CDE) form; Card 2 (EE. UU.) opens the Givebutter block directly,
// skipping the extranjero mechanics. A "Cambiar opción" link returns here.
export type DonarDoor = "sv" | "eeuu";

export const DONAR_LANDING_HEADING = "Diezmos y Ofrendas";
// Official support contact for BOTH lanes (SV fiscal + EE. UU./Givebutter). Rendered
// as a discreet mailto line at the bottom of every donor screen and in email footers.
export const DONAR_SUPPORT_EMAIL = "legacy-contact-1@example.com";
// Residence-based framing: the doors differ by the donor's residence / payment rail /
// tax receipt, NEVER by beneficiary. Both fund the configured church in El Salvador.
export const DONAR_LANDING_SUBTITLE = "Elija según su lugar de residencia.";
// The SV flag is rendered as an inline SVG badge after the church name (flag EMOJI
// are unreliable: Windows renders them as bare letters, other platforms as a blank
// box — the landing showed "El Salvador  ." with an orphaned period).
export const DONAR_LANDING_UNIFIER_LEAD = "Todos los diezmos y ofrendas apoyan la obra de";
export function donarLandingUnifierChurch(organizationName: string | null): string {
  return `${organizationName?.trim() || "esta iglesia"} en El Salvador`;
}
export const DONAR_DOOR_SV_LABEL = "El Salvador y el mundo";
// Per-door descriptor: the real differentiator is the tax receipt, not the destination.
export const DONAR_DOOR_SV_DESC = "Comprobante de donación DTE salvadoreño";
export const DONAR_DOOR_EEUU_LABEL = "EE. UU.";
export const DONAR_DOOR_EEUU_DESC = "Recibo oficial deducible de impuestos (IRS 501c3)";
export const DONAR_CHANGE_DOOR_LABEL = "← Cambiar opción";

// Optional deep-link: /donar?ruta=sv or ?ruta=eeuu preselects a door. Read once
// on mount; the chooser writes it back via history.replaceState so a refresh
// keeps the door. Any other value (or absence) leaves the donor on the chooser.
export const DONAR_ROUTE_PARAM = "ruta";
const DONAR_ROUTE_SV = "sv";
const DONAR_ROUTE_EEUU = "eeuu";

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

// Normalizes the entered monto to a plain dollar string for Givebutter URL prefill.
// Returns "" for a blank/invalid amount so the caller can omit the query param.
function givebutterAmountParam(amount: string): string {
  const parsed = Number.parseFloat(amount.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return "";
  }
  // Whole dollars render without a trailing ".00"; cents are preserved.
  return Number.isInteger(parsed) ? String(parsed) : String(parsed);
}

// Query params shared by the Givebutter iframe and hosted-page fallback. Monthly
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

// The frameable Givebutter embed URL discovered from their widget's elements API
// (2026-07-07). goalBar=false matches the official widget's generated iframe src.
export function givebutterEmbedUrl(input: { amount: string; monthly: boolean }): string {
  const params = new URLSearchParams(givebutterPrefillParams(input));
  params.set("goalBar", "false");
  return `${GIVEBUTTER_EMBED_BASE_URL}?${params.toString()}`;
}

// The mandatory hosted-page fallback link. Works with the vanity slug in all cases
// (Givebutter resolves the slug in share URLs), so it is safe even if the embed
// endpoint changes in the future.
export function givebutterHostedUrl(input: { amount: string; monthly: boolean }): string {
  const params = new URLSearchParams(givebutterPrefillParams(input));
  const query = params.toString();
  return query ? `https://givebutter.com/${GIVEBUTTER_CAMPAIGN}?${query}` : `https://givebutter.com/${GIVEBUTTER_CAMPAIGN}`;
}

export const DONAR_THANK_YOU_TITLE = "Dios le bendiga. Su aportación fue recibida.";
export const DONAR_THANK_YOU_BODY =
  "Recibirá su comprobante de donación por correo electrónico cuando el Ministerio de Hacienda lo confirme.";
export const DONAR_FALLBACK_MESSAGE =
  "Si completó su entrega, recibirá su comprobante de donación por correo electrónico. Puede cerrar esta página.";

// Paso 3 handoff states: spinner copy while the embedded checkout prepares, and the
// manual hosted-checkout CTA when it takes longer than the render budget. Leaving the
// page is always donor-initiated — never an automatic redirect. Wording rule for every
// donor-facing string: these are diezmos y ofrendas — an ENTREGA, never a "pago"
// (Wompi is still named where it builds trust in the secure card step).
export const DONAR_WIDGET_LOADING_MESSAGE = "Preparando su entrega segura…";
export const DONAR_WIDGET_VERIFYING_MESSAGE = "Verificando su entrega…";
export const DONAR_WIDGET_DELAYED_MESSAGE =
  "Esto está tardando más de lo esperado. Puede continuar su entrega en la página segura de Wompi:";
export const DONAR_WIDGET_FALLBACK_CTA = "Continuar en Wompi";

// Preconnect target for the Paso 3 embed: DNS + TLS are warmed only after the donor
// chooses the SV/Wompi path, so chooser-only visits do not contact Wompi.
export const DONAR_WOMPI_CHECKOUT_ORIGIN = "https://pagos.wompi.sv";

// postMessage payload the thank-you page sends to its opener (the /donar view)
// when it detects it is running inside the widget iframe modal.
export const DONAR_COMPLETED_MESSAGE = "diezmos:donation-completed";

// All five CAT-022 receptor document types the /donar form accepts.
export type DonorDocumentType = "13" | "36" | "37" | "03" | "02";

// Diezmo vs Ofrenda, the REQUIRED first field on the SV (Wompi/CDE) form. "" is the
// unselected state (the form client-validates it as required before submitting).
export type DonarGiftType = "DIEZMO" | "OFRENDA";
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

// The país select is the full CAT-020 catalog (~240 entries). A "Frecuentes"
// optgroup surfaces the countries where the Salvadoran diaspora actually lives so
// nobody scrolls a government list to find Estados Unidos or Guatemala. The codes
// stay in the full list too — duplicate options are standard in country selects.
const DONAR_FREQUENT_COUNTRY_CODES = ["US", "CA", "ES", "GT", "MX", "HN", "IT", "AU"] as const;
export const DONAR_FREQUENT_COUNTRIES = DONAR_FREQUENT_COUNTRY_CODES.map((code) =>
  DONAR_FOREIGN_COUNTRIES.find((option) => option.code === code)
).filter((option): option is (typeof DONAR_FOREIGN_COUNTRIES)[number] => option !== undefined);
export const DONAR_FREQUENT_COUNTRIES_GROUP_LABEL = "Frecuentes";
export const DONAR_ALL_COUNTRIES_GROUP_LABEL = "Todos los países";

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
  foreignResident: boolean;
  pais: string;
  departamento: string;
  municipio: string;
  distrito: string;
}

export function isDonarPath(pathname: string): boolean {
  return pathname === "/" || pathname === "/donar" || pathname === "/donar/";
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

// ── Per-field validation ────────────────────────────────────────────────────
//
// The wizard shows EVERY invalid field at once, each message under its own
// control (aria-describedby), and clears a field's error the moment the donor
// edits it — no one-error-at-a-time whack-a-mole, no stale messages. The
// single-message validators below reduce these maps in field order, so the
// server mirror and the pre-wizard message contract stay byte-identical.

// Every donor-form control that can carry its own inline error.
export type DonationField =
  | "giftType"
  | "amount"
  | "donorDocument"
  | "donorName"
  | "pais"
  | "departamento"
  | "municipio"
  | "distrito";

export type DonationFieldErrors = Partial<Record<DonationField, string>>;

// Focus-first-invalid order — identical to the legacy first-error-wins order.
export const DONATION_STEP1_FIELD_ORDER: readonly DonationField[] = ["giftType", "amount"];
export const DONATION_STEP2_FIELD_ORDER: readonly DonationField[] = [
  "donorDocument",
  "donorName",
  "pais",
  "departamento",
  "municipio",
  "distrito"
];

export function firstDonationFieldError(
  errors: DonationFieldErrors,
  order: readonly DonationField[]
): DonationField | null {
  for (const field of order) {
    if (errors[field]) {
      return field;
    }
  }
  return null;
}

// Paso 1 (SV door): diezmo/ofrenda choice + amount. The US door has no gift
// type, so its Paso 1 uses donationAmountValidationMessage alone.
export function donationStep1FieldErrors(input: Pick<DonationFormInput, "giftType" | "amount">): DonationFieldErrors {
  const errors: DonationFieldErrors = {};
  // The SV form requires the donor to state whether the gift is a diezmo or an
  // ofrenda before anything else. (The US/Givebutter path renders no fiscal form and
  // never reaches this validator.)
  if (input.giftType !== "DIEZMO" && input.giftType !== "OFRENDA") {
    errors.giftType = "Seleccione si es diezmo u ofrenda.";
  }
  const amountMessage = donationAmountValidationMessage(input.amount);
  if (amountMessage) {
    errors.amount = amountMessage;
  }
  return errors;
}

// Mirrors the server-side validation codes (src/worker/services/donations.ts) but
// with donor-facing usted-form messages shown inline. Each CAT-022 document type
// carries its own rule: DUI check digit (13), NIT 14-digit format (36, plus a
// required razón social), pasaporte/carnet 5-30 chars (03/02), and free text for
// Otro (37). Name and email are NOT validated here — the donor enters them on
// Wompi's hosted sheet (razón social is the one exception, for NIT donors).
// Paso 2 (SV door): identity + address. Ignores the Paso-1 fields entirely.
export function donationStep2FieldErrors(input: DonationFormInput): DonationFieldErrors {
  const errors: DonationFieldErrors = {};
  if (input.donorDocumentType === "13") {
    if (!isValidDui(input.donorDocument)) {
      errors.donorDocument = "Revise el número de DUI.";
    }
  } else if (input.donorDocumentType === "36") {
    // Donor-facing framing: the select labels 36 as "Empresa", so the copy asks for
    // the empresa's NIT (a natural person's document is the DUI post-reform).
    if (!isValidNitFormat(input.donorDocument)) {
      errors.donorDocument = "Ingrese el NIT de la empresa (14 dígitos).";
    }
    if (!input.donorName.trim()) {
      errors.donorName = "Ingrese la razón social.";
    } else if (input.donorName.trim().length > 200) {
      errors.donorName = "La razón social no debe exceder 200 caracteres.";
    }
  } else if (input.donorDocumentType === "03" || input.donorDocumentType === "02") {
    const documentLength = input.donorDocument.trim().length;
    if (documentLength < 5 || documentLength > 30) {
      errors.donorDocument = "Ingrese su documento (entre 5 y 30 caracteres).";
    }
  } else if (!input.donorDocument.trim()) {
    errors.donorDocument = "Ingrese su documento.";
  } else if (input.donorDocument.trim().length > 50) {
    errors.donorDocument = "El documento no debe exceder 50 caracteres.";
  }

  if (input.foreignResident) {
    if (!input.pais) {
      errors.pais = "Seleccione su país de residencia.";
    }
  } else {
    if (!input.departamento) {
      errors.departamento = "Seleccione un departamento.";
    }
    if (!input.municipio) {
      errors.municipio = "Seleccione un municipio.";
    }
    if (!input.distrito) {
      errors.distrito = "Seleccione un distrito.";
    }
  }
  return errors;
}

// Editing a field must clear its own error — and only errors its edit can affect.
// Changing the document TYPE re-scopes the document/razón rules; toggling the
// extranjero checkbox swaps which geography fields exist. A new departamento
// clears only ITS error even though it resets the dependent municipio/distrito
// values: "Seleccione un municipio." is still true of the reset (empty) child, and
// keeping it visible walks the donor down the cascade instead of resurfacing it on
// the next submit.
const DONATION_FIELD_ERROR_CLEARERS: Record<keyof DonationFormInput, readonly DonationField[]> = {
  amount: ["amount"],
  giftType: ["giftType"],
  donorDocumentType: ["donorDocument", "donorName"],
  donorDocument: ["donorDocument"],
  donorName: ["donorName"],
  foreignResident: ["pais", "departamento", "municipio", "distrito"],
  pais: ["pais"],
  departamento: ["departamento"],
  municipio: ["municipio"],
  distrito: ["distrito"]
};

export function clearDonationFieldErrors(
  errors: DonationFieldErrors,
  changed: readonly (keyof DonationFormInput)[]
): DonationFieldErrors {
  const cleared = changed.flatMap((key) => DONATION_FIELD_ERROR_CLEARERS[key] ?? []);
  if (!cleared.some((field) => errors[field])) {
    return errors;
  }
  const next = { ...errors };
  for (const field of cleared) {
    delete next[field];
  }
  return next;
}

// Legacy single-message validators: first field error in order. Kept because the
// whole-form contract (and its tests) pin the exact message sequence.
export function donationStep1ValidationMessage(input: Pick<DonationFormInput, "giftType" | "amount">): string {
  const errors = donationStep1FieldErrors(input);
  const first = firstDonationFieldError(errors, DONATION_STEP1_FIELD_ORDER);
  return first ? errors[first]! : "";
}

export function donationStep2ValidationMessage(input: DonationFormInput): string {
  const errors = donationStep2FieldErrors(input);
  const first = firstDonationFieldError(errors, DONATION_STEP2_FIELD_ORDER);
  return first ? errors[first]! : "";
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
    departamento: form.foreignResident ? DONAR_FOREIGN_GEOGRAPHY_CODE : form.departamento,
    municipio: form.foreignResident ? DONAR_FOREIGN_GEOGRAPHY_CODE : form.municipio,
    distrito: form.foreignResident ? DONAR_FOREIGN_GEOGRAPHY_CODE : form.distrito,
    pais: form.foreignResident ? form.pais : undefined
  };
}

// The DRAFT create body fired in the background on the SV Paso 1→2 transition: only
// the two values known then (amount + gift type). The donor data is attached later via
// the datos endpoint. giftType is always present on the SV path (Diezmo preselected).
export function donationDraftBody(form: Pick<DonationFormInput, "amount" | "giftType">): Record<string, unknown> {
  return {
    amount: form.amount.trim(),
    giftType: form.giftType || undefined
  };
}

// The datos-completion body: the donor's fiscal data ONLY (no amount, no giftType — the
// draft was minted with those and the server must not move them). Same field mapping as
// donationIntentBody minus amount/giftType, so server validation is identical.
export function donationDatosBody(form: DonationFormInput): Record<string, unknown> {
  return {
    donorDocumentType: form.donorDocumentType,
    donorDocument: form.donorDocument.trim(),
    donorName: form.donorDocumentType === "36" ? form.donorName.trim() : undefined,
    departamento: form.foreignResident ? DONAR_FOREIGN_GEOGRAPHY_CODE : form.departamento,
    municipio: form.foreignResident ? DONAR_FOREIGN_GEOGRAPHY_CODE : form.municipio,
    distrito: form.foreignResident ? DONAR_FOREIGN_GEOGRAPHY_CODE : form.distrito,
    pais: form.foreignResident ? form.pais : undefined
  };
}

// Whether a background-minted draft is still safe to reuse. Besides matching the amount +
// gift type the donor now has in the form, the retained Wompi link must still be
// comfortably inside its one-hour vigencia (see DONAR_DRAFT_REUSE_WINDOW_MS). If the donor
// edited either value (Atrás/Editar) or left the link near expiry, the draft is stale and
// the wizard falls back to a fresh full POST (the old link expires on the sweep). `now` is
// injectable for deterministic tests; a draft without a mintedAt is treated as just minted.
export function draftMatchesForm(
  draft: { amount: string; giftType: DonarGiftType | ""; mintedAt?: number },
  form: Pick<DonationFormInput, "amount" | "giftType">,
  now = Date.now()
): boolean {
  const matchesValues = draft.amount === form.amount.trim() && draft.giftType === form.giftType;
  const mintedAt = draft.mintedAt ?? now;
  return matchesValues && now - mintedAt < DONAR_DRAFT_REUSE_WINDOW_MS;
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
