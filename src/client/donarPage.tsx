import { markDonorBrandingSettled } from "./donorReady";
import svFlag from "./assets/sv-flag.svg";
import { GIVEBUTTER_ICON_DATA_URI } from "./assets/givebutterIcon";
import { AlertCircle, CheckCircle2, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DONAR_ALL_COUNTRIES_GROUP_LABEL,
  DONAR_AMOUNT_CHIPS,
  DONAR_AMOUNT_CHIPS_US,
  DONAR_BACK_LABEL,
  DONAR_CHANGE_DOOR_LABEL,
  DONAR_COMPLETED_MESSAGE,
  DONAR_CONTINUE_LABEL,
  DONAR_DOMESTIC_DEPARTMENTS,
  DONAR_DOOR_EEUU_DESC,
  DONAR_DOOR_EEUU_LABEL,
  DONAR_DOOR_SV_DESC,
  DONAR_DOOR_SV_LABEL,
  DONAR_EDIT_LABEL,
  DONAR_FALLBACK_MESSAGE,
  DONAR_FOREIGN_COUNTRIES,
  DONAR_FREQUENT_COUNTRIES,
  DONAR_FREQUENT_COUNTRIES_GROUP_LABEL,
  DONAR_GIFT_TYPE_FIELD_LABEL,
  DONAR_GIFT_TYPE_LABEL,
  DONAR_HERO_PLACEHOLDER,
  DONAR_INTENT_PATH,
  DONAR_LANDING_HEADING,
  DONAR_LANDING_SUBTITLE,
  DONAR_LANDING_UNIFIER_LEAD,
  DONAR_POLL_INTERVAL_MS,
  DONAR_POLL_TIMEOUT_MS,
  DONAR_VERIFYING_NOTICE_DELAY_MS,
  DONAR_ROUTE_PARAM,
  DONAR_SCRIPT_TIMEOUT_MS,
  DONAR_STEP_COUNT_SV,
  DONAR_STEP_TITLE_DATOS,
  DONAR_STEP_TITLE_ENTREGA,
  DONAR_SUPPORT_EMAIL,
  DONAR_STEP_COUNT_US,
  DONAR_THANK_YOU_BODY,
  DONAR_THANK_YOU_TITLE,
  DONAR_WIDGET_DELAYED_MESSAGE,
  DONAR_WIDGET_FALLBACK_CTA,
  DONAR_WIDGET_LOADING_MESSAGE,
  DONAR_WIDGET_VERIFYING_MESSAGE,
  DONAR_WOMPI_CHECKOUT_ORIGIN,
  GIVEBUTTER_RENDER_TIMEOUT_MS,
  STRIPE_CANCELED_MESSAGE,
  STRIPE_CHECKOUT_PATH,
  STRIPE_FREQ_MONTHLY_LABEL,
  STRIPE_FREQ_ONCE_LABEL,
  STRIPE_GIFT_TYPE_LABEL,
  STRIPE_GIFT_TYPE_OFFERING_LABEL,
  STRIPE_GIFT_TYPE_TITHE_LABEL,
  STRIPE_MONTHLY_LABEL,
  DONATION_STEP1_FIELD_ORDER,
  DONATION_STEP2_FIELD_ORDER,
  clearDonationFieldErrors,
  donarAmountDisplay,
  donarLandingUnifierChurch,
  donarStepIndicator,
  donationAmountValidationMessage,
  donationIntentBody,
  donationStep1FieldErrors,
  donationStep2FieldErrors,
  firstDonationFieldError,
  doorFromSearch,
  givebutterEmbedUrl,
  givebutterHostedUrl,
  stripeCheckoutBody,
  stripeIntro,
  graciasDisplayFromSearch,
  isUsDonation,
  routeParamForDoor,
  widgetUrlFrom,
  type DonarDoor,
  type DonarGiftType,
  type DonationField,
  type DonationFieldErrors,
  type DonationFormInput,
  type DonorDocumentType,
  type StripeGiftType
} from "./donation";
import { StripeDonationForm, type StripeCheckoutClientConfig } from "./stripeDonationForm";
import { catalogOptionLabel, userFacingErrorMessage } from "./displayText";
import { brandingDonorLogoSrc, parseBrandingResponse } from "./branding";
import { ORG_LOGO_PATHS, ORG_LOGO_VIEW_BOX } from "../worker/services/orgLogo";
import { getCat008Districts, getCat013Municipalities, type CatalogOption } from "../shared/catalogs";
import { formatDui, isValidDui } from "../shared/dui";
import { formatNit, isValidNitFormat } from "../shared/nit";

// ─────────────────────────────────────────────────────────────────────────────
// The public donor-checkout views (/donar + /donar/gracias), extracted from
// App.tsx so the donor wizard owns its own module. Both routes render WITHOUT
// a session (App.tsx keeps only the thin path branch that mounts them).
//
// Layout: a step wizard with one concern per
// screen inside a soft-shadowed 16px card — skinned in the monochrome Gotham brand.
// SV door:  Paso 1 monto (segmented Diezmo|Ofrenda + hero amount input),
//           Paso 2 datos (documento + geografía), Paso 3 entrega (Wompi handoff).
// US door:  Paso 1 monto (segmented Única|Mensual + the same hero input),
//           Paso 2 Stripe's hosted Checkout embedded inside our page.
// ─────────────────────────────────────────────────────────────────────────────

// Unauthenticated fetch for the two public donation endpoints. Mirrors App's
// api() helper with an empty token (no Authorization header) and the same
// user-facing error mapping.
class DonarApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number
  ) {
    super(message);
    this.name = "DonarApiError";
  }
}

async function donarApi<T>(path: string, options: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers ?? {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = (await response.json().catch(() => ({}))) as { message?: unknown; error?: unknown };
  if (!response.ok) {
    throw new DonarApiError(
      userFacingErrorMessage(String(data.message ?? data.error ?? `HTTP ${response.status}`)),
      typeof data.error === "string" ? data.error : "",
      response.status
    );
  }
  return data as T;
}

// Donor-facing catalog select: no codes, Spanish placeholder, label above.
function DonarSelect({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  errorId,
  frequentOptions
}: {
  value: string;
  options: readonly CatalogOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  id?: string;
  // Present only while this field has an inline error: wires aria-invalid (red
  // border via CSS) + aria-describedby to the message paragraph.
  errorId?: string;
  // Optional "Frecuentes" optgroup above the full list (the país select): the
  // same codes stay in the full group too, as country selects conventionally do.
  frequentOptions?: readonly CatalogOption[];
}) {
  const selected = options.some((option) => option.code === value) ? value : "";
  const renderOptions = (list: readonly CatalogOption[], keyPrefix = "") =>
    list.map((option) => (
      <option key={`${keyPrefix}${option.code}-${option.label}`} value={option.code}>
        {catalogOptionLabel(option.label)}
      </option>
    ));
  return (
    <select
      id={id}
      value={selected}
      onChange={(event) => onChange(event.target.value)}
      aria-label={ariaLabel}
      aria-invalid={errorId ? true : undefined}
      aria-describedby={errorId}
    >
      <option value="">Seleccione</option>
      {frequentOptions?.length ? (
        <>
          <optgroup label={DONAR_FREQUENT_COUNTRIES_GROUP_LABEL}>{renderOptions(frequentOptions, "freq-")}</optgroup>
          <optgroup label={DONAR_ALL_COUNTRIES_GROUP_LABEL}>{renderOptions(options)}</optgroup>
        </>
      ) : (
        renderOptions(options)
      )}
    </select>
  );
}

// One donor-form control's inline error message. Rendered as a span (labels only
// allow phrasing content) directly under the field it names; role="alert" makes
// screen readers announce it when it appears.
function DonarFieldError({ field, errors }: { field: DonationField; errors: DonationFieldErrors }) {
  const message = errors[field];
  if (!message) {
    return null;
  }
  return (
    <span className="donar-field-error" id={donarFieldErrorId(field)} role="alert">
      {message}
    </span>
  );
}

// Stable DOM ids for focus-first-invalid and aria-describedby wiring.
function donarFieldDomId(field: DonationField): string {
  return `donar-field-${field}`;
}

function donarFieldErrorId(field: DonationField): string {
  return `${donarFieldDomId(field)}-error`;
}

// The aria-describedby target for a field, only while it carries an error.
function donarFieldErrorRef(field: DonationField, errors: DonationFieldErrors): string | undefined {
  return errors[field] ? donarFieldErrorId(field) : undefined;
}

// After a failed submit, move the donor to the first problem instead of leaving
// them at the CTA staring at nothing. rAF lets React paint the error state first.
function focusFirstInvalidField(errors: DonationFieldErrors, order: readonly DonationField[]) {
  const first = firstDonationFieldError(errors, order);
  if (!first) {
    return;
  }
  requestAnimationFrame(() => {
    const element = document.getElementById(donarFieldDomId(first));
    if (!element) {
      return;
    }
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

const emptyDonationForm: DonationFormInput = {
  amount: "",
  // Diezmo is preselected on mount: the SV Paso 1 segmented control lands checked,
  // so the "elija un tipo" validation is only ever a safety net. The donor can still
  // switch to Ofrenda. The U.S. door keeps its independent Stripe gift type state.
  giftType: "DIEZMO",
  donorDocumentType: "13",
  donorDocument: "",
  donorName: "",
  foreignResident: false,
  pais: "",
  departamento: "",
  municipio: "",
  distrito: ""
};

type DonarStage = "form" | "widget" | "thanks" | "closed";
type DonarStep = 1 | 2 | 3;

interface DonarIntent {
  intentId: string;
  urlEnlace: string;
  urlEnlaceLargo: string;
}

// The built-in default logo, reusing the vector paths shared with the worker's PDF
// renderer (src/worker/services/orgLogo.ts). Monochrome black on the donor landing.
export function OrganizationLogo({ organizationName }: { organizationName: string | null }) {
  return (
    <svg
      className="donar-logo"
      viewBox={`0 0 ${ORG_LOGO_VIEW_BOX.width} ${ORG_LOGO_VIEW_BOX.height}`}
      role="img"
      aria-label={organizationName ?? "Logo de la iglesia"}
      xmlns="http://www.w3.org/2000/svg"
    >
      {ORG_LOGO_PATHS.map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  );
}

// Home chooser artwork: preserve its original globe with the official SV flag
// overlapping at the lower-right. The secondary screen has its own component below.
function SvWorldIcon() {
  return (
    <svg
      className="donar-door-icon"
      viewBox="0 0 96 96"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g fill="none" stroke="#595959" strokeWidth="1.5">
        <circle cx="42" cy="38" r="30" />
        <ellipse cx="42" cy="38" rx="12" ry="30" />
        <ellipse cx="42" cy="38" rx="24" ry="30" />
        <line x1="12" y1="38" x2="72" y2="38" />
        <path d="M 17 23 Q 42 31 67 23" />
        <path d="M 17 53 Q 42 45 67 53" />
      </g>
      <clipPath id="sv-flag-circle">
        <circle cx="69" cy="69" r="25" />
      </clipPath>
      <circle cx="69" cy="69" r="28" fill="#ffffff" />
      <image
        href={svFlag}
        x="44"
        y="44"
        width="50"
        height="50"
        preserveAspectRatio="xMidYMid slice"
        clipPath="url(#sv-flag-circle)"
      />
    </svg>
  );
}

// SV secondary-header artwork: flag first/upper-left, globe lower-right, with a
// deliberate overlap. The globe paints first so the official flag stays on top.
function SvTitleWorldIcon() {
  return (
    <svg
      className="donar-title-world-icon"
      viewBox="0 0 140 88"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <g fill="none" stroke="#595959" strokeWidth="1.5">
        <circle cx="94" cy="34" r="24" />
        <ellipse cx="94" cy="34" rx="10" ry="24" />
        <ellipse cx="94" cy="34" rx="19" ry="24" />
        <line x1="70" y1="34" x2="118" y2="34" />
        <path d="M 74 22 Q 94 28 114 22" />
        <path d="M 74 46 Q 94 40 114 46" />
      </g>
      <clipPath id="sv-title-flag-circle">
        <circle cx="48" cy="34" r="32" />
      </clipPath>
      <circle cx="48" cy="34" r="34" fill="#ffffff" />
      <image
        href={svFlag}
        x="16"
        y="2"
        width="64"
        height="64"
        preserveAspectRatio="xMidYMid slice"
        clipPath="url(#sv-title-flag-circle)"
      />
    </svg>
  );
}

// Door 2 icon: the United States circle flag (HatScripts/circle-flags, MIT), inlined
// verbatim (self-hosted, no runtime fetch) so the previous hand-drawn flag's glitch
// is gone. aria-hidden: the door button's text label is the single accessible name.
// className is parameterized so the same artwork doubles as the small heading badge.
function UsFlagIcon({ className = "donar-door-icon" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 512 512"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      <mask id="us-flag-a">
        <circle cx="256" cy="256" r="256" fill="#fff" />
      </mask>
      <g mask="url(#us-flag-a)">
        <path fill="#eee" d="M256 0h256v64l-32 32 32 32v64l-32 32 32 32v64l-32 32 32 32v64l-256 32L0 448v-64l32-32-32-32v-64z" />
        <path fill="#d80027" d="M224 64h288v64H224Zm0 128h288v64H256ZM0 320h512v64H0Zm0 128h512v64H0Z" />
        <path fill="#0052b4" d="M0 0h256v256H0Z" />
        <path
          fill="#eee"
          d="m187 243 57-41h-70l57 41-22-67zm-81 0 57-41H93l57 41-22-67zm-81 0 57-41H12l57 41-22-67zm162-81 57-41h-70l57 41-22-67zm-81 0 57-41H93l57 41-22-67zm-81 0 57-41H12l57 41-22-67Zm162-82 57-41h-70l57 41-22-67Zm-81 0 57-41H93l57 41-22-67zm-81 0 57-41H12l57 41-22-67Z"
        />
      </g>
    </svg>
  );
}

// Inline circle-flag badge replacing the SV/US flag EMOJI in the landing unifier:
// flag emoji render as a blank box on platforms without flag
// glyphs (and as bare "SV"/"US" letters on Windows), which left an orphaned
// period on the landing. Decorative (aria-hidden) — the text carries the meaning.
function DonarFlagBadge({ country }: { country: "sv" | "us" }) {
  if (country === "us") {
    return <UsFlagIcon className="donar-flag" />;
  }
  return <img className="donar-flag" src={svFlag} alt="" aria-hidden="true" />;
}

// Clamp for the height Wompi's checkout reports via its sizeUpdate postMessage: a
// buggy or hostile frame must not collapse the embed or blow the layout open.
function clampEmbedHeight(height: number): number {
  return Math.min(Math.max(Math.round(height), 320), 2400);
}

// Official support contact for both lanes — a discreet mailto line at the bottom of
// every donor card, visually subordinate to the giving flow. The address is the church's
// configured branding supportEmail; DONAR_SUPPORT_EMAIL is the client-side default used
// until the fetched branding arrives (and if the fetch fails).
export function DonarSupport({ supportEmail = DONAR_SUPPORT_EMAIL }: { supportEmail?: string }) {
  return (
    <p className="donar-support">
      ¿Dudas o necesita ayuda? Escríbanos a <a href={`mailto:${supportEmail}`}>{supportEmail}</a>
    </p>
  );
}

// Public donation wizard + Wompi handoff / Stripe Embedded Checkout. Renders without an app session.
export function DonarPage() {
  const [form, setForm] = useState<DonationFormInput>(emptyDonationForm);
  // Server/global failures only (intent POST errors, the closed state). Field
  // validation lives in fieldErrors: every invalid control at once, each message
  // under its own field, cleared the moment that field changes.
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<DonationFieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [stage, setStage] = useState<DonarStage>("form");
  const [step, setStep] = useState<DonarStep>(1);
  const [intent, setIntent] = useState<DonarIntent | null>(null);
  // The two-door chooser: /donar opens on a landing where the donor picks where
  // the gift goes (SV/mundo vs EE. UU.) before any form appears. Preseeded from
  // ?ruta=sv / ?ruta=eeuu; null keeps the donor on the chooser. Door "eeuu" opens
  // the Stripe wizard directly, skipping the extranjero mechanics.
  const [door, setDoor] = useState<DonarDoor | null>(() => doorFromSearch(window.location.search));
  // White-label logo for the landing chooser. When a church has uploaded a logo the
  // donor page shows it in place of the built-in vector logo; the vector stays as the
  // fallback. The accent color is deliberately NOT applied here — the donor wizard's
  // monochrome Gotham brand is a design decision, so only the logo is branded.
  const [brandingLogo, setBrandingLogo] = useState<{ src: string; name: string } | null>(null);
  // Donor-facing organization copy must come from the public branding response.
  // Keep it neutral until a valid configured name arrives instead of exposing the
  // admin client's historical build placeholder on the public donation page.
  const [organizationName, setOrganizationName] = useState<string | null>(null);
  // The church's configured support contact, shown by DonarSupport at the bottom of every
  // donor card. Seeded with the client-side default so the line renders before (and if)
  // the /api/branding fetch resolves; replaced with the configured value when it does.
  const [supportEmail, setSupportEmail] = useState(DONAR_SUPPORT_EMAIL);
  // US-donor (Stripe) path state: gift type + frequency (stacked segmented
  // control), the stable identifier for one amount/frequency/gift-type attempt, and the
  // promise that initializes Stripe Embedded Checkout inside Paso 2.
  const [monthly, setMonthly] = useState(false);
  const [stripeGiftType, setStripeGiftType] = useState<StripeGiftType>("TITHE");
  const [usProvider, setUsProvider] = useState<"stripe" | "givebutter">("stripe");
  const [givebutterFrameStatus, setGivebutterFrameStatus] = useState<"loading" | "ready" | "delayed">("loading");
  const stripeAttemptRef = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const [stripeSessionAttempt, setStripeSessionAttempt] = useState<{
    fingerprint: string;
    sequence: number;
    session: Promise<StripeCheckoutClientConfig>;
  } | null>(null);
  const stripeSessionSequenceRef = useRef(0);
  const stripeRejectedSessionSequenceRef = useRef<number | null>(null);
  // Paso 3 widget lifecycle: "loading" from entry until Wompi renders its button
  // (spinner), "ready" once it has, "delayed" when the render budget elapses first
  // (manual hosted-checkout CTA appears; the poll keeps watching, so a late widget
  // still flips to "ready").
  const [handoff, setHandoff] = useState<"loading" | "ready" | "delayed" | "verifying">("loading");
  // Height reported by Wompi's checkout via sizeUpdate; null keeps the CSS fallback
  // (min(78vh, 820px)) until the first message. Tablet/desktop can then track the full
  // content height; mobile CSS caps the frame and keeps Wompi's own scrolling available.
  const [embedHeight, setEmbedHeight] = useState<number | null>(null);
  // Explicit focus targets: the hero amount input after a quick-fill and the
  // summary's Editar control on an embedded handoff step.
  const heroInputRef = useRef<HTMLInputElement | null>(null);
  const summaryEditRef = useRef<HTMLButtonElement | null>(null);

  // When to render the Stripe wizard instead of the SV fiscal steps: the EE.
  // UU. door, OR the país=US safety net on the SV form (harmless belt-and-braces).
  // "← Cambiar opción" is the only way back — the donor deliberately chose the door.
  const usDonation = door === "eeuu" || isUsDonation(form);
  const stripeCanceled = usDonation && new URLSearchParams(window.location.search).get("cancelado") === "1";
  const stepCount = usDonation ? DONAR_STEP_COUNT_US : DONAR_STEP_COUNT_SV;
  const displayStep = usDonation && step > DONAR_STEP_COUNT_US ? DONAR_STEP_COUNT_US : step;
  // The Paso 3 (and US handoff) summary label: what the donor chose on Paso 1.
  const summaryLabel = usDonation
    ? stripeGiftType === "TITHE" ? STRIPE_GIFT_TYPE_TITHE_LABEL : STRIPE_GIFT_TYPE_OFFERING_LABEL
    : form.giftType
      ? DONAR_GIFT_TYPE_LABEL[form.giftType]
      : "";
  const frequencyLabel = monthly ? STRIPE_FREQ_MONTHLY_LABEL : STRIPE_FREQ_ONCE_LABEL;
  const givebutterFrameUrl = givebutterEmbedUrl({ amount: form.amount, monthly });

  // Choose a door: record it in ?ruta (composing with — never clobbering — any
  // existing query) so a refresh keeps the door, then swap the view. null returns
  // to the chooser.
  const chooseDoor = (next: DonarDoor | null) => {
    const params = new URLSearchParams(window.location.search);
    params.delete("cancelado");
    const route = routeParamForDoor(next);
    if (route) {
      params.set(DONAR_ROUTE_PARAM, route);
    } else {
      params.delete(DONAR_ROUTE_PARAM);
    }
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    // Leaving a door resets the wizard chrome so each entry is clean. The typed form
    // values survive on purpose — going back must never lose the donor's data — with
    // ONE exception: the extranjero+país pair is cleared, because leftover
    // foreignResident+US state would re-forward an explicit SV-door choice to the
    // Stripe path forever.
    setForm((current) => ({ ...current, foreignResident: false, pais: "" }));
    setMonthly(false);
    setStripeGiftType("TITHE");
    setUsProvider("stripe");
    stripeAttemptRef.current = null;
    setStripeSessionAttempt(null);
    setStep(1);
    setError("");
    setFieldErrors({});
    setIntent(null);
    setStage("form");
    setDoor(next);
  };

  // Every form write also clears the inline errors that edit can affect (reward
  // early: the message disappears as soon as the donor acts on it; re-validation
  // happens on the next submit). editedFields narrows the clearing when a patch
  // bundles mechanical resets the donor did not type (the departamento cascade).
  const update = (patch: Partial<DonationFormInput>, editedFields?: readonly (keyof DonationFormInput)[]) => {
    setForm((current) => ({ ...current, ...patch }));
    setFieldErrors((current) =>
      clearDonationFieldErrors(current, editedFields ?? (Object.keys(patch) as (keyof DonationFormInput)[]))
    );
  };

  // Changing departamento resets the dependent selects. Only the departamento was
  // EDITED: the children's "Seleccione…" errors stay (still true of the reset
  // values) and keep walking the donor down the cascade.
  const setDepartamento = (departamento: string) => update({ departamento, municipio: "", distrito: "" }, ["departamento"]);

  const municipalityOptions = getCat013Municipalities(form.departamento);
  const districtOptions = getCat008Districts(form.departamento);

  // Every newly rendered donor view starts at the top instead of inheriting the
  // scroll used to reach the previous step's CTA. Reassert on the next frame for
  // mobile Safari, which can settle its visual viewport after the DOM commit.
  // Later-step focus remains, but preventScroll keeps it from undoing the reset.
  useLayoutEffect(() => {
    const resetScroll = () => window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    resetScroll();

    // Paso 1 deliberately leaves focus untouched so opening the donation flow
    // does not summon a mobile keyboard. The SV Paso 2 select stays unfocused too:
    // mobile browsers may open its native picker on programmatic focus.
    if (door !== null && step !== 1 && (step !== 2 || usDonation)) {
      summaryEditRef.current?.focus({ preventScroll: true });
    }

    const resetFrame = requestAnimationFrame(resetScroll);
    return () => cancelAnimationFrame(resetFrame);
  }, [door, stage, step, usDonation]);

  // Fetch the church's branding for the landing logo (name is used as alt text). Uses
  // the same unauthenticated /api/branding as the admin; a failure keeps the built-in vector.
  useEffect(() => {
    let cancelled = false;
    void donarApi<unknown>("/api/branding")
      .then(async (data) => {
        if (cancelled) return;
        const brandingRecord = data && typeof data === "object" ? (data as Record<string, unknown>) : {};
        const configuredName =
          typeof brandingRecord.displayName === "string" && brandingRecord.displayName.trim()
            ? brandingRecord.displayName.trim()
            : null;
        const branding = parseBrandingResponse(data);
        const src = brandingDonorLogoSrc(branding.donorLogoVersion);
        // Decode BEFORE committing to state. Swapping the built-in vector for an <img>
        // that has not been fetched yet paints an empty box and reflows when it lands;
        // decoding first means the swap is a single already-painted frame. A decode
        // failure just falls through and keeps the vector.
        let decodedLogo: { src: string; name: string } | null = null;
        if (src) {
          const image = new Image();
          image.src = src;
          try {
            await image.decode();
            decodedLogo = { src, name: configuredName ?? "Logo de la iglesia" };
          } catch {
            decodedLogo = null;
          }
        }
        if (cancelled) return;
        setBrandingLogo(decodedLogo);
        setOrganizationName(configuredName);
        setSupportEmail(branding.supportEmail);
      })
      .catch(() => {
        // Keep the built-in vector and neutral organization wording.
      })
      .finally(() => {
        // Success, failure, or a malformed payload — the branded form is now final, so
        // the cold-load reveal in main.tsx can stop waiting on us.
        markDonorBrandingSettled();
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Warm DNS + TLS to Wompi's checkout host once the donor commits to the SV/Wompi
  // path, so the Paso 3 embed skips connection setup (a few hundred ms on mobile
  // networks). The chooser and the EE. UU./Stripe path must not disclose
  // third-party network metadata to Wompi before that flow is actually chosen.
  useEffect(() => {
    if (door !== "sv" || usDonation) {
      return;
    }
    if (document.querySelector(`link[rel="preconnect"][href="${DONAR_WOMPI_CHECKOUT_ORIGIN}"]`)) {
      return;
    }
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = DONAR_WOMPI_CHECKOUT_ORIGIN;
    document.head.appendChild(link);
  }, [door, usDonation]);

  // Givebutter's embed is mounted only after the donor explicitly selects it. A
  // slow frame exposes the same hosted-page escape hatch as the production form;
  // switching back to Stripe cancels this timer and removes the iframe entirely.
  useEffect(() => {
    if (!usDonation || step !== 2 || usProvider !== "givebutter") {
      return;
    }
    let cancelled = false;
    setGivebutterFrameStatus("loading");
    const timeout = window.setTimeout(() => {
      if (!cancelled) {
        setGivebutterFrameStatus((status) => status === "ready" ? status : "delayed");
      }
    }, GIVEBUTTER_RENDER_TIMEOUT_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [givebutterFrameUrl, step, usDonation, usProvider]);

  // Listen for the thank-you page's postMessage (fired when it runs inside the
  // widget iframe modal) so we can swap to the thank-you state directly.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // The gracias page inside the modal iframe is same-origin. Reject any other
      // origin so the Wompi widget iframe (or anything it embeds) cannot spoof the
      // thank-you state without a payment.
      if (event.origin !== window.location.origin) {
        return;
      }
      if (event.data === DONAR_COMPLETED_MESSAGE) {
        setStage("thanks");
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Once an intent exists, Paso 3 embeds the checkout directly (iframe below). This
  // effect only drives the waiting UI: spinner from entry, and if the iframe has not
  // fired onLoad within the render budget, the manual hosted-checkout CTA appears —
  // never a redirect. The iframe keeps loading underneath; its onLoad flips a
  // loading/delayed handoff to "ready" whenever it lands, but cannot cancel a
  // Wompi-close verification already in progress.
  useEffect(() => {
    if (stage !== "widget" || !intent) {
      return;
    }
    setHandoff("loading");
    setEmbedHeight(null);
    const slow = window.setTimeout(() => {
      setHandoff((current) => (current === "loading" ? "delayed" : current));
    }, DONAR_SCRIPT_TIMEOUT_MS);
    return () => {
      window.clearTimeout(slow);
    };
  }, [stage, intent]);

  // Wompi's checkout posts JSON messages to its parent — the same channel its own
  // modal widget consumes: { message: "sizeUpdate", height } as the content grows
  // (their widget renders it as height + 35), and { message: "close" } when the donor
  // taps the checkout's back arrow OR its post-payment "Cerrar". Origin-checked strictly;
  // anything unparseable is ignored. "close" starts a neutral verification state and
  // preserves the intent so a delayed webhook can still move the donor to thanks.
  useEffect(() => {
    if (stage !== "widget" || !intent) {
      return;
    }
    // Capture the non-null intent so the close handler's deferred fetch keeps a stable,
    // narrowed reference (the effect re-runs whenever intent changes).
    const activeIntent = intent;
    function onWompiMessage(event: MessageEvent) {
      if (event.origin !== DONAR_WOMPI_CHECKOUT_ORIGIN) {
        return;
      }
      let payload: { message?: unknown; height?: unknown };
      try {
        payload = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (payload?.message === "sizeUpdate" && typeof payload.height === "number") {
        setEmbedHeight(clampEmbedHeight(payload.height + 35));
        return;
      }
      if (payload?.message === "close") {
        // Wompi posts { message: "close" } from BOTH its back arrow AND its post-payment
        // "Cerrar" button. Never infer "unpaid" from an early response or a transient
        // fetch failure: hide the checkout, retain the intent, and let the status poll
        // observe Wompi's webhook. The page's own Atrás remains the explicit way back.
        setHandoff("verifying");
        const statusPath = `${DONAR_INTENT_PATH}/${activeIntent.intentId}/status`;
        void donarApi<{ status: string; paid: boolean }>(statusPath)
          .then((result) => {
            if (result.paid || result.status === "COMPLETED") {
              setStage("thanks");
            }
          })
          .catch(() => {
            // Keep polling: one failed read must not reopen the form and invite a
            // duplicate donation after Wompi has already accepted the card.
          });
      }
    }
    window.addEventListener("message", onWompiMessage);
    return () => window.removeEventListener("message", onWompiMessage);
  }, [stage, intent]);

  // "verifying" is entered at Wompi's "close", which fires at the 3DS hand-off — long
  // before the donor has paid. Arm the notice on a delay rather than showing it then:
  // a donor who completes normally reaches thanks first and never sees it, while an
  // entrega that really is stuck still gets reassurance. Disarmed whenever the state
  // leaves "verifying" so a reopened checkout never inherits a stale timer.
  const [verifyingNoticeVisible, setVerifyingNoticeVisible] = useState(false);
  useEffect(() => {
    if (handoff !== "verifying") {
      setVerifyingNoticeVisible(false);
      return;
    }
    const notice = window.setTimeout(() => setVerifyingNoticeVisible(true), DONAR_VERIFYING_NOTICE_DELAY_MS);
    return () => {
      window.clearTimeout(notice);
    };
  }, [handoff]);

  // Poll the intent status while the embedded checkout is open; COMPLETED -> thank-you.
  // Stop after ~3 minutes with a neutral closing message. Entering the post-close
  // verification state restarts that window so a slow checkout never shortens the
  // webhook grace period.
  const verifyingWompiClose = handoff === "verifying";
  useEffect(() => {
    if (stage !== "widget" || !intent) {
      return;
    }
    let cancelled = false;
    const deadline = Date.now() + DONAR_POLL_TIMEOUT_MS;
    const timer = window.setInterval(async () => {
      if (cancelled) {
        return;
      }
      if (Date.now() >= deadline) {
        window.clearInterval(timer);
        if (!cancelled) {
          setStage("closed");
        }
        return;
      }
      try {
        const result = await donarApi<{ status: string; paid: boolean }>(`${DONAR_INTENT_PATH}/${intent.intentId}/status`);
        // The donor's "thanks" keys on PAYMENT (result.paid, stamped by Wompi's webhook)
        // — not on MH acceptance. COMPLETED is kept as the legacy signal so an intent that
        // was accepted before the poll observed the payment still lands on thanks.
        if (!cancelled && (result.paid || result.status === "COMPLETED")) {
          window.clearInterval(timer);
          setStage("thanks");
        }
      } catch {
        // Transient poll errors are ignored; the deadline still ends polling.
      }
    }, DONAR_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [stage, intent, verifyingWompiClose]);

  // Paso 1 → Paso 2. The SV and U.S. doors both gate on amount; U.S. gift type
  // is always an explicit state choice and travels in the Stripe request.
  function continueFromMonto(event: FormEvent) {
    event.preventDefault();
    const amountMessage = donationAmountValidationMessage(form.amount);
    const errors: DonationFieldErrors = usDonation
      ? amountMessage
        ? { amount: amountMessage }
        : {}
      : donationStep1FieldErrors(form);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      focusFirstInvalidField(errors, DONATION_STEP1_FIELD_ORDER);
      return;
    }
    setFieldErrors({});
    setError("");
    if (usDonation) {
      const fingerprint = stripeFingerprint();
      if (stripeSessionAttempt?.fingerprint !== fingerprint) {
        setStripeSessionAttempt(createStripeSessionAttempt());
      }
    }
    setStep(2);
  }

  async function continueToPago(event: FormEvent) {
    event.preventDefault();
    const errors = donationStep2FieldErrors(form);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      focusFirstInvalidField(errors, DONATION_STEP2_FIELD_ORDER);
      return;
    }
    setFieldErrors({});
    setError("");
    setSubmitting(true);
    try {
      const created = await donarApi<DonarIntent>(DONAR_INTENT_PATH, {
        method: "POST",
        body: donationIntentBody(form)
      });
      setHandoff("loading");
      setIntent(created);
      setStage("widget");
      setStep(3);
    } catch (err) {
      setError(userFacingErrorMessage(err instanceof Error ? err.message : String(err)));
    } finally {
      setSubmitting(false);
    }
  }

  // Initialize Stripe's hosted embedded form. The request identifier remains
  // stable across transport retries for the same amount/frequency/gift-type fingerprint;
  // only server-proven terminal unavailability clears it. An indeterminate
  // Session keeps the original identity so no fresh provider request can escape.
  function stripeFingerprint(): string {
    const amountCents = Math.round(Number.parseFloat(form.amount.trim()) * 100);
    return `${monthly ? "monthly" : "once"}:${stripeGiftType.toLowerCase()}:${amountCents}`;
  }

  function createStripeSessionAttempt() {
    const fingerprint = stripeFingerprint();
    let attempt = stripeAttemptRef.current;
    if (!attempt || attempt.fingerprint !== fingerprint) {
      attempt = { fingerprint, requestId: crypto.randomUUID() };
      stripeAttemptRef.current = attempt;
    }
    const ownedAttempt = attempt;
    const requestId = ownedAttempt.requestId;
    stripeSessionSequenceRef.current += 1;
    const sequence = stripeSessionSequenceRef.current;
    const session = donarApi<StripeCheckoutClientConfig>(STRIPE_CHECKOUT_PATH, {
        method: "POST",
        body: stripeCheckoutBody({ requestId, amount: form.amount, monthly, giftType: stripeGiftType })
      }).catch((err: unknown) => {
        stripeRejectedSessionSequenceRef.current = sequence;
        if (
          err instanceof DonarApiError
          && err.status === 409
          && err.code === "stripe_checkout_unavailable"
          && stripeAttemptRef.current?.requestId === ownedAttempt.requestId
          && stripeAttemptRef.current.fingerprint === ownedAttempt.fingerprint
        ) {
          stripeAttemptRef.current = null;
        }
        throw new Error(userFacingErrorMessage(err instanceof Error ? err.message : String(err)));
      });
    return {
      fingerprint,
      sequence,
      session
    };
  }

  function retryStripeSession() {
    setStripeSessionAttempt(createStripeSessionAttempt());
  }

  // "← Atrás": one step back. Leaving Paso 3 abandons the created intent (a new
  // one is created on the next entry) and unmounts the widget cleanly.
  function goBack() {
    setError("");
    // Inline errors belong to a submit attempt on the screen being left.
    setFieldErrors({});
    if (step === 3) {
      setIntent(null);
      setStage("form");
      setStep(2);
      return;
    }
    // Form-driven Stripe takeover (SV door + extranjero USA): Atrás returns to the
    // SV datos screen where the choice was made — clearing the país drops usDonation,
    // so this same step re-renders as the SV Paso 2 with every dato intact and the
    // extranjero checkbox still set. Without this, Atrás only walked the US steps and
    // the donor could never reach the SV form again.
    if (door === "sv" && usDonation) {
      setMonthly(false);
      setUsProvider("stripe");
      update({ pais: "" });
      return;
    }
    setUsProvider("stripe");
    setStep(1);
  }

  // The summary's "Editar": straight back to Paso 1. A U.S. Stripe attempt is kept
  // until a changed fingerprint replaces it.
  function editAmount() {
    setError("");
    setFieldErrors({});
    setIntent(null);
    if (!usDonation) {
      stripeAttemptRef.current = null;
      setStripeSessionAttempt(null);
    } else if (stripeSessionAttempt?.sequence === stripeRejectedSessionSequenceRef.current) {
      stripeRejectedSessionSequenceRef.current = null;
      setStripeSessionAttempt(null);
    }
    setStage("form");
    setUsProvider("stripe");
    setStep(1);
  }

  if (stage === "thanks") {
    return <DonarThankYou monto={form.amount.trim()} supportEmail={supportEmail} />;
  }

  // The chooser is the first sight of /donar: no door picked yet and no payment
  // handoff in progress. Once a door is chosen the matching wizard renders.
  if (door === null) {
    return (
      <div className="donar-screen">
        <div className="donar-card card donar-landing">
          {brandingLogo ? (
            <img className="donar-logo" src={brandingLogo.src} alt={brandingLogo.name} />
          ) : (
            <OrganizationLogo organizationName={organizationName} />
          )}
          <h1>{DONAR_LANDING_HEADING}</h1>
          {/* Unifying line: both doors fund the same mother church in El Salvador —
              they differ by residence / payment rail / tax receipt, not beneficiary.
              The flag is an inline SVG badge (the flag emoji rendered as a blank
              box, leaving an orphaned period). */}
          <p className="donar-landing-unifier">
            <span>{DONAR_LANDING_UNIFIER_LEAD}</span>{" "}
            <span className="donar-landing-unifier-church">{donarLandingUnifierChurch(organizationName)} <DonarFlagBadge country="sv" />.</span>
          </p>
          <p className="donar-landing-subtitle">{DONAR_LANDING_SUBTITLE}</p>
          <div className="donar-doors">
            <button type="button" className="donar-door" onClick={() => chooseDoor("sv")}>
              <SvWorldIcon />
              <span className="donar-door-label">{DONAR_DOOR_SV_LABEL}</span>
              <span className="donar-door-desc">{DONAR_DOOR_SV_DESC}</span>
            </button>
            <button type="button" className="donar-door" onClick={() => chooseDoor("eeuu")}>
              <UsFlagIcon />
              <span className="donar-door-label">{DONAR_DOOR_EEUU_LABEL}</span>
              <span className="donar-door-desc">{DONAR_DOOR_EEUU_DESC}</span>
            </button>
          </div>
          <DonarSupport supportEmail={supportEmail} />
        </div>
      </div>
    );
  }

  const summary = (
    <div className="donar-summary">
      <span className="donar-summary-line">
        {usDonation
          ? `${summaryLabel} · ${frequencyLabel} · ${donarAmountDisplay(form.amount)}`
          : `${summaryLabel} · ${donarAmountDisplay(form.amount)}`}
      </span>
      <button ref={summaryEditRef} type="button" className="donar-summary-edit" onClick={editAmount}>
        {DONAR_EDIT_LABEL}
      </button>
    </div>
  );

  return (
    <div className="donar-screen">
      <div className="donar-card card">
        {/* Wizard chrome: back affordance left ("← Cambiar opción" only on Paso 1,
            "← Atrás" afterwards), minimal "Paso n de m" indicator right. */}
        <div className="donar-card-top">
          {step === 1 ? (
            <button type="button" className="donar-change-door" onClick={() => chooseDoor(null)}>
              {DONAR_CHANGE_DOOR_LABEL}
            </button>
          ) : (
            <button type="button" className="donar-change-door" onClick={goBack}>
              {DONAR_BACK_LABEL}
            </button>
          )}
          <p className="donar-step-indicator">{donarStepIndicator(displayStep, stepCount)}</p>
        </div>

        {/* The ceremonial header is identical on every step — centered shield,
            big brand title. The SV lane reuses the chooser's globe + flag artwork;
            the US lane keeps its inline SVG flag badge (emoji render as a blank
            box or bare "SV"/"US" letters on platforms without flag glyphs).
            Working steps add a small caps-tracked step label UNDER the title for
            orientation; a brand-demoting compact header was tried and read as a
            regression (the brand looked like a fake subtitle of the step). */}
        <div className="donar-glyph">
          <ShieldCheck size={28} />
        </div>
        <h1 className="donar-wizard-title">
          <span>{DONAR_LANDING_HEADING}</span>
          {usDonation ? <UsFlagIcon className="donar-title-lane-flag" /> : <SvTitleWorldIcon />}
        </h1>
        {step > 1 && (
          <p className="donar-step-label">
            {step === 2 && !usDonation ? DONAR_STEP_TITLE_DATOS : DONAR_STEP_TITLE_ENTREGA}
          </p>
        )}

        {/* Paso 1 assurance: right under the heading, name the legal document this
            door produces — reassurance of the door the donor just chose. */}
        {step === 1 && (
          <p className="donar-assurance">
            {usDonation
              ? "Recibirá un recibo oficial deducible de impuestos (IRS 501c3) en su dirección de correo electrónico."
              : "Recibirá por correo electrónico un comprobante de donación oficial (DTE), con validez fiscal únicamente en El Salvador."}
          </p>
        )}

        {/* Paso 1 — Monto. Shared by both doors: a segmented control on top
            (Diezmo|Ofrenda on the SV door, Única|Mensual on the US door), the
            hero amount input as the screen's primary element, and the preset
            quick-fill pills underneath. */}
        {step === 1 && (
          <form className="donar-form donar-step" onSubmit={continueFromMonto}>
            {usDonation ? (
              <>
                <div className="donar-segment" role="radiogroup" aria-label={STRIPE_GIFT_TYPE_LABEL}>
                  <label className={stripeGiftType === "TITHE" ? "donar-segment-option active" : "donar-segment-option"}>
                    <input type="radio" name="stripe-gift-type" value="tithe" checked={stripeGiftType === "TITHE"} onChange={() => setStripeGiftType("TITHE")} />
                    <span>{STRIPE_GIFT_TYPE_TITHE_LABEL}</span>
                  </label>
                  <label className={stripeGiftType === "OFFERING" ? "donar-segment-option active" : "donar-segment-option"}>
                    <input type="radio" name="stripe-gift-type" value="offering" checked={stripeGiftType === "OFFERING"} onChange={() => setStripeGiftType("OFFERING")} />
                    <span>{STRIPE_GIFT_TYPE_OFFERING_LABEL}</span>
                  </label>
                </div>
                <div className="donar-segment" role="radiogroup" aria-label={STRIPE_MONTHLY_LABEL}>
                <label className={monthly ? "donar-segment-option" : "donar-segment-option active"}>
                  <input type="radio" name="donar-frequency" value="once" checked={!monthly} onChange={() => setMonthly(false)} />
                  <span>{STRIPE_FREQ_ONCE_LABEL}</span>
                </label>
                <label className={monthly ? "donar-segment-option active" : "donar-segment-option"}>
                  <input type="radio" name="donar-frequency" value="monthly" checked={monthly} onChange={() => setMonthly(true)} />
                  <span>{STRIPE_FREQ_MONTHLY_LABEL}</span>
                </label>
                </div>
                {monthly && <p className="donar-stripe-monthly-note">Su entrega se realizará cada mes hasta que usted la cancele.</p>}
              </>
            ) : (
              <div
                className="donar-segment"
                role="radiogroup"
                aria-label={DONAR_GIFT_TYPE_FIELD_LABEL}
                aria-invalid={fieldErrors.giftType ? true : undefined}
                aria-describedby={donarFieldErrorRef("giftType", fieldErrors)}
              >
                {(["DIEZMO", "OFRENDA"] as DonarGiftType[]).map((option, index) => (
                  <label key={option} className={form.giftType === option ? "donar-segment-option active" : "donar-segment-option"}>
                    <input
                      type="radio"
                      name="donar-gift-type"
                      id={index === 0 ? donarFieldDomId("giftType") : undefined}
                      value={option}
                      checked={form.giftType === option}
                      onChange={() => update({ giftType: option })}
                    />
                    <span>{DONAR_GIFT_TYPE_LABEL[option]}</span>
                  </label>
                ))}
              </div>
            )}
            <DonarFieldError field="giftType" errors={fieldErrors} />

            {/* THE HERO: the amount IS this screen. Giant Gotham numerals with a
                quiet "$" prefix; most tithes are personal amounts, so typing is
                the primary path and the chips below are quick-fills into it. */}
            <div className="donar-hero-amount">
              <span className="donar-hero-currency" aria-hidden="true">
                $
              </span>
              <input
                ref={heroInputRef}
                id={donarFieldDomId("amount")}
                value={form.amount}
                onChange={(event) => {
                  const amount = event.target.value;
                  if (/^[0-9]*(?:\.[0-9]{0,2})?$/.test(amount)) {
                    update({ amount });
                  }
                }}
                placeholder={DONAR_HERO_PLACEHOLDER}
                aria-label="Monto"
                aria-invalid={fieldErrors.amount ? true : undefined}
                aria-describedby={donarFieldErrorRef("amount", fieldErrors)}
                inputMode="decimal"
                autoComplete="off"
                size={Math.min(Math.max(form.amount.length, DONAR_HERO_PLACEHOLDER.length), 10)}
              />
            </div>

            <div className="donar-chips">
              {/* The US door keeps accessible, round anchors for either frequency. */}
              {(usDonation ? DONAR_AMOUNT_CHIPS_US : DONAR_AMOUNT_CHIPS).map((chip) => (
                <button
                  key={chip}
                  type="button"
                  className={form.amount === chip.toFixed(2) ? "donar-chip active" : "donar-chip"}
                  onClick={() => {
                    update({ amount: chip.toFixed(2) });
                    // The chip fills the hero input; the donor can keep typing.
                    heroInputRef.current?.focus();
                  }}
                >
                  ${chip}
                </button>
              ))}
            </div>
            <DonarFieldError field="amount" errors={fieldErrors} />

            {step === 1 && stripeCanceled && (
              <p className="auth-notice" role="status">{STRIPE_CANCELED_MESSAGE}</p>
            )}

            {error && (
              <p className="error donar-error" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
                {error}
              </p>
            )}
            <button className="primary" type="submit">
              {usDonation ? stripeGiftType === "TITHE" ? "Continuar con su diezmo" : "Continuar con su ofrenda" : DONAR_CONTINUE_LABEL}
            </button>
          </form>
        )}

        {/* Paso 2 — Sus datos (SV door only). Documento + dirección, roomy single
            column. Entering Paso 3 creates the payment intent, so the submit
            label names the chosen gift ("Continuar con su diezmo/ofrenda"). */}
        {step === 2 && !usDonation && (
          <form className="donar-form donar-step" onSubmit={continueToPago}>
            <p className="donar-intro">Complete sus datos para generar su comprobante de donación (CDE).</p>
            <p className="donar-note">Su nombre, correo, teléfono y dirección se ingresan al completar su entrega con Wompi.</p>

            <div className="donar-doc-row">
              <label>
                <span>Tipo de documento</span>
                <select
                  value={form.donorDocumentType}
                  onChange={(event) => update({ donorDocumentType: event.target.value as DonorDocumentType, donorDocument: "", donorName: "" })}
                  aria-label="Tipo de documento"
                >
                  {/* CAT-022 "36" is labeled "Empresa" (donor-facing only; stored
                      code stays 36): many natural persons hold legacy personal
                      NITs and a literal "NIT" option would bait them into the
                      razón-social requirement. Empresas donate under NIT. */}
                  <option value="13">DUI</option>
                  <option value="36">Empresa</option>
                  <option value="37">Otro</option>
                  <option value="03">Pasaporte</option>
                  <option value="02">Carnet de Residente</option>
                </select>
              </label>
              <label>
                <span>{form.donorDocumentType === "36" ? "NIT de la empresa" : "Número de documento"}</span>
                <input
                  id={donarFieldDomId("donorDocument")}
                  value={form.donorDocument}
                  onChange={(event) => update({ donorDocument: event.target.value })}
                  onBlur={() => {
                    if (form.donorDocumentType === "13" && isValidDui(form.donorDocument)) {
                      update({ donorDocument: formatDui(form.donorDocument) });
                    }
                    if (form.donorDocumentType === "36" && isValidNitFormat(form.donorDocument)) {
                      update({ donorDocument: formatNit(form.donorDocument) });
                    }
                  }}
                  placeholder={form.donorDocumentType === "13" ? "00000000-0" : form.donorDocumentType === "36" ? "0000-000000-000-0" : "Documento"}
                  inputMode={form.donorDocumentType === "13" ? "numeric" : undefined}
                  aria-label={form.donorDocumentType === "36" ? "NIT de la empresa" : "Número de documento"}
                  aria-invalid={fieldErrors.donorDocument ? true : undefined}
                  aria-describedby={donarFieldErrorRef("donorDocument", fieldErrors)}
                />
                <DonarFieldError field="donorDocument" errors={fieldErrors} />
              </label>
            </div>

            {form.donorDocumentType === "36" && (
              <label>
                <span>Razón social</span>
                <input
                  id={donarFieldDomId("donorName")}
                  value={form.donorName}
                  onChange={(event) => update({ donorName: event.target.value })}
                  placeholder="Nombre legal de la empresa"
                  aria-label="Razón social"
                  aria-invalid={fieldErrors.donorName ? true : undefined}
                  aria-describedby={donarFieldErrorRef("donorName", fieldErrors)}
                />
                <DonarFieldError field="donorName" errors={fieldErrors} />
              </label>
            )}

            {/* The extranjero toggle + geography only belong to the SV/mundo door.
                The EE. UU. door (usDonation) never reaches this step's fields. */}
            <label className="donar-foreign-toggle">
              <input
                type="checkbox"
                checked={form.foreignResident}
                onChange={(event) => {
                  setMonthly(false);
                  update({ foreignResident: event.target.checked, departamento: "", municipio: "", distrito: "", pais: "" });
                }}
                aria-label="Resido en el extranjero"
              />
              <span>Resido en el extranjero</span>
            </label>

            {form.foreignResident ? (
              <label>
                <span>País</span>
                <DonarSelect
                  value={form.pais}
                  options={DONAR_FOREIGN_COUNTRIES}
                  frequentOptions={DONAR_FREQUENT_COUNTRIES}
                  onChange={(pais) => {
                    // Estados Unidos is a safety correction, not implicit consent to a
                    // processor switch. Restart at explicit U.S. Paso 1, preserve the
                    // donor's truthful amount/type choice, and mint no Stripe Session
                    // until that step is confirmed.
                    setMonthly(false);
                    if (pais === "US") {
                      const params = new URLSearchParams(window.location.search);
                      params.delete("cancelado");
                      params.set(DONAR_ROUTE_PARAM, "eeuu");
                      window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
                      setStripeGiftType(form.giftType === "OFRENDA" ? "OFFERING" : "TITHE");
                      setUsProvider("stripe");
                      stripeAttemptRef.current = null;
                      setStripeSessionAttempt(null);
                      update({ foreignResident: false, pais: "" });
                      setStep(1);
                      setError("");
                      setFieldErrors({});
                      setDoor("eeuu");
                      return;
                    }
                    update({ pais });
                  }}
                  ariaLabel="País"
                  id={donarFieldDomId("pais")}
                  errorId={donarFieldErrorRef("pais", fieldErrors)}
                />
                <DonarFieldError field="pais" errors={fieldErrors} />
              </label>
            ) : (
              <div className="donar-address-row">
                <label>
                  <span>Departamento</span>
                  <DonarSelect
                    value={form.departamento}
                    options={DONAR_DOMESTIC_DEPARTMENTS}
                    onChange={setDepartamento}
                    ariaLabel="Departamento"
                    id={donarFieldDomId("departamento")}
                    errorId={donarFieldErrorRef("departamento", fieldErrors)}
                  />
                  <DonarFieldError field="departamento" errors={fieldErrors} />
                </label>
                <label>
                  <span>Municipio</span>
                  <DonarSelect
                    value={form.municipio}
                    options={municipalityOptions}
                    onChange={(municipio) => update({ municipio })}
                    ariaLabel="Municipio"
                    id={donarFieldDomId("municipio")}
                    errorId={donarFieldErrorRef("municipio", fieldErrors)}
                  />
                  <DonarFieldError field="municipio" errors={fieldErrors} />
                </label>
                <label>
                  <span>Distrito</span>
                  <DonarSelect
                    value={form.distrito}
                    options={districtOptions}
                    onChange={(distrito) => update({ distrito })}
                    ariaLabel="Distrito"
                    id={donarFieldDomId("distrito")}
                    errorId={donarFieldErrorRef("distrito", fieldErrors)}
                  />
                  <DonarFieldError field="distrito" errors={fieldErrors} />
                </label>
              </div>
            )}

            {error && (
              <p className="error donar-error" role="alert">
                <AlertCircle size={16} aria-hidden="true" />
                {error}
              </p>
            )}
            <button className="primary" type="submit" disabled={submitting}>
              {submitting ? "Preparando su entrega…" : form.giftType === "OFRENDA" ? "Continuar con su ofrenda" : "Continuar con su diezmo"}
            </button>
          </form>
        )}

        {/* US Stripe step — our Spanish composition stays on this page while Stripe
            owns the embedded form and dynamically renders eligible methods. */}
        {step === 2 && usDonation && (
          <div className="donar-stripe donar-step">
            {summary}
            <div className="donar-handoff">
              <p className="donar-intro">{stripeIntro(organizationName)}</p>
              {usProvider === "stripe" && (
                <>
                  <button
                    type="button"
                    className="donar-provider-choice donar-provider-choice-givebutter"
                    onClick={() => setUsProvider("givebutter")}
                  >
                    <img
                      src={GIVEBUTTER_ICON_DATA_URI}
                      alt=""
                      aria-hidden="true"
                    />
                    <span className="donar-provider-choice-copy">
                      <strong>Dar con Givebutter</strong>
                      <small>Formulario en inglés</small>
                    </span>
                    <span className="donar-provider-choice-arrow" aria-hidden="true">→</span>
                  </button>
                  {stripeSessionAttempt && (
                    <StripeDonationForm
                      key={stripeSessionAttempt.sequence}
                      session={stripeSessionAttempt.session}
                      onRetry={retryStripeSession}
                    />
                  )}
                </>
              )}
              {usProvider === "givebutter" && (
                <div className="donar-givebutter-surface">
                  <button
                    type="button"
                    className="donar-provider-choice donar-provider-choice-stripe"
                    onClick={() => setUsProvider("stripe")}
                  >
                    <span className="donar-provider-stripe-mark" aria-hidden="true" />
                    <span className="donar-provider-choice-copy">
                      <strong>Volver a Stripe</strong>
                      <small>Formulario en español</small>
                    </span>
                    <span className="donar-provider-choice-arrow" aria-hidden="true">←</span>
                  </button>
                  <iframe
                    className="donar-givebutter-frame"
                    title="Formulario de donación Givebutter"
                    src={givebutterFrameUrl}
                    allow="payment *; clipboard-write"
                    referrerPolicy="strict-origin-when-cross-origin"
                    onLoad={() => setGivebutterFrameStatus("ready")}
                  />
                  {givebutterFrameStatus === "delayed" && (
                    <a
                      className="primary donar-givebutter-fallback"
                      href={givebutterHostedUrl({ amount: form.amount, monthly })}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Abrir Givebutter en otra pestaña
                    </a>
                  )}
                  <a
                    className="donar-givebutter-hint"
                    href={givebutterHostedUrl({ amount: form.amount, monthly })}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    ¿Problemas con el formulario? Abrir Givebutter
                  </a>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Paso 3 — Entrega (SV door). Summary line above the existing Wompi
            handoff: embedded checkout iframe, manual backup, polling, neutral close. */}
        {step === 3 && !usDonation && (
          <div className="donar-step">
            {summary}

            {stage === "widget" && intent && (
              <div className="donar-handoff">
                <p className="donar-intro">Complete su entrega de forma segura con Wompi. Al finalizar, verá aquí la confirmación.</p>
                {/* The iframe stays mounted for the WHOLE widget stage. Wompi posts
                    { message: "close" } both when the donor backs out and when it hands
                    off to the bank's 3DS challenge — and that challenge renders inside
                    this very iframe. Unmounting it on "verifying" killed the challenge
                    mid-flight: no charge, no CDE. The spinner sits above it instead —
                    and only once the delay has elapsed, since "close" arrives at the
                    hand-off while the donor is still inside the bank's challenge. */}
                {verifyingNoticeVisible && (
                  <div className="donar-widget-loading" role="status">
                    <span className="donar-spinner" aria-hidden="true" />
                    {DONAR_WIDGET_VERIFYING_MESSAGE}
                  </div>
                )}
                {handoff === "loading" && (
                  <div className="donar-widget-loading" role="status">
                    <span className="donar-spinner" aria-hidden="true" />
                    {DONAR_WIDGET_LOADING_MESSAGE}
                  </div>
                )}
                {handoff === "delayed" && (
                  <div className="donar-widget-delayed">
                    <p>{DONAR_WIDGET_DELAYED_MESSAGE}</p>
                    <a className="primary donar-widget-fallback" href={intent.urlEnlace}>
                      {DONAR_WIDGET_FALLBACK_CTA}
                    </a>
                  </div>
                )}
                <iframe
                  className="donar-hosted-surface donar-embed"
                  src={widgetUrlFrom(intent.urlEnlaceLargo)}
                  title="Entrega segura con Wompi"
                  style={embedHeight ? { height: embedHeight } : undefined}
                  onLoad={() => setHandoff((current) => (current === "verifying" ? current : "ready"))}
                />
                <button type="button" className="link-button" onClick={() => (window.location.href = intent.urlEnlace)}>
                  ¿Problemas con el formulario? Continúe aquí
                </button>
              </div>
            )}

            {stage === "closed" && <p className="auth-notice">{DONAR_FALLBACK_MESSAGE}</p>}
          </div>
        )}

        <DonarSupport supportEmail={supportEmail} />
      </div>
    </div>
  );
}

function DonarThankYou({ monto, supportEmail }: { monto?: string; supportEmail: string }) {
  return (
    <div className="donar-screen">
      <div className="donar-card card donar-thanks">
        <div className="donar-glyph">
          <CheckCircle2 size={56} />
        </div>
        <h1>{DONAR_THANK_YOU_TITLE}</h1>
        {monto && <p className="donar-thanks-amount">Monto: ${monto}</p>}
        <DonarSupport supportEmail={supportEmail} />
        <p className="donar-intro">{DONAR_THANK_YOU_BODY}</p>
      </div>
    </div>
  );
}

type GraciasVerification = "checking" | "verified" | "unverified";

function DonarGraciasNeutral({ checking, supportEmail }: { checking: boolean; supportEmail: string }) {
  return (
    <div className="donar-screen">
      <div className="donar-card card donar-thanks">
        <div className="donar-glyph">
          <ShieldCheck size={56} />
        </div>
        <h1>{checking ? "Verificando su entrega…" : "No pudimos verificar su entrega todavía."}</h1>
        <p className="donar-intro">{DONAR_FALLBACK_MESSAGE}</p>
        <DonarSupport supportEmail={supportEmail} />
      </div>
    </div>
  );
}

// Landing for Wompi's redirect. Query values identify the intent to check, but only
// server-held webhook state may select the success UI or notify the parent frame.
export function DonarGraciasPage() {
  const display = useMemo(() => graciasDisplayFromSearch(window.location.search), []);
  const [verification, setVerification] = useState<GraciasVerification>("checking");
  const [supportEmail, setSupportEmail] = useState(DONAR_SUPPORT_EMAIL);

  useEffect(() => {
    let cancelled = false;
    void donarApi<unknown>("/api/branding")
      .then((data) => {
        if (!cancelled) {
          setSupportEmail(parseBrandingResponse(data).supportEmail);
        }
      })
      .catch(() => {
        // Keep the compiled fallback when branding is unavailable.
      })
      .finally(() => {
        markDonorBrandingSettled();
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const intentId = display.identificadorEnlaceComercio;
    if (!intentId) {
      setVerification("unverified");
      return;
    }

    let cancelled = false;
    let retry: number | null = null;
    const deadline = Date.now() + DONAR_POLL_TIMEOUT_MS;
    const check = async (): Promise<void> => {
      try {
        const result = await donarApi<{ status: string; paid: boolean }>(
          `${DONAR_INTENT_PATH}/${encodeURIComponent(intentId)}/status`
        );
        if (cancelled) return;
        if (result.paid || result.status === "COMPLETED") {
          setVerification("verified");
          return;
        }
      } catch {
        if (cancelled) return;
      }

      if (Date.now() >= deadline) {
        setVerification("unverified");
        return;
      }
      retry = window.setTimeout(() => void check(), DONAR_POLL_INTERVAL_MS);
    };
    void check();

    return () => {
      cancelled = true;
      if (retry !== null) window.clearTimeout(retry);
    };
  }, [display.identificadorEnlaceComercio]);

  useEffect(() => {
    if (verification === "verified" && window.parent !== window) {
      // Parent and child share the origin; scope the message to it so an unexpected
      // intermediate frame never receives the completion signal.
      window.parent.postMessage(DONAR_COMPLETED_MESSAGE, window.location.origin);
    }
  }, [verification]);

  if (verification === "verified") return <DonarThankYou supportEmail={supportEmail} />;
  return <DonarGraciasNeutral checking={verification === "checking"} supportEmail={supportEmail} />;
}
