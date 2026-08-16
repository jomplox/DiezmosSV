import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  nextStripeResultView,
  stripeResultViewAfterTimeout,
  type StripeResultSnapshot,
  type StripeResultView
} from "../../src/client/stripeResultPage";
import {
  GIVEBUTTER_CAMPAIGN,
  STRIPE_CHECKOUT_PATH,
  STRIPE_FREQ_MONTHLY_LABEL,
  STRIPE_FREQ_ONCE_LABEL,
  STRIPE_MONTHLY_LABEL,
  STRIPE_PORTAL_PATH,
  STRIPE_RESULT_PATH,
  STRIPE_US_COUNTRY_CODE,
  givebutterEmbedUrl,
  givebutterHostedUrl,
  isStripeHostedUrl,
  isStripeResultPath,
  stripeCheckoutBody,
  stripeIntro,
  stripeIntroSegments,
  stripeSessionIdFromSearch,
  stripeSessionPath
} from "../../src/client/donation";

const donationSource = readFileSync(resolve(import.meta.dirname, "../../src/client/donation.ts"), "utf8");
const donarSource = readFileSync(resolve(import.meta.dirname, "../../src/client/donarPage.tsx"), "utf8");
const stripeFormSource = readFileSync(resolve(import.meta.dirname, "../../src/client/stripeDonationForm.tsx"), "utf8");
const resultSource = readFileSync(resolve(import.meta.dirname, "../../src/client/stripeResultPage.tsx"), "utf8");
const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");
const mainSource = readFileSync(resolve(import.meta.dirname, "../../src/client/main.tsx"), "utf8");
const givebutterEmbedUrlUnderTest = givebutterEmbedUrl as unknown as (
  input: { amount: string; monthly: boolean; giftType: string },
  fundIds?: { tithe: string; offering: string } | null
) => string | null;
const givebutterHostedUrlUnderTest = givebutterHostedUrl as unknown as (
  input: { amount: string; monthly: boolean; giftType: string },
  fundIds: { tithe: string; offering: string } | null
) => string | null;

describe("Stripe donor browser contract", () => {
  it("pins the anonymous endpoints and the US-only route", () => {
    expect(STRIPE_CHECKOUT_PATH).toBe("/api/donations/stripe/checkout");
    expect(STRIPE_PORTAL_PATH).toBe("/api/donations/stripe/portal");
    expect(STRIPE_RESULT_PATH).toBe("/donar/stripe/resultado");
    expect(stripeSessionPath("cs_test_abc_12345678")).toBe(
      "/api/donations/stripe/session/cs_test_abc_12345678"
    );
    expect(STRIPE_US_COUNTRY_CODE).toBe("US");
  });

  it("builds the explicit gift type with amount, frequency, and idempotent browser request identifier", () => {
    const requestId = "11111111-1111-4111-8111-111111111111";
    expect(stripeCheckoutBody({ requestId, amount: " 25.00 ", monthly: false, giftType: "TITHE" })).toEqual({
      requestId,
      amount: "25.00",
      frequency: "once",
      giftType: "tithe"
    });
    expect(stripeCheckoutBody({ requestId, amount: "50", monthly: true, giftType: "OFFERING" })).toEqual({
      requestId,
      amount: "50",
      frequency: "monthly",
      giftType: "offering"
    });
  });

  it("accepts only exact Stripe-hosted HTTPS destinations", () => {
    expect(isStripeHostedUrl("https://checkout.stripe.com/c/pay/cs_test_123", "checkout")).toBe(true);
    expect(isStripeHostedUrl("https://billing.stripe.com/p/session/test", "billing")).toBe(true);
    expect(isStripeHostedUrl("https://checkout.stripe.test/c/pay/cs_test_123", "checkout", true)).toBe(true);
    expect(isStripeHostedUrl("https://checkout.stripe.test/c/pay/cs_test_123", "checkout")).toBe(false);
    expect(isStripeHostedUrl("http://checkout.stripe.com/c/pay/cs_test_123", "checkout")).toBe(false);
    expect(isStripeHostedUrl("https://checkout.stripe.com:444/c/pay/cs_test_123", "checkout")).toBe(false);
    expect(isStripeHostedUrl("https://checkout.stripe.com.evil.example/c/pay", "checkout")).toBe(false);
    expect(isStripeHostedUrl("https://user:pass@checkout.stripe.com/c/pay", "checkout")).toBe(false);
  });

  it("recognizes and validates the public result capability", () => {
    expect(isStripeResultPath(STRIPE_RESULT_PATH)).toBe(true);
    expect(isStripeResultPath(`${STRIPE_RESULT_PATH}/`)).toBe(true);
    expect(isStripeResultPath("/donar")).toBe(false);
    expect(stripeSessionIdFromSearch("?session_id=cs_test_abcdefgh")).toBe("cs_test_abcdefgh");
    expect(stripeSessionIdFromSearch("?session_id=cs_live_abc_DEF-123")).toBe("cs_live_abc_DEF-123");
    expect(stripeSessionIdFromSearch("?session_id=../admin")).toBeNull();
    expect(stripeSessionIdFromSearch("")).toBeNull();
  });

  it("preserves the production U.S. donor introduction", () => {
    expect(STRIPE_MONTHLY_LABEL).toBe("Frecuencia de la entrega");
    expect(STRIPE_FREQ_ONCE_LABEL).toBe("Única");
    expect(STRIPE_FREQ_MONTHLY_LABEL).toBe("Mensual");
    expect(stripeIntro("Iglesia Ejemplo Central")).toBe(
      "Su diezmo u ofrenda apoya a Iglesia Ejemplo Central en El Salvador. Se procesa en EE. UU. a través de Friends of Iglesia Ejemplo Central (501c3) y recibirá un recibo deducible de impuestos en EE. UU. por correo."
    );
    expect(stripeIntro(null)).toBe(
      "Su diezmo u ofrenda apoya a esta iglesia en El Salvador. Se procesa en EE. UU. a través de una organización estadounidense 501c3 y recibirá un recibo deducible de impuestos en EE. UU. por correo."
    );
    expect(stripeIntroSegments("Iglesia Ejemplo Central")).toEqual({
      beneficiary: "Su diezmo u ofrenda apoya a Iglesia Ejemplo Central en El Salvador",
      processing: "Se procesa en EE. UU. a través de Friends of Iglesia Ejemplo Central (501c3) y recibirá un recibo deducible de impuestos en EE. UU. por correo."
    });
    expect(stripeIntroSegments(null)).toEqual({
      beneficiary: "Su diezmo u ofrenda apoya a esta iglesia en El Salvador",
      processing: "Se procesa en EE. UU. a través de una organización estadounidense 501c3 y recibirá un recibo deducible de impuestos en EE. UU. por correo."
    });
  });

  it("maps each gift type to its configured Givebutter fund with explicit supported prefills", () => {
    const fundIds = { tithe: "731902", offering: "842013" } as const;
    expect(GIVEBUTTER_CAMPAIGN).toBe("example-campaign");
    const titheEmbed = givebutterEmbedUrlUnderTest(
      { amount: "100.00", monthly: false, giftType: "TITHE" },
      fundIds
    );
    const offeringHosted = givebutterHostedUrlUnderTest(
      { amount: "25.50", monthly: true, giftType: "OFFERING" },
      fundIds
    );

    expect(titheEmbed).not.toBeNull();
    expect(Object.fromEntries(new URL(titheEmbed!).searchParams)).toEqual({
      amount: "100",
      frequency: "once",
      fund: fundIds.tithe,
      goalBar: "false"
    });
    expect(offeringHosted).not.toBeNull();
    expect(Object.fromEntries(new URL(offeringHosted!).searchParams)).toEqual({
      amount: "25.5",
      frequency: "monthly",
      fund: fundIds.offering
    });
  });

  it("fails closed when the Givebutter mapping, gift type, or amount is unsupported", () => {
    expect(
      givebutterEmbedUrlUnderTest({ amount: "100.00", monthly: false, giftType: "TITHE" })
    ).toBeNull();
    expect(
      givebutterEmbedUrlUnderTest({ amount: "100.00", monthly: false, giftType: "TITHE" }, null)
    ).toBeNull();
    expect(
      givebutterEmbedUrlUnderTest(
        { amount: "100.00", monthly: false, giftType: "UNSUPPORTED" },
        { tithe: "731902", offering: "842013" }
      )
    ).toBeNull();
    expect(
      givebutterHostedUrlUnderTest(
        { amount: "not-an-amount", monthly: true, giftType: "OFFERING" },
        { tithe: "731902", offering: "842013" }
      )
    ).toBeNull();
    expect(donarSource).toContain(
      "const givebutterAvailable = givebutterFrameUrl !== null && givebutterHostedPageUrl !== null;"
    );
    expect(donarSource).toContain("{givebutterAvailable && (");
  });
});

describe("Stripe result visible transitions", () => {
  const pendingSnapshot = (status: "OPEN" | "PENDING"): StripeResultSnapshot => ({
    status,
    frequency: "ONCE",
    amountCents: 5000,
    currency: "usd",
    canManageRecurring: false,
    recurringStatus: null
  });

  it("keeps the exact checking view for repeated OPEN and PENDING snapshots", () => {
    const checking: StripeResultView = { kind: "checking" };

    expect(nextStripeResultView(checking, pendingSnapshot("OPEN"))).toBe(checking);
    expect(nextStripeResultView(checking, pendingSnapshot("PENDING"))).toBe(checking);
  });

  it.each(["PAID", "FAILED", "EXPIRED"] as const)(
    "commits the meaningful %s terminal transition",
    (status) => {
      const checking: StripeResultView = { kind: "checking" };
      const snapshot = { ...pendingSnapshot("PENDING"), status };

      expect(nextStripeResultView(checking, snapshot)).toEqual({ kind: "snapshot", value: snapshot });
    }
  );

  it("changes checking to delayed only when the polling budget expires", () => {
    const checking: StripeResultView = { kind: "checking" };
    expect(stripeResultViewAfterTimeout(checking)).toEqual({ kind: "delayed" });
  });
});

describe("Stripe donor page source contract", () => {
  it("creates one embedded Checkout Session per amount/frequency attempt and mounts Stripe's form", () => {
    expect(donarSource).toContain("STRIPE_CHECKOUT_PATH");
    expect(donarSource).toContain("stripeCheckoutBody(");
    expect(donarSource).toContain("crypto.randomUUID()");
    expect(donarSource).toContain("stripeAttemptRef.current");
    expect(donarSource).toContain("giftType: stripeGiftType");
    expect(donarSource).toContain("<StripeDonationForm");
    expect(donarSource).not.toContain("window.location.assign");
  });

  it("delegates the entire form to Stripe Embedded Checkout without pinning payment methods", () => {
    const usBlock = donarSource.slice(
      donarSource.indexOf("{/* US Stripe step"),
      donarSource.indexOf("{/* Paso 3", donarSource.indexOf("{/* US Stripe step"))
    );
    expect(usBlock).toContain('title="Formulario de donación Givebutter (en inglés)"');
    expect(usBlock).not.toContain("payment_method_types");
    expect(stripeFormSource).toContain("<EmbeddedCheckoutProvider");
    expect(stripeFormSource).toContain('<EmbeddedCheckout className="donar-stripe-frame-mount" />');
    expect(stripeFormSource).not.toContain("ExpressCheckoutElement");
    expect(stripeFormSource).not.toContain("ContactDetailsElement");
    expect(stripeFormSource).not.toContain("BillingAddressElement");
    expect(stripeFormSource).not.toContain("PaymentElement");
    expect(`${donationSource}\n${donarSource}\n${stripeFormSource}\n${resultSource}`).not.toContain(
      "payment_method_types"
    );
  });

  it("gates Givebutter behind a mapped handoff without extra provider instructions", () => {
    expect(donarSource).toContain("giftType: stripeGiftType");
    expect(donarSource).toContain("givebutterFrameUrl && givebutterHostedPageUrl");
    expect(donarSource).not.toContain(
      "Confirme en Givebutter el tipo de entrega, el monto y la frecuencia"
    );
    expect(donarSource).toContain('usProvider === "stripe"');
    expect(donarSource).toContain('usProvider === "givebutter"');
  });

  it("keeps transactional vocabulary out of every Stripe-owned donor surface", () => {
    const usBlockStart = donarSource.indexOf("{/* US Stripe step");
    const usBlock = donarSource.slice(usBlockStart, donarSource.indexOf("{/* Paso 3", usBlockStart));
    expect(`${usBlock}\n${resultSource}`).not.toMatch(
      /\b(?:pagar|pago|comprar|compra|cliente|precio|costo|checkout|carrito|orden)\b/i
    );
  });

  it("offers the U.S. gift type and frequency choices without demoting the ceremonial title", () => {
    expect(donationSource).toContain('STRIPE_GIFT_TYPE_LABEL = "Tipo de entrega"');
    expect(donationSource).toContain('STRIPE_GIFT_TYPE_TITHE_LABEL = "Diezmo"');
    expect(donationSource).toContain('STRIPE_GIFT_TYPE_OFFERING_LABEL = "Ofrenda"');
    expect(donarSource).toContain("Su entrega se realizará cada mes hasta que usted la cancele.");
    expect(donarSource).toContain("Continuar con su ofrenda");
    expect(donarSource).toContain("${summaryLabel} · ${frequencyLabel} · ${donarAmountDisplay(form.amount)}");
    expect(donarSource).toContain("<h1 className=\"donar-wizard-title\">");
  });

  it("mounts the result page anonymously and includes it in the donor reveal gate", () => {
    const resultBranch = appSource.indexOf("isStripeResultPath(");
    const authGate = appSource.indexOf("if (!token || !user)");
    expect(resultBranch).toBeGreaterThan(-1);
    expect(resultBranch).toBeLessThan(authGate);
    expect(appSource).toContain("<StripeResultPage");
    expect(mainSource).toContain("isStripeResultPath(");
  });

  it("polls durable status and offers recurring management only through the portal endpoint", () => {
    expect(resultSource).toContain("stripeSessionPath(sessionId)");
    expect(resultSource).toContain("STRIPE_RESULT_POLL_INTERVAL_MS");
    expect(resultSource).toContain("canManageRecurring");
    expect(resultSource).toContain("STRIPE_PORTAL_PATH");
    expect(resultSource).toContain("Administrar mi entrega mensual");
    expect(resultSource).toContain("Su entrega mensual necesita atención.");
    expect(resultSource).toContain("Su entrega mensual está cancelada");
    expect(resultSource).toContain("window.location.assign");
  });

  it("keeps the ceremonial title on the result surface", () => {
    expect(resultSource).toContain("<h1>{DONAR_LANDING_HEADING}</h1>");
    expect(resultSource).toContain("DONAR_STEP_TITLE_ENTREGA");
    expect(resultSource).not.toContain("donar-compact-head");
  });
});
