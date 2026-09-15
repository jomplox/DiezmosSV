import { EL_SALVADOR_TIME_ZONE } from "../../shared/legalWindows";
import { formatCents } from "../../shared/money";
import type { DteDocumentRecord } from "../types";

// Fallback accent for an unbranded deployment (matches BRANDING_DEFAULTS.accentColor).
// White-label callers thread a church's own color through the *Options.brandColor.
const DEFAULT_BRAND_COLOR = "#0f766e";

// Contacto de soporte por defecto para ambas vías (SV y EE. UU.): se muestra una sola
// vez en el pie compartido. Cada iglesia puede configurar el suyo en Marca; este valor
// queda solo como respaldo cuando no se ha configurado ninguno.
const DEFAULT_SUPPORT_EMAIL = "legacy-contact-1@example.com";
const DEFAULT_ORGANIZATION_NAME = "ExamplePerson1";
const TEXT_COLOR = "#1f2a2e";
const MUTED_COLOR = "#52656c";
const BORDER_COLOR = "#dfe6e8";
const CARD_BACKGROUND = "#f7f9fa";

export interface DteEmailHtmlOptions {
  organizationName: string;
  brandColor?: string;
  supportEmail?: string;
  logoUrl?: string | null;
}

export function dteEmailHtml(record: DteDocumentRecord, bodyText: string, options: DteEmailHtmlOptions): string {
  const banner = statusBanner(record);
  const testNote =
    record.environment === "00"
      ? note("Documento emitido en el ambiente de pruebas del Ministerio de Hacienda; no tiene validez fiscal.")
      : "";
  const details = detailsCard([
    ["Donante", record.donor_name ?? "—"],
    ["Número de control", record.numero_control],
    ["Código de generación", record.codigo_generacion],
    ["Monto", formatCents(record.amount_cents)],
    ["Fecha de emisión", elSalvadorDate(record.issued_at)],
    ["Sello de recepción", record.sello_recibido ?? "Pendiente"],
    ["Ambiente", record.environment === "01" ? "Producción" : "Pruebas"]
  ]);
  const brandColor = options.brandColor ?? DEFAULT_BRAND_COLOR;
  return emailDocument(options.organizationName, "Comprobante de Donación Electrónico", brandColor, options.supportEmail, options.logoUrl, [
    banner,
    emailTemplateBody(bodyText),
    details,
    testNote,
    footNote("Se adjuntan la representación gráfica en PDF y el documento electrónico en JSON.")
  ]);
}

export interface BrandingEmailOptions {
  organizationName: string;
  brandColor?: string;
  supportEmail?: string;
  logoUrl?: string | null;
}

export function editableDonorEmailHtml(input: {
  organizationName: string;
  title: string;
  bodyText: string;
  brandColor?: string;
  supportEmail?: string;
  logoUrl?: string | null;
}): string {
  return emailDocument(
    input.organizationName,
    input.title,
    input.brandColor ?? DEFAULT_BRAND_COLOR,
    input.supportEmail,
    input.logoUrl,
    [emailTemplateBody(input.bodyText)]
  );
}

export function emailTemplatePlainText(bodyText: string): string {
  return bodyText
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/^\s*>\s?/, ""))
    .join("\n")
    .replace(/(?<!\\)\*\*([^*\n]+)(?<!\\)\*\*/g, "$1")
    .replace(/(?<!\\)\*([^*\n]+)(?<!\\)\*/g, "$1")
    .replace(/(?<!\\)\+\+([^+\n]+)(?<!\\)\+\+/g, "$1")
    .replace(/\\([\\*+>])/g, "$1");
}

export function passwordResetEmailHtml(
  name: string,
  link: string,
  expiresMinutes: number,
  options: BrandingEmailOptions = { organizationName: DEFAULT_ORGANIZATION_NAME }
): string {
  const organizationName = options.organizationName || DEFAULT_ORGANIZATION_NAME;
  const brandColor = options.brandColor ?? DEFAULT_BRAND_COLOR;
  const safeLink = escapeHtml(link);
  const button = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto;">
      <tr>
        <td style="border-radius:8px;background:${brandColor};">
          <a href="${safeLink}" style="display:inline-block;padding:12px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;">Crear nueva contraseña</a>
        </td>
      </tr>
    </table>`;
  return emailDocument(organizationName, "Panel de administración", brandColor, options.supportEmail, options.logoUrl, [
    paragraphs(
      `Hola ${name}:\n\nRecibimos una solicitud para restablecer su contraseña en ${organizationName}. Use el botón para crear una nueva contraseña; el enlace vence en ${expiresMinutes} minutos.`
    ),
    button,
    note(`Si el botón no funciona, copie y pegue este enlace en su navegador: ${link}`),
    footNote("Si usted no solicitó este cambio, ignore este mensaje; su contraseña actual sigue vigente.")
  ]);
}

export function loginStepUpEmailHtml(
  name: string,
  code: string,
  expiresMinutes: number,
  options: BrandingEmailOptions = { organizationName: DEFAULT_ORGANIZATION_NAME }
): string {
  const organizationName = options.organizationName || DEFAULT_ORGANIZATION_NAME;
  const brandColor = options.brandColor ?? DEFAULT_BRAND_COLOR;
  const codeBlock = `
    <div style="margin:24px auto;padding:14px 18px;max-width:240px;border:1px solid ${BORDER_COLOR};border-radius:8px;background:${CARD_BACKGROUND};font-family:Arial,Helvetica,sans-serif;font-size:30px;font-weight:bold;letter-spacing:8px;text-align:center;color:${TEXT_COLOR};">${escapeHtml(code)}</div>`;
  return emailDocument(organizationName, "Verificación de inicio de sesión", brandColor, options.supportEmail, options.logoUrl, [
    paragraphs(
      `Hola ${name}:\n\nPara proteger su cuenta después de varios intentos fallidos, confirme este inicio de sesión con el código de un solo uso. Vence en ${expiresMinutes} minutos.`
    ),
    codeBlock,
    footNote("Si usted no intentó iniciar sesión, no comparta este código y puede ignorar este mensaje.")
  ]);
}

export interface OperationalAlertInput {
  kind: string;
  title: string;
  detail: string;
  entityType: string;
  entityId: string;
}

export function operationalAlertHtml(
  alert: OperationalAlertInput,
  originUrl: string,
  options: BrandingEmailOptions = { organizationName: DEFAULT_ORGANIZATION_NAME }
): string {
  const organizationName = options.organizationName || DEFAULT_ORGANIZATION_NAME;
  const brandColor = options.brandColor ?? DEFAULT_BRAND_COLOR;
  const banner = alertBanner(alert.kind, alert.title);
  const details = detailsCard([
    ["Tipo de evento", alert.kind],
    ["Entidad", alert.entityType],
    ["Identificador", alert.entityId]
  ]);
  return emailDocument(organizationName, "Alerta operativa", brandColor, options.supportEmail, options.logoUrl, [
    banner,
    paragraphs(alert.detail),
    details,
    note(`Revise el panel de administración para más detalles: ${originUrl}`)
  ]);
}

export interface CertificateEmailInput {
  organizationName: string;
  donorName: string;
  year: number;
  count: number;
  totalLabel: string;
  isTestEnvironment: boolean;
  brandColor?: string;
  supportEmail?: string;
  logoUrl?: string | null;
}

export function certificateEmailHtml(input: CertificateEmailInput): string {
  const testNote = input.isTestEnvironment
    ? note("Esta constancia incluye documentos emitidos en el ambiente de pruebas del Ministerio de Hacienda; no tiene validez fiscal.")
    : "";
  const details = detailsCard([
    ["Año", String(input.year)],
    ["Donaciones", String(input.count)],
    ["Total del año", input.totalLabel]
  ]);
  return emailDocument(input.organizationName, "Constancia anual de donaciones", input.brandColor ?? DEFAULT_BRAND_COLOR, input.supportEmail, input.logoUrl, [
    paragraphs(
      `Estimado(a) ${input.donorName}:\n\n` +
        `Adjuntamos su constancia de donaciones correspondiente al año ${input.year}. ` +
        `El documento resume las donaciones que usted realizó durante el año y puede utilizarlo como respaldo informativo. ` +
        `Los comprobantes de donación electrónicos (CDE) individuales siguen siendo sus comprobantes fiscales.`
    ),
    details,
    testNote,
    footNote("Se adjunta la constancia anual en formato PDF.")
  ]);
}

function alertBanner(kind: string, title: string): string {
  // Ámbar para avisos operativos (histórico de contingencia y MH no disponible);
  // rojo para fallos.
  const isWarning = kind.startsWith("CONTINGENCY") || kind === "MH_UNAVAILABLE";
  const background = isWarning ? "#fdf3e1" : "#fdecec";
  const border = isWarning ? "#ecd196" : "#f2b8b5";
  const color = isWarning ? "#7a5c00" : "#8c1d18";
  return `<div style="margin:0 0 18px;padding:10px 14px;border-radius:8px;background:${background};border:1px solid ${border};color:${color};font-weight:bold;text-align:center;">${escapeHtml(title)}</div>`;
}

function emailDocument(
  organizationName: string,
  strapline: string,
  brandColor: string,
  supportEmail: string | undefined,
  logoUrl: string | null | undefined,
  blocks: string[]
): string {
  // A configured church contact wins; otherwise fall back to the historical default.
  const contact = escapeHtml(supportEmail?.trim() || DEFAULT_SUPPORT_EMAIL);
  const logo = headerLogo(logoUrl, organizationName);
  // The logo is centered above the name; without one, the header keeps its historical
  // left-aligned layout so a logo-less deployment renders exactly as before.
  const headerAlign = logo ? "text-align:center;" : "";
  // Standards-aware clients can honor `only light`; the HTML bgcolor plus solid
  // background image preserves a branded header fallback in clients that ignore it.
  return `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="only light" />
    <style>:root { color-scheme: only light; }</style>
  </head>
  <body style="margin:0;padding:0;background:#eef3f4;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f4;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${BORDER_COLOR};border-radius:10px;overflow:hidden;">
            <tr>
              <td bgcolor="${brandColor}" style="background-color:${brandColor};background-image:linear-gradient(${brandColor},${brandColor});padding:18px 28px;${headerAlign}">
                ${logo}<span style="font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:bold;color:#ffffff;">${escapeHtml(organizationName)}</span><br />
                <span style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#d2eae7;">${escapeHtml(strapline)}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:${TEXT_COLOR};">
                ${blocks.filter(Boolean).join("\n")}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px;border-top:1px solid ${BORDER_COLOR};font-family:Arial,Helvetica,sans-serif;font-size:11px;color:${MUTED_COLOR};">
                Correo generado automáticamente por ${escapeHtml(organizationName)}. Por favor no responda a este mensaje.<br />¿Dudas o necesita ayuda? Escríbanos a <a href="mailto:${contact}" style="color:#595959;">${contact}</a>.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// The white-label logo in the header, centered above the organization name. Returns "" when
// no logo is configured (keeps the historical logo-less header untouched). Email clients block
// remote images by default, so the name text below stays the reliable identifier and the img
// carries the organization name as alt. Inline, email-safe sizing only: block + auto margins,
// max-height ~64px / max-width ~240px so wide uploaded logos stay legible without overflowing.
function headerLogo(logoUrl: string | null | undefined, organizationName: string): string {
  const url = logoUrl?.trim();
  if (!url) {
    return "";
  }
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(organizationName)}" style="display:block;margin:0 auto 12px;max-height:64px;max-width:240px;" />`;
}

function statusBanner(record: DteDocumentRecord): string {
  if (record.status === "INVALIDATED") {
    return `<div style="margin:0 0 18px;padding:10px 14px;border-radius:8px;background:#fdecec;border:1px solid #f2b8b5;color:#8c1d18;font-weight:bold;text-align:center;">DOCUMENTO INVALIDADO</div>`;
  }
  if (record.status === "CONTINGENCY_PENDING" || (record.status === "SIGNED" && record.transmission_deferred_at)) {
    // Banner en negrita: el adjunto es PROVISIONAL (sello TRANSITORIO); la versión
    // definitiva con Sello de Recepción llega automáticamente al aceptar MH.
    return `<div style="margin:0 0 18px;padding:10px 14px;border-radius:8px;background:#fdf3e1;border:1px solid #ecd196;color:#7a5c00;font-weight:bold;text-align:center;">COMPROBANTE TRANSITORIO</div>`;
  }
  return "";
}

function paragraphs(bodyText: string): string {
  return bodyText
    .split(/\n{2,}/)
    .map((block) => `<p style="margin:0 0 14px;">${escapeHtml(block.trim()).replaceAll("\n", "<br />")}</p>`)
    .join("\n");
}

function emailTemplateBody(bodyText: string): string {
  const fragments: string[] = [];
  let paragraphLines: string[] = [];
  let quoteLines: string[] = [];
  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    fragments.push(`<p style="margin:0 0 14px;">${paragraphLines.map(formatEmailTemplateInline).join("<br />")}</p>`);
    paragraphLines = [];
  };
  const flushQuote = () => {
    if (quoteLines.length === 0) return;
    fragments.push(
      `<blockquote style="margin:0 0 14px;padding:10px 14px;border-left:3px solid ${BORDER_COLOR};background:${CARD_BACKGROUND};color:${MUTED_COLOR};">${quoteLines.map(formatEmailTemplateInline).join("<br />")}</blockquote>`
    );
    quoteLines = [];
  };

  for (const rawLine of bodyText.replace(/\r\n?/g, "\n").split("\n")) {
    const quote = rawLine.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      quoteLines.push(quote[1]);
      continue;
    }
    if (!rawLine.trim()) {
      flushParagraph();
      flushQuote();
      continue;
    }
    flushQuote();
    paragraphLines.push(rawLine.trim());
  }
  flushParagraph();
  flushQuote();
  return fragments.join("\n");
}

function formatEmailTemplateInline(value: string): string {
  return escapeHtml(value)
    .replace(/\\\\/g, "&#92;")
    .replace(/\\\*/g, "&#42;")
    .replace(/\\\+/g, "&#43;")
    .replace(/\\&gt;/g, "&gt;")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
    .replace(/\+\+([^+\n]+)\+\+/g, "<u>$1</u>");
}

function detailsCard(rows: Array<[string, string]>): string {
  const body = rows
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:6px 12px;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:${MUTED_COLOR};white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
        <td style="padding:6px 12px;font-family:'Courier New',monospace;font-size:12px;color:${TEXT_COLOR};word-break:break-all;">${escapeHtml(value)}</td>
      </tr>`
    )
    .join("");
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;background:${CARD_BACKGROUND};border:1px solid ${BORDER_COLOR};border-radius:8px;">
      ${body}
    </table>`;
}

function note(text: string): string {
  return `<p style="margin:0 0 14px;padding:10px 14px;border-radius:8px;background:${CARD_BACKGROUND};border:1px solid ${BORDER_COLOR};font-size:12px;color:${MUTED_COLOR};">${escapeHtml(text)}</p>`;
}

function footNote(text: string): string {
  return `<p style="margin:0;font-size:12px;color:${MUTED_COLOR};">${escapeHtml(text)}</p>`;
}

function elSalvadorDate(iso: string): string {
  return new Intl.DateTimeFormat("es-SV", { dateStyle: "long", timeZone: EL_SALVADOR_TIME_ZONE }).format(new Date(iso));
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
