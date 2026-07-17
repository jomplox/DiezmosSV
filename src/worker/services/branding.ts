// White-label branding: one display name, one accent color, and one logo let any
// church deploy this product under its own identity. The name and color live in
// app_settings (branding_display_name / branding_accent_color); the logo binary
// lives in the ARCHIVE R2 bucket under BRANDING_LOGO_OBJECT_KEY with its metadata
// (content type, size, cache-busting version) mirrored into branding_logo. Defaults
// keep an unbranded deployment identical to the historical "ExamplePerson1" build.

export const BRANDING_DISPLAY_NAME_SETTING_KEY = "branding_display_name";
export const BRANDING_ACCENT_COLOR_SETTING_KEY = "branding_accent_color";
export const BRANDING_SUPPORT_EMAIL_SETTING_KEY = "branding_support_email";
export const BRANDING_LOGO_SETTING_KEY = "branding_logo";
export const BRANDING_LOGO_OBJECT_KEY = "branding/logo";
export const BRANDING_DONOR_LOGO_SETTING_KEY = "branding_donor_logo";
export const BRANDING_DONOR_LOGO_OBJECT_KEY = "branding/donor-logo";

export const BRANDING_DEFAULTS = {
  displayName: "ExamplePerson1",
  accentColor: "#0f766e",
  // The official support contact both donor pages and email footers fall back to when a
  // church has not configured its own. Keeps an unbranded deployment identical.
  supportEmail: "legacy-contact-1@example.com"
} as const;

const BRANDING_DISPLAY_NAME_MAX_LENGTH = 80;
const BRANDING_SUPPORT_EMAIL_MAX_LENGTH = 100;
// 512 KB: comfortably fits a logo (SVG/optimized PNG/JPEG) while keeping the R2
// object — and the unauthenticated /api/branding/logo stream — cheap to serve.
export const BRANDING_LOGO_MAX_BYTES = 512 * 1024;

// The exact upload allow-list. User-uploaded SVG can embed scripts, so the read
// route locks it down with a strict CSP + nosniff; the type list itself stays tight.
export const BRANDING_LOGO_CONTENT_TYPES = ["image/svg+xml", "image/png", "image/jpeg"] as const;
export type BrandingLogoContentType = (typeof BRANDING_LOGO_CONTENT_TYPES)[number];

const LOGO_EXTENSIONS: Record<BrandingLogoContentType, string> = {
  "image/svg+xml": "svg",
  "image/png": "png",
  "image/jpeg": "jpg"
};

const ACCENT_COLOR_PATTERN = /^#[0-9a-f]{6}$/;
// The same pragmatic email shape used elsewhere (isValidEmail in App.tsx, normalizeEmail
// in the worker index): one @, a dot in the domain, no whitespace. Deliberately lenient.
const SUPPORT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class BrandingValidationError extends Error {}

export interface BrandingSettings {
  displayName: string;
  accentColor: string;
  supportEmail: string;
}

export interface BrandingLogoMeta {
  contentType: BrandingLogoContentType;
  size: number;
  version: string;
}

export function normalizeBrandingDisplayName(value: unknown): string {
  if (typeof value !== "string") {
    throw new BrandingValidationError("Ingrese el nombre de la organización.");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new BrandingValidationError("Ingrese el nombre de la organización.");
  }
  if (trimmed.length > BRANDING_DISPLAY_NAME_MAX_LENGTH) {
    throw new BrandingValidationError(`El nombre no puede superar los ${BRANDING_DISPLAY_NAME_MAX_LENGTH} caracteres.`);
  }
  return trimmed;
}

export function normalizeBrandingAccentColor(value: unknown): string {
  if (typeof value !== "string") {
    throw new BrandingValidationError("Ingrese un color en formato #rrggbb.");
  }
  const lowered = value.trim().toLowerCase();
  if (!ACCENT_COLOR_PATTERN.test(lowered)) {
    throw new BrandingValidationError("Ingrese un color válido en formato #rrggbb.");
  }
  return lowered;
}

// The support contact shown on donor pages and in email footers. Trimmed, lowercased,
// validated against the pragmatic email shape and capped at 100 chars. Spanish error.
export function normalizeBrandingSupportEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new BrandingValidationError("Ingrese un correo de soporte válido.");
  }
  const email = value.trim().toLowerCase();
  if (!email) {
    throw new BrandingValidationError("Ingrese un correo de soporte.");
  }
  if (email.length > BRANDING_SUPPORT_EMAIL_MAX_LENGTH) {
    throw new BrandingValidationError(`El correo de soporte no puede superar los ${BRANDING_SUPPORT_EMAIL_MAX_LENGTH} caracteres.`);
  }
  if (!SUPPORT_EMAIL_PATTERN.test(email)) {
    throw new BrandingValidationError("Ingrese un correo de soporte válido.");
  }
  return email;
}

export function normalizeBrandingLogoContentType(value: unknown): BrandingLogoContentType {
  if (typeof value !== "string") {
    throw new BrandingValidationError("Suba un logo en formato SVG, PNG o JPG.");
  }
  // A Content-Type header may carry parameters (e.g. "image/svg+xml; charset=utf-8");
  // match on the media type alone.
  const mediaType = value.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!isBrandingLogoContentType(mediaType)) {
    throw new BrandingValidationError("El logo debe estar en formato SVG, PNG o JPG.");
  }
  return mediaType;
}

export function brandingLogoExtension(contentType: BrandingLogoContentType): string {
  return LOGO_EXTENSIONS[contentType];
}

// Load the church's name + accent + support contact + logo URL from app_settings for an
// email send. A minimal settings reader (getSetting) is all the settings side needs, so
// it stays decoupled from the full Repository type and easy to fake in tests. The origin
// (env.APP_ORIGIN, with a workers.dev/example fallback) turns the stored logo version
// into the ABSOLUTE URL email clients need — a relative path is useless in an inbox.
export async function loadEmailBranding(
  settings: {
    getSetting(key: string): Promise<string | null>;
  },
  env: BrandingOriginEnv
): Promise<{ organizationName: string; brandColor: string; supportEmail: string; logoUrl: string | null }> {
  const branding = parseBrandingSettings(
    await settings.getSetting(BRANDING_DISPLAY_NAME_SETTING_KEY),
    await settings.getSetting(BRANDING_ACCENT_COLOR_SETTING_KEY),
    await settings.getSetting(BRANDING_SUPPORT_EMAIL_SETTING_KEY)
  );
  const logo = parseBrandingLogoMeta(await settings.getSetting(BRANDING_LOGO_SETTING_KEY));
  return {
    organizationName: branding.displayName,
    brandColor: branding.accentColor,
    supportEmail: branding.supportEmail,
    logoUrl: logo ? brandingLogoUrl(env, logo.version) : null
  };
}

// The origin fields loadEmailBranding needs, kept as a narrow structural type so a plain
// { APP_ORIGIN } literal satisfies it in tests without dragging in the whole Env.
export interface BrandingOriginEnv {
  APP_ORIGIN?: string;
  CLOUDFLARE_SCRIPT_NAME?: string;
}

// The public origin an email links back to. Mirrors alerts.originUrl: a configured
// APP_ORIGIN wins; otherwise the deployed workers.dev host; otherwise a placeholder.
export function brandingOrigin(env: BrandingOriginEnv): string {
  const appOrigin = env.APP_ORIGIN?.trim();
  if (appOrigin) {
    return appOrigin;
  }
  const scriptName = env.CLOUDFLARE_SCRIPT_NAME?.trim();
  return scriptName ? `https://${scriptName}.workers.dev` : "https://diezmos.example.org";
}

// Absolute, version-qualified logo URL for email chrome. Trims a trailing slash on the
// origin so the path has exactly one separator; the ?v= busts the short public cache.
function brandingLogoUrl(env: BrandingOriginEnv, version: string): string {
  const origin = brandingOrigin(env).replace(/\/+$/, "");
  return `${origin}/api/branding/logo?v=${version}`;
}

export function brandingDonorLogoUrl(env: BrandingOriginEnv, version: string): string {
  const origin = brandingOrigin(env).replace(/\/+$/, "");
  return `${origin}/api/branding/donor-logo?v=${version}`;
}

export function parseBrandingSettings(
  displayName: string | null,
  accentColor: string | null,
  supportEmail: string | null
): BrandingSettings {
  return {
    displayName: displayName?.trim() || BRANDING_DEFAULTS.displayName,
    accentColor: accentColor?.trim().toLowerCase() || BRANDING_DEFAULTS.accentColor,
    supportEmail: supportEmail?.trim().toLowerCase() || BRANDING_DEFAULTS.supportEmail
  };
}

export function parseBrandingLogoMeta(raw: string | null | undefined): BrandingLogoMeta | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const contentType = record.contentType;
  const size = record.size;
  const version = record.version;
  if (!isBrandingLogoContentType(contentType) || typeof size !== "number" || typeof version !== "string" || !version) {
    return null;
  }
  return { contentType, size, version };
}

function isBrandingLogoContentType(value: unknown): value is BrandingLogoContentType {
  return typeof value === "string" && (BRANDING_LOGO_CONTENT_TYPES as readonly string[]).includes(value);
}
