import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { resetTokenFromHash } from "./passwordReset";
import "./styles.css";

const initialResetToken = resetTokenFromHash(window.location.hash);
if (initialResetToken) {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}

function BootstrappedApp() {
  useEffect(() => {
    document.getElementById("app-bootstrap")?.remove();
  }, []);

  return <App initialResetToken={initialResetToken} />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BootstrappedApp />
  </React.StrictMode>
);
