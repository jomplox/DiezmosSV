import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as appModule from "../../src/client/App";

const receiptEmailFailureGuidance = (appModule as unknown as {
  receiptEmailFailureGuidance?: (outcome: string | null | undefined) => string;
}).receiptEmailFailureGuidance;

describe("document email failure notice", () => {
  it("explains safe rejection, delivery failure, and ambiguous provider outcomes", () => {
    expect(receiptEmailFailureGuidance).toBeTypeOf("function");
    if (!receiptEmailFailureGuidance) return;

    expect(receiptEmailFailureGuidance("NOT_SENT")).toContain("antes de enviarlo");
    expect(receiptEmailFailureGuidance("NOT_DELIVERED")).toContain("no pudo entregarse");
    expect(receiptEmailFailureGuidance("UNKNOWN")).toContain("No podemos confirmar");
    expect(receiptEmailFailureGuidance(null)).toContain("intento de envío falló");
  });

  it("renders the failed delivery and its recovery action inside the warning", () => {
    const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");

    expect(appSource).toContain('receiptEmailDelivery?.status === "FAILED"');
    expect(appSource).toContain("Falló el envío del correo");
    expect(appSource).toContain("receiptEmailFailureGuidance(emailFailure.outcomeClass)");
    expect(appSource).toContain("Reenviar ahora");
    expect(appSource).toContain("{!emailFailure && (");
    expect(appSource).toContain("Reintentar DTE");
    expect(appSource).not.toContain("latestReceiptEmailFailure(audit)");
  });

  it("refreshes authoritative delivery state after a resend without changing selection", () => {
    const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");

    expect(appSource).toContain("receiptEmailDelivery?: ReceiptEmailDeliveryState");
    expect(appSource).toContain("setSelectedReceiptEmailDelivery(detail.receiptEmailDelivery ?? null)");
    expect(appSource).toContain("setSelectedDocumentDetailVersion((current) => current + 1)");
    expect(appSource).toContain("selectedDocumentDetailVersion");
  });

  it("marks accepted receipt failures in the document list and failure metric", () => {
    const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");

    expect(appSource).toContain("Correo fallido");
    expect(appSource).toContain('document.receipt_email_status === "FAILED"');
  });

  it("reuses one resend request ID until the server confirms success", () => {
    const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");

    expect(appSource).toContain("const resendRequestIds = useRef(new Map<string, string>())");
    expect(appSource).toContain("resendRequestIds.current.get(target.id) ?? crypto.randomUUID()");
    expect(appSource).toContain("? { resendRequestId }");
    expect(appSource).toContain("resendRequestIds.current.delete(target.id)");
  });
});
