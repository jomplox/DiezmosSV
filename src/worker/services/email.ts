import { isMockMode } from "../config";
import type { DteDocumentRecord, Env } from "../types";
import { bytesToBase64 } from "../utils/encoding";
import { DEFAULT_EMAIL_TEMPLATES, renderEmailTemplate, type EmailTemplateSettings } from "./emailTemplates";
import { renderDtePdf } from "./pdf";

export class EmailService {
  constructor(
    private readonly env: Env,
    private readonly templates: EmailTemplateSettings = DEFAULT_EMAIL_TEMPLATES
  ) {}

  async sendReceipt(record: DteDocumentRecord, toEmail: string): Promise<unknown> {
    const message = renderEmailTemplate(this.templates.dteReceipt, record);
    if (record.status === "CONTINGENCY_PENDING" && this.templates.dteReceipt.subject === DEFAULT_EMAIL_TEMPLATES.dteReceipt.subject) {
      message.subject = "Comprobante DTE transitorio por donación";
    }
    return this.sendDteEmail(record, toEmail, message);
  }

  async sendInvalidationNotice(record: DteDocumentRecord, toEmail: string): Promise<unknown> {
    const invalidatedRecord = { ...record, status: "INVALIDATED" };
    return this.sendDteEmail(invalidatedRecord, toEmail, renderEmailTemplate(this.templates.dteInvalidation, invalidatedRecord));
  }

  private async sendDteEmail(record: DteDocumentRecord, toEmail: string, message: EmailMessage): Promise<unknown> {
    const pdfBytes = await renderDtePdf(record);
    const jsonBytes = new TextEncoder().encode(record.plain_json);
    const from = this.env.EMAIL_FROM ?? "dte@example.org";
    const pdfAttachment = {
      filename: `${record.codigo_generacion}.pdf`,
      contentBase64: bytesToBase64(pdfBytes),
      contentType: "application/pdf"
    };
    const jsonAttachment = {
      filename: `${record.codigo_generacion}.json`,
      contentBase64: bytesToBase64(jsonBytes),
      contentType: "application/json"
    };
    const payload = {
      from,
      to: toEmail,
      subject: message.subject,
      text: message.text,
      attachments: [
        {
          filename: pdfAttachment.filename,
          contentType: pdfAttachment.contentType,
          contentBase64: pdfAttachment.contentBase64
        },
        {
          filename: jsonAttachment.filename,
          contentType: jsonAttachment.contentType,
          contentBase64: jsonAttachment.contentBase64
        }
      ]
    };

    if (isMockMode(this.env)) {
      return { mock: true, toEmail, subject: message.subject };
    }
    if (this.env.EMAIL) {
      try {
        const result = await this.env.EMAIL.send({
          from,
          to: toEmail,
          subject: message.subject,
          text: payload.text,
          attachments: [
            {
              filename: pdfAttachment.filename,
              type: pdfAttachment.contentType,
              disposition: "attachment",
              content: pdfBytes
            },
            {
              filename: jsonAttachment.filename,
              type: jsonAttachment.contentType,
              disposition: "attachment",
              content: jsonBytes
            }
          ]
        });
        return { provider: "cloudflare-email", messageId: result.messageId };
      } catch (error) {
        if (hasHttpProvider(this.env)) {
          return sendViaHttpProvider(this.env, payload, error);
        }
        throw error;
      }
    }
    if (hasHttpProvider(this.env)) {
      return sendViaHttpProvider(this.env, payload);
    }
    throw new Error("Configure el servicio de correo antes de enviar comprobantes.");
  }
}

interface EmailMessage {
  subject: string;
  text: string;
}

async function sendViaHttpProvider(env: Env, payload: EmailPayload, cloudflareError?: unknown): Promise<unknown> {
  const response = await fetch(env.EMAIL_API_URL!, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.EMAIL_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  const responseBody = await response.text();
  const parsed = parseProviderResponse(responseBody);
  if (!response.ok) {
    throw new Error(`Falló el proveedor de correo: ${response.status} ${responseBody}`);
  }
  return {
    provider: "http-email",
    ...(cloudflareError ? { fallbackFrom: "cloudflare-email", cloudflareError: errorMessage(cloudflareError) } : {}),
    response: parsed
  };
}

interface EmailPayload {
  from: string;
  to: string;
  subject: string;
  text: string;
  attachments: Array<{
    filename: string;
    contentType: string;
    contentBase64: string;
  }>;
}

function hasHttpProvider(env: Env): boolean {
  return Boolean(env.EMAIL_API_URL?.trim() && env.EMAIL_API_KEY?.trim());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseProviderResponse(responseBody: string): unknown {
  if (!responseBody) {
    return { ok: true };
  }
  try {
    return JSON.parse(responseBody) as unknown;
  } catch {
    return { text: responseBody };
  }
}
