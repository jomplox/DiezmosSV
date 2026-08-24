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
const runbookReceiptStart = "## Frontera de correo de recibo Stripe";
const runbookReceiptEnd = "## Por qué Embedded Checkout y no un Payment Link";

function boundedReceiptBoundary(
  document: string,
  file: string,
  startSentinel: string,
  endSentinel: string
): string {
  const start = uniqueSentinelIndex(document, file, "start", startSentinel);
  const end = uniqueSentinelIndex(document, file, "end", endSentinel);
  if (end <= start) throw new Error(`${file}: receipt-email boundary sentinels are out of order`);

  return document.slice(start, end);
}

function uniqueSentinelIndex(
  document: string,
  file: string,
  boundary: "start" | "end",
  sentinel: string
): number {
  const first = document.indexOf(sentinel);
  if (first < 0) throw new Error(`${file}: receipt-email boundary ${boundary} sentinel is missing`);
  if (document.indexOf(sentinel, first + sentinel.length) >= 0) {
    throw new Error(`${file}: receipt-email boundary ${boundary} sentinel is duplicated`);
  }
  return first;
}

const requiredRuntimeNames = [
  "STRIPE_RESTRICTED_KEY",
  "STRIPE_PUBLISHABLE_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_WEBHOOK_SECRET_NEXT",
  "STRIPE_PAYMENT_METHOD_CONFIGURATION_ID",
  "STRIPE_BILLING_PORTAL_CONFIGURATION_ID",
  "STRIPE_US_LEGAL_NAME",
  "STRIPE_US_EIN",
  "STRIPE_US_TIME_ZONE",
  "STRIPE_US_PHONE",
  "STRIPE_US_WEBSITE",
  "STRIPE_US_MAILING_ADDRESS",
  "STRIPE_US_SIGNER_NAME",
  "STRIPE_US_SIGNER_TITLE"
] as const;

describe("Stripe US giving provisioning documentation", () => {
  it("fails closed when a receipt-boundary sentinel is missing, reversed, or duplicated", () => {
    const start = runbookReceiptStart;
    const end = runbookReceiptEnd;
    const file = "docs/stripe-us-giving.fixture.md";
    const cases = [
      { document: `before ${end}`, expected: `${file}: receipt-email boundary start sentinel is missing` },
      { document: `${start} after`, expected: `${file}: receipt-email boundary end sentinel is missing` },
      { document: `${end} before ${start}`, expected: `${file}: receipt-email boundary sentinels are out of order` },
      { document: `${start} earlier ${start} body ${end}`, expected: `${file}: receipt-email boundary start sentinel is duplicated` },
      { document: `${start} body ${end} later ${end}`, expected: `${file}: receipt-email boundary end sentinel is duplicated` }
    ];

    for (const { document, expected } of cases) {
      expect(() => boundedReceiptBoundary(document, file, start, end)).toThrow(expected);
    }
    expect(boundedReceiptBoundary(`before ${start} body ${end} after`, file, start, end)).toBe(`${start} body `);
  });

  it("mirrors the Stripe runtime and Givebutter build configuration contracts in both canonical READMEs", () => {
    for (const document of [english, spanish]) {
      for (const name of requiredRuntimeNames) expect(document).toContain(name);
      expect(document).toContain("STRIPE_MOCK_MODE");
      expect(document).toContain("docs/stripe-us-giving.md");
      expect(document).toContain("Givebutter");
      expect(document).toContain("VITE_GIVEBUTTER_CAMPAIGN");
      expect(document).toContain("VITE_GIVEBUTTER_TITHE_FUND_ID");
      expect(document).toContain("VITE_GIVEBUTTER_OFFERING_FUND_ID");
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

  it("documents the account-level Stripe receipt boundary and one-Elim-acknowledgment verification", () => {
    const runbookBoundary = boundedReceiptBoundary(
      runbook,
      "docs/stripe-us-giving.md",
      runbookReceiptStart,
      runbookReceiptEnd
    );
    expect(runbookBoundary).toMatch(/receipt_email/);
    expect(runbookBoundary).toMatch(/customer_details\.email/);
    expect(runbookBoundary).toMatch(/Dashboard.*Settings.*Business.*Customer emails.*Payments.*Successful payments/is);
    expect(runbookBoundary).toMatch(/account-level|nivel de cuenta/i);
    expect(runbookBoundary).toMatch(/no.*Checkout Session|ninguna.*Checkout Session/i);
    expect(runbookBoundary).toMatch(/freeze|congelamiento/i);
    expect(runbookBoundary).toMatch(/subscription service emails|correos.*servicio.*suscripci/i);
    expect(runbookBoundary).toMatch(/exactly one Elim-branded acknowledgment|exactamente un acuse.*Elim/is);

    const englishBoundary = boundedReceiptBoundary(
      english,
      "README.md",
      "**Stripe receipt-email boundary.",
      "The pure Stripe.js loader"
    );
    expect(englishBoundary).toMatch(/receipt_email.*customer_details\.email.*separate/is);
    expect(englishBoundary).toMatch(/Dashboard\s*→\s*Settings\s*→\s*Business\s*→\s*Customer emails\s*→\s*Payments\s*→\s*disable `Successful payments`/is);
    expect(englishBoundary).toMatch(/account-level Customer emails setting, not a per-Checkout\s+Session option/is);
    expect(englishBoundary).toMatch(/Do not change it during the current production freeze/is);
    expect(englishBoundary).toMatch(/subscription service emails.*distinct from successful-payment receipts.*separately approved/is);
    expect(englishBoundary).toMatch(/one controlled donation.*exactly one\s+Elim-branded acknowledgment/is);

    const spanishBoundary = boundedReceiptBoundary(
      spanish,
      "README.es.md",
      "**Frontera de correo de recibo Stripe.",
      "El cargador puro de Stripe.js"
    );
    expect(spanishBoundary).toMatch(/receipt_email.*customer_details\.email.*distinto/is);
    expect(spanishBoundary).toMatch(/Dashboard\s*→\s*Settings\s*→\s*Business\s*→\s*Customer emails\s*→\s*Payments\s*→\s*disable `Successful payments`/is);
    expect(spanishBoundary).toMatch(/a nivel de cuenta,\s*no una opción por Checkout Session/is);
    expect(spanishBoundary).toMatch(/No la cambie durante el congelamiento actual de producción/is);
    expect(spanishBoundary).toMatch(/correos de servicio de suscripción requeridos y distintos.*se apruebe cambiarlos por separado/is);
    expect(spanishBoundary).toMatch(/donación controlada.*exactamente un acuse.*Elim/is);
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
      "charge.succeeded",
      "charge.refunded"
    ]) {
      expect(runbook).toContain(event);
    }
    expect(runbook).toContain("/webhooks/stripe");
    expect(runbook).toMatch(/firma.*cuerpo crudo|cuerpo crudo.*firma/is);
  });

  it("documents deterministic Checkout recovery without absence heuristics", () => {
    const durableRecovery = runbook.slice(
      runbook.indexOf("## Firma, idempotencia y datos durables"),
      runbook.indexOf("## Configuración Stripe EE. UU. en el panel")
    );
    expect(durableRecovery).toMatch(/ambiguo.*misma.*idempotency key|misma.*idempotency key.*ambiguo/is);
    expect(durableRecovery).toMatch(/no.*rota.*automáticamente|nunca.*rota.*automáticamente/is);
    expect(durableRecovery).toMatch(/ruta de estado.*adjunt|adjunt.*ruta de estado/is);
    expect(durableRecovery).toMatch(/webhook firmado.*adjunt|adjunt.*webhook firmado/is);
    expect(durableRecovery).toMatch(/huella SHA-256.*parámetros canónicos|parámetros canónicos.*huella SHA-256/is);
    expect(durableRecovery).toMatch(/configuración.*cambia.*no.*llama a Stripe|no.*llama a Stripe.*configuración.*cambia/is);
    expect(durableRecovery).toMatch(/tres intentos.*indeterminad|indeterminad.*tres intentos/is);
    expect(durableRecovery).toMatch(/misma identidad.*webhook firmado|webhook firmado.*misma identidad/is);
    expect(durableRecovery).not.toContain("checkout.sessions.list");
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
    expect(runbook).toMatch(/promover.*intercambia.*activo.*siguiente/is);
    expect(runbook).not.toMatch(/promueve.*elimina el valor preparado/is);
  });

  it("documents the explicit single-rail SV-to-US safety restart in both READMEs", () => {
    expect(english).toMatch(/does not mint a Wompi link on Step 1/i);
    expect(english).toMatch(/returns to an explicit U\.S\. Step 1/i);
    expect(english).toMatch(/no Stripe Session exists until.*confirm/is);
    expect(spanish).toMatch(/no crea un enlace Wompi en el Paso 1/i);
    expect(spanish).toMatch(/regresa\s+al\s+Paso 1 explícito de EE\. UU\./i);
    expect(spanish).toMatch(/no existe ninguna Checkout Session de Stripe hasta.*confirme/is);
  });

  it("keeps every additive Stripe migration in the rollback preservation boundary", () => {
    const rollback = runbook.slice(runbook.indexOf("## Handoff del propietario y rollback"));
    for (const migration of ["0032", "0033", "0034", "0035", "0036", "0037", "0038", "0039", "0040", "0041", "0042", "0043", "0044", "0046"]) {
      expect(rollback).toContain(migration);
    }
    expect(rollback).toMatch(/no.*elimine|conserve/is);
    expect(rollback).toContain("DONATION_INTAKE_DISABLED");
    expect(rollback).toMatch(/revisión.*Stripe|Stripe.*revisión/is);
    for (const route of [
      "/webhooks/stripe",
      "/api/donations/stripe/session/",
      "/api/donations/stripe/portal"
    ]) {
      expect(rollback).toContain(route);
    }
    expect(rollback).toMatch(/constancias|acknowledgment|acuses/i);
    expect(rollback).not.toContain("revierta el Worker al SHA anterior");
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
    expect(devVars).toContain('STRIPE_US_PHONE="+1 555 010 0100"');
    expect(devVars).toContain('STRIPE_US_WEBSITE="https://example.org"');
    expect(devVars).toContain('STRIPE_US_MAILING_ADDRESS="100 Test Avenue\\nNew York, NY 10001, USA"');
    expect(devVars).toContain('STRIPE_US_SIGNER_NAME="Authorized Representative"');
    expect(devVars).toContain('STRIPE_US_SIGNER_TITLE="Treasurer"');
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

  it("documents the target-bound Givebutter campaign without moving Stripe into Vite", () => {
    expect(localArtifacts).toContain("VITE_GIVEBUTTER_CAMPAIGN");
    expect(localArtifacts).toMatch(/givebutter/i);
    expect(localArtifacts).toMatch(/Stripe.*runtime|runtime.*Stripe/is);
  });
});
