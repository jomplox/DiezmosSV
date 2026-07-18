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
      issuance_error_message: "Los datos del donante contienen un DUI inválido."
    } as WompiIssuanceFailureItem;
    const transient = {
      issuance_error_code: "ISSUANCE_ERROR",
      issuance_error_message: "El proveedor no respondió."
    } as WompiIssuanceFailureItem;

    expect(isCorrectablePreCdeFailure(deterministic)).toBe(true);
    expect(isCorrectablePreCdeFailure(transient)).toBe(false);
    expect(appSource).toContain('"Corregir y reintentar"');
    expect(appSource).toContain('"Reintentar creación"');
    expect(appSource).toContain("isCorrectablePreCdeFailure(item)");
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

  it("keeps one request UUID through unknown network failures and clears it after a response", () => {
    const ids = new Map<string, string>();
    const create = vi.fn()
      .mockReturnValueOnce("11111111-1111-4111-8111-111111111111")
      .mockReturnValueOnce("70000003-2222-4222-8222-700000032222");

    expect(fiscalCorrectionRequestIdForTarget(ids, "DTE_DOCUMENT:dte-1", create))
      .toBe("11111111-1111-4111-8111-111111111111");
    expect(fiscalCorrectionRequestIdForTarget(ids, "DTE_DOCUMENT:dte-1", create))
      .toBe("11111111-1111-4111-8111-111111111111");
    expect(create).toHaveBeenCalledTimes(1);
    ids.delete("DTE_DOCUMENT:dte-1");
    expect(fiscalCorrectionRequestIdForTarget(ids, "DTE_DOCUMENT:dte-1", create))
      .toBe("70000003-2222-4222-8222-700000032222");

    expect(appSource).toContain("const fiscalCorrectionRequestIds = useRef(new Map<string, string>())");
    expect(appSource).toContain("fiscalCorrectionRequestIdForTarget(");
    expect(appSource).toContain("if (isApiError(error))");
    expect(appSource).toContain("fiscalCorrectionRequestIds.current.delete(targetKey)");
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
