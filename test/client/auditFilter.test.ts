import { describe, expect, it } from "vitest";
import { filterAuditEntries } from "../../src/client/auditFilter";
import type { AuditRow } from "../../src/client/types";

describe("audit entry filtering", () => {
  const entries: AuditRow[] = [
    entry({ action: "LOGIN", summary: "owner@example.org", entity_type: "user" }),
    entry({ action: "DTE_INVALIDATED", summary: "PROCESADO", entity_type: "dte_document", entity_id: "dte_123" }),
    entry({ action: "EMAIL_SENT", summary: "Comprobante enviado a donante@example.org", entity_type: "dte_document" })
  ];

  it("returns everything for a blank query", () => {
    expect(filterAuditEntries(entries, "  ")).toHaveLength(3);
  });

  it("matches against the localized action label", () => {
    const result = filterAuditEntries(entries, "invalidado");
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe("DTE_INVALIDATED");
  });

  it("matches summary and entity id case-insensitively", () => {
    expect(filterAuditEntries(entries, "DONANTE@")).toHaveLength(1);
    expect(filterAuditEntries(entries, "dte_123")).toHaveLength(1);
  });
});

function entry(overrides: Partial<AuditRow>): AuditRow {
  return {
    id: "audit_x",
    actor_type: "USER",
    actor_id: "user_1",
    action: "LOGIN",
    entity_type: "user",
    entity_id: "entity_x",
    summary: "",
    metadata_json: "{}",
    created_at: "2026-07-04T00:00:00.000Z",
    ...overrides
  };
}
