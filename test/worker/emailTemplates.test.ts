import { describe, expect, it } from "vitest";
import { EMAIL_TEMPLATE_DEFINITIONS } from "../../src/worker/services/emailTemplates";
import { certificateEmailHtml, dteEmailHtml, passwordResetEmailHtml } from "../../src/worker/services/emailHtml";
import type { DteDocumentRecord } from "../../src/worker/types";

function fakeRecord(): DteDocumentRecord {
  return {
    id: "doc_1",
    status: "ACCEPTED",
    environment: "01",
    donor_name: "Ana",
    numero_control: "DTE-15-0001-000000000000001",
    codigo_generacion: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    amount_cents: 5000,
    issued_at: "2026-06-01T12:00:00.000Z",
    sello_recibido: "SELLO123",
    transmission_deferred_at: null,
    plain_json: "{}"
  } as unknown as DteDocumentRecord;
}

import { readFileSync as __readEmailHtmlSource } from "node:fs";
import { resolve as __resolveEmailHtml } from "node:path";

describe("email support contact", () => {
  it("keeps the fmce default as the footer fallback in source", () => {
    // legacy-contact-1@example.com is the default support contact for both lanes; the shared
    // emailDocument chrome renders it when a church has not configured its own.
    const emailHtmlSource = __readEmailHtmlSource(
      __resolveEmailHtml(import.meta.dirname, "../../src/worker/services/emailHtml.ts"),
      "utf8"
    );
    expect(emailHtmlSource).toContain("SUPPORT_EMAIL");
    expect(emailHtmlSource).toContain("legacy-contact-1@example.com");
    expect(emailHtmlSource).toContain("mailto:");
  });

  it("renders the fmce default in every footer when no support email is configured", () => {
    const receipt = dteEmailHtml(fakeRecord(), "Gracias.", { organizationName: "ExamplePerson1" });
    const reset = passwordResetEmailHtml("Ana", "https://example.org/?reset=abc", 30, { organizationName: "ExamplePerson1" });
    const certificate = certificateEmailHtml({
      organizationName: "MISION EXAMPLEORGANIZATION",
      donorName: "Ana",
      year: 2025,
      count: 1,
      totalLabel: "$25.00",
      isTestEnvironment: false
    });
    for (const html of [receipt, reset, certificate]) {
      expect(html).toContain("mailto:legacy-contact-1@example.com");
      expect(html).toContain(">legacy-contact-1@example.com<");
    }
  });

  it("renders the configured support email in the footer when set", () => {
    const supportEmail = "legacy-email-119@example.com";
    const receipt = dteEmailHtml(fakeRecord(), "Gracias.", { organizationName: "Iglesia Central", supportEmail });
    const reset = passwordResetEmailHtml("Ana", "https://example.org/?reset=abc", 30, {
      organizationName: "Iglesia Central",
      supportEmail
    });
    const certificate = certificateEmailHtml({
      organizationName: "Iglesia Central",
      donorName: "Ana",
      year: 2025,
      count: 1,
      totalLabel: "$25.00",
      isTestEnvironment: false,
      supportEmail
    });
    for (const html of [receipt, reset, certificate]) {
      expect(html).toContain(`mailto:${supportEmail}`);
      expect(html).toContain(`>${supportEmail}<`);
      expect(html).not.toContain("legacy-contact-1@example.com");
    }
  });
});

describe("email template defaults", () => {
  it("spells out the tax authority in donor-facing defaults", () => {
    const invalidation = EMAIL_TEMPLATE_DEFINITIONS.find((definition) => definition.type === "dteInvalidation");

    expect(invalidation?.defaultBody).toContain("ante el Ministerio de Hacienda");
    expect(invalidation?.defaultBody).not.toContain("ante MH");
  });
});

describe("certificateEmailHtml", () => {
  it("greets the donor formally, states the year total, and notes the attachment", () => {
    const html = certificateEmailHtml({
      organizationName: "MISION EXAMPLEORGANIZATION",
      donorName: "Ana",
      year: 2025,
      count: 2,
      totalLabel: "$100.01",
      isTestEnvironment: false
    });

    expect(html).toContain("Estimado(a) Ana");
    expect(html).toContain("2025");
    expect(html).toContain("$100.01");
    expect(html).toContain("Se adjunta la constancia anual en formato PDF.");
    expect(html).not.toContain("sin validez fiscal");
  });

  it("adds the test-environment disclaimer when the year mixes ambiente 00 documents", () => {
    const html = certificateEmailHtml({
      organizationName: "MISION EXAMPLEORGANIZATION",
      donorName: "Ana",
      year: 2025,
      count: 1,
      totalLabel: "$25.00",
      isTestEnvironment: true
    });

    expect(html).toContain("no tiene validez fiscal");
  });
});

describe("branding-aware email chrome", () => {
  it("paints the receipt header with a custom accent color and organization name", () => {
    const html = dteEmailHtml(fakeRecord(), "Gracias por su donación.", {
      organizationName: "Iglesia Central",
      brandColor: "#123abc"
    });

    expect(html).toContain("#123abc");
    expect(html).toContain("Iglesia Central");
    expect(html).not.toContain("ExamplePerson1");
  });

  it("falls back to the historical brand color and name when unset", () => {
    const html = dteEmailHtml(fakeRecord(), "Gracias.", { organizationName: "ExamplePerson1" });

    expect(html).toContain("#0f766e");
    expect(html).toContain("ExamplePerson1");
  });

  it("uses the organization name and accent in the password-reset email", () => {
    const html = passwordResetEmailHtml("Ana", "https://example.org/?reset=abc", 30, {
      organizationName: "Iglesia Central",
      brandColor: "#123abc"
    });

    expect(html).toContain("Iglesia Central");
    expect(html).toContain("#123abc");
    expect(html).not.toContain("ExamplePerson1");
  });
});
