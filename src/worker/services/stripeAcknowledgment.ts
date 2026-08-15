import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatCents } from "../../shared/money";
import type { Repository, StripeGiftFrequency, StripeGiftType } from "../storage/repository";
import type { Env } from "../types";
import { sha256Hex, utf8Bytes } from "../utils/encoding";
import { isRecord } from "../utils/guards";
import { newId } from "../utils/ids";
import { sendOperationalAlert } from "./alerts";
import { loadEmailBranding } from "./branding";
import { classifyEmailDispatchError, EmailService } from "./email";
import {
  editableDonorEmailHtml,
  type BrandingEmailOptions
} from "./emailHtml";
import {
  DEFAULT_EMAIL_TEMPLATES,
  EMAIL_TEMPLATES_SETTING_KEY,
  parseEmailTemplates,
  renderEmailTemplateValue,
  type EmailTemplateValue
} from "./emailTemplates";
import { resolveStripeConfiguration } from "./stripeDonations";
import { stripeUsTimeZone } from "./stripeAnnualStatement";
import { logWorkerError } from "./observability";
import { pdfSafeText } from "./pdf";
import { STRIPE_RECEIPT_ELIM_LOGO_BYTES } from "./stripePdfAssets";
import { stripePaymentMethodLabel } from "./stripePaymentMethod";

export const STRIPE_ACKNOWLEDGMENT_PDF_VERSION = "stripe-acknowledgment-pdf:v6" as const;
const LEGACY_STRIPE_ACKNOWLEDGMENT_PDF_VERSION_V5 = "stripe-acknowledgment-pdf:v5" as const;
const LEGACY_STRIPE_ACKNOWLEDGMENT_PDF_VERSION_V4 = "stripe-acknowledgment-pdf:v4" as const;
const LEGACY_STRIPE_ACKNOWLEDGMENT_PDF_VERSION_V3 = "stripe-acknowledgment-pdf:v3" as const;
const LEGACY_STRIPE_ACKNOWLEDGMENT_PDF_VERSION_V2 = "stripe-acknowledgment-pdf:v2" as const;
const LEGACY_STRIPE_ACKNOWLEDGMENT_PDF_VERSION_V1 = "stripe-acknowledgment-pdf:v1" as const;

export interface StripeAcknowledgmentContentInput {
  donorName: string | null;
  amountCents: number;
  frequency: StripeGiftFrequency;
  giftType: StripeGiftType;
  settledAt: string;
  timeZone: string;
  legalName: string;
  ein: string;
  branding: BrandingEmailOptions;
  kind?: "ORIGINAL" | "PARTIAL_REFUND" | "FULL_REFUND";
  refundedAmountCents?: number;
  template?: EmailTemplateValue;
}

export function stripeAcknowledgmentContent(
  input: StripeAcknowledgmentContentInput
): { subject: string; text: string; html: string } {
  const donorName = input.donorName?.trim() || "Donante";
  const amountLabel = `${formatCents(input.amountCents)} USD`;
  const refundedAmountCents = input.refundedAmountCents ?? 0;
  const refundedAmountLabel = `${formatCents(refundedAmountCents)} USD`;
  const netAmountLabel = `${formatCents(Math.max(0, input.amountCents - refundedAmountCents))} USD`;
  const kind = input.kind ?? "ORIGINAL";
  const settledDateLabel = new Intl.DateTimeFormat("es-US", {
    dateStyle: "long",
    timeZone: input.timeZone
  }).format(new Date(input.settledAt));
  const frequencyLabel = input.frequency === "MONTHLY" ? "Mensual" : "Única";
  const giftTypeLabel = input.giftType === "TITHE"
    ? "Diezmo"
    : input.giftType === "OFFERING"
      ? "Ofrenda"
      : "No especificado";
  const correctionText = kind === "PARTIAL_REFUND"
    ? `Esta constancia corregida reemplaza la versión anterior para esta donación.\n` +
      `Monto original: ${amountLabel}\n` +
      `Reembolso acumulado: ${refundedAmountLabel}\n` +
      `Monto neto reconocido: ${netAmountLabel}\n\n`
    : kind === "FULL_REFUND"
      ? `Se registró un reembolso total de ${refundedAmountLabel}. ` +
        `La constancia anterior queda revocada y el monto neto reconocido es ${netAmountLabel}.\n\n`
      : "";
  const typeLabel = kind === "PARTIAL_REFUND"
    ? "Constancia corregida"
    : kind === "FULL_REFUND"
      ? "Constancia revocada"
      : "Constancia";
  const template = input.template ?? (kind === "ORIGINAL"
    ? DEFAULT_EMAIL_TEMPLATES.stripeAcknowledgment
    : DEFAULT_EMAIL_TEMPLATES.stripeRefund);
  const rendered = renderEmailTemplateValue(template, {
    "{{donante}}": donorName,
    "{{monto}}": amountLabel,
    "{{montoOriginal}}": amountLabel,
    "{{montoReembolsado}}": refundedAmountLabel,
    "{{montoNeto}}": netAmountLabel,
    "{{detalleReembolso}}": correctionText.trim(),
    "{{tipoConstancia}}": typeLabel,
    "{{fecha}}": settledDateLabel,
    "{{tipoEntrega}}": giftTypeLabel,
    "{{frecuencia}}": frequencyLabel,
    "{{nombreLegal}}": input.legalName,
    "{{ein}}": input.ein
  });
  return {
    subject: rendered.subject,
    text: rendered.text,
    html: editableDonorEmailHtml({
      organizationName: input.branding.organizationName,
      title: rendered.subject,
      bodyText: rendered.formattedText,
      brandColor: input.branding.brandColor,
      supportEmail: input.branding.supportEmail,
      logoUrl: input.branding.logoUrl
    })
  };
}

export interface RenderStripeAcknowledgmentPdfInput {
  donorName: string | null;
  amountCents: number;
  refundedAmountCents: number;
  frequency: StripeGiftFrequency;
  giftType: StripeGiftType;
  sourceId: string;
  paymentMethod?: string;
  settledAt: string;
  timeZone: string;
  legalName: string;
  ein: string;
  organizationName: string;
  supportEmail: string;
  organizationPhone: string;
  organizationWebsite: string;
  organizationMailingAddress: string[];
  signerName: string;
  signerTitle: string;
  kind: "ORIGINAL" | "PARTIAL_REFUND" | "FULL_REFUND";
}

export async function renderStripeAcknowledgmentPdf(
  input: RenderStripeAcknowledgmentPdfInput
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const italic = await pdf.embedFont(StandardFonts.HelveticaOblique);
  const logo = await pdf.embedPng(STRIPE_RECEIPT_ELIM_LOGO_BYTES);
  const contentX = 113.22;
  const contentWidth = 385.56;
  const muted = rgb(0.28, 0.28, 0.28);

  page.drawImage(logo, { x: 201, y: 684, width: 210, height: 84 });

  drawPdfText(page, `Dear ${input.donorName?.trim() || "Donor"},`, {
    x: contentX,
    y: 635,
    size: 11.25,
    font: regular
  });

  const originalAmount = `${formatCents(input.amountCents)} USD`;
  const refundedAmount = `${formatCents(input.refundedAmountCents)} USD`;
  const netAmountCents = Math.max(0, input.amountCents - input.refundedAmountCents);
  const netAmount = `${formatCents(netAmountCents)} USD`;
  const receivedDate = formatEnglishDate(input.settledAt, input.timeZone);
  const contributionParagraph = input.kind === "ORIGINAL"
    ? `Thank you for your cash contribution of ${originalAmount} that ${input.legalName} received on ${receivedDate}. No goods or services were provided in exchange for your contribution. God bless you.`
    : input.kind === "PARTIAL_REFUND"
      ? `This corrected receipt replaces the prior acknowledgment for your ${originalAmount} cash contribution received on ${receivedDate}. A cumulative refund of ${refundedAmount} leaves a net charitable contribution of ${netAmount}. No goods or services were provided in exchange for your contribution.`
      : `This receipt revokes the prior acknowledgment for your ${originalAmount} cash contribution received on ${receivedDate}. A full refund of ${refundedAmount} leaves a net charitable contribution of ${netAmount}.`;
  const contributionBottom = drawPdfWrapped(page, contributionParagraph, {
    x: contentX,
    y: 604,
    size: 10.5,
    lineHeight: 14,
    maxWidth: contentWidth,
    font: regular
  });

  let signatureY = Math.min(535.5, contributionBottom - 4);
  const signatureTypography = fitReceiptSignatureTypography(
    [
      { text: input.signerName, font: bold },
      { text: `${input.signerTitle.replace(/[.]$/u, "")}.`, font: regular },
      { text: input.legalName, font: regular }
    ],
    signatureY,
    442.5 + bold.heightAtSize(12.5) + 2,
    contentWidth
  );
  signatureY = drawPdfWrapped(page, input.signerName, {
    x: contentX,
    y: signatureY,
    size: signatureTypography.size,
    lineHeight: signatureTypography.lineHeight,
    maxWidth: contentWidth,
    font: bold
  });
  signatureY = drawPdfWrapped(page, `${input.signerTitle.replace(/[.]$/u, "")}.`, {
    x: contentX,
    y: signatureY,
    size: signatureTypography.size,
    lineHeight: signatureTypography.lineHeight,
    maxWidth: contentWidth,
    font: regular
  });
  drawPdfWrapped(page, input.legalName, {
    x: contentX,
    y: signatureY,
    size: signatureTypography.size,
    lineHeight: signatureTypography.lineHeight,
    maxWidth: contentWidth,
    font: regular
  });

  drawPdfText(page, "Receipt of Charitable Donation:", {
    x: contentX,
    y: 442.5,
    size: 12.5,
    font: bold
  });
  const giftType = input.giftType === "TITHE"
    ? "Tithe"
    : input.giftType === "OFFERING"
      ? "Offering"
      : "Donation";
  const status = input.kind === "ORIGINAL"
    ? "Completed"
    : input.kind === "PARTIAL_REFUND"
      ? "Corrected"
      : "Revoked";
  const facts = [
    ["DONATION NAME:", `${giftType} · ${input.frequency === "MONTHLY" ? "Monthly" : "One-time"}`],
    ["DONATION AMOUNT:", input.kind === "ORIGINAL" ? originalAmount : netAmount],
    ["PAYMENT METHOD:", input.paymentMethod ?? "Stripe"],
    ["DONATION STATUS:", status === "Completed" ? "Completado" : status],
    ["DONATION DATE:", formatEnglishYear(input.settledAt, input.timeZone)],
    ["PAYMENT ID:", input.sourceId]
  ] as const;
  facts.forEach(([label, value], index) => {
    const y = 417.5 - index * 14.4;
    drawPdfText(page, label, { x: contentX, y, size: 10, font: bold });
    drawPdfText(page, value, {
      x: contentX + bold.widthOfTextAtSize(`${label} `, 10) + 2,
      y,
      size: 10,
      font: regular
    });
  });

  const contactLeft = 45;
  const contactRight = 567;
  const contactWidth = contactRight - contactLeft;
  const contactLines = [
    [input.supportEmail, input.organizationPhone].filter(Boolean).join(" • "),
    input.organizationMailingAddress.join(" ")
  ].filter(Boolean);
  const contactTypography = fitReceiptContactTypography(
    contactLines,
    bold,
    contactWidth
  );
  const contactTop = 232 + bold.heightAtSize(contactTypography.size);
  const legalTypography = fitReceiptLegalTypography(
    input.legalName,
    bold,
    italic,
    contactTop,
    171
  );
  drawPdfWrapped(page, input.legalName, {
    x: contentX,
    y: 294.1,
    size: legalTypography.size,
    lineHeight: legalTypography.lineHeight,
    maxWidth: 171,
    font: bold
  });
  drawPdfText(page, "A 501(c)(3) Public Charity", {
    x: contentX,
    y: legalTypography.charityY,
    size: 10,
    font: italic
  });
  drawPdfText(page, `EIN ${input.ein}`, {
    x: contentX,
    y: legalTypography.einY,
    size: 10,
    font: bold
  });

  const spanishLegalText =
    `La Fundación ${input.legalName} es una organización sin fines de lucro 501(c)(3), incorporada en Washington, D.C., que apoya la labor de ${input.organizationName} en El Salvador en su misión de difusión y servicio del evangelio.`;
  const spanishLegalTypography = fitReceiptWrappedTypography(
    spanishLegalText,
    regular,
    203.1,
    297.8,
    contactTop + 1.5,
    { size: 9.2, lineHeight: 12 }
  );
  drawPdfWrapped(
    page,
    spanishLegalText,
    {
      x: 292.1,
      y: 297.8,
      size: spanishLegalTypography.size,
      lineHeight: spanishLegalTypography.lineHeight,
      maxWidth: 203.1,
      font: regular
    }
  );

  let contactY = 232;
  for (const line of contactLines) {
    contactY = drawPdfWrappedCentered(page, line, {
      left: contactLeft,
      right: contactRight,
      y: contactY,
      size: contactTypography.size,
      lineHeight: contactTypography.lineHeight,
      maxWidth: contactWidth,
      font: bold
    });
  }

  page.drawRectangle({ x: 0, y: 0, width: 612, height: 169, color: rgb(0.93, 0.93, 0.93) });
  const scripture = [
    "Traigan íntegro el diezmo a la tesorería del Templo; así habrá alimento en mi casa.",
    "Pruébenme en esto —dice el Señor de los Ejércitos—, y vean si no abro las",
    "compuertas del cielo y derramo sobre ustedes bendición hasta que sobreabunde."
  ];
  scripture.forEach((line, index) => {
    drawPdfCentered(page, line, 108 - index * 15, 9.2, italic, 95, 517, muted);
  });
  drawPdfCentered(page, "— Malaquías 3:10", 60, 9.2, italic, 95, 517, muted);

  pdf.setTitle(`Receipt of Charitable Donation ${input.sourceId}`);
  pdf.setAuthor(input.legalName);
  pdf.setProducer(STRIPE_ACKNOWLEDGMENT_PDF_VERSION);
  return pdf.save();
}

function drawPdfText(
  page: PDFPage,
  text: string,
  options: { x: number; y: number; size: number; font: PDFFont; color?: ReturnType<typeof rgb> }
): void {
  page.drawText(pdfSafeText(text, options.font), options);
}

function drawPdfWrapped(
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
  const lines = wrapStripePdfText(text, options.font, options.size, options.maxWidth);
  lines.forEach((line, index) => drawPdfText(page, line, {
    x: options.x,
    y: options.y - index * options.lineHeight,
    size: options.size,
    font: options.font,
    color: options.color
  }));
  return options.y - lines.length * options.lineHeight;
}

function drawPdfCentered(
  page: PDFPage,
  text: string,
  y: number,
  size: number,
  font: PDFFont,
  left: number,
  right: number,
  color = rgb(0, 0, 0)
): void {
  const safe = pdfSafeText(text, font);
  const width = right - left;
  page.drawText(safe, {
    x: left + (width - font.widthOfTextAtSize(safe, size)) / 2,
    y,
    size,
    font,
    color
  });
}

function drawPdfWrappedCentered(
  page: PDFPage,
  text: string,
  options: {
    left: number;
    right: number;
    y: number;
    size: number;
    lineHeight: number;
    maxWidth: number;
    font: PDFFont;
  }
): number {
  const lines = wrapStripePdfText(text, options.font, options.size, options.maxWidth);
  lines.forEach((line, index) => drawPdfCentered(
    page,
    line,
    options.y - index * options.lineHeight,
    options.size,
    options.font,
    options.left,
    options.right
  ));
  return options.y - lines.length * options.lineHeight;
}

function wrapStripePdfText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const safe = pdfSafeText(text, font).trim();
  if (!safe) return [""];
  const lines: string[] = [];
  let current = "";
  const pushLongToken = (token: string) => {
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
    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      if (current) lines.push(current);
      current = word;
    } else {
      if (current) current += " ";
      pushLongToken(word);
    }
  }
  if (current) lines.push(current);
  return lines;
}

function fitReceiptSignatureTypography(
  lines: Array<{ text: string; font: PDFFont }>,
  startY: number,
  minimumBaseline: number,
  maxWidth: number
): { size: number; lineHeight: number } {
  for (let size = 10; size >= 3.6; size -= 0.2) {
    const lineHeight = size + 2;
    const lineCount = lines.reduce(
      (count, line) => count + wrapStripePdfText(line.text, line.font, size, maxWidth).length,
      0
    );
    if (startY - (lineCount - 1) * lineHeight >= minimumBaseline) {
      return { size, lineHeight };
    }
  }
  throw new Error("Stripe acknowledgment signature does not fit its reserved band");
}

function fitReceiptLegalTypography(
  legalName: string,
  legalFont: PDFFont,
  charityFont: PDFFont,
  contactTop: number,
  maxWidth: number
): { size: number; lineHeight: number; charityY: number; einY: number } {
  const startY = 294.1;
  for (let size = 10; size >= 3.6; size -= 0.2) {
    const lineHeight = size + 2;
    const lineCount = wrapStripePdfText(legalName, legalFont, size, maxWidth).length;
    const finalLegalBaseline = startY - (lineCount - 1) * lineHeight;
    const charityY = Math.min(275, finalLegalBaseline - charityFont.heightAtSize(10) - 2);
    const einY = Math.min(254.7, charityY - legalFont.heightAtSize(10) - 2);
    if (einY >= contactTop + 1.5) return { size, lineHeight, charityY, einY };
  }
  throw new Error("Stripe acknowledgment legal identity does not fit its reserved band");
}

function fitReceiptWrappedTypography(
  text: string,
  font: PDFFont,
  maxWidth: number,
  startY: number,
  minimumBaseline: number,
  preferred: { size: number; lineHeight: number }
): { size: number; lineHeight: number } {
  const lineHeightOffset = preferred.lineHeight - preferred.size;
  for (let size = preferred.size; size >= 3.6; size -= 0.2) {
    const lineHeight = size + lineHeightOffset;
    const lineCount = wrapStripePdfText(text, font, size, maxWidth).length;
    if (startY - (lineCount - 1) * lineHeight >= minimumBaseline) {
      return { size, lineHeight };
    }
  }
  throw new Error("Stripe acknowledgment text does not fit its reserved band");
}

function fitReceiptContactTypography(
  lines: string[],
  font: PDFFont,
  maxWidth: number
): { size: number; lineHeight: number } {
  const availableBaselineDrop = 232 - 177;
  for (let size = 7.2; size >= 3.6; size -= 0.2) {
    const lineHeight = size + 0.5;
    const lineCount = lines.reduce(
      (count, line) => count + wrapStripePdfText(line, font, size, maxWidth).length,
      0
    );
    if ((lineCount - 1) * lineHeight <= availableBaselineDrop) {
      return { size, lineHeight };
    }
  }
  return { size: 3.6, lineHeight: 4.1 };
}

function formatEnglishDate(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone }).format(new Date(iso));
}

function formatEnglishYear(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", timeZone }).format(new Date(iso));
}

interface StripeAcknowledgmentEvidenceV1 {
  version: 1;
  deliveryId: string;
  giftId: string;
  revision: number;
  kind: "ORIGINAL" | "PARTIAL_REFUND" | "FULL_REFUND";
  refundedAmountCents: number;
  recipientEmail: string | null;
  legalName: string;
  ein: string;
  timeZone: string;
  branding: Awaited<ReturnType<typeof loadEmailBranding>>;
  content: { subject: string; text: string; html: string };
  pdf?: StripeAcknowledgmentPdfEvidence;
}

type StripeAcknowledgmentPdfEvidence = Omit<
  RenderStripeAcknowledgmentPdfInput,
  "organizationPhone" | "organizationWebsite" | "organizationMailingAddress" | "signerName" | "signerTitle"
> & {
  rendererVersion:
    | typeof STRIPE_ACKNOWLEDGMENT_PDF_VERSION
    | typeof LEGACY_STRIPE_ACKNOWLEDGMENT_PDF_VERSION_V5
    | typeof LEGACY_STRIPE_ACKNOWLEDGMENT_PDF_VERSION_V4
    | typeof LEGACY_STRIPE_ACKNOWLEDGMENT_PDF_VERSION_V3
    | typeof LEGACY_STRIPE_ACKNOWLEDGMENT_PDF_VERSION_V2
    | typeof LEGACY_STRIPE_ACKNOWLEDGMENT_PDF_VERSION_V1;
  organizationPhone?: string;
  organizationWebsite?: string;
  organizationMailingAddress?: string[];
  signerName?: string;
  signerTitle?: string;
};

export async function snapshotStripeAcknowledgmentEvidence(
  env: Env,
  repo: Repository,
  deliveryId: string,
  now = new Date().toISOString()
): Promise<StripeAcknowledgmentEvidenceV1> {
  let source = await repo.getStripeAcknowledgmentEvidenceSource(deliveryId);
  if (!source) throw new Error("Stripe acknowledgment evidence source is missing");
  if (source.snapshot_json && source.snapshot_hash) {
    return parseStripeAcknowledgmentEvidence(source.snapshot_json, source.snapshot_hash);
  }
  const configuration = resolveStripeConfiguration(env);
  const branding = await loadEmailBranding(repo, env);
  const templates = parseEmailTemplates(await repo.getSetting(EMAIL_TEMPLATES_SETTING_KEY));
  const timeZone = stripeUsTimeZone(env);
  const content = stripeAcknowledgmentContent({
    donorName: source.donor_name,
    amountCents: source.amount_cents,
    frequency: source.frequency,
    giftType: source.gift_type,
    settledAt: source.settled_at,
    timeZone,
    legalName: configuration.legalName,
    ein: configuration.ein,
    branding,
    kind: source.kind,
    refundedAmountCents: source.evidence_refunded_amount_cents,
    template: source.kind === "ORIGINAL"
      ? templates.stripeAcknowledgment
      : templates.stripeRefund
  });
  const evidence: StripeAcknowledgmentEvidenceV1 = {
    version: 1,
    deliveryId: source.id,
    giftId: source.gift_id,
    revision: source.revision,
    kind: source.kind,
    refundedAmountCents: source.evidence_refunded_amount_cents,
    recipientEmail: source.donor_email,
    legalName: configuration.legalName,
    ein: configuration.ein,
    timeZone,
    branding,
    content,
    pdf: {
      rendererVersion: STRIPE_ACKNOWLEDGMENT_PDF_VERSION,
      donorName: source.donor_name,
      amountCents: source.amount_cents,
      refundedAmountCents: source.evidence_refunded_amount_cents,
      frequency: source.frequency,
      giftType: source.gift_type,
      sourceId: source.source_id,
      paymentMethod: stripePaymentMethodLabel(
        source.payment_method_type,
        source.payment_method_wallet
      ),
      settledAt: source.settled_at,
      timeZone,
      legalName: configuration.legalName,
      ein: configuration.ein,
      organizationName: branding.organizationName,
      supportEmail: branding.supportEmail,
      organizationPhone: configuration.organizationPhone,
      organizationWebsite: configuration.organizationWebsite,
      organizationMailingAddress: configuration.organizationMailingAddress,
      signerName: configuration.signerName,
      signerTitle: configuration.signerTitle,
      kind: source.kind
    }
  };
  const snapshotJson = JSON.stringify(evidence);
  const snapshotHash = await sha256Hex(utf8Bytes(snapshotJson));
  await repo.saveStripeAcknowledgmentSnapshot({
    id: source.id,
    snapshotHash,
    snapshotJson,
    now
  });
  source = await repo.getStripeAcknowledgmentEvidenceSource(deliveryId);
  if (!source?.snapshot_json || !source.snapshot_hash) {
    throw new Error("Stripe acknowledgment evidence snapshot was not persisted");
  }
  return parseStripeAcknowledgmentEvidence(source.snapshot_json, source.snapshot_hash);
}

async function parseStripeAcknowledgmentEvidence(
  snapshotJson: string,
  snapshotHash: string
): Promise<StripeAcknowledgmentEvidenceV1> {
  if (await sha256Hex(utf8Bytes(snapshotJson)) !== snapshotHash) {
    throw new Error("Stripe acknowledgment evidence hash mismatch");
  }
  const parsed: unknown = JSON.parse(snapshotJson);
  if (
    !isRecord(parsed)
    || parsed.version !== 1
    || typeof parsed.deliveryId !== "string"
    || typeof parsed.giftId !== "string"
    || typeof parsed.revision !== "number"
    || !["ORIGINAL", "PARTIAL_REFUND", "FULL_REFUND"].includes(String(parsed.kind))
    || (parsed.recipientEmail !== null && typeof parsed.recipientEmail !== "string")
    || !isRecord(parsed.branding)
    || !isRecord(parsed.content)
    || typeof parsed.content.subject !== "string"
    || typeof parsed.content.text !== "string"
    || typeof parsed.content.html !== "string"
    || (parsed.pdf !== undefined && !validStripeAcknowledgmentPdfEvidence(parsed.pdf))
  ) {
    throw new Error("Stripe acknowledgment evidence snapshot is invalid");
  }
  return parsed as unknown as StripeAcknowledgmentEvidenceV1;
}

export async function deliverNextStripeAcknowledgment(
  env: Env,
  repo: Repository,
  options: { now?: string } = {}
): Promise<
  | { processed: false }
  | { processed: true; outcome: "SENT" | "FAILED" | "REVIEW"; giftId: string }
> {
  const now = options.now ?? new Date().toISOString();
  const claimId = newId("stripe_ack_claim");
  const claim = await repo.claimNextStripeAcknowledgment({ claimId, now });
  if (!claim) {
    return { processed: false };
  }
  let evidence: StripeAcknowledgmentEvidenceV1;
  try {
    evidence = await snapshotStripeAcknowledgmentEvidence(env, repo, claim.id, now);
  } catch (error) {
    await repo.finalizeStripeAcknowledgment({
      id: claim.id,
      claimId,
      outcome: "REVIEW",
      failureCode: "evidence_snapshot_invalid",
      retrySafe: false,
      now
    });
    logWorkerError(env, "stripe_acknowledgment_evidence_failed", error);
    await auditAcknowledgmentBestEffort(env, repo, claim.id, "REVIEW", "evidence_snapshot_invalid");
    return { processed: true, outcome: "REVIEW", giftId: claim.gift_id };
  }
  if (!evidence.recipientEmail) {
    await repo.finalizeStripeAcknowledgment({
      id: claim.id,
      claimId,
      outcome: "REVIEW",
      failureCode: "recipient_missing",
      retrySafe: false,
      now
    });
    await auditAcknowledgmentBestEffort(env, repo, claim.id, "REVIEW", "recipient_missing");
    return { processed: true, outcome: "REVIEW", giftId: claim.gift_id };
  }

  let providerDispatchStarted = false;
  try {
    const pdfInput = completeStripeAcknowledgmentPdfInput(evidence.pdf ?? {
      rendererVersion: LEGACY_STRIPE_ACKNOWLEDGMENT_PDF_VERSION_V1,
      donorName: claim.donor_name,
      amountCents: claim.amount_cents,
      refundedAmountCents: evidence.refundedAmountCents,
      frequency: claim.frequency,
      giftType: claim.gift_type,
      sourceId: claim.source_id,
      settledAt: claim.settled_at,
      timeZone: evidence.timeZone,
      legalName: evidence.legalName,
      ein: evidence.ein,
      organizationName: evidence.branding.organizationName,
      supportEmail: evidence.branding.supportEmail,
      kind: evidence.kind
    });
    const pdfBytes = await renderStripeAcknowledgmentPdf(pdfInput);
    const result = await new EmailService(env, undefined, evidence.branding).sendStripeAcknowledgment({
      toEmail: evidence.recipientEmail,
      subject: evidence.content.subject,
      text: evidence.content.text,
      html: evidence.content.html,
      pdfBytes,
      filename: `constancia-donacion-eeuu-${claim.id}-r${evidence.revision}.pdf`,
      idempotencyKey: `stripe-acknowledgment:${claim.id}`
    }, async () => {
      providerDispatchStarted = await repo.markStripeAcknowledgmentDispatchStarted({
        id: claim.id,
        claimId,
        now
      });
      if (!providerDispatchStarted) {
        throw new Error("Stripe acknowledgment dispatch claim was lost");
      }
    });
    if (!result.providerDeliveryId) {
      throw new Error("Stripe acknowledgment provider acceptance was unconfirmed");
    }
    if (!await repo.finalizeStripeAcknowledgment({
      id: claim.id,
      claimId,
      outcome: "SENT",
      providerIdHash: result.providerDeliveryId,
      failureCode: null,
      retrySafe: false,
      now
    })) {
      throw new Error("Stripe acknowledgment finalization claim was lost");
    }
    await auditAcknowledgmentBestEffort(env, repo, claim.id, "SENT", null);
    return { processed: true, outcome: "SENT", giftId: claim.gift_id };
  } catch (error) {
    const classified = classifyEmailDispatchError(error, providerDispatchStarted);
    const retryExhausted = classified.outcomeClass !== "UNKNOWN"
      && classified.retrySafe
      && claim.attempt_count >= 5;
    const outcome = classified.outcomeClass === "UNKNOWN" || retryExhausted ? "REVIEW" : "FAILED";
    await repo.finalizeStripeAcknowledgment({
      id: claim.id,
      claimId,
      outcome,
      failureCode: retryExhausted ? "acknowledgment_retry_exhausted" : classified.code,
      retrySafe: outcome === "FAILED" && classified.retrySafe,
      retryAt: outcome === "FAILED" && classified.retrySafe
        ? stripeAcknowledgmentRetryAt(now, claim.attempt_count)
        : null,
      now
    });
    await auditAcknowledgmentBestEffort(
      env,
      repo,
      claim.id,
      outcome,
      retryExhausted ? "acknowledgment_retry_exhausted" : classified.code
    );
    return { processed: true, outcome, giftId: claim.gift_id };
  }
}

function validStripeAcknowledgmentPdfEvidence(value: unknown): value is StripeAcknowledgmentPdfEvidence {
  if (!isRecord(value)) return false;
  return (value.rendererVersion === STRIPE_ACKNOWLEDGMENT_PDF_VERSION
      || value.rendererVersion === LEGACY_STRIPE_ACKNOWLEDGMENT_PDF_VERSION_V5
      || value.rendererVersion === LEGACY_STRIPE_ACKNOWLEDGMENT_PDF_VERSION_V4
      || value.rendererVersion === LEGACY_STRIPE_ACKNOWLEDGMENT_PDF_VERSION_V3
      || value.rendererVersion === LEGACY_STRIPE_ACKNOWLEDGMENT_PDF_VERSION_V2
      || value.rendererVersion === LEGACY_STRIPE_ACKNOWLEDGMENT_PDF_VERSION_V1)
    && (value.donorName === null || typeof value.donorName === "string")
    && Number.isSafeInteger(value.amountCents)
    && Number(value.amountCents) >= 0
    && Number.isSafeInteger(value.refundedAmountCents)
    && Number(value.refundedAmountCents) >= 0
    && ["ONCE", "MONTHLY"].includes(String(value.frequency))
    && ["TITHE", "OFFERING", "UNSPECIFIED"].includes(String(value.giftType))
    && typeof value.sourceId === "string"
    && (value.paymentMethod === undefined || typeof value.paymentMethod === "string")
    && typeof value.settledAt === "string"
    && typeof value.timeZone === "string"
    && typeof value.legalName === "string"
    && typeof value.ein === "string"
    && typeof value.organizationName === "string"
    && typeof value.supportEmail === "string"
    && (value.organizationPhone === undefined || typeof value.organizationPhone === "string")
    && (value.organizationWebsite === undefined || typeof value.organizationWebsite === "string")
    && (value.organizationMailingAddress === undefined
      || (Array.isArray(value.organizationMailingAddress) && value.organizationMailingAddress.every((line) => typeof line === "string")))
    && (value.signerName === undefined || typeof value.signerName === "string")
    && (value.signerTitle === undefined || typeof value.signerTitle === "string")
    && ["ORIGINAL", "PARTIAL_REFUND", "FULL_REFUND"].includes(String(value.kind));
}

function completeStripeAcknowledgmentPdfInput(
  evidence: StripeAcknowledgmentPdfEvidence
): RenderStripeAcknowledgmentPdfInput {
  return {
    ...evidence,
    paymentMethod: evidence.paymentMethod ?? "Stripe",
    organizationPhone: evidence.organizationPhone ?? "",
    organizationWebsite: evidence.organizationWebsite ?? "",
    organizationMailingAddress: evidence.organizationMailingAddress ?? [],
    signerName: evidence.signerName ?? "Authorized Representative",
    signerTitle: evidence.signerTitle ?? "Authorized representative"
  };
}

async function auditAcknowledgmentBestEffort(
  env: Env,
  repo: Repository,
  deliveryId: string,
  outcome: "SENT" | "FAILED" | "REVIEW",
  failureCode: string | null
): Promise<void> {
  try {
    await repo.createAudit({
      actorType: "SYSTEM",
      actorId: null,
      action: `STRIPE_ACKNOWLEDGMENT_${outcome}`,
      entityType: "stripe_acknowledgment",
      entityId: deliveryId,
      summary: outcome === "SENT"
        ? "Constancia inmediata de EE. UU. enviada"
        : `Constancia inmediata de EE. UU. marcada ${outcome}`,
      metadata: { outcome, failureCode }
    });
  } catch (error) {
    logWorkerError(env, "stripe_acknowledgment_audit_failed", error);
  }
  if (outcome === "SENT") return;

  const safeFailureCode = failureCode && /^[A-Za-z0-9_-]{1,80}$/.test(failureCode)
    ? failureCode
    : "unknown";
  try {
    await sendOperationalAlert(env, repo, {
      kind: "stripe_acknowledgment_attention",
      title: "Constancia inmediata de EE. UU. requiere atención",
      detail: `Una constancia inmediata de EE. UU. quedó ${outcome === "REVIEW" ? "en revisión" : "fallida"}. Código: ${safeFailureCode}. Revise la conciliación en el panel administrativo.`,
      entityType: "stripe_acknowledgment",
      entityId: deliveryId,
      incidentId: `${deliveryId}:${outcome}`
    });
  } catch (error) {
    logWorkerError(env, "stripe_acknowledgment_alert_failed", error);
  }
}

function stripeAcknowledgmentRetryAt(now: string, attemptCount: number): string {
  const timestamp = Date.parse(now);
  if (!Number.isFinite(timestamp)) throw new Error("Stripe acknowledgment retry timestamp is invalid");
  const delayMinutes = Math.min(240, 5 * (2 ** Math.max(0, attemptCount - 1)));
  return new Date(timestamp + delayMinutes * 60 * 1000).toISOString();
}
