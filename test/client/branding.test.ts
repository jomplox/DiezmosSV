import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRANDING_ACCENT_CSS_VAR,
  BRANDING_LOGO_ACCEPT,
  CLIENT_BRANDING_DEFAULTS,
  brandingFieldError,
  brandingDonorLogoSrc,
  brandingLogoSrc,
  parseBrandingResponse
} from "../../src/client/branding";

const stylesSource = readFileSync(resolve(import.meta.dirname, "../../src/client/styles.css"), "utf8");
const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");
const credentialsPanelSource = readFileSync(resolve(import.meta.dirname, "../../src/client/credentialsPanel.tsx"), "utf8");
const donarSource = readFileSync(resolve(import.meta.dirname, "../../src/client/donarPage.tsx"), "utf8");
const indexSource = readFileSync(resolve(import.meta.dirname, "../../index.html"), "utf8");
const mainSource = readFileSync(resolve(import.meta.dirname, "../../src/client/main.tsx"), "utf8");

describe("parseBrandingResponse", () => {
  it("falls back to defaults for an empty payload", () => {
    expect(parseBrandingResponse({})).toEqual({
      displayName: CLIENT_BRANDING_DEFAULTS.displayName,
      accentColor: CLIENT_BRANDING_DEFAULTS.accentColor,
      supportEmail: CLIENT_BRANDING_DEFAULTS.supportEmail,
      logoVersion: null,
      donorLogoVersion: null
    });
  });

  it("passes through a full payload", () => {
    expect(
      parseBrandingResponse({
        displayName: "Iglesia Central",
        accentColor: "#123abc",
        supportEmail: "legacy-email-119@example.com",
        logoVersion: "v1",
        donorLogoVersion: "donor-v1"
      })
    ).toEqual({
      displayName: "Iglesia Central",
      accentColor: "#123abc",
      supportEmail: "legacy-email-119@example.com",
      logoVersion: "v1",
      donorLogoVersion: "donor-v1"
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

  it("references the public donor logo endpoint separately", () => {
    expect(brandingDonorLogoSrc("donor123")).toBe("/api/branding/donor-logo?v=donor123");
    expect(brandingDonorLogoSrc(null)).toBeNull();
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

  it("keeps a neutral startup shell visible until branding has resolved", () => {
    expect(appSource).toContain("brandingReady");
    expect(appSource).toContain("setBrandingReady(true)");
    expect(appSource).toContain("return <StartupShell />");
    expect(appSource.indexOf("if (!brandingReady)")).toBeLessThan(appSource.indexOf("if (!token || !user)"));
  });
});

describe("static bootstrap shell", () => {
  it("uses the donor ceremony name as the initial browser title", () => {
    expect(indexSource).toContain("<title>Diezmos y Ofrendas</title>");
  });

  it("does not paint a donor-shaped placeholder before the public React page mounts", () => {
    expect(indexSource).toMatch(
      /html\[data-bootstrap-route="donor"\]\s+#app-bootstrap\s*\{\s*display:\s*none;/
    );
    expect(indexSource).not.toContain("bootstrap-donor-card");
  });

  it("keeps the donor root hidden until the document fonts are ready", () => {
    expect(indexSource).toMatch(
      /html\[data-bootstrap-route="donor"\]\s+#root\s*\{\s*visibility:\s*hidden;/
    );
    expect(stylesSource).toMatch(
      /html\[data-bootstrap-route="donor"\]\[data-donor-ready\]\s+#root\s*\{\s*visibility:\s*visible;/
    );
    expect(mainSource).toContain("document.fonts?.ready");
    expect(mainSource).toContain('setAttribute("data-donor-ready", "")');
  });

  it("renders a neutral admin shell before React loads", () => {
    expect(indexSource).toContain('id="app-bootstrap"');
    expect(indexSource).toContain("bootstrap-admin-shell");
    expect(indexSource).toContain("data-bootstrap-route");

    const bootstrapRegion = indexSource.slice(
      indexSource.indexOf('<style id="bootstrap-shell-styles">'),
      indexSource.indexOf('<script type="module"')
    );
    expect(bootstrapRegion).not.toContain("#0f766e");
    expect(bootstrapRegion).not.toContain("#007c75");
    expect(bootstrapRegion).not.toContain("ExamplePerson1");
  });

  it("removes the static shell only after the React app has mounted", () => {
    expect(mainSource).toContain("useEffect");
    expect(mainSource).toContain('document.getElementById("app-bootstrap")?.remove()');
    expect(mainSource).toContain("<BootstrappedApp />");
  });
});

describe("BrandingEditor edits the support email (source contract)", () => {
  it("offers a 'Correo de soporte' input saved through the branding PUT", () => {
    // The Marca form gains a support-email field alongside name + color; it is sent to
    // /api/settings/branding and explained as the contact shown on donor pages + emails.
    expect(credentialsPanelSource).toContain("Correo de soporte");
    expect(credentialsPanelSource).toContain("supportEmail");
    // Validation runs through the shared brandingFieldError helper before the round-trip.
    expect(credentialsPanelSource).toContain("brandingFieldError(");
  });
});

describe("Donor landing uses the uploaded logo when present (source contract)", () => {
  it("renders the donor logo image and keeps the default vector fallback", () => {
    expect(donarSource).toContain("brandingDonorLogoSrc");
    expect(donarSource).toContain("donorLogoVersion");
    expect(donarSource).toContain("OrganizationLogo");
    expect(donarSource).not.toContain("brandingLogoSrc(branding.logoVersion)");
  });
});

describe("BrandingEditor renders a live Vista previa block (source contract)", () => {
  it("shows a captioned preview block with both channel mocks", () => {
    // A "Vista previa" block below the logo controls with two side-by-side miniature
    // mocks, each with a Spanish caption describing where the branding will show.
    expect(credentialsPanelSource).toContain("Vista previa");
    expect(credentialsPanelSource).toContain("branding-preview");
    expect(credentialsPanelSource).toContain("Así se verá en los correos");
    expect(credentialsPanelSource).toContain("Así se verá en la página de donación");
    // Labeled channels: an email chrome mock and a donor landing card mock.
    expect(credentialsPanelSource).toContain("Correo");
    expect(credentialsPanelSource).toContain("Página de donación");
  });

  it("explains that email clients can adjust the preview in dark mode", () => {
    expect(credentialsPanelSource).toContain("Vista aproximada.");
    expect(credentialsPanelSource).toContain("modo oscuro");
  });

  it("drives the preview from the editor's unsaved draft values", () => {
    // The email header mock tints with the draft accent color (colorForPicker) and shows
    // the draft display name; the footer shows the draft support email. The logo comes
    // from the draft admin/email preview object URL or the current admin/email logo src.
    const previewStart = credentialsPanelSource.indexOf("branding-preview");
    const previewRegion = credentialsPanelSource.slice(previewStart, previewStart + 3000);
    expect(previewRegion).toContain("colorForPicker");
    expect(previewRegion).toContain("displayName");
    expect(previewRegion).toContain("supportEmail");
    expect(previewRegion).toContain("previewUrl");
    expect(previewRegion).toContain("currentLogoSrc");
    expect(previewRegion).toContain("currentDonorLogoSrc");
  });

  it("keeps the donor-page mock monochrome (never tinted with the accent)", () => {
    // The donor landing is monochrome by design: its mock must not paint the accent
    // color onto the card. Only the email mock's header carries the accent.
    const donorMockStart = credentialsPanelSource.indexOf("branding-preview-donor");
    expect(donorMockStart).toBeGreaterThan(-1);
    const donorMock = credentialsPanelSource.slice(donorMockStart, donorMockStart + 700);
    expect(donorMock).not.toContain("colorForPicker");
    expect(donorMock).toContain("Diezmos y Ofrendas");
  });
});

describe("Marca supports separate admin/email and donor logos (source contract)", () => {
  it("offers independent upload controls for the admin/email logo and donor logo", () => {
    expect(credentialsPanelSource).toContain("Logo de administración y correos");
    expect(credentialsPanelSource).toContain("Logo para donantes");
    expect(credentialsPanelSource).toContain("/api/settings/branding/logo");
    expect(credentialsPanelSource).toContain("/api/settings/branding/donor-logo");
  });

  it("uses the donor logo on white authentication surfaces", () => {
    const authScreenStart = appSource.indexOf("function AuthScreen");
    const authScreen = appSource.slice(authScreenStart, authScreenStart + 4500);

    expect(authScreen).toContain("brandingDonorLogoSrc(branding.donorLogoVersion) ?? brandingLogoSrc(branding.logoVersion)");
    expect(authScreen).toContain('src={authLogoSrc}');
  });

  it("keeps email preview tied to the admin logo and donor preview tied to the donor logo", () => {
    const emailMockStart = credentialsPanelSource.indexOf("branding-preview-email");
    const emailMock = credentialsPanelSource.slice(emailMockStart, emailMockStart + 1200);
    expect(emailMock).toContain("previewUrl");
    expect(emailMock).toContain("currentLogoSrc");
    expect(emailMock).not.toContain("currentDonorLogoSrc");

    const donorMockStart = credentialsPanelSource.indexOf("branding-preview-donor");
    const donorMock = credentialsPanelSource.slice(donorMockStart, donorMockStart + 1000);
    expect(donorMock).toContain("donorPreviewUrl");
    expect(donorMock).toContain("currentDonorLogoSrc");
    expect(donorMock).not.toContain("colorForPicker");
  });

  it("allocates wide slots instead of square icon slots for uploaded logos", () => {
    expect(stylesSource).toMatch(/\.brand-logo\s*{[^}]*width:\s*56px;[^}]*height:\s*44px;/s);
    expect(stylesSource).toMatch(/\.sidebar\.collapsed\s+\.brand-logo\s*{[^}]*width:\s*44px;[^}]*height:\s*36px;/s);
    expect(stylesSource).toMatch(/\.auth-logo\s*{[^}]*width:\s*min\(240px,\s*76%\);[^}]*max-height:\s*112px;/s);
    expect(stylesSource).toMatch(/\.branding-logo-preview\s*{[^}]*width:\s*168px;[^}]*height:\s*118px;[^}]*background:\s*var\(--surface\);/s);
    expect(stylesSource).toMatch(/\.branding-preview-email-logo\s*{[^}]*max-height:\s*44px;[^}]*max-width:\s*184px;/s);
  });

  it("hides native file inputs in every branded upload control", () => {
    expect(stylesSource).toMatch(/input\.file-input-hidden\s*{[^}]*position:\s*absolute;[^}]*clip:\s*rect\(0,\s*0,\s*0,\s*0\);/s);
    expect(stylesSource).toMatch(/\.branding-logo-controls\s*{[^}]*gap:\s*12px;/s);
  });

  it("centers and spaces the login branding block", () => {
    expect(stylesSource).toMatch(/\.auth-logo\s*{[^}]*margin-bottom:\s*14px;/s);
    expect(stylesSource).toMatch(/\.auth-card h1\s*{[^}]*margin-bottom:\s*15px;[^}]*text-align:\s*center;/s);
  });

  it("stacks the sidebar admin logo above the organization name and product label", () => {
    expect(appSource).toContain("<span>DiezmosSV</span>");
    expect(stylesSource).toMatch(/\.brand\s*{[^}]*display:\s*grid;[^}]*justify-items:\s*start;/s);
    expect(stylesSource).toMatch(/\.brand-text\s*{[^}]*display:\s*grid;[^}]*gap:\s*2px;/s);
    expect(stylesSource).toMatch(/\.sidebar\.collapsed\s+\.brand\s*{[^}]*justify-items:\s*center;/s);
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

  it("the donor-page preview mark follows the draft name, not a hardcoded default", () => {
    // Without a logo, the donor mock's placeholder mark must show the DRAFT organization
    // name (like the email mock) so both previews stay consistent while editing.
    const panelSource = readFileSync(resolve(import.meta.dirname, "../../src/client/credentialsPanel.tsx"), "utf8");
    expect(panelSource).toContain('className="branding-preview-donor-mark">{displayName || "ExamplePerson1"}');
  });
});
