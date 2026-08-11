import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const english = read("README.md");
const spanish = read("README.es.md");
const runbook = read("docs/stripe-us-giving.md");
const localArtifacts = read("docs/local-private-artifacts.md");
const devVars = read(".dev.vars.example");
const publicWrangler = read("wrangler.toml");
const annualCertificateRaces = read("e2e/annualCertificateRaces.spec.ts");
const adminUiCoverage = read("e2e/adminUiCoverage.spec.ts");

const requiredRuntimeNames = [
  "STRIPE_RESTRICTED_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_WEBHOOK_SECRET_NEXT",
  "STRIPE_PAYMENT_METHOD_CONFIGURATION_ID",
  "STRIPE_BILLING_PORTAL_CONFIGURATION_ID",
  "STRIPE_US_LEGAL_NAME",
  "STRIPE_US_EIN",
  "STRIPE_US_TIME_ZONE"
] as const;

describe("Stripe US giving provisioning documentation", () => {
  it("mirrors the runtime-only configuration contract in both canonical READMEs", () => {
    for (const document of [english, spanish]) {
      for (const name of requiredRuntimeNames) expect(document).toContain(name);
      expect(document).toContain("STRIPE_MOCK_MODE");
      expect(document).toContain("docs/stripe-us-giving.md");
      expect(document).not.toMatch(/givebutter/i);
      expect(document).not.toContain("VITE_STRIPE");
    }
  });

  it("documents dynamic eligible methods with BNPL excluded by account configuration", () => {
    expect(runbook).toContain("payment_method_configuration");
    expect(runbook).toContain("payment_method_types");
    expect(runbook).toMatch(/dinámic/i);
    expect(runbook).toMatch(/BNPL/);
    for (const financingMethod of ["Affirm", "Afterpay/Clearpay", "Klarna", "Scalapay", "Sunbit", "Zip"]) {
      expect(runbook).toContain(financingMethod);
    }
    expect(runbook).toMatch(/elegibilidad.*donante|donante.*elegibilidad/is);
    expect(runbook).toMatch(/dominio.*Apple Pay|Apple Pay.*dominio/is);
  });

  it("pins least privilege, environment separation, and the owner-only handoff", () => {
    expect(runbook).toContain("rk_test_");
    expect(runbook).toContain("rk_live_");
    expect(runbook).toContain("pk_test_");
    expect(runbook).toContain("pk_live_");
    expect(runbook).toMatch(/publicable.*navegador|navegador.*publicable/is);
    expect(runbook).not.toContain("sk_live_");
    expect(runbook).toMatch(/Checkout Sessions.*Write/is);
    expect(runbook).toMatch(/Billing Portal.*Write/is);
    expect(runbook).toMatch(/sandbox.*antes.*live/is);
    expect(runbook).toMatch(/no.*cambiar.*live|no.*modificar.*live/is);
    expect(runbook).toContain("Cloudflare secret");
  });

  it("lists every event consumed by the signed idempotent webhook", () => {
    for (const event of [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired",
      "invoice.paid",
      "invoice.payment_failed",
      "invoice_payment.paid",
      "customer.subscription.deleted",
      "charge.refunded"
    ]) {
      expect(runbook).toContain(event);
    }
    expect(runbook).toContain("/webhooks/stripe");
    expect(runbook).toMatch(/firma.*cuerpo crudo|cuerpo crudo.*firma/is);
  });

  it("documents the complete U.S. gift, reporting, and safe owner-control contract", () => {
    for (const document of [english, spanish]) {
      for (const term of [
        "Diezmo",
        "Ofrenda",
        "Única",
        "Mensual",
        "Embedded Checkout",
        "Constancia anual",
        "STRIPE_WEBHOOK_SECRET_NEXT"
      ]) {
        expect(document).toContain(term);
      }
    }
    expect(english).toMatch(/not a Salvadoran CDE|never a Salvadoran CDE/i);
    expect(spanish).toMatch(/no un CDE salvadoreño|nunca es un CDE/i);

    for (const route of [
      "GET /api/settings/stripe",
      "POST /api/settings/stripe",
      "POST /api/settings/stripe/webhook-secret/stage",
      "POST /api/settings/stripe/webhook-secret/promote",
      "POST /api/settings/stripe/webhook-secret/cancel"
    ]) {
      expect(runbook).toContain(route);
    }

    expect(runbook).toMatch(/Configurado.*no.*verificad|no.*verificad.*Configurado/is);
    expect(runbook).toMatch(/desconocid|ambiguo|incierto/is);
    expect(runbook).toMatch(/Payment Method Configuration.*BNPL|BNPL.*Payment Method Configuration/is);
    expect(runbook).toMatch(/prueba.*live|live.*prueba/is);
  });

  it("keeps mock mode local/staging-only and out of production examples", () => {
    expect(devVars).toContain('STRIPE_MOCK_MODE="1"');
    expect(publicWrangler).toMatch(/\[vars\][\s\S]*STRIPE_MOCK_MODE\s*=\s*"1"/);
    const production = publicWrangler.slice(publicWrangler.indexOf("[env.production]"));
    expect(production).not.toContain("STRIPE_MOCK_MODE");
    expect(runbook).toMatch(/STRIPE_MOCK_MODE.*prohibid/is);
  });

  it("keeps the staged webhook secret and U.S. statement timezone in local examples", () => {
    expect(devVars).toContain('STRIPE_WEBHOOK_SECRET_NEXT="whsec_replace-with-next-endpoint-secret"');
    expect(devVars).toContain('STRIPE_US_TIME_ZONE="America/New_York"');
  });

  it("keeps U.S. annual fixture hydration read-only", () => {
    expect(annualCertificateRaces).toContain(
      'url.pathname === "/api/statements/stripe/annual" && route.request().method() === "GET"'
    );
    expect(adminUiCoverage).toContain(
      'url.pathname === "/api/statements/stripe/annual" && request.method() === "GET"'
    );
    expect(adminUiCoverage).toContain(
      'url.pathname === "/api/settings/stripe" && request.method() === "GET"'
    );
  });

  it("removes the obsolete client campaign value from private artifacts", () => {
    expect(localArtifacts).not.toMatch(/givebutter|VITE_GIVEBUTTER/i);
    expect(localArtifacts).toMatch(/Stripe.*runtime|runtime.*Stripe/is);
  });
});
