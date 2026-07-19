import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource =
  readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8") +
  readFileSync(resolve(import.meta.dirname, "../../src/client/documentsView.tsx"), "utf8");
const typesSource = readFileSync(resolve(import.meta.dirname, "../../src/client/types.ts"), "utf8");
const reconciliationRunbook = readFileSync(resolve(import.meta.dirname, "../../docs/fiscal-claim-reconciliation.md"), "utf8");

describe("ambiguous fiscal outcome visibility", () => {
  it("surfaces the durable claim and blocks another operator mutation", () => {
    expect(typesSource).toContain("fiscal_operation_claim_id");
    expect(typesSource).toContain("fiscal_operation_claimed_at");
    expect(typesSource).toContain("fiscal_operation_kind");
    expect(typesSource).toContain("fiscal_operation_event_id");
    expect(appSource).toContain("Resultado fiscal pendiente de conciliación");
    expect(appSource).toMatch(/function isRetryableDocument[\s\S]*?fiscal_operation_claim_id/);
    expect(appSource).toMatch(/disabled=\{fiscalOutcomePending \|\| postAcceptFinalizationPending \|\| busy === "resend"\}/);
  });

  it("explains a terminal pre-dispatch correction quarantine without implying MH processed it", () => {
    expect(typesSource).toContain("FiscalReconciliationState");
    expect(appSource).toContain("fiscalReconciliation?: FiscalReconciliationState");
    expect(appSource).toContain("Requiere reconciliación");
    expect(appSource).toContain("fiscalReconciliation.failureMessage");
    expect(appSource).toContain("No use Reintentar DTE; revise y concilie este caso.");
    expect(appSource).toMatch(
      /fiscalReconciliation[\s\S]*?Requiere reconciliación[\s\S]*?no se transmitió a MH/
    );
    expect(appSource).toMatch(
      /fiscalReconciliation \?[\s\S]*?:[\s\S]*?MH pudo haber procesado/
    );
  });

  it("labels and counts correction-owned nonterminal documents in the failures view", () => {
    expect(appSource).toContain("Corrección por conciliar");
    expect(appSource).toMatch(
      /function isCorrectionReconciliationDocument[\s\S]*?fiscal_correction_[\s\S]*?PENDING[\s\S]*?SIGNED[\s\S]*?CONTINGENCY_PENDING/
    );
    expect(appSource).toContain("showCorrectionAttention={view === \"failures\"}");
    expect(appSource).toMatch(
      /onlyFailed\s*\?\s*documents\.length \+ preCdeFailureCount\s*:\s*\(counts\.FAILED/
    );
  });

  it("documents the three exact reconciliation outcomes and D1-compatible atomic execution", () => {
    expect(reconciliationRunbook).toContain("Outcome 1: still unknown");
    expect(reconciliationRunbook).toContain("Outcome 2: MH confirms NOT_RECEIVED");
    expect(reconciliationRunbook).toContain("Outcome 3: MH confirms a definitive result");
    expect(reconciliationRunbook).toContain("env.DB.batch([...])");
    expect(reconciliationRunbook).toContain("exact claim id");
    expect(reconciliationRunbook).toContain("fiscal_operation_kind = 'INVALIDATION'");
    expect(reconciliationRunbook).toContain("exact `fiscal_operation_event_id`");
    expect(reconciliationRunbook).toContain("event update, document update, and audit insert must each report `changes = 1`");
    expect(reconciliationRunbook).toContain("FISCAL_CLAIM_RELEASED_AFTER_RECONCILIATION");
    expect(reconciliationRunbook).toContain("Never use a latest-event query, partial direct edit, or bulk claim clear");
  });
});
