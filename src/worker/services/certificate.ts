import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatDocument } from "../../shared/documentFormat";
import { EL_SALVADOR_TIME_ZONE, formatElSalvadorDate } from "../../shared/legalWindows";
import { formatCents } from "../../shared/money";
import { ORG_LOGO_PATHS, ORG_LOGO_VIEW_BOX } from "./orgLogo";
import { RETENTION_PAGE_SIZE, type Repository } from "../storage/repository";
import { getEmisorConfig } from "../config";
import type { DteDocumentRecord, Env } from "../types";
import { loadEmailBranding } from "./branding";
import { EmailService } from "./email";
import { certificateEmailHtml } from "./emailHtml";
import { renderDtePdf } from "./pdf";

const DONOR_CERTIFICATE_SENT_ACTION = "DONOR_CERTIFICATE_SENT";
const DONOR_CERTIFICATE_FAILED_ACTION = "DONOR_CERTIFICATE_FAILED";
const DONOR_CERTIFICATE_ENTITY_TYPE = "donor_certificate";

const EL_SALVADOR_UTC_OFFSET_HOURS = 6;

interface CertificateDonation {
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
  // The source ACCEPTED records, in dossier order (ascending accepted_at, tie-break
  // issued_at then id). Each is re-rendered with renderDtePdf and appended to the
  // certificate so the donor receives every related CDE in one file.
  documents: DteDocumentRecord[];
}

interface CertificateEmisor {
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
        dateLabel: formatElSalvadorDate(row.issued_at),
        numeroControl: row.numero_control,
        amountCents: row.amount_cents
      };
      if (existing) {
        existing.count += 1;
        existing.totalCents += row.amount_cents;
        existing.hasTestEnvironment ||= row.environment === "00";
        existing.donations.push(donation);
        existing.documents.push(row);
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
          donations: [donation],
          documents: [row]
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
    // Dossier order: chronological by acceptance, tie-broken by issue instant then id
    // so the appended CDE pages are deterministic even when two share an accepted_at.
    donor.documents.sort(compareDossierDocuments);
  }
  donors.sort((left, right) => left.donorName.localeCompare(right.donorName, "es"));
  return donors;
}

// accepted_at may be null on legacy rows; treat null as an empty string so it sorts
// before any real timestamp and never throws in the comparator.
function compareDossierDocuments(left: DteDocumentRecord, right: DteDocumentRecord): number {
  const leftAccepted = left.accepted_at ?? "";
  const rightAccepted = right.accepted_at ?? "";
  return (
    leftAccepted.localeCompare(rightAccepted) ||
    left.issued_at.localeCompare(right.issued_at) ||
    left.id.localeCompare(right.id)
  );
}

function normalizeText(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length ? trimmed : null;
}

// Bare amount for the table cells: the "Monto (US$)" header already carries the unit,
// so rows print "1,234.56" while totals use the shared "$1,234.56" display format.
function bareCents(cents: number): string {
  return formatCents(cents).slice(1);
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
  // Branding accent (hex #rrggbb) painting the title + table header; the historical
  // teal remains the default so an unbranded deployment renders unchanged.
  accentColor?: string;
}

// Renders the annual donor certificate. Reuses the CDE branding (default vector logo,
// Helvetica) but is deliberately NOT a DTE: it makes no Ministerio de Hacienda seal
// claim. The individual CDE remain the fiscal vouchers; this is informational.
// Converts the branding accent (#rrggbb) into pdf-lib color space; falls back to the
// historical teal on absent/malformed values so rendering never fails over branding.
function accentRgb(hex: string | undefined) {
  const match = /^#([0-9a-f]{6})$/i.exec(hex?.trim() ?? "");
  if (!match) {
    return rgb(0.06, 0.46, 0.43);
  }
  const value = Number.parseInt(match[1], 16);
  return rgb(((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255);
}

export async function renderCertificatePdf(input: RenderCertificateInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([PAGE_WIDTH, 792]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const muted = rgb(0.32, 0.32, 0.32);
  const brand = accentRgb(input.accentColor);

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

  const tableEnd = drawTable(pdf, page, input, regular, bold, y, brand);
  y = tableEnd.y;

  y -= 26;
  tableEnd.page.drawText(
    `Fecha de emisión de la constancia: ${input.issuedOnLabel}`,
    { x: MARGIN, y, size: 9, font: regular, color: muted }
  );

  for (const certificatePage of pdf.getPages()) {
    drawFooter(certificatePage, input.emisor.nombre, regular);
  }
  return pdf.save();
}

// Builds the complete dossier: the summary page(s) followed by every related CDE,
// one document per page, in the donor's dossier order. Renders each CDE sequentially
// (never Promise.all — the worker CPU budget is tight) and appends via copyPages so a
// single PDF carries the whole year. A CDE that fails to render throws a Spanish error
// rather than shipping an incomplete dossier; callers isolate that failure per donor.
export async function renderCertificateDossierPdf(input: RenderCertificateInput): Promise<Uint8Array> {
  const summaryBytes = await renderCertificatePdf(input);
  const dossier = await PDFDocument.load(summaryBytes);

  // Sort here too (aggregateAnnualDonors already does) so the dossier invariant holds
  // regardless of the order the caller supplies the records in.
  const ordered = [...input.donor.documents].sort(compareDossierDocuments);
  for (const record of ordered) {
    let dteBytes: Uint8Array;
    try {
      dteBytes = await renderDtePdf(record);
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      throw new Error(`No se pudo generar el comprobante ${record.numero_control} para la constancia: ${cause}`);
    }
    const source = await PDFDocument.load(dteBytes);
    const copied = await dossier.copyPages(source, source.getPageIndices());
    for (const copiedPage of copied) {
      dossier.addPage(copiedPage);
    }
  }

  return dossier.save();
}

function drawTable(
  pdf: PDFDocument,
  firstPage: PDFPage,
  input: RenderCertificateInput,
  regular: PDFFont,
  bold: PDFFont,
  top: number,
  accent = rgb(0.06, 0.46, 0.43)
): { page: PDFPage; y: number } {
  const black = rgb(0, 0, 0);
  const headerFill = accent;
  const rowHeight = 18;
  const contentBottom = 90;
  const left = MARGIN;
  const right = PAGE_WIDTH - MARGIN;
  const controlX = left + 90;
  const amountRightX = right - 6;

  const drawHeader = (page: PDFPage, headerTop: number): number => {
    page.drawRectangle({ x: left, y: headerTop - rowHeight + 4, width: right - left, height: rowHeight, color: headerFill });
    page.drawText("Fecha", { x: left + 6, y: headerTop - rowHeight + 9, size: 8.5, font: bold, color: rgb(1, 1, 1) });
    page.drawText("Número de control", { x: controlX, y: headerTop - rowHeight + 9, size: 8.5, font: bold, color: rgb(1, 1, 1) });
    drawRightAligned(page, "Monto (US$)", headerTop - rowHeight + 9, 8.5, bold, amountRightX, rgb(1, 1, 1));
    return headerTop - rowHeight;
  };

  const addContinuationPage = (): { page: PDFPage; y: number } => {
    const page = pdf.addPage([PAGE_WIDTH, 792]);
    drawCentered(page, `Constancia de Donaciones ${input.year} — continuación`, 724, 13, bold, 0, PAGE_WIDTH, accent);
    if (input.donor.hasTestEnvironment) {
      drawTestEnvironmentBanner(page, bold);
    }
    return { page, y: drawHeader(page, input.donor.hasTestEnvironment ? 628 : 682) };
  };

  let page = firstPage;
  let y = drawHeader(page, top);
  for (const donation of input.donor.donations) {
    if (y - rowHeight < contentBottom) {
      ({ page, y } = addContinuationPage());
    }
    y -= rowHeight;
    page.drawText(donation.dateLabel, { x: left + 6, y: y + 5, size: 8.5, font: regular, color: black });
    page.drawText(donation.numeroControl, { x: controlX, y: y + 5, size: 8.5, font: regular, color: black });
    drawRightAligned(page, bareCents(donation.amountCents), y + 5, 8.5, regular, amountRightX, black);
    page.drawLine({ start: { x: left, y: y + 2 }, end: { x: right, y: y + 2 }, thickness: 0.4, color: rgb(0.82, 0.82, 0.82) });
  }

  // Keep the total and issue date together above the footer. If the final row used
  // that reserved space, move both closing lines to a fresh continuation page.
  if (y - rowHeight - 26 < contentBottom) {
    ({ page, y } = addContinuationPage());
  }
  y -= rowHeight;
  page.drawRectangle({ x: left, y: y + 4, width: right - left, height: rowHeight, color: rgb(0.93, 0.95, 0.95) });
  page.drawText(`Total (${input.donor.count} ${input.donor.count === 1 ? "donación" : "donaciones"})`, { x: left + 6, y: y + 9, size: 9, font: bold, color: black });
  drawRightAligned(page, formatCents(input.donor.totalCents), y + 9, 9.5, bold, amountRightX, black);
  return { page, y };
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

interface AnnualCertificatePreviewDonor {
  // The donor grouping key (email, else name) — the single-donor send addresses a
  // donor by this exact value, so the preview row carries it for the per-row button.
  groupKey: string;
  donorName: string;
  donorEmail: string | null;
  hasEmail: boolean;
  count: number;
  totalLabel: string;
  hasTestEnvironment: boolean;
}

export interface AnnualCertificatePreview {
  year: number;
  // donorCount/withEmail/withoutEmail/totalLabel are ALWAYS computed over the full,
  // unfiltered year — the summary describes the whole statement run, not the current
  // search. Only `donors` narrows to (and is capped over) the search results.
  donorCount: number;
  withEmail: number;
  withoutEmail: number;
  totalLabel: string;
  donors: AnnualCertificatePreviewDonor[];
  // Total donors matching the search `q` (or the full year when q is empty). `donors`
  // is the first ANNUAL_PREVIEW_LIMIT of these in aggregation order; `truncated` is
  // true when matchCount exceeds that cap so the UI can show "Mostrando N de M".
  matchCount: number;
  truncated: boolean;
}

// A busy year can have thousands of donors; the preview table (and its JSON payload)
// collapses at that scale, so the preview returns at most this many donor rows. The
// summary counts and matchCount still describe the full set.
const ANNUAL_PREVIEW_LIMIT = 50;

// Fold accents and lowercase so a search for "jose" finds "José". NFD splits a base
// letter from its combining diacritic; stripping the U+0300–U+036F combining range
// removes the accent. Applied to BOTH the query and each candidate before comparing.
function deaccentLower(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export async function buildAnnualCertificatePreview(repo: Repository, year: number, q?: string | null): Promise<AnnualCertificatePreview> {
  const donors = await aggregateAnnualDonors(repo, year);
  // Summary is over the FULL year, independent of the search filter.
  const withEmail = donors.filter((donor) => donor.donorEmail).length;
  const totalCents = donors.reduce((sum, donor) => sum + donor.totalCents, 0);

  const needle = deaccentLower((q ?? "").trim());
  const matches = needle
    ? donors.filter(
        (donor) =>
          deaccentLower(donor.donorName).includes(needle) || deaccentLower(donor.donorEmail ?? "").includes(needle)
      )
    : donors;

  return {
    year,
    donorCount: donors.length,
    withEmail,
    withoutEmail: donors.length - withEmail,
    totalLabel: formatCents(totalCents),
    matchCount: matches.length,
    truncated: matches.length > ANNUAL_PREVIEW_LIMIT,
    donors: matches.slice(0, ANNUAL_PREVIEW_LIMIT).map((donor) => ({
      groupKey: donor.groupKey,
      donorName: donor.donorName,
      donorEmail: donor.donorEmail,
      hasEmail: Boolean(donor.donorEmail),
      count: donor.count,
      totalLabel: formatCents(donor.totalCents),
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

// Raised when an explicit single-donor send names a donor who cannot be served.
// `status` maps directly onto the HTTP response: 404 when the donor is absent from
// the year's aggregation, 400 when the donor exists but has no email address.
export class SingleDonorSendError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message);
    this.name = "SingleDonorSendError";
  }
}

// Emails certificates for the given year. Two modes:
//  - Bulk (no `donorGroupKey`): one certificate per donor WITH an email address.
//    Idempotent re-runs — a donor with an existing DONOR_CERTIFICATE_SENT audit for
//    this year (entityId `<year>:<email>`) is skipped, so re-running covers only new
//    or previously failed donors. Donors without email are counted as skipped. Each
//    donor is audited SENT or FAILED independently — one failure never aborts the batch.
//  - Single (`donorGroupKey` set): sends ONLY that donor and is also the resend path,
//    so the sent-dedupe is deliberately bypassed. An unknown donor throws a 404 and a
//    donor without email a 400 (both Spanish); the audit metadata records mode "single".
export async function sendAnnualCertificates(
  env: Env,
  repo: Repository,
  year: number,
  actorId: string | null,
  donorGroupKey?: string | null
): Promise<AnnualCertificateSendResult> {
  const emisorConfig = getEmisorConfig(env);
  const emisor: CertificateEmisor = { nombre: emisorConfig.nombreComercial || emisorConfig.nombre, numDocumento: emisorConfig.numDocumento };
  const donors = await aggregateAnnualDonors(repo, year);
  // The certificate keeps the emisor's legal name (it is a fiscal document), but the
  // email chrome still picks up the church's accent color.
  const branding = await loadEmailBranding(repo, env);
  const email = new EmailService(env, undefined, {
    organizationName: emisor.nombre,
    senderName: branding.senderName,
    replyToAddress: branding.replyToAddress,
    brandColor: branding.brandColor,
    supportEmail: branding.supportEmail,
    logoUrl: branding.logoUrl
  });
  const issuedOnLabel = formatElSalvadorDate(new Date().toISOString());
  const result: AnnualCertificateSendResult = { year, sent: 0, skipped: 0, failed: 0 };
  const single = typeof donorGroupKey === "string";

  let targets = donors;
  if (single) {
    const donor = donors.find((candidate) => candidate.groupKey === donorGroupKey);
    if (!donor) {
      throw new SingleDonorSendError(404, "No se encontró al donante indicado en las donaciones aceptadas de este año.");
    }
    if (!donor.donorEmail) {
      throw new SingleDonorSendError(400, "El donante indicado no tiene correo registrado, por lo que no se le puede enviar la constancia.");
    }
    targets = [donor];
  }

  for (const donor of targets) {
    if (!donor.donorEmail) {
      result.skipped += 1;
      continue;
    }
    const entityId = `${year}:${donor.donorEmail}`;
    // A single-donor send is the explicit resend path, so it never dedupes.
    if (!single) {
      const alreadySent = await repo.countAuditEntries(DONOR_CERTIFICATE_SENT_ACTION, entityId);
      if (alreadySent > 0) {
        result.skipped += 1;
        continue;
      }
    }
    try {
      const pdfBytes = await renderCertificateDossierPdf({ year, donor, emisor, issuedOnLabel, accentColor: branding.brandColor });
      const totalLabel = formatCents(donor.totalCents);
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
          isTestEnvironment: donor.hasTestEnvironment,
          brandColor: branding.brandColor,
          supportEmail: branding.supportEmail,
          logoUrl: branding.logoUrl
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
        metadata: { year, donorName: donor.donorName, count: donor.count, totalCents: donor.totalCents, ...(single ? { mode: "single" } : {}) }
      });
      result.sent += 1;
    } catch (error) {
      await repo.createAudit({
        actorType: actorId ? "USER" : "SYSTEM",
        actorId,
        action: DONOR_CERTIFICATE_FAILED_ACTION,
        entityType: DONOR_CERTIFICATE_ENTITY_TYPE,
        entityId,
        summary: error instanceof Error ? error.message : String(error),
        metadata: single ? { mode: "single" } : undefined
      });
      result.failed += 1;
    }
  }
  return result;
}
