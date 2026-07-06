// Client-side white-label branding. The admin shell fetches /api/branding on boot
// (before the session check, since the login screen must already be branded) and
// applies the accent color, document title, display name, and logo. Donor pages read
// the same endpoint for their logo. Defaults keep an unbranded build on the historical
// "ExamplePerson1" identity.

export const CLIENT_BRANDING_DEFAULTS = {
  displayName: "ExamplePerson1",
  accentColor: "#0f766e"
} as const;

// The single CSS custom property that drives every admin accent shade (see styles.css
// where teal literals became var(--accent, …) and color-mix derivations).
export const BRANDING_ACCENT_CSS_VAR = "--accent";

export const BRANDING_DISPLAY_NAME_MAX_LENGTH = 80;
export const BRANDING_LOGO_MAX_BYTES = 512 * 1024;
export const BRANDING_LOGO_ACCEPT = ".svg,.png,.jpg,.jpeg,image/svg+xml,image/png,image/jpeg";

const ACCENT_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

// Client-side pre-validation mirroring the worker's rules, so the Marca form can flag
// obvious problems before the round-trip. Returns a Spanish error, or null when valid.
export function brandingFieldError(displayName: string, accentColor: string): string | null {
  if (!displayName.trim()) {
    return "Ingrese el nombre de la organización.";
  }
  if (displayName.trim().length > BRANDING_DISPLAY_NAME_MAX_LENGTH) {
    return `El nombre no puede superar los ${BRANDING_DISPLAY_NAME_MAX_LENGTH} caracteres.`;
  }
  if (!ACCENT_COLOR_PATTERN.test(accentColor.trim())) {
    return "Ingrese un color válido en formato #rrggbb.";
  }
  return null;
}

export interface Branding {
  displayName: string;
  accentColor: string;
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
  const logoVersion = typeof record.logoVersion === "string" && record.logoVersion ? record.logoVersion : null;
  return { displayName, accentColor, logoVersion };
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
