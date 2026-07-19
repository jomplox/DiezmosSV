import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource =
  readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8") +
  readFileSync(resolve(import.meta.dirname, "../../src/client/exportsPanel.tsx"), "utf8");
const stylesSource = readFileSync(resolve(import.meta.dirname, "../../src/client/styles.css"), "utf8");

describe("annual certificate UI contract", () => {
  it("renders the certificate card with usted-form labels below the F960 card", () => {
    expect(appSource).toContain("Constancia anual de donaciones");
    expect(appSource).toContain("Envíe a cada donante el resumen de sus donaciones aceptadas del año.");
    // Preview table columns: donante, donaciones, total, correo.
    expect(appSource).toContain("<th>Donante</th>");
    expect(appSource).toContain(">Donaciones</th>");
    expect(appSource).toContain(">Total</th>");
    expect(appSource).toContain("<th>Correo</th>");
    expect(appSource).toContain("Enviar constancias");
  });

  it("confirms the send and states that donors without email are skipped", () => {
    expect(appSource).toContain("window.confirm");
    expect(appSource).toContain("sin correo se omitirán");
    expect(appSource).toContain("Los donantes sin correo aparecen en la vista previa pero se omiten al enviar.");
  });

  it("wires the preview and send endpoints for the selected year", () => {
    expect(appSource).toContain("/api/certificates/annual?year=");
    expect(appSource).toContain("/api/certificates/annual/send?year=");
    expect(appSource).toContain("certificateYearOptions()");
    expect(stylesSource).toContain(".certificate-table table");
  });

  it("offers a per-row send button that posts the donor group key in the body", () => {
    // Per-row action column and its usted-form label.
    expect(appSource).toContain("<th>Enviar</th>");
    // Single-donor send posts the donor's grouping key in the request body.
    expect(appSource).toContain("body: { donor:");
    // Per-row busy state keyed by donor so one row spins without disabling the rest.
    expect(appSource).toContain("certificates-send-");
  });

  it("offers a debounced donor/email search that re-fetches the capped preview", () => {
    // Search input with the usted-form placeholder.
    expect(appSource).toContain('placeholder="Buscar donante o correo"');
    // Debounced search state threaded into the preview endpoint via q.
    expect(appSource).toContain("debouncedCertificateSearch");
    expect(appSource).toContain("certificatePreviewPath(certificateYear, debouncedCertificateSearch)");
    expect(appSource).toContain("year=${year}&q=${encodeURIComponent(trimmed)}");
    // Truncation notice when the match set exceeds the server cap.
    expect(appSource).toContain("Mostrando ");
    expect(appSource).toContain("preview.matchCount");
    // Empty search result copy is distinct from the no-donations-this-year copy.
    expect(appSource).toContain("Ningún donante coincide con la búsqueda.");
    expect(stylesSource).toContain(".certificate-search");
  });
});
