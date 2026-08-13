import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderStripeAcknowledgmentPdf } from "../src/worker/services/stripeAcknowledgment";
import {
  buildStripeAnnualStatementSnapshot,
  renderStripeAnnualStatementPdf
} from "../src/worker/services/stripeAnnualStatement";

export async function renderStripeUsPdfPreviews(
  outputDirectory: string
): Promise<{ receiptPath: string; annualPath: string }> {
  await mkdir(outputDirectory, { recursive: true });
  const receiptPath = join(outputDirectory, "stripe-us-single-gift-receipt.pdf");
  const annualPath = join(outputDirectory, "stripe-us-annual-giving-statement.pdf");
  const [receipt, annual] = await Promise.all([
    renderStripeAcknowledgmentPdf({
      donorName: "Preview Receipt Donor 413",
      amountCents: 41_300,
      refundedAmountCents: 0,
      frequency: "ONCE",
      giftType: "OFFERING",
      sourceId: "pi_preview_receipt_413",
      settledAt: "2025-04-13T16:00:00.000Z",
      timeZone: "America/New_York",
      legalName: "Preview Receipt Legal Foundation",
      ein: "41-3000413",
      organizationName: "Preview Receipt Ministry",
      supportEmail: "preview-receipt@example.org",
      organizationPhone: "+1 555 010 0413",
      organizationWebsite: "https://preview-receipt.example.org",
      organizationMailingAddress: ["413 Preview Receipt Way", "Orlando, FL 32813, USA"],
      signerName: "Preview Receipt Signer",
      signerTitle: "Preview Treasurer",
      kind: "ORIGINAL"
    }),
    renderAnnualPreview()
  ]);
  await Promise.all([writeFile(receiptPath, receipt), writeFile(annualPath, annual)]);
  return { receiptPath, annualPath };
}

async function renderAnnualPreview(): Promise<Uint8Array> {
  const snapshot = await buildStripeAnnualStatementSnapshot({
    year: 2025,
    livemode: false,
    donorKey: "preview-annual-donor@example.org",
    donorName: "Preview Annual Donor 517",
    donorEmail: "preview-annual-donor@example.org",
    document: {
      rendererVersion: "stripe-annual-statement-pdf:v4",
      legalName: "Preview Annual Legal Foundation",
      ein: "51-7000517",
      timeZone: "America/New_York",
      accentColor: "#0f766e",
      logo: {
        format: "png",
        hash: "ac235e246a9d15381b32501f49eec7e8f8fb60a52214e0fde9a6595e5c67e19c"
      },
      organizationContact: {
        phone: "+1 555 010 0517",
        website: "https://preview-annual.example.org",
        mailingAddress: ["517 Preview Annual Avenue", "Austin, TX 78751, USA"]
      },
      email: {
        organizationName: "Preview Annual Ministry",
        supportEmail: "preview-annual@example.org",
        logoUrl: null,
        senderName: "Preview Annual Ministry",
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
    gifts: [{
      id: "preview_annual_gift_517",
      source_type: "PAYMENT_INTENT",
      source_id: "pi_preview_annual_517",
      checkout_id: "checkout_preview_annual_517",
      stripe_payment_intent_id: "pi_preview_annual_517",
      stripe_invoice_id: null,
      stripe_subscription_id: null,
      frequency: "MONTHLY",
      gift_type: "TITHE",
      amount_cents: 51_700,
      currency: "usd",
      donor_name: "Preview Annual Donor 517",
      donor_email: "preview-annual-donor@example.org",
      donor_phone: "+1 555 010 1517",
      donor_address_json: JSON.stringify({
        line1: "517 Preview Donor Street",
        line2: null,
        city: "Austin",
        state: "TX",
        postalCode: "78751",
        country: "US"
      }),
      settled_at: "2025-05-17T16:00:00.000Z",
      status: "PAID",
      refunded_amount_cents: 0,
      net_amount_cents: 51_700,
      created_at: "2025-05-17T16:00:00.000Z",
      updated_at: "2025-05-17T16:00:00.000Z"
    }]
  });
  return renderStripeAnnualStatementPdf({
    snapshot,
    issuedOn: "2026-01-10T12:00:00.000Z",
    corrected: false
  });
}
