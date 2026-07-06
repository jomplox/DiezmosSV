import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");
const stylesSource = readFileSync(resolve(import.meta.dirname, "../../src/client/styles.css"), "utf8");

describe("Auditoría actor/context UI contract", () => {
  it("renders a Usuario column and an IP column in the audit table header", () => {
    expect(appSource).toContain("<th>Usuario</th>");
    expect(appSource).toContain("<th>IP</th>");
  });

  it("resolves the actor via the shared display helper and shows the captured IP", () => {
    expect(appSource).toContain("auditActorLabel(row)");
    expect(appSource).toContain("{row.actor_ip ?? \"—\"}");
  });

  it("exposes the request context in an expandable detail with Spanish labels", () => {
    expect(appSource).toContain("AuditContextDetail");
    expect(appSource).toContain("parseAuditContext(row.actor_context)");
    expect(appSource).toContain("AUDIT_CONTEXT_LABELS.location");
    expect(appSource).toContain("AUDIT_CONTEXT_LABELS.isp");
    expect(appSource).toContain("AUDIT_CONTEXT_LABELS.browser");
    // The raw user-agent is shown truncated with a title tooltip (no UA-parsing library).
    expect(appSource).toContain("title: context.userAgent");
  });

  it("styles the audit context detail block", () => {
    expect(stylesSource).toContain(".audit-context-grid");
    expect(stylesSource).toContain(".audit-expand-toggle");
    expect(stylesSource).toContain(".audit-actor");
  });
});
