import { describe, expect, it } from "vitest";
import { projectAuditRows } from "../../src/worker/services/auditProjection";

const userRow = {
  id: "audit_user",
  actor_type: "USER",
  actor_id: "owner_1",
  actor_name: "Owner Name",
  actor_email: "owner@example.org",
  actor_ip: "203.0.113.9",
  actor_context: "{\"country\":\"SV\"}",
  action: "USER_CREATED",
  entity_type: "user",
  entity_id: "new_user_1",
  summary: "new.user@example.org",
  metadata_json: "{\"email\":\"new.user@example.org\"}",
  created_at: "2026-07-09T12:00:00.000Z"
};

const documentRow = {
  ...userRow,
  id: "audit_document",
  action: "DTE_ACCEPTED",
  entity_type: "dte_document",
  entity_id: "doc_1",
  summary: "DTE accepted",
  metadata_json: "{\"status\":\"PROCESADO\"}"
};

describe("audit audience projection", () => {
  it.each(["ADMIN", "OWNER"] as const)("preserves full rows for %s", (role) => {
    const projected = projectAuditRows([userRow], role);
    expect(projected).toEqual([userRow]);
  });

  it.each(["VIEWER", "OPERATOR"] as const)("redacts transport telemetry for every %s row", (role) => {
    const [projected] = projectAuditRows([documentRow], role);
    expect(projected).toMatchObject({
      actor_email: null,
      actor_ip: null,
      actor_context: null,
      actor_id: "owner_1",
      actor_name: "Owner Name",
      entity_id: "doc_1",
      summary: "DTE accepted",
      metadata_json: "{\"status\":\"PROCESADO\"}"
    });
  });

  it.each(["VIEWER", "OPERATOR"] as const)("removes account identities and payloads from %s user audits", (role) => {
    const [projected] = projectAuditRows([userRow], role);
    expect(projected).toMatchObject({
      actor_id: null,
      actor_name: null,
      actor_email: null,
      actor_ip: null,
      actor_context: null,
      entity_id: null,
      summary: "Usuario creado",
      metadata_json: "{}"
    });
    expect(projected).toMatchObject({ id: "audit_user", action: "USER_CREATED", entity_type: "user", created_at: userRow.created_at });
    expect(JSON.stringify(projected)).not.toContain("example.org");
  });

  it("uses a fixed fallback summary for an unknown user action", () => {
    const [projected] = projectAuditRows([{ ...userRow, action: "FUTURE_USER_ACTION", summary: "secret" }], "VIEWER");
    expect(projected.summary).toBe("Actividad de cuenta registrada");
  });
});
