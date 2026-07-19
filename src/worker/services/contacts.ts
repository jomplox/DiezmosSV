import { CAT012_DEPARTMENTS, CAT020_COUNTRIES, findCatalogOption } from "../../shared/catalogs";
import { elSalvadorDateOnly } from "../../shared/legalWindows";
import { RETENTION_PAGE_SIZE, type Repository } from "../storage/repository";
import type { Ambiente, DonationGiftType } from "../types";

// Departamento label shown when the intent used the foreign-donor path (00
// "Otro (Para extranjeros)"): a CRM contact reads better as "Extranjero" than as
// the raw catalog phrase.
const FOREIGN_DEPARTMENT_LABEL = "Extranjero";
// CAT-020 default when the donor never carried a país (domestic SV intents).
const DEFAULT_COUNTRY_LABEL = "El Salvador";

// One correlated intent's contact fields for a Wompi-lane ACCEPTED document. All
// nullable: a donor may have paid before the /datos completion existed, or through
// a path that never captured the field.
interface ContactIntentFields {
  donorPhone: string | null;
  direccionComplemento: string | null;
  direccionDepartamento: string | null;
  donorPais: string | null;
  giftType: DonationGiftType | null;
  // The correlated intent's created_at — used to pick the MOST RECENT intent per
  // donor for enrichment (phone/address/departamento/país). Null when the row has
  // no correlated intent at all.
  intentCreatedAt: string | null;
}

// A single Wompi-lane ACCEPTED document joined to its correlated COMPLETED intent
// (0 or 1 per document via donation_intents.document_id). Read in keyset-paged
// chunks by aggregateDonorContacts, mirroring the annual-certificate paging.
export interface ContactSourceRow extends ContactIntentFields {
  id: string;
  donorEmail: string | null;
  donorName: string | null;
  amountCents: number;
  issuedAt: string;
}

// One CRM contact row: a unique donor with aggregate totals and most-recent-intent
// enrichment. Deliberately EXCLUDES the fiscal donor_document — this is CRM contact
// data, not a fiscal identifier.
export interface DonorContact {
  nombre: string;
  correo: string;
  telefono: string;
  direccion: string;
  departamento: string;
  pais: string;
  primeraDonacion: string;
  ultimaDonacion: string;
  totalDonadoUsd: string;
  numeroDonaciones: number;
  tipoPreferido: string;
}

interface ContactAccumulator {
  groupKey: string;
  donorName: string | null;
  donorEmail: string | null;
  count: number;
  totalCents: number;
  firstIssuedAt: string;
  lastIssuedAt: string;
  // The most recent correlated intent seen so far (by intentCreatedAt), whose fields
  // enrich the contact. Null until an intent-bearing row is seen.
  latestIntent: ContactIntentFields | null;
  latestIntentAt: string | null;
  diezmoCount: number;
  ofrendaCount: number;
}

// The CSV column order and Spanish snake_case headers (binding spec order).
export const CONTACT_CSV_HEADERS = [
  "nombre",
  "correo",
  "telefono",
  "direccion",
  "departamento",
  "pais",
  "primera_donacion",
  "ultima_donacion",
  "total_donado_usd",
  "numero_donaciones",
  "tipo_preferido"
] as const;

// Optional filters for the CRM contacts export. `window` restricts the counted
// donations to a [startIso, endIso) issued_at range (El Salvador local semantics are
// resolved by the caller). `giftType` restricts the counted donations to those whose
// correlated intent carries that gift type. Both narrow the set that feeds the
// aggregates, so totals/dates/count/tipo_preferido reflect exactly the filtered
// donations; a donor left with zero counted donations drops out of the export.
export interface ContactAggregateOptions {
  window?: { startIso: string; endIso: string };
  giftType?: DonationGiftType;
}

// Aggregates Wompi-lane ACCEPTED documents for one ambiente into one contact per
// unique donor. Identity key: donor_email lowercased, fallback donor_name — the
// same convention as aggregateAnnualDonors. Enrichment (phone/address/departamento/
// país) comes from the donor's MOST RECENT correlated intent; tipo_preferido from
// the majority of the donor's correlated intents' gift_type. Documents are read in
// keyset-paged chunks so a busy environment never loads unbounded rows at once.
export async function aggregateDonorContacts(
  repo: Repository,
  environment: Ambiente,
  options: ContactAggregateOptions = {}
): Promise<DonorContact[]> {
  const { window, giftType } = options;
  const groups = new Map<string, ContactAccumulator>();
  let cursor: { issuedAt: string; id: string } | null = null;
  for (;;) {
    const rows = await repo.listAcceptedWompiContactRows(environment, cursor, RETENTION_PAGE_SIZE, window);
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      // The keyset cursor must advance over EVERY fetched row (below), but a row whose
      // gift type doesn't match the filter contributes nothing to the aggregates. The
      // window is already applied in SQL; the gift-type filter is applied here so the
      // query stays stable and the correlated intent's type is what gates inclusion.
      if (giftType && row.giftType !== giftType) {
        continue;
      }
      // Identity + displayed correo both use the lowercased email: two casings of the
      // same address are one donor and export as one canonical contact.
      const email = normalizeText(row.donorEmail)?.toLowerCase() ?? null;
      const name = normalizeText(row.donorName);
      const groupKey = email ?? name ?? "(sin identificar)";
      const existing = groups.get(groupKey);
      const intentFields: ContactIntentFields | null = row.intentCreatedAt
        ? {
            donorPhone: row.donorPhone,
            direccionComplemento: row.direccionComplemento,
            direccionDepartamento: row.direccionDepartamento,
            donorPais: row.donorPais,
            giftType: row.giftType,
            intentCreatedAt: row.intentCreatedAt
          }
        : null;
      if (existing) {
        existing.count += 1;
        existing.totalCents += row.amountCents;
        if (row.issuedAt < existing.firstIssuedAt) {
          existing.firstIssuedAt = row.issuedAt;
        }
        if (row.issuedAt > existing.lastIssuedAt) {
          existing.lastIssuedAt = row.issuedAt;
        }
        if (!existing.donorEmail && email) {
          existing.donorEmail = email;
        }
        if (!existing.donorName && name) {
          existing.donorName = name;
        }
        applyIntent(existing, intentFields, row.intentCreatedAt);
      } else {
        const accumulator: ContactAccumulator = {
          groupKey,
          donorName: name,
          donorEmail: email,
          count: 1,
          totalCents: row.amountCents,
          firstIssuedAt: row.issuedAt,
          lastIssuedAt: row.issuedAt,
          latestIntent: null,
          latestIntentAt: null,
          diezmoCount: 0,
          ofrendaCount: 0
        };
        applyIntent(accumulator, intentFields, row.intentCreatedAt);
        groups.set(groupKey, accumulator);
      }
    }
    const last = rows[rows.length - 1];
    cursor = { issuedAt: last.issuedAt, id: last.id };
    if (rows.length < RETENTION_PAGE_SIZE) {
      break;
    }
  }
  const contacts = [...groups.values()].map(toContact);
  contacts.sort((left, right) => left.nombre.localeCompare(right.nombre, "es"));
  return contacts;
}

function applyIntent(accumulator: ContactAccumulator, intent: ContactIntentFields | null, intentCreatedAt: string | null): void {
  if (!intent || !intentCreatedAt) {
    return;
  }
  if (intent.giftType === "DIEZMO") {
    accumulator.diezmoCount += 1;
  } else if (intent.giftType === "OFRENDA") {
    accumulator.ofrendaCount += 1;
  }
  // Keep the most recent intent's fields for enrichment. Ties (same created_at) keep
  // the first seen — deterministic given the keyset order.
  if (!accumulator.latestIntentAt || intentCreatedAt > accumulator.latestIntentAt) {
    accumulator.latestIntent = intent;
    accumulator.latestIntentAt = intentCreatedAt;
  }
}

function toContact(accumulator: ContactAccumulator): DonorContact {
  const intent = accumulator.latestIntent;
  return {
    nombre: accumulator.donorName ?? accumulator.donorEmail ?? "",
    correo: accumulator.donorEmail ?? "",
    telefono: normalizeText(intent?.donorPhone) ?? "",
    direccion: normalizeText(intent?.direccionComplemento) ?? "",
    departamento: departmentLabel(intent),
    pais: countryLabel(intent),
    primeraDonacion: elSalvadorDateOnly(accumulator.firstIssuedAt),
    ultimaDonacion: elSalvadorDateOnly(accumulator.lastIssuedAt),
    totalDonadoUsd: (accumulator.totalCents / 100).toFixed(2),
    numeroDonaciones: accumulator.count,
    tipoPreferido: preferredGiftLabel(accumulator.diezmoCount, accumulator.ofrendaCount)
  };
}

// CAT-012 label for the most recent intent's departamento. The foreign path (00)
// reads as "Extranjero". Blank when no intent was ever captured.
function departmentLabel(intent: ContactIntentFields | null): string {
  const code = normalizeText(intent?.direccionDepartamento);
  if (!code) {
    return "";
  }
  if (code === "00") {
    return FOREIGN_DEPARTMENT_LABEL;
  }
  return findCatalogOption(CAT012_DEPARTMENTS, code)?.label ?? "";
}

// CAT-020 label for the most recent intent's país, defaulting to El Salvador for a
// domestic intent (país null). Blank only when no intent was ever captured.
function countryLabel(intent: ContactIntentFields | null): string {
  if (!intent) {
    return "";
  }
  const code = normalizeText(intent.donorPais);
  if (!code) {
    return DEFAULT_COUNTRY_LABEL;
  }
  return findCatalogOption(CAT020_COUNTRIES, code)?.label ?? DEFAULT_COUNTRY_LABEL;
}

// "Diezmo"/"Ofrenda" by majority of correlated intents' gift_type; blank when
// unknown (no gift types seen) or tied.
function preferredGiftLabel(diezmoCount: number, ofrendaCount: number): string {
  if (diezmoCount === 0 && ofrendaCount === 0) {
    return "";
  }
  if (diezmoCount === ofrendaCount) {
    return "";
  }
  return diezmoCount > ofrendaCount ? "Diezmo" : "Ofrenda";
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length ? trimmed : null;
}

export type ContactColumn = (typeof CONTACT_CSV_HEADERS)[number];

// Maps each header to the DonorContact field it renders. Kept beside CONTACT_CSV_HEADERS
// so a column subset stays a straight lookup rather than a positional index.
const CONTACT_COLUMN_VALUE: Record<ContactColumn, (contact: DonorContact) => string> = {
  nombre: (contact) => contact.nombre,
  correo: (contact) => contact.correo,
  telefono: (contact) => contact.telefono,
  direccion: (contact) => contact.direccion,
  departamento: (contact) => contact.departamento,
  pais: (contact) => contact.pais,
  primera_donacion: (contact) => contact.primeraDonacion,
  ultima_donacion: (contact) => contact.ultimaDonacion,
  total_donado_usd: (contact) => contact.totalDonadoUsd,
  numero_donaciones: (contact) => String(contact.numeroDonaciones),
  tipo_preferido: (contact) => contact.tipoPreferido
};

// Validates and normalises a comma-separated `columns` param into the canonical header
// order. Null/empty → all columns. An unknown column name throws a Spanish error naming
// the offender (the route maps this to a 400). An empty-after-trim selection also throws.
export function resolveContactColumns(columnsParam: string | null | undefined): ContactColumn[] {
  const raw = (columnsParam ?? "").trim();
  if (!raw) {
    return [...CONTACT_CSV_HEADERS];
  }
  const requested = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  // A non-empty param (e.g. ",,") that resolves to no real column names is malformed,
  // not "default all" — only a genuinely absent/blank param defaults to every column.
  if (requested.length === 0) {
    throw new Error(`No indicó ninguna columna válida. Columnas permitidas: ${CONTACT_CSV_HEADERS.join(", ")}.`);
  }
  const allowed = new Set<string>(CONTACT_CSV_HEADERS);
  for (const name of requested) {
    if (!allowed.has(name)) {
      throw new Error(`La columna «${name}» no es válida. Columnas permitidas: ${CONTACT_CSV_HEADERS.join(", ")}.`);
    }
  }
  const selected = new Set(requested);
  // Emit in canonical header order regardless of the request order.
  return CONTACT_CSV_HEADERS.filter((header) => selected.has(header));
}

// The contacts CSV: UTF-8 BOM + CRLF rows, semicolon-free comma-delimited fields
// with F960-style quoting/escaping (a field containing a delimiter, quote, or
// newline is wrapped in quotes and its quotes doubled). `columns` (default all)
// selects and orders the emitted columns.
export function buildContactsCsv(contacts: DonorContact[], columns: readonly ContactColumn[] = CONTACT_CSV_HEADERS): string {
  const lines = [columns.map(csvField).join(",")];
  for (const contact of contacts) {
    lines.push(columns.map((column) => csvField(CONTACT_COLUMN_VALUE[column](contact))).join(","));
  }
  return `﻿${lines.join("\r\n")}\r\n`;
}

export function contactsCsvFilename(environment: Ambiente, count: number): string {
  return `contactos-donantes-${environment}-${count}.csv`;
}

function csvField(value: string): string {
  // Neutralize spreadsheet-formula injection: a donor-controlled cell that opens with
  // =, +, -, @ (or a tab/CR that some parsers treat as a formula lead) is prefixed with
  // an apostrophe so Excel/LibreOffice/Sheets treat it as literal text, then escaped.
  const safeValue = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safeValue) ? `"${safeValue.replace(/"/g, '""')}"` : safeValue;
}
