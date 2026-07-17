import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { readPasswordResetLocation } from "./passwordReset";
import "./styles.css";

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

    if (!window.location.pathname.startsWith("/donar")) {
      return;
    }

    let cancelled = false;
    let revealFrame: number | null = null;
    void document.fonts.ready.then(() => {
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
    };
  }, []);

  return <App initialResetToken={initialResetToken} />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BootstrappedApp />
  </React.StrictMode>
);
