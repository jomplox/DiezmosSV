import { CheckCircle2, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  DONAR_AMOUNT_CHIPS,
  DONAR_AUTOCLICK_INTERVAL_MS,
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
  DONAR_STEP_COUNT_US,
  DONAR_THANK_YOU_BODY,
  DONAR_THANK_YOU_TITLE,
  DONAR_WOMPI_SCRIPT_URL,
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
  donarStepIndicator,
  donationAmountValidationMessage,
  donationIntentBody,
  donationStep1ValidationMessage,
  donationStep2ValidationMessage,
  doorFromSearch,
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
import svFlag from "./assets/sv-flag.png";
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

// Door 1 icon: the church's own El Salvador flag asset (src/client/assets/sv-flag.png,
// the civil blue-white-blue tricolor) overlapping the lower-right of a thin monochrome
// line-art globe. The flag is a rounded-corner rectangle (~16:9) sitting on a white
// backing card so it separates cleanly from the globe lines behind it — the same
// "drops onto the globe's lower right" relationship as the previous circle flag.
// aria-hidden: the door button's text label is the single accessible name.
function SvWorldIcon() {
  return (
    <svg
      className="donar-door-icon"
      viewBox="0 0 96 96"
      aria-hidden="true"
      focusable="false"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Rounded-corner clip for the flag image (subtle ~4px radius). */}
      <clipPath id="sv-flag-clip">
        <rect x="47" y="58" width="44" height="24.75" rx="4" ry="4" />
      </clipPath>
      {/* Line-art globe behind the flag. */}
      <g fill="none" stroke="#595959" strokeWidth="1.5">
        <circle cx="44" cy="40" r="30" />
        <ellipse cx="44" cy="40" rx="12" ry="30" />
        <ellipse cx="44" cy="40" rx="24" ry="30" />
        <line x1="14" y1="40" x2="74" y2="40" />
        <path d="M 19 25 Q 44 33 69 25" />
        <path d="M 19 55 Q 44 47 69 55" />
      </g>
      {/* White backing card (the "drop"): a slightly larger rounded rect behind the
          flag so it reads clearly against the globe strokes. */}
      <rect x="44.5" y="55.5" width="49" height="29.75" rx="5.5" ry="5.5" fill="#ffffff" />
      {/* The church's own flag PNG, clipped to a rounded rectangle in the lower-right. */}
      <image
        href={svFlag}
        x="47"
        y="58"
        width="44"
        height="24.75"
        preserveAspectRatio="xMidYMid slice"
        clipPath="url(#sv-flag-clip)"
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

// Public donation wizard + Wompi/Givebutter handoff. Renders WITHOUT a session.
export function DonarPage() {
  const [form, setForm] = useState<DonationFormInput>(emptyDonationForm);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [stage, setStage] = useState<DonarStage>("form");
  const [step, setStep] = useState<DonarStep>(1);
  const [intent, setIntent] = useState<DonarIntent | null>(null);
  // The two-door chooser: /donar opens on a landing where the donor picks where
  // the gift goes (SV/mundo vs EE. UU.) before any form appears. Preseeded from
  // ?ruta=sv / ?ruta=eeuu; null keeps the donor on the chooser. Door "eeuu" opens
  // the Givebutter wizard directly, skipping the extranjero mechanics.
  const [door, setDoor] = useState<DonarDoor | null>(() => doorFromSearch(window.location.search));
  // US-donor (Givebutter) path state: gift frequency (Única | Mensual segmented
  // control) and the render-probe fallback for the embedded giving form.
  const [monthly, setMonthly] = useState(false);
  const [givebutterFallback, setGivebutterFallback] = useState(false);
  const widgetHostRef = useRef<HTMLDivElement | null>(null);
  const givebutterHostRef = useRef<HTMLDivElement | null>(null);
  // Latches once the rendered Wompi button is auto-clicked so re-observing the
  // (still-present) button never re-opens the modal. Reset per intent below.
  const autoClickedRef = useRef(false);
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
    // Leaving a door resets the wizard chrome so each entry is clean (the typed
    // form values survive on purpose — going back must never lose the donor's data).
    setMonthly(false);
    setStep(1);
    setError("");
    setIntent(null);
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

  // Load the Wompi widget script only while this view is mounted (never on admin
  // views). Injected once; the widget div is rendered after intent success.
  useEffect(() => {
    if (document.querySelector(`script[src="${DONAR_WOMPI_SCRIPT_URL}"]`)) {
      return;
    }
    const script = document.createElement("script");
    script.src = DONAR_WOMPI_SCRIPT_URL;
    script.async = true;
    document.head.appendChild(script);
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

  // Once an intent exists, render the widget button. If the script/widget does not
  // render within a short timeout, fall back to the full-page hosted flow.
  useEffect(() => {
    if (stage !== "widget" || !intent) {
      return;
    }
    // Fresh intent: allow the button to be auto-clicked exactly once again.
    autoClickedRef.current = false;
    const host = widgetHostRef.current;
    if (host) {
      host.innerHTML = "";
      const widget = document.createElement("div");
      widget.className = "wompi_button_widget";
      widget.setAttribute("data-url-pago", widgetUrlFrom(intent.urlEnlaceLargo));
      widget.setAttribute("data-render", "widget");
      widget.setAttribute("data-color-fondo", "#007c75");
      widget.setAttribute("data-color-texto", "#ffffff");
      widget.setAttribute("data-cubrir-ancho", "true");
      host.appendChild(widget);
    }
    // Instant handoff: poll the host for the button Wompi injects and click it once
    // so the donor goes form → payment modal with no extra click. The manual button
    // and "Continúe aquí" link stay visible as the backup (the modal can be closed
    // and reopened). Guarded by autoClickedRef so it never double-fires.
    const autoClick = window.setInterval(() => {
      if (autoClickedRef.current || !host) {
        window.clearInterval(autoClick);
        return;
      }
      const button = host.querySelector("button");
      if (button) {
        autoClickedRef.current = true;
        window.clearInterval(autoClick);
        button.click();
      }
    }, DONAR_AUTOCLICK_INTERVAL_MS);
    const fallback = window.setTimeout(() => {
      window.clearInterval(autoClick);
      const rendered = host?.querySelector("iframe, a, button");
      if (!rendered) {
        // Script failed to load or never enhanced the div: hosted redirect.
        window.location.href = intent.urlEnlace;
      }
    }, DONAR_SCRIPT_TIMEOUT_MS);
    return () => {
      window.clearInterval(autoClick);
      window.clearTimeout(fallback);
    };
  }, [stage, intent]);

  // Poll the intent status while the widget modal is open; COMPLETED -> thank-you.
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
        const result = await donarApi<{ status: string }>(`${DONAR_INTENT_PATH}/${intent.intentId}/status`);
        if (!cancelled && result.status === "COMPLETED") {
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
    }
    setStep(2);
  }

  // Paso 2 → Paso 3. Entering the pago step creates the payment intent: validate
  // the datos, POST the intent, then advance into the handoff (widget auto-open,
  // polling, and fallbacks unchanged). On error the donor stays on Paso 2.
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
      const created = await donarApi<DonarIntent>(DONAR_INTENT_PATH, {
        method: "POST",
        body: donationIntentBody(form)
      });
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
  // one is created on the next entry) and unmounts the widget cleanly.
  function goBack() {
    setError("");
    if (step === 3) {
      setIntent(null);
      setStage("form");
      setStep(2);
      return;
    }
    setStep(1);
  }

  // The summary's "Editar": straight back to Paso 1 (amount), abandoning any intent.
  function editAmount() {
    setError("");
    setIntent(null);
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
          <OrganizationLogo />
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
        <h1>{usDonation ? "Diezmos y Ofrendas 🇺🇸" : "Entregue su diezmo u ofrenda 🇸🇻"}</h1>

        {/* Paso 1 assurance: right under the heading, name the legal document this
            door produces — reassurance of the door the donor just chose. */}
        {step === 1 && (
          <p className="donar-assurance">
            {usDonation
              ? "Recibirá un recibo deducible de impuestos en EE. UU. por correo."
              : "Recibirá su comprobante de donación electrónico (CDE) por correo."}
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
            label is the diezmo-framed "Continuar al pago". */}
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
              {submitting ? "Preparando el pago…" : "Continuar al pago"}
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
            handoff: widget auto-open, manual backup, polling, neutral close. */}
        {step === 3 && !usDonation && (
          <div className="donar-step">
            {summary}

            {stage === "widget" && intent && (
              <div className="donar-handoff">
                <p className="donar-intro">Pague de forma segura con Wompi. Al completar el pago, verá la confirmación aquí.</p>
                <div className="donar-widget" ref={widgetHostRef} />
                <button type="button" className="link-button" onClick={() => (window.location.href = intent.urlEnlace)}>
                  ¿No se abre el pago? Continúe aquí
                </button>
              </div>
            )}

            {stage === "closed" && <p className="auth-notice">{DONAR_FALLBACK_MESSAGE}</p>}
          </div>
        )}
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
