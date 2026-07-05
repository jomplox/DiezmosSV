import { describe, expect, it } from "vitest";
import { dteEmailHtml, passwordResetEmailHtml } from "../../src/worker/services/emailHtml";
import type { DteDocumentRecord } from "../../src/worker/types";

describe("HTML email rendering", () => {
  it("renders a branded receipt with the document details card", () => {
    const html = dteEmailHtml(record(), "Hola María:\n\nGracias por su donación de $25.50.", { organizationName: "Misión ExampleOrganization" });

    expect(html).toContain("<!DOCTYPE html");
    expect(html).toContain("Misión ExampleOrganization");
    expect(html).toContain("Gracias por su donación de $25.50.");
    expect(html).toContain("DTE-15-M001P004-000000000000009");
    expect(html).toContain("6CAE5F7E-A590-4573-8EF2-FE48B14796C4");
    expect(html).toContain("$25.50");
    expect(html).not.toContain("{{");
  });

  it("marks test-environment documents as having no fiscal validity", () => {
    const html = dteEmailHtml(record({ environment: "00" }), "Cuerpo", { organizationName: "Iglesia" });

    expect(html).toContain("ambiente de pruebas");
  });

  it("shows an INVALIDADO banner for invalidated documents", () => {
    const html = dteEmailHtml(record({ status: "INVALIDATED" }), "Cuerpo", { organizationName: "Iglesia" });

    expect(html).toContain("INVALIDADO");
  });

  it("escapes HTML in interpolated values", () => {
    const html = dteEmailHtml(record({ donor_name: "<script>alert(1)</script>" }), "Cuerpo con <b>etiquetas</b>", { organizationName: "Iglesia <XSS>" });

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("Cuerpo con <b>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Iglesia &lt;XSS&gt;");
  });

  it("renders the password reset email with a button link and expiry", () => {
    const html = passwordResetEmailHtml("José", "https://example.org/?reset=tok", 45);

    expect(html).toContain("<!DOCTYPE html");
    expect(html).toContain("José");
    expect(html).toContain('href="https://example.org/?reset=tok"');
    expect(html).toContain("45 minutos");
  });
});

function record(overrides: Partial<DteDocumentRecord> = {}): DteDocumentRecord {
  return {
    id: "dte_1",
    wompi_event_id: "wompi_1",
    tipo_dte: "15",
    environment: "01",
    codigo_generacion: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4",
    numero_control: "DTE-15-M001P004-000000000000009",
    status: "ACCEPTED",
    plain_json: "{}",
    signed_jws: null,
    sello_recibido: "2026SELLO123",
    mh_estado: "PROCESADO",
    mh_observaciones_json: "[]",
    donor_email: "donante@example.org",
    donor_name: "María de Prueba",
    amount_cents: 2550,
    issued_at: "2026-07-04T18:00:00.000Z",
    accepted_at: "2026-07-04T18:00:05.000Z",
    contingency_period_id: null,
    created_at: "2026-07-04T18:00:00.000Z",
    updated_at: "2026-07-04T18:00:05.000Z",
    ...overrides
  } as DteDocumentRecord;
}
