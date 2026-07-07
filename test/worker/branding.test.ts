import { describe, expect, it } from "vitest";
import {
  BRANDING_DEFAULTS,
  BRANDING_LOGO_MAX_BYTES,
  BRANDING_LOGO_CONTENT_TYPES,
  BrandingValidationError,
  brandingLogoExtension,
  loadEmailBranding,
  normalizeBrandingAccentColor,
  normalizeBrandingDisplayName,
  normalizeBrandingLogoContentType,
  normalizeBrandingSupportEmail,
  parseBrandingLogoMeta,
  parseBrandingSettings
} from "../../src/worker/services/branding";
import type { Env } from "../../src/worker/types";

describe("normalizeBrandingDisplayName", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeBrandingDisplayName("  Iglesia Central  ")).toBe("Iglesia Central");
  });

  it("rejects an empty name in Spanish", () => {
    expect(() => normalizeBrandingDisplayName("   ")).toThrow(BrandingValidationError);
    try {
      normalizeBrandingDisplayName("");
    } catch (error) {
      expect((error as Error).message).toContain("nombre");
    }
  });

  it("rejects a name longer than 80 characters", () => {
    expect(() => normalizeBrandingDisplayName("a".repeat(81))).toThrow(BrandingValidationError);
  });

  it("accepts a name of exactly 80 characters", () => {
    const name = "a".repeat(80);
    expect(normalizeBrandingDisplayName(name)).toBe(name);
  });

  it("rejects a non-string value", () => {
    expect(() => normalizeBrandingDisplayName(42 as unknown as string)).toThrow(BrandingValidationError);
  });
});

describe("normalizeBrandingAccentColor", () => {
  it("lowercases a valid #rrggbb color", () => {
    expect(normalizeBrandingAccentColor("#0F766E")).toBe("#0f766e");
  });

  it("accepts an already-lowercase color", () => {
    expect(normalizeBrandingAccentColor("#007c75")).toBe("#007c75");
  });

  it("rejects a 3-digit shorthand color in Spanish", () => {
    expect(() => normalizeBrandingAccentColor("#fff")).toThrow(BrandingValidationError);
    try {
      normalizeBrandingAccentColor("#fff");
    } catch (error) {
      expect((error as Error).message).toContain("color");
    }
  });

  it("rejects a color without the leading hash", () => {
    expect(() => normalizeBrandingAccentColor("0f766e")).toThrow(BrandingValidationError);
  });

  it("rejects a color with non-hex characters", () => {
    expect(() => normalizeBrandingAccentColor("#12345g")).toThrow(BrandingValidationError);
  });
});

describe("normalizeBrandingLogoContentType", () => {
  it("accepts the three supported content types", () => {
    for (const type of BRANDING_LOGO_CONTENT_TYPES) {
      expect(normalizeBrandingLogoContentType(type)).toBe(type);
    }
  });

  it("strips charset parameters from the content type", () => {
    expect(normalizeBrandingLogoContentType("image/svg+xml; charset=utf-8")).toBe("image/svg+xml");
  });

  it("rejects an unsupported content type", () => {
    expect(() => normalizeBrandingLogoContentType("image/gif")).toThrow(BrandingValidationError);
  });

  it("rejects a missing content type", () => {
    expect(() => normalizeBrandingLogoContentType(null)).toThrow(BrandingValidationError);
  });
});

describe("brandingLogoExtension", () => {
  it("maps each content type to a file extension", () => {
    expect(brandingLogoExtension("image/svg+xml")).toBe("svg");
    expect(brandingLogoExtension("image/png")).toBe("png");
    expect(brandingLogoExtension("image/jpeg")).toBe("jpg");
  });
});

describe("normalizeBrandingSupportEmail", () => {
  it("trims and lowercases a valid email", () => {
    expect(normalizeBrandingSupportEmail("  legacy-email-119@example.com  ")).toBe("legacy-email-119@example.com");
  });

  it("accepts the historical fmce contact", () => {
    expect(normalizeBrandingSupportEmail("legacy-contact-1@example.com")).toBe("legacy-contact-1@example.com");
  });

  it("rejects an empty value in Spanish", () => {
    expect(() => normalizeBrandingSupportEmail("   ")).toThrow(BrandingValidationError);
    try {
      normalizeBrandingSupportEmail("");
    } catch (error) {
      expect((error as Error).message).toContain("correo");
    }
  });

  it("rejects a malformed email in Spanish", () => {
    expect(() => normalizeBrandingSupportEmail("no-arroba")).toThrow(BrandingValidationError);
    try {
      normalizeBrandingSupportEmail("no-arroba");
    } catch (error) {
      expect((error as Error).message).toContain("correo");
    }
  });

  it("rejects an email longer than 100 characters", () => {
    const local = "a".repeat(95);
    expect(() => normalizeBrandingSupportEmail(`${local}@b.com`)).toThrow(BrandingValidationError);
  });

  it("rejects a non-string value", () => {
    expect(() => normalizeBrandingSupportEmail(42 as unknown as string)).toThrow(BrandingValidationError);
  });
});

describe("parseBrandingSettings", () => {
  it("returns the defaults when nothing is stored", () => {
    expect(parseBrandingSettings(null, null, null)).toEqual({
      displayName: BRANDING_DEFAULTS.displayName,
      accentColor: BRANDING_DEFAULTS.accentColor,
      supportEmail: BRANDING_DEFAULTS.supportEmail
    });
  });

  it("returns stored values over defaults", () => {
    expect(parseBrandingSettings("Iglesia Central", "#123456", "legacy-email-119@example.com")).toEqual({
      displayName: "Iglesia Central",
      accentColor: "#123456",
      supportEmail: "legacy-email-119@example.com"
    });
  });

  it("lowercases a stored support email and falls back when blank", () => {
    expect(parseBrandingSettings(null, null, "  legacy-email-119@example.com  ").supportEmail).toBe("legacy-email-119@example.com");
    expect(parseBrandingSettings(null, null, "   ").supportEmail).toBe(BRANDING_DEFAULTS.supportEmail);
  });
});

describe("loadEmailBranding", () => {
  const originEnv = { APP_ORIGIN: "https://iglesia.example.org" } as Env;

  it("returns the organization name, brand color, and support email from settings", async () => {
    const store: Record<string, string> = {
      branding_display_name: "Iglesia Central",
      branding_accent_color: "#123456",
      branding_support_email: "legacy-email-119@example.com"
    };
    const branding = await loadEmailBranding(
      {
        getSetting: async (key: string) => store[key] ?? null
      },
      originEnv
    );
    expect(branding).toEqual({
      organizationName: "Iglesia Central",
      brandColor: "#123456",
      supportEmail: "legacy-email-119@example.com",
      logoUrl: null
    });
  });

  it("defaults the support email to fmce when unset", async () => {
    const branding = await loadEmailBranding({ getSetting: async () => null }, originEnv);
    expect(branding.supportEmail).toBe("legacy-contact-1@example.com");
  });

  it("builds an absolute logo URL from APP_ORIGIN and the stored logo version", async () => {
    const store: Record<string, string> = {
      branding_logo: JSON.stringify({ contentType: "image/png", size: 1234, version: "v9" })
    };
    const branding = await loadEmailBranding(
      {
        getSetting: async (key: string) => store[key] ?? null
      },
      originEnv
    );
    expect(branding.logoUrl).toBe("https://iglesia.example.org/api/branding/logo?v=v9");
  });

  it("returns a null logoUrl when no logo meta is stored", async () => {
    const branding = await loadEmailBranding({ getSetting: async () => null }, originEnv);
    expect(branding.logoUrl).toBeNull();
  });

  it("trims a trailing slash on APP_ORIGIN so the logo URL has exactly one separator", async () => {
    const store: Record<string, string> = {
      branding_logo: JSON.stringify({ contentType: "image/svg+xml", size: 10, version: "abc" })
    };
    const branding = await loadEmailBranding(
      {
        getSetting: async (key: string) => store[key] ?? null
      },
      { APP_ORIGIN: "https://iglesia.example.org/" } as Env
    );
    expect(branding.logoUrl).toBe("https://iglesia.example.org/api/branding/logo?v=abc");
  });
});

describe("parseBrandingLogoMeta", () => {
  it("returns null when unset", () => {
    expect(parseBrandingLogoMeta(null)).toBeNull();
  });

  it("parses stored JSON metadata", () => {
    const meta = parseBrandingLogoMeta(JSON.stringify({ contentType: "image/png", size: 1234, version: "abc" }));
    expect(meta).toEqual({ contentType: "image/png", size: 1234, version: "abc" });
  });

  it("returns null for malformed JSON", () => {
    expect(parseBrandingLogoMeta("{not json")).toBeNull();
  });

  it("returns null when the content type is not a supported logo type", () => {
    expect(parseBrandingLogoMeta(JSON.stringify({ contentType: "image/gif", size: 1, version: "x" }))).toBeNull();
  });
});

describe("branding constants", () => {
  it("caps uploads at 512 KB", () => {
    expect(BRANDING_LOGO_MAX_BYTES).toBe(512 * 1024);
  });

  it("defaults to the historical ExamplePerson1 brand", () => {
    expect(BRANDING_DEFAULTS.displayName).toBe("ExamplePerson1");
    expect(BRANDING_DEFAULTS.accentColor).toBe("#0f766e");
    expect(BRANDING_DEFAULTS.supportEmail).toBe("legacy-contact-1@example.com");
  });
});
