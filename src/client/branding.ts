// Client-side white-label branding. The admin shell fetches /api/branding on boot
// (before the session check, since the login screen must already be branded) and
// applies the accent color, document title, display name, and logo. Donor pages read
// the same endpoint for their logo. Defaults keep an unbranded build on the historical
// "ExamplePerson1" identity.

export const CLIENT_BRANDING_DEFAULTS = {
  displayName: "ExamplePerson1",
  accentColor: "#0f766e",
  // The default support contact shown on donor pages + email footers (mirrors the
  // worker's BRANDING_DEFAULTS.supportEmail) until a church configures its own.
  supportEmail: "legacy-contact-1@example.com"
} as const;

// The single CSS custom property that drives every admin accent shade (see styles.css
// where teal literals became var(--accent, …) and color-mix derivations).
export const BRANDING_ACCENT_CSS_VAR = "--accent";

export const BRANDING_DISPLAY_NAME_MAX_LENGTH = 80;
export const BRANDING_SUPPORT_EMAIL_MAX_LENGTH = 100;
export const BRANDING_LOGO_MAX_BYTES = 512 * 1024;
export const BRANDING_LOGO_ACCEPT = ".svg,.png,.jpg,.jpeg,image/svg+xml,image/png,image/jpeg";

const ACCENT_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
// Same pragmatic email shape the worker uses (normalizeBrandingSupportEmail): one @, a
// dot in the domain, no whitespace.
const SUPPORT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Client-side pre-validation mirroring the worker's rules, so the Marca form can flag
// obvious problems before the round-trip. Returns a Spanish error, or null when valid.
export function brandingFieldError(displayName: string, accentColor: string, supportEmail: string): string | null {
  if (!displayName.trim()) {
    return "Ingrese el nombre de la organización.";
  }
  if (displayName.trim().length > BRANDING_DISPLAY_NAME_MAX_LENGTH) {
    return `El nombre no puede superar los ${BRANDING_DISPLAY_NAME_MAX_LENGTH} caracteres.`;
  }
  if (!ACCENT_COLOR_PATTERN.test(accentColor.trim())) {
    return "Ingrese un color válido en formato #rrggbb.";
  }
  const email = supportEmail.trim();
  if (!email) {
    return "Ingrese un correo de soporte.";
  }
  if (email.length > BRANDING_SUPPORT_EMAIL_MAX_LENGTH || !SUPPORT_EMAIL_PATTERN.test(email)) {
    return "Ingrese un correo de soporte válido.";
  }
  return null;
}

export interface Branding {
  displayName: string;
  accentColor: string;
  supportEmail: string;
  logoVersion: string | null;
}

// Normalize the raw /api/branding payload, tolerating anything malformed by falling
// back to the historical defaults (branding must never break the login screen).
export function parseBrandingResponse(data: unknown): Branding {
  const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const displayName =
    typeof record.displayName === "string" && record.displayName.trim()
      ? record.displayName.trim()
      : CLIENT_BRANDING_DEFAULTS.displayName;
  const accentColor =
    typeof record.accentColor === "string" && ACCENT_COLOR_PATTERN.test(record.accentColor.trim())
      ? record.accentColor.trim().toLowerCase()
      : CLIENT_BRANDING_DEFAULTS.accentColor;
  const supportEmail =
    typeof record.supportEmail === "string" && SUPPORT_EMAIL_PATTERN.test(record.supportEmail.trim())
      ? record.supportEmail.trim().toLowerCase()
      : CLIENT_BRANDING_DEFAULTS.supportEmail;
  const logoVersion = typeof record.logoVersion === "string" && record.logoVersion ? record.logoVersion : null;
  return { displayName, accentColor, supportEmail, logoVersion };
}

// The cache-busting logo URL. Always version-qualified so a re-upload invalidates the
// short public cache. null when no logo is stored (caller renders the built-in mark).
export function brandingLogoSrc(logoVersion: string | null): string | null {
  return logoVersion ? `/api/branding/logo?v=${logoVersion}` : null;
}

// Apply branding to the live document: accent CSS variable + tab title. Safe to call
// with the defaults (keeps the historical look). Guarded so it can run in any DOM.
export function applyBranding(branding: Branding, doc: Document = document): void {
  doc.documentElement.style.setProperty(BRANDING_ACCENT_CSS_VAR, branding.accentColor);
  doc.title = branding.displayName;
}

// Fetch + apply in one call for the admin boot path. Never throws: a failed fetch
// leaves the defaults in place so the login screen still renders.
export async function loadAndApplyBranding(doc: Document = document): Promise<Branding> {
  let branding: Branding = { ...CLIENT_BRANDING_DEFAULTS, logoVersion: null };
  try {
    const response = await fetch("/api/branding");
    if (response.ok) {
      branding = parseBrandingResponse(await response.json());
    }
  } catch {
    // Network failure: keep the defaults.
  }
  applyBranding(branding, doc);
  return branding;
}
