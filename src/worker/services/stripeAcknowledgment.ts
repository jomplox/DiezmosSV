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
  stripeAcknowledgmentEmailHtml,
  type BrandingEmailOptions
} from "./emailHtml";
import { resolveStripeConfiguration } from "./stripeDonations";
import { stripeUsTimeZone } from "./stripeAnnualStatement";
import { logWorkerError } from "./observability";

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
  const text =
    `Estimado(a) ${donorName}:\n\n` +
    `Gracias por su donación voluntaria de ${amountLabel}.\n\n` +
    correctionText +
      `Organización legal: ${input.legalName}\n` +
      `EIN ${input.ein}\n` +
      `Fecha: ${settledDateLabel}\n` +
      `Tipo: ${giftTypeLabel}\n` +
    `Frecuencia: ${frequencyLabel}\n\n` +
    `No se proporcionaron bienes ni servicios a cambio de esta donación.\n\n` +
    `Conserve este correo con sus registros. Consulte con su asesor sobre la aplicación a su situación fiscal.`;
  return {
    subject: kind === "PARTIAL_REFUND"
      ? "Constancia corregida de su donación"
      : kind === "FULL_REFUND"
        ? "Constancia revocada de su donación"
        : "Constancia de su donación",
    text,
    html: stripeAcknowledgmentEmailHtml({
      donorName,
      amountLabel,
      settledDateLabel,
      giftTypeLabel,
      frequencyLabel,
      legalName: input.legalName,
      ein: input.ein,
      organizationName: input.branding.organizationName,
      brandColor: input.branding.brandColor,
      supportEmail: input.branding.supportEmail,
      logoUrl: input.branding.logoUrl,
      kind,
      refundedAmountLabel,
      netAmountLabel
    })
  };
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
}

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
    refundedAmountCents: source.evidence_refunded_amount_cents
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
    content
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
    const result = await new EmailService(env, undefined, evidence.branding).sendStripeAcknowledgment({
      toEmail: evidence.recipientEmail,
      subject: evidence.content.subject,
      text: evidence.content.text,
      html: evidence.content.html,
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
