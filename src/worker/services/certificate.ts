import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { ORG_LOGO_PATHS, ORG_LOGO_VIEW_BOX } from "./orgLogo";
import { RETENTION_PAGE_SIZE, type Repository } from "../storage/repository";
import { getEmisorConfig } from "../config";
import type { Env } from "../types";
import { EmailService } from "./email";
import { certificateEmailHtml } from "./emailHtml";

export const DONOR_CERTIFICATE_SENT_ACTION = "DONOR_CERTIFICATE_SENT";
export const DONOR_CERTIFICATE_FAILED_ACTION = "DONOR_CERTIFICATE_FAILED";
export const DONOR_CERTIFICATE_ENTITY_TYPE = "donor_certificate";

const EL_SALVADOR_TIME_ZONE = "America/El_Salvador";
const EL_SALVADOR_UTC_OFFSET_HOURS = 6;

export const CERTIFICATE_PDF_RENDERER_VERSION = "annual-certificate:v1";

export interface CertificateDonation {
  issuedAt: string;
  dateLabel: string;
  numeroControl: string;
  amountCents: number;
}

export interface DonorCertificateSummary {
  // Grouping identity: donor_email when present, else donor_name (pragmatic v1 —
  // the dte_documents table has no receptor-document column, and parsing plain_json
  // per row to recover the receptor NIT/DUI would be prohibitively heavy).
  groupKey: string;
  donorName: string;
  donorEmail: string | null;
  count: number;
  totalCents: number;
  // True when any included donation was emitted in ambiente "00" (staging/test).
  // Production data is naturally ambiente "01" only; a test-data certificate must
  // carry the "sin validez fiscal" marker so it is never mistaken for a real one.
  hasTestEnvironment: boolean;
  donations: CertificateDonation[];
}

export interface CertificateEmisor {
  nombre: string;
  numDocumento: string;
}

// [startIso, endIso) in UTC for the given calendar year as observed in El Salvador
// local time (fixed UTC-6, no DST — a constant offset is exact). Mirrors the
// retention month-window helper, widened to a full year.
export function elSalvadorYearWindow(year: number): { startIso: string; endIso: string } {
  const start = new Date(Date.UTC(year, 0, 1, EL_SALVADOR_UTC_OFFSET_HOURS, 0, 0));
  const end = new Date(Date.UTC(year + 1, 0, 1, EL_SALVADOR_UTC_OFFSET_HOURS, 0, 0));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

// A certificate year must be a well-formed four-digit year that is the current
// year or a completed one (mid-year statements for the current year are legitimate;
// future years are not). Returns a Spanish error message, or null when valid.
export function certificateYearError(yearParam: string | null | undefined, now: Date): string | null {
  if (!yearParam || !/^\d{4}$/.test(yearParam)) {
    return "Indique un año válido de cuatro dígitos.";
  }
  const year = Number(yearParam);
  const currentYear = elSalvadorYear(now);
  if (year > currentYear) {
    return "No se pueden emitir constancias de un año que aún no ha iniciado.";
  }
  if (year < 2000) {
    return "El año está fuera del rango admitido.";
  }
  return null;
}

function elSalvadorYear(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: EL_SALVADOR_TIME_ZONE, year: "numeric" }).formatToParts(date);
  return Number(parts.find((part) => part.type === "year")?.value ?? 0);
}

// dd/mm/yyyy in El Salvador local time for a stored ISO instant.
export function elSalvadorDateLabel(iso: string): string {
  const parts = new Intl.DateTimeFormat("es-SV", {
    timeZone: EL_SALVADOR_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).formatToParts(new Date(iso));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${value("day")}/${value("month")}/${value("year")}`;
}

// Aggregate ACCEPTED donations for a calendar year into one summary per donor,
// grouped by email (fallback: name). Totals accumulate in integer cents to avoid
// float drift. Documents are read in keyset-paged chunks so a busy year never
// loads unbounded rows at once.
export async function aggregateAnnualDonors(repo: Repository, year: number): Promise<DonorCertificateSummary[]> {
  const window = elSalvadorYearWindow(year);
  const groups = new Map<string, DonorCertificateSummary>();
  let cursor: { issuedAt: string; id: string } | null = null;
  for (;;) {
    const rows = await repo.listAcceptedDocumentsInYear(window, cursor, RETENTION_PAGE_SIZE);
    if (rows.length === 0) {
      break;
    }
    for (const row of rows) {
      const email = normalizeText(row.donor_email);
      const name = normalizeText(row.donor_name);
      const groupKey = email ?? name ?? "(sin identificar)";
      const existing = groups.get(groupKey);
      const donation: CertificateDonation = {
        issuedAt: row.issued_at,
        dateLabel: elSalvadorDateLabel(row.issued_at),
        numeroControl: row.numero_control,
        amountCents: row.amount_cents
      };
      if (existing) {
        existing.count += 1;
        existing.totalCents += row.amount_cents;
        existing.hasTestEnvironment ||= row.environment === "00";
        existing.donations.push(donation);
        if (!existing.donorEmail && email) {
          existing.donorEmail = email;
        }
      } else {
        groups.set(groupKey, {
          groupKey,
          donorName: name ?? email ?? "(sin identificar)",
          donorEmail: email,
          count: 1,
          totalCents: row.amount_cents,
          hasTestEnvironment: row.environment === "00",
          donations: [donation]
        });
      }
    }
    const last = rows[rows.length - 1];
    cursor = { issuedAt: last.issued_at, id: last.id };
    if (rows.length < RETENTION_PAGE_SIZE) {
      break;
    }
  }
  const donors = [...groups.values()];
  for (const donor of donors) {
    donor.donations.sort((left, right) => left.issuedAt.localeCompare(right.issuedAt));
  }
  donors.sort((left, right) => left.donorName.localeCompare(right.donorName, "es"));
  return donors;
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length ? trimmed : null;
}

export function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

const LOGO_BOTTOM_Y = 726;
const LOGO_HEIGHT = 46;
const PAGE_WIDTH = 612;
const MARGIN = 48;

export interface RenderCertificateInput {
  year: number;
  donor: DonorCertificateSummary;
  emisor: CertificateEmisor;
  issuedOnLabel: string;
}

// Renders the annual donor certificate. Reuses the CDE branding (default vector logo,
// Helvetica) but is deliberately NOT a DTE: it makes no Ministerio de Hacienda seal
// claim. The individual CDE remain the fiscal vouchers; this is informational.
export async function renderCertificatePdf(input: RenderCertificateInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE_WIDTH, 792]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const muted = rgb(0.32, 0.32, 0.32);
  const brand = rgb(0.06, 0.46, 0.43);

  drawOrganizationLogo(page);
  drawCentered(page, input.emisor.nombre.toUpperCase(), 724, 11, bold, 0, PAGE_WIDTH, black);
  drawCentered(page, `NIT: ${formatDocument(input.emisor.numDocumento)}`, 710, 8.5, regular, 0, PAGE_WIDTH, muted);
  drawCentered(page, `Constancia de Donaciones ${input.year}`, 682, 17, bold, 0, PAGE_WIDTH, brand);

  if (input.donor.hasTestEnvironment) {
    drawTestEnvironmentBanner(page, bold);
  }

  let y = input.donor.hasTestEnvironment ? 628 : 648;
  page.drawText("Donante:", { x: MARGIN, y, size: 10, font: bold, color: black });
  page.drawText(input.donor.donorName, { x: MARGIN + 60, y, size: 10, font: regular, color: black });
  y -= 16;
  if (input.donor.donorEmail) {
    page.drawText("Correo:", { x: MARGIN, y, size: 10, font: bold, color: black });
    page.drawText(input.donor.donorEmail, { x: MARGIN + 60, y, size: 10, font: regular, color: black });
    y -= 16;
  }
  y -= 8;

  page.drawText(
    `Por medio de la presente se hace constar que ${input.donor.donorName} realizó las siguientes donaciones durante el año ${input.year}:`,
    { x: MARGIN, y, size: 9.5, font: regular, color: black, maxWidth: PAGE_WIDTH - MARGIN * 2, lineHeight: 13 }
  );
  y -= 34;

  y = drawTable(page, input.donor, regular, bold, y);

  y -= 26;
  page.drawText(
    `Fecha de emisión de la constancia: ${input.issuedOnLabel}`,
    { x: MARGIN, y, size: 9, font: regular, color: muted }
  );

  drawFooter(page, input.emisor.nombre, regular);
  return pdf.save();
}

function drawTable(page: PDFPage, donor: DonorCertificateSummary, regular: PDFFont, bold: PDFFont, top: number): number {
  const black = rgb(0, 0, 0);
  const headerFill = rgb(0.06, 0.46, 0.43);
  const rowHeight = 18;
  const left = MARGIN;
  const right = PAGE_WIDTH - MARGIN;
  const controlX = left + 90;
  const amountRightX = right - 6;

  page.drawRectangle({ x: left, y: top - rowHeight + 4, width: right - left, height: rowHeight, color: headerFill });
  page.drawText("Fecha", { x: left + 6, y: top - rowHeight + 9, size: 8.5, font: bold, color: rgb(1, 1, 1) });
  page.drawText("Número de control", { x: controlX, y: top - rowHeight + 9, size: 8.5, font: bold, color: rgb(1, 1, 1) });
  drawRightAligned(page, "Monto (US$)", top - rowHeight + 9, 8.5, bold, amountRightX, rgb(1, 1, 1));

  let y = top - rowHeight;
  for (const donation of donor.donations) {
    y -= rowHeight;
    page.drawText(donation.dateLabel, { x: left + 6, y: y + 5, size: 8.5, font: regular, color: black });
    page.drawText(donation.numeroControl, { x: controlX, y: y + 5, size: 8.5, font: regular, color: black });
    drawRightAligned(page, formatCents(donation.amountCents), y + 5, 8.5, regular, amountRightX, black);
    page.drawLine({ start: { x: left, y: y + 2 }, end: { x: right, y: y + 2 }, thickness: 0.4, color: rgb(0.82, 0.82, 0.82) });
  }

  y -= rowHeight;
  page.drawRectangle({ x: left, y: y + 4, width: right - left, height: rowHeight, color: rgb(0.93, 0.95, 0.95) });
  page.drawText(`Total (${donor.count} ${donor.count === 1 ? "donación" : "donaciones"})`, { x: left + 6, y: y + 9, size: 9, font: bold, color: black });
  drawRightAligned(page, `$${formatCents(donor.totalCents)}`, y + 9, 9.5, bold, amountRightX, black);
  return y;
}

function drawTestEnvironmentBanner(page: PDFPage, bold: PDFFont): void {
  const y = 656;
  page.drawRectangle({ x: MARGIN, y: y - 4, width: PAGE_WIDTH - MARGIN * 2, height: 20, color: rgb(0.99, 0.94, 0.88), borderColor: rgb(0.85, 0.6, 0.2), borderWidth: 0.8 });
  drawCentered(page, "AMBIENTE DE PRUEBAS — SIN VALIDEZ FISCAL", y + 2, 9, bold, MARGIN, PAGE_WIDTH - MARGIN * 2, rgb(0.55, 0.36, 0.0));
}

function drawFooter(page: PDFPage, emisorNombre: string, regular: PDFFont): void {
  const muted = rgb(0.4, 0.4, 0.4);
  page.drawLine({ start: { x: MARGIN, y: 72 }, end: { x: PAGE_WIDTH - MARGIN, y: 72 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
  page.drawText(`Documento informativo emitido por ${emisorNombre}.`, { x: MARGIN, y: 58, size: 8, font: regular, color: muted });
  // Keep this sentence on one physical line so pdftotext preserves it verbatim.
  page.drawText("Los CDE individuales constituyen los comprobantes fiscales.", { x: MARGIN, y: 46, size: 8, font: regular, color: muted });
}

function drawOrganizationLogo(page: PDFPage): void {
  const scale = LOGO_HEIGHT / ORG_LOGO_VIEW_BOX.height;
  const topY = LOGO_BOTTOM_Y + LOGO_HEIGHT;
  const width = ORG_LOGO_VIEW_BOX.width * scale;
  const x = (PAGE_WIDTH - width) / 2;
  for (const path of ORG_LOGO_PATHS) {
    page.drawSvgPath(path, { x, y: topY, scale, color: rgb(0, 0, 0) });
  }
}

function drawCentered(page: PDFPage, text: string, y: number, size: number, font: PDFFont, x = 0, width = PAGE_WIDTH, color = rgb(0, 0, 0)): void {
  page.drawText(text, { x: x + (width - font.widthOfTextAtSize(text, size)) / 2, y, size, font, color });
}

function drawRightAligned(page: PDFPage, text: string, y: number, size: number, font: PDFFont, rightX: number, color = rgb(0, 0, 0)): void {
  page.drawText(text, { x: rightX - font.widthOfTextAtSize(text, size), y, size, font, color });
}

function formatDocument(value: string | null | undefined): string {
  const digits = (value ?? "").replace(/\D/g, "");
  if (digits.length === 14) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 10)}-${digits.slice(10, 13)}-${digits.slice(13)}`;
  }
  return value ?? "";
}

export interface AnnualCertificatePreviewDonor {
  donorName: string;
  donorEmail: string | null;
  hasEmail: boolean;
  count: number;
  totalLabel: string;
  hasTestEnvironment: boolean;
}

export interface AnnualCertificatePreview {
  year: number;
  donorCount: number;
  withEmail: number;
  withoutEmail: number;
  totalLabel: string;
  donors: AnnualCertificatePreviewDonor[];
}

export async function buildAnnualCertificatePreview(repo: Repository, year: number): Promise<AnnualCertificatePreview> {
  const donors = await aggregateAnnualDonors(repo, year);
  const withEmail = donors.filter((donor) => donor.donorEmail).length;
  const totalCents = donors.reduce((sum, donor) => sum + donor.totalCents, 0);
  return {
    year,
    donorCount: donors.length,
    withEmail,
    withoutEmail: donors.length - withEmail,
    totalLabel: `$${formatCents(totalCents)}`,
    donors: donors.map((donor) => ({
      donorName: donor.donorName,
      donorEmail: donor.donorEmail,
      hasEmail: Boolean(donor.donorEmail),
      count: donor.count,
      totalLabel: `$${formatCents(donor.totalCents)}`,
      hasTestEnvironment: donor.hasTestEnvironment
    }))
  };
}

export interface AnnualCertificateSendResult {
  year: number;
  sent: number;
  skipped: number;
  failed: number;
}

// Emails one certificate per donor WITH an email address, for the given year.
// Idempotent re-runs: a donor with an existing DONOR_CERTIFICATE_SENT audit for
// this year (entityId `<year>:<email>`) is skipped, so re-running covers only new
// or previously failed donors. Donors without email are counted as skipped and
// never sent. Each donor is audited SENT or FAILED independently — one failure
// never aborts the batch.
export async function sendAnnualCertificates(env: Env, repo: Repository, year: number, actorId: string | null): Promise<AnnualCertificateSendResult> {
  const emisorConfig = getEmisorConfig(env);
  const emisor: CertificateEmisor = { nombre: emisorConfig.nombreComercial || emisorConfig.nombre, numDocumento: emisorConfig.numDocumento };
  const donors = await aggregateAnnualDonors(repo, year);
  const email = new EmailService(env);
  const issuedOnLabel = elSalvadorDateLabel(new Date().toISOString());
  const result: AnnualCertificateSendResult = { year, sent: 0, skipped: 0, failed: 0 };

  for (const donor of donors) {
    if (!donor.donorEmail) {
      result.skipped += 1;
      continue;
    }
    const entityId = `${year}:${donor.donorEmail}`;
    const alreadySent = await repo.countAuditEntries(DONOR_CERTIFICATE_SENT_ACTION, entityId);
    if (alreadySent > 0) {
      result.skipped += 1;
      continue;
    }
    try {
      const pdfBytes = await renderCertificatePdf({ year, donor, emisor, issuedOnLabel });
      const totalLabel = `$${formatCents(donor.totalCents)}`;
      await email.sendDonorCertificate({
        toEmail: donor.donorEmail,
        subject: `Constancia de donaciones ${year}`,
        text:
          `Estimado(a) ${donor.donorName}:\n\n` +
          `Adjuntamos su constancia de donaciones del año ${year} (${donor.count} ${donor.count === 1 ? "donación" : "donaciones"}, total ${totalLabel}). ` +
          `Los comprobantes de donación electrónicos individuales siguen siendo sus comprobantes fiscales.`,
        html: certificateEmailHtml({
          organizationName: emisor.nombre,
          donorName: donor.donorName,
          year,
          count: donor.count,
          totalLabel,
          isTestEnvironment: donor.hasTestEnvironment
        }),
        pdfBytes,
        filename: `constancia-donaciones-${year}.pdf`
      });
      await repo.createAudit({
        actorType: actorId ? "USER" : "SYSTEM",
        actorId,
        action: DONOR_CERTIFICATE_SENT_ACTION,
        entityType: DONOR_CERTIFICATE_ENTITY_TYPE,
        entityId,
        summary: `Constancia ${year} enviada a ${donor.donorEmail}`,
        metadata: { year, donorName: donor.donorName, count: donor.count, totalCents: donor.totalCents }
      });
      result.sent += 1;
    } catch (error) {
      await repo.createAudit({
        actorType: actorId ? "USER" : "SYSTEM",
        actorId,
        action: DONOR_CERTIFICATE_FAILED_ACTION,
        entityType: DONOR_CERTIFICATE_ENTITY_TYPE,
        entityId,
        summary: error instanceof Error ? error.message : String(error)
      });
      result.failed += 1;
    }
  }
  return result;
}
