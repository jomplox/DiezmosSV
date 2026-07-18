import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  FiscalCorrectionDialog,
  fiscalCorrectionFormState,
  fiscalCorrectionRequestIdForTarget,
  fiscalCorrectionStatusLabel,
  isCorrectablePreCdeFailure
} from "../../src/client/fiscalCorrectionDialog";
import {
  restoreFiscalCorrectionDialogFocus,
  trapFiscalCorrectionDialogFocus
} from "../../src/client/fiscalCorrectionFocus";
import type {
  FiscalCorrectionData,
  WompiIssuanceFailureItem
} from "../../src/client/types";
import type { FiscalReceptorCorrection } from "../../src/shared/fiscalCorrection";

const appSource = readFileSync(
  resolve(import.meta.dirname, "../../src/client/App.tsx"),
  "utf8"
);
const dialogSource = readFileSync(
  resolve(import.meta.dirname, "../../src/client/fiscalCorrectionDialog.tsx"),
  "utf8"
);
const stylesSource = readFileSync(
  resolve(import.meta.dirname, "../../src/client/styles.css"),
  "utf8"
);

const domesticReceptor: FiscalReceptorCorrection = {
  tipoDocumento: "13",
  numDocumento: "10000002-7",
  nrc: null,
  nombre: "Ana Donante",
  codActividad: null,
  descActividad: null,
  correo: "ana@example.org",
  telefono: "70001111",
  codDomiciliado: 1,
  codPais: "SV",
  departamento: "06",
  municipio: "22",
  distrito: "01",
  complemento: "Colonia Centro"
};

function data(
  receptor: FiscalReceptorCorrection = domesticReceptor,
  activeCorrection: FiscalCorrectionData["activeCorrection"] = null
): FiscalCorrectionData {
  return {
    receptor,
    targetStatus: "REJECTED",
    failureReason: "Campo #/receptor/numDocumento contiene un valor inválido",
    correctable: true,
    guidance: null,
    activeCorrection
  };
}

function renderDialog(value: FiscalCorrectionData): string {
  return renderToStaticMarkup(createElement(FiscalCorrectionDialog, {
    open: true,
    data: value,
    protectedContext: {
      amountLabel: "$42.50",
      environmentLabel: "Pruebas",
      issuerLabel: "Misión ExampleOrganization"
    },
    busy: false,
    error: "",
    onCancel: vi.fn(),
    onSubmit: vi.fn(async () => undefined)
  }));
}

describe("fiscal correction dialog", () => {
  it("uses the shared structured contract and rejects unchanged or invalid drafts", () => {
    expect(dialogSource).toContain('from "../shared/fiscalCorrection"');

    expect(fiscalCorrectionFormState(domesticReceptor, domesticReceptor, null)).toMatchObject({
      changed: false,
      canSubmit: false,
      validationError: ""
    });
    expect(fiscalCorrectionFormState(
      domesticReceptor,
      { ...domesticReceptor, numDocumento: "12345678-9" },
      null
    )).toMatchObject({
      changed: false,
      canSubmit: false,
      validationError: expect.stringContaining("DUI válido")
    });
    expect(fiscalCorrectionFormState(
      domesticReceptor,
      { ...domesticReceptor, correo: "nueva@example.org" },
      null
    )).toMatchObject({
      changed: true,
      canSubmit: true,
      validationError: ""
    });
  });

  it("shows only safe read-only context and never renders protected edit controls", () => {
    const html = renderDialog(data());
    const renderedFieldNames = [...html.matchAll(/\sname="([^"]+)"/g)].map((match) => match[1]);

    expect(html).toContain("<dt>Monto</dt><dd>$42.50</dd>");
    expect(html).toContain("<dt>Ambiente</dt><dd>Pruebas</dd>");
    expect(html).toContain("<dt>Emisor</dt><dd>Misión ExampleOrganization</dd>");
    expect(renderedFieldNames).toEqual(expect.arrayContaining([
      "tipoDocumento",
      "numDocumento",
      "nombre",
      "correo",
      "telefono",
      "codDomiciliado",
      "departamento",
      "municipio",
      "distrito",
      "complemento"
    ]));
    for (const protectedName of [
      "amount",
      "amount_cents",
      "payment",
      "paymentReference",
      "issuer",
      "environment",
      "numeroControl",
      "codigoGeneracion",
      "plain_json",
      "rawJson"
    ]) {
      expect(renderedFieldNames).not.toContain(protectedName);
    }
    expect(html).not.toContain("Ver JSON");
  });

  it("renders domestic, foreign, and business fields only when applicable", () => {
    const domesticHtml = renderDialog(data());
    expect(domesticHtml).toContain('name="departamento"');
    expect(domesticHtml).toContain('name="municipio"');
    expect(domesticHtml).toContain('name="distrito"');
    expect(domesticHtml).not.toContain('name="codPais"');
    expect(domesticHtml).not.toContain('name="nrc"');
    expect(domesticHtml).not.toContain('name="codActividad"');

    const foreignHtml = renderDialog(data({
      ...domesticReceptor,
      tipoDocumento: "03",
      numDocumento: "P-A123456",
      codDomiciliado: 2,
      codPais: "GT",
      departamento: "00",
      municipio: "00",
      distrito: "00",
      complemento: "Zona 10, Ciudad de Guatemala"
    }));
    expect(foreignHtml).toContain('name="codPais"');
    expect(foreignHtml).toContain("Dirección en el extranjero");
    expect(foreignHtml).not.toContain('name="departamento"');
    expect(foreignHtml).not.toContain('name="municipio"');
    expect(foreignHtml).not.toContain('name="distrito"');

    const businessHtml = renderDialog(data({
      ...domesticReceptor,
      tipoDocumento: "36",
      numDocumento: "0614-010101-101-0",
      nrc: "2400001",
      codActividad: "94910",
      descActividad: "Actividades de organizaciones religiosas"
    }));
    expect(businessHtml).toContain('name="nrc"');
    expect(businessHtml).toContain('name="codActividad"');
    expect(businessHtml).toContain('name="descActividad"');
  });

  it("uses the approved guarded action and blocks it while a correction is active", () => {
    const initialHtml = renderDialog(data());
    expect(initialHtml).toContain("Guardar y reintentar");
    expect(initialHtml).toMatch(/<button[^>]*disabled=""[^>]*>Guardar y reintentar<\/button>/);

    for (const [status, label] of [
      ["QUEUED", "Corrección en cola"],
      ["PROCESSING", "Procesando corrección"],
      ["REVIEW_REQUIRED", "Revisión necesaria"]
    ] as const) {
      expect(fiscalCorrectionStatusLabel(status)).toBe(label);
      const html = renderDialog(data(domesticReceptor, { id: `correction-${status}`, status }));
      expect(html).toContain(label);
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Guardar y reintentar<\/button>/);
    }
  });

  it("is an accessible responsive modal using the existing visual tokens", () => {
    const html = renderDialog(data());
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="fiscal-correction-title"');
    expect(stylesSource).toContain(".fiscal-correction-dialog");
    expect(stylesSource).toContain(".fiscal-correction-grid");
    expect(stylesSource).toContain(".fiscal-correction-protected");
    expect(stylesSource).toContain(".fiscal-correction-reason");
    expect(stylesSource).toMatch(
      /@media \(max-width: 720px\) \{[\s\S]*?\.fiscal-correction-grid,[\s\S]*?grid-template-columns: 1fr;/
    );
  });
});

describe("Fallos fiscal correction wiring", () => {
  it("distinguishes deterministic donor errors from transient pre-CDE failures", () => {
    const deterministic = {
      issuance_error_code: "WOMPI_INVALID_DONOR_DUI",
      issuance_error_message: "Los datos del donante contienen un DUI inválido.",
      correction_available: true
    } as WompiIssuanceFailureItem;
    const transient = {
      issuance_error_code: "ISSUANCE_ERROR",
      issuance_error_message: "El proveedor no respondió.",
      correction_available: null
    } as WompiIssuanceFailureItem;
    const blocked = {
      issuance_error_code: "WOMPI_INVALID_DONOR_DUI",
      issuance_error_message: "Los datos del donante contienen un DUI inválido.",
      correction_available: false
    } as WompiIssuanceFailureItem;

    expect(isCorrectablePreCdeFailure(deterministic)).toBe(true);
    expect(isCorrectablePreCdeFailure(transient)).toBe(false);
    expect(isCorrectablePreCdeFailure(blocked)).toBe(false);
    expect(appSource).toContain("preCdeActionLabel(item, correctable, reviewRequired)");
    expect(appSource).toContain("isCorrectablePreCdeFailure(item)");
    expect(appSource).toContain("disabled={reviewRequired || retryQueued || actionBusy}");
  });

  it("corrects rejected content instead of blindly retrying its rejected JWS", () => {
    expect(appSource).toContain('selected.status === "REJECTED"');
    expect(appSource).toContain('onCorrect({ kind: "DTE_DOCUMENT", id: selected.id })');
    expect(appSource).toContain("Corregir y reintentar");
    expect(appSource).not.toContain('["SIGNED", "REJECTED", "FAILED", "CONTINGENCY_PENDING"]');
    expect(appSource).toContain('["SIGNED", "FAILED", "CONTINGENCY_PENDING"]');
  });

  it("loads and submits only the allowlisted receptor to the guarded endpoints", () => {
    expect(appSource).toContain("/correction-data");
    expect(appSource).toContain("/correct-and-retry");
    expect(appSource).toContain("body: { correctionRequestId, receptor }");
    expect(appSource).not.toContain("body: { correctionRequestId, receptor, protectedContext");
    expect(appSource).not.toContain("body: { correctionRequestId, receptor, document");
    expect(appSource).not.toContain("body: { correctionRequestId, receptor, event");
  });

  it("reuses the exact request UUID after an unknown failure, close, and reopen", () => {
    const ids = new Map<string, string>();
    const create = vi.fn()
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("70000003-2222-4222-8222-700000032222")
      .mockReturnValueOnce("33333333-3333-4333-8333-333333333333");

    const firstAttempt = fiscalCorrectionRequestIdForTarget(
      ids,
      "DTE_DOCUMENT:dte-1",
      create
    );
    expect(firstAttempt).toBe("11111111-1111-4111-8111-111111111111");

    // An unknown POST result and a user close are both non-definitive. Reopening
    // the same target must therefore retain the first action's request fence.
    expect(fiscalCorrectionRequestIdForTarget(ids, "DTE_DOCUMENT:dte-1", create))
      .toBe(firstAttempt);
    expect(create).toHaveBeenCalledTimes(1);

    // A different target owns a different fence.
    expect(fiscalCorrectionRequestIdForTarget(ids, "WOMPI_EVENT:event-2", create))
      .toBe("70000003-2222-4222-8222-700000032222");

    // Account/logout reset is allowed to clear every retained action.
    ids.clear();
    expect(fiscalCorrectionRequestIdForTarget(ids, "DTE_DOCUMENT:dte-1", create))
      .toBe("33333333-3333-4333-8333-333333333333");

    expect(appSource).toContain("const fiscalCorrectionRequestIds = useRef(new Map<string, string>())");
    expect(appSource).toContain("fiscalCorrectionRequestIdForTarget(");
    expect(appSource).toContain("if (isApiError(error))");
    expect(appSource).toContain("fiscalCorrectionRequestIds.current.delete(targetKey)");
    const closeBlock =
      appSource.match(/function closeFiscalCorrection\(\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(closeBlock).not.toContain("fiscalCorrectionRequestIds.current.delete");
    expect(dialogSource).toContain(
      "if (event.currentTarget === event.target && !busy) onCancel();"
    );
    expect(dialogSource).toContain(
      "if (!busyRef.current) onCancelRef.current();"
    );
    expect(dialogSource).toContain(
      '<button type="button" onClick={onCancel} disabled={busy}>'
    );
    const unknownFailureBlock =
      appSource.match(/else if \(!\(error instanceof StaleAccountStateError\)\) \{[\s\S]*?\n      \}/)?.[0] ?? "";
    expect(unknownFailureBlock).not.toContain("fiscalCorrectionRequestIds.current.delete");
  });

  it("clears correction state on account reset without disrupting an open dialog during detail refresh", () => {
    const resetBlock =
      appSource.match(/function resetAccountState\(\) \{[\s\S]*?\n  \}/)?.[0] ?? "";
    const detailEffect =
      appSource.match(/\/\/ The document list does not carry[\s\S]*?\n  \}, \[token, selected\?\.id, selectedDocumentDetailVersion\]\);/)?.[0] ?? "";

    expect(resetBlock).toContain("setFiscalCorrectionTarget(null)");
    expect(resetBlock).toContain("fiscalCorrectionRequestIds.current.clear()");
    expect(detailEffect).not.toContain("setFiscalCorrectionTarget(null)");
    expect(detailEffect).not.toContain("fiscalCorrectionRequestIds.current.clear()");
  });

  it("finds active correction state for both direct and Wompi-backed documents", () => {
    const selectedCorrectionEffect =
      appSource.match(/const shouldLoad =[\s\S]*?\n  \}, \[[\s\S]*?selectedDocumentDetailVersion[\s\S]*?\]\);/)?.[0] ?? "";

    expect(selectedCorrectionEffect).toContain(
      "`/api/documents/${documentId}/correction-data`"
    );
    expect(selectedCorrectionEffect).toContain(
      "`/api/wompi-events/${selected.wompi_event_id}/correction-data`"
    );
    expect(selectedCorrectionEffect).toContain("documentData.activeCorrection");
    expect(selectedCorrectionEffect).toContain("!selected?.wompi_event_id");
  });
});

describe("fiscal correction focus ownership", () => {
  function focusTarget(
    ownerDocument: { activeElement: unknown },
    connected = true
  ): HTMLElement {
    const target = {
      hidden: false,
      isConnected: connected,
      getAttribute: () => null,
      focus: vi.fn(() => {
        ownerDocument.activeElement = target;
      })
    };
    return target as unknown as HTMLElement;
  }

  it("wraps initial Shift+Tab and Tab without allowing focus outside", () => {
    const ownerDocument: { activeElement: unknown } = { activeElement: null };
    const first = focusTarget(ownerDocument);
    const last = focusTarget(ownerDocument);
    const outside = focusTarget(ownerDocument);
    const dialog = {
      ownerDocument,
      querySelectorAll: () => [first, last],
      contains: (element: unknown) => element === first || element === last,
      focus: vi.fn()
    } as unknown as HTMLElement;

    ownerDocument.activeElement = dialog;
    const initialShiftTab = {
      key: "Tab",
      shiftKey: true,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent;
    trapFiscalCorrectionDialogFocus(dialog, initialShiftTab);
    expect(initialShiftTab.preventDefault).toHaveBeenCalledOnce();
    expect(last.focus).toHaveBeenCalledOnce();

    ownerDocument.activeElement = outside;
    const escapedTab = {
      key: "Tab",
      shiftKey: false,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent;
    trapFiscalCorrectionDialogFocus(dialog, escapedTab);
    expect(escapedTab.preventDefault).toHaveBeenCalledOnce();
    expect(first.focus).toHaveBeenCalledOnce();

    ownerDocument.activeElement = last;
    const finalTab = {
      key: "Tab",
      shiftKey: false,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent;
    trapFiscalCorrectionDialogFocus(dialog, finalTab);
    expect(finalTab.preventDefault).toHaveBeenCalledOnce();
    expect(first.focus).toHaveBeenCalledTimes(2);
  });

  it("restores the connected opener and ignores a detached one", () => {
    const ownerDocument: { activeElement: unknown } = { activeElement: null };
    const connected = focusTarget(ownerDocument);
    const detached = focusTarget(ownerDocument, false);

    restoreFiscalCorrectionDialogFocus(connected);
    restoreFiscalCorrectionDialogFocus(detached);

    expect(connected.focus).toHaveBeenCalledOnce();
    expect(detached.focus).not.toHaveBeenCalled();
  });
});
