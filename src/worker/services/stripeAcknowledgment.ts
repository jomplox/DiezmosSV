import { formatCents } from "../../shared/money";
import type { Repository, StripeGiftFrequency, StripeGiftType } from "../storage/repository";
import type { Env } from "../types";
import { newId } from "../utils/ids";
import { loadEmailBranding } from "./branding";
import { classifyEmailDispatchError, EmailService } from "./email";
import {
  stripeAcknowledgmentEmailHtml,
  type BrandingEmailOptions
} from "./emailHtml";
import { resolveStripeConfiguration } from "./stripeDonations";

export interface StripeAcknowledgmentContentInput {
  donorName: string | null;
  amountCents: number;
  frequency: StripeGiftFrequency;
  giftType: StripeGiftType;
  settledAt: string;
  legalName: string;
  ein: string;
  branding: BrandingEmailOptions;
}

export function stripeAcknowledgmentContent(
  input: StripeAcknowledgmentContentInput
): { subject: string; text: string; html: string } {
  const donorName = input.donorName?.trim() || "Donante";
  const amountLabel = `${formatCents(input.amountCents)} USD`;
  const settledDateLabel = new Intl.DateTimeFormat("es-US", {
    dateStyle: "long",
    timeZone: "UTC"
  }).format(new Date(input.settledAt));
  const frequencyLabel = input.frequency === "MONTHLY" ? "Mensual" : "Única";
  const giftTypeLabel = input.giftType === "TITHE"
    ? "Diezmo"
    : input.giftType === "OFFERING"
      ? "Ofrenda"
      : "No especificado";
  const text =
    `Estimado(a) ${donorName}:\n\n` +
    `Gracias por su donación voluntaria de ${amountLabel}.\n\n` +
      `Organización legal: ${input.legalName}\n` +
      `EIN ${input.ein}\n` +
      `Fecha: ${settledDateLabel}\n` +
      `Tipo: ${giftTypeLabel}\n` +
    `Frecuencia: ${frequencyLabel}\n\n` +
    `No se proporcionaron bienes ni servicios a cambio de esta donación.\n\n` +
    `Conserve este correo con sus registros. Consulte con su asesor sobre la aplicación a su situación fiscal.`;
  return {
    subject: "Constancia de su donación",
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
      logoUrl: input.branding.logoUrl
    })
  };
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
  if (!claim.donor_email) {
    await repo.finalizeStripeAcknowledgment({
      id: claim.id,
      claimId,
      outcome: "REVIEW",
      failureCode: "recipient_missing",
      retrySafe: false,
      now
    });
    return { processed: true, outcome: "REVIEW", giftId: claim.gift_id };
  }

  let providerDispatchStarted = false;
  try {
    const configuration = resolveStripeConfiguration(env);
    const branding = await loadEmailBranding(repo, env);
    const content = stripeAcknowledgmentContent({
      donorName: claim.donor_name,
      amountCents: claim.amount_cents,
      frequency: claim.frequency,
      giftType: claim.gift_type,
      settledAt: claim.settled_at,
      legalName: configuration.legalName,
      ein: configuration.ein,
      branding
    });
    const result = await new EmailService(env, undefined, branding).sendStripeAcknowledgment({
      toEmail: claim.donor_email,
      subject: content.subject,
      text: content.text,
      html: content.html,
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
    return { processed: true, outcome: "SENT", giftId: claim.gift_id };
  } catch (error) {
    const classified = classifyEmailDispatchError(error, providerDispatchStarted);
    const outcome = classified.outcomeClass === "UNKNOWN" ? "REVIEW" : "FAILED";
    await repo.finalizeStripeAcknowledgment({
      id: claim.id,
      claimId,
      outcome,
      failureCode: classified.code,
      retrySafe: outcome === "FAILED" && classified.retrySafe,
      now
    });
    return { processed: true, outcome, giftId: claim.gift_id };
  }
}
