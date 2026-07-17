import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as appModule from "../../src/client/App";

interface EmailAuditEvidence {
  action: string;
  summary: string;
  created_at: string;
}

type LatestReceiptEmailFailure = (audit: EmailAuditEvidence[]) => {
  summary: string;
  failedAt: string;
} | null;

const latestReceiptEmailFailure = (appModule as unknown as {
  latestReceiptEmailFailure?: LatestReceiptEmailFailure;
}).latestReceiptEmailFailure;
const receiptEmailFailureGuidance = (appModule as unknown as {
  receiptEmailFailureGuidance?: (outcome: string | null | undefined) => string;
}).receiptEmailFailureGuidance;

describe("latestReceiptEmailFailure", () => {
  it("returns the newest receipt-email failure", () => {
    expect(latestReceiptEmailFailure).toBeTypeOf("function");
    if (!latestReceiptEmailFailure) return;

    expect(latestReceiptEmailFailure([
      { action: "EMAIL_FAILED", summary: "fallo anterior", created_at: "2026-07-17T17:00:00.000Z" },
      { action: "DTE_ACCEPTED", summary: "aceptado", created_at: "2026-07-17T17:01:00.000Z" },
      { action: "EMAIL_RESEND_FAILED", summary: "proveedor rechazó el envío", created_at: "2026-07-17T17:02:00.000Z" }
    ])).toEqual({
      summary: "proveedor rechazó el envío",
      failedAt: "2026-07-17T17:02:00.000Z"
    });
  });

  it("clears an older failure after a successful receipt resend", () => {
    expect(latestReceiptEmailFailure).toBeTypeOf("function");
    if (!latestReceiptEmailFailure) return;

    expect(latestReceiptEmailFailure([
      { action: "EMAIL_RESENT", summary: "reenviado", created_at: "2026-07-17T17:03:00.000Z" },
      { action: "EMAIL_FAILED", summary: "proveedor rechazó el envío", created_at: "2026-07-17T17:02:00.000Z" }
    ])).toBeNull();
  });
});

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

    expect(appSource).toContain("latestReceiptEmailFailure(audit)");
    expect(appSource).toContain("Falló el envío del correo");
    expect(appSource).toContain("receiptEmailFailureGuidance(selected.receipt_email_outcome_class)");
    expect(appSource).toContain("Reenviar ahora");
    expect(appSource).toContain("{!emailFailure && (");
    expect(appSource).toContain("Reintentar DTE");
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
