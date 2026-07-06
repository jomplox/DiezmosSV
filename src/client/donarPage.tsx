import svFlag from "./assets/sv-flag.svg";
import { CheckCircle2, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  DONAR_AMOUNT_CHIPS,
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
  DONAR_GIFT_TYPE_FIELD_LABEL,
  DONAR_GIFT_TYPE_LABEL,
  DONAR_HERO_PLACEHOLDER,
  DONAR_INTENT_PATH,
  DONAR_LANDING_HEADING,
  DONAR_LANDING_SUBTITLE,
  DONAR_LANDING_UNIFIER,
  DONAR_POLL_INTERVAL_MS,
  DONAR_POLL_TIMEOUT_MS,
  DONAR_ROUTE_PARAM,
  DONAR_SCRIPT_TIMEOUT_MS,
  DONAR_STEP_COUNT_SV,
  DONAR_SUPPORT_EMAIL,
  DONAR_STEP_COUNT_US,
  DONAR_THANK_YOU_BODY,
  DONAR_THANK_YOU_TITLE,
  DONAR_WIDGET_DELAYED_MESSAGE,
  DONAR_WIDGET_FALLBACK_CTA,
  DONAR_WIDGET_LOADING_MESSAGE,
  DONAR_WOMPI_CHECKOUT_ORIGIN,
  GIVEBUTTER_CAMPAIGN,
  GIVEBUTTER_ENGLISH_NOTICE,
  GIVEBUTTER_FALLBACK_CTA,
  GIVEBUTTER_FALLBACK_HINT,
  GIVEBUTTER_FREQ_MONTHLY_LABEL,
  GIVEBUTTER_FREQ_ONCE_LABEL,
  GIVEBUTTER_INTRO,
  GIVEBUTTER_MONTHLY_LABEL,
  GIVEBUTTER_RENDER_TIMEOUT_MS,
  GIVEBUTTER_SCRIPT_URL,
  donarAmountDisplay,
  donarDatosPath,
  donarStepIndicator,
  donationAmountValidationMessage,
  donationDatosBody,
  donationDraftBody,
  donationIntentBody,
  donationStep1ValidationMessage,
  donationStep2ValidationMessage,
  doorFromSearch,
  draftMatchesForm,
  givebutterHostedUrl,
  givebutterPrefillParams,
  graciasDisplayFromSearch,
  isUsDonation,
  routeParamForDoor,
  widgetUrlFrom,
  type DonarDoor,
  type DonarGiftType,
  type DonationFormInput,
  type DonorDocumentType
} from "./donation";
import { catalogOptionLabel, userFacingErrorMessage } from "./displayText";
import { brandingLogoSrc, parseBrandingResponse } from "./branding";
import { ORG_LOGO_PATHS, ORG_LOGO_VIEW_BOX } from "../worker/services/orgLogo";
import { getCat008Districts, getCat013Municipalities, type CatalogOption } from "../shared/catalogs";
import { formatDui, isValidDui } from "../shared/dui";
import { formatNit, isValidNitFormat } from "../shared/nit";

// ─────────────────────────────────────────────────────────────────────────────
// The public donor-checkout views (/donar + /donar/gracias), extracted from
// App.tsx so the donor wizard owns its own module. Both routes render WITHOUT
// a session (App.tsx keeps only the thin path branch that mounts them).
//
// Layout: a 3-step wizard in Givebutter's structural language — one concern per
// screen inside a soft-shadowed 16px card — skinned in Elim's monochrome Gotham.
// SV door:  Paso 1 monto (segmented Diezmo|Ofrenda + hero amount input),
//           Paso 2 datos (documento + dirección), Paso 3 pago (Wompi handoff).
// US door:  Paso 1 monto (segmented Única|Mensual + the same hero input),
//           Paso 2 the embedded Givebutter giving form.
// ─────────────────────────────────────────────────────────────────────────────

// Unauthenticated fetch for the two public donation endpoints. Mirrors App's
// api() helper with an empty token (no Authorization header) and the same
// user-facing error mapping.
async function donarApi<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : {},
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = (await response.json().catch(() => ({}))) as { message?: unknown; error?: unknown };
  if (!response.ok) {
    throw new Error(userFacingErrorMessage(String(data.message ?? data.error ?? `HTTP ${response.status}`)));
  }
  return data as T;
}

// Donor-facing catalog select: no codes, Spanish placeholder, label above.
function DonarSelect({
  value,
  options,
  onChange,
  ariaLabel
}: {
  value: string;
  options: readonly CatalogOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
}) {
  const selected = options.some((option) => option.code === value) ? value : "";
  return (
    <select value={selected} onChange={(event) => onChange(event.target.value)} aria-label={ariaLabel}>
      <option value="">Seleccione</option>
      {options.map((option) => (
        <option key={`${option.code}-${option.label}`} value={option.code}>
          {catalogOptionLabel(option.label)}
        </option>
      ))}
    </select>
  );
}

const emptyDonationForm: DonationFormInput = {
  amount: "",
  // Diezmo is preselected on mount: the SV Paso 1 segmented control lands checked,
  // so the "elija un tipo" validation is only ever a safety net. The donor can still
  // switch to Ofrenda. (The US door ignores giftType entirely.)
  giftType: "DIEZMO",
  donorDocumentType: "13",
  donorDocument: "",
  donorName: "",
  donorPhone: "",
  foreignResident: false,
  pais: "",
  departamento: "",
  municipio: "",
  distrito: "",
  complemento: ""
};

type DonarStage = "form" | "widget" | "thanks" | "closed";
type DonarStep = 1 | 2 | 3;

interface DonarIntent {
  intentId: string;
  urlEnlace: string;
  urlEnlaceLargo: string;
}

// A background-minted draft: the Wompi link the wizard created on the SV Paso 1→2
// transition, tagged with the amount + gift type it was minted with so Paso 2 submit
// can tell whether the donor edited either (stale → abandon the draft, full POST).
interface DonarDraftIntent {
  intent: DonarIntent;
  amount: string;
  giftType: DonarGiftType | "";
}

// The default logo, reusing the vector paths shared with the worker's PDF renderer
// (src/worker/services/orgLogo.ts). Monochrome black on the donor landing.
function OrganizationLogo() {
  return (
    <svg
      className="donar-logo"
      viewBox={`0 0 ${ORG_LOGO_VIEW_BOX.width} ${ORG_LOGO_VIEW_BOX.height}`}
      role="img"
      aria-label="Misión ExampleOrganization"
      xmlns="http://www.w3.org/2000/svg"
    >
      {ORG_LOGO_PATHS.map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  );
}

// Door 1 icon: the official El Salvador flag (flag-icons sv 1:1, MIT — full escudo
// with the "REPUBLICA DE EL SALVADOR" ring) cropped to a circle, overlapping the
// lower-right of a thin monochrome line-art globe. Referenced as an <image> asset so
// its internal SVG ids stay encapsulated. aria-hidden: the door button's text label
// is the single accessible name.
function SvWorldIcon() {
  return (
    <svg
      className="donar-door-icon"
      viewBox="0 0 96 96"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Line-art globe behind the flag. */}
      <g fill="none" stroke="#595959" strokeWidth="1.5">
        <circle cx="42" cy="38" r="30" />
        <ellipse cx="42" cy="38" rx="12" ry="30" />
        <ellipse cx="42" cy="38" rx="24" ry="30" />
        <line x1="12" y1="38" x2="72" y2="38" />
        <path d="M 17 23 Q 42 31 67 23" />
        <path d="M 17 53 Q 42 45 67 53" />
      </g>
      {/* Official flag, circle-cropped, lower-right, with a white ring separating it
          from the globe lines. */}
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

// Door 2 icon: the United States circle flag (HatScripts/circle-flags, MIT), inlined
// verbatim (self-hosted, no runtime fetch) so the previous hand-drawn flag's glitch
// is gone. aria-hidden: the door button's text label is the single accessible name.
function UsFlagIcon() {
  return (
    <svg
      className="donar-door-icon"
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

// Clamp for the height Wompi's checkout reports via its sizeUpdate postMessage: a
// buggy or hostile frame must not collapse the embed or blow the layout open.
function clampEmbedHeight(height: number): number {
  return Math.min(Math.max(Math.round(height), 320), 2400);
}

// Official support contact for both lanes — a discreet mailto line at the bottom of
// every donor card, visually subordinate to the giving flow.
function DonarSupport() {
  return (
    <p className="donar-support">
      ¿Dudas o necesita ayuda? Escríbanos a <a href={`mailto:${DONAR_SUPPORT_EMAIL}`}>{DONAR_SUPPORT_EMAIL}</a>
    </p>
  );
}

// Public donation wizard + Wompi/Givebutter handoff. Renders WITHOUT a session.
export function DonarPage() {
  const [form, setForm] = useState<DonationFormInput>(emptyDonationForm);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [stage, setStage] = useState<DonarStage>("form");
  const [step, setStep] = useState<DonarStep>(1);
  const [intent, setIntent] = useState<DonarIntent | null>(null);
  // The link minted in the background when the donor entered Paso 2. Held here until
  // Paso 2 submit, which attaches the fiscal data (datos) and reuses this intent.
  const [draftIntent, setDraftIntent] = useState<DonarDraftIntent | null>(null);
  // The two-door chooser: /donar opens on a landing where the donor picks where
  // the gift goes (SV/mundo vs EE. UU.) before any form appears. Preseeded from
  // ?ruta=sv / ?ruta=eeuu; null keeps the donor on the chooser. Door "eeuu" opens
  // the Givebutter wizard directly, skipping the extranjero mechanics.
  const [door, setDoor] = useState<DonarDoor | null>(() => doorFromSearch(window.location.search));
  // White-label logo for the landing chooser. When a church has uploaded a logo the
  // donor page shows it in place of the built-in default vector; the vector stays as the
  // fallback. The accent color is deliberately NOT applied here — the donor wizard's
  // monochrome Gotham brand is a design decision, so only the logo is branded.
  const [brandingLogo, setBrandingLogo] = useState<{ src: string; name: string } | null>(null);
  // US-donor (Givebutter) path state: gift frequency (Única | Mensual segmented
  // control) and the render-probe fallback for the embedded giving form.
  const [monthly, setMonthly] = useState(false);
  const [givebutterFallback, setGivebutterFallback] = useState(false);
  // Paso 3 widget lifecycle: "loading" from entry until Wompi renders its button
  // (spinner), "ready" once it has, "delayed" when the render budget elapses first
  // (manual hosted-checkout CTA appears; the poll keeps watching, so a late widget
  // still flips to "ready").
  const [handoff, setHandoff] = useState<"loading" | "ready" | "delayed">("loading");
  // Height reported by Wompi's checkout via sizeUpdate; null keeps the CSS fallback
  // (min(78vh, 820px)) until the first message, then the iframe tracks the content and
  // the inner scrollbar disappears — the page is the only scroller.
  const [embedHeight, setEmbedHeight] = useState<number | null>(null);
  const givebutterHostRef = useRef<HTMLDivElement | null>(null);
  // Per-step focus targets: the hero amount input (Paso 1), the first Paso 2
  // field, and the summary's Editar control (Paso 3 / the US embed step).
  const heroInputRef = useRef<HTMLInputElement | null>(null);
  const step2FirstFieldRef = useRef<HTMLSelectElement | null>(null);
  const summaryEditRef = useRef<HTMLButtonElement | null>(null);

  // When to render the Givebutter wizard instead of the SV fiscal steps: the EE.
  // UU. door, OR the país=US safety net on the SV form (harmless belt-and-braces).
  // "← Cambiar opción" is the only way back — the donor deliberately chose the door.
  const usDonation = door === "eeuu" || isUsDonation(form);
  const stepCount = usDonation ? DONAR_STEP_COUNT_US : DONAR_STEP_COUNT_SV;
  const displayStep = usDonation && step > DONAR_STEP_COUNT_US ? DONAR_STEP_COUNT_US : step;
  // The Paso 3 (and US embed) summary label: what the donor chose on Paso 1.
  const summaryLabel = usDonation
    ? monthly
      ? GIVEBUTTER_FREQ_MONTHLY_LABEL
      : GIVEBUTTER_FREQ_ONCE_LABEL
    : form.giftType
      ? DONAR_GIFT_TYPE_LABEL[form.giftType]
      : "";

  // Choose a door: record it in ?ruta (composing with — never clobbering — any
  // existing query, e.g. the Givebutter amount/frequency prefill) so a refresh
  // keeps the door, then swap the view. null returns to the chooser.
  const chooseDoor = (next: DonarDoor | null) => {
    const params = new URLSearchParams(window.location.search);
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
    // Givebutter path forever.
    setForm((current) => ({ ...current, foreignResident: false, pais: "" }));
    setMonthly(false);
    setStep(1);
    setError("");
    setIntent(null);
    setDraftIntent(null);
    setStage("form");
    setDoor(next);
  };

  const update = (patch: Partial<DonationFormInput>) => setForm((current) => ({ ...current, ...patch }));

  // Changing departamento resets the dependent selects.
  const setDepartamento = (departamento: string) => update({ departamento, municipio: "", distrito: "" });

  const municipalityOptions = getCat013Municipalities(form.departamento);
  const districtOptions = getCat008Districts(form.departamento);

  // Focus follows the wizard: each advance (or back) moves focus to the step's
  // first control — the hero input on Paso 1, the document type on Paso 2, the
  // summary's Editar on Paso 3 / the US embed step.
  useEffect(() => {
    if (door === null) {
      return;
    }
    if (step === 1) {
      heroInputRef.current?.focus();
      return;
    }
    if (step === 2 && step2FirstFieldRef.current) {
      step2FirstFieldRef.current.focus();
      return;
    }
    summaryEditRef.current?.focus();
  }, [door, step]);

  // Fetch the church's branding for the landing logo (name is used as alt text). Uses
  // the same unauthenticated /api/branding as the admin; a failure keeps the default vector.
  useEffect(() => {
    let cancelled = false;
    void donarApi<unknown>("/api/branding")
      .then((data) => {
        if (cancelled) return;
        const branding = parseBrandingResponse(data);
        const src = brandingLogoSrc(branding.logoVersion);
        setBrandingLogo(src ? { src, name: branding.displayName } : null);
      })
      .catch(() => {
        // Keep the built-in default vector.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Warm DNS + TLS to Wompi's checkout host while the donor fills the form, so the
  // Paso 3 embed skips connection setup (a few hundred ms on mobile networks).
  useEffect(() => {
    if (document.querySelector(`link[rel="preconnect"][href="${DONAR_WOMPI_CHECKOUT_ORIGIN}"]`)) {
      return;
    }
    const link = document.createElement("link");
    link.rel = "preconnect";
    link.href = DONAR_WOMPI_CHECKOUT_ORIGIN;
    document.head.appendChild(link);
  }, []);

  // Inject the Givebutter widget script ONLY when the US donation path first becomes
  // active — never on admin views, never for non-US donors. Guarded like the Wompi
  // injection so it loads at most once per page load. Injected from Paso 1 (before
  // the embed step) so the giving form upgrades instantly on "Continuar".
  useEffect(() => {
    if (!usDonation) {
      return;
    }
    if (document.querySelector(`script[src="${GIVEBUTTER_SCRIPT_URL}"]`)) {
      return;
    }
    const script = document.createElement("script");
    script.src = GIVEBUTTER_SCRIPT_URL;
    script.async = true;
    document.head.appendChild(script);
  }, [usDonation]);

  // While the US embed step is active: write the chosen amount (and
  // frequency=monthly when toggled) into the page URL query so the widget
  // prefills, then run the same render probe as the Wompi widget — if the giving
  // form has not rendered any child within the timeout, surface the hosted-page
  // fallback link. On leave (Atrás / Editar / door change) the query is restored
  // so the fiscal path is clean.
  useEffect(() => {
    if (!usDonation || step < 2) {
      return;
    }
    setGivebutterFallback(false);
    const params = new URLSearchParams(window.location.search);
    params.delete("amount");
    params.delete("frequency");
    for (const [key, value] of Object.entries(givebutterPrefillParams({ amount: form.amount, monthly }))) {
      params.set(key, value);
    }
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);

    const probe = window.setTimeout(() => {
      const host = givebutterHostRef.current;
      const element = host?.querySelector("givebutter-giving-form");
      // The widget renders its UI as a child iframe/form OR inside the custom
      // element's shadow root. An *empty* shadow root does not count: the element
      // upgrades and attaches a shadow root even when it rejects the account/campaign
      // (e.g. "Invalid ?acct= format"), so require actual rendered content — a light-
      // DOM iframe/form, or a non-empty shadow root — before suppressing the fallback.
      const lightRendered = !!host?.querySelector("iframe, form");
      const shadowRendered = !!(element?.shadowRoot && element.shadowRoot.childElementCount > 0);
      if (!lightRendered && !shadowRendered) {
        setGivebutterFallback(true);
      }
    }, GIVEBUTTER_RENDER_TIMEOUT_MS);

    return () => {
      window.clearTimeout(probe);
      // Drop only OUR prefill params from the live URL (never a stale snapshot), so
      // any query the donor arrived with survives and the fiscal/Wompi path is clean.
      const leaving = new URLSearchParams(window.location.search);
      leaving.delete("amount");
      leaving.delete("frequency");
      const rest = leaving.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${rest ? `?${rest}` : ""}`);
    };
  }, [usDonation, step, form.amount, monthly]);

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
  // never a redirect. The iframe keeps loading underneath; its onLoad flips to
  // "ready" whenever it lands.
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
  // anything unparseable is ignored. "close" does a one-shot status check: paid/COMPLETED
  // → thanks, otherwise it walks back to Paso 2 (same as our own Atrás from the embed).
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
        // "Cerrar" button. Returning straight to Paso 2 is right for the back arrow but
        // wrong after a successful payment. So do a one-shot status check first: if the
        // intent is already paid (or COMPLETED), go to thanks; otherwise fall back to the
        // existing back-to-Paso-2 behavior. A fetch failure is treated as not-paid.
        const statusPath = `${DONAR_INTENT_PATH}/${activeIntent.intentId}/status`;
        void donarApi<{ status: string; paid: boolean }>(statusPath)
          .then((result) => {
            if (result.paid || result.status === "COMPLETED") {
              setStage("thanks");
            } else {
              setIntent(null);
              setStage("form");
              setStep(2);
            }
          })
          .catch(() => {
            setIntent(null);
            setStage("form");
            setStep(2);
          });
      }
    }
    window.addEventListener("message", onWompiMessage);
    return () => window.removeEventListener("message", onWompiMessage);
  }, [stage, intent]);

  // Poll the intent status while the embedded checkout is open; COMPLETED -> thank-you.
  // Stop after ~3 minutes with a neutral closing message.
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
  }, [stage, intent]);

  // Paso 1 → Paso 2. The SV door gates on gift type + amount; the US door (no
  // gift type) gates on the amount alone. For the US door the prefill params are
  // written into the URL BEFORE the embed mounts, so the giving form (which reads
  // the host URL when it upgrades) always sees the chosen amount/frequency.
  function continueFromMonto(event: FormEvent) {
    event.preventDefault();
    const message = usDonation ? donationAmountValidationMessage(form.amount) : donationStep1ValidationMessage(form);
    if (message) {
      setError(message);
      return;
    }
    setError("");
    if (usDonation) {
      const params = new URLSearchParams(window.location.search);
      params.delete("amount");
      params.delete("frequency");
      for (const [key, value] of Object.entries(givebutterPrefillParams({ amount: form.amount, monthly }))) {
        params.set(key, value);
      }
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    } else {
      // SV door: mint the Wompi link in the BACKGROUND now that amount + gift type are
      // known, so its ~6 s cost is spent while the donor fills Paso 2 instead of on
      // submit. Never blocks the step change; a failure just leaves draftIntent null and
      // Paso 2 submit falls back to the full POST. A draft that still matches (Atrás →
      // Continuar without edits) is reused — each mint costs a Wompi link and one of the
      // donor's throttle slots, so only a missing or stale draft triggers a fresh one.
      if (!draftIntent || !draftMatchesForm(draftIntent, form)) {
        mintDraftIntent(form.amount.trim(), form.giftType);
      }
    }
    setStep(2);
  }

  // Fire-and-forget draft create (SV door only). Stores the minted link + the values it
  // was minted with; errors are swallowed so the wizard degrades to the full POST.
  function mintDraftIntent(amount: string, giftType: DonarGiftType | "") {
    setDraftIntent(null);
    void donarApi<DonarIntent>(DONAR_INTENT_PATH, {
      method: "POST",
      body: donationDraftBody({ amount, giftType })
    })
      .then((created) => {
        setDraftIntent({ intent: created, amount, giftType });
      })
      .catch(() => {
        // Ignored: Paso 2 submit falls back to the full-body POST.
      });
  }

  // Paso 2 → Paso 3. If a background-minted draft still matches the amount + gift type,
  // attach the fiscal data with the fast D1-only datos call and reuse that link — Paso 3
  // renders instantly (the ~6 s Wompi mint already happened during Paso 2). If the draft
  // is missing/failed or stale (amount/tipo edited via Atrás/Editar), fall back to the
  // full-body POST, which still mints the link inline. On error the donor stays on Paso 2.
  async function continueToPago(event: FormEvent) {
    event.preventDefault();
    const message = donationStep2ValidationMessage(form);
    if (message) {
      setError(message);
      return;
    }
    setError("");
    setSubmitting(true);
    try {
      let created: DonarIntent;
      if (draftIntent && draftMatchesForm(draftIntent, form)) {
        // Fast path: the draft link is valid; only attach the donor data (no Wompi call).
        await donarApi<{ ok: true }>(donarDatosPath(draftIntent.intent.intentId), {
          method: "POST",
          body: donationDatosBody(form)
        });
        created = draftIntent.intent;
      } else {
        // No usable draft (missing/failed/stale): the full POST mints the link inline.
        created = await donarApi<DonarIntent>(DONAR_INTENT_PATH, {
          method: "POST",
          body: donationIntentBody(form)
        });
      }
      setDraftIntent(null);
      setIntent(created);
      setStage("widget");
      setStep(3);
    } catch (err) {
      setError(userFacingErrorMessage(err instanceof Error ? err.message : String(err)));
    } finally {
      setSubmitting(false);
    }
  }

  // "← Atrás": one step back. Leaving Paso 3 abandons the created intent (a new
  // one is created on the next entry) and unmounts the widget cleanly. Leaving Paso 2
  // for Paso 1 KEEPS the held draft: if the donor returns without editing amount/tipo,
  // draftMatchesForm reuses it (no second mint, no throttle slot); if they edit, the
  // next Paso 1→2 crossing mints fresh and the stale link expires on the sweep.
  function goBack() {
    setError("");
    if (step === 3) {
      setIntent(null);
      setStage("form");
      setStep(2);
      return;
    }
    // Form-driven Givebutter takeover (SV door + extranjero USA): Atrás returns to the
    // SV datos screen where the choice was made — clearing the país drops usDonation,
    // so this same step re-renders as the SV Paso 2 with every dato intact and the
    // extranjero checkbox still set. Without this, Atrás only walked the US steps and
    // the donor could never reach the SV form again.
    if (door === "sv" && usDonation) {
      setMonthly(false);
      update({ pais: "" });
      return;
    }
    setStep(1);
  }

  // The summary's "Editar": straight back to Paso 1 (amount), abandoning any intent and
  // any background-minted draft (the amount is about to change).
  function editAmount() {
    setError("");
    setIntent(null);
    setDraftIntent(null);
    setStage("form");
    setStep(1);
  }

  if (stage === "thanks") {
    return <DonarThankYou monto={form.amount.trim()} />;
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
            <OrganizationLogo />
          )}
          <h1>{DONAR_LANDING_HEADING}</h1>
          <p className="donar-landing-subtitle">{DONAR_LANDING_SUBTITLE}</p>
          {/* Unifying line: both doors fund the same mother church in El Salvador —
              they differ by residence / payment rail / tax receipt, not beneficiary. */}
          <p className="donar-landing-unifier">{DONAR_LANDING_UNIFIER}</p>
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
          <DonarSupport />
        </div>
      </div>
    );
  }

  const summary = (
    <div className="donar-summary">
      <span className="donar-summary-line">
        {summaryLabel} · {donarAmountDisplay(form.amount)}
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

        <div className="donar-glyph">
          <ShieldCheck size={28} />
        </div>
        <h1>{usDonation ? "Diezmos y Ofrendas 🇺🇸" : "Diezmos y Ofrendas 🇸🇻"}</h1>

        {/* Paso 1 assurance: right under the heading, name the legal document this
            door produces — reassurance of the door the donor just chose. */}
        {step === 1 && (
          <p className="donar-assurance">
            {usDonation
              ? "Recibirá un recibo oficial deducible de impuestos (IRS 501c3) en su dirección de correo electrónico."
              : "Recibirá un comprobante de donación oficial (DTE) en su dirección de correo electrónico."}
          </p>
        )}

        {/* Paso 1 — Monto. Shared by both doors: a segmented control on top
            (Diezmo|Ofrenda on the SV door, Única|Mensual on the US door), the
            hero amount input as the screen's primary element, and the preset
            quick-fill pills underneath. */}
        {step === 1 && (
          <form className="donar-form donar-step" onSubmit={continueFromMonto}>
            {usDonation ? (
              <div className="donar-segment" role="radiogroup" aria-label={GIVEBUTTER_MONTHLY_LABEL}>
                <label className={monthly ? "donar-segment-option" : "donar-segment-option active"}>
                  <input type="radio" name="donar-frequency" value="once" checked={!monthly} onChange={() => setMonthly(false)} />
                  <span>{GIVEBUTTER_FREQ_ONCE_LABEL}</span>
                </label>
                <label className={monthly ? "donar-segment-option active" : "donar-segment-option"}>
                  <input type="radio" name="donar-frequency" value="monthly" checked={monthly} onChange={() => setMonthly(true)} />
                  <span>{GIVEBUTTER_FREQ_MONTHLY_LABEL}</span>
                </label>
              </div>
            ) : (
              <div className="donar-segment" role="radiogroup" aria-label={DONAR_GIFT_TYPE_FIELD_LABEL}>
                {(["DIEZMO", "OFRENDA"] as DonarGiftType[]).map((option) => (
                  <label key={option} className={form.giftType === option ? "donar-segment-option active" : "donar-segment-option"}>
                    <input
                      type="radio"
                      name="donar-gift-type"
                      value={option}
                      checked={form.giftType === option}
                      onChange={() => update({ giftType: option })}
                    />
                    <span>{DONAR_GIFT_TYPE_LABEL[option]}</span>
                  </label>
                ))}
              </div>
            )}

            {/* THE HERO: the amount IS this screen. Giant Gotham numerals with a
                quiet "$" prefix; most tithes are personal amounts, so typing is
                the primary path and the chips below are quick-fills into it. */}
            <div className="donar-hero-amount">
              <span className="donar-hero-currency" aria-hidden="true">
                $
              </span>
              <input
                ref={heroInputRef}
                value={form.amount}
                onChange={(event) => update({ amount: event.target.value })}
                placeholder={DONAR_HERO_PLACEHOLDER}
                aria-label="Monto"
                inputMode="decimal"
                autoComplete="off"
                size={Math.min(Math.max(form.amount.length, DONAR_HERO_PLACEHOLDER.length), 10)}
              />
            </div>

            <div className="donar-chips">
              {DONAR_AMOUNT_CHIPS.map((chip) => (
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

            {error && <p className="error donar-error">{error}</p>}
            <button className="primary" type="submit">
              {DONAR_CONTINUE_LABEL}
            </button>
          </form>
        )}

        {/* Paso 2 — Sus datos (SV door only). Documento + dirección, roomy single
            column. Entering Paso 3 creates the payment intent, so the submit
            label names the chosen gift ("Continuar con su diezmo/ofrenda"). */}
        {step === 2 && !usDonation && (
          <form className="donar-form donar-step" onSubmit={continueToPago}>
            <p className="donar-intro">Complete sus datos para generar su comprobante de donación (CDE).</p>
            <p className="donar-note">Su nombre y correo se ingresan al pagar con Wompi.</p>

            <div className="donar-doc-row">
              <label>
                <span>Tipo de documento</span>
                <select
                  ref={step2FirstFieldRef}
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
                  aria-label={form.donorDocumentType === "36" ? "NIT de la empresa" : "Número de documento"}
                />
              </label>
            </div>

            {form.donorDocumentType === "36" && (
              <label>
                <span>Razón social</span>
                <input
                  value={form.donorName}
                  onChange={(event) => update({ donorName: event.target.value })}
                  placeholder="Nombre legal de la empresa"
                  aria-label="Razón social"
                />
              </label>
            )}

            <label>
              <span>Teléfono (opcional)</span>
              <input
                value={form.donorPhone}
                onChange={(event) => update({ donorPhone: event.target.value })}
                placeholder="0000-0000"
                aria-label="Teléfono (opcional)"
                type="tel"
              />
            </label>

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
                  onChange={(pais) => {
                    // Switching country away from US must leave the Givebutter path
                    // cleanly (the prefill effect cleanup restores the URL).
                    setMonthly(false);
                    update({ pais });
                  }}
                  ariaLabel="País"
                />
              </label>
            ) : (
              <div className="donar-address-row">
                <label>
                  <span>Departamento</span>
                  <DonarSelect value={form.departamento} options={DONAR_DOMESTIC_DEPARTMENTS} onChange={setDepartamento} ariaLabel="Departamento" />
                </label>
                <label>
                  <span>Municipio</span>
                  <DonarSelect value={form.municipio} options={municipalityOptions} onChange={(municipio) => update({ municipio })} ariaLabel="Municipio" />
                </label>
                <label>
                  <span>Distrito</span>
                  <DonarSelect value={form.distrito} options={districtOptions} onChange={(distrito) => update({ distrito })} ariaLabel="Distrito" />
                </label>
              </div>
            )}

            <label>
              <span>Dirección</span>
              <textarea
                value={form.complemento}
                onChange={(event) => update({ complemento: event.target.value })}
                placeholder={form.foreignResident ? "Dirección completa en su país de residencia" : "Dirección completa"}
                aria-label="Dirección"
                maxLength={200}
              />
            </label>

            {error && <p className="error donar-error">{error}</p>}
            <button className="primary" type="submit" disabled={submitting}>
              {submitting ? "Preparando su entrega…" : form.giftType === "OFRENDA" ? "Continuar con su ofrenda" : "Continuar con su diezmo"}
            </button>
          </form>
        )}

        {/* US embed step — the donor's Paso 2/3 is the real Givebutter giving
            form. Compact summary (with Editar back to Paso 1) above the embed so
            the transition into Givebutter's own card feels continuous. */}
        {step === 2 && usDonation && (
          <div className="donar-givebutter donar-step">
            {summary}
            <p className="donar-intro">{GIVEBUTTER_INTRO}</p>
            <p className="donar-english-notice">{GIVEBUTTER_ENGLISH_NOTICE}</p>

            {/* Givebutter reads amount/frequency from the host page URL (written
                before this step mounts and re-asserted by the prefill effect). The
                custom element is upgraded by the widgets.givebutter.com script
                injected on this path. */}
            <div className="donar-givebutter-widget" ref={givebutterHostRef}>
              <givebutter-giving-form campaign={GIVEBUTTER_CAMPAIGN} />
            </div>

            {givebutterFallback && (
              <a
                className="primary donar-givebutter-fallback"
                href={givebutterHostedUrl({ amount: form.amount, monthly })}
                target="_blank"
                rel="noopener noreferrer"
              >
                {GIVEBUTTER_FALLBACK_CTA}
              </a>
            )}

            <a
              className="donar-givebutter-hint"
              href={givebutterHostedUrl({ amount: form.amount, monthly })}
              target="_blank"
              rel="noopener noreferrer"
            >
              {GIVEBUTTER_FALLBACK_HINT}
            </a>
          </div>
        )}

        {/* Paso 3 — Pago (SV door). Summary line above the existing Wompi
            handoff: embedded checkout iframe, manual backup, polling, neutral close. */}
        {step === 3 && !usDonation && (
          <div className="donar-step">
            {summary}

            {stage === "widget" && intent && (
              <div className="donar-handoff">
                <p className="donar-intro">Complete su entrega de forma segura con Wompi. Al finalizar, verá aquí la confirmación.</p>
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
                  className="donar-embed"
                  src={widgetUrlFrom(intent.urlEnlaceLargo)}
                  title="Entrega segura con Wompi"
                  style={embedHeight ? { height: embedHeight } : undefined}
                  scrolling={embedHeight ? "no" : undefined}
                  onLoad={() => setHandoff("ready")}
                />
                <button type="button" className="link-button" onClick={() => (window.location.href = intent.urlEnlace)}>
                  ¿No se muestra el formulario? Continúe aquí
                </button>
              </div>
            )}

            {stage === "closed" && <p className="auth-notice">{DONAR_FALLBACK_MESSAGE}</p>}
          </div>
        )}

        <DonarSupport />
      </div>
    </div>
  );
}

export function DonarThankYou({ monto }: { monto?: string }) {
  return (
    <div className="donar-screen">
      <div className="donar-card card donar-thanks">
        <div className="donar-glyph">
          <CheckCircle2 size={56} />
        </div>
        <h1>{DONAR_THANK_YOU_TITLE}</h1>
        {monto && <p className="donar-thanks-amount">Monto: ${monto}</p>}
        <DonarSupport />
        <p className="donar-intro">{DONAR_THANK_YOU_BODY}</p>
      </div>
    </div>
  );
}

// Landing for the redirect fallback and Wompi's per-link redirect. Reads the query
// string for DISPLAY ONLY (no trust decisions). If it is running inside the widget
// iframe modal, it postMessages the parent so /donar can show the thank-you state.
export function DonarGraciasPage() {
  const display = useMemo(() => graciasDisplayFromSearch(window.location.search), []);

  useEffect(() => {
    if (window.parent !== window) {
      // Parent and child share the origin; scope the message to it so an unexpected
      // intermediate frame never receives the completion signal.
      window.parent.postMessage(DONAR_COMPLETED_MESSAGE, window.location.origin);
    }
  }, []);

  return <DonarThankYou monto={display.monto || undefined} />;
}
