import { describe, expect, it, vi } from "vitest";
import { makeDocument } from "./fixtures";
import {
  DEFAULT_EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_DEFINITIONS,
  normalizeEmailTemplateSettings,
  renderEmailTemplate,
  TRANSITORIO_RECEIPT_TEMPLATE
} from "../../src/worker/services/emailTemplates";
import { classifyEmailDispatchError, EmailService } from "../../src/worker/services/email";
import { certificateEmailHtml, dteEmailHtml, passwordResetEmailHtml } from "../../src/worker/services/emailHtml";
import type { DteDocumentRecord, Env } from "../../src/worker/types";

function fakeRecord(): DteDocumentRecord {
  return makeDocument({
    environment: "01",
    donor_name: "Ana",
    numero_control: "DTE-15-0001-000000000000001",
    codigo_generacion: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
    amount_cents: 5000,
    issued_at: "2026-06-01T12:00:00.000Z",
    sello_recibido: "SELLO123",
    plain_json: "{}"
  });
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

describe("transitory (deferred) receipt template", () => {
  // A deferred CDE (SIGNED + transmission_deferred_at) is emailed BEFORE MH acceptance,
  // with a PDF that lacks a real sello_recibido. The default dteReceipt copy asserts the
  // attachment already carries an MH reception seal, which would be a false claim on a
  // transitorio. The fixed transitory template must never make that claim.
  function deferredRecord(): DteDocumentRecord {
    return {
      id: "doc_defer",
      status: "SIGNED",
      environment: "00",
      donor_name: "Ana",
      donor_email: "ana@example.org",
      numero_control: "DTE-15-0001-000000000000042",
      codigo_generacion: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
      amount_cents: 5000,
      issued_at: "2026-06-01T12:00:00.000Z",
      sello_recibido: null,
      transmission_deferred_at: "2026-06-01T12:01:00.000Z",
      plain_json: "{}"
    } as unknown as DteDocumentRecord;
  }

  const FALSE_SELLO_CLAIM = "con Sello de Recepción del Ministerio de Hacienda";

  it("frames the deferred receipt as provisional without claiming an MH sello", () => {
    const message = renderEmailTemplate(TRANSITORIO_RECEIPT_TEMPLATE, deferredRecord());

    expect(message.subject).toContain("(en trámite)");
    expect(message.text).toContain("TRANSITORIA");
    expect(message.text).toContain("en trámite");
    // The definitive sello is promised for the FUTURE, never asserted as already obtained.
    expect(message.text).toContain("en cuanto el Ministerio de Hacienda lo confirme");
    expect(message.text).not.toContain(FALSE_SELLO_CLAIM);
  });

  it("keeps the default dteReceipt copy (used only for accepted docs) claiming the sello", () => {
    // The default receipt is correct for its own use — an ACCEPTED CDE really has a sello.
    // This locks the contrast that the transitory template above must not reuse it.
    expect(DEFAULT_EMAIL_TEMPLATES.dteReceipt.body).toContain(FALSE_SELLO_CLAIM);
  });
});

describe("email template defaults", () => {
  it("spells out the tax authority in donor-facing defaults", () => {
    const invalidation = EMAIL_TEMPLATE_DEFINITIONS.find((definition) => definition.type === "dteInvalidation");

    expect(invalidation?.defaultBody).toContain("ante el Ministerio de Hacienda");
    expect(invalidation?.defaultBody).not.toContain("ante MH");
  });

  it("includes the numero de control in the default receipt subject", () => {
    const message = renderEmailTemplate(DEFAULT_EMAIL_TEMPLATES.dteReceipt, fakeRecord());

    expect(message.subject).toBe("Comprobante de su donación DTE-15-0001-000000000000001");
  });

  it("tells the donor what to expect after an invalidation", () => {
    const invalidation = EMAIL_TEMPLATE_DEFINITIONS.find((definition) => definition.type === "dteInvalidation");

    expect(invalidation?.defaultBody).toContain("comprobante corregido, lo recibirá en un correo aparte");
    expect(invalidation?.defaultBody).toContain("Si no esperaba esta invalidación");
  });
});

describe("email subject boundary", () => {
  it("rejects control characters when an operator saves a subject", () => {
    expect(() =>
      normalizeEmailTemplateSettings({
        dteReceipt: { subject: "Receipt\r\nBcc: attacker@example.org", body: "Body" },
        dteInvalidation: { ...DEFAULT_EMAIL_TEMPLATES.dteInvalidation }
      })
    ).toThrow(/asunto/i);
    expect(() =>
      normalizeEmailTemplateSettings({
        dteReceipt: { subject: `Receipt${String.fromCharCode(0x85)}hidden`, body: "Body" },
        dteInvalidation: { ...DEFAULT_EMAIL_TEMPLATES.dteInvalidation }
      })
    ).toThrow(/asunto/i);
  });

  it("rejects donor control characters after placeholder rendering", () => {
    expect(() =>
      renderEmailTemplate(
        { subject: "Receipt for {{donante}}", body: "Body" },
        { ...fakeRecord(), donor_name: "Ana\r\nBcc: attacker@example.org" }
      )
    ).toThrow(/asunto/i);
  });

  it("rejects unsafe subjects at the common dispatch boundary before a provider call", async () => {
    const send = vi.fn();
    const service = new EmailService({
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL: { send }
    } as unknown as Env);

    await expect(
      service.sendOperationalAlert({
        to: "ops@example.org",
        subject: "Alert\r\nBcc: attacker@example.org",
        text: "Body",
        html: "<p>Body</p>"
      })
    ).rejects.toThrow(/asunto/i);
    expect(send).not.toHaveBeenCalled();
  });

  it("uses caller-scoped HTTP idempotency without suppressing manual resends", async () => {
    const providerFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ status: "accepted", id: "email_http_1" }), {
        status: 202,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", providerFetch);
    const service = new EmailService({
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL_PROVIDER_URL: "https://mail.example/send",
      EMAIL_API_KEY: "email-api-key"
    } as unknown as Env);

    try {
      await service.sendReceipt(fakeRecord(), "ana@example.org", "dte-email:doc_1:dteReceipt");
      await service.sendReceipt(fakeRecord(), "ana@example.org");

      const firstHeaders = providerFetch.mock.calls[0][1]?.headers as Record<string, string>;
      const secondHeaders = providerFetch.mock.calls[1][1]?.headers as Record<string, string>;
      expect(firstHeaders["Idempotency-Key"]).toBe("dte-email:doc_1:dteReceipt");
      expect(secondHeaders).not.toHaveProperty("Idempotency-Key");
      expect(JSON.parse(String(providerFetch.mock.calls[0][1]?.body))).not.toHaveProperty("idempotencyKey");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses a Cloudflare-allowed custom header for receipt idempotency", async () => {
    const send = vi.fn(async (_message: unknown) => ({ messageId: "email_cf_1" }));
    const service = new EmailService({
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL: { send }
    } as unknown as Env);

    await service.sendReceipt(fakeRecord(), "ana@example.org", "dte-email:doc_1:dteReceipt");

    const message = send.mock.calls[0][0] as { headers?: Record<string, string> };
    expect(message.headers).toEqual({
      "X-Idempotency-Key": "dte-email:doc_1:dteReceipt"
    });
    expect(message.headers).not.toHaveProperty("Idempotency-Key");
    expect(message.headers).not.toHaveProperty("Message-ID");
  });

  it("runs the receipt hook after preparation and before the provider side effect", async () => {
    const send = vi.fn(async () => ({ messageId: "must-not-send" }));
    const beforeProviderDispatch = vi.fn(async () => {
      throw new Error("simulated worker stop at provider boundary");
    });
    const service = new EmailService({
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL: { send }
    } as unknown as Env);

    await expect(
      service.sendReceipt(
        fakeRecord(),
        "ana@example.org",
        "dte-email:doc_1:dteReceipt",
        beforeProviderDispatch
      )
    ).rejects.toThrow("simulated worker stop at provider boundary");
    expect(beforeProviderDispatch).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});

describe("email dispatch outcome classification", () => {
  it("marks Cloudflare header validation as proven not sent and retry-safe", () => {
    expect(classifyEmailDispatchError(
      Object.assign(new Error("header rejected for ana@example.org"), { code: "E_HEADER_NOT_ALLOWED" }),
      true
    )).toMatchObject({
      code: "E_HEADER_NOT_ALLOWED",
      outcomeClass: "NOT_SENT",
      retrySafe: true,
      providerResponse: {
        code: "E_HEADER_NOT_ALLOWED"
      }
    });
    const classified = classifyEmailDispatchError(
      Object.assign(new Error("header rejected for ana@example.org"), { code: "E_HEADER_NOT_ALLOWED" }),
      true
    );
    expect(classified.message).not.toContain("ana@example.org");
    expect(JSON.stringify(classified.providerResponse)).not.toContain("ana@example.org");
  });

  it("keeps an explicit delivery failure out of automatic retries", () => {
    expect(classifyEmailDispatchError(
      Object.assign(new Error("delivery failed"), { code: "E_DELIVERY_FAILED" }),
      true
    )).toMatchObject({
      code: "E_DELIVERY_FAILED",
      outcomeClass: "NOT_DELIVERED",
      retrySafe: false
    });
  });

  it("treats internal and untyped post-dispatch errors as unknown", () => {
    expect(classifyEmailDispatchError(
      Object.assign(new Error("internal"), { code: "E_INTERNAL_SERVER_ERROR" }),
      true
    )).toMatchObject({
      code: "E_INTERNAL_SERVER_ERROR",
      outcomeClass: "UNKNOWN",
      retrySafe: false
    });
    expect(classifyEmailDispatchError(new Error("response channel closed"), true)).toMatchObject({
      code: "EMAIL_DISPATCH_UNKNOWN",
      outcomeClass: "UNKNOWN",
      retrySafe: false
    });
  });

  it("marks preparation and ownership errors before dispatch as retry-safe", () => {
    expect(classifyEmailDispatchError(new Error("render failed"), false)).toMatchObject({
      code: "EMAIL_PRE_DISPATCH_FAILED",
      outcomeClass: "NOT_SENT",
      retrySafe: true
    });
  });

  it("classifies only a machine-confirmed HTTP rejection as not sent without storing its body", async () => {
    const providerFetch = vi.fn(async () =>
      new Response(JSON.stringify({
        status: "rejected",
        accepted: false,
        code: "INVALID_RECIPIENT",
        detail: "private recipient detail"
      }), {
        status: 422,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", providerFetch);
    const service = new EmailService({
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL_PROVIDER_URL: "https://mail.example/send",
      EMAIL_API_KEY: "email-api-key"
    } as unknown as Env);

    try {
      await expect(service.sendOperationalAlert({
        to: "ops@example.org",
        subject: "Alert",
        text: "Body",
        html: "<p>Body</p>"
      })).rejects.toMatchObject({
        code: "HTTP_PROVIDER_INVALID_RECIPIENT",
        outcomeClass: "NOT_SENT",
        retrySafe: true,
        providerResponse: {
          code: "HTTP_PROVIDER_INVALID_RECIPIENT"
        }
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("treats an undocumented HTTP 4xx body as unknown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: "private provider detail" }), {
        status: 422,
        headers: { "content-type": "application/json" }
      })
    ));
    const service = new EmailService({
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL_PROVIDER_URL: "https://mail.example/send",
      EMAIL_API_KEY: "email-api-key"
    } as unknown as Env);

    try {
      await expect(service.sendOperationalAlert({
        to: "ops@example.org",
        subject: "Alert",
        text: "Body",
        html: "<p>Body</p>"
      })).rejects.toMatchObject({
        code: "HTTP_PROVIDER_RESPONSE_UNRECOGNIZED",
        outcomeClass: "UNKNOWN",
        retrySafe: false,
        providerResponse: {
          code: "HTTP_PROVIDER_RESPONSE_UNRECOGNIZED"
        }
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["empty", "", "application/json"],
    ["malformed", "not-json", "text/plain"],
    ["error-shaped", JSON.stringify({ error: "queued but uncertain" }), "application/json"],
    ["missing-id", JSON.stringify({ status: "accepted" }), "application/json"]
  ])("treats an %s HTTP 2xx response as unknown", async (_label, body, contentType) => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(body, {
        status: 202,
        headers: { "content-type": contentType }
      })
    ));
    const service = new EmailService({
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL_PROVIDER_URL: "https://mail.example/send",
      EMAIL_API_KEY: "email-api-key"
    } as unknown as Env);

    try {
      await expect(service.sendOperationalAlert({
        to: "ops@example.org",
        subject: "Alert",
        text: "Body",
        html: "<p>Body</p>"
      })).rejects.toMatchObject({
        code: "HTTP_PROVIDER_RESPONSE_UNRECOGNIZED",
        outcomeClass: "UNKNOWN",
        retrySafe: false
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("persists only the accepted HTTP provider identity", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        status: "accepted",
        id: "email_http_contract_1",
        private: "must-not-be-persisted"
      }), {
        status: 202,
        headers: { "content-type": "application/json" }
      })
    ));
    const service = new EmailService({
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL_PROVIDER_URL: "https://mail.example/send",
      EMAIL_API_KEY: "email-api-key"
    } as unknown as Env);

    try {
      await expect(service.sendOperationalAlert({
        to: "ops@example.org",
        subject: "Alert",
        text: "Body",
        html: "<p>Body</p>"
      })).resolves.toEqual({
        provider: "http-email",
        messageId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    "ops@example.org",
    "https://user:secret@mail.example/private",
    "Bearer secret-token",
    "sk_private_provider_token"
  ])("hashes an accepted HTTP provider identity without returning the raw value %s", async (providerId) => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        status: "accepted",
        id: providerId
      }), {
        status: 202,
        headers: { "content-type": "application/json" }
      })
    ));
    const service = new EmailService({
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL_PROVIDER_URL: "https://mail.example/send",
      EMAIL_API_KEY: "email-api-key"
    } as unknown as Env);

    try {
      const result = await service.sendOperationalAlert({
        to: "ops@example.org",
        subject: "Alert",
        text: "Body",
        html: "<p>Body</p>"
      });
      expect(result).toMatchObject({
        provider: "http-email",
        messageId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
      });
      expect(JSON.stringify(result)).not.toContain(providerId);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("hashes an RFC-style Cloudflare message ID after acceptance without returning the raw value", async () => {
    const providerId = "<accepted.message.123@mail.cloudflare.example>";
    const send = vi.fn(async () => ({ messageId: providerId }));
    const service = new EmailService({
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL: { send }
    } as unknown as Env);

    const result = await service.sendOperationalAlert({
      to: "ops@example.org",
      subject: "Alert",
      text: "Body",
      html: "<p>Body</p>"
    });

    expect(result).toMatchObject({
      provider: "cloudflare-email",
      messageId: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    });
    expect(JSON.stringify(result)).not.toContain(providerId);
  });

  it("classifies HTTP server errors as unknown and never retry-safe", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response("internal provider details", { status: 503 })
    ));
    const service = new EmailService({
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL_PROVIDER_URL: "https://mail.example/send",
      EMAIL_API_KEY: "email-api-key"
    } as unknown as Env);

    try {
      await expect(service.sendOperationalAlert({
        to: "ops@example.org",
        subject: "Alert",
        text: "Body",
        html: "<p>Body</p>"
      })).rejects.toMatchObject({
        code: "HTTP_503",
        outcomeClass: "UNKNOWN",
        retrySafe: false,
        providerResponse: {
          code: "HTTP_503"
        }
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("sanitizes HTTP transport errors as unknown", async () => {
    const privateUrl = "https://mail.example/private-token/send";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error(`socket closed while calling ${privateUrl}`);
    }));
    const service = new EmailService({
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL_PROVIDER_URL: privateUrl,
      EMAIL_API_KEY: "email-api-key"
    } as unknown as Env);

    try {
      const outcome = await service.sendOperationalAlert({
        to: "ops@example.org",
        subject: "Alert",
        text: "Body",
        html: "<p>Body</p>"
      }).catch((error: unknown) => error);
      expect(outcome).toMatchObject({
        code: "HTTP_PROVIDER_TRANSPORT_ERROR",
        outcomeClass: "UNKNOWN",
        retrySafe: false
      });
      expect(String((outcome as Error).message)).not.toContain(privateUrl);
    } finally {
      vi.unstubAllGlobals();
    }
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
