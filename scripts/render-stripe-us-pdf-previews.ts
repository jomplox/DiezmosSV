import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderStripeAcknowledgmentPdf } from "../src/worker/services/stripeAcknowledgment";
import {
  buildStripeAnnualStatementSnapshot,
  renderStripeAnnualStatementPdf
} from "../src/worker/services/stripeAnnualStatement";

export async function renderStripeUsPdfPreviews(
  outputDirectory: string,
  configuration: StripeUsPdfPreviewConfiguration
): Promise<{ receiptPath: string; annualPath: string }> {
  await mkdir(outputDirectory, { recursive: true });
  const receiptPath = join(outputDirectory, "stripe-us-single-gift-receipt.pdf");
  const annualPath = join(outputDirectory, "stripe-us-annual-giving-statement.pdf");
  const [receipt, annual] = await Promise.all([
    renderStripeAcknowledgmentPdf({
      donorName: "SAMPLE PREVIEW DONOR",
      amountCents: 25_000,
      refundedAmountCents: 0,
      frequency: "ONCE",
      giftType: "OFFERING",
      sourceId: "pi_sample_receipt_2025_0413",
      paymentMethod: "Card",
      settledAt: "2025-04-13T16:00:00.000Z",
      timeZone: "America/New_York",
      ...configuration,
      kind: "ORIGINAL"
    }),
    renderAnnualPreview(configuration)
  ]);
  await Promise.all([writeFile(receiptPath, receipt), writeFile(annualPath, annual)]);
  return { receiptPath, annualPath };
}

export interface StripeUsPdfPreviewConfiguration {
  legalName: string;
  ein: string;
  organizationName: string;
  supportEmail: string;
  organizationPhone: string;
  organizationWebsite: string;
  organizationMailingAddress: string[];
  signerName: string;
  signerTitle: string;
}

async function renderAnnualPreview(configuration: StripeUsPdfPreviewConfiguration): Promise<Uint8Array> {
  const snapshot = await buildStripeAnnualStatementSnapshot({
    year: 2025,
    livemode: false,
    donorKey: "ana.morales@example.org",
    donorName: "SAMPLE PREVIEW DONOR",
    donorEmail: "sample-preview-donor@example.org",
    document: {
      rendererVersion: "stripe-annual-statement-pdf:v6",
      legalName: configuration.legalName,
      ein: configuration.ein,
      timeZone: "America/New_York",
      accentColor: "#0f766e",
      logo: {
        format: "png",
        hash: "ac235e246a9d15381b32501f49eec7e8f8fb60a52214e0fde9a6595e5c67e19c"
      },
      organizationContact: {
        phone: configuration.organizationPhone,
        website: configuration.organizationWebsite,
        mailingAddress: configuration.organizationMailingAddress
      },
      email: {
        organizationName: configuration.organizationName,
        supportEmail: configuration.supportEmail,
        logoUrl: null,
        senderName: configuration.organizationName,
        replyToAddress: null
      },
      settings: {
        brandingDisplayName: null,
        brandingAccentColor: null,
        brandingSupportEmail: null,
        brandingLogo: null,
        brandingDonorLogo: null,
        emailSenderName: null,
        emailReplyTo: null
      }
    },
    gifts: Array.from({ length: 5 }, (_, index) => ({
      id: `sample_annual_gift_2025_${index + 1}`,
      source_type: "PAYMENT_INTENT",
      source_id: `pi_sample_annual_2025_${String(index + 1).padStart(2, "0")}`,
      checkout_id: `checkout_sample_annual_2025_${index + 1}`,
      stripe_payment_intent_id: `pi_sample_annual_2025_${String(index + 1).padStart(2, "0")}`,
      stripe_invoice_id: null,
      stripe_subscription_id: null,
      payment_method_type: index === 0 ? "card" : "us_bank_account",
      payment_method_wallet: index === 0 ? "apple_pay" : null,
      payment_method_charge_id: `ch_sample_annual_2025_${String(index + 1).padStart(2, "0")}`,
      payment_method_event_id: `evt_sample_annual_2025_${String(index + 1).padStart(2, "0")}`,
      frequency: "MONTHLY",
      gift_type: "TITHE",
      amount_cents: 50_000,
      currency: "usd",
      donor_name: "SAMPLE PREVIEW DONOR",
      donor_email: "sample-preview-donor@example.org",
      donor_phone: "+1 (616) 555-0192",
      donor_address_json: JSON.stringify({
        line1: "1250 Cedar Street",
        line2: null,
        city: "Grand Rapids",
        state: "MI",
        postalCode: "49503",
        country: "US"
      }),
      settled_at: `2025-0${index + 1}-15T16:00:00.000Z`,
      status: "PAID",
      refunded_amount_cents: 0,
      net_amount_cents: 50_000,
      created_at: "2025-05-17T16:00:00.000Z",
      updated_at: "2025-05-17T16:00:00.000Z"
    }))
  });
  return renderStripeAnnualStatementPdf({
    snapshot,
    issuedOn: "2026-01-10T12:00:00.000Z",
    corrected: false
  });
}
