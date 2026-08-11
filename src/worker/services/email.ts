import { isMockMode } from "../config";
import type { DteDocumentRecord, Env } from "../types";
import { bytesToBase64, sha256Hex, utf8Bytes } from "../utils/encoding";
import { isRecord } from "../utils/guards";
import { dteEmailHtml, passwordResetEmailHtml } from "./emailHtml";
import { resolveEmailReplyToAddress, resolveEmailSenderName } from "./emailSender";
import { assertSafeEmailSubject, DEFAULT_EMAIL_TEMPLATES, renderEmailTemplate, TRANSITORIO_RECEIPT_TEMPLATE, type EmailEvidenceType, type EmailTemplateSettings, type EmailTemplateValue } from "./emailTemplates";
import { DTE_PDF_RENDERER_VERSION, loadPdfBrandingLogo, renderDtePdf } from "./pdf";

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

export interface StripeAcknowledgmentDeliveryResult {
  providerResponse: unknown;
  providerDeliveryId: string | null;
}

export function emailDeliveryAuditEvidence(
  result: EmailDeliveryResult
): Omit<EmailDeliveryResult, "providerResponse"> {
  const { providerResponse: _providerResponse, ...evidence } = result;
  return evidence;
}

export type EmailDeliveryOutcomeClass = "NOT_SENT" | "NOT_DELIVERED" | "UNKNOWN";

export class EmailDispatchError extends Error {
  readonly providerResponse: Record<string, unknown>;

  constructor(
    message: string,
    readonly code: string,
    readonly outcomeClass: EmailDeliveryOutcomeClass,
    readonly retrySafe: boolean
  ) {
    super(message);
    this.name = "EmailDispatchError";
    // Persist only a stable machine code. Provider exception text can echo
    // recipients, headers, URLs, or credentials and is never durable evidence.
    this.providerResponse = { code };
  }
}

const CLOUDFLARE_NOT_SENT_CODES = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY"
]);
const HTTP_PROVIDER_ACCEPTED_STATUSES = new Set([200, 202]);
const HTTP_PROVIDER_TIMEOUT_MS = 15_000;
const HTTP_PROVIDER_RESPONSE_MAX_CHARS = 16_384;
const PROVIDER_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const PROVIDER_DELIVERY_ID_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function classifyEmailDispatchError(
  error: unknown,
  providerDispatchStarted: boolean
): EmailDispatchError {
  if (error instanceof EmailDispatchError) {
    return error;
  }
  const providerCode =
    isRecord(error) &&
    typeof error.code === "string" &&
    PROVIDER_CODE_PATTERN.test(error.code.trim())
      ? error.code.trim()
      : null;
  if (!providerDispatchStarted) {
    return new EmailDispatchError(
      "El correo no pudo prepararse antes del envío.",
      providerCode ?? "EMAIL_PRE_DISPATCH_FAILED",
      "NOT_SENT",
      true
    );
  }
  if (providerCode && CLOUDFLARE_NOT_SENT_CODES.has(providerCode)) {
    return new EmailDispatchError(
      "El proveedor rechazó el correo antes de aceptarlo.",
      providerCode,
      "NOT_SENT",
      true
    );
  }
  if (providerCode === "E_DELIVERY_FAILED") {
    return new EmailDispatchError(
      "El proveedor confirmó que el correo no pudo entregarse.",
      providerCode,
      "NOT_DELIVERED",
      false
    );
  }
  return new EmailDispatchError(
    "No se pudo confirmar el resultado del envío con el proveedor.",
    providerCode ?? "EMAIL_DISPATCH_UNKNOWN",
    "UNKNOWN",
    false
  );
}

// White-label chrome for every email this service sends. Callers that already load
// settings before a send (receipt/invalidation/certificate/reset) thread the church's
// branding here; the defaults keep an unbranded deployment on the historical identity.
export interface EmailBranding {
  organizationName: string;
  brandColor: string;
  supportEmail: string;
  senderName?: string;
  replyToAddress?: string | null;
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
  private resolveFrom(): EmailSenderIdentity {
    const branding = this.resolveBranding();
    const senderName = resolveEmailSenderName(branding.senderName, branding.organizationName);
    if (isMockMode(this.env)) {
      return { email: this.env.EMAIL_FROM?.trim() ?? "", name: senderName };
    }
    const senderAddress = this.env.EMAIL_FROM?.trim();
    if (!senderAddress) {
      throw new EmailDispatchError(
        "Configure el remitente de correo antes de enviar.",
        "EMAIL_FROM_REQUIRED",
        "NOT_SENT",
        true
      );
    }
    return { email: senderAddress, name: senderName };
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
    // The attached comprobante carries the same configured logo as the email chrome
    // around it; loadPdfBrandingLogo yields null (built-in vector) on any problem.
    const pdfBytes = await renderDtePdf(record, await loadPdfBrandingLogo(this.env));
    const dteJsonBytes = new TextEncoder().encode(record.plain_json);
    const evidence = {
      emailType,
      documentStatusAtSend: record.status,
      templateVersion: await templateVersion(emailType, template),
      pdfRendererVersion: DTE_PDF_RENDERER_VERSION,
      pdfSha256: await sha256Hex(pdfBytes),
      dteJsonSha256: await sha256Hex(dteJsonBytes)
    };
    const from = this.resolveFrom();
    const pdfAttachment = {
      filename: `${record.codigo_generacion}.pdf`,
      contentBase64: bytesToBase64(pdfBytes),
      contentType: "application/pdf"
    };
    const jsonAttachment = {
      filename: `${record.codigo_generacion}.json`,
      contentBase64: bytesToBase64(dteJsonBytes),
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
        content: dteJsonBytes
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

  async sendStripeAcknowledgment(
    input: {
      toEmail: string;
      subject: string;
      text: string;
      html: string;
      idempotencyKey: string;
    },
    beforeProviderDispatch?: () => void | Promise<void>
  ): Promise<StripeAcknowledgmentDeliveryResult> {
    const payload: EmailPayload = {
      from: this.resolveFrom(),
      to: input.toEmail,
      idempotencyKey: input.idempotencyKey,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: []
    };
    const providerResponse = await this.dispatch(payload, [], beforeProviderDispatch);
    return {
      providerResponse,
      providerDeliveryId: deliveryIdFromProvider(providerResponse)
    };
  }

  async sendStripeAnnualStatement(
    input: {
      toEmail: string;
      subject: string;
      text: string;
      html: string;
      pdfBytes: Uint8Array;
      filename: string;
      idempotencyKey: string;
    },
    beforeProviderDispatch?: () => void | Promise<void>
  ): Promise<StripeAcknowledgmentDeliveryResult> {
    const payload: EmailPayload = {
      from: this.resolveFrom(),
      to: input.toEmail,
      idempotencyKey: input.idempotencyKey,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: [{
        filename: input.filename,
        contentType: "application/pdf",
        contentBase64: bytesToBase64(input.pdfBytes)
      }]
    };
    const providerResponse = await this.dispatch(payload, [{
      filename: input.filename,
      type: "application/pdf",
      disposition: "attachment",
      content: input.pdfBytes
    }], beforeProviderDispatch);
    return { providerResponse, providerDeliveryId: deliveryIdFromProvider(providerResponse) };
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

  async sendOperationalAlert(
    input: { to: string; subject: string; text: string; html: string },
    beforeProviderDispatch?: () => void | Promise<void>
  ): Promise<unknown> {
    const payload: EmailPayload = {
      from: this.resolveFrom(),
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
      attachments: []
    };
    return this.dispatch(payload, [], beforeProviderDispatch);
  }

  private async dispatch(
    payload: EmailPayload,
    cfAttachments: CloudflareEmailAttachment[],
    beforeProviderDispatch?: () => void | Promise<void>
  ): Promise<unknown> {
    assertSafeEmailSubject(payload.subject);
    if (isMockMode(this.env)) {
      await beforeProviderDispatch?.();
      return {
        provider: "mock-email",
        messageId: await hashProviderDeliveryId("mock-email-accepted")
      };
    }
    const replyTo = resolveEmailReplyToAddress(this.resolveBranding().replyToAddress);
    const dispatchPayload: EmailPayload = replyTo ? { ...payload, replyTo } : payload;
    const httpProviderConfigured = hasHttpProvider(this.env);
    const cloudflareSelected = Boolean(
      this.env.EMAIL &&
      (this.env.EMAIL_ARBITRARY_RECIPIENTS?.trim().toLowerCase() === "true" || !httpProviderConfigured)
    );
    if (cloudflareSelected && this.env.EMAIL) {
      await beforeProviderDispatch?.();
      // Never cross to the HTTP provider after invoking Cloudflare. Documented
      // validation codes can prove a pre-accept rejection, but every unrecognized
      // rejection remains outcome-ambiguous and requires durable review.
      const result = await this.env.EMAIL.send({
        from: {
          email: dispatchPayload.from.email,
          name: dispatchPayload.from.name
        },
        to: dispatchPayload.to,
        subject: dispatchPayload.subject,
        ...(dispatchPayload.replyTo ? { replyTo: dispatchPayload.replyTo } : {}),
        ...(dispatchPayload.idempotencyKey ? { headers: providerIdentityHeaders(dispatchPayload.idempotencyKey) } : {}),
        text: dispatchPayload.text,
        ...(dispatchPayload.html ? { html: dispatchPayload.html } : {}),
        ...(cfAttachments.length > 0 ? { attachments: cfAttachments } : {})
      });
      const messageId = await hashProviderDeliveryId(result.messageId);
      if (!messageId) {
        throw new EmailDispatchError(
          "Cloudflare aceptó la llamada, pero no devolvió una identidad de entrega.",
          "CLOUDFLARE_ACCEPTANCE_UNCONFIRMED",
          "UNKNOWN",
          false
        );
      }
      return { provider: "cloudflare-email", messageId };
    }
    if (httpProviderConfigured) {
      await beforeProviderDispatch?.();
      return sendViaHttpProvider(this.env, dispatchPayload);
    }
    throw new EmailDispatchError(
      "Configure el servicio de correo antes de enviar comprobantes.",
      "EMAIL_PROVIDER_NOT_CONFIGURED",
      "NOT_SENT",
      true
    );
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

interface EmailSenderIdentity {
  email: string;
  name: string;
}

async function sendViaHttpProvider(env: Env, payload: EmailPayload): Promise<unknown> {
  const providerUrl = emailProviderUrl(env);
  if (!providerUrl || !env.EMAIL_API_KEY?.trim()) {
    throw new Error("Configure un endpoint HTTPS de correo administrado por el despliegue.");
  }
  let response: Response;
  try {
    response = await fetch(providerUrl.toString(), {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: `Bearer ${env.EMAIL_API_KEY}`,
        "Content-Type": "application/json",
        ...(payload.idempotencyKey ? { "Idempotency-Key": payload.idempotencyKey } : {})
      },
      body: JSON.stringify(providerPayload(payload)),
      signal: AbortSignal.timeout(HTTP_PROVIDER_TIMEOUT_MS)
    });
  } catch {
    throw new EmailDispatchError(
      "No se pudo confirmar el resultado del proveedor HTTP",
      "HTTP_PROVIDER_TRANSPORT_ERROR",
      "UNKNOWN",
      false
    );
  }
  if (!response.ok) {
    const body = await readHttpProviderResponse(response);
    const rejectionCode = httpProviderRejectionCode(response.status, body);
    if (rejectionCode) {
      throw new EmailDispatchError(
        "El proveedor HTTP rechazó el correo antes de aceptarlo.",
        rejectionCode,
        "NOT_SENT",
        true
      );
    }
    throw new EmailDispatchError(
      "El proveedor HTTP respondió sin confirmar si aceptó el correo.",
      response.status >= 500
        ? `HTTP_${response.status}`
        : "HTTP_PROVIDER_RESPONSE_UNRECOGNIZED",
      "UNKNOWN",
      false
    );
  }
  const body = await readHttpProviderResponse(response);
  const acceptedId = httpProviderAcceptedId(response.status, body);
  if (!acceptedId) {
    throw new EmailDispatchError(
      "El proveedor HTTP respondió sin una confirmación de aceptación válida.",
      "HTTP_PROVIDER_RESPONSE_UNRECOGNIZED",
      "UNKNOWN",
      false
    );
  }
  return {
    provider: "http-email",
    messageId: await hashProviderDeliveryId(acceptedId)
  };
}

async function readHttpProviderResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    return null;
  }
  let responseBody: string;
  try {
    responseBody = await response.text();
  } catch {
    return null;
  }
  if (!responseBody || responseBody.length > HTTP_PROVIDER_RESPONSE_MAX_CHARS) {
    return null;
  }
  try {
    return JSON.parse(responseBody) as unknown;
  } catch {
    return null;
  }
}

function httpProviderAcceptedId(status: number, body: unknown): string | null {
  if (!HTTP_PROVIDER_ACCEPTED_STATUSES.has(status) || !isRecord(body)) {
    return null;
  }
  if (body.status !== "accepted") {
    return null;
  }
  return providerAcceptanceId(body.id ?? body.messageId);
}

function httpProviderRejectionCode(status: number, body: unknown): string | null {
  if (status < 400 || status > 499 || !isRecord(body)) {
    return null;
  }
  if (body.status !== "rejected" || body.accepted !== false) {
    return null;
  }
  const code =
    typeof body.code === "string" && PROVIDER_CODE_PATTERN.test(body.code.trim())
      ? body.code.trim()
      : null;
  return code ? `HTTP_PROVIDER_${code}` : null;
}

function providerIdentityHeaders(idempotencyKey: string): Record<string, string> {
  return {
    "X-Idempotency-Key": idempotencyKey
  };
}

interface EmailPayload {
  from: EmailSenderIdentity;
  to: string;
  replyTo?: string;
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

function providerPayload(
  payload: EmailPayload
): Omit<EmailPayload, "idempotencyKey" | "from"> & { from: string; fromName: string } {
  const { idempotencyKey: _idempotencyKey, from, ...body } = payload;
  return {
    ...body,
    from: from.email,
    fromName: from.name
  };
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

async function templateVersion(emailType: EmailEvidenceType, template: EmailTemplateValue): Promise<string> {
  const payload = JSON.stringify({ emailType, subject: template.subject, body: template.body });
  return `${emailType}:sha256:${await sha256Hex(utf8Bytes(payload))}`;
}

function deliveryIdFromProvider(providerResponse: unknown): string | null {
  if (!isRecord(providerResponse)) return null;
  return typeof providerResponse.messageId === "string" &&
    PROVIDER_DELIVERY_ID_DIGEST_PATTERN.test(providerResponse.messageId)
    ? providerResponse.messageId
    : null;
}

function providerAcceptanceId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

async function hashProviderDeliveryId(value: unknown): Promise<string | null> {
  const acceptedId = providerAcceptanceId(value);
  return acceptedId
    ? `sha256:${await sha256Hex(utf8Bytes(acceptedId))}`
    : null;
}
