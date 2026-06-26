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
  };
  resumen?: {
    valorTotal?: number | string | null;
  };
}

export interface F960ExportResult {
  csv: string;
  rowCount: number;
  filename: string;
}

interface F960Period {
  year: number;
  month: number;
}

export function buildF960Export(records: DteDocumentRecord[], periodValue: string | null): F960ExportResult {
  const period = parsePeriod(periodValue);
  const rows = records
    .map((record) => toF960Row(record))
    .filter((row) => !period || row.period === formatPeriod(period));
  return {
    csv: rows.map((row) => row.fields.map(csvField).join(";")).join("\r\n") + (rows.length ? "\r\n" : ""),
    rowCount: rows.length,
    filename: period ? `f960-${formatPeriod(period)}.csv` : "f960.csv"
  };
}

function toF960Row(record: DteDocumentRecord): { fields: string[]; period: string } {
  const document = JSON.parse(record.plain_json) as F960Document;
  const donorDocument = clean(document.receptor?.numDocumento) ?? "";
  const donorDigits = donorDocument.replace(/\D/g, "");
  const donorNit = isNit(document.receptor?.tipoDocumento, donorDigits) ? donorDigits : "";
  const donorDui = donorNit ? "" : donorDigits || donorDocument;
  const issueDate = clean(document.identificacion?.fecEmi) ?? record.issued_at.slice(0, 10);
  const period = periodFromDate(issueDate);
  const generationCode = clean(document.identificacion?.codigoGeneracion) ?? record.codigo_generacion;
  const amount = money(document.resumen?.valorTotal ?? record.amount_cents / 100);

  return {
    period,
    fields: [
      "1",
      donorNit,
      clean(document.receptor?.nombre) ?? record.donor_name ?? "",
      "9300",
      "4",
      record.sello_recibido ?? "",
      generationCode.replace(/-/g, ""),
      amount,
      donorDui,
      period
    ]
  };
}

function parsePeriod(value: string | null): F960Period | null {
  if (!value) {
    return null;
  }
  const match = value.match(/^(\d{4})-(0[1-9]|1[0-2])$/);
  if (!match) {
    throw new Error("Period must use YYYY-MM");
  }
  return { year: Number(match[1]), month: Number(match[2]) };
}

function formatPeriod(period: F960Period): string {
  return `${String(period.month).padStart(2, "0")}${period.year}`;
}

function periodFromDate(date: string): string {
  const match = date.match(/^(\d{4})-(\d{2})-\d{2}/);
  if (!match) {
    return "";
  }
  return `${match[2]}${match[1]}`;
}

function isNit(tipoDocumento: string | null | undefined, digits: string): boolean {
  return tipoDocumento === "36" || digits.length === 14;
}

function money(value: number | string): string {
  const amount = typeof value === "number" ? value : Number(value);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function csvField(value: string): string {
  return /[;"\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
