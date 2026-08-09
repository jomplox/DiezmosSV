import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailService } from "../../src/worker/services/email";
import type { DteDocumentRecord, Env } from "../../src/worker/types";
import { makeDocument } from "./fixtures";

const GENERATION_CODE = "6CAE5F7E-A590-4573-8EF2-FE48B14796C4";

interface AttachmentMetadata {
  filename: string;
  mediaType: string;
}

describe("outbound email attachment allowlists", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends only each email type's intended attachments through Cloudflare Email", async () => {
    const sent: Array<{ attachments?: Array<{ filename: string; type: string }> }> = [];
    const service = new EmailService({
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          sent.push(message as { attachments?: Array<{ filename: string; type: string }> });
          return { messageId: `cf-email-${sent.length}` };
        }
      }
    } as unknown as Env);

    await exerciseEveryEmailType(service);

    expect(sent.map((message) => cloudflareAttachmentMetadata(message.attachments))).toEqual(
      expectedAttachmentMatrix()
    );
  });

  it("sends only each email type's intended attachments through the HTTP provider", async () => {
    const sent: Array<{ attachments?: Array<{ filename: string; contentType: string }> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)) as {
        attachments?: Array<{ filename: string; contentType: string }>;
      });
      return new Response(JSON.stringify({ status: "accepted", id: `http-email-${sent.length}` }), {
        status: 202,
        headers: { "content-type": "application/json" }
      });
    }));
    const service = new EmailService({
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "receipts@example.org",
      EMAIL_PROVIDER_URL: "https://mail.example/send",
      EMAIL_API_KEY: "email-api-key"
    } as unknown as Env);

    await exerciseEveryEmailType(service);

    expect(sent.map((message) => httpAttachmentMetadata(message.attachments))).toEqual(
      expectedAttachmentMatrix()
    );
  });
});

async function exerciseEveryEmailType(service: EmailService): Promise<void> {
  const record = signedRecord();
  await service.sendReceipt(record, "donor@example.org");
  await service.sendInvalidationNotice(record, "donor@example.org");
  await service.sendDonorCertificate({
    toEmail: "donor@example.org",
    subject: "Constancia anual",
    text: "Adjuntamos su constancia.",
    html: "<p>Adjuntamos su constancia.</p>",
    pdfBytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
    filename: "constancia-donaciones-2025.pdf"
  });
  await service.sendPasswordReset(
    "operator@example.org",
    "Operador",
    "https://example.org/reset?token=synthetic",
    45
  );
  await service.sendOperationalAlert({
    to: "operator@example.org",
    subject: "Alerta operativa",
    text: "Revise el panel.",
    html: "<p>Revise el panel.</p>"
  });
}

function signedRecord(): DteDocumentRecord {
  return makeDocument({
    codigo_generacion: GENERATION_CODE,
    // A signed DTE must retain this durable fiscal artifact, but donor email
    // packaging is deliberately limited to the PDF representation and JSON document.
    signed_jws: "eyJhbGciOiJSUzUxMiJ9.eyJ0ZXN0Ijp0cnVlfQ.synthetic-signature"
  });
}

function expectedAttachmentMatrix(): AttachmentMetadata[][] {
  const dteAttachments = [
    { filename: `${GENERATION_CODE}.pdf`, mediaType: "application/pdf" },
    { filename: `${GENERATION_CODE}.json`, mediaType: "application/json" }
  ];
  return [
    dteAttachments,
    dteAttachments,
    [{ filename: "constancia-donaciones-2025.pdf", mediaType: "application/pdf" }],
    [],
    []
  ];
}

function cloudflareAttachmentMetadata(
  attachments: Array<{ filename: string; type: string }> | undefined
): AttachmentMetadata[] {
  return (attachments ?? []).map(({ filename, type }) => ({ filename, mediaType: type }));
}

function httpAttachmentMetadata(
  attachments: Array<{ filename: string; contentType: string }> | undefined
): AttachmentMetadata[] {
  return (attachments ?? []).map(({ filename, contentType }) => ({ filename, mediaType: contentType }));
}
