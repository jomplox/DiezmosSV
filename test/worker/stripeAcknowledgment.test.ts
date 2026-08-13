import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, PDFPage } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailService } from "../../src/worker/services/email";
import {
  deliverNextStripeAcknowledgment,
  renderStripeAcknowledgmentPdf,
  stripeAcknowledgmentContent
} from "../../src/worker/services/stripeAcknowledgment";
import * as stripePdfAssets from "../../src/worker/services/stripePdfAssets";
import { Repository } from "../../src/worker/storage/repository";
import type { Env } from "../../src/worker/types";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { migratedDatabase } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";

describe("Spanish Stripe 501(c)(3) acknowledgment", () => {
  const directories: string[] = [];
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
    directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
  });

  it("embeds the approved logo asset for the immediate receipt", () => {
    const assets = stripePdfAssets as Record<string, unknown>;
    const bytes = assets.STRIPE_RECEIPT_ELIM_LOGO_BYTES as Uint8Array;

    expect(assets.STRIPE_RECEIPT_ELIM_LOGO_SHA256)
      .toBe("57bc3660089f4046d42ab3598c1be039d0911a9d0540f0355e9227d42815fac1");
    expect(createHash("sha256").update(bytes).digest("hex"))
      .toBe("57bc3660089f4046d42ab3598c1be039d0911a9d0540f0355e9227d42815fac1");
    expect(pngDimensions(bytes)).toEqual({ width: 300, height: 120 });
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

  it("renders the approved logo at readable scale on a U.S. Letter charitable receipt", async () => {
    const drawImage = vi.spyOn(PDFPage.prototype, "drawImage");
    const drawRectangle = vi.spyOn(PDFPage.prototype, "drawRectangle");
    const drawText = vi.spyOn(PDFPage.prototype, "drawText");
    const bytes = await renderStripeAcknowledgmentPdf({
      donorName: "Edith Anaya",
      amountCents: 90_000,
      refundedAmountCents: 0,
      frequency: "ONCE",
      giftType: "OFFERING",
      sourceId: "pi_30298",
      paymentMethod: "Apple Pay",
      settledAt: "2024-12-31T17:00:00.000Z",
      timeZone: "America/New_York",
      legalName: "Friends of Misión Cristiana Elim",
      ein: "82-0889012",
      organizationName: "Misión Cristiana Elim",
      supportEmail: "fmce@example.org",
      organizationPhone: "+1 (786) 505-8446",
      organizationWebsite: "https://www.elim.click",
      organizationMailingAddress: [
        "2885 Sanford Ave SW, PMB 41357",
        "Grandville, MI 49418, USA"
      ],
      signerName: "Mathieu Guély",
      signerTitle: "Treasurer",
      kind: "ORIGINAL"
    });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    const metadataDirectory = mkdtempSync(join(tmpdir(), "stripe-ack-version-"));
    directories.push(metadataDirectory);
    const metadataPath = join(metadataDirectory, "receipt.pdf");
    writeFileSync(metadataPath, bytes);
    expect(execFileSync("pdfinfo", [metadataPath], { encoding: "utf8" }))
      .toContain("Producer:        stripe-acknowledgment-pdf:v6");
    expect(pdf.getPage(0).getMediaBox()).toEqual({ x: 0, y: 0, width: 612, height: 792 });

    expect(drawImage).toHaveBeenCalledTimes(1);
    const logoCall = drawImage.mock.calls[0];
    if (!logoCall) throw new Error("Receipt logo was not drawn");
    const [logo, logoOptions] = logoCall;
    if (!logoOptions) throw new Error("Receipt logo dimensions were not supplied");
    expect({ width: logo.width, height: logo.height }).toEqual({ width: 300, height: 120 });
    expect(logoOptions.width).toBeGreaterThanOrEqual(180);
    expect(logoOptions.height).toBeGreaterThanOrEqual(60);
    expect(logoOptions.width! / logoOptions.height!).toBeCloseTo(300 / 120, 8);

    const directory = mkdtempSync(join(tmpdir(), "stripe-ack-pdf-"));
    directories.push(directory);
    const pdfPath = join(directory, "receipt.pdf");
    writeFileSync(pdfPath, bytes);
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });
    const normalizedText = text.replace(/\s+/g, " ");
    expect(text).toContain("Dear Edith Anaya,");
    expect(text).toContain("Receipt of Charitable Donation:");
    expect(text).toContain("DONATION AMOUNT: $900.00 USD");
    expect(text).toContain("PAYMENT METHOD: Apple Pay");
    expect(text).toContain("DONATION STATUS: Completado");
    expect(text).toContain("PAYMENT ID: pi_30298");
    expect(text).not.toContain("DONATION METHOD:");
    expect(text).not.toContain("DONATION ID:");
    expect(normalizedText).toContain("No goods or services were provided in exchange for your contribution.");
    expect(text).toContain("Friends of Misión Cristiana Elim");
    expect(text).toContain("Mathieu Guély");
    expect(text).toContain("Treasurer");
    expect(text).toContain("+1 (786) 505-8446");
    expect(text).toContain("2885 Sanford Ave SW, PMB 41357");
    expect(text).toContain("A 501(c)(3) Public Charity");
    expect(text).toContain("EIN 82-0889012");
    expect(text).toContain("Malaquías 3:10");
    expect(text).not.toMatch(/Ministerio de Hacienda|\bMH\b|\bCDE\b/i);
    expect(readFileSync(pdfPath).subarray(0, 4).toString()).toBe("%PDF");

    expect(drawRectangle.mock.calls).toContainEqual([
      expect.objectContaining({ x: 0, y: 0, width: 612, height: 169 })
    ]);
    expect(normalizedText).toContain("fmce@example.org • +1 (786) 505-8446");
    expect(normalizedText).toContain("2885 Sanford Ave SW, PMB 41357 Grandville, MI 49418, USA");
    expect(normalizedText).toContain("incorporada en Washington, D.C.");
    expect(normalizedText).toContain("Misión Cristiana Elim en El Salvador");
    expect(text).not.toContain("https://www.elim.click");
    for (const contact of ["fmce@example.org • +1 (786) 505-8446"]) {
      const contactCall = drawText.mock.calls.find(([drawn]) => drawn === contact);
      if (!contactCall?.[1]?.font || typeof contactCall[1].x !== "number") {
        throw new Error(`Centered receipt contact line missing: ${contact}`);
      }
      const center = contactCall[1].x
        + contactCall[1].font.widthOfTextAtSize(contact, contactCall[1].size ?? 12) / 2;
      expect(center).toBeCloseTo(306, 1);
    }
    const headingIndex = drawText.mock.calls.findIndex(([drawn]) => drawn === "Receipt of Charitable Donation:");
    const signerIndex = drawText.mock.calls.findIndex(([drawn]) => drawn === "Mathieu Guély");
    expect(drawText.mock.calls.slice(signerIndex, headingIndex).some(([drawn]) =>
      drawn === "Friends of Misión Cristiana Elim"
    )).toBe(true);
    expect(drawText.mock.calls.slice(signerIndex, headingIndex).some(([drawn]) =>
      drawn === "Misión Cristiana Elim"
    )).toBe(false);
    const salutation = drawText.mock.calls.find(([text]) => text === "Dear Edith Anaya,");
    expect(logoOptions.y).toBeGreaterThan((salutation?.[1]?.y ?? Number.POSITIVE_INFINITY) + 24);
  });

  it("preserves maximum renderer-safe names, contacts, and all four address lines", async () => {
    const legalName = `LEGAL ${"L".repeat(74)}`;
    const signerName = `SIGNER ${"S".repeat(53)}`;
    const signerTitle = `TITLE ${"T".repeat(54)}`;
    const supportEmail = `${"e".repeat(88)}@example.org`;
    const phone = `+1${"2".repeat(38)}`;
    const website = `https://example.org/${"w".repeat(80)}`;
    const address = [1, 2, 3, 4].map((line) => `ADDRESS-${line} ${"A".repeat(70)}`);
    expect([legalName.length, signerName.length, signerTitle.length, supportEmail.length, phone.length, website.length])
      .toEqual([80, 60, 60, 100, 40, 100]);
    expect(address.map((line) => line.length)).toEqual([80, 80, 80, 80]);
    const drawText = vi.spyOn(PDFPage.prototype, "drawText");
    const bytes = await renderStripeAcknowledgmentPdf({
      donorName: "Maximum Contact Donor",
      amountCents: 10_000,
      refundedAmountCents: 0,
      frequency: "ONCE",
      giftType: "TITHE",
      sourceId: "pi_max_contact",
      settledAt: "2025-01-01T12:00:00.000Z",
      timeZone: "America/New_York",
      legalName,
      ein: "12-3456789",
      organizationName: "Maximum Contact Ministry",
      supportEmail,
      organizationPhone: phone,
      organizationWebsite: website,
      organizationMailingAddress: address,
      signerName,
      signerTitle,
      kind: "ORIGINAL"
    });
    const directory = mkdtempSync(join(tmpdir(), "stripe-ack-max-contact-"));
    directories.push(directory);
    const pdfPath = join(directory, "receipt.pdf");
    writeFileSync(pdfPath, bytes);
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });
    for (const marker of ["LEGAL", "SIGNER", "TITLE", "example.org", "ADDRESS-1", "ADDRESS-2", "ADDRESS-3", "ADDRESS-4"]) {
      expect(text).toContain(marker);
    }
    for (const [drawn, options] of drawText.mock.calls) {
      if (!options?.font || typeof options.x !== "number" || !String(drawn).match(/LEGAL|SIGNER|TITLE|example\.org|ADDRESS-|^\+1/)) continue;
      expect(options.x).toBeGreaterThanOrEqual(45);
      expect(options.x + options.font.widthOfTextAtSize(String(drawn), options.size ?? 12)).toBeLessThanOrEqual(567);
      expect(options.y, String(drawn)).toBeGreaterThanOrEqual(176);
    }
    const contactCalls = drawText.mock.calls.filter(([drawn, options]) =>
      options?.y !== undefined
      && options.y >= 177
      && options.y <= 232
      && options.x !== 292.1
      && String(drawn).match(/example\.org|ADDRESS-|^\+1/)
    );
    expect(contactCalls.length).toBeGreaterThanOrEqual(5);
    for (const [drawn, options] of contactCalls) {
      expect(options?.y, String(drawn)).toBeGreaterThanOrEqual(177);
    }
    expectReceiptReservedBandGeometry(drawText.mock.calls, {
      legalMarker: "LEGAL",
      signerMarker: "SIGNER",
      titleMarker: "TITLE"
    });
  });

  it("fits legacy v1-v3 contact maxima above the later-painted scripture panel", async () => {
    const drawText = vi.spyOn(PDFPage.prototype, "drawText");
    const bytes = await renderStripeAcknowledgmentPdf({
      donorName: "Legacy Contact Donor",
      amountCents: 10_000,
      refundedAmountCents: 0,
      frequency: "ONCE",
      giftType: "TITHE",
      sourceId: "pi_legacy_contact",
      settledAt: "2025-01-01T12:00:00.000Z",
      timeZone: "America/New_York",
      legalName: `LEGACY-LEGAL ${"L".repeat(187)}`,
      ein: "12-3456789",
      organizationName: "Legacy Contact Ministry",
      supportEmail: `${"e".repeat(88)}@example.org`,
      organizationPhone: `+1${"2".repeat(38)}`,
      organizationWebsite: `https://example.org/${"w".repeat(180)}`,
      organizationMailingAddress: [1, 2, 3, 4].map((line) => `LEGACY-ADDRESS-${line} ${"A".repeat(183)}`),
      signerName: `LEGACY-SIGNER ${"S".repeat(106)}`,
      signerTitle: `LEGACY-TITLE ${"T".repeat(107)}`,
      kind: "ORIGINAL"
    });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    const directory = mkdtempSync(join(tmpdir(), "stripe-ack-legacy-contact-"));
    directories.push(directory);
    const pdfPath = join(directory, "receipt.pdf");
    writeFileSync(pdfPath, bytes);
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });
    for (const marker of ["LEGACY-LEGAL", "LEGACY-SIGNER", "LEGACY-TITLE", "LEGACY-ADDRESS-1", "LEGACY-ADDRESS-2", "LEGACY-ADDRESS-3", "LEGACY-ADDRESS-4"]) {
      expect(text).toContain(marker);
    }
    const contactCalls = drawText.mock.calls.filter(([, options]) =>
      options?.y !== undefined
      && options.y >= 177
      && options.y <= 232
      && options.x !== 292.1
    );
    expect(contactCalls.length).toBeGreaterThanOrEqual(8);
    for (const [drawn, options] of contactCalls) {
      if (!options?.font || typeof options.x !== "number") throw new Error("Contact draw geometry missing");
      expect(options.y, String(drawn)).toBeGreaterThanOrEqual(177);
      expect(options.x + options.font.widthOfTextAtSize(String(drawn), options.size ?? 12))
        .toBeLessThanOrEqual(567);
    }
    expectReceiptReservedBandGeometry(drawText.mock.calls, {
      legalMarker: "LEGACY-LEGAL",
      signerMarker: "LEGACY-SIGNER",
      titleMarker: "LEGACY-TITLE"
    });
  });

  it("attaches the immutable one-page receipt before crossing the email provider boundary", async () => {
    let attachment: { pdfBytes?: Uint8Array; filename?: string } | undefined;
    vi.spyOn(EmailService.prototype, "sendStripeAcknowledgment")
      .mockImplementation(async (input, beforeProviderDispatch) => {
        attachment = input;
        await beforeProviderDispatch?.();
        return { providerResponse: {}, providerDeliveryId: `sha256:${"a".repeat(64)}` };
      });

    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:01:00.000Z"
    })).toMatchObject({ outcome: "SENT" });
    expect(attachment?.filename).toBe("constancia-donacion-eeuu-stripe_ack_fixture-r1.pdf");
    expect(attachment?.pdfBytes).toBeInstanceOf(Uint8Array);
    expect(await PDFDocument.load(attachment!.pdfBytes!)).toBeInstanceOf(PDFDocument);
  });

  it("wires durable fields into the attached Stripe acknowledgment PDF", async () => {
    await repo.applyStripeRefund({
      stripePaymentIntentId: "pi_fixture",
      refundedAmountCents: 432,
      now: "2026-08-10T12:00:30.000Z"
    });
    database.prepare(
      `UPDATE stripe_gifts
          SET donor_name = ?, source_id = ?, stripe_payment_intent_id = ?, frequency = ?, gift_type = ?, amount_cents = ?
        WHERE id = 'stripe_gift_fixture'`
    ).run(
      "Donor Ack Sentinel",
      "pi_ack_source_sentinel_82",
      "pi_ack_source_sentinel_82",
      "MONTHLY",
      "OFFERING",
      5_432
    );
    database.prepare(
      "INSERT INTO app_settings (key, value) VALUES (?, ?), (?, ?)"
    ).run(
      "branding_display_name",
      "Ack Organization Sentinel",
      "branding_support_email",
      "ack-support-sentinel@example.org"
    );
    const emailSend = vi.fn().mockResolvedValue({ messageId: "ack-provider-sentinel" });
    const configuredEnv: Env = {
      ...workerEnv,
      STRIPE_MOCK_MODE: undefined,
      MOCK_EXTERNAL_SERVICES: "false",
      STRIPE_RESTRICTED_KEY: "rk_test_ack_field_wiring",
      STRIPE_PUBLISHABLE_KEY: "pk_test_ack_field_wiring",
      STRIPE_WEBHOOK_SECRET: "whsec_ack_field_wiring",
      STRIPE_PAYMENT_METHOD_CONFIGURATION_ID: "pmc_ack_field_wiring",
      STRIPE_BILLING_PORTAL_CONFIGURATION_ID: "bpc_ack_field_wiring",
      STRIPE_US_LEGAL_NAME: "Ack Legal Name Sentinel",
      STRIPE_US_EIN: "12-3456789",
      STRIPE_US_TIME_ZONE: "America/New_York",
      STRIPE_US_PHONE: "+1 555 010 8282",
      STRIPE_US_WEBSITE: "https://ack-sentinel.example.org",
      STRIPE_US_MAILING_ADDRESS: "82 Acknowledgment Way\nNew York, NY 10082, USA",
      STRIPE_US_SIGNER_NAME: "Ack Signer Sentinel",
      STRIPE_US_SIGNER_TITLE: "Acknowledgment Treasurer",
      EMAIL_FROM: "sender@example.org",
      EMAIL: { send: emailSend } as unknown as SendEmail
    };

    await expect(deliverNextStripeAcknowledgment(configuredEnv, repo, {
      now: "2026-08-10T12:01:00.000Z"
    })).resolves.toMatchObject({ outcome: "SENT" });

    const message = emailSend.mock.calls[0]?.[0] as {
      attachments?: Array<{ content: Uint8Array }>;
    };
    const pdfBytes = message.attachments?.[0]?.content;
    expect(pdfBytes).toBeInstanceOf(Uint8Array);
    const pdf = await PDFDocument.load(pdfBytes!);
    expect(pdf.getPageCount()).toBe(1);
    const directory = mkdtempSync(join(tmpdir(), "stripe-ack-wiring-"));
    directories.push(directory);
    const pdfPath = join(directory, "acknowledgment.pdf");
    writeFileSync(pdfPath, pdfBytes!);
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });
    const normalizedText = text.replace(/\s+/g, " ");

    for (const expected of [
      "Donor Ack Sentinel",
      "$54.32 USD",
      "$50.00 USD",
      "Offering · Monthly",
      "pi_ack_source_sentinel_82",
      "August 10, 2026",
      "Ack Legal Name Sentinel",
      "EIN 12-3456789",
      "Ack Organization Sentinel",
      "ack-support-sentinel@example.org",
      "+1 555 010 8282",
      "82 Acknowledgment Way",
      "New York, NY 10082, USA",
      "Ack Signer Sentinel",
      "Acknowledgment Treasurer"
    ]) {
      expect(normalizedText).toContain(expected);
    }
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

  it("emits a donor-safe operational alert when delivery needs operator attention", async () => {
    database.prepare(
      "INSERT INTO app_settings (key, value) VALUES ('alert_email', 'owner@example.org')"
    ).run();
    vi.spyOn(EmailService.prototype, "sendStripeAcknowledgment")
      .mockRejectedValue(new Error("Ana ana@example.org Bearer private-fixture"));
    const alerts: Array<{ subject: string; text: string }> = [];
    vi.spyOn(EmailService.prototype, "sendOperationalAlert")
      .mockImplementation(async (input, beforeProviderDispatch) => {
        await beforeProviderDispatch?.();
        alerts.push({ subject: input.subject, text: input.text });
        return { messageId: "alert-fixture" };
      });

    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:01:00.000Z"
    })).toMatchObject({ processed: true, outcome: "FAILED" });
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      subject: "Constancia inmediata de EE. UU. requiere atención"
    });
    expect(alerts[0].text).toContain("EMAIL_PRE_DISPATCH_FAILED");
    expect(alerts[0].text).not.toMatch(/Ana|ana@example\.org|Bearer|private-fixture/);
  });

  it("retries persisted v2 immediate-receipt evidence through the current renderer", async () => {
    let retryAttachment: Uint8Array | undefined;
    const saveSnapshot = repo.saveStripeAcknowledgmentSnapshot.bind(repo);
    vi.spyOn(repo, "saveStripeAcknowledgmentSnapshot").mockImplementationOnce(async (input) => {
      const evidence = JSON.parse(input.snapshotJson) as {
        pdf: { rendererVersion: string };
      };
      evidence.pdf.rendererVersion = "stripe-acknowledgment-pdf:v2";
      const snapshotJson = JSON.stringify(evidence);
      return saveSnapshot({
        ...input,
        snapshotJson,
        snapshotHash: createHash("sha256").update(snapshotJson).digest("hex")
      });
    });
    const send = vi.spyOn(EmailService.prototype, "sendStripeAcknowledgment")
      .mockRejectedValueOnce(new Error("failed before provider dispatch"))
      .mockImplementationOnce(async (input, beforeProviderDispatch) => {
        retryAttachment = input.pdfBytes;
        await beforeProviderDispatch?.();
        return { providerResponse: {}, providerDeliveryId: "sha256:" + "a".repeat(64) };
      });

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

    expect(JSON.parse((database.prepare(
      "SELECT snapshot_json FROM stripe_acknowledgment_deliveries"
    ).get() as { snapshot_json: string }).snapshot_json)).toMatchObject({
      pdf: { rendererVersion: "stripe-acknowledgment-pdf:v2" }
    });

    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:06:00.000Z"
    })).toMatchObject({ processed: true, outcome: "SENT" });
    expect(send).toHaveBeenCalledTimes(2);
    expect(retryAttachment).toBeInstanceOf(Uint8Array);
    expect(await PDFDocument.load(retryAttachment!)).toBeInstanceOf(PDFDocument);
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

  it("queues immutable corrected evidence and fences a stale original when a refund arrives before claim", async () => {
    await repo.applyStripeRefund({
      stripePaymentIntentId: "pi_fixture",
      refundedAmountCents: 1500,
      now: "2026-08-10T12:00:30.000Z"
    });

    expect(database.prepare(
      `SELECT revision, kind, evidence_refunded_amount_cents, status, failure_code
         FROM stripe_acknowledgment_deliveries ORDER BY revision`
    ).all()).toEqual([
      {
        revision: 1,
        kind: "ORIGINAL",
        evidence_refunded_amount_cents: 0,
        status: "FAILED",
        failure_code: "superseded_by_refund"
      },
      {
        revision: 2,
        kind: "PARTIAL_REFUND",
        evidence_refunded_amount_cents: 1500,
        status: "PENDING",
        failure_code: null
      }
    ]);
    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:01:00.000Z"
    })).toMatchObject({ processed: true, outcome: "SENT" });
  });

  it("atomically blocks provider entry when a refund lands between claim and dispatch", async () => {
    const originalMark = repo.markStripeAcknowledgmentDispatchStarted.bind(repo);
    vi.spyOn(repo, "markStripeAcknowledgmentDispatchStarted").mockImplementation(async (input) => {
      await repo.applyStripeRefund({
        stripePaymentIntentId: "pi_fixture",
        refundedAmountCents: 1000,
        now: "2026-08-10T12:01:01.000Z"
      });
      return originalMark(input);
    });
    let providerEntered = false;
    vi.spyOn(EmailService.prototype, "sendStripeAcknowledgment")
      .mockImplementation(async (_input, beforeProviderDispatch) => {
        await beforeProviderDispatch?.();
        providerEntered = true;
        return { providerResponse: {}, providerDeliveryId: `sha256:${"a".repeat(64)}` };
      });

    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:01:00.000Z"
    })).toMatchObject({ processed: true, outcome: "FAILED" });
    expect(providerEntered).toBe(false);
    expect(database.prepare(
      "SELECT status, kind FROM stripe_acknowledgment_deliveries ORDER BY revision"
    ).all()).toEqual([
      { status: "FAILED", kind: "ORIGINAL" },
      { status: "PENDING", kind: "PARTIAL_REFUND" }
    ]);
  });

  it("preserves SENT evidence and sends idempotent partial and full refund corrections", async () => {
    const messages: Array<{ subject: string; text: string }> = [];
    vi.spyOn(EmailService.prototype, "sendStripeAcknowledgment")
      .mockImplementation(async (input, beforeProviderDispatch) => {
        await beforeProviderDispatch?.();
        messages.push({ subject: input.subject, text: input.text });
        return { providerResponse: {}, providerDeliveryId: `sha256:${String(messages.length).repeat(64)}` };
      });
    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:01:00.000Z"
    })).toMatchObject({ outcome: "SENT" });

    await repo.applyStripeRefund({
      stripePaymentIntentId: "pi_fixture",
      refundedAmountCents: 1000,
      now: "2026-08-10T12:02:00.000Z"
    });
    await repo.applyStripeRefund({
      stripePaymentIntentId: "pi_fixture",
      refundedAmountCents: 1000,
      now: "2026-08-10T12:02:01.000Z"
    });
    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:03:00.000Z"
    })).toMatchObject({ outcome: "SENT" });
    expect(messages[1].subject).toContain("corregida");
    expect(messages[1].text).toContain("$10.00 USD");
    expect(messages[1].text).toContain("$40.00 USD");

    await repo.applyStripeRefund({
      stripePaymentIntentId: "pi_fixture",
      refundedAmountCents: 5000,
      now: "2026-08-10T12:04:00.000Z"
    });
    await repo.applyStripeRefund({
      stripePaymentIntentId: "pi_fixture",
      refundedAmountCents: 5000,
      now: "2026-08-10T12:04:01.000Z"
    });
    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:05:00.000Z"
    })).toMatchObject({ outcome: "SENT" });
    expect(messages[2].subject).toContain("revocada");
    expect(messages[2].text).toContain("reembolso total");
    expect(database.prepare(
      "SELECT revision, kind, status FROM stripe_acknowledgment_deliveries ORDER BY revision"
    ).all()).toEqual([
      { revision: 1, kind: "ORIGINAL", status: "SENT" },
      { revision: 2, kind: "PARTIAL_REFUND", status: "SENT" },
      { revision: 3, kind: "FULL_REFUND", status: "SENT" }
    ]);
  });

  it("reuses the immutable email evidence after mutable branding drifts", async () => {
    database.prepare(
      "INSERT INTO app_settings (key, value) VALUES ('branding_display_name', 'Organización Original')"
    ).run();
    let sentHtml = "";
    vi.spyOn(EmailService.prototype, "sendStripeAcknowledgment")
      .mockRejectedValueOnce(new Error("pre-provider fixture"))
      .mockImplementationOnce(async (input, beforeProviderDispatch) => {
        await beforeProviderDispatch?.();
        sentHtml = input.html;
        return { providerResponse: {}, providerDeliveryId: `sha256:${"b".repeat(64)}` };
      });

    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:01:00.000Z"
    })).toMatchObject({ outcome: "FAILED" });
    database.prepare(
      "UPDATE app_settings SET value = 'Organización Cambiada' WHERE key = 'branding_display_name'"
    ).run();
    expect(await deliverNextStripeAcknowledgment(workerEnv, repo, {
      now: "2026-08-10T12:06:00.000Z"
    })).toMatchObject({ outcome: "SENT" });
    expect(sentHtml).toContain("Organización Original");
    expect(sentHtml).not.toContain("Organización Cambiada");
    expect(database.prepare(
      "SELECT snapshot_hash, snapshot_json FROM stripe_acknowledgment_deliveries"
    ).get()).toEqual({
      snapshot_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      snapshot_json: expect.stringContaining("Organización Original")
    });
  });
});

type DrawTextCall = Parameters<PDFPage["drawText"]>;
type PositionedDrawTextOptions = NonNullable<DrawTextCall[1]> & {
  font: NonNullable<NonNullable<DrawTextCall[1]>["font"]>;
  x: number;
  y: number;
};

function expectReceiptReservedBandGeometry(
  calls: DrawTextCall[],
  markers: { legalMarker: string; signerMarker: string; titleMarker: string }
): void {
  const text = (call: DrawTextCall): string => String(call[0]);
  const options = (call: DrawTextCall): PositionedDrawTextOptions => {
    const value = call[1];
    if (!value?.font || typeof value.x !== "number" || typeof value.y !== "number") {
      throw new Error(`Receipt draw geometry missing for ${text(call)}`);
    }
    return value as PositionedDrawTextOptions;
  };
  const top = (call: DrawTextCall): number => {
    const value = options(call);
    return value.y + value.font.heightAtSize(value.size ?? 12);
  };
  const right = (call: DrawTextCall): number => {
    const value = options(call);
    return value.x + value.font.widthOfTextAtSize(text(call), value.size ?? 12);
  };
  const requiredIndex = (predicate: (call: DrawTextCall, index: number) => boolean, label: string): number => {
    const index = calls.findIndex(predicate);
    if (index < 0) throw new Error(`Receipt draw call missing: ${label}`);
    return index;
  };

  const headingIndex = requiredIndex(([value]) => value === "Receipt of Charitable Donation:", "receipt heading");
  const signatureStart = requiredIndex(
    ([value], index) => index < headingIndex && String(value).startsWith(markers.signerMarker),
    markers.signerMarker
  );
  const signatureCalls = calls.slice(signatureStart, headingIndex);
  expect(signatureCalls.some(([value]) => String(value).startsWith(markers.titleMarker))).toBe(true);
  const headingTop = top(calls[headingIndex]!);
  for (const call of signatureCalls) {
    const value = options(call);
    expect(value.y, text(call)).toBeGreaterThanOrEqual(headingTop + 2);
    expect(value.x, text(call)).toBeGreaterThanOrEqual(113.22);
    expect(right(call), text(call)).toBeLessThanOrEqual(498.78);
  }

  const charityIndex = requiredIndex(([value]) => value === "A 501(c)(3) Public Charity", "charity status");
  const einIndex = requiredIndex(([value]) => String(value).startsWith("EIN "), "EIN");
  const legalStart = requiredIndex(
    ([value], index) => index > headingIndex && index < charityIndex && String(value).startsWith(markers.legalMarker),
    markers.legalMarker
  );
  const leftLegalCalls = calls.slice(legalStart, charityIndex);
  expect(Math.min(...leftLegalCalls.map((call) => options(call).y)))
    .toBeGreaterThanOrEqual(top(calls[charityIndex]!) + 1.5);
  for (const call of leftLegalCalls) {
    expect(options(call).x, text(call)).toBeGreaterThanOrEqual(113.22);
    expect(right(call), text(call)).toBeLessThanOrEqual(284.22);
  }
  expect(options(calls[charityIndex]!).y)
    .toBeGreaterThanOrEqual(top(calls[einIndex]!) + 1.5);

  const spanishStart = requiredIndex(
    ([value], index) => index > einIndex && String(value).startsWith(`La Fundación ${markers.legalMarker}`),
    "Spanish legal acknowledgment"
  );
  const contactStart = requiredIndex(
    ([, value], index) => index > spanishStart
      && typeof value?.y === "number"
      && value.y <= 232
      && value.x !== 292.1,
    "contact block"
  );
  const rightLegalCalls = calls.slice(spanishStart, contactStart);
  const contactCalls = calls.filter(([, value], index) =>
    index >= contactStart
    && typeof value?.y === "number"
    && value.y >= 177
    && value.y <= 232
    && value.x !== 292.1
  );
  expect(contactCalls.length).toBeGreaterThan(0);
  expect(options(calls[einIndex]!).y)
    .toBeGreaterThanOrEqual(Math.max(...contactCalls.map(top)) + 1.5);
  expect(Math.min(...rightLegalCalls.map((call) => options(call).y)))
    .toBeGreaterThanOrEqual(Math.max(...contactCalls.map(top)) + 1.5);
  for (const call of rightLegalCalls) {
    expect(options(call).x, text(call)).toBeGreaterThanOrEqual(292.1);
    expect(right(call), text(call)).toBeLessThanOrEqual(495.2);
  }
  for (const call of contactCalls) {
    expect(options(call).x, text(call)).toBeGreaterThanOrEqual(45);
    expect(options(call).y, text(call)).toBeGreaterThanOrEqual(177);
    expect(right(call), text(call)).toBeLessThanOrEqual(567);
  }
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const buffer = Buffer.from(bytes);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

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
