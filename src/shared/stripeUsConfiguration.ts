export const STRIPE_US_LEGAL_NAME_MAX_LENGTH = 80;
export const STRIPE_US_SIGNER_NAME_MAX_LENGTH = 60;
export const STRIPE_US_SIGNER_TITLE_MAX_LENGTH = 60;
export const STRIPE_US_WEBSITE_MAX_LENGTH = 100;
export const STRIPE_US_MAILING_ADDRESS_LINE_MAX_LENGTH = 80;

const FMCE_LEGAL_NAME_DISPLAY = "Friends of Misión Cristiana Elim";
const FMCE_LEGAL_NAME_DISPLAY_VARIANTS = new Set([
  "FRIENDS OF MISION CRISTIANA ELIM",
  "FRIENDS OF MISIÓN CRISTIANA ELIM"
]);

export function stripeUsLegalNameForDisplay(value: string): string {
  return FMCE_LEGAL_NAME_DISPLAY_VARIANTS.has(value) ? FMCE_LEGAL_NAME_DISPLAY : value;
}

export function stripeUsConfiguredLegalNameForDisplay(value: string | undefined): string {
  const raw = typeof value === "string" ? value : "";
  const mapped = stripeUsLegalNameForDisplay(raw);
  return mapped === raw ? raw.trim() : mapped;
}

export const STRIPE_US_TIME_ZONE_OPTIONS = [
  { value: "America/New_York", label: "Hora del Este — America/New_York" },
  { value: "America/Chicago", label: "Hora Central — America/Chicago" },
  { value: "America/Denver", label: "Hora de la Montaña — America/Denver" },
  { value: "America/Phoenix", label: "Arizona — America/Phoenix" },
  { value: "America/Los_Angeles", label: "Hora del Pacífico — America/Los_Angeles" },
  { value: "America/Anchorage", label: "Alaska — America/Anchorage" },
  { value: "America/Adak", label: "Islas Aleutianas — America/Adak" },
  { value: "Pacific/Honolulu", label: "Hawái — Pacific/Honolulu" },
  { value: "America/Puerto_Rico", label: "Puerto Rico — America/Puerto_Rico" },
  { value: "Pacific/Guam", label: "Guam — Pacific/Guam" },
  { value: "Pacific/Pago_Pago", label: "Samoa Americana — Pacific/Pago_Pago" }
] as const;
