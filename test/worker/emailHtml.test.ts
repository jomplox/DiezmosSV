import { describe, expect, it } from "vitest";
import { certificateEmailHtml, dteEmailHtml, editableDonorEmailHtml, operationalAlertHtml, passwordResetEmailHtml } from "../../src/worker/services/emailHtml";
import type { DteDocumentRecord } from "../../src/worker/types";

const LOGO_URL = "https://iglesia.example.org/api/branding/logo?v=v9";

describe("HTML email rendering", () => {
  it("signals a light-only color scheme on every generated HTML email", () => {
    const htmlEmails = [
      dteEmailHtml(record(), "Cuerpo", { organizationName: "Misión ExampleOrganization" }),
      dteEmailHtml(record({ status: "INVALIDATED" }), "Cuerpo", { organizationName: "Misión ExampleOrganization" }),
      passwordResetEmailHtml("José", "https://example.org/?reset=tok", 45, { organizationName: "Misión ExampleOrganization" }),
      operationalAlertHtml(
        {
          kind: "DTE_FAILED",
          title: "Fallo al emitir DTE",
          detail: "Detalle",
          entityType: "dte_document",
          entityId: "dte_1"
        },
        "https://example.org/",
        { organizationName: "Misión ExampleOrganization" }
      ),
      certificateEmailHtml({
        organizationName: "Misión ExampleOrganization",
        donorName: "María",
        year: 2026,
        count: 3,
        totalLabel: "$100.00",
        isTestEnvironment: false
      }),
      editableDonorEmailHtml({
        organizationName: "Misión ExampleOrganization",
        title: "Constancia anual de donaciones — EE. UU.",
        bodyText: "Estimada María:\n\nAdjuntamos su constancia anual de 2025 por $75.00."
      })
    ];

    for (const html of htmlEmails) {
      expect(html).toContain('<meta name="color-scheme" content="only light" />');
      expect(html).toContain(":root { color-scheme: only light; }");
    }
  });

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

  it("keeps the U.S. annual email materially separate from the SV fiscal dossier", () => {
    const html = editableDonorEmailHtml({
      organizationName: "Misión ExampleOrganization",
      title: "Constancia anual corregida de donaciones — EE. UU.",
      bodyText:
        "Estimada María:\n\nAdjuntamos su constancia anual corregida de 2025 por $75.00.\n\n"
        + "No se proporcionaron bienes ni servicios a cambio de estas donaciones.\n\n"
        + "Conserve este documento con sus registros."
    });

    expect(html).toContain("Constancia anual corregida de donaciones — EE. UU.");
    expect(html).toContain("No se proporcionaron bienes ni servicios");
    expect(html).toContain("registros");
    expect(html).not.toMatch(/Ministerio de Hacienda|\bMH\b|\bCDE\b|validez fiscal/i);
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

  it("renders the supported formatting in an editable Salvadoran template body", () => {
    const html = dteEmailHtml(
      record(),
      "**Negrita** y *cursiva* y ++subrayado++\n\n> Una cita\n> en dos líneas",
      { organizationName: "Iglesia" }
    );

    expect(html).toContain("<strong>Negrita</strong>");
    expect(html).toContain("<em>cursiva</em>");
    expect(html).toContain("<u>subrayado</u>");
    expect(html).toContain("<blockquote");
    expect(html).toContain("Una cita<br />en dos líneas");
  });

  it("renders the supported formatting in an editable U.S. template without accepting raw HTML", () => {
    const html = editableDonorEmailHtml({
      organizationName: "Iglesia",
      title: "Constancia",
      bodyText: "**Negrita** *cursiva* ++subrayado++\n\n> Cita <script>alert(1)</script>"
    });

    expect(html).toContain("<strong>Negrita</strong>");
    expect(html).toContain("<em>cursiva</em>");
    expect(html).toContain("<u>subrayado</u>");
    expect(html).toContain("<blockquote");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders the password reset email with a button link and expiry", () => {
    const html = passwordResetEmailHtml("José", "https://example.org/?reset=tok", 45);

    expect(html).toContain("<!DOCTYPE html");
    expect(html).toContain("José");
    expect(html).toContain('href="https://example.org/?reset=tok"');
    expect(html).toContain("45 minutos");
  });

  it("renders an operational alert with a red banner for failure kinds", () => {
    const html = operationalAlertHtml(
      {
        kind: "DTE_FAILED",
        title: "Fallo al emitir DTE",
        detail: "El documento DTE-15-M001P004-000000000000009 falló: MH no disponible",
        entityType: "dte_document",
        entityId: "dte_1"
      },
      "https://worker.example.invalid/"
    );

    expect(html).toContain("<!DOCTYPE html");
    expect(html).toContain("Fallo al emitir DTE");
    expect(html).toContain("El documento DTE-15-M001P004-000000000000009 falló: MH no disponible");
    expect(html).toContain("dte_1");
    expect(html).toContain("https://worker.example.invalid/");
    expect(html).toContain("#fdecec");
  });

  it("renders an operational alert with an amber banner for contingency kinds", () => {
    const html = operationalAlertHtml(
      {
        kind: "CONTINGENCY_OPENED",
        title: "Contingencia abierta",
        detail: "Se abrió un período de contingencia automáticamente: MH no disponible",
        entityType: "contingency_period",
        entityId: "cont_1"
      },
      "https://worker.example.invalid/"
    );

    expect(html).toContain("Contingencia abierta");
    expect(html).toContain("#fdf3e1");
    expect(html).not.toContain("#fdecec");
  });
});

describe("HTML email header logo", () => {
  it("protects the branded header from Gmail dark-mode color inversion", () => {
    const html = dteEmailHtml(record(), "Cuerpo", {
      organizationName: "Misión ExampleOrganization",
      brandColor: "#000000",
      logoUrl: LOGO_URL
    });

    expect(html).toContain('bgcolor="#000000"');
    expect(html).toContain("background-color:#000000");
    expect(html).toContain("background-image:linear-gradient(#000000,#000000)");
  });

  it("renders the absolute logo image above the organization name on a receipt when a logoUrl is set", () => {
    const html = dteEmailHtml(record(), "Cuerpo", { organizationName: "Misión ExampleOrganization", logoUrl: LOGO_URL });

    expect(html).toContain(`src="${LOGO_URL}"`);
    // Alt text is the organization name, so a client that blocks the image still identifies the sender.
    expect(html).toContain('alt="Misión ExampleOrganization"');
    // The name text stays as the reliable identifier below the (blockable) image.
    expect(html).toContain("Misión ExampleOrganization");
    // Email-safe inline sizing: block + auto margins, capped dimensions.
    expect(html).toMatch(/max-height:\s*64px/);
    expect(html).toMatch(/max-width:\s*240px/);
    expect(html).toMatch(/display:\s*block/);
    // The logo sits before the name in the header markup.
    expect(html.indexOf(`src="${LOGO_URL}"`)).toBeLessThan(html.indexOf("Misión ExampleOrganization"));
  });

  it("renders no header image on a receipt when there is no logoUrl (exactly today's output)", () => {
    const html = dteEmailHtml(record(), "Cuerpo", { organizationName: "Misión ExampleOrganization" });

    expect(html).not.toContain("<img");
    expect(html).toContain("Misión ExampleOrganization");
  });

  it("escapes the organization name used as the logo alt text", () => {
    const html = dteEmailHtml(record(), "Cuerpo", { organizationName: 'Iglesia "X" & <Y>', logoUrl: LOGO_URL });

    expect(html).not.toContain('alt="Iglesia "X"');
    expect(html).toContain("&quot;");
    expect(html).toContain("&amp;");
  });

  it("renders the header logo on the password reset email when a logoUrl is set", () => {
    const html = passwordResetEmailHtml("José", "https://example.org/?reset=tok", 45, {
      organizationName: "Misión ExampleOrganization",
      logoUrl: LOGO_URL
    });

    expect(html).toContain(`src="${LOGO_URL}"`);
    expect(html).toContain('alt="Misión ExampleOrganization"');
  });

  it("renders no header image on the password reset email when there is no logoUrl", () => {
    const html = passwordResetEmailHtml("José", "https://example.org/?reset=tok", 45, { organizationName: "Misión ExampleOrganization" });

    expect(html).not.toContain("<img");
  });

  it("renders the header logo on the annual certificate email when a logoUrl is set", () => {
    const html = certificateEmailHtml({
      organizationName: "Misión ExampleOrganization",
      donorName: "María",
      year: 2026,
      count: 3,
      totalLabel: "$100.00",
      isTestEnvironment: false,
      logoUrl: LOGO_URL
    });

    expect(html).toContain(`src="${LOGO_URL}"`);
    expect(html).toContain('alt="Misión ExampleOrganization"');
  });

  it("renders no header image on the annual certificate email when there is no logoUrl", () => {
    const html = certificateEmailHtml({
      organizationName: "Misión ExampleOrganization",
      donorName: "María",
      year: 2026,
      count: 3,
      totalLabel: "$100.00",
      isTestEnvironment: false
    });

    expect(html).not.toContain("<img");
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

describe("email header strapline context", () => {
  it("keeps the CDE strapline on receipt and invalidation emails", () => {
    expect(dteEmailHtml(record(), "Cuerpo", { organizationName: "Iglesia" })).toContain("Comprobante de Donación Electrónico");
    expect(dteEmailHtml(record({ status: "INVALIDATED" }), "Cuerpo", { organizationName: "Iglesia" })).toContain("Comprobante de Donación Electrónico");
  });

  it("labels the password reset email as panel access, not a CDE", () => {
    const html = passwordResetEmailHtml("José", "https://example.org/?reset=tok", 45, { organizationName: "Iglesia" });

    expect(html).toContain("Panel de administración");
    expect(html).not.toContain("Comprobante de Donación Electrónico");
  });

  it("labels operational alerts as alerts, not a CDE", () => {
    const html = operationalAlertHtml(
      { kind: "DTE_FAILED", title: "Fallo al emitir DTE", detail: "Detalle", entityType: "dte_document", entityId: "dte_1" },
      "https://example.org/",
      { organizationName: "Iglesia" }
    );

    expect(html).toContain("Alerta operativa");
    expect(html).not.toContain("Comprobante de Donación Electrónico");
  });

  it("labels the annual certificate email and frames it as an informative backup", () => {
    const html = certificateEmailHtml({
      organizationName: "Iglesia",
      donorName: "María",
      year: 2026,
      count: 3,
      totalLabel: "$100.00",
      isTestEnvironment: false
    });

    expect(html).toContain("Constancia anual de donaciones");
    expect(html).toContain("respaldo informativo");
    expect(html).not.toContain("Comprobante de Donación Electrónico");
  });
});
