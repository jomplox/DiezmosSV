import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailService } from "../../src/worker/services/email";
import {
  deliverNextStripeAcknowledgment,
  stripeAcknowledgmentContent
} from "../../src/worker/services/stripeAcknowledgment";
import { Repository } from "../../src/worker/storage/repository";
import type { Env } from "../../src/worker/types";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { migratedDatabase } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";

describe("Spanish Stripe 501(c)(3) acknowledgment", () => {
  let database: ReturnType<typeof migratedDatabase>;
  let repo: Repository;
  let workerEnv: Env;

  beforeEach(async () => {
    database = migratedDatabase();
    const db = sqliteD1(database);
    repo = new Repository(db);
    workerEnv = {
      ...env(new InMemoryD1()),
      DB: db,
      APP_ENV: "local",
      APP_ORIGIN: "https://example.org",
      STRIPE_MOCK_MODE: "1"
    };
    await seedGift(repo);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    database.close();
  });

  it("renders escaped Spanish substantiation copy with all legally relevant facts", () => {
    const content = stripeAcknowledgmentContent({
      donorName: "Ana <Ejemplo>",
      amountCents: 5000,
      frequency: "ONCE",
      giftType: "TITHE",
      settledAt: "2026-08-10T12:00:00.000Z",
      timeZone: "America/New_York",
      legalName: "Friends & Example",
      ein: "12-3456789",
      branding: {
        organizationName: "Organización <Visible>",
        brandColor: "#0f766e",
        supportEmail: "ayuda@example.org",
        logoUrl: null
      }
    });

    expect(content.subject).toBe("Constancia de su donación");
    expect(content.text).toContain("Friends & Example");
    expect(content.text).toContain("EIN 12-3456789");
    expect(content.text).toContain("$50.00 USD");
    expect(content.text).toContain("Tipo: Diezmo");
    expect(content.text).toContain("10 de agosto de 2026");
    expect(content.text).toContain("No se proporcionaron bienes ni servicios a cambio de esta donación.");
    expect(content.text).toContain("Conserve este correo");
    expect(content.html).toContain("Friends &amp; Example");
    expect(content.html).toContain("Ana &lt;Ejemplo&gt;");
    expect(content.html).toContain("Diezmo");
    expect(content.text).not.toMatch(/\b(?:MH|CDE)\b|Ministerio de Hacienda|validez fiscal/i);
    expect(content.html).not.toContain("Ana <Ejemplo>");
  });

  it("formats the settled date in the configured U.S. timezone at the New Year boundary", () => {
    const content = stripeAcknowledgmentContent({
      donorName: "Ana",
      amountCents: 5000,
      frequency: "ONCE",
      giftType: "OFFERING",
      settledAt: "2026-01-01T00:30:00.000Z",
      timeZone: "America/New_York",
      legalName: "Friends of Example Church, Inc.",
      ein: "12-3456789",
      branding: { organizationName: "Example Church" }
    });

    expect(content.text).toContain("Fecha: 31 de diciembre de 2025");
    expect(content.text).not.toContain("Fecha: 1 de enero de 2026");
  });

  it("claims, dispatches, and finalizes one acknowledgment idempotently", async () => {
    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:01:00.000Z"
    })).toEqual({ processed: true, outcome: "SENT", giftId: "stripe_gift_fixture" });

    expect(database.prepare(
      `SELECT status, attempt_count, processing_claim_id, provider_id_hash,
              failure_code, retry_safe, sent_at
         FROM stripe_acknowledgment_deliveries`
    ).get()).toEqual({
      status: "SENT",
      attempt_count: 1,
      processing_claim_id: null,
      provider_id_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      failure_code: null,
      retry_safe: 0,
      sent_at: "2026-08-10T12:01:00.000Z"
    });
    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:02:00.000Z"
    })).toEqual({ processed: false });
  });

  it("moves an unknown provider outcome to manual review and never retries it", async () => {
    vi.spyOn(EmailService.prototype, "sendStripeAcknowledgment")
      .mockImplementation(async (_input, beforeProviderDispatch) => {
        await beforeProviderDispatch?.();
        throw new Error("ambiguous provider response with private details");
      });

    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:01:00.000Z"
    })).toEqual({ processed: true, outcome: "REVIEW", giftId: "stripe_gift_fixture" });
    expect(database.prepare(
      `SELECT status, failure_code, retry_safe, dispatch_started_at
         FROM stripe_acknowledgment_deliveries`
    ).get()).toEqual({
      status: "REVIEW",
      failure_code: "EMAIL_DISPATCH_UNKNOWN",
      retry_safe: 0,
      dispatch_started_at: "2026-08-10T12:01:00.000Z"
    });
    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:02:00.000Z"
    })).toEqual({ processed: false });
  });

  it("marks a pre-dispatch failure retry-safe and reclaims it on the next sweep", async () => {
    const send = vi.spyOn(EmailService.prototype, "sendStripeAcknowledgment")
      .mockRejectedValueOnce(new Error("failed before provider dispatch"))
      .mockResolvedValueOnce({ providerResponse: {}, providerDeliveryId: "sha256:" + "a".repeat(64) });

    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:01:00.000Z"
    })).toMatchObject({ processed: true, outcome: "FAILED" });
    expect(database.prepare(
      "SELECT status, failure_code, retry_safe FROM stripe_acknowledgment_deliveries"
    ).get()).toEqual({
      status: "FAILED",
      failure_code: "EMAIL_PRE_DISPATCH_FAILED",
      retry_safe: 1
    });

    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:02:00.000Z"
    })).toMatchObject({ processed: true, outcome: "SENT" });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("moves an absent donor address to review without invoking the provider", async () => {
    database.prepare("UPDATE stripe_gifts SET donor_email = NULL").run();
    const send = vi.spyOn(EmailService.prototype, "sendStripeAcknowledgment");

    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:01:00.000Z"
    })).toEqual({ processed: true, outcome: "REVIEW", giftId: "stripe_gift_fixture" });
    expect(send).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT status, failure_code, retry_safe FROM stripe_acknowledgment_deliveries"
    ).get()).toEqual({
      status: "REVIEW",
      failure_code: "recipient_missing",
      retry_safe: 0
    });
  });
});

async function seedGift(repo: Repository): Promise<void> {
  await repo.reserveStripeCheckout({
    id: "stripe_checkout_fixture",
    requestId: "0c2e2165-edb7-4e4b-bc50-95a7fa3cdfe5",
    requestFingerprint: "once:tithe:5000",
    frequency: "ONCE",
    giftType: "TITHE",
    amountCents: 5000,
    livemode: false,
    rateLimitClaimId: null,
    now: "2026-08-10T12:00:00.000Z"
  });
  await repo.recordStripeGiftAndAcknowledgment({
    giftId: "stripe_gift_fixture",
    acknowledgmentId: "stripe_ack_fixture",
    sourceType: "PAYMENT_INTENT",
    sourceId: "pi_fixture",
    checkoutId: "stripe_checkout_fixture",
    stripePaymentIntentId: "pi_fixture",
    stripeInvoiceId: null,
    stripeSubscriptionId: null,
    frequency: "ONCE",
    giftType: "TITHE",
    amountCents: 5000,
    donorName: "Ana Ejemplo",
    donorEmail: "ana@example.org",
    settledAt: "2026-08-10T12:00:00.000Z",
    now: "2026-08-10T12:00:01.000Z"
  });
}
