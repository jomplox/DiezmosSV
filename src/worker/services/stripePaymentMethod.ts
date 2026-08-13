export interface StripePaymentMethodEvidence {
  type: string;
  wallet: string | null;
  chargeId: string | null;
  eventId: string;
}

const PROVIDER_METHOD_PATTERN = /^[a-z0-9_]{1,64}$/u;

export function stripePaymentMethodEvidence(
  charge: Record<string, unknown>,
  eventId: string
): StripePaymentMethodEvidence {
  const details = record(charge.payment_method_details);
  const type = providerMethod(details?.type, "payment_method_type_invalid");
  const card = type === "card" ? record(details?.card) : null;
  const walletRecord = record(card?.wallet);
  const wallet = walletRecord
    ? providerMethod(walletRecord.type, "payment_method_wallet_invalid")
    : null;
  return {
    type,
    wallet,
    chargeId: legacyChargeId(charge.id),
    eventId: providerId(eventId, "evt_")
  };
}

export function stripePaymentMethodLabel(
  type: string | null | undefined,
  wallet: string | null | undefined
): string {
  if (!type || type === "legacy_stripe") return "Stripe";
  if (type === "card") {
    if (wallet === "apple_pay") return "Apple Pay";
    if (wallet === "google_pay") return "Google Pay";
    if (wallet === "link") return "Link";
    if (wallet) return humanizeProviderMethod(wallet);
    return "Card";
  }
  if (type === "link") return "Link";
  if (type === "us_bank_account") return "ACH Direct Debit";
  if (type === "cashapp") return "Cash App Pay";
  if (type === "amazon_pay") return "Amazon Pay";
  if (type === "paypal") return "PayPal";
  return humanizeProviderMethod(type);
}

function humanizeProviderMethod(value: string): string {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function providerMethod(value: unknown, code: string): string {
  if (typeof value !== "string" || !PROVIDER_METHOD_PATTERN.test(value)) {
    throw new Error(code);
  }
  return value;
}

function providerId(value: unknown, prefix: string): string {
  if (
    typeof value !== "string"
    || !value.startsWith(prefix)
    || value.length > 255
    || !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error("stripe_identifier_invalid");
  }
  return value;
}

function legacyChargeId(value: unknown): string | null {
  if (
    typeof value !== "string"
    || (!value.startsWith("ch_") && !value.startsWith("py_"))
    || value.length > 255
    || !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error("stripe_identifier_invalid");
  }
  // The original evidence column is constrained to historical ch_ IDs.
  // Dahlia can identify non-card Charge objects with py_; the signed event ID
  // and PaymentIntent remain the durable identity for those records.
  return value.startsWith("ch_") ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
