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
      logoVersion: null
    });
  });

  it("passes through a full payload", () => {
    expect(
      parseBrandingResponse({ displayName: "Iglesia Central", accentColor: "#123abc", logoVersion: "v1" })
    ).toEqual({ displayName: "Iglesia Central", accentColor: "#123abc", logoVersion: "v1" });
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
  it("accepts a valid name and color", () => {
    expect(brandingFieldError("Iglesia Central", "#0f766e")).toBeNull();
  });

  it("flags an empty name", () => {
    expect(brandingFieldError("  ", "#0f766e")).toContain("nombre");
  });

  it("flags an 81-character name", () => {
    expect(brandingFieldError("a".repeat(81), "#0f766e")).toContain("caracteres");
  });

  it("flags a malformed color", () => {
    expect(brandingFieldError("Iglesia", "#zz")).toContain("color");
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

describe("Donor landing uses the uploaded logo when present (source contract)", () => {
  it("renders the branding logo image and keeps the default vector fallback", () => {
    expect(donarSource).toContain("brandingLogoSrc");
    expect(donarSource).toContain("OrganizationLogo");
  });
});
