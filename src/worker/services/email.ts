import { isMockMode } from "../config";
import type { DteDocumentRecord, Env } from "../types";
import { bytesToBase64, sha256Hex, utf8Bytes } from "../utils/encoding";
import { dteEmailHtml, passwordResetEmailHtml } from "./emailHtml";
import { DEFAULT_EMAIL_TEMPLATES, renderEmailTemplate, type EmailTemplateSettings, type EmailTemplateType, type EmailTemplateValue } from "./emailTemplates";
import { DTE_PDF_RENDERER_VERSION, renderDtePdf } from "./pdf";

export interface EmailDeliveryResult {
  providerResponse: unknown;
  emailType: EmailTemplateType;
  documentStatusAtSend: string;
  templateVersion: string;
  pdfRendererVersion: string;
  pdfSha256: string;
  dteJsonSha256: string;
  providerDeliveryId: string | null;
}

export class EmailService {
  constructor(
    private readonly env: Env,
    private readonly templates: EmailTemplateSettings = DEFAULT_EMAIL_TEMPLATES
  ) {}

  async sendReceipt(record: DteDocumentRecord, toEmail: string): Promise<EmailDeliveryResult> {
    const message = renderEmailTemplate(this.templates.dteReceipt, record);
    if (record.status === "CONTINGENCY_PENDING" && this.templates.dteReceipt.subject === DEFAULT_EMAIL_TEMPLATES.dteReceipt.subject) {
      message.subject = "Comprobante transitorio de su donación";
    }
    return this.sendDteEmail(record, toEmail, "dteReceipt", this.templates.dteReceipt, message);
  }

  async sendInvalidationNotice(record: DteDocumentRecord, toEmail: string): Promise<EmailDeliveryResult> {
    const invalidatedRecord = { ...record, status: "INVALIDATED" };
    return this.sendDteEmail(invalidatedRecord, toEmail, "dteInvalidation", this.templates.dteInvalidation, renderEmailTemplate(this.templates.dteInvalidation, invalidatedRecord));
  }

  private async sendDteEmail(record: DteDocumentRecord, toEmail: string, emailType: EmailTemplateType, template: EmailTemplateValue, message: EmailMessage): Promise<EmailDeliveryResult> {
    const pdfBytes = await renderDtePdf(record);
    const jsonBytes = new TextEncoder().encode(record.plain_json);
    const evidence = {
      emailType,
      documentStatusAtSend: record.status,
      templateVersion: await templateVersion(emailType, template),
      pdfRendererVersion: DTE_PDF_RENDERER_VERSION,
      pdfSha256: await sha256Hex(pdfBytes),
      dteJsonSha256: await sha256Hex(jsonBytes)
    };
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
      html: dteEmailHtml(record, message.text, { organizationName: organizationName(this.env) }),
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

    const providerResponse = await this.dispatch(payload, [
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
    ]);
    return { providerResponse, ...evidence, providerDeliveryId: deliveryIdFromProvider(providerResponse) };
  }

  async sendPasswordReset(toEmail: string, name: string, link: string, expiresMinutes: number): Promise<unknown> {
    const payload: EmailPayload = {
      from: this.env.EMAIL_FROM ?? "dte@example.org",
      to: toEmail,
      subject: "Restablecimiento de contraseña - ExamplePerson1",
      text:
        `Hola ${name},\n\n` +
        `Recibimos una solicitud para restablecer su contraseña en ExamplePerson1. ` +
        `Abra este enlace para crear una nueva contraseña (vence en ${expiresMinutes} minutos):\n\n` +
        `${link}\n\n` +
        `Si usted no solicitó este cambio, ignore este mensaje; su contraseña actual sigue vigente.`,
      html: passwordResetEmailHtml(name, link, expiresMinutes),
      attachments: []
    };
    return this.dispatch(payload, []);
  }

  private async dispatch(payload: EmailPayload, cfAttachments: CloudflareEmailAttachment[]): Promise<unknown> {
    if (isMockMode(this.env)) {
      return { mock: true, toEmail: payload.to, subject: payload.subject };
    }
    if (this.env.EMAIL) {
      try {
        const result = await this.env.EMAIL.send({
          from: payload.from,
          to: payload.to,
          subject: payload.subject,
          text: payload.text,
          ...(payload.html ? { html: payload.html } : {}),
          ...(cfAttachments.length > 0 ? { attachments: cfAttachments } : {})
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

interface CloudflareEmailAttachment {
  filename: string;
  type: string;
  disposition: "attachment";
  content: Uint8Array;
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
  html?: string;
  attachments: Array<{
    filename: string;
    contentType: string;
    contentBase64: string;
  }>;
}

function organizationName(env: Env): string {
  // Lenient on purpose: a branding fallback must never block an email send.
  try {
    const parsed = JSON.parse(env.EMISOR_CONFIG_JSON ?? "") as { nombreComercial?: unknown; nombre?: unknown };
    const name = [parsed.nombreComercial, parsed.nombre].find((value) => typeof value === "string" && value.trim());
    return typeof name === "string" ? name.trim() : "ExamplePerson1";
  } catch {
    return "ExamplePerson1";
  }
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

async function templateVersion(emailType: EmailTemplateType, template: EmailTemplateValue): Promise<string> {
  const payload = JSON.stringify({ emailType, subject: template.subject, body: template.body });
  return `${emailType}:sha256:${await sha256Hex(utf8Bytes(payload))}`;
}

function deliveryIdFromProvider(providerResponse: unknown): string | null {
  if (!isRecord(providerResponse)) return null;
  const messageId = stringValue(providerResponse.messageId);
  if (messageId) return messageId;
  const id = stringValue(providerResponse.id);
  if (id) return id;
  const response = providerResponse.response;
  return isRecord(response) ? stringValue(response.id) ?? stringValue(response.messageId) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}
