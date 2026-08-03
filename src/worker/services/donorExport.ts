import {
  CAT012_DEPARTMENTS,
  CAT020_COUNTRIES,
  CAT022_DOCUMENT_TYPES,
  findCatalogOption
} from "../../shared/catalogs";
import { formatElSalvadorDateTime } from "../../shared/legalWindows";
import type { DonorExplorerRow } from "../storage/repository/donors";
import type { Ambiente } from "../types";

const DONOR_EXPLORER_CSV_HEADERS = [
  "tipo_documento",
  "numero_documento",
  "nombre",
  "correo",
  "telefono",
  "direccion",
  "departamento",
  "pais",
  "primera_entrega",
  "ultima_entrega",
  "total_entregado_usd",
  "numero_entregas",
  "tipo_preferido",
  "origen"
] as const;

export function buildDonorExplorerCsv(donors: readonly DonorExplorerRow[]): string {
  const lines = [DONOR_EXPLORER_CSV_HEADERS.join(",")];
  for (const donor of donors) {
    lines.push([
      documentTypeLabel(donor.documentType),
      donor.documentNumber,
      donor.name,
      donor.email ?? "",
      donor.phone ?? "",
      donor.address ?? "",
      departmentLabel(donor.department),
      countryLabel(donor.country),
      formatElSalvadorDateTime(donor.firstGiftAt),
      formatElSalvadorDateTime(donor.lastGiftAt),
      (donor.totalCents / 100).toFixed(2),
      String(donor.giftCount),
      giftTypeLabel(donor.preferredGiftType),
      sourceLabel(donor.source)
    ].map(csvField).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function donorExplorerCsvFilename(environment: Ambiente, count: number): string {
  return `donantes-${environment}-${count}.csv`;
}

function documentTypeLabel(value: string): string {
  return findCatalogOption(CAT022_DOCUMENT_TYPES, value)?.label ?? value;
}

function departmentLabel(value: string | null): string {
  if (!value) return "";
  if (value === "00") return "Extranjero";
  return findCatalogOption(CAT012_DEPARTMENTS, value)?.label ?? value;
}

function countryLabel(value: string | null): string {
  if (!value) return "";
  return findCatalogOption(CAT020_COUNTRIES, value)?.label ?? value;
}

function giftTypeLabel(value: DonorExplorerRow["preferredGiftType"]): string {
  if (value === "DIEZMO") return "Diezmo";
  if (value === "OFRENDA") return "Ofrenda";
  return "Sin clasificar";
}

function sourceLabel(value: DonorExplorerRow["source"]): string {
  if (value === "WOMPI") return "En línea";
  if (value === "MANUAL") return "Manual";
  return "En línea y manual";
}

function csvField(value: string): string {
  const safeValue = /^[=+\-@\t\r\n]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safeValue)
    ? `"${safeValue.replace(/"/g, '""')}"`
    : safeValue;
}
