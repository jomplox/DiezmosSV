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
    expect(appSource).toContain("Enviar primera tanda");
  });

  it("confirms a bounded batch and offers truthful continuation", () => {
    expect(appSource).toContain("window.confirm");
    expect(appSource).toContain("Se enviará una tanda de hasta 10 constancias a donantes con correo. Podrá continuar si quedan más.");
    expect(appSource).toContain("Enviar siguiente tanda");
    expect(appSource).toContain("Iniciar nuevo recorrido");
    expect(appSource).toContain("Quedan donantes por procesar");
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

  it("keeps preview pagination and bulk traversal in independent state", () => {
    expect(appSource).toContain("certificatePreviewCursor");
    expect(appSource).toContain("bulkNextCursor");
    expect(appSource).toContain("bulkHasMore");
    expect(appSource).toContain("bulkTraversalStarted");
    expect(appSource).toContain("loadMoreCertificatePreview");
    expect(appSource).toContain("body: bulkTraversalStarted ? { after: bulkNextCursor } : {}");

    const singleStart = appSource.indexOf("async function sendDonorCertificate");
    const singleEnd = appSource.indexOf("async function createUser", singleStart);
    const singleSendSource = appSource.slice(singleStart, singleEnd);
    expect(singleSendSource).toContain("body: { donor: donor.groupKey }");
    expect(singleSendSource).not.toContain("setBulkNextCursor");
    expect(singleSendSource).not.toContain("setBulkHasMore");
    expect(singleSendSource).not.toContain("setBulkTraversalStarted");
  });

  it("offers debounced search and keyset preview pagination that reset independently", () => {
    // Search input with the usted-form placeholder.
    expect(appSource).toContain('placeholder="Buscar donante o correo"');
    // Debounced search state threaded into the preview endpoint via q.
    expect(appSource).toContain("debouncedCertificateSearch");
    expect(appSource).toContain("certificatePreviewPath(certificateYear, debouncedCertificateSearch, certificatePreviewCursor)");
    expect(appSource).toContain("&q=${encodeURIComponent(trimmed)}");
    expect(appSource).toContain("Ver más donantes");
    expect(appSource).toContain("setCertificatePreviewCursor(null)");
    // Empty search result copy is distinct from the no-donations-this-year copy.
    expect(appSource).toContain("Ningún donante coincide con la búsqueda.");
    expect(stylesSource).toContain(".certificate-search");
  });

  it("shows and disables oversized dossiers before a per-row send", () => {
    expect(appSource).toContain("dossierTooLarge");
    expect(appSource).toContain("Demasiados comprobantes para una sola constancia");
    expect(appSource).toContain("!donor.hasEmail || donor.dossierTooLarge");
  });

  it("does not present a bounded page as whole-year population or totals", () => {
    expect(appSource).not.toContain("preview?.donorCount");
    expect(appSource).not.toContain("preview?.withEmail");
    expect(appSource).not.toContain("preview?.totalLabel");
    expect(appSource).not.toContain("preview.matchCount");
    expect(appSource).not.toContain("Mostrando {donors.length} de");
  });
});
