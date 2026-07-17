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
  it("renders the failed delivery and recovery action in the document detail panel", () => {
    const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");

    expect(appSource).toContain("latestReceiptEmailFailure(audit)");
    expect(appSource).toContain("Falló el envío del correo");
    expect(appSource).toContain("Use “Reenviar correo” para intentarlo de nuevo.");
  });
});
