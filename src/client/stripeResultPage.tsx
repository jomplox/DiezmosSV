import { AlertCircle, CheckCircle2, Clock3, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import {
  donorBrandingRequestFailed,
  resolveDonorBranding,
  unresolvedDonorBranding,
  type DonorBrandingState
} from "./branding";
import {
  DONAR_LANDING_HEADING,
  DONAR_STEP_TITLE_ENTREGA,
  STRIPE_PORTAL_PATH,
  STRIPE_RESULT_POLL_INTERVAL_MS,
  STRIPE_RESULT_POLL_TIMEOUT_MS,
  isStripeHostedUrl,
  stripeSessionIdFromSearch,
  stripeSessionPath
} from "./donation";
import { DonorBrandingLogo, DonarSupport } from "./donarPage";
import { markDonorBrandingSettled } from "./donorReady";
import { userFacingErrorMessage } from "./displayText";
import { formatCents } from "../shared/money";

type StripeResultStatus = "OPEN" | "PENDING" | "PAID" | "FAILED" | "EXPIRED";

interface StripeResultSnapshot {
  status: StripeResultStatus;
  frequency: "ONCE" | "MONTHLY";
  amountCents: number;
  currency: "usd";
  canManageRecurring: boolean;
  recurringStatus: "ACTIVE" | "PAST_DUE" | "CANCELED" | null;
}

type StripeResultView =
  | { kind: "checking" }
  | { kind: "invalid" }
  | { kind: "delayed" }
  | { kind: "snapshot"; value: StripeResultSnapshot };

async function stripePublicApi<T>(
  path: string,
  options: { method?: string; body?: unknown } = {}
): Promise<T> {
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = (await response.json().catch(() => ({}))) as { message?: unknown; error?: unknown };
  if (!response.ok) {
    throw new Error(userFacingErrorMessage(String(data.message ?? data.error ?? `HTTP ${response.status}`)));
  }
  return data as T;
}

function isStripeResultSnapshot(value: unknown): value is StripeResultSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return new Set(["OPEN", "PENDING", "PAID", "FAILED", "EXPIRED"]).has(String(record.status))
    && new Set(["ONCE", "MONTHLY"]).has(String(record.frequency))
    && Number.isInteger(record.amountCents)
    && Number(record.amountCents) >= 100
    && record.currency === "usd"
    && typeof record.canManageRecurring === "boolean"
    && (record.recurringStatus === null
      || new Set(["ACTIVE", "PAST_DUE", "CANCELED"]).has(String(record.recurringStatus)));
}

function isPendingStatus(status: StripeResultStatus): boolean {
  return status === "OPEN" || status === "PENDING";
}

function ResultIcon({ view }: { view: StripeResultView }) {
  if (view.kind === "snapshot" && view.value.status === "PAID") {
    return <CheckCircle2 size={56} aria-hidden="true" />;
  }
  if (view.kind === "snapshot" && (view.value.status === "FAILED" || view.value.status === "EXPIRED")) {
    return <AlertCircle size={56} aria-hidden="true" />;
  }
  return <Clock3 size={56} aria-hidden="true" />;
}

export function StripeResultPage() {
  const sessionId = stripeSessionIdFromSearch(window.location.search);
  const [view, setView] = useState<StripeResultView>(sessionId ? { kind: "checking" } : { kind: "invalid" });
  const [portalError, setPortalError] = useState("");
  const [openingPortal, setOpeningPortal] = useState(false);
  const [branding, setBranding] = useState<DonorBrandingState>(unresolvedDonorBranding);

  useEffect(() => {
    let cancelled = false;
    void stripePublicApi<unknown>("/api/branding")
      .then(async (data) => {
        const nextBranding = await resolveDonorBranding(data);
        if (!cancelled) setBranding(nextBranding);
      })
      .catch(() => {
        if (!cancelled) setBranding(donorBrandingRequestFailed());
      })
      .finally(markDonorBrandingSettled);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: number | null = null;
    const startedAt = Date.now();

    const refresh = async () => {
      try {
        const snapshot = await stripePublicApi<unknown>(stripeSessionPath(sessionId));
        if (cancelled) return;
        if (!isStripeResultSnapshot(snapshot)) {
          throw new Error("No pudimos interpretar la confirmación de esta entrega.");
        }
        setView({ kind: "snapshot", value: snapshot });
        if (!isPendingStatus(snapshot.status)) return;
      } catch {
        if (cancelled) return;
      }

      if (Date.now() - startedAt >= STRIPE_RESULT_POLL_TIMEOUT_MS) {
        setView({ kind: "delayed" });
        return;
      }
      timer = window.setTimeout(() => void refresh(), STRIPE_RESULT_POLL_INTERVAL_MS);
    };

    void refresh();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [sessionId]);

  async function openRecurringManagement() {
    if (!sessionId || openingPortal) return;
    setPortalError("");
    setOpeningPortal(true);
    try {
      const result = await stripePublicApi<{ url: string }>(STRIPE_PORTAL_PATH, {
        method: "POST",
        body: { sessionId }
      });
      const allowTestHost = window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1";
      if (!isStripeHostedUrl(result.url, "billing", allowTestHost)) {
        throw new Error("No pudimos abrir la administración de su entrega mensual.");
      }
      window.location.assign(result.url);
    } catch (error) {
      setPortalError(userFacingErrorMessage(error instanceof Error ? error.message : String(error)));
    } finally {
      setOpeningPortal(false);
    }
  }

  const confirmed = view.kind === "snapshot" && view.value.status === "PAID";
  const terminalProblem = view.kind === "snapshot"
    && (view.value.status === "FAILED" || view.value.status === "EXPIRED");
  let confirmationMessage = "";
  if (view.kind === "snapshot" && view.value.status === "PAID") {
    if (view.value.frequency === "ONCE") {
      confirmationMessage = "La organización estadounidense 501(c)(3) enviará su recibo por correo electrónico.";
    } else if (view.value.recurringStatus === "PAST_DUE") {
      confirmationMessage = "Su entrega mensual necesita atención. Use la administración de Stripe para revisar el método guardado. La organización estadounidense 501(c)(3) enviará su recibo por correo electrónico.";
    } else if (view.value.recurringStatus === "CANCELED") {
      confirmationMessage = "Su entrega mensual está cancelada; no se programarán nuevas aportaciones. La organización estadounidense 501(c)(3) enviará el recibo de esta donación por correo electrónico.";
    } else {
      confirmationMessage = "Su entrega mensual quedó confirmada. La organización estadounidense 501(c)(3) enviará su recibo por correo electrónico.";
    }
  }

  return (
    <div className="donar-screen">
      <div className="donar-card card donar-thanks donar-stripe-result">
        <DonorBrandingLogo branding={branding} />
        <h1>{DONAR_LANDING_HEADING}</h1>
        <p className="donar-step-label">{DONAR_STEP_TITLE_ENTREGA}</p>
        <div className="donar-glyph donar-result-icon">
          <ResultIcon view={view} />
        </div>

        {confirmed ? (
          <>
            <h2>Dios le bendiga. Su aportación fue recibida.</h2>
            <p className="donar-thanks-amount">{formatCents(view.value.amountCents)} USD</p>
            <p className="donar-intro">{confirmationMessage}</p>
            {view.value.canManageRecurring && (
              <button className="primary" type="button" disabled={openingPortal} onClick={() => void openRecurringManagement()}>
                {openingPortal ? "Abriendo…" : "Administrar mi entrega mensual"}
              </button>
            )}
          </>
        ) : terminalProblem ? (
          <>
            <h2>No pudimos confirmar esta entrega.</h2>
            <p className="donar-intro">
              {view.value.status === "EXPIRED"
                ? "El enlace venció antes de que se completara la entrega."
                : "Puede iniciar una nueva entrega o escribirnos si necesita ayuda."}
            </p>
          </>
        ) : view.kind === "invalid" ? (
          <>
            <h2>No pudimos identificar esta entrega.</h2>
            <p className="donar-intro">Abra el enlace completo que recibió después de continuar con Stripe.</p>
          </>
        ) : view.kind === "delayed" ? (
          <>
            <h2>La confirmación está tardando más de lo esperado.</h2>
            <p className="donar-intro">Si completó su entrega, recibirá el recibo por correo electrónico. No necesita intentarlo de nuevo.</p>
          </>
        ) : (
          <div className="donar-result-checking" role="status">
            <span className="donar-spinner" aria-hidden="true" />
            <div>
              <h2>Confirmando su entrega…</h2>
              <p>Espere un momento mientras recibimos la confirmación segura de Stripe.</p>
            </div>
          </div>
        )}

        {portalError && (
          <p className="error donar-error" role="alert">
            <AlertCircle size={16} aria-hidden="true" />
            {portalError}
          </p>
        )}
        <div className="donar-stripe-trust">
          <ShieldCheck size={18} aria-hidden="true" />
          <span>Entrega segura con Stripe</span>
        </div>
        {!confirmed && (
          <a className="link-button donar-result-return" href="/donar?ruta=eeuu">Volver a Diezmos y Ofrendas</a>
        )}
        <DonarSupport supportEmail={branding.supportEmail} />
      </div>
    </div>
  );
}
