import type { DteDocumentRecord } from "../types";

interface F960Document {
  identificacion?: {
    fecEmi?: string | null;
    codigoGeneracion?: string | null;
  };
  receptor?: {
    tipoDocumento?: string | null;
    numDocumento?: string | null;
    nombre?: string | null;
    correo?: string | null;
  };
  resumen?: {
    valorTotal?: number | string | null;
  };
}

export interface F960Filters {
  period?: string | null;
  startDate?: string | null;
  endDate?: string | null;
}

interface F960Row {
  tipoOperacion: string;
  nit: string;
  nombre: string;
  codigoActividad: string;
  tipoDonacion: string;
  sello: string;
  codigoGeneracion: string;
  monto: string;
  dui: string;
  periodo: string;
  fechaEmision: string;
  numeroControl: string;
  correo: string;
  estado: string;
}

export interface F960Selection {
  rows: F960Row[];
  rowCount: number;
  amountTotal: string;
  csvFilename: string;
  xlsxFilename: string;
}

interface NormalizedFilters {
  period: string | null;
  startDate: string | null;
  endDate: string | null;
  suffix: string;
}

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export { XLSX_MIME };

export function buildF960Selection(records: DteDocumentRecord[], filters: F960Filters = {}): F960Selection {
  const normalized = normalizeFilters(filters);
  const rows = records
    .map((record) => toF960Row(record))
    .filter((row) => matchesFilters(row, normalized));
  const amountTotal = rows.reduce((total, row) => total + Number(row.monto), 0);

  return {
    rows,
    rowCount: rows.length,
    amountTotal: amountTotal.toFixed(2),
    csvFilename: `f960-${normalized.suffix}.csv`,
    xlsxFilename: `f960-inspeccion-${normalized.suffix}.xlsx`
  };
}

export function buildF960Csv(selection: F960Selection): string {
  return selection.rows.map((row) => csvFields(row).map(csvField).join(";")).join("\r\n") + (selection.rows.length ? "\r\n" : "");
}

export function buildF960Xlsx(selection: F960Selection): Uint8Array {
  const rows = [
    [
      "Tipo operación",
      "NIT",
      "Nombre donante",
      "Código actividad",
      "Tipo donación",
      "Sello recibido",
      "Código generación",
      "Monto",
      "DUI",
      "Periodo",
      "Fecha emisión",
      "Número control",
      "Correo",
      "Estado"
    ],
    ...selection.rows.map((row) => [
      row.tipoOperacion,
      row.nit,
      row.nombre,
      row.codigoActividad,
      row.tipoDonacion,
      row.sello,
      row.codigoGeneracion,
      row.monto,
      row.dui,
      row.periodo,
      row.fechaEmision,
      row.numeroControl,
      row.correo,
      f960StatusLabel(row.estado)
    ])
  ];

  return zipStore([
    { name: "[Content_Types].xml", text: contentTypesXml() },
    { name: "_rels/.rels", text: rootRelsXml() },
    { name: "xl/workbook.xml", text: workbookXml() },
    { name: "xl/_rels/workbook.xml.rels", text: workbookRelsXml() },
    { name: "xl/styles.xml", text: stylesXml() },
    { name: "xl/worksheets/sheet1.xml", text: worksheetXml(rows) }
  ]);
}

function toF960Row(record: DteDocumentRecord): F960Row {
  const document = JSON.parse(record.plain_json) as F960Document;
  const donorDocument = clean(document.receptor?.numDocumento) ?? "";
  const donorDigits = donorDocument.replace(/\D/g, "");
  const donorNit = isNit(document.receptor?.tipoDocumento, donorDigits) ? donorDigits : "";
  const donorDui = donorNit ? "" : donorDigits || donorDocument;
  const issueDate = clean(document.identificacion?.fecEmi) ?? record.issued_at.slice(0, 10);
  const generationCode = clean(document.identificacion?.codigoGeneracion) ?? record.codigo_generacion;

  return {
    tipoOperacion: "1",
    nit: donorNit,
    nombre: clean(document.receptor?.nombre) ?? record.donor_name ?? "",
    codigoActividad: "9300",
    tipoDonacion: "4",
    sello: record.sello_recibido ?? "",
    codigoGeneracion: generationCode.replace(/-/g, ""),
    monto: money(document.resumen?.valorTotal ?? record.amount_cents / 100),
    dui: donorDui,
    periodo: periodFromDate(issueDate),
    fechaEmision: issueDate,
    numeroControl: record.numero_control,
    correo: clean(document.receptor?.correo) ?? record.donor_email ?? "",
    estado: record.status
  };
}

function csvFields(row: F960Row): string[] {
  return [
    row.tipoOperacion,
    row.nit,
    row.nombre,
    row.codigoActividad,
    row.tipoDonacion,
    row.sello,
    row.codigoGeneracion,
    row.monto,
    row.dui,
    row.periodo
  ];
}

function normalizeFilters(filters: F960Filters): NormalizedFilters {
  const startDate = clean(filters.startDate);
  const endDate = clean(filters.endDate);
  const period = clean(filters.period);
  if (startDate && !isDate(startDate)) {
    throw new Error("La fecha inicial debe usar el formato AAAA-MM-DD");
  }
  if (endDate && !isDate(endDate)) {
    throw new Error("La fecha final debe usar el formato AAAA-MM-DD");
  }
  if (startDate && endDate && startDate > endDate) {
    throw new Error("La fecha inicial debe ser anterior o igual a la fecha final");
  }
  if (startDate || endDate) {
    return {
      period: null,
      startDate,
      endDate,
      suffix: [startDate ? startDate.replace(/-/g, "") : "inicio", endDate ? endDate.replace(/-/g, "") : "fin"].join("-")
    };
  }
  if (period) {
    const match = period.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
    if (!match) {
      throw new Error("El periodo debe usar el formato AAAA-MM");
    }
    return { period: `${match[2]}${match[1]}`, startDate: null, endDate: null, suffix: `${match[2]}${match[1]}` };
  }
  return { period: null, startDate: null, endDate: null, suffix: "all" };
}

function matchesFilters(row: F960Row, filters: NormalizedFilters): boolean {
  if (filters.period) {
    return row.periodo === filters.period;
  }
  if (filters.startDate && row.fechaEmision < filters.startDate) {
    return false;
  }
  if (filters.endDate && row.fechaEmision > filters.endDate) {
    return false;
  }
  return true;
}

function periodFromDate(date: string): string {
  const match = date.match(/^(\d{4})-(\d{2})-\d{2}/);
  if (!match) {
    return "";
  }
  return `${match[2]}${match[1]}`;
}

function isDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return date.toISOString().slice(0, 10) === value;
}

function isNit(tipoDocumento: string | null | undefined, digits: string): boolean {
  return tipoDocumento === "36" || digits.length === 14;
}

function money(value: number | string): string {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

function f960StatusLabel(status: string): string {
  const labels: Record<string, string> = {
    ACCEPTED: "Aceptado",
    CONTINGENCY_PENDING: "Contingencia",
    FAILED: "Fallido",
    INVALIDATED: "Invalidado",
    PENDING: "Pendiente",
    REJECTED: "Rechazado"
  };
  return labels[status] ?? status;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function csvField(value: string): string {
  // Neutralize spreadsheet-formula injection: a donor-controlled cell that opens with
  // =, +, -, @ (or a tab/CR that some parsers treat as a formula lead) is prefixed with
  // an apostrophe so Excel/LibreOffice/Sheets treat it as literal text, then escaped.
  const safeValue = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[;"\r\n]/.test(safeValue) ? `"${safeValue.replace(/"/g, '""')}"` : safeValue;
}

function contentTypesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
}

function rootRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function workbookXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="F960 inspección" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`;
}

function workbookRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2"><xf fontId="0" fillId="0" borderId="0" xfId="0"/><xf fontId="1" fillId="0" borderId="0" xfId="0"/></cellXfs>
</styleSheet>`;
}

function worksheetXml(rows: string[][]): string {
  const body = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const ref = `${columnName(columnIndex + 1)}${rowIndex + 1}`;
          const style = rowIndex === 0 ? ' s="1"' : "";
          return `<c r="${ref}" t="inlineStr"${style}><is><t>${xml(value)}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cols><col min="1" max="14" width="18" customWidth="1"/></cols>
  <sheetData>${body}</sheetData>
</worksheet>`;
}

function columnName(index: number): string {
  let name = "";
  let current = index;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function zipStore(files: Array<{ name: string; text: string }>): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const data = encoder.encode(file.text);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0, true);
    localView.setUint16(8, 0, true);
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    localParts.push(local, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, 0, true);
    centralView.setUint16(14, 0, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true);
    centralView.setUint16(32, 0, true);
    centralView.setUint16(34, 0, true);
    centralView.setUint16(36, 0, true);
    centralView.setUint32(38, 0, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(4, 0, true);
  endView.setUint16(6, 0, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, centralOffset, true);
  endView.setUint16(20, 0, true);

  return concat([...localParts, ...centralParts, end]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
