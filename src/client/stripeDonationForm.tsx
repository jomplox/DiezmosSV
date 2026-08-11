import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { loadStripe } from "@stripe/stripe-js";
import { useEffect, useMemo, useState } from "react";

export interface StripeCheckoutClientConfig {
  sessionId: string;
  clientSecret: string;
  publishableKey: string;
  mock: boolean;
}

interface StripeDonationFormProps {
  session: Promise<StripeCheckoutClientConfig>;
  onRetry: () => void;
}

type StripeFormView =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; config: StripeCheckoutClientConfig };

const STRIPE_FORM_ERROR = "No pudimos preparar su entrega con Stripe. Inténtelo de nuevo.";

export function StripeDonationForm({ session, onRetry }: StripeDonationFormProps) {
  const [view, setView] = useState<StripeFormView>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    setView({ kind: "loading" });
    void session.then((config) => {
      if (!active) return;
      setView(isStripeCheckoutClientConfig(config)
        ? { kind: "ready", config }
        : { kind: "error", message: STRIPE_FORM_ERROR });
    }).catch((error: unknown) => {
      if (!active) return;
      setView({
        kind: "error",
        message: error instanceof Error && error.message.trim() ? error.message : STRIPE_FORM_ERROR
      });
    });
    return () => {
      active = false;
    };
  }, [session]);

  if (view.kind === "loading") {
    return (
      <div className="donar-hosted-surface donar-stripe-embedded donar-stripe-loading" role="status">
        <span className="donar-spinner" aria-hidden="true" />
        Preparando su formulario seguro con Stripe…
      </div>
    );
  }

  if (view.kind === "error") {
    return (
      <div className="donar-hosted-surface donar-stripe-embedded donar-stripe-load-error">
        <p className="error donar-error" role="alert">{view.message}</p>
        <button className="secondary" type="button" onClick={onRetry}>Intentar de nuevo</button>
      </div>
    );
  }

  return view.config.mock
    ? <MockStripeDonationForm />
    : <LiveStripeDonationForm config={view.config} />;
}

function LiveStripeDonationForm({ config }: { config: StripeCheckoutClientConfig }) {
  const stripePromise = useMemo(() => loadStripe(config.publishableKey), [config.publishableKey]);
  const options = useMemo(() => ({ clientSecret: config.clientSecret }), [config.clientSecret]);

  return (
    <div className="donar-hosted-surface donar-stripe-embedded">
      <EmbeddedCheckoutProvider stripe={stripePromise} options={options}>
        <EmbeddedCheckout />
      </EmbeddedCheckoutProvider>
    </div>
  );
}

function MockStripeDonationForm() {
  return (
    <>
      <p className="donar-stripe-mock-banner" role="status">
        <strong>Simulación local del formulario alojado por Stripe</strong>
        <span>La sesión conectada reemplaza esta vista; ningún dato se envía desde la simulación.</span>
      </p>

      <div className="donar-hosted-surface donar-stripe-embedded donar-stripe-embedded-mock">
        <section className="donar-stripe-hosted-preview" aria-labelledby="stripe-hosted-preview-title">
          <div className="donar-stripe-hosted-brand" aria-hidden="true">
            <span>stripe</span>
            <span>Entrega segura</span>
          </div>
          <h2 id="stripe-hosted-preview-title">Formulario seguro alojado por Stripe</h2>
          <p>
            Stripe mostrará aquí, en español, el formulario completo y cada opción elegible para la persona donante.
          </p>
          <div className="donar-stripe-hosted-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
        </section>
      </div>

      <p className="donar-stripe-disclosure">
        Su donación es voluntaria y no recibe bienes ni servicios a cambio.
      </p>
    </>
  );
}

function isStripeCheckoutClientConfig(value: unknown): value is StripeCheckoutClientConfig {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StripeCheckoutClientConfig>;
  return typeof candidate.sessionId === "string"
    && /^cs_(?:test|live)_[A-Za-z0-9_-]{8,200}$/.test(candidate.sessionId)
    && typeof candidate.clientSecret === "string"
    && candidate.clientSecret.startsWith(`${candidate.sessionId}_secret_`)
    && typeof candidate.publishableKey === "string"
    && /^pk_(?:test|live)_[A-Za-z0-9_]{4,300}$/.test(candidate.publishableKey)
    && typeof candidate.mock === "boolean";
}
