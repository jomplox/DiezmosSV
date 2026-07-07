import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRANDING_ACCENT_CSS_VAR,
  BRANDING_LOGO_ACCEPT,
  CLIENT_BRANDING_DEFAULTS,
  brandingFieldError,
  brandingLogoSrc,
  parseBrandingResponse
} from "../../src/client/branding";

const stylesSource = readFileSync(resolve(import.meta.dirname, "../../src/client/styles.css"), "utf8");
const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");
const donarSource = readFileSync(resolve(import.meta.dirname, "../../src/client/donarPage.tsx"), "utf8");

describe("parseBrandingResponse", () => {
  it("falls back to defaults for an empty payload", () => {
    expect(parseBrandingResponse({})).toEqual({
      displayName: CLIENT_BRANDING_DEFAULTS.displayName,
      accentColor: CLIENT_BRANDING_DEFAULTS.accentColor,
      supportEmail: CLIENT_BRANDING_DEFAULTS.supportEmail,
      logoVersion: null
    });
  });

  it("passes through a full payload", () => {
    expect(
      parseBrandingResponse({
        displayName: "Iglesia Central",
        accentColor: "#123abc",
        supportEmail: "legacy-email-119@example.com",
        logoVersion: "v1"
      })
    ).toEqual({
      displayName: "Iglesia Central",
      accentColor: "#123abc",
      supportEmail: "legacy-email-119@example.com",
      logoVersion: "v1"
    });
  });

  it("lowercases a valid support email and keeps the default for a malformed one", () => {
    expect(parseBrandingResponse({ supportEmail: "  legacy-email-119@example.com " }).supportEmail).toBe("legacy-email-119@example.com");
    expect(parseBrandingResponse({ supportEmail: "no-arroba" }).supportEmail).toBe(
      CLIENT_BRANDING_DEFAULTS.supportEmail
    );
  });

  it("ignores a malformed accent color and keeps the default", () => {
    expect(parseBrandingResponse({ displayName: "X", accentColor: "not-a-color", logoVersion: null })).toMatchObject({
      accentColor: CLIENT_BRANDING_DEFAULTS.accentColor
    });
  });

  it("ignores a non-string display name", () => {
    expect(parseBrandingResponse({ displayName: 5 as unknown as string })).toMatchObject({
      displayName: CLIENT_BRANDING_DEFAULTS.displayName
    });
  });
});

describe("brandingLogoSrc", () => {
  it("references the public logo endpoint with the version query", () => {
    expect(brandingLogoSrc("abc123")).toBe("/api/branding/logo?v=abc123");
  });

  it("returns null when there is no logo version", () => {
    expect(brandingLogoSrc(null)).toBeNull();
  });
});

describe("brandingFieldError", () => {
  it("accepts a valid name, color, and support email", () => {
    expect(brandingFieldError("Iglesia Central", "#0f766e", "legacy-email-119@example.com")).toBeNull();
  });

  it("flags an empty name", () => {
    expect(brandingFieldError("  ", "#0f766e", "legacy-email-119@example.com")).toContain("nombre");
  });

  it("flags an 81-character name", () => {
    expect(brandingFieldError("a".repeat(81), "#0f766e", "legacy-email-119@example.com")).toContain("caracteres");
  });

  it("flags a malformed color", () => {
    expect(brandingFieldError("Iglesia", "#zz", "legacy-email-119@example.com")).toContain("color");
  });

  it("flags an empty support email", () => {
    expect(brandingFieldError("Iglesia", "#0f766e", "  ")).toContain("correo");
  });

  it("flags a malformed support email", () => {
    expect(brandingFieldError("Iglesia", "#0f766e", "no-arroba")).toContain("correo");
  });

  it("exposes an accept string covering the three allowed formats", () => {
    expect(BRANDING_LOGO_ACCEPT).toContain("image/svg+xml");
    expect(BRANDING_LOGO_ACCEPT).toContain("image/png");
    expect(BRANDING_LOGO_ACCEPT).toContain("image/jpeg");
  });
});

describe("branding defaults", () => {
  it("keeps the historical ExamplePerson1 identity", () => {
    expect(CLIENT_BRANDING_DEFAULTS.displayName).toBe("ExamplePerson1");
    expect(CLIENT_BRANDING_DEFAULTS.accentColor).toBe("#0f766e");
    expect(CLIENT_BRANDING_DEFAULTS.supportEmail).toBe("legacy-contact-1@example.com");
    expect(BRANDING_ACCENT_CSS_VAR).toBe("--accent");
  });
});

describe("admin stylesheet is driven by the accent variable (source contract)", () => {
  it("has no hardcoded teal accent left outside var(--accent) fallbacks", () => {
    // The white-label accent recolors the admin UI through var(--accent, …). The only
    // places the historical teal literals may appear are inside such a fallback default
    // and in the single --accent custom-property definition on :root.
    const withoutFallbacks = stylesSource
      .replace(/var\(--accent[^)]*\)/g, "")
      .replace(/--accent:\s*#[0-9a-f]{6};/gi, "");
    expect(withoutFallbacks).not.toMatch(/#007c75/i);
    expect(withoutFallbacks).not.toMatch(/#0f766e/i);
  });

  it("defines the accent custom property with the historical fallback on :root", () => {
    expect(stylesSource).toMatch(/--accent:\s*#0f766e/);
  });
});

describe("App boots branding before the session (source contract)", () => {
  it("fetches the public branding endpoint and applies it", () => {
    expect(appSource).toContain("/api/branding");
    expect(appSource).toContain("applyBranding");
  });
});

describe("BrandingEditor edits the support email (source contract)", () => {
  it("offers a 'Correo de soporte' input saved through the branding PUT", () => {
    // The Marca form gains a support-email field alongside name + color; it is sent to
    // /api/settings/branding and explained as the contact shown on donor pages + emails.
    expect(appSource).toContain("Correo de soporte");
    expect(appSource).toContain("supportEmail");
    // Validation runs through the shared brandingFieldError helper before the round-trip.
    expect(appSource).toContain("brandingFieldError(");
  });
});

describe("Donor landing uses the uploaded logo when present (source contract)", () => {
  it("renders the branding logo image and keeps the default vector fallback", () => {
    expect(donarSource).toContain("brandingLogoSrc");
    expect(donarSource).toContain("OrganizationLogo");
  });
});

describe("BrandingEditor renders a live Vista previa block (source contract)", () => {
  it("shows a captioned preview block with both channel mocks", () => {
    // A "Vista previa" block below the logo controls with two side-by-side miniature
    // mocks, each with a Spanish caption describing where the branding will show.
    expect(appSource).toContain("Vista previa");
    expect(appSource).toContain("branding-preview");
    expect(appSource).toContain("Así se verá en los correos");
    expect(appSource).toContain("Así se verá en la página de donación");
    // Labeled channels: an email chrome mock and a donor landing card mock.
    expect(appSource).toContain("Correo");
    expect(appSource).toContain("Página de donación");
  });

  it("drives the preview from the editor's unsaved draft values", () => {
    // The email header mock tints with the draft accent color (colorForPicker) and shows
    // the draft display name; the footer shows the draft support email. The logo comes
    // from the draft preview object URL or the current logo src.
    const previewStart = appSource.indexOf("branding-preview");
    const previewRegion = appSource.slice(previewStart, previewStart + 3000);
    expect(previewRegion).toContain("colorForPicker");
    expect(previewRegion).toContain("displayName");
    expect(previewRegion).toContain("supportEmail");
    expect(previewRegion).toContain("previewUrl");
    expect(previewRegion).toContain("currentLogoSrc");
  });

  it("keeps the donor-page mock monochrome (never tinted with the accent)", () => {
    // The donor landing is monochrome by design: its mock must not paint the accent
    // color onto the card. Only the email mock's header carries the accent.
    const donorMockStart = appSource.indexOf("branding-preview-donor");
    expect(donorMockStart).toBeGreaterThan(-1);
    const donorMock = appSource.slice(donorMockStart, donorMockStart + 700);
    expect(donorMock).not.toContain("colorForPicker");
    expect(donorMock).toContain("Diezmos y Ofrendas");
  });
});

describe("BrandingEditor preview styles are namespaced and theme-driven (source contract)", () => {
  it("defines .branding-preview-* classes without introducing new hex literals", () => {
    // Isolate every rule whose selector line mentions .branding-preview and assert those
    // rules use theme variables, never a raw hex (theme variables only, no new hexes).
    const previewRules = stylesSource
      .split(/(?=\n\.[a-z])/i)
      .filter((rule) => /\.branding-preview/.test(rule.split("{")[0] ?? ""));
    expect(previewRules.length).toBeGreaterThan(0);
    const previewCss = previewRules.join("\n");
    expect(previewCss).toContain("var(--");
    expect(previewCss).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
  });
});
test("the donor-page preview mark follows the draft name, not a hardcoded default", () => {
  // Without a logo, the donor mock's placeholder mark must show the DRAFT organization
  // name (like the email mock) so both previews stay consistent while editing.
  const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");
  expect(appSource).toContain('className="branding-preview-donor-mark">{displayName || "ExamplePerson1"}');
});

