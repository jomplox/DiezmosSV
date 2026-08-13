import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isDonarGraciasPath, isDonarPath, isStripeResultPath } from "./donation";
import { donorBrandingSettled } from "./donorReady";
import { readPasswordResetLocation } from "./passwordReset";
import "./styles.css";

// Ceiling on how long the donor page stays invisible waiting for fonts or branding.
// Neither gate may strand the donor on a blank screen: past this budget we reveal and
// accept the (rare) reflow or branded swap rather than show nothing.
const DONOR_REVEAL_BUDGET_MS = 1_500;

const resetLocation = readPasswordResetLocation(window.location.search, window.location.hash);
const initialResetToken = resetLocation.token;
if (resetLocation.shouldReplace) {
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${resetLocation.cleanSearch}${resetLocation.cleanHash}`
  );
}

function BootstrappedApp() {
  useEffect(() => {
    document.getElementById("app-bootstrap")?.remove();

    if (
      !isDonarPath(window.location.pathname) &&
      !isDonarGraciasPath(window.location.pathname) &&
      !isStripeResultPath(window.location.pathname)
    ) {
      return;
    }

    let cancelled = false;
    let revealFrame: number | null = null;
    let budgetTimer: number | null = null;

    // Reveal only once the page is in its FINAL form: fonts loaded (no text reflow) and
    // branding settled (no logo/support-line swap). Waiting on fonts alone still let the
    // branded logo pop in after the donor could already see the page.
    //
    // Both donor routes fetch branding: the wizard resolves its logo and support line,
    // while /donar/gracias resolves the configured support contact.
    const budget = new Promise<void>((resolve) => {
      budgetTimer = window.setTimeout(resolve, DONOR_REVEAL_BUDGET_MS);
    });
    const fontsReady = document.fonts?.ready ?? Promise.resolve();
    const fontsGate = Promise.race([fontsReady, budget]);
    const brandingGate = Promise.race([donorBrandingSettled, budget]);
    void Promise.all([fontsGate, brandingGate]).then(() => {
      if (cancelled) {
        return;
      }
      revealFrame = window.requestAnimationFrame(() => {
        document.documentElement.setAttribute("data-donor-ready", "");
      });
    });

    return () => {
      cancelled = true;
      if (revealFrame !== null) {
        window.cancelAnimationFrame(revealFrame);
      }
      if (budgetTimer !== null) {
        window.clearTimeout(budgetTimer);
      }
    };
  }, []);

  return <App initialResetToken={initialResetToken} />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BootstrappedApp />
  </React.StrictMode>
);
