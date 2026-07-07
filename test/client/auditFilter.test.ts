import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("matches on the resolved actor name, email, and IP", () => {
    const withActor: AuditRow[] = [
      entry({ action: "USER_UPDATED", actor_name: "Ada Admin", actor_email: "ada@example.org", actor_ip: "190.86.1.2" }),
      entry({ action: "LOGIN", actor_name: "Bob Viewer", actor_email: "bob@example.org", actor_ip: "10.0.0.9" })
    ];
    expect(filterAuditEntries(withActor, "ada admin")).toHaveLength(1);
    expect(filterAuditEntries(withActor, "bob@example.org")).toHaveLength(1);
    expect(filterAuditEntries(withActor, "190.86.1.2")).toHaveLength(1);
  });

  it("pages the audit trail with a keyset cursor and a Cargar más control", () => {
    const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");
    // First page + cursor on refresh; older pages append via the cursor param.
    expect(appSource).toContain('api<{ audit: AuditRow[]; nextCursor: string | null }>("/api/audit?limit=50"');
    expect(appSource).toContain("cursor=${encodeURIComponent(auditCursor)}");
    expect(appSource).toContain("Cargar más");
    // The filter hint clarifies it searches the LOADED rows.
    expect(appSource).toContain("registros cargados");
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
