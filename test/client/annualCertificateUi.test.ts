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
    // Per-row busy state keeps the active row's truthful spinner label.
    expect(appSource).toContain("certificates-send-");
    expect(appSource).toContain('const anySending = busy || rowBusy.startsWith("certificates-send")');
  });

  it("keeps preview pagination and bulk traversal in independent state", () => {
    expect(appSource).toContain("certificatePreviewCursor");
    expect(appSource).toContain("bulkHasMore");
    expect(appSource).toContain("bulkTraversalStarted");
    expect(appSource).toContain("certificatePreviewRequestRef");
    expect(appSource).toContain("certificateBulkTraversalRef");
    expect(appSource).toContain("loadMoreCertificatePreview");
    expect(appSource).toContain("body: request.cursor ? { after: request.cursor } : {}");

    const singleStart = appSource.indexOf("async function sendDonorCertificate");
    const singleEnd = appSource.indexOf("async function createUser", singleStart);
    const singleSendSource = appSource.slice(singleStart, singleEnd);
    expect(singleSendSource).toContain("body: { donor: donor.groupKey }");
    expect(singleSendSource).not.toContain("setBulkNextCursor");
    expect(singleSendSource).not.toContain("setBulkHasMore");
    expect(singleSendSource).not.toContain("setBulkTraversalStarted");
    expect(singleSendSource).not.toContain("certificateBulkTraversalRef");
  });

  it("offers debounced search and keyset preview pagination that reset independently", () => {
    // Search input with the usted-form placeholder.
    expect(appSource).toContain('placeholder="Buscar donante o correo"');
    // Debounced search state threaded into the preview endpoint via q.
    expect(appSource).toContain("debouncedCertificateSearch");
    expect(appSource).toContain("certificatePreviewPath(request.year, request.search, request.cursor)");
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

  it("invalidates raw search synchronously without resetting bulk traversal", () => {
    const searchStart = appSource.indexOf("function changeCertificateSearch");
    const searchEnd = appSource.indexOf("// Single-donor send", searchStart);
    const searchSource = appSource.slice(searchStart, searchEnd);
    expect(searchSource).toContain("certificateSearchInputGenerationRef.current += 1");
    expect(searchSource.indexOf("certificateSearchInputGenerationRef.current += 1")).toBeLessThan(
      searchSource.indexOf("invalidateCertificatePreview")
    );
    expect(searchSource).toContain(
      "invalidateCertificatePreview(certificatePreviewRequestRef.current.year, value.trim())"
    );
    expect(searchSource.indexOf("invalidateCertificatePreview")).toBeLessThan(
      searchSource.indexOf("setCertificateSearch(value)")
    );
    expect(searchSource).not.toContain("resetCertificateBulkTraversal");
  });

  it("settles every surviving raw-search revision even when its trimmed value is unchanged", () => {
    const debounceStart = appSource.indexOf("const nextSearch = certificateSearch.trim()");
    const debounceEnd = appSource.indexOf("document.querySelector", debounceStart);
    const debounceSource = appSource.slice(debounceStart, debounceEnd);
    expect(debounceSource).toContain("const inputGeneration = certificateSearchInputGenerationRef.current");
    expect(debounceSource).toContain("setSettledCertificateSearchRevision(inputGeneration)");

    const refreshEffectStart = appSource.indexOf("const refreshKey = JSON.stringify");
    const refreshEffectEnd = appSource.indexOf("// Effective analytics range", refreshEffectStart);
    expect(appSource.slice(refreshEffectStart, refreshEffectEnd)).toContain(
      "settledCertificateSearchRevision"
    );
  });

  it("coalesces one pending automatic refresh and queues only one current follower", () => {
    const keyStart = appSource.indexOf("const refreshKey = JSON.stringify");
    const keyEnd = appSource.indexOf("]);", keyStart) + 3;
    const effectEnd = appSource.indexOf("// Effective analytics range", keyStart);
    const keySource = appSource.slice(keyStart, keyEnd);
    const refreshSource = appSource.slice(keyStart, effectEnd);

    expect(keySource).toContain("certificateYear");
    expect(keySource).toContain("debouncedCertificateSearch");
    expect(keySource).toContain("certificateSearchInputGenerationRef.current");
    expect(keySource).not.toContain("settledCertificateSearchRevision");
    expect(refreshSource).toContain("automaticRefreshFlightRef.current");
    expect(refreshSource).toContain('currentFlight.state === "pending"');
    expect(refreshSource).toContain("followerQueued: true");
    expect(refreshSource).toContain("dispatchAutomaticRefresh(refreshKey, false)");
  });

  it("owns every automatic refresh commit and retries one queued follower only once", () => {
    const dispatchStart = appSource.indexOf("function dispatchAutomaticRefresh");
    const dispatchEnd = appSource.indexOf("function resetAccountState", dispatchStart);
    const dispatchSource = appSource.slice(dispatchStart, dispatchEnd);

    expect(dispatchSource).toContain("const token = Symbol(refreshKey)");
    expect(dispatchSource).toContain("const control = automaticRefreshControl(token)");
    expect(dispatchSource).toContain("void refresh(control)");
    expect(dispatchSource).toContain("currentFlight.token !== token");
    expect(dispatchSource).toContain('state: "completed"');
    expect(dispatchSource).toContain("currentFlight.followerQueued && !currentFlight.retryUsed");
    expect(dispatchSource).toContain("dispatchAutomaticRefresh(refreshKey, true)");

    const controlStart = appSource.indexOf("function automaticRefreshControl");
    const controlEnd = appSource.indexOf("function dispatchAutomaticRefresh", controlStart);
    const controlSource = appSource.slice(controlStart, controlEnd);
    expect(controlSource).toContain("automaticRefreshFlightRef.current?.token === token");
    expect(controlSource).toContain("accountStateGuardRef.current.isCurrent(renderAccountStateVersion)");
    expect(controlSource).toContain("operation()");
  });

  it("uses synchronous uniquely-owned claims for all certificate dispatch shapes", () => {
    expect(appSource).toContain("const token = Symbol(key)");
    expect(appSource).toContain("certificateOperationClaimsRef.current.get(key) === token");

    const bulkStart = appSource.indexOf("async function sendAnnualCertificates");
    const bulkEnd = appSource.indexOf("async function loadMoreCertificatePreview", bulkStart);
    const bulkSource = appSource.slice(bulkStart, bulkEnd);
    expect(bulkSource.indexOf("claimCertificateOperation(claimKey)")).toBeLessThan(
      bulkSource.indexOf("window.confirm")
    );

    const pageStart = bulkEnd;
    const pageEnd = appSource.indexOf("function startNewCertificateTraversal", pageStart);
    const pageSource = appSource.slice(pageStart, pageEnd);
    expect(pageSource.indexOf("claimCertificateOperation(claimKey)")).toBeLessThan(
      pageSource.indexOf("await runAction")
    );

    const singleStart = appSource.indexOf("async function sendDonorCertificate");
    const singleEnd = appSource.indexOf("async function createUser", singleStart);
    const singleSource = appSource.slice(singleStart, singleEnd);
    expect(singleSource.indexOf("claimCertificateOperation(claimKey)")).toBeLessThan(
      singleSource.indexOf("window.confirm")
    );
    expect(singleSource).toContain("releaseCertificateOperation(claimKey, claimToken)");

    const singleClaimStart = singleSource.indexOf("const claimKey = JSON.stringify");
    const singleClaimEnd = singleSource.indexOf("const claimToken", singleClaimStart);
    const singleClaimSource = singleSource.slice(singleClaimStart, singleClaimEnd);
    expect(singleClaimSource).toContain('"single"');
    expect(singleClaimSource).toContain("previewRequest.generation");
    expect(singleClaimSource).toContain("previewRequest.year");
    expect(singleClaimSource).not.toContain("donor.groupKey");
  });

  it("suppresses stale preview errors and owns generic action success, failure, and finalizers", () => {
    expect(appSource).toContain('certificateResult?.status === "rejected"');
    expect(appSource).toContain("isCurrentCertificatePreviewRequest(certificateRequest)");
    expect(appSource).toContain("throw certificateResult.reason");

    const actionStart = appSource.indexOf("async function runAction");
    const actionEnd = appSource.indexOf("// Appends the next audit page", actionStart);
    const actionSource = appSource.slice(actionStart, actionEnd);
    expect(actionSource).toContain("const actionToken = Symbol(name)");
    expect(actionSource).toContain("action: (control: RunActionControl) => Promise<void>");
    expect(actionSource).toContain("await runAccountOperation(() => action(control))");
    expect(actionSource).toContain("commit(operation)");
    expect(actionSource).toContain("if (!isOwner())");
    expect(actionSource).toContain("runActionOwnerRef.current?.token === actionToken");
    expect(actionSource).toContain("&& isCurrent()");
    expect(actionSource).toContain("runActionOwnerRef.current = null");

    const f960Start = appSource.indexOf("async function downloadF960");
    const f960End = appSource.indexOf("async function downloadContacts", f960Start);
    const f960Source = appSource.slice(f960Start, f960End);
    expect(f960Source).toContain("async (control) =>");
    expect(f960Source).toContain("control.commit(() =>");
    expect(f960Source.indexOf("control.commit(() =>")).toBeLessThan(
      f960Source.indexOf('setToast(format === "csv"')
    );

    expect(appSource).toContain("function commitRefreshState(control: RunActionControl | undefined");
    expect(appSource).toContain("return control.commit(operation)");
  });

  it("invalidates certificate claims on account reset and unmount", () => {
    const unmountStart = appSource.indexOf("useEffect(() => () => {");
    const unmountEnd = appSource.indexOf("}, []);", unmountStart);
    expect(appSource.slice(unmountStart, unmountEnd)).toContain("automaticRefreshFlightRef.current = null");

    const resetStart = appSource.indexOf("function resetAccountState");
    const resetEnd = appSource.indexOf("async function loadMoreDocuments", resetStart);
    expect(appSource.slice(resetStart, resetEnd)).toContain("certificateOperationClaimsRef.current.clear()");
    expect(appSource.slice(resetStart, resetEnd)).toContain("automaticRefreshFlightRef.current = null");
    expect(appSource).toContain("generation: previewRequest.generation + 1");
    expect(appSource).toContain("generation: bulkTraversal.generation + 1");
  });
});
