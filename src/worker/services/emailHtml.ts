import type { DteDocumentRecord } from "../types";

const BRAND_COLOR = "#0f766e";
const TEXT_COLOR = "#1f2a2e";
const MUTED_COLOR = "#52656c";
const BORDER_COLOR = "#dfe6e8";
const CARD_BACKGROUND = "#f7f9fa";

export interface DteEmailHtmlOptions {
  organizationName: string;
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
    ["Monto", money(record.amount_cents)],
    ["Fecha de emisión", elSalvadorDate(record.issued_at)],
    ["Sello de recepción", record.sello_recibido ?? "Pendiente"],
    ["Ambiente", record.environment === "01" ? "Producción" : "Pruebas"]
  ]);
  return emailDocument(options.organizationName, [
    banner,
    paragraphs(bodyText),
    details,
    testNote,
    footNote("Se adjuntan la representación gráfica en PDF y el documento electrónico en JSON.")
  ]);
}

export function passwordResetEmailHtml(name: string, link: string, expiresMinutes: number): string {
  const safeLink = escapeHtml(link);
  const button = `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px auto;">
      <tr>
        <td style="border-radius:8px;background:${BRAND_COLOR};">
          <a href="${safeLink}" style="display:inline-block;padding:12px 28px;font-family:Arial,Helvetica,sans-serif;font-size:15px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;">Crear nueva contraseña</a>
        </td>
      </tr>
    </table>`;
  return emailDocument("ExamplePerson1", [
    paragraphs(
      `Hola ${name}:\n\nRecibimos una solicitud para restablecer su contraseña en ExamplePerson1. Use el botón para crear una nueva contraseña; el enlace vence en ${expiresMinutes} minutos.`
    ),
    button,
    note(`Si el botón no funciona, copie y pegue este enlace en su navegador: ${link}`),
    footNote("Si usted no solicitó este cambio, ignore este mensaje; su contraseña actual sigue vigente.")
  ]);
}

export interface OperationalAlertInput {
  kind: string;
  title: string;
  detail: string;
  entityType: string;
  entityId: string;
}

export function operationalAlertHtml(alert: OperationalAlertInput, originUrl: string): string {
  const banner = alertBanner(alert.kind, alert.title);
  const details = detailsCard([
    ["Tipo de evento", alert.kind],
    ["Entidad", alert.entityType],
    ["Identificador", alert.entityId]
  ]);
  return emailDocument("ExamplePerson1", [
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
  return emailDocument(input.organizationName, [
    paragraphs(
      `Estimado(a) ${input.donorName}:\n\n` +
        `Adjuntamos su constancia de donaciones correspondiente al año ${input.year}. ` +
        `El documento resume las donaciones que usted realizó y puede utilizarlo como respaldo. ` +
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

function emailDocument(organizationName: string, blocks: string[]): string {
  return `<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body style="margin:0;padding:0;background:#eef3f4;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#eef3f4;padding:24px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${BORDER_COLOR};border-radius:10px;overflow:hidden;">
            <tr>
              <td style="background:${BRAND_COLOR};padding:18px 28px;">
                <span style="font-family:Arial,Helvetica,sans-serif;font-size:18px;font-weight:bold;color:#ffffff;">${escapeHtml(organizationName)}</span><br />
                <span style="font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#d2eae7;">Comprobante de Donación Electrónico</span>
              </td>
            </tr>
            <tr>
              <td style="padding:28px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:${TEXT_COLOR};">
                ${blocks.filter(Boolean).join("\n")}
              </td>
            </tr>
            <tr>
              <td style="padding:16px 28px;border-top:1px solid ${BORDER_COLOR};font-family:Arial,Helvetica,sans-serif;font-size:11px;color:${MUTED_COLOR};">
                Correo generado automáticamente por ExamplePerson1. Por favor no responda a este mensaje.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function statusBanner(record: DteDocumentRecord): string {
  if (record.status === "INVALIDATED") {
    return `<div style="margin:0 0 18px;padding:10px 14px;border-radius:8px;background:#fdecec;border:1px solid #f2b8b5;color:#8c1d18;font-weight:bold;text-align:center;">DOCUMENTO INVALIDADO</div>`;
  }
  if (record.status === "CONTINGENCY_PENDING" || record.status === "TRANSMISSION_PENDING") {
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

function money(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`;
}

function elSalvadorDate(iso: string): string {
  return new Intl.DateTimeFormat("es-SV", { dateStyle: "long", timeZone: "America/El_Salvador" }).format(new Date(iso));
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
