import React, { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

function BootstrappedApp() {
  useEffect(() => {
    document.getElementById("app-bootstrap")?.remove();
  }, []);

  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BootstrappedApp />
  </React.StrictMode>
);
