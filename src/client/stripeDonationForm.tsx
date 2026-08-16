import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import type { StripeEmbeddedCheckoutAnalyticsEventUnion } from "@stripe/stripe-js";
import { loadStripe } from "@stripe/stripe-js/pure";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

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
const STRIPE_FORM_LOADING = "Preparando su formulario seguro con Stripe…";

export function StripeDonationForm({ session, onRetry }: StripeDonationFormProps) {
  const [view, setView] = useState<StripeFormView>({ kind: "loading" });
  const [embeddedReady, setEmbeddedReady] = useState(false);
  const markEmbeddedReady = useCallback(() => setEmbeddedReady(true), []);

  useEffect(() => {
    let active = true;
    setView({ kind: "loading" });
    setEmbeddedReady(false);
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

  if (view.kind === "error") {
    return (
      <div className="donar-hosted-surface donar-stripe-embedded donar-stripe-load-error">
        <p className="error donar-error" role="alert">{view.message}</p>
        <button className="secondary" type="button" onClick={onRetry}>Intentar de nuevo</button>
      </div>
    );
  }

  return (
    <div
      className="donar-hosted-surface donar-stripe-embedded donar-provider-viewport"
      role="region"
      aria-label="Formulario seguro de Stripe"
    >
      {!embeddedReady && (
        <div className="donar-stripe-loading" role="status">
          <span className="donar-spinner" aria-hidden="true" />
          {STRIPE_FORM_LOADING}
        </div>
      )}
      {view.kind === "ready" && (view.config.mock
        ? <MockStripeDonationForm onReady={markEmbeddedReady} />
        : <LiveStripeDonationForm config={view.config} onReady={markEmbeddedReady} />)}
    </div>
  );
}

function LiveStripeDonationForm({
  config,
  onReady
}: {
  config: StripeCheckoutClientConfig;
  onReady: () => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stripePromise = useMemo(() => loadStripe(config.publishableKey), [config.publishableKey]);
  const onAnalyticsEvent = useCallback((event: StripeEmbeddedCheckoutAnalyticsEventUnion) => {
    if (event.eventType === "checkoutRendered") {
      onReady();
    }
  }, [onReady]);
  const options = useMemo(() => ({
    clientSecret: config.clientSecret,
    onAnalyticsEvent
  }), [config.clientSecret, onAnalyticsEvent]);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const viewport = root.parentElement;
    if (!viewport) return;
    let observer: MutationObserver | undefined;
    let boundedFrame: HTMLIFrameElement | undefined;
    let boundedHeight = "";
    const applyViewportHeight = (frame: HTMLIFrameElement) => {
      if (viewport.clientHeight <= 0) return;
      boundedFrame = frame;
      boundedHeight = `${viewport.clientHeight}px`;
      root.style.setProperty("height", boundedHeight);
      frame.style.setProperty("height", boundedHeight, "important");
    };
    const detectPublishedFrameHeight = () => {
      const frame = root.querySelector<HTMLIFrameElement>(".donar-stripe-frame-mount iframe");
      if (!frame) return;
      const height = frame.style.getPropertyValue("height").trim();
      if (frame === boundedFrame && height === boundedHeight) return;
      if (!/^\d+(?:\.\d+)?px$/.test(height) || Number.parseFloat(height) <= 0) return;
      // Stripe publishes its full content height inline with !important. Leaving
      // that height in place makes a capped parent the scroll owner, but pointer
      // gestures over the cross-origin iframe never reach that parent. Keep the
      // iframe itself at the bounded viewport height so its own document scrolls,
      // exactly like the Wompi iframe. Reapply after later Stripe height updates.
      applyViewportHeight(frame);
      onReady();
    };
    observer = new MutationObserver(detectPublishedFrameHeight);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["style"],
      childList: true,
      subtree: true
    });
    const resizeObserver = new ResizeObserver(() => {
      if (boundedFrame) applyViewportHeight(boundedFrame);
    });
    resizeObserver.observe(viewport);
    detectPublishedFrameHeight();
    return () => {
      observer?.disconnect();
      resizeObserver.disconnect();
    };
  }, [onReady]);

  return (
    <div ref={rootRef} className="donar-stripe-live">
      <EmbeddedCheckoutProvider stripe={stripePromise} options={options}>
        <EmbeddedCheckout className="donar-stripe-frame-mount" />
      </EmbeddedCheckoutProvider>
    </div>
  );
}

function MockStripeDonationForm({ onReady }: { onReady: () => void }) {
  useLayoutEffect(onReady, [onReady]);
  return (
    <>
      <p className="donar-stripe-mock-banner" role="status">
        <strong>Simulación local del formulario alojado por Stripe</strong>
        <span>El formulario simulado no envía datos a Stripe.</span>
      </p>

      <div className="donar-stripe-embedded-mock">
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
