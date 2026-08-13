import { degrees, PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import { BRANDING_DONOR_LOGO_OBJECT_KEY } from "./branding";
import { logOperationalAlert } from "./observability";
import { ORG_LOGO_INK_VIEW_HEIGHT, ORG_LOGO_PATHS, ORG_LOGO_VIEW_BOX } from "./orgLogo";
import { CAT012_DEPARTMENTS, CAT020_COUNTRIES, findCatalogOption, getCat008Districts, getCat013Municipalities } from "../../shared/catalogs";
import { formatDocument } from "../../shared/documentFormat";
import { onlyDigits } from "../utils/guards";
import type { DteDocumentRecord } from "../types";

export const DTE_PDF_RENDERER_VERSION = "cde-pdf:v4";

type PdfColor = ReturnType<typeof rgb>;

const LOGO_X = 28;
const LOGO_BOTTOM_Y = 729;
const LOGO_HEIGHT = 42;

// The deployment's Marca logo, already fetched and in a raster format pdf-lib can
// embed. The donor slot is the one these documents use: a receipt/constancia is a
// donor-facing sheet printed on white, which is exactly what that slot is uploaded
// for, while the other slot dresses the admin panel and email chrome.
export interface PdfBrandingLogo {
  bytes: Uint8Array;
  format: "png" | "jpeg";
  appEnv?: string;
}

// Only the ARCHIVE binding and optional APP_ENV token are needed; kept structural so
// callers (and tests) can pass a bare object, mirroring branding.ts's BrandingOriginEnv.
export interface BrandingLogoArchiveEnv {
  ARCHIVE?: R2Bucket;
  APP_ENV?: string;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

// Reads the stored donor branding logo once, for the caller to hand to every document
// it renders in that request. Returns null for every unusable case — no logo stored,
// R2 unavailable or erroring, or a format pdf-lib cannot embed (SVG is accepted by the
// upload form for the web chrome, but pdf-lib embeds PNG and JPEG only) — and the
// documents then draw the built-in vector. A misconfigured logo must never be able to
// fail a receipt, so nothing here throws.
export async function loadPdfBrandingLogo(env: BrandingLogoArchiveEnv): Promise<PdfBrandingLogo | null> {
  let logo: PdfBrandingLogo | null = null;
  try {
    const object = await env.ARCHIVE?.get(BRANDING_DONOR_LOGO_OBJECT_KEY);
    if (object) {
      const bytes = new Uint8Array(await object.arrayBuffer());
      const format = embeddableLogoFormat(bytes);
      logo = format ? { bytes, format, appEnv: env.APP_ENV } : null;
    }
  } catch {
    logo = null;
  }
  if (!logo && env.APP_ENV === "production") {
    logOperationalAlert(env as import("../types").Env, "branding_logo_fallback", "credentials");
  }
  return logo;
}

// Sniffs the bytes instead of trusting the recorded content type: the upload stores
// whatever Content-Type the browser sent, and a mislabelled file would only surface as
// a throw in the middle of rendering a receipt.
function embeddableLogoFormat(bytes: Uint8Array): PdfBrandingLogo["format"] | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return "png";
  }
  return startsWith(bytes, JPEG_SIGNATURE) ? "jpeg" : null;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return bytes.length >= signature.length && signature.every((byte, index) => bytes[index] === byte);
}

// The fixed slot the logo occupies on a document: `height` tall, anchored with its
// bottom edge at `bottomY`, as wide as the built-in artwork's view box at that height.
export interface OrgLogoSlot {
  x: number;
  bottomY: number;
  height: number;
  // Centre a narrower raster inside the slot (the constancia) instead of aligning it
  // to the slot's left edge (the CDE).
  centered: boolean;
}

// Draws the configured branding logo into the slot, falling back to the built-in
// vector whenever there is none or it cannot be embedded. The raster keeps its own
// aspect ratio and is fitted inside the slot's width and the artwork's reserved ink
// band (see orgLogo.ts), so neighbouring text keeps the clearance the layout assumes.
export async function drawOrganizationLogo(
  pdf: PDFDocument,
  page: PDFPage,
  slot: OrgLogoSlot,
  logo?: PdfBrandingLogo | null
): Promise<void> {
  const scale = slot.height / ORG_LOGO_VIEW_BOX.height;
  const slotWidth = ORG_LOGO_VIEW_BOX.width * scale;
  const topY = slot.bottomY + slot.height;
  const image = await embedBrandingLogo(pdf, logo);
  if (image) {
    const maxHeight = slot.height * (ORG_LOGO_INK_VIEW_HEIGHT / ORG_LOGO_VIEW_BOX.height);
    const fit = Math.min(slotWidth / image.width, maxHeight / image.height);
    const width = image.width * fit;
    const height = image.height * fit;
    page.drawImage(image, {
      x: slot.centered ? slot.x + (slotWidth - width) / 2 : slot.x,
      y: topY - height,
      width,
      height
    });
    return;
  }
  for (const path of ORG_LOGO_PATHS) {
    page.drawSvgPath(path, { x: slot.x, y: topY, scale, color: rgb(0, 0, 0) });
  }
}

async function embedBrandingLogo(pdf: PDFDocument, logo: PdfBrandingLogo | null | undefined): Promise<PDFImage | null> {
  if (!logo) {
    return null;
  }
  try {
    return logo.format === "png" ? await pdf.embedPng(logo.bytes) : await pdf.embedJpg(logo.bytes);
  } catch {
    // Truncated, corrupt, or a variant pdf-lib rejects (e.g. interlaced PNG): the
    // document still has to be issued, so fall through to the built-in vector.
    if (logo.appEnv === "production") {
      logOperationalAlert({ APP_ENV: logo.appEnv } as import("../types").Env, "branding_logo_fallback", "credentials");
    }
    return null;
  }
}

export async function renderDtePdf(record: DteDocumentRecord, logo?: PdfBrandingLogo | null): Promise<Uint8Array> {
  const document = JSON.parse(record.plain_json) as CdePdfJson;
  const emisor = document.emisor ?? document.donatario ?? {};
  const receptor = document.receptor ?? document.donante ?? {};
  const item = document.cuerpoDocumento?.[0] ?? {};
  const amount = numberValue(document.resumen?.valorTotal, record.amount_cents / 100);
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const grayFill = rgb(0.88, 0.88, 0.88);
  const green = rgb(0.0, 0.46, 0.07);

  await drawOrganizationLogo(pdf, page, { x: LOGO_X, bottomY: LOGO_BOTTOM_Y, height: LOGO_HEIGHT, centered: false }, logo);
  drawCentered(page, "DOCUMENTO TRIBUTARIO ELECTRÓNICO", 769, 9, bold, 190, 230);
  drawCentered(page, "COMPROBANTE DE DONACIÓN", 744, 14, bold, 170, 275);
  drawQr(page, buildDteQrPayload(record), 508, 690, 82);

  drawRoundedRectangle(page, { x: 18, y: 685, width: 294, height: 40, radius: 5, color: grayFill });
  drawKeyValue(page, "Código de generación:", record.codigo_generacion, 24, 716, 84, regular, bold, 7.6, black);
  drawKeyValue(page, "Número de control:", record.numero_control, 24, 704, 84, regular, bold, 7.6, black);
  drawKeyValue(page, "Sello de recepción:", record.sello_recibido ?? "TRANSITORIO", 24, 692, 84, regular, bold, 7.6, green);

  drawTextSafe(page, `TIPO DE MODELO: v${document.identificacion?.version ?? ""}`, { x: 318, y: 716, size: 7.7, font: regular, color: black });
  drawTextSafe(page, `PREVIO / TIPO DTE: ${record.tipo_dte}`, { x: 404, y: 716, size: 7.7, font: regular, color: black });
  drawTextSafe(page, `TIPO DE TRANSMISIÓN: ${transmissionLabel(document.identificacion?.tipoOperacion)}`, { x: 318, y: 704, size: 7.7, font: regular, color: black });
  drawTextSafe(page, `FECHA: ${formatDate(document.identificacion?.fecEmi)}`, { x: 318, y: 692, size: 7.7, font: bold, color: black });
  drawTextSafe(page, "Moneda:", { x: 424, y: 692, size: 7.7, font: regular, color: black });
  drawTextSafe(page, document.identificacion?.tipoMoneda ?? "USD", { x: 464, y: 692, size: 7.7, font: regular, color: black });

  drawCentered(page, "EMISOR:", 675, 7.5, bold, 18, 294);
  drawCentered(page, "RECEPTOR:", 675, 7.5, bold, 318, 276);
  drawPartyBox(page, {
    x: 18,
    y: 574,
    width: 294,
    height: 97,
    regular,
    bold,
    nameLabel: "Nombre o razón social:",
    name: emisor.nombre,
    activity: emisor.descActividad,
    nrc: formatNrc(emisor.nrc),
    documentLabel: "NIT:",
    documentNumber: formatDocument(emisor.numDocumento),
    addressLines: emisorLines(emisor)
  });
  drawPartyBox(page, {
    x: 318,
    y: 574,
    width: 276,
    height: 97,
    regular,
    bold,
    nameLabel: "Cliente:",
    name: receptor.nombre,
    activity: receptor.descActividad ?? "Empleados",
    nrc: formatNrc(receptor.nrc),
    documentLabel: documentLabelFor(receptor.tipoDocumento),
    documentNumber: formatDocument(receptor.numDocumento),
    addressLines: [receptorContactLine(receptor, foreignAddressFromApendice(document))]
  });

  drawItemsTable(page, item, amount, regular);
  drawTotals(page, amount, document.resumen?.totalLetras, regular, bold);
  if (record.status === "INVALIDATED") {
    drawInvalidatedWatermark(page, bold);
  }

  return pdf.save();
}

function drawRoundedRectangle(
  page: PDFPage,
  options: {
    x: number;
    y: number;
    width: number;
    height: number;
    radius: number;
    color?: PdfColor;
    borderColor?: PdfColor;
    borderWidth?: number;
  }
): void {
  const radius = Math.max(0, Math.min(options.radius, options.width / 2, options.height / 2));
  const { x, y, width, height, color, borderColor, borderWidth } = options;
  if (radius === 0) {
    page.drawRectangle({ x, y, width, height, color, borderColor, borderWidth });
    return;
  }
  const path = [
    `M ${radius} 0`,
    `L ${width - radius} 0`,
    `Q ${width} 0 ${width} ${radius}`,
    `L ${width} ${height - radius}`,
    `Q ${width} ${height} ${width - radius} ${height}`,
    `L ${radius} ${height}`,
    `Q 0 ${height} 0 ${height - radius}`,
    `L 0 ${radius}`,
    `Q 0 0 ${radius} 0`,
    "Z"
  ].join(" ");
  page.drawSvgPath(path, {
    x,
    y: y + height,
    scale: 1,
    color,
    borderColor,
    borderWidth
  });
}

function drawPartyBox(
  page: PDFPage,
  options: {
    x: number;
    y: number;
    width: number;
    height: number;
    regular: PDFFont;
    bold: PDFFont;
    nameLabel: string;
    name?: string | null;
    activity?: string | null;
    nrc?: string | null;
    documentLabel: string;
    documentNumber?: string | null;
    addressLines: string[];
  }
): void {
  const black = rgb(0, 0, 0);
  drawRoundedRectangle(page, { x: options.x, y: options.y, width: options.width, height: options.height, radius: 6, borderColor: black, borderWidth: 0.8 });
  const left = options.x + 6;
  const valueX = options.x + (options.width > 285 ? 91 : 82);
  const docX = options.x + (options.width > 285 ? 106 : 86);
  drawKeyValue(page, options.nameLabel, safeUpper(options.name), left, options.y + options.height - 16, valueX - left, options.regular, options.bold, 7.2, black);
  drawKeyValue(page, "Actividad económica:", safeUpper(options.activity), left, options.y + options.height - 38, valueX - left, options.regular, options.bold, 7.2, black);
  drawKeyValue(page, "NRC:", safeUpper(options.nrc), left, options.y + options.height - 60, 26, options.regular, options.bold, 7.2, black);
  // Ancho de etiqueta dinámico: "Documento:"/"Pasaporte:" son más anchas que los 22pt
  // fijos pensados para "DUI:"/"NIT:", y el número se imprimía ENCIMA de la etiqueta.
  const documentLabelWidth = Math.max(22, options.bold.widthOfTextAtSize(options.documentLabel, 7.2) + 3);
  drawKeyValue(page, options.documentLabel, safeUpper(options.documentNumber), docX, options.y + options.height - 60, documentLabelWidth, options.regular, options.bold, 7.2, black);
  const addressFontSize = 7.1;
  const innerWidth = options.width - 12;
  const wrapped = clampLines(
    options.addressLines.flatMap((line) => wrapText(line, options.regular, addressFontSize, innerWidth)),
    3,
    options.regular,
    addressFontSize,
    innerWidth
  );
  wrapped.forEach((line, index) => {
    drawTextSafe(page, line, { x: left, y: options.y + 26 - index * 10.5, size: addressFontSize, font: options.regular, color: black });
  });
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  text = pdfSafeText(text, font);
  const source = clean(text);
  if (!source) {
    return [];
  }
  if (font.widthOfTextAtSize(source, size) <= maxWidth) {
    return [source];
  }
  const lines: string[] = [];
  let current = "";
  const flush = () => {
    if (current) {
      lines.push(current);
      current = "";
    }
  };
  // Prefer breaking at ", " and " / " so multi-word geographic segments (e.g. "SAN SALVADOR
  // ESTE") stay whole; only fall back to word/character breaks when a single segment is itself
  // wider than the box.
  for (const segment of splitAddressSegments(source)) {
    const candidate = current ? `${current} ${segment}` : segment;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    flush();
    if (font.widthOfTextAtSize(segment, size) <= maxWidth) {
      current = segment;
      continue;
    }
    for (const fragment of wrapWords(segment, font, size, maxWidth)) {
      lines.push(fragment);
    }
  }
  flush();
  return lines;
}

function splitAddressSegments(source: string): string[] {
  return source
    .split(/(?<=,)\s+|\s+(?=\/(?:\s|$))/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function wrapWords(segment: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of segment.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      current = word;
    } else {
      lines.push(truncateToWidth(word, font, size, maxWidth));
    }
  }
  if (current) {
    lines.push(current);
  }
  return lines;
}

function truncateToWidth(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const ellipsis = "…";
  if (font.widthOfTextAtSize(ellipsis, size) > maxWidth) {
    return ellipsis;
  }
  let truncated = text;
  while (truncated && font.widthOfTextAtSize(`${truncated}${ellipsis}`, size) > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}${ellipsis}`;
}

function clampLines(lines: string[], maxLines: number, font: PDFFont, size: number, maxWidth: number): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1];
  kept[maxLines - 1] = last.endsWith("…") ? last : truncateToWidth(last, font, size, maxWidth);
  return kept;
}

function drawItemsTable(page: PDFPage, item: CdeItem, amount: number, regular: PDFFont): void {
  const black = rgb(0, 0, 0);
  drawRoundedRectangle(page, { x: 18, y: 548, width: 576, height: 22, radius: 5, color: black });
  drawTextSafe(page, "CANTIDAD", { x: 24, y: 555, size: 8.3, font: regular, color: rgb(1, 1, 1) });
  drawCentered(page, "DESCRIPCIÓN", 555, 8.3, regular, 145, 280, rgb(1, 1, 1));
  drawRightAligned(page, "VALOR", 555, 8.3, regular, 588, rgb(1, 1, 1));

  drawTextSafe(page, formatQuantity(numberValue(item.cantidad, 1)), { x: 24, y: 538, size: 8.2, font: regular, color: black });
  drawTextSafe(page, clean(item.descripcion) || "DONACIÓN", { x: 75, y: 538, size: 8.2, font: regular, color: black });
  drawRightAligned(page, formatMoney(numberValue(item.valor, amount), false), 538, 8.2, regular, 588, black);
}

function drawTotals(page: PDFPage, amount: number, totalLetras: string | null | undefined, regular: PDFFont, bold: PDFFont): void {
  const black = rgb(0, 0, 0);
  drawRoundedRectangle(page, { x: 18, y: 16, width: 354, height: 62, radius: 5, borderColor: rgb(0.45, 0.45, 0.45), borderWidth: 0.7 });
  drawTextSafe(page, `Valor en Letras:  ${amountInWords(amount, totalLetras)}`, { x: 24, y: 66, size: 7.9, font: regular, color: black });
  drawTextSafe(page, "Observaciones:", { x: 24, y: 39, size: 7.9, font: regular, color: black });

  drawRoundedRectangle(page, { x: 375, y: 16, width: 220, height: 28, radius: 3, borderColor: black, borderWidth: 1.2 });
  drawTextSafe(page, "Total de la Donación", { x: 381, y: 29, size: 8.4, font: bold, color: black });
  drawTextSafe(page, "$", { x: 480, y: 29, size: 8.4, font: regular, color: black });
  drawRightAligned(page, formatMoney(amount, false), 29, 8.4, bold, 588, black);
}

function drawQr(page: PDFPage, text: string, x: number, y: number, size: number): void {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" }) as unknown as { modules: { size: number; data: Uint8Array } };
  const moduleSize = size / qr.modules.size;
  qr.modules.data.forEach((enabled, index) => {
    if (enabled === 0) {
      return;
    }
    const row = Math.floor(index / qr.modules.size);
    const col = index % qr.modules.size;
    page.drawRectangle({
      x: x + col * moduleSize,
      y: y + size - (row + 1) * moduleSize,
      width: moduleSize,
      height: moduleSize,
      color: rgb(0, 0, 0)
    });
  });
}

function drawInvalidatedWatermark(page: PDFPage, font: PDFFont): void {
  const text = "INVALIDADO";
  const size = 116;
  drawTextSafe(page, text, {
    x: 92,
    y: 95,
    size,
    font,
    color: rgb(0.82, 0.03, 0.03),
    opacity: 0.2,
    rotate: degrees(45)
  });
}

function drawKeyValue(
  page: PDFPage,
  label: string,
  value: string,
  x: number,
  y: number,
  labelWidth: number,
  regular: PDFFont,
  bold: PDFFont,
  size: number,
  valueColor = rgb(0, 0, 0)
): void {
  drawTextSafe(page, label, { x, y, size, font: bold, color: rgb(0, 0, 0) });
  drawTextSafe(page, value, { x: x + labelWidth, y, size, font: regular, color: valueColor });
}

function drawCentered(page: PDFPage, text: string, y: number, size: number, font: PDFFont, x = 0, width = 612, color = rgb(0, 0, 0)): void {
  drawTextSafe(page, text, { x: x + (width - font.widthOfTextAtSize(text, size)) / 2, y, size, font, color });
}

function drawRightAligned(page: PDFPage, text: string, y: number, size: number, font: PDFFont, rightX: number, color = rgb(0, 0, 0)): void {
  drawTextSafe(page, text, { x: rightX - font.widthOfTextAtSize(text, size), y, size, font, color });
}

export function buildDteQrPayload(record: DteDocumentRecord): string {
  const document = JSON.parse(record.plain_json) as CdePdfJson;
  const params = new URLSearchParams({
    ambiente: record.environment,
    codGen: record.codigo_generacion,
    fechaEmi: document.identificacion?.fecEmi ?? record.issued_at.slice(0, 10)
  });
  if (record.status === "INVALIDATED") {
    params.set("estado", "INVALIDADO");
  }
  return `https://admin.factura.gob.sv/consultaPublica?${params.toString()}`;
}

function emisorLines(emisor: Party): string[] {
  const establishmentName = emisor.nombreComercial ?? emisor.nombre;
  const establishment = establishmentName ? `• ${safeUpper(establishmentName)}` : "";
  const address = [safeUpper(addressText(emisor.direccion)), emisor.telefono ? `/ Tel.: ${safeUpper(emisor.telefono)}` : ""].filter(Boolean).join(" ");
  // The box clamps at 3 rendered lines and a full geographic address wraps onto
  // two of them, so the correo rides on the (short) establishment line — a fourth
  // logical line would be clamped away.
  const correo = emisor.correo ? `Correo: ${clean(emisor.correo)}` : "";
  return [[establishment, correo].filter(Boolean).join(" / "), `• ${address} /`].filter(Boolean);
}

function receptorContactLine(receptor: Party, foreignAddress: string | null): string {
  return [
    safeUpper(receptorAddressText(receptor, foreignAddress)),
    receptor.telefono ? `Tel.: ${safeUpper(receptor.telefono)}` : "",
    receptor.correo ? `Correo: ${clean(receptor.correo)}` : ""
  ]
    .filter(Boolean)
    .join(" / ");
}

// El documento legal de un receptor extranjero lleva direccion null (MH rechaza el
// objeto para no domiciliados); su país y la dirección que escribió viajan en el
// apéndice DireccionExtranjera, de donde el PDF los recupera.
function foreignAddressFromApendice(document: CdePdfJson): string | null {
  const entries = Array.isArray(document.apendice) ? (document.apendice as unknown[]) : [];
  const entry = entries.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).campo === "DireccionExtranjera");
  const valor = entry ? (entry as Record<string, unknown>).valor : null;
  return typeof valor === "string" && valor.trim() ? valor.trim() : null;
}

// Foreign receptor (the 00 "Otro (Para extranjeros)" geography): the CAT-008/012/013
// labels would print "Otro (Para extranjeros)" three times, so render the donor's
// complemento followed by their CAT-020 country label instead. This special case
// lives here (not in addressText) because codPais sits on the receptor, outside the
// direccion object addressText receives.
function receptorAddressText(receptor: Party, foreignAddress: string | null): string {
  // Documentos actuales: direccion null + apéndice DireccionExtranjera.
  if (!receptor.direccion) {
    if (foreignAddress) {
      return foreignAddress;
    }
    // Sin apéndice (p. ej. documentos ajenos al asistente): al menos el país.
    const country = findCatalogOption(CAT020_COUNTRIES, receptor.codPais);
    const nonDomiciled = receptor.codDomiciliado === 2 || receptor.codDomiciliado === "2";
    return nonDomiciled && country ? country.label : "";
  }
  // Documentos históricos (pre-fix): el marcador 00 "Otro (Para extranjeros)".
  if (clean(receptor.direccion?.departamento) === "00") {
    const country = findCatalogOption(CAT020_COUNTRIES, receptor.codPais);
    return [clean(receptor.direccion?.complemento), country?.label]
      .map((part) => clean(part))
      .filter(Boolean)
      .join(", ");
  }
  return addressText(receptor.direccion);
}

function documentLabelFor(tipoDocumento: string | null | undefined): string {
  switch (clean(tipoDocumento)) {
    case "36":
      return "NIT:";
    case "13":
      return "DUI:";
    case "03":
      return "Pasaporte:";
    case "02":
      return "Carné de residente:";
    default:
      return "Documento:";
  }
}

function addressText(direccion: Party["direccion"]): string {
  if (!direccion) {
    return "";
  }
  const department = findCatalogOption(CAT012_DEPARTMENTS, direccion.departamento);
  const municipality = findCatalogOption(getCat013Municipalities(direccion.departamento), direccion.municipio);
  const district = findCatalogOption(getCat008Districts(direccion.departamento), direccion.distrito);
  return [clean(direccion.complemento), district?.label, municipality?.label, department?.label]
    .map((part) => clean(part))
    .filter(Boolean)
    .join(", ");
}

function transmissionLabel(tipoOperacion: number | undefined): string {
  return tipoOperacion === 2 ? "CONTINGENCIA" : "NORMAL";
}

function formatDate(value: string | undefined): string {
  if (!value) {
    return "";
  }
  const [year, month, day] = value.split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
}

function formatMoney(value: number, withSymbol = true): string {
  return `${withSymbol ? "$" : ""}${value.toFixed(2)}`;
}

function formatQuantity(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatNrc(value: string | null | undefined): string {
  const digits = onlyDigits(value);
  return digits.length === 7 ? `${digits.slice(0, 6)}-${digits.slice(6)}` : value ?? "";
}


// Los StandardFonts de pdf-lib codifican WinAnsi: un emoji o CJK en un campo escrito
// por el donante (Wompi los deja pasar) lanzaba en drawText y tumbaba el correo del
// comprobante. Cada carácter no codificable se reemplaza por "?" antes de dibujar.
export function pdfSafeText(value: string, font: PDFFont): string {
  return Array.from(value, (char) => {
    try {
      font.encodeText(char);
      return char;
    } catch {
      return "?";
    }
  }).join("");
}

export function drawTextSafe(page: PDFPage, text: string, options: Parameters<PDFPage["drawText"]>[1] & { font: PDFFont }): void {
  page.drawText(pdfSafeText(text, options.font), options);
}

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function safeUpper(value: string | null | undefined): string {
  return clean(value).toUpperCase();
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}


function amountInWords(amount: number, provided: string | null | undefined): string {
  const integer = Math.floor(Math.abs(amount));
  const cents = Math.round((Math.abs(amount) - integer) * 100);
  const words = cleanProvidedWords(provided) || integerToSpanish(integer);
  return `${words} DOLARES ${String(cents).padStart(2, "0")}/100 CTVS.`;
}

function cleanProvidedWords(value: string | null | undefined): string {
  return clean(value)
    .replace(/\s+\d{2}\s*\/\s*100.*$/i, "")
    .replace(/\s+DOLARES.*$/i, "")
    .trim();
}

function integerToSpanish(value: number): string {
  if (value === 0) {
    return "CERO";
  }
  if (value < 1000) {
    return hundredsToSpanish(value);
  }
  if (value < 1_000_000) {
    const thousands = Math.floor(value / 1000);
    const remainder = value % 1000;
    const prefix = thousands === 1 ? "MIL" : `${hundredsToSpanish(thousands)} MIL`;
    return remainder === 0 ? prefix : `${prefix} ${hundredsToSpanish(remainder)}`;
  }
  return String(value);
}

function hundredsToSpanish(value: number): string {
  const hundreds = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS", "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];
  if (value === 100) {
    return "CIEN";
  }
  const hundred = Math.floor(value / 100);
  const remainder = value % 100;
  return [hundreds[hundred], tensToSpanish(remainder)].filter(Boolean).join(" ");
}

function tensToSpanish(value: number): string {
  const units = ["", "UNO", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE"];
  const specials: Record<number, string> = {
    10: "DIEZ",
    11: "ONCE",
    12: "DOCE",
    13: "TRECE",
    14: "CATORCE",
    15: "QUINCE",
    20: "VEINTE"
  };
  if (value < 10) {
    return units[value];
  }
  if (specials[value]) {
    return specials[value];
  }
  if (value < 20) {
    return `DIECI${units[value - 10]}`;
  }
  if (value < 30) {
    return `VEINTI${units[value - 20]}`;
  }
  const tens = ["", "", "", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
  const ten = Math.floor(value / 10);
  const unit = value % 10;
  return unit === 0 ? tens[ten] : `${tens[ten]} Y ${units[unit]}`;
}

interface CdePdfJson {
  identificacion?: {
    version?: number;
    tipoOperacion?: number;
    fecEmi?: string;
    tipoMoneda?: string;
  };
  emisor?: Party;
  donatario?: Party;
  receptor?: Party;
  donante?: Party;
  cuerpoDocumento?: CdeItem[];
  apendice?: unknown;
  resumen?: {
    valorTotal?: number;
    totalLetras?: string | null;
  };
}

interface Party {
  numDocumento?: string | null;
  tipoDocumento?: string | null;
  nrc?: string | null;
  nombre?: string | null;
  descActividad?: string | null;
  nombreComercial?: string | null;
  direccion?: {
    departamento?: string | null;
    municipio?: string | null;
    distrito?: string | null;
    complemento?: string | null;
  } | null;
  telefono?: string | null;
  correo?: string | null;
  codDomiciliado?: number | string | null;
  codEstable?: string | null;
  // CAT-020 nationality country; drives the foreign-address rendering when the
  // direccion carries the 00 "Otro (Para extranjeros)" geography.
  codPais?: string | null;
}

interface CdeItem {
  cantidad?: number;
  descripcion?: string;
  valor?: number;
}
