import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import { formatCents } from "../../shared/money";
import type {
  Repository,
  StripeAnnualStatementDonorTarget,
  StripeAnnualStatementGift,
  StripeDonorAddress
} from "../storage/repository";
import { StripeAnnualStatementReservationFenceError } from "../storage/repository/stripeAnnualStatements";
import type { Env } from "../types";
import { sha256Hex, utf8Bytes } from "../utils/encoding";
import { newId } from "../utils/ids";
import {
  BRANDING_ACCENT_COLOR_SETTING_KEY,
  BRANDING_DISPLAY_NAME_SETTING_KEY,
  BRANDING_DONOR_LOGO_SETTING_KEY,
  BRANDING_LOGO_SETTING_KEY,
  BRANDING_SUPPORT_EMAIL_SETTING_KEY,
  loadEmailBranding
} from "./branding";
import { classifyEmailDispatchError, EmailDispatchError, EmailService } from "./email";
import { stripeAnnualStatementEmailHtml, type BrandingEmailOptions } from "./emailHtml";
import { EMAIL_REPLY_TO_SETTING_KEY, EMAIL_SENDER_NAME_SETTING_KEY } from "./emailSender";
import {
  loadPdfBrandingLogo,
  pdfSafeText,
  type PdfBrandingLogo
} from "./pdf";
import { logWorkerError } from "./observability";
import { resolveStripeConfiguration } from "./stripeDonations";
import { STRIPE_ANNUAL_LOGO_BYTES } from "./stripePdfAssets";

export const STRIPE_ANNUAL_STATEMENT_PREVIEW_PAGE_SIZE = 50;
export const STRIPE_ANNUAL_STATEMENT_BULK_DONOR_LIMIT = 10;

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
export const STRIPE_ANNUAL_STATEMENT_PDF_VERSION = "stripe-annual-statement-pdf:v3" as const;

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

export function stripeUsTimeZone(
  env: Pick<Env, "STRIPE_MOCK_MODE" | "STRIPE_US_TIME_ZONE">
): string {
  const timeZone = env.STRIPE_MOCK_MODE === "1"
    ? "America/New_York"
    : env.STRIPE_US_TIME_ZONE?.trim();
  if (!timeZone || !validTimeZone(timeZone)) {
    throw new StripeAnnualStatementConfigurationError(
      "STRIPE_US_TIME_ZONE debe contener una zona horaria IANA válida."
    );
  }
  return timeZone;
}

export function stripeUsCurrentYear(
  env: Pick<Env, "STRIPE_MOCK_MODE" | "STRIPE_US_TIME_ZONE">,
  now: Date
): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: stripeUsTimeZone(env),
    year: "numeric"
  }).formatToParts(now);
  return Number(parts.find((part) => part.type === "year")?.value ?? 0);
}

export function stripeUsYearWindow(
  env: Pick<Env, "STRIPE_MOCK_MODE" | "STRIPE_US_TIME_ZONE">,
  year: number
): StripeUsYearWindow {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) {
    throw new StripeAnnualStatementConfigurationError("Indique un año válido para la constancia de EE. UU.");
  }
  const timeZone = stripeUsTimeZone(env);
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
  version: 2;
  year: number;
  livemode: boolean;
  donor: {
    key: string;
    name: string;
    email: string | null;
    phone: string | null;
    address: StripeDonorAddress | null;
  };
  document: StripeAnnualStatementDocumentEvidence;
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

export interface StripeAnnualStatementDocumentEvidence {
  rendererVersion: typeof STRIPE_ANNUAL_STATEMENT_PDF_VERSION;
  legalName: string;
  ein: string;
  timeZone: string;
  accentColor: string;
  logo: { format: PdfBrandingLogo["format"]; hash: string } | null;
  organizationContact: {
    phone: string;
    website: string;
    mailingAddress: string[];
  };
  email: {
    organizationName: string;
    supportEmail: string;
    logoUrl: string | null;
    senderName: string;
    replyToAddress: string | null;
  };
  settings: StripeAnnualStatementSettingEvidence;
}

export interface StripeAnnualStatementSettingEvidence {
  brandingDisplayName: string | null;
  brandingAccentColor: string | null;
  brandingSupportEmail: string | null;
  brandingLogo: string | null;
  brandingDonorLogo: string | null;
  emailSenderName: string | null;
  emailReplyTo: string | null;
}

export async function buildStripeAnnualStatementSnapshot(input: {
  year: number;
  livemode: boolean;
  donorKey: string;
  donorName: string;
  donorEmail: string | null;
  document: StripeAnnualStatementDocumentEvidence;
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
  const newestGifts = [...input.gifts]
    .sort((left, right) => right.settled_at.localeCompare(left.settled_at) || right.id.localeCompare(left.id));
  const donorPhone = newestGifts
    .map((gift) => gift.donor_phone?.trim() || null)
    .find((value): value is string => value !== null) ?? null;
  const donorAddress = newestGifts
    .map((gift) => parseStripeDonorAddress(gift.donor_address_json))
    .find((value): value is StripeDonorAddress => value !== null) ?? null;
  const canonical = {
    version: 2 as const,
    year: input.year,
    livemode: input.livemode,
    donor: {
      key: input.donorKey.trim(),
      name: input.donorName.trim() || "Donante",
      email: normalizedEmail(input.donorEmail),
      phone: donorPhone,
      address: donorAddress
    },
    document: {
      rendererVersion: input.document.rendererVersion,
      legalName: input.document.legalName.trim(),
      ein: input.document.ein.trim(),
      timeZone: input.document.timeZone,
      accentColor: input.document.accentColor.trim().toLowerCase(),
      logo: input.document.logo,
      organizationContact: {
        phone: input.document.organizationContact.phone.trim(),
        website: input.document.organizationContact.website.trim(),
        mailingAddress: input.document.organizationContact.mailingAddress.map((line) => line.trim()).filter(Boolean)
      },
      email: input.document.email,
      settings: input.document.settings
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
  issuedOn: string;
  corrected: boolean;
  logo?: PdfBrandingLogo | null;
}

export async function renderStripeAnnualStatementPdf(
  input: RenderStripeAnnualStatementPdfInput
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const logo = await annualStatementLogo(pdf, input.logo);
  const firstPageItems = input.snapshot.items.slice(0, 5);
  const continuationItems = input.snapshot.items.slice(5);
  const pages: StripeAnnualStatementItem[][] = [firstPageItems];
  for (let index = 0; index < continuationItems.length; index += 12) {
    pages.push(continuationItems.slice(index, index + 12));
  }

  pages.forEach((items, pageIndex) => {
    const page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const finalPage = pageIndex === pages.length - 1;
    if (pageIndex === 0) {
      drawAnnualCover(page, input, logo, regular, bold, italic);
      drawAnnualContributionTable(page, items, {
        topY: 215.613,
        rowHeight: 24.75,
        regular,
        bold,
        timeZone: input.snapshot.document.timeZone,
        total: finalPage ? input.snapshot.totals : null
      });
    } else {
      drawAnnualContributionTable(page, items, {
        topY: 752.316,
        rowHeight: 24.75,
        regular,
        bold,
        timeZone: input.snapshot.document.timeZone,
        total: finalPage ? input.snapshot.totals : null
      });
    }
    drawAnnualFooter(page, input, pageIndex + 1, pages.length, regular);
  });

  pdf.setTitle(`Annual Giving Statement ${input.snapshot.year}`);
  pdf.setAuthor(input.snapshot.document.legalName);
  pdf.setProducer(STRIPE_ANNUAL_STATEMENT_PDF_VERSION);
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
  const context = await loadStripeAnnualStatementContext(env, repo, year, livemode);
  const { window } = context;
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
  const operationNow = (): string => request.now ?? new Date().toISOString();

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
      const snapshot = await snapshotForTarget(repo, window, livemode, target, year, context.document);
      let delivery;
      try {
        delivery = await repo.reserveStripeAnnualStatementDelivery({
          id: newId("stripe_annual_statement"),
          year,
          livemode,
          donorKey: snapshot.donor.key,
          donorName: snapshot.donor.name,
          donorEmail: snapshot.donor.email,
          snapshotHash: snapshot.hash,
          snapshotJson: snapshot.canonicalJson,
          now: operationNow()
        });
      } catch (error) {
        if (error instanceof StripeAnnualStatementReservationFenceError) {
          if (error.status === "REVIEW") result.review += 1;
          else result.skipped += 1;
          continue;
        }
        throw error;
      }
      deliveryId = delivery.id;
      if (delivery.status === "REVIEW") {
        result.review += 1;
        continue;
      }
      if (delivery.status === "SENT" || (delivery.status === "FAILED" && delivery.retry_safe === 0)) {
        result.skipped += 1;
        continue;
      }
      claimId = newId("stripe_annual_statement_claim");
      const claim = await repo.claimStripeAnnualStatementDelivery({
        id: delivery.id,
        claimId,
        now: operationNow()
      });
      if (!claim) {
        result.skipped += 1;
        continue;
      }
      const corrected = Boolean(claim.supersedes_delivery_id);
      const pdfBytes = await renderStripeAnnualStatementPdf({
        snapshot,
        issuedOn: claim.updated_at,
        corrected,
        logo: context.logo
      });
      const finalContext = await loadStripeAnnualStatementContext(env, repo, year, livemode);
      const rechecked = await snapshotForTarget(
        repo,
        finalContext.window,
        livemode,
        target,
        year,
        finalContext.document
      );
      if (rechecked.hash !== claim.snapshot_hash || rechecked.canonicalJson !== claim.snapshot_json) {
        await repo.finalizeStripeAnnualStatementDelivery({
          id: claim.id,
          claimId,
          outcome: "FAILED",
          failureCode: "snapshot_changed_before_dispatch",
          retrySafe: true,
          now: operationNow()
        });
        result.failed += 1;
        await auditStatementBestEffort(env, repo, actorId, claim.id, "FAILED", claim.revision, corrected);
        continue;
      }
      const content = stripeAnnualStatementEmailContent({
        donorName: rechecked.donor.name,
        year,
        count: rechecked.totals.count,
        netTotalCents: rechecked.totals.netAmountCents,
        corrected,
        branding: finalContext.branding
      });
      const sent = await new EmailService(env, undefined, finalContext.branding).sendStripeAnnualStatement({
        toEmail: rechecked.donor.email!,
        subject: content.subject,
        text: content.text,
        html: content.html,
        pdfBytes,
        filename: `constancia-anual-donaciones-eeuu-${year}-r${claim.revision}.pdf`,
        idempotencyKey: `stripe-annual-statement:${claim.id}`
      }, async () => {
        const dispatchAuthorized = await repo.markStripeAnnualStatementDispatchStarted({
          id: claim.id,
          claimId: claimId!,
          snapshotHash: claim.snapshot_hash,
          snapshotJson: claim.snapshot_json,
          range: finalContext.window,
          livemode,
          donorKey: claim.donor_key,
          now: operationNow()
        });
        if (!dispatchAuthorized) {
          throw new EmailDispatchError(
            "Stripe annual statement dispatch authorization failed",
            "snapshot_changed_before_dispatch",
            "NOT_SENT",
            true
          );
        }
        providerDispatchStarted = true;
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
        now: operationNow()
      })) {
        throw new Error("Stripe annual statement finalization claim was lost");
      }
      result.sent += 1;
      await auditStatementBestEffort(env, repo, actorId, claim.id, "SENT", claim.revision, corrected);
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
          now: operationNow()
        });
        await auditStatementBestEffort(env, repo, actorId, deliveryId, outcome, null, false);
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
  year: number,
  document: StripeAnnualStatementDocumentEvidence
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
    document,
    gifts
  });
}

async function loadStripeAnnualStatementContext(
  env: Env,
  repo: Repository,
  year: number,
  livemode: boolean
): Promise<{
  window: StripeUsYearWindow;
  branding: Awaited<ReturnType<typeof loadEmailBranding>>;
  logo: PdfBrandingLogo | null;
  document: StripeAnnualStatementDocumentEvidence;
}> {
  const window = stripeUsYearWindow(env, year);
  const configuration = resolveStripeConfiguration(env);
  if (configuration.livemode !== livemode) {
    throw new StripeAnnualStatementConfigurationError("El ambiente solicitado no coincide con la configuración de Stripe.");
  }
  const [settings, logo] = await Promise.all([
    loadStripeAnnualStatementSettingEvidence(repo),
    loadPdfBrandingLogo(env)
  ]);
  const branding = await loadEmailBranding({
    getSetting: async (key) => settingEvidenceValue(settings, key)
  }, env);
  return {
    window,
    branding,
    logo,
    document: {
      rendererVersion: STRIPE_ANNUAL_STATEMENT_PDF_VERSION,
      legalName: configuration.legalName,
      ein: configuration.ein,
      timeZone: window.timeZone,
      accentColor: branding.brandColor,
      logo: logo ? { format: logo.format, hash: await sha256Hex(logo.bytes) } : null,
      email: {
        organizationName: branding.organizationName,
        supportEmail: branding.supportEmail,
        logoUrl: branding.logoUrl,
        senderName: branding.senderName,
        replyToAddress: branding.replyToAddress
      },
      organizationContact: {
        phone: configuration.organizationPhone,
        website: configuration.organizationWebsite,
        mailingAddress: configuration.organizationMailingAddress
      },
      settings
    }
  };
}

async function loadStripeAnnualStatementSettingEvidence(
  repo: Pick<Repository, "getSetting">
): Promise<StripeAnnualStatementSettingEvidence> {
  const [
    brandingDisplayName,
    brandingAccentColor,
    brandingSupportEmail,
    brandingLogo,
    brandingDonorLogo,
    emailSenderName,
    emailReplyTo
  ] = await Promise.all([
    repo.getSetting(BRANDING_DISPLAY_NAME_SETTING_KEY),
    repo.getSetting(BRANDING_ACCENT_COLOR_SETTING_KEY),
    repo.getSetting(BRANDING_SUPPORT_EMAIL_SETTING_KEY),
    repo.getSetting(BRANDING_LOGO_SETTING_KEY),
    repo.getSetting(BRANDING_DONOR_LOGO_SETTING_KEY),
    repo.getSetting(EMAIL_SENDER_NAME_SETTING_KEY),
    repo.getSetting(EMAIL_REPLY_TO_SETTING_KEY)
  ]);
  return {
    brandingDisplayName,
    brandingAccentColor,
    brandingSupportEmail,
    brandingLogo,
    brandingDonorLogo,
    emailSenderName,
    emailReplyTo
  };
}

function settingEvidenceValue(settings: StripeAnnualStatementSettingEvidence, key: string): string | null {
  switch (key) {
    case BRANDING_DISPLAY_NAME_SETTING_KEY: return settings.brandingDisplayName;
    case BRANDING_ACCENT_COLOR_SETTING_KEY: return settings.brandingAccentColor;
    case BRANDING_SUPPORT_EMAIL_SETTING_KEY: return settings.brandingSupportEmail;
    case BRANDING_LOGO_SETTING_KEY: return settings.brandingLogo;
    case BRANDING_DONOR_LOGO_SETTING_KEY: return settings.brandingDonorLogo;
    case EMAIL_SENDER_NAME_SETTING_KEY: return settings.emailSenderName;
    case EMAIL_REPLY_TO_SETTING_KEY: return settings.emailReplyTo;
    default: return null;
  }
}

async function auditStatementBestEffort(
  env: Env,
  repo: Repository,
  actorId: string | null,
  deliveryId: string,
  outcome: "SENT" | "FAILED" | "REVIEW",
  revision: number | null,
  corrected: boolean
): Promise<void> {
  try {
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
  } catch (error) {
    logWorkerError(env, "stripe_annual_statement_audit_failed", error);
  }
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

async function annualStatementLogo(
  pdf: PDFDocument,
  configured: PdfBrandingLogo | null | undefined
): Promise<PDFImage> {
  if (configured) {
    try {
      return configured.format === "png"
        ? await pdf.embedPng(configured.bytes)
        : await pdf.embedJpg(configured.bytes);
    } catch {
      // The approved built-in mark keeps the statement renderable when an
      // operator-uploaded raster is corrupt or unsupported by pdf-lib.
    }
  }
  return pdf.embedPng(STRIPE_ANNUAL_LOGO_BYTES);
}

function drawAnnualCover(
  page: PDFPage,
  input: RenderStripeAnnualStatementPdfInput,
  logo: PDFImage,
  regular: PDFFont,
  bold: PDFFont,
  italic: PDFFont
): void {
  const left = 45.354;
  const right = 566.646;
  const preparedX = 316.426;
  const gray = rgb(0.32, 0.32, 0.32);
  const logoFit = Math.min(75 / logo.width, 30 / logo.height);
  page.drawImage(logo, {
    x: left,
    y: 716,
    width: logo.width * logoFit,
    height: logo.height * logoFit
  });
  drawRight(page, "Annual Giving Statement", right, 737, 15.5, bold);
  drawRight(page, `Statement No. AGS-${input.snapshot.year}-${input.snapshot.hash.slice(0, 8).toUpperCase()}`, right, 721, 8, regular, gray);
  drawRight(page, `Tax Year ${input.snapshot.year} · Generated ${formatAnnualLongDate(input.issuedOn, input.snapshot.document.timeZone)}`, right, 709, 8, regular, gray);
  if (input.corrected) {
    drawRight(page, "CORRECTED STATEMENT", right, 698, 8.5, bold, rgb(0.55, 0.13, 0.1));
  }
  page.drawLine({ start: { x: left, y: 695 }, end: { x: right, y: 695 }, thickness: 1.25, color: rgb(0.12, 0.12, 0.12) });

  drawPdfLabel(page, "FROM", left, 674, bold);
  drawPdfLabel(page, "PREPARED FOR", preparedX, 674, bold);
  drawWrappedText(page, input.snapshot.document.legalName, {
    x: left,
    y: 656,
    size: 12,
    lineHeight: 13.5,
    maxWidth: 220,
    font: bold
  });
  drawPdfTextLine(page, "A 501(c)(3) Public Charity", left, 638, 9.8, regular);
  drawPdfTextLine(page, `EIN ${input.snapshot.document.ein}`, left, 625, 9.8, regular);
  drawPdfTextLine(page, `${input.snapshot.document.email.supportEmail}  ·  ${input.snapshot.document.organizationContact.phone}`, left, 612, 9.3, regular, gray);
  drawPdfTextLine(page, input.snapshot.document.organizationContact.website, left, 599, 9.3, regular, gray);
  input.snapshot.document.organizationContact.mailingAddress.slice(0, 3).forEach((line, index) => {
    drawPdfTextLine(page, line, left, 586 - index * 13, 9.3, regular, gray);
  });

  drawWrappedText(page, input.snapshot.donor.name, {
    x: preparedX,
    y: 656,
    size: 12,
    lineHeight: 13.5,
    maxWidth: right - preparedX,
    font: bold
  });
  const donorContactLines = annualDonorContactLines(input.snapshot.donor);
  donorContactLines.slice(0, 4).forEach((line, index) => {
    drawPdfTextLine(page, line, preparedX, 638 - index * 13, 9.3, regular, gray);
  });
  drawAnnualRoundedRectangle(page, {
    x: preparedX,
    y: 522,
    width: right - preparedX,
    height: 79,
    radius: 4.5,
    borderColor: rgb(0.86, 0.87, 0.88),
    borderWidth: 0.7,
    color: rgb(0.975, 0.978, 0.982)
  });
  drawPdfLabel(page, "CONTRIBUTION PERIOD", preparedX + 10, 585, bold);
  drawPdfTextLine(page, annualPeriodLabel(input.snapshot.year), preparedX + 10, 570, 10, regular);
  drawPdfLabel(page, "TOTAL TAX-DEDUCTIBLE CONTRIBUTIONS", preparedX + 10, 555, bold);
  const summaryAmount = formatCents(input.snapshot.totals.netAmountCents);
  drawPdfTextLine(page, summaryAmount, 326.176, 535, 20, bold);
  drawPdfTextLine(
    page,
    "USD",
    326.176 + bold.widthOfTextAtSize(summaryAmount, 20) + 5,
    535,
    9,
    bold,
    gray
  );

  drawAnnualRoundedRectangle(page, {
    x: left,
    y: 366.184,
    width: right - left,
    height: 145.652,
    radius: 3.75,
    borderColor: rgb(0.82, 0.82, 0.82),
    borderWidth: 0.7,
    color: rgb(0.985, 0.985, 0.985)
  });
  page.drawLine({
    start: { x: left + 1.2, y: 367.5 },
    end: { x: left + 1.2, y: 509.5 },
    thickness: 2.4,
    color: rgb(0.1, 0.1, 0.1)
  });
  drawPdfTextLine(page, "Tax-Deductible Contribution Acknowledgment", left + 12.75, 493, 9.4, bold);
  const legalName = input.snapshot.document.legalName;
  drawWrappedText(page, `${legalName} is a tax-exempt organization as described in Section 501(c)(3) of the Internal Revenue Code (EIN ${input.snapshot.document.ein}). Contributions to ${legalName} are tax-deductible to the extent allowed by law.`, {
    x: left + 12.75,
    y: 477.8,
    size: 8,
    lineHeight: 13.05,
    maxWidth: right - left - 25.5,
    font: regular
  });
  drawWrappedText(page, `This letter is your contemporaneous written acknowledgment of the charitable contributions itemized below. During ${annualPeriodLabel(input.snapshot.year)}, you made cash contributions totaling ${formatCents(input.snapshot.totals.netAmountCents)} USD. No goods or services were provided to you in exchange for these contributions.`, {
    x: left + 12.75,
    y: 447.2,
    size: 8,
    lineHeight: 13.05,
    maxWidth: right - left - 25.5,
    font: regular
  });
  drawWrappedText(page, "Please retain this acknowledgment with your tax records. To claim a charitable deduction, the IRS requires that you obtain written acknowledgment of each contribution of $250 or more before the earlier of the date you file your federal income tax return for the year of the contribution or the due date (including extensions) of that return. This document does not constitute tax advice.", {
    x: left + 12.75,
    y: 403,
    size: 8,
    lineHeight: 11.85,
    maxWidth: right - left - 25.5,
    font: regular
  });

  drawWrappedText(page, "Le expresamos nuestro más sincero agradecimiento por su generoso apoyo a la Obra del Señor. Su aporte marca una gran diferencia en el alcance del evangelio y nos impulsa a seguir cumpliendo nuestra misión.", {
    x: left,
    y: 347.3,
    size: 9.2,
    lineHeight: 11.5,
    maxWidth: right - left,
    font: regular
  });
  drawWrappedText(page, "«Traigan íntegro el diezmo a la tesorería del Templo; así habrá alimento en mi casa. Pruébenme en esto —dice el Señor de los Ejércitos—, y vean si no abro las compuertas del cielo y derramo sobre ustedes bendición hasta que sobreabunde.»", {
    x: left + 13,
    y: 308,
    size: 8.6,
    lineHeight: 10.5,
    maxWidth: right - left - 26,
    font: italic
  });
  page.drawRectangle({
    x: left,
    y: 270.664,
    width: 1.5,
    height: 49.922,
    color: rgb(0.788, 0.8, 0.82)
  });
  drawPdfTextLine(page, "— Malaquías 3:10", left + 13, 278, 8.6, italic);

  drawPdfLabel(page, "CONTRIBUTIONS", left, 249, bold);
  drawWrappedText(page, "Amounts shown are net of refunds and other adjustments recorded for the period.", {
    x: left,
    y: 236,
    size: 7.4,
    lineHeight: 9,
    maxWidth: right - left,
    font: regular,
    color: gray
  });
}

function drawAnnualContributionTable(
  page: PDFPage,
  items: StripeAnnualStatementItem[],
  options: {
    topY: number;
    rowHeight: number;
    regular: PDFFont;
    bold: PDFFont;
    timeZone: string;
    total: StripeAnnualStatementSnapshot["totals"] | null;
  }
): void {
  const left = 45.354;
  const right = 566.646;
  const headerHeight = 22.578;
  const amountRight = 235.938;
  const sourceX = 250.945;
  const methodX = 407.332;
  const rule = rgb(0.78, 0.78, 0.78);
  const stripe = rgb(0.98822, 0.98822, 0.992157);
  const headerText = rgb(0.298, 0.337, 0.391);
  page.drawRectangle({
    x: left,
    y: options.topY - headerHeight,
    width: right - left,
    height: headerHeight,
    color: rgb(0.952927, 0.956848, 0.964691)
  });
  page.drawLine({ start: { x: left, y: options.topY }, end: { x: right, y: options.topY }, thickness: 0.7, color: rule });
  const headerBaseline = options.topY - 12.273;
  drawPdfTextLine(page, "DATE", left + 7.5, headerBaseline, 8, options.bold, headerText);
  drawPdfTextLine(page, "AMOUNT", 146.687, headerBaseline, 8, options.bold, headerText);
  drawPdfTextLine(page, "DONATION ID", sourceX, headerBaseline, 8, options.bold, headerText);
  drawPdfTextLine(page, "DONATION METHOD", methodX, headerBaseline, 8, options.bold, headerText);
  page.drawLine({ start: { x: left, y: options.topY - headerHeight }, end: { x: right, y: options.topY - headerHeight }, thickness: 0.7, color: rule });

  let rowTop = options.topY - headerHeight;
  items.forEach((item, index) => {
    const rowBottom = rowTop - options.rowHeight;
    if (index % 2 === 1) {
      page.drawRectangle({ x: left, y: rowBottom, width: right - left, height: options.rowHeight, color: stripe });
    }
    const baseline = rowBottom + options.rowHeight / 2 - 1.63;
    drawPdfTextLine(page, formatAnnualShortDate(item.settledAt, options.timeZone), left + 7.5, baseline, 9, options.regular);
    drawRight(page, formatCents(item.netAmountCents), amountRight, baseline, 9, options.regular);
    drawPdfTextLine(page, fitPdfText(item.sourceId, options.regular, 9, methodX - sourceX - 12), sourceX, baseline, 9, options.regular);
    drawPdfTextLine(page, "Stripe", methodX, baseline, 9, options.regular);
    page.drawLine({ start: { x: left, y: rowBottom }, end: { x: right, y: rowBottom }, thickness: 0.35, color: rgb(0.86, 0.86, 0.86) });
    rowTop = rowBottom;
  });

  if (options.total) {
    const totalHeight = 36.223;
    page.drawRectangle({
      x: left,
      y: rowTop - totalHeight,
      width: right - left,
      height: totalHeight,
      color: rgb(0.965, 0.965, 0.965)
    });
    page.drawLine({
      start: { x: left, y: rowTop },
      end: { x: right, y: rowTop },
      thickness: 1.4,
      color: rgb(0.1, 0.1, 0.1)
    });
    drawPdfTextLine(page, `TOTAL — ${options.total.count}`, left + 7.5, rowTop - 17.32, 9.9, options.bold);
    drawPdfTextLine(
      page,
      options.total.count === 1 ? "CONTRIBUTION" : "CONTRIBUTIONS",
      left + 7.5,
      rowTop - 29.62,
      9.9,
      options.bold
    );
    drawRight(page, `${formatCents(options.total.netAmountCents)} USD`, amountRight, rowTop - 22.38, 9, options.bold);
    page.drawLine({ start: { x: left, y: rowTop - totalHeight }, end: { x: right, y: rowTop - totalHeight }, thickness: 0.7, color: rule });
  }
}

function drawAnnualFooter(
  page: PDFPage,
  input: RenderStripeAnnualStatementPdfInput,
  pageNumber: number,
  pageCount: number,
  regular: PDFFont
): void {
  const left = 45.354;
  const right = 566.646;
  page.drawLine({ start: { x: left, y: 37.5 }, end: { x: right, y: 37.5 }, thickness: 0.6, color: rgb(0.75, 0.75, 0.75) });
  const identity = `${input.snapshot.document.email.organizationName} · A 501(c)(3) Public Charity · EIN ${input.snapshot.document.ein}`;
  drawPdfTextLine(page, fitPdfText(identity, regular, 7.5, 430), left, 24.5, 7.5, regular, rgb(0.604, 0.627, 0.651));
  drawRight(page, `Page ${pageNumber} of ${pageCount}`, right, 24.5, 7.5, regular, rgb(0.604, 0.627, 0.651));
}

function drawPdfLabel(page: PDFPage, text: string, x: number, y: number, font: PDFFont): void {
  drawPdfTextLine(page, text, x, y, 8.2, font, rgb(0.627, 0.649, 0.671));
}

function drawPdfTextLine(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  size: number,
  font: PDFFont,
  color = rgb(0, 0, 0)
): void {
  page.drawText(pdfSafeText(text, font), { x, y, size, font, color });
}

function annualPeriodLabel(year: number): string {
  return `January 1, ${year} – December 31, ${year}`;
}

function drawAnnualRoundedRectangle(
  page: PDFPage,
  options: {
    x: number;
    y: number;
    width: number;
    height: number;
    radius: number;
    color: ReturnType<typeof rgb>;
    borderColor: ReturnType<typeof rgb>;
    borderWidth: number;
  }
): void {
  const { x, y, width, height, radius, color, borderColor, borderWidth } = options;
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
    color,
    borderColor,
    borderWidth
  });
}

function formatAnnualLongDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone }).format(new Date(iso));
}

function formatAnnualShortDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "2-digit", day: "2-digit", year: "numeric", timeZone }).format(new Date(iso));
}

function fitPdfText(text: string, font: PDFFont, size: number, maxWidth: number): string {
  const safe = pdfSafeText(text, font);
  if (font.widthOfTextAtSize(safe, size) <= maxWidth) return safe;
  let fitted = safe;
  while (fitted && font.widthOfTextAtSize(`${fitted}...`, size) > maxWidth) fitted = fitted.slice(0, -1);
  return `${fitted}...`;
}

function drawWrappedText(
  page: PDFPage,
  text: string,
  options: {
    x: number;
    y: number;
    size: number;
    lineHeight: number;
    maxWidth: number;
    font: PDFFont;
    color?: ReturnType<typeof rgb>;
  }
): number {
  const lines = wrapPdfText(text, options.font, options.size, options.maxWidth);
  lines.forEach((line, index) => page.drawText(line, {
    x: options.x,
    y: options.y - index * options.lineHeight,
    size: options.size,
    font: options.font,
    color: options.color
  }));
  return options.y - lines.length * options.lineHeight;
}

function wrapPdfText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const safe = pdfSafeText(text, font).trim();
  if (!safe) return [""];
  const lines: string[] = [];
  let current = "";
  const pushToken = (token: string) => {
    for (const character of Array.from(token)) {
      const candidate = current + character;
      if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
        lines.push(current);
        current = character;
      } else {
        current = candidate;
      }
    }
  };
  for (const word of safe.split(/\s+/u)) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = "";
    }
    if (font.widthOfTextAtSize(word, size) <= maxWidth) current = word;
    else pushToken(word);
  }
  if (current) lines.push(current);
  return lines;
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
  const safeText = pdfSafeText(text, font);
  page.drawText(safeText, { x: right - font.widthOfTextAtSize(safeText, size), y, size, font, color });
}

function annualDonorContactLines(
  donor: StripeAnnualStatementSnapshot["donor"]
): string[] {
  const lines: string[] = [];
  if (donor.address?.line1) lines.push(donor.address.line1);
  if (donor.address?.line2) lines.push(donor.address.line2);
  if (donor.address) {
    const locality = [
      [donor.address.city, donor.address.state].filter(Boolean).join(", "),
      donor.address.postalCode
    ].filter(Boolean).join(" ");
    const country = donor.address.country === "US"
      ? "United States"
      : donor.address.country;
    const localityCountry = [locality, country].filter(Boolean).join(", ");
    if (localityCountry) lines.push(localityCountry);
  }
  if (donor.phone) lines.push(donor.phone);
  if (lines.length === 0 && donor.email) lines.push(donor.email);
  return lines;
}

function parseStripeDonorAddress(value: string | null): StripeDonorAddress | null {
  if (!value) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("Stripe annual statement donor address evidence is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Stripe annual statement donor address evidence is invalid");
  }
  const record = parsed as Record<string, unknown>;
  const field = (name: string, maxLength: number): string | null => {
    const candidate = record[name];
    if (candidate == null) return null;
    if (typeof candidate !== "string") {
      throw new Error("Stripe annual statement donor address evidence is invalid");
    }
    const normalized = candidate.trim().replace(/\s+/gu, " ");
    if (!normalized) return null;
    if (normalized.length > maxLength) {
      throw new Error("Stripe annual statement donor address evidence is invalid");
    }
    return normalized;
  };
  const address: StripeDonorAddress = {
    line1: field("line1", 200),
    line2: field("line2", 200),
    city: field("city", 100),
    state: field("state", 100),
    postalCode: field("postalCode", 32),
    country: field("country", 2)?.toUpperCase() ?? null
  };
  return Object.values(address).some(Boolean) ? address : null;
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
