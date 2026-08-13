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
      donorName: "Ana Morales",
      amountCents: 25_000,
      refundedAmountCents: 0,
      frequency: "ONCE",
      giftType: "OFFERING",
      sourceId: "pi_sample_receipt_2025_0413",
      settledAt: "2025-04-13T16:00:00.000Z",
      timeZone: "America/New_York",
      legalName: "Friends of Misión Cristiana Elim, Inc.",
      ein: "12-3456789",
      organizationName: "Misión Cristiana Elim",
      supportEmail: "giving@example.org",
      organizationPhone: "+1 (616) 555-0143",
      organizationWebsite: "https://www.elim.click",
      organizationMailingAddress: [
        "2885 Sanford Avenue SW",
        "PMB 41357",
        "Grandville, MI 49418",
        "United States"
      ],
      signerName: "Mathieu Guély",
      signerTitle: "Treasurer",
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
    donorKey: "ana.morales@example.org",
    donorName: "Ana Morales",
    donorEmail: "ana.morales@example.org",
    document: {
      rendererVersion: "stripe-annual-statement-pdf:v5",
      legalName: "Friends of Misión Cristiana Elim, Inc.",
      ein: "12-3456789",
      timeZone: "America/New_York",
      accentColor: "#0f766e",
      logo: {
        format: "png",
        hash: "ac235e246a9d15381b32501f49eec7e8f8fb60a52214e0fde9a6595e5c67e19c"
      },
      organizationContact: {
        phone: "+1 (616) 555-0143",
        website: "https://www.elim.click",
        mailingAddress: [
          "2885 Sanford Avenue SW",
          "PMB 41357",
          "Grandville, MI 49418",
          "United States"
        ]
      },
      email: {
        organizationName: "Misión Cristiana Elim",
        supportEmail: "giving@example.org",
        logoUrl: null,
        senderName: "Misión Cristiana Elim",
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
      frequency: "MONTHLY",
      gift_type: "TITHE",
      amount_cents: 50_000,
      currency: "usd",
      donor_name: "Ana Morales",
      donor_email: "ana.morales@example.org",
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
