import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatCents } from "../../shared/money";
import type {
  Repository,
  StripeAnnualStatementDonorTarget,
  StripeAnnualStatementGift
} from "../storage/repository";
import type { Env } from "../types";
import { sha256Hex, utf8Bytes } from "../utils/encoding";
import { newId } from "../utils/ids";
import { loadEmailBranding } from "./branding";
import { classifyEmailDispatchError, EmailService } from "./email";
import { stripeAnnualStatementEmailHtml, type BrandingEmailOptions } from "./emailHtml";
import { ORG_LOGO_VIEW_BOX } from "./orgLogo";
import { drawOrganizationLogo, loadPdfBrandingLogo, type PdfBrandingLogo } from "./pdf";
import { resolveStripeConfiguration } from "./stripeDonations";

export const STRIPE_ANNUAL_STATEMENT_PREVIEW_PAGE_SIZE = 50;
export const STRIPE_ANNUAL_STATEMENT_BULK_DONOR_LIMIT = 10;

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 42;

export class StripeAnnualStatementConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StripeAnnualStatementConfigurationError";
  }
}

export class StripeAnnualStatementSingleDonorError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message);
    this.name = "StripeAnnualStatementSingleDonorError";
  }
}

export interface StripeUsYearWindow {
  timeZone: string;
  startIso: string;
  endIso: string;
}

export function stripeUsYearWindow(
  env: Pick<Env, "STRIPE_MOCK_MODE" | "STRIPE_US_TIME_ZONE">,
  year: number
): StripeUsYearWindow {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new StripeAnnualStatementConfigurationError("Indique un año válido para la constancia de EE. UU.");
  }
  const timeZone = env.STRIPE_MOCK_MODE === "1"
    ? "America/New_York"
    : env.STRIPE_US_TIME_ZONE?.trim();
  if (!timeZone || !validTimeZone(timeZone)) {
    throw new StripeAnnualStatementConfigurationError(
      "STRIPE_US_TIME_ZONE debe contener una zona horaria IANA válida."
    );
  }
  return {
    timeZone,
    startIso: zonedMidnightIso(year, timeZone),
    endIso: zonedMidnightIso(year + 1, timeZone)
  };
}

export interface StripeAnnualStatementItem {
  sourceId: string;
  settledAt: string;
  giftType: StripeAnnualStatementGift["gift_type"];
  frequency: StripeAnnualStatementGift["frequency"];
  grossAmountCents: number;
  refundedAmountCents: number;
  netAmountCents: number;
}

export interface StripeAnnualStatementSnapshot {
  version: 1;
  year: number;
  livemode: boolean;
  donor: { key: string; name: string; email: string | null };
  items: StripeAnnualStatementItem[];
  totals: {
    count: number;
    grossAmountCents: number;
    refundedAmountCents: number;
    netAmountCents: number;
  };
  canonicalJson: string;
  hash: string;
}

export async function buildStripeAnnualStatementSnapshot(input: {
  year: number;
  livemode: boolean;
  donorKey: string;
  donorName: string;
  donorEmail: string | null;
  gifts: StripeAnnualStatementGift[];
}): Promise<StripeAnnualStatementSnapshot> {
  const items = [...input.gifts]
    .sort((left, right) => left.settled_at.localeCompare(right.settled_at) || left.id.localeCompare(right.id))
    .map((gift): StripeAnnualStatementItem => {
      const grossAmountCents = checkedCents(gift.amount_cents, "gross amount");
      const refundedAmountCents = checkedCents(gift.refunded_amount_cents, "refunded amount");
      const netAmountCents = grossAmountCents - refundedAmountCents;
      if (netAmountCents < 0) {
        throw new Error("Stripe annual statement contains a negative net amount");
      }
      return {
        sourceId: gift.source_id,
        settledAt: normalizedIso(gift.settled_at),
        giftType: gift.gift_type,
        frequency: gift.frequency,
        grossAmountCents,
        refundedAmountCents,
        netAmountCents
      };
    });
  if (items.length === 0) {
    throw new Error("Stripe annual statement snapshot has no settled gifts");
  }
  const totals = items.reduce(
    (sum, item) => ({
      count: sum.count + 1,
      grossAmountCents: sum.grossAmountCents + item.grossAmountCents,
      refundedAmountCents: sum.refundedAmountCents + item.refundedAmountCents,
      netAmountCents: sum.netAmountCents + item.netAmountCents
    }),
    { count: 0, grossAmountCents: 0, refundedAmountCents: 0, netAmountCents: 0 }
  );
  if (totals.netAmountCents < 0) {
    throw new Error("Stripe annual statement contains a negative annual net amount");
  }
  const canonical = {
    version: 1 as const,
    year: input.year,
    livemode: input.livemode,
    donor: {
      key: input.donorKey.trim(),
      name: input.donorName.trim() || "Donante",
      email: normalizedEmail(input.donorEmail)
    },
    items,
    totals
  };
  const canonicalJson = JSON.stringify(canonical);
  return {
    ...canonical,
    canonicalJson,
    hash: await sha256Hex(utf8Bytes(canonicalJson))
  };
}

export interface RenderStripeAnnualStatementPdfInput {
  snapshot: StripeAnnualStatementSnapshot;
  legalName: string;
  ein: string;
  timeZone: string;
  issuedOn: string;
  corrected: boolean;
  accentColor?: string;
  logo?: PdfBrandingLogo | null;
}

export async function renderStripeAnnualStatementPdf(
  input: RenderStripeAnnualStatementPdfInput
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const accent = accentRgb(input.accentColor);
  const muted = rgb(0.32, 0.36, 0.38);
  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = await drawStatementHeader(pdf, page, input, regular, bold, accent);

  for (const item of input.snapshot.items) {
    if (y < 142) {
      page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      page.drawText(`Constancia anual de donaciones — EE. UU. ${input.snapshot.year} — continuación`, {
        x: MARGIN,
        y: 744,
        size: 12,
        font: bold,
        color: accent
      });
      y = drawTableHeader(page, bold, 716, accent);
    }
    const date = formatUsDate(item.settledAt, input.timeZone);
    page.drawText(date, { x: MARGIN + 4, y, size: 8, font: regular });
    page.drawText(giftTypeLabel(item.giftType), { x: 112, y, size: 8, font: regular });
    page.drawText(frequencyLabel(item.frequency), { x: 176, y, size: 8, font: regular });
    drawRight(page, formatCents(item.grossAmountCents), 337, y, 8, regular);
    drawRight(page, formatCents(item.refundedAmountCents), 432, y, 8, regular);
    drawRight(page, formatCents(item.netAmountCents), PAGE_WIDTH - MARGIN - 4, y, 8, regular);
    page.drawLine({
      start: { x: MARGIN, y: y - 5 },
      end: { x: PAGE_WIDTH - MARGIN, y: y - 5 },
      thickness: 0.35,
      color: rgb(0.84, 0.86, 0.87)
    });
    y -= 20;
  }

  if (y < 158) {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = 724;
  }
  page.drawText(`Total neto anual (${input.snapshot.totals.count} ${input.snapshot.totals.count === 1 ? "donación" : "donaciones"})`, {
    x: MARGIN,
    y,
    size: 10,
    font: bold
  });
  drawRight(page, formatCents(input.snapshot.totals.netAmountCents), PAGE_WIDTH - MARGIN, y, 11, bold);
  y -= 22;
  page.drawText("No se proporcionaron bienes ni servicios a cambio de estas donaciones.", {
    x: MARGIN,
    y,
    size: 9,
    font: bold,
    maxWidth: PAGE_WIDTH - MARGIN * 2
  });
  y -= 18;
  page.drawText("Documento informativo para sus registros; no constituye asesoría fiscal.", {
    x: MARGIN,
    y,
    size: 8.5,
    font: regular,
    color: muted
  });
  page.drawText(`Emitida el ${formatUsDate(input.issuedOn, input.timeZone)}.`, {
    x: MARGIN,
    y: y - 16,
    size: 8.5,
    font: regular,
    color: muted
  });

  for (const currentPage of pdf.getPages()) {
    currentPage.drawLine({ start: { x: MARGIN, y: 54 }, end: { x: PAGE_WIDTH - MARGIN, y: 54 }, thickness: 0.5, color: rgb(0.8, 0.82, 0.83) });
    currentPage.drawText(input.legalName, { x: MARGIN, y: 40, size: 7.5, font: regular, color: muted });
  }
  return pdf.save();
}

export function stripeAnnualStatementEmailContent(input: {
  donorName: string;
  year: number;
  count: number;
  netTotalCents: number;
  corrected: boolean;
  branding: BrandingEmailOptions;
}): { subject: string; text: string; html: string } {
  const title = input.corrected ? "Constancia anual corregida de donaciones" : "Constancia anual de donaciones";
  const netTotalLabel = formatCents(input.netTotalCents);
  const correction = input.corrected
    ? " Esta versión corregida reemplaza la constancia anterior para el mismo año."
    : "";
  return {
    subject: `${title} ${input.year} — EE. UU.`,
    text:
      `Estimado(a) ${input.donorName}:\n\n` +
      `Adjuntamos su constancia anual de donaciones de ${input.year}, con ${input.count} ${input.count === 1 ? "donación" : "donaciones"} y un total neto de ${netTotalLabel}.${correction}\n\n` +
      `No se proporcionaron bienes ni servicios a cambio de estas donaciones.\n\n` +
      `Conserve este documento con sus registros. Este mensaje no constituye asesoría fiscal.`,
    html: stripeAnnualStatementEmailHtml({
      donorName: input.donorName,
      year: input.year,
      count: input.count,
      netTotalLabel,
      corrected: input.corrected,
      organizationName: input.branding.organizationName,
      brandColor: input.branding.brandColor,
      supportEmail: input.branding.supportEmail,
      logoUrl: input.branding.logoUrl
    })
  };
}

export interface StripeAnnualStatementPreviewDonor {
  donorKey: string;
  donorName: string;
  donorEmail: string | null;
  hasEmail: boolean;
  count: number;
  grossTotalLabel: string;
  refundedTotalLabel: string;
  netTotalLabel: string;
}

export interface StripeAnnualStatementPreview {
  year: number;
  livemode: boolean;
  timeZone: string;
  donors: StripeAnnualStatementPreviewDonor[];
  hasMore: boolean;
  nextCursor: string | null;
}

export async function buildStripeAnnualStatementPreview(
  env: Env,
  repo: Repository,
  year: number,
  livemode: boolean,
  after?: string | null,
  query?: string | null
): Promise<StripeAnnualStatementPreview> {
  const window = stripeUsYearWindow(env, year);
  const targets = await repo.listStripeAnnualStatementDonorTargets(window, {
    livemode,
    afterDonorKey: after?.trim() || null,
    query: query?.trim() || null,
    limit: STRIPE_ANNUAL_STATEMENT_PREVIEW_PAGE_SIZE
  });
  const hasMore = targets.length > STRIPE_ANNUAL_STATEMENT_PREVIEW_PAGE_SIZE;
  const visible = targets.slice(0, STRIPE_ANNUAL_STATEMENT_PREVIEW_PAGE_SIZE);
  return {
    year,
    livemode,
    timeZone: window.timeZone,
    donors: visible.map(previewDonor),
    hasMore,
    nextCursor: hasMore ? visible.at(-1)?.donorKey ?? null : null
  };
}

export interface StripeAnnualStatementSendRequest {
  donor?: string;
  after?: string;
  now?: string;
}

export interface StripeAnnualStatementSendResult {
  year: number;
  livemode: boolean;
  mode: "bulk" | "single";
  processed: number;
  sent: number;
  skipped: number;
  failed: number;
  review: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export async function sendStripeAnnualStatements(
  env: Env,
  repo: Repository,
  year: number,
  livemode: boolean,
  actorId: string | null,
  request: StripeAnnualStatementSendRequest = {}
): Promise<StripeAnnualStatementSendResult> {
  const window = stripeUsYearWindow(env, year);
  const configuration = resolveStripeConfiguration(env);
  if (configuration.livemode !== livemode) {
    throw new StripeAnnualStatementConfigurationError("El ambiente solicitado no coincide con la configuración de Stripe.");
  }
  const single = typeof request.donor === "string";
  const candidates = await repo.listStripeAnnualStatementDonorTargets(window, {
    livemode,
    afterDonorKey: single ? null : request.after?.trim() || null,
    limit: single ? 1 : STRIPE_ANNUAL_STATEMENT_BULK_DONOR_LIMIT,
    ...(single ? { donorKey: request.donor } : {})
  });
  if (single && candidates.length === 0) {
    throw new StripeAnnualStatementSingleDonorError(404, "No se encontró al donante indicado en las donaciones de EE. UU. de este año.");
  }
  if (single && !candidates[0].donorEmail) {
    throw new StripeAnnualStatementSingleDonorError(400, "El donante indicado no tiene correo registrado.");
  }
  const hasMore = !single && candidates.length > STRIPE_ANNUAL_STATEMENT_BULK_DONOR_LIMIT;
  const targets = candidates.slice(0, single ? 1 : STRIPE_ANNUAL_STATEMENT_BULK_DONOR_LIMIT);
  const result: StripeAnnualStatementSendResult = {
    year,
    livemode,
    mode: single ? "single" : "bulk",
    processed: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
    review: 0,
    hasMore,
    nextCursor: hasMore ? targets.at(-1)?.donorKey ?? null : null
  };
  const now = request.now ?? new Date().toISOString();
  const branding = await loadEmailBranding(repo, env);
  const logo = await loadPdfBrandingLogo(env);
  const email = new EmailService(env, undefined, branding);

  for (const target of targets) {
    result.processed += 1;
    if (!target.donorEmail) {
      result.skipped += 1;
      continue;
    }
    let deliveryId: string | null = null;
    let claimId: string | null = null;
    let providerDispatchStarted = false;
    try {
      const snapshot = await snapshotForTarget(repo, window, livemode, target, year);
      const delivery = await repo.reserveStripeAnnualStatementDelivery({
        id: newId("stripe_annual_statement"),
        year,
        livemode,
        donorKey: snapshot.donor.key,
        donorName: snapshot.donor.name,
        donorEmail: snapshot.donor.email,
        snapshotHash: snapshot.hash,
        snapshotJson: snapshot.canonicalJson,
        now
      });
      deliveryId = delivery.id;
      if (delivery.status === "SENT" || delivery.status === "REVIEW" || (delivery.status === "FAILED" && delivery.retry_safe === 0)) {
        result.skipped += 1;
        continue;
      }
      claimId = newId("stripe_annual_statement_claim");
      const claim = await repo.claimStripeAnnualStatementDelivery({ id: delivery.id, claimId, now });
      if (!claim) {
        result.skipped += 1;
        continue;
      }
      const rechecked = await snapshotForTarget(repo, window, livemode, target, year);
      if (rechecked.hash !== claim.snapshot_hash || rechecked.canonicalJson !== claim.snapshot_json) {
        await repo.finalizeStripeAnnualStatementDelivery({
          id: claim.id,
          claimId,
          outcome: "FAILED",
          failureCode: "snapshot_changed_before_dispatch",
          retrySafe: true,
          now
        });
        result.failed += 1;
        await auditStatement(repo, actorId, claim.id, "FAILED", claim.revision, Boolean(claim.supersedes_delivery_id));
        continue;
      }
      const corrected = Boolean(claim.supersedes_delivery_id);
      const pdfBytes = await renderStripeAnnualStatementPdf({
        snapshot: rechecked,
        legalName: configuration.legalName,
        ein: configuration.ein,
        timeZone: window.timeZone,
        issuedOn: now,
        corrected,
        accentColor: branding.brandColor,
        logo
      });
      const content = stripeAnnualStatementEmailContent({
        donorName: rechecked.donor.name,
        year,
        count: rechecked.totals.count,
        netTotalCents: rechecked.totals.netAmountCents,
        corrected,
        branding
      });
      const sent = await email.sendStripeAnnualStatement({
        toEmail: target.donorEmail,
        subject: content.subject,
        text: content.text,
        html: content.html,
        pdfBytes,
        filename: `constancia-anual-donaciones-eeuu-${year}-r${claim.revision}.pdf`,
        idempotencyKey: `stripe-annual-statement:${claim.id}`
      }, async () => {
        providerDispatchStarted = await repo.markStripeAnnualStatementDispatchStarted({
          id: claim.id,
          claimId: claimId!,
          now
        });
        if (!providerDispatchStarted) throw new Error("Stripe annual statement dispatch claim was lost");
      });
      if (!sent.providerDeliveryId) {
        throw new Error("Stripe annual statement provider acceptance was unconfirmed");
      }
      if (!await repo.finalizeStripeAnnualStatementDelivery({
        id: claim.id,
        claimId,
        outcome: "SENT",
        providerIdHash: sent.providerDeliveryId,
        failureCode: null,
        retrySafe: false,
        now
      })) {
        throw new Error("Stripe annual statement finalization claim was lost");
      }
      result.sent += 1;
      await auditStatement(repo, actorId, claim.id, "SENT", claim.revision, corrected);
    } catch (error) {
      const classified = classifyEmailDispatchError(error, providerDispatchStarted);
      const outcome = classified.outcomeClass === "UNKNOWN" ? "REVIEW" : "FAILED";
      if (deliveryId && claimId) {
        await repo.finalizeStripeAnnualStatementDelivery({
          id: deliveryId,
          claimId,
          outcome,
          failureCode: classified.code,
          retrySafe: outcome === "FAILED" && classified.retrySafe,
          now
        });
        await auditStatement(repo, actorId, deliveryId, outcome, null, false);
      }
      if (outcome === "REVIEW") result.review += 1;
      else result.failed += 1;
    }
  }
  return result;
}

async function snapshotForTarget(
  repo: Repository,
  window: StripeUsYearWindow,
  livemode: boolean,
  target: StripeAnnualStatementDonorTarget,
  year: number
): Promise<StripeAnnualStatementSnapshot> {
  const gifts = await repo.listStripeAnnualStatementDonorGifts(window, livemode, target.donorKey);
  const first = [...gifts]
    .sort((left, right) => left.settled_at.localeCompare(right.settled_at) || left.id.localeCompare(right.id))[0];
  const donorEmail = normalizedEmail(first?.donor_email ?? null);
  const donorKey = donorEmail ?? (first ? `gift:${first.id}` : target.donorKey);
  const donorName = first?.donor_name?.trim() || donorEmail || "Donante";
  return buildStripeAnnualStatementSnapshot({
    year,
    livemode,
    donorKey,
    donorName,
    donorEmail,
    gifts
  });
}

async function auditStatement(
  repo: Repository,
  actorId: string | null,
  deliveryId: string,
  outcome: "SENT" | "FAILED" | "REVIEW",
  revision: number | null,
  corrected: boolean
): Promise<void> {
  await repo.createAudit({
    actorType: actorId ? "USER" : "SYSTEM",
    actorId,
    action: `STRIPE_ANNUAL_STATEMENT_${outcome}`,
    entityType: "stripe_annual_statement",
    entityId: deliveryId,
    summary: outcome === "SENT"
      ? `Constancia anual de EE. UU. ${corrected ? "corregida " : ""}enviada`
      : `Constancia anual de EE. UU. marcada ${outcome}`,
    metadata: { outcome, revision, corrected }
  });
}

function previewDonor(target: StripeAnnualStatementDonorTarget): StripeAnnualStatementPreviewDonor {
  return {
    donorKey: target.donorKey,
    donorName: target.donorName,
    donorEmail: target.donorEmail,
    hasEmail: Boolean(target.donorEmail),
    count: target.count,
    grossTotalLabel: formatCents(target.grossCents),
    refundedTotalLabel: formatCents(target.refundedCents),
    netTotalLabel: formatCents(target.netCents)
  };
}

async function drawStatementHeader(
  pdf: PDFDocument,
  page: PDFPage,
  input: RenderStripeAnnualStatementPdfInput,
  regular: PDFFont,
  bold: PDFFont,
  accent: ReturnType<typeof rgb>
): Promise<number> {
  const logoHeight = 42;
  const logoWidth = ORG_LOGO_VIEW_BOX.width * (logoHeight / ORG_LOGO_VIEW_BOX.height);
  await drawOrganizationLogo(pdf, page, {
    x: (PAGE_WIDTH - logoWidth) / 2,
    bottomY: 730,
    height: logoHeight,
    centered: true
  }, input.logo);
  drawCentered(page, input.legalName, 706, 11, bold);
  drawCentered(page, `EIN: ${input.ein}`, 691, 9, regular);
  drawCentered(page, "Constancia anual de donaciones — EE. UU.", 660, 17, bold, accent);
  drawCentered(page, `Año calendario ${input.snapshot.year}`, 640, 11, bold);
  if (input.corrected) {
    drawCentered(page, "CONSTANCIA CORREGIDA", 619, 10, bold, rgb(0.65, 0.2, 0.12));
  }
  const identityY = input.corrected ? 588 : 602;
  page.drawText(`Donante: ${input.snapshot.donor.name}`, { x: MARGIN, y: identityY, size: 9.5, font: regular });
  if (input.snapshot.donor.email) {
    page.drawText(`Correo: ${input.snapshot.donor.email}`, { x: MARGIN, y: identityY - 15, size: 9.5, font: regular });
  }
  return drawTableHeader(page, bold, identityY - 44, accent);
}

function drawTableHeader(page: PDFPage, bold: PDFFont, y: number, accent: ReturnType<typeof rgb>): number {
  page.drawRectangle({ x: MARGIN, y: y - 5, width: PAGE_WIDTH - MARGIN * 2, height: 18, color: accent });
  page.drawText("Fecha", { x: MARGIN + 4, y, size: 8, font: bold, color: rgb(1, 1, 1) });
  page.drawText("Tipo", { x: 112, y, size: 8, font: bold, color: rgb(1, 1, 1) });
  page.drawText("Frecuencia", { x: 176, y, size: 8, font: bold, color: rgb(1, 1, 1) });
  drawRight(page, "Bruto", 337, y, 8, bold, rgb(1, 1, 1));
  drawRight(page, "Reintegrado", 432, y, 8, bold, rgb(1, 1, 1));
  drawRight(page, "Neto", PAGE_WIDTH - MARGIN - 4, y, 8, bold, rgb(1, 1, 1));
  return y - 22;
}

function drawCentered(
  page: PDFPage,
  text: string,
  y: number,
  size: number,
  font: PDFFont,
  color = rgb(0, 0, 0)
): void {
  page.drawText(text, { x: (PAGE_WIDTH - font.widthOfTextAtSize(text, size)) / 2, y, size, font, color });
}

function drawRight(
  page: PDFPage,
  text: string,
  right: number,
  y: number,
  size: number,
  font: PDFFont,
  color = rgb(0, 0, 0)
): void {
  page.drawText(text, { x: right - font.widthOfTextAtSize(text, size), y, size, font, color });
}

function accentRgb(value: string | undefined): ReturnType<typeof rgb> {
  const match = /^#([0-9a-f]{6})$/i.exec(value?.trim() ?? "");
  if (!match) return rgb(0.06, 0.46, 0.43);
  const encoded = Number.parseInt(match[1], 16);
  return rgb(((encoded >> 16) & 0xff) / 255, ((encoded >> 8) & 0xff) / 255, (encoded & 0xff) / 255);
}

function giftTypeLabel(value: StripeAnnualStatementGift["gift_type"]): string {
  return value === "TITHE" ? "Diezmo" : value === "OFFERING" ? "Ofrenda" : "No especificado";
}

function frequencyLabel(value: StripeAnnualStatementGift["frequency"]): string {
  return value === "MONTHLY" ? "Mensual" : "Única";
}

function formatUsDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("es-US", { dateStyle: "medium", timeZone }).format(new Date(iso));
}

function normalizedEmail(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function checkedCents(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Stripe annual statement ${label} is invalid`);
  return value;
}

function normalizedIso(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Stripe annual statement settled date is invalid");
  return new Date(timestamp).toISOString();
}

function validTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

function zonedMidnightIso(year: number, timeZone: string): string {
  const target = Date.UTC(year, 0, 1, 0, 0, 0);
  let instant = target;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const localAsUtc = localPartsAsUtc(instant, timeZone);
    instant += target - localAsUtc;
  }
  return new Date(instant).toISOString();
}

function localPartsAsUtc(timestamp: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day"), part("hour"), part("minute"), part("second"));
}
