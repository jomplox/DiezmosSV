import { isMockMode } from "../config";
import type { DteDocumentRecord, Env } from "../types";
import { bytesToBase64, sha256Hex, utf8Bytes } from "../utils/encoding";
import { dteEmailHtml, passwordResetEmailHtml } from "./emailHtml";
import { assertSafeEmailSubject, DEFAULT_EMAIL_TEMPLATES, renderEmailTemplate, TRANSITORIO_RECEIPT_TEMPLATE, type EmailEvidenceType, type EmailTemplateSettings, type EmailTemplateValue } from "./emailTemplates";
import { DTE_PDF_RENDERER_VERSION, renderDtePdf } from "./pdf";

export interface EmailDeliveryResult {
  providerResponse: unknown;
  emailType: EmailEvidenceType;
  documentStatusAtSend: string;
  templateVersion: string;
  pdfRendererVersion: string;
  pdfSha256: string;
  dteJsonSha256: string;
  providerDeliveryId: string | null;
}

// White-label chrome for every email this service sends. Callers that already load
// settings before a send (receipt/invalidation/certificate/reset) thread the church's
// branding here; the defaults keep an unbranded deployment on the historical identity.
export interface EmailBranding {
  organizationName: string;
  brandColor: string;
  supportEmail: string;
  // Absolute, version-qualified logo URL (or null). Rendered in the header of every rich
  // HTML email above the organization name; null keeps exactly the historical, logo-less
  // chrome. Absolute because a relative path is meaningless inside an email client.
  logoUrl?: string | null;
}

export class EmailService {
  constructor(
    private readonly env: Env,
    private readonly templates: EmailTemplateSettings = DEFAULT_EMAIL_TEMPLATES,
    private readonly branding?: EmailBranding
  ) {}

  // Resolve the branding once per send: an explicit branding (loaded from app_settings
  // by the caller) wins; otherwise fall back to the emisor-derived name + default color.
  private resolveBranding(): EmailBranding {
    if (this.branding) {
      return this.branding;
    }
    return { organizationName: organizationName(this.env), brandColor: "#0f766e", supportEmail: "legacy-contact-1@example.com", logoUrl: null };
  }

  // Sender identity for real dispatch. EMAIL_FROM is required for any actual send;
  // mock mode short-circuits before `from` is used, so an unset value stays harmless
  // there and only surfaces as an error when a real provider would be contacted.
  private resolveFrom(): string {
    if (isMockMode(this.env)) {
      return this.env.EMAIL_FROM ?? "";
    }
    if (!this.env.EMAIL_FROM) {
      throw new Error("EMAIL_FROM es requerido para enviar correos");
    }
    return this.env.EMAIL_FROM;
  }

  async sendReceipt(
    record: DteDocumentRecord,
    toEmail: string,
    idempotencyKey?: string,
    beforeProviderDispatch?: () => void | Promise<void>
  ): Promise<EmailDeliveryResult> {
    // Documento diferido (MH no disponible): SIEMPRE la copy fija transitoria, sin
    // importar la plantilla del operador — el PDF adjunto lleva sello TRANSITORIO y
    // el correo debe enmarcarlo como provisional, no como comprobante definitivo.
    // Diferido = SIGNED + transmission_deferred_at; un documento ya ACCEPTED conserva
    // el marcador como historia y cae al comprobante definitivo de abajo.
    if (record.status === "SIGNED" && record.transmission_deferred_at) {
      return this.sendDteEmail(record, toEmail, "dteReceiptTransitorio", TRANSITORIO_RECEIPT_TEMPLATE, renderEmailTemplate(TRANSITORIO_RECEIPT_TEMPLATE, record), idempotencyKey, beforeProviderDispatch);
    }
    const message = renderEmailTemplate(this.templates.dteReceipt, record);
    if (record.status === "CONTINGENCY_PENDING" && this.templates.dteReceipt.subject === DEFAULT_EMAIL_TEMPLATES.dteReceipt.subject) {
      // Solo documentos históricos: la emisión en contingencia se eliminó (Anexo,
      // campo 35 — el CDE no participa del evento de contingencia).
      message.subject = "Comprobante transitorio de su donación";
    }
    return this.sendDteEmail(record, toEmail, "dteReceipt", this.templates.dteReceipt, message, idempotencyKey, beforeProviderDispatch);
  }

  async sendInvalidationNotice(record: DteDocumentRecord, toEmail: string): Promise<EmailDeliveryResult> {
    const invalidatedRecord = { ...record, status: "INVALIDATED" };
    return this.sendDteEmail(
      invalidatedRecord,
      toEmail,
      "dteInvalidation",
      this.templates.dteInvalidation,
      renderEmailTemplate(this.templates.dteInvalidation, invalidatedRecord),
      `dte-email:${record.id}:dteInvalidation`
    );
  }

  private async sendDteEmail(
    record: DteDocumentRecord,
    toEmail: string,
    emailType: EmailEvidenceType,
    template: EmailTemplateValue,
    message: EmailMessage,
    idempotencyKey?: string,
    beforeProviderDispatch?: () => void | Promise<void>
  ): Promise<EmailDeliveryResult> {
    const pdfBytes = await renderDtePdf(record);
    // Prefer the signed JWS — the cryptographically signed, legally meaningful artifact —
    // over the unsigned plain_json. The pipeline signs and persists a JWS before emailing
    // accepted/transitorio receipts; only an edge document without a JWS falls back to
    // plain_json. The recorded dteJsonSha256 evidence covers whatever was actually sent.
    const dteAttachmentBytes = new TextEncoder().encode(record.signed_jws ?? record.plain_json);
    const evidence = {
      emailType,
      documentStatusAtSend: record.status,
      templateVersion: await templateVersion(emailType, template),
      pdfRendererVersion: DTE_PDF_RENDERER_VERSION,
      pdfSha256: await sha256Hex(pdfBytes),
      dteJsonSha256: await sha256Hex(dteAttachmentBytes)
    };
    const from = this.resolveFrom();
    const pdfAttachment = {
      filename: `${record.codigo_generacion}.pdf`,
      contentBase64: bytesToBase64(pdfBytes),
      contentType: "application/pdf"
    };
    const jsonAttachment = {
      filename: `${record.codigo_generacion}.json`,
      contentBase64: bytesToBase64(dteAttachmentBytes),
      contentType: "application/json"
    };
    const payload = {
      from,
      to: toEmail,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      subject: message.subject,
      text: message.text,
      html: dteEmailHtml(record, message.text, {
        organizationName: this.resolveBranding().organizationName,
        brandColor: this.resolveBranding().brandColor,
        supportEmail: this.resolveBranding().supportEmail,
        logoUrl: this.resolveBranding().logoUrl
      }),
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
        content: dteAttachmentBytes
      }
    ], beforeProviderDispatch);
    return { providerResponse, ...evidence, providerDeliveryId: deliveryIdFromProvider(providerResponse) };
  }

  async sendDonorCertificate(input: {
    toEmail: string;
    subject: string;
    text: string;
    html: string;
    pdfBytes: Uint8Array;
    filename: string;
  }): Promise<unknown> {
    const contentBase64 = bytesToBase64(input.pdfBytes);
    const payload: EmailPayload = {
      from: this.resolveFrom(),
      to: input.toEmail,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: [{ filename: input.filename, contentType: "application/pdf", contentBase64 }]
    };
    return this.dispatch(payload, [
      { filename: input.filename, type: "application/pdf", disposition: "attachment", content: input.pdfBytes }
    ]);
  }

  async sendPasswordReset(toEmail: string, name: string, link: string, expiresMinutes: number): Promise<unknown> {
    const branding = this.resolveBranding();
    const payload: EmailPayload = {
      from: this.resolveFrom(),
      to: toEmail,
      subject: `Restablecimiento de contraseña - ${branding.organizationName}`,
      text:
        `Hola ${name},\n\n` +
        `Recibimos una solicitud para restablecer su contraseña en ${branding.organizationName}. ` +
        `Abra este enlace para crear una nueva contraseña (vence en ${expiresMinutes} minutos):\n\n` +
        `${link}\n\n` +
        `Si usted no solicitó este cambio, ignore este mensaje; su contraseña actual sigue vigente.`,
      html: passwordResetEmailHtml(name, link, expiresMinutes, {
        organizationName: branding.organizationName,
        brandColor: branding.brandColor,
        supportEmail: branding.supportEmail,
        logoUrl: branding.logoUrl
      }),
      attachments: []
    };
    return this.dispatch(payload, []);
  }

  async sendOperationalAlert(input: { to: string; subject: string; text: string; html: string }): Promise<unknown> {
    const payload: EmailPayload = {
      from: this.resolveFrom(),
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: []
    };
    return this.dispatch(payload, []);
  }

  private async dispatch(
    payload: EmailPayload,
    cfAttachments: CloudflareEmailAttachment[],
    beforeProviderDispatch?: () => void | Promise<void>
  ): Promise<unknown> {
    assertSafeEmailSubject(payload.subject);
    if (isMockMode(this.env)) {
      return { mock: true, toEmail: payload.to, subject: payload.subject };
    }
    const httpProviderConfigured = hasHttpProvider(this.env);
    const cloudflareSelected = Boolean(
      this.env.EMAIL &&
      (this.env.EMAIL_ARBITRARY_RECIPIENTS?.trim().toLowerCase() === "true" || !httpProviderConfigured)
    );
    if (cloudflareSelected && this.env.EMAIL) {
      await beforeProviderDispatch?.();
      // Once Cloudflare Email is invoked, a rejected promise is outcome-ambiguous:
      // the provider may already have accepted the message. Crossing to the HTTP
      // provider here could deliver the same receipt twice, so recovery remains on
      // this provider's durable FAILED evidence instead of automatic fallback.
      const result = await this.env.EMAIL.send({
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        ...(payload.idempotencyKey ? { headers: providerIdentityHeaders(payload.idempotencyKey) } : {}),
        text: payload.text,
        ...(payload.html ? { html: payload.html } : {}),
        ...(cfAttachments.length > 0 ? { attachments: cfAttachments } : {})
      });
      return { provider: "cloudflare-email", messageId: result.messageId };
    }
    if (httpProviderConfigured) {
      await beforeProviderDispatch?.();
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

async function sendViaHttpProvider(env: Env, payload: EmailPayload): Promise<unknown> {
  const providerUrl = emailProviderUrl(env);
  if (!providerUrl || !env.EMAIL_API_KEY?.trim()) {
    throw new Error("Configure un endpoint HTTPS de correo administrado por el despliegue.");
  }
  const response = await fetch(providerUrl.toString(), {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${env.EMAIL_API_KEY}`,
      "Content-Type": "application/json",
      ...(payload.idempotencyKey ? { "Idempotency-Key": payload.idempotencyKey } : {})
    },
    body: JSON.stringify(providerPayload(payload))
  });
  const responseBody = await response.text();
  const parsed = parseProviderResponse(responseBody);
  if (!response.ok) {
    throw new Error(`Falló el proveedor de correo: ${response.status} ${responseBody}`);
  }
  return {
    provider: "http-email",
    response: parsed
  };
}

function providerIdentityHeaders(idempotencyKey: string): Record<string, string> {
  return {
    "X-Idempotency-Key": idempotencyKey
  };
}

interface EmailPayload {
  from: string;
  to: string;
  idempotencyKey?: string;
  subject: string;
  text: string;
  html?: string;
  attachments: Array<{
    filename: string;
    contentType: string;
    contentBase64: string;
  }>;
}

function providerPayload(payload: EmailPayload): Omit<EmailPayload, "idempotencyKey"> {
  const { idempotencyKey: _idempotencyKey, ...body } = payload;
  return body;
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
  return Boolean(emailProviderUrl(env) && env.EMAIL_API_KEY?.trim());
}

function emailProviderUrl(env: Env): URL | null {
  const raw = env.EMAIL_PROVIDER_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
      return null;
    }
    return url;
  } catch {
    return null;
  }
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

async function templateVersion(emailType: EmailEvidenceType, template: EmailTemplateValue): Promise<string> {
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
