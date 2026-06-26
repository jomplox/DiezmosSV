import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import QRCode from "qrcode";
import { ORG_LOGO_PATHS, ORG_LOGO_VIEW_BOX } from "./orgLogo";
import type { DteDocumentRecord } from "../types";

const LOGO_X = 28;
const LOGO_BOTTOM_Y = 729;
const LOGO_HEIGHT = 42;

export async function renderDtePdf(record: DteDocumentRecord): Promise<Uint8Array> {
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

  drawOrganizationLogo(page);
  drawCentered(page, "DOCUMENTO TRIBUTARIO ELECTRÓNICO", 769, 9, bold, 190, 230);
  drawCentered(page, "COMPROBANTE DE DONACIÓN", 744, 14, bold, 170, 275);
  drawQr(page, buildDteQrPayload(record), 508, 690, 82);

  page.drawRectangle({ x: 18, y: 682, width: 294, height: 40, color: grayFill });
  drawKeyValue(page, "Código de generación:", record.codigo_generacion, 24, 708, 84, regular, bold, 7.6, black);
  drawKeyValue(page, "Número de control:", record.numero_control, 24, 696, 84, regular, bold, 7.6, black);
  drawKeyValue(page, "Sello de recepción:", record.sello_recibido ?? "TRANSITORIO", 24, 684, 84, regular, bold, 7.6, green);

  page.drawText(`TIPO DE MODELO: v${document.identificacion?.version ?? ""}`, { x: 318, y: 708, size: 7.7, font: regular, color: black });
  page.drawText(`PREVIO / TIPO DTE: ${record.tipo_dte}`, { x: 404, y: 708, size: 7.7, font: regular, color: black });
  page.drawText(`TIPO DE TRANSMISIÓN: ${transmissionLabel(document.identificacion?.tipoOperacion)}`, { x: 318, y: 696, size: 7.7, font: regular, color: black });
  page.drawText(`FECHA: ${formatDate(document.identificacion?.fecEmi)}`, { x: 318, y: 684, size: 7.7, font: bold, color: black });
  page.drawText("Moneda:", { x: 424, y: 684, size: 7.7, font: regular, color: black });
  page.drawText(document.identificacion?.tipoMoneda ?? "USD", { x: 464, y: 684, size: 7.7, font: regular, color: rgb(0.7, 0, 0) });

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
    name: safeUpper(receptor.nombre),
    activity: receptor.descActividad ?? "Empleados",
    nrc: formatNrc(receptor.nrc),
    documentLabel: "NIT:",
    documentNumber: formatDocument(receptor.numDocumento),
    addressLines: [receptorContactLine(receptor)]
  });

  drawItemsTable(page, item, amount, regular, bold);
  drawTotals(page, amount, document.resumen?.totalLetras, regular, bold);

  return pdf.save();
}

function drawOrganizationLogo(page: PDFPage): void {
  const scale = LOGO_HEIGHT / ORG_LOGO_VIEW_BOX.height;
  const topY = LOGO_BOTTOM_Y + LOGO_HEIGHT;
  for (const path of ORG_LOGO_PATHS) {
    page.drawSvgPath(path, { x: LOGO_X, y: topY, scale, color: rgb(0, 0, 0) });
  }
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
  page.drawRectangle({ x: options.x, y: options.y, width: options.width, height: options.height, borderColor: black, borderWidth: 0.8 });
  const left = options.x + 6;
  const valueX = options.x + (options.width > 285 ? 91 : 82);
  const docX = options.x + (options.width > 285 ? 106 : 86);
  drawKeyValue(page, options.nameLabel, clean(options.name), left, options.y + options.height - 16, valueX - left, options.regular, options.bold, 7.2, black);
  drawKeyValue(page, "Actividad económica:", clean(options.activity), left, options.y + options.height - 38, valueX - left, options.regular, options.bold, 7.2, black);
  drawKeyValue(page, "NRC:", options.nrc ?? "", left, options.y + options.height - 60, 26, options.regular, options.bold, 7.2, black);
  drawKeyValue(page, options.documentLabel, options.documentNumber ?? "", docX, options.y + options.height - 60, 22, options.regular, options.bold, 7.2, black);
  options.addressLines.slice(0, 3).forEach((line, index) => {
    page.drawText(line, { x: left, y: options.y + 26 - index * 10.5, size: 7.1, font: options.regular, color: black });
  });
}

function drawItemsTable(page: PDFPage, item: CdeItem, amount: number, regular: PDFFont, bold: PDFFont): void {
  const black = rgb(0, 0, 0);
  page.drawRectangle({ x: 18, y: 550, width: 576, height: 22, color: black });
  page.drawText("CANTIDAD", { x: 24, y: 557, size: 8.3, font: regular, color: rgb(1, 1, 1) });
  drawCentered(page, "DESCRIPCIÓN", 557, 8.3, regular, 145, 280, rgb(1, 1, 1));
  drawRightAligned(page, "VALOR", 557, 8.3, regular, 588, rgb(1, 1, 1));

  page.drawText(formatQuantity(numberValue(item.cantidad, 1)), { x: 24, y: 540, size: 8.2, font: regular, color: black });
  page.drawText(clean(item.descripcion) || "DONACIÓN", { x: 75, y: 540, size: 8.2, font: regular, color: black });
  drawRightAligned(page, formatMoney(numberValue(item.valor, amount), false), 540, 8.2, regular, 588, black);
}

function drawTotals(page: PDFPage, amount: number, totalLetras: string | null | undefined, regular: PDFFont, bold: PDFFont): void {
  const black = rgb(0, 0, 0);
  page.drawRectangle({ x: 18, y: 26, width: 354, height: 62, borderColor: rgb(0.45, 0.45, 0.45), borderWidth: 0.7 });
  page.drawText(`Valor en Letras:  ${amountInWords(amount, totalLetras)}`, { x: 24, y: 73, size: 7.9, font: regular, color: black });
  page.drawText("Observaciones:", { x: 24, y: 46, size: 7.9, font: regular, color: black });

  page.drawRectangle({ x: 378, y: 26, width: 216, height: 28, borderColor: black, borderWidth: 1.2 });
  page.drawText("Total de la Donación", { x: 384, y: 36, size: 8.4, font: bold, color: black });
  page.drawText("$", { x: 482, y: 36, size: 8.4, font: regular, color: black });
  drawRightAligned(page, formatMoney(amount, false), 36, 8.4, bold, 588, black);
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
  page.drawText(label, { x, y, size, font: bold, color: rgb(0, 0, 0) });
  page.drawText(value, { x: x + labelWidth, y, size, font: regular, color: valueColor });
}

function drawCentered(page: PDFPage, text: string, y: number, size: number, font: PDFFont, x = 0, width = 612, color = rgb(0, 0, 0)): void {
  page.drawText(text, { x: x + (width - font.widthOfTextAtSize(text, size)) / 2, y, size, font, color });
}

function drawRightAligned(page: PDFPage, text: string, y: number, size: number, font: PDFFont, rightX: number, color = rgb(0, 0, 0)): void {
  page.drawText(text, { x: rightX - font.widthOfTextAtSize(text, size), y, size, font, color });
}

export function buildDteQrPayload(record: DteDocumentRecord): string {
  const document = JSON.parse(record.plain_json) as CdePdfJson;
  const params = new URLSearchParams({
    ambiente: record.environment,
    codGen: record.codigo_generacion,
    fechaEmi: document.identificacion?.fecEmi ?? record.issued_at.slice(0, 10)
  });
  return `https://admin.factura.gob.sv/consultaPublica?${params.toString()}`;
}

function emisorLines(emisor: Party): string[] {
  const establishment = emisor.nombreComercial || emisor.nombre ? `• ${clean(emisor.nombreComercial ?? emisor.nombre)}${emisor.codEstable ? ` (${emisor.codEstable})` : ""}` : "";
  const address = [clean(emisor.direccion?.complemento), emisor.telefono ? `/ Tel.: ${emisor.telefono}` : ""].filter(Boolean).join(" ");
  return [establishment, `• ${address} /`, `email.: ${emisor.correo ?? ""}`].filter(Boolean);
}

function receptorContactLine(receptor: Party): string {
  return [clean(receptor.direccion?.complemento), receptor.telefono ? `Tel.: ${receptor.telefono}` : "", receptor.correo ? `email.: ${receptor.correo}` : ""]
    .filter(Boolean)
    .join(" / ");
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

function formatDocument(value: string | null | undefined): string {
  const digits = onlyDigits(value);
  if (digits.length === 14) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 10)}-${digits.slice(10, 13)}-${digits.slice(13)}`;
  }
  if (digits.length === 9) {
    return `${digits.slice(0, 8)}-${digits.slice(8)}`;
  }
  return value ?? "";
}

function onlyDigits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
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
  resumen?: {
    valorTotal?: number;
    totalLetras?: string | null;
  };
}

interface Party {
  numDocumento?: string | null;
  nrc?: string | null;
  nombre?: string | null;
  descActividad?: string | null;
  nombreComercial?: string | null;
  direccion?: {
    complemento?: string | null;
  } | null;
  telefono?: string | null;
  correo?: string | null;
  codEstable?: string | null;
}

interface CdeItem {
  cantidad?: number;
  descripcion?: string;
  valor?: number;
}
