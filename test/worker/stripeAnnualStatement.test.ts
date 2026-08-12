import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildStripeAnnualStatementPreview,
  buildStripeAnnualStatementSnapshot,
  renderStripeAnnualStatementPdf,
  sendStripeAnnualStatements,
  stripeAnnualStatementEmailContent,
  stripeUsCurrentYear,
  stripeUsYearWindow
} from "../../src/worker/services/stripeAnnualStatement";
import { Repository } from "../../src/worker/storage/repository";
import type { StripeAnnualStatementGift } from "../../src/worker/storage/repository/stripeAnnualStatements";
import type { Env } from "../../src/worker/types";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { migratedDatabase } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";

describe("Stripe U.S. annual statement calendar", () => {
  it("fails closed without a valid configured IANA zone outside Stripe mock mode", () => {
    expect(() => stripeUsYearWindow({}, 2025)).toThrow(/STRIPE_US_TIME_ZONE/);
    expect(() => stripeUsYearWindow({ STRIPE_US_TIME_ZONE: "Not/AZone" }, 2025)).toThrow(/STRIPE_US_TIME_ZONE/);
  });

  it("uses America/New_York in deterministic mock mode and respects local year edges", () => {
    expect(stripeUsYearWindow({ STRIPE_MOCK_MODE: "1" }, 2025)).toEqual({
      timeZone: "America/New_York",
      startIso: "2025-01-01T05:00:00.000Z",
      endIso: "2026-01-01T05:00:00.000Z"
    });
  });

  it("derives the current statement year in the validated U.S. timezone", () => {
    const boundary = new Date("2026-01-01T00:30:00.000Z");

    expect(stripeUsCurrentYear({ STRIPE_MOCK_MODE: "1" }, boundary)).toBe(2025);
    expect(stripeUsCurrentYear({ STRIPE_US_TIME_ZONE: "America/Los_Angeles" }, boundary)).toBe(2025);
    expect(() => stripeUsCurrentYear({ STRIPE_US_TIME_ZONE: "Not/AZone" }, boundary)).toThrow(/STRIPE_US_TIME_ZONE/);
  });
});

describe("Stripe U.S. annual statement snapshot and rendering", () => {
  it("hashes normalized identity and ordered durable refund facts, including a zero-net refund", async () => {
    const gifts = [
      gift({ id: "gift_b", settled_at: "2025-07-01T12:00:00.000Z", gift_type: "OFFERING", frequency: "MONTHLY", amount_cents: 5_000, refunded_amount_cents: 5_000, status: "REFUNDED" }),
      gift({ id: "gift_a", settled_at: "2025-01-02T12:00:00.000Z", amount_cents: 10_000 })
    ];
    const snapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "ana@example.org",
      donorName: " Ana ",
      donorEmail: " ANA@Example.ORG ",
      document: statementDocument(),
      gifts
    });

    expect(snapshot.donor).toEqual({ key: "ana@example.org", name: "Ana", email: "ana@example.org" });
    expect(snapshot.items.map((item) => ({ id: item.sourceId, net: item.netAmountCents }))).toEqual([
      { id: "pi_gift_a", net: 10_000 },
      { id: "pi_gift_b", net: 0 }
    ]);
    expect(snapshot.totals).toEqual({ count: 2, grossAmountCents: 15_000, refundedAmountCents: 5_000, netAmountCents: 10_000 });
    expect(snapshot.hash).toMatch(/^[a-f0-9]{64}$/);

    const changed = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "ana@example.org",
      donorName: "Ana",
      donorEmail: "ana@example.org",
      document: statementDocument(),
      gifts: gifts.map((row) => row.id === "gift_a" ? { ...row, refunded_amount_cents: 100, status: "PARTIALLY_REFUNDED", net_amount_cents: 9_900 } : row)
    });
    expect(changed.hash).not.toBe(snapshot.hash);

    const changedConfiguration = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "ana@example.org",
      donorName: "Ana",
      donorEmail: "ana@example.org",
      document: statementDocument({ legalName: "Friends of Example Church — Updated" }),
      gifts
    });
    expect(changedConfiguration.hash).not.toBe(snapshot.hash);
    expect(JSON.parse(changedConfiguration.canonicalJson)).toMatchObject({
      document: {
        rendererVersion: expect.any(String),
        legalName: "Friends of Example Church — Updated",
        ein: "12-3456789",
        timeZone: "America/New_York"
      }
    });
  });

  it("renders the U.S. legal identity, itemized types/refunds, substantiation, and neutral disclaimer", async () => {
    const snapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "ana@example.org",
      donorName: "Ana",
      donorEmail: "ana@example.org",
      document: statementDocument(),
      gifts: [
        gift({ id: "gift_tithe", settled_at: "2025-01-02T12:00:00.000Z", gift_type: "TITHE", amount_cents: 10_000 }),
        gift({ id: "gift_refund", settled_at: "2025-07-01T12:00:00.000Z", gift_type: "OFFERING", amount_cents: 5_000, refunded_amount_cents: 5_000, status: "REFUNDED" })
      ]
    });
    const bytes = await renderStripeAnnualStatementPdf({
      snapshot,
      issuedOn: "2026-01-10T12:00:00.000Z",
      corrected: true
    });
    const directory = mkdtempSync(join(tmpdir(), "stripe-annual-"));
    const pdfPath = join(directory, "statement.pdf");
    writeFileSync(pdfPath, bytes);
    const text = execFileSync("pdftotext", ["-layout", pdfPath, "-"], { encoding: "utf8" });

    expect(text).toContain("Constancia anual de donaciones — EE. UU.");
    expect(text).toContain("CONSTANCIA CORREGIDA");
    expect(text).toContain("Friends of Example Church, Inc.");
    expect(text).toContain("EIN: 12-3456789");
    expect(text).toContain("Diezmo");
    expect(text).toContain("Ofrenda");
    expect(text).toContain("$50.00");
    expect(text).toContain("$0.00");
    expect(text).toContain("No se proporcionaron bienes ni servicios a cambio de estas donaciones.");
    expect(text).toContain("no constituye asesoría fiscal");
    expect(text).not.toMatch(/Ministerio de Hacienda|\bMH\b|\bCDE\b|deducible garantizada/i);
    expect(readFileSync(pdfPath).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("renders unsupported Unicode deterministically without changing source identity", async () => {
    const snapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "unicode@example.org",
      donorName: "李 😊 García",
      donorEmail: "unicode@example.org",
      document: statementDocument({ legalName: "Iglesia 李 😊" }),
      gifts: [gift({ id: "gift_unicode", donor_name: "李 😊 García", donor_email: "unicode@example.org" })]
    });

    expect(snapshot.donor.name).toBe("李 😊 García");
    await expect(renderStripeAnnualStatementPdf({
      snapshot,
      issuedOn: "2026-01-10T12:00:00.000Z",
      corrected: false
    })).resolves.toBeInstanceOf(Uint8Array);
  });

  it("builds distinct U.S. Spanish email copy for original and corrected statements", () => {
    const original = stripeAnnualStatementEmailContent({
      donorName: "Ana",
      year: 2025,
      count: 2,
      netTotalCents: 10_000,
      corrected: false,
      branding: { organizationName: "Example Church" }
    });
    const corrected = stripeAnnualStatementEmailContent({
      donorName: "Ana",
      year: 2025,
      count: 2,
      netTotalCents: 9_900,
      corrected: true,
      branding: { organizationName: "Example Church" }
    });
    expect(original.subject).toBe("Constancia anual de donaciones 2025 — EE. UU.");
    expect(corrected.subject).toBe("Constancia anual corregida de donaciones 2025 — EE. UU.");
    expect(corrected.text).toContain("reemplaza la constancia anterior");
    for (const content of [original, corrected]) {
      expect(content.text).toContain("No se proporcionaron bienes ni servicios");
      expect(content.text).not.toMatch(/Ministerio de Hacienda|\bMH\b|\bCDE\b|validez fiscal/i);
    }
  });
});

describe("Stripe U.S. annual statement preview and delivery", () => {
  let database: ReturnType<typeof migratedDatabase>;
  let repo: Repository;
  let workerEnv: Env;
  let emailSend: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    database = migratedDatabase();
    const db = sqliteD1(database);
    repo = new Repository(db);
    emailSend = vi.fn().mockResolvedValue({ messageId: "annual-provider-id" });
    workerEnv = env(new InMemoryD1(), {
      DB: db,
      APP_ENV: "local",
      STRIPE_MOCK_MODE: "1",
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "sender@example.org",
      EMAIL: { send: emailSend } as unknown as SendEmail
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    database.close();
  });

  it("returns a 50-row preview with an opaque no-email row and stable continuation", async () => {
    for (let index = 0; index < 50; index += 1) seedGift(database, gift({ id: `gift_${String(index).padStart(2, "0")}`, donor_email: `donor${String(index).padStart(2, "0")}@example.org` }));
    seedGift(database, gift({ id: "gift_no_email", donor_email: null, donor_name: "Sin Correo" }));

    const preview = await buildStripeAnnualStatementPreview(workerEnv, repo, 2025, false);
    expect(preview.donors).toHaveLength(50);
    expect(preview.hasMore).toBe(true);
    expect(preview.nextCursor).toBe("donor49@example.org");

    const next = await buildStripeAnnualStatementPreview(workerEnv, repo, 2025, false, preview.nextCursor);
    expect(next.donors).toEqual([expect.objectContaining({ donorKey: "gift:gift_no_email", hasEmail: false })]);
  });

  it("threads a trimmed preview query to the grouped Stripe donor search", async () => {
    seedGift(database, gift({ id: "gift_match", donor_email: "match@example.org", donor_name: "Ana Matching" }));
    seedGift(database, gift({ id: "gift_nonmatch", donor_email: "other@example.org", donor_name: "No coincide" }));

    const preview = await buildStripeAnnualStatementPreview(workerEnv, repo, 2025, false, null, "  MATCHING  ");

    expect(preview.donors).toEqual([expect.objectContaining({ donorKey: "match@example.org", donorName: "Ana Matching" })]);
  });

  it("deduplicates an identical send and emits a corrected revision after a durable refund", async () => {
    seedGift(database, gift({ id: "gift_send", amount_cents: 10_000 }));

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", { donor: "ana@example.org", now: "2026-01-10T12:00:00.000Z" }))
      .toMatchObject({ sent: 1, skipped: 0, failed: 0, review: 0 });
    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", { donor: "ana@example.org", now: "2026-01-10T12:01:00.000Z" }))
      .toMatchObject({ sent: 0, skipped: 1 });

    database.prepare("UPDATE stripe_gifts SET refunded_amount_cents = 2500, status = 'PARTIALLY_REFUNDED' WHERE id = 'gift_send'").run();
    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", { donor: "ana@example.org", now: "2026-01-10T12:02:00.000Z" }))
      .toMatchObject({ sent: 1, skipped: 0 });

    expect(database.prepare(
      "SELECT revision, supersedes_delivery_id, status FROM stripe_annual_statement_deliveries ORDER BY revision"
    ).all()).toEqual([
      { revision: 1, supersedes_delivery_id: null, status: "SENT" },
      { revision: 2, supersedes_delivery_id: expect.any(String), status: "SENT" }
    ]);
    expect(emailSend).toHaveBeenCalledTimes(2);
    expect((emailSend.mock.calls[1][0] as { subject: string }).subject).toContain("corregida");
  });

  it("records dispatch-start evidence before deterministic mock acceptance", async () => {
    seedGift(database, gift({ id: "gift_mock_dispatch" }));
    workerEnv = { ...workerEnv, MOCK_EXTERNAL_SERVICES: "true", EMAIL: undefined };

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 1, failed: 0, review: 0 });
    expect(database.prepare(
      "SELECT status, dispatch_started_at, provider_id_hash FROM stripe_annual_statement_deliveries"
    ).get()).toEqual({
      status: "SENT",
      dispatch_started_at: "2026-01-10T12:00:00.000Z",
      provider_id_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/)
    });
  });

  it("moves an ambiguous post-dispatch outcome to REVIEW and never retries it", async () => {
    seedGift(database, gift({ id: "gift_review" }));
    emailSend.mockRejectedValue(Object.assign(new Error("private provider response"), { code: "E_UNKNOWN" }));

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", { donor: "ana@example.org", now: "2026-01-10T12:00:00.000Z" }))
      .toMatchObject({ sent: 0, review: 1 });
    expect(database.prepare("SELECT status, retry_safe, failure_code FROM stripe_annual_statement_deliveries").get())
      .toEqual({ status: "REVIEW", retry_safe: 0, failure_code: "E_UNKNOWN" });

    emailSend.mockResolvedValue({ messageId: "must-not-send" });
    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", { donor: "ana@example.org", now: "2026-01-10T12:01:00.000Z" }))
      .toMatchObject({ sent: 0, skipped: 0, review: 1 });
    expect(emailSend).toHaveBeenCalledTimes(1);
  });

  it("fences every changed snapshot while a donor-year provider outcome is in REVIEW", async () => {
    seedGift(database, gift({ id: "gift_review_changed", amount_cents: 10_000 }));
    emailSend.mockRejectedValueOnce(Object.assign(new Error("private provider response"), { code: "E_UNKNOWN" }));

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 0, review: 1 });

    database.prepare("UPDATE stripe_gifts SET refunded_amount_cents = 2500, status = 'PARTIALLY_REFUNDED' WHERE id = 'gift_review_changed'").run();
    emailSend.mockResolvedValue({ messageId: "must-not-send-changed-review" });
    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:01:00.000Z"
    })).toMatchObject({ sent: 0, review: 1, failed: 0 });
    expect(emailSend).toHaveBeenCalledTimes(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM stripe_annual_statement_deliveries").get())
      .toEqual({ count: 1 });
  });

  it("blocks every legacy duplicate PENDING revision from provider dispatch", async () => {
    const originalGift = gift({ id: "gift_duplicate_pending", amount_cents: 10_000 });
    seedGift(database, originalGift);
    const document = statementDocument({
      legalName: "Nonprofit Test Fixture",
      ein: "00-0000000"
    });
    const originalSnapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "ana@example.org",
      donorName: "Ana",
      donorEmail: "ana@example.org",
      document,
      gifts: [originalGift]
    });
    const changedSnapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "ana@example.org",
      donorName: "Ana",
      donorEmail: "ana@example.org",
      document,
      gifts: [{
        ...originalGift,
        status: "PARTIALLY_REFUNDED",
        refunded_amount_cents: 100,
        net_amount_cents: 9_900
      }]
    });
    insertPendingStatement(database, "delivery_pending_original", 1, originalSnapshot);
    insertPendingStatement(database, "delivery_pending_changed", 2, changedSnapshot);

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 0, skipped: 1, failed: 0, review: 0 });

    database.prepare(
      "UPDATE stripe_gifts SET refunded_amount_cents = 100, status = 'PARTIALLY_REFUNDED' WHERE id = 'gift_duplicate_pending'"
    ).run();
    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:01:00.000Z"
    })).toMatchObject({ sent: 0, skipped: 1, failed: 0, review: 0 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT id, status, attempt_count FROM stripe_annual_statement_deliveries ORDER BY revision"
    ).all()).toEqual([
      { id: "delivery_pending_original", status: "PENDING", attempt_count: 0 },
      { id: "delivery_pending_changed", status: "PENDING", attempt_count: 0 }
    ]);
  });

  it("rechecks the immutable snapshot immediately before dispatch and fails safely when it changed", async () => {
    seedGift(database, gift({ id: "gift_race", amount_cents: 10_000 }));
    const originalRead = repo.listStripeAnnualStatementDonorGifts.bind(repo);
    let reads = 0;
    vi.spyOn(repo, "listStripeAnnualStatementDonorGifts").mockImplementation(async (...args) => {
      const rows = await originalRead(...args);
      reads += 1;
      return reads === 2
        ? rows.map((row) => ({
            ...row,
            status: "PARTIALLY_REFUNDED" as const,
            refunded_amount_cents: 100,
            net_amount_cents: row.amount_cents - 100
          }))
        : rows;
    });

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 0, failed: 1, review: 0 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT status, failure_code, retry_safe, dispatch_started_at FROM stripe_annual_statement_deliveries"
    ).get()).toEqual({
      status: "FAILED",
      failure_code: "snapshot_changed_before_dispatch",
      retry_safe: 1,
      dispatch_started_at: null
    });
  });

  it("includes freshly reread donor identity in the pre-dispatch snapshot recheck", async () => {
    seedGift(database, gift({ id: "gift_identity_race", donor_name: "Ana Original" }));
    const originalRead = repo.listStripeAnnualStatementDonorGifts.bind(repo);
    let reads = 0;
    vi.spyOn(repo, "listStripeAnnualStatementDonorGifts").mockImplementation(async (...args) => {
      const rows = await originalRead(...args);
      reads += 1;
      return reads === 2 ? rows.map((row) => ({ ...row, donor_name: "Ana Corregida" })) : rows;
    });

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 0, failed: 1 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT status, failure_code FROM stripe_annual_statement_deliveries"
    ).get()).toEqual({ status: "FAILED", failure_code: "snapshot_changed_before_dispatch" });
  });

  it("rechecks the snapshot after PDF rendering and immediately before provider dispatch", async () => {
    seedGift(database, gift({ id: "gift_render_race", amount_cents: 10_000 }));
    const originalSave = PDFDocument.prototype.save;
    vi.spyOn(PDFDocument.prototype, "save").mockImplementation(async function (this: PDFDocument, ...args) {
      database.prepare(
        "UPDATE stripe_gifts SET refunded_amount_cents = 100, status = 'PARTIALLY_REFUNDED' WHERE id = 'gift_render_race'"
      ).run();
      return originalSave.apply(this, args);
    });

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 0, failed: 1, review: 0 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT status, failure_code, dispatch_started_at FROM stripe_annual_statement_deliveries"
    ).get()).toEqual({
      status: "FAILED",
      failure_code: "snapshot_changed_before_dispatch",
      dispatch_started_at: null
    });
  });

  it("aborts before provider dispatch when the snapshot changes during dispatch authorization", async () => {
    seedGift(database, gift({ id: "gift_dispatch_authorization_race", amount_cents: 10_000 }));
    const originalMarkDispatchStarted = repo.markStripeAnnualStatementDispatchStarted.bind(repo);
    vi.spyOn(repo, "markStripeAnnualStatementDispatchStarted").mockImplementation(async (input) => {
      const marked = await originalMarkDispatchStarted(input);
      database.prepare(
        "UPDATE stripe_gifts SET refunded_amount_cents = 100, status = 'PARTIALLY_REFUNDED' WHERE id = 'gift_dispatch_authorization_race'"
      ).run();
      return marked;
    });

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 0, failed: 1, review: 0 });
    expect(emailSend).not.toHaveBeenCalled();
    expect(database.prepare(
      "SELECT status, failure_code, retry_safe, dispatch_started_at FROM stripe_annual_statement_deliveries"
    ).get()).toEqual({
      status: "FAILED",
      failure_code: "snapshot_changed_before_dispatch",
      retry_safe: 1,
      dispatch_started_at: "2026-01-10T12:00:00.000Z"
    });
  });

  it("keeps a durable SENT outcome authoritative when its follow-up audit write fails", async () => {
    seedGift(database, gift({ id: "gift_sent_audit" }));
    const createAudit = vi.spyOn(repo, "createAudit")
      .mockRejectedValueOnce(new Error("audit unavailable"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(await sendStripeAnnualStatements(workerEnv, repo, 2025, false, "user_operator", {
      donor: "ana@example.org",
      now: "2026-01-10T12:00:00.000Z"
    })).toMatchObject({ sent: 1, failed: 0, review: 0 });
    expect(database.prepare("SELECT status, sent_at FROM stripe_annual_statement_deliveries").get())
      .toEqual({ status: "SENT", sent_at: "2026-01-10T12:00:00.000Z" });
    expect(createAudit).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({
      event: "stripe_annual_statement_audit_failed"
    }));
  });
});

function statementDocument(overrides: Partial<{
  legalName: string;
  ein: string;
  timeZone: string;
}> = {}) {
  return {
    rendererVersion: "stripe-annual-statement-pdf:v1" as const,
    legalName: overrides.legalName ?? "Friends of Example Church, Inc.",
    ein: overrides.ein ?? "12-3456789",
    timeZone: overrides.timeZone ?? "America/New_York",
    accentColor: "#0f766e",
    logo: null
  };
}

function gift(overrides: Partial<StripeAnnualStatementGift> & { id: string }): StripeAnnualStatementGift {
  const amountCents = overrides.amount_cents ?? 1_000;
  const refundedCents = overrides.refunded_amount_cents ?? 0;
  return {
    id: overrides.id,
    source_type: "PAYMENT_INTENT",
    source_id: overrides.source_id ?? `pi_${overrides.id}`,
    checkout_id: overrides.checkout_id ?? `checkout_${overrides.id}`,
    stripe_payment_intent_id: overrides.stripe_payment_intent_id ?? `pi_${overrides.id}`,
    stripe_invoice_id: null,
    stripe_subscription_id: null,
    frequency: overrides.frequency ?? "ONCE",
    gift_type: overrides.gift_type ?? "TITHE",
    amount_cents: amountCents,
    currency: "usd",
    donor_name: overrides.donor_name ?? "Ana",
    donor_email: overrides.donor_email === undefined ? "ana@example.org" : overrides.donor_email,
    settled_at: overrides.settled_at ?? "2025-06-01T12:00:00.000Z",
    status: overrides.status ?? "PAID",
    refunded_amount_cents: refundedCents,
    net_amount_cents: overrides.net_amount_cents ?? amountCents - refundedCents,
    created_at: overrides.created_at ?? "2025-06-01T12:00:00.000Z",
    updated_at: overrides.updated_at ?? "2025-06-01T12:00:00.000Z"
  };
}

function seedGift(database: ReturnType<typeof migratedDatabase>, row: StripeAnnualStatementGift): void {
  database.prepare(
    `INSERT INTO stripe_checkout_sessions (
       id, request_id, request_fingerprint, frequency, gift_type, amount_cents,
       livemode, status, payment_status
     ) VALUES (?, ?, ?, ?, ?, ?, 0, 'COMPLETE', 'PAID')`
  ).run(row.checkout_id, `request_${row.id}`, `fingerprint_${row.id}`, row.frequency, row.gift_type, row.amount_cents);
  database.prepare(
    `INSERT INTO stripe_gifts (
       id, source_type, source_id, checkout_id, stripe_payment_intent_id,
       frequency, gift_type, amount_cents, donor_name, donor_email, settled_at,
       status, refunded_amount_cents
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.source_type,
    row.source_id,
    row.checkout_id,
    row.stripe_payment_intent_id,
    row.frequency,
    row.gift_type,
    row.amount_cents,
    row.donor_name,
    row.donor_email,
    row.settled_at,
    row.status,
    row.refunded_amount_cents
  );
}

function insertPendingStatement(
  database: ReturnType<typeof migratedDatabase>,
  id: string,
  revision: number,
  snapshot: Awaited<ReturnType<typeof buildStripeAnnualStatementSnapshot>>
): void {
  database.prepare(
    `INSERT INTO stripe_annual_statement_deliveries (
       id, year, livemode, donor_key, donor_name, donor_email,
       snapshot_hash, snapshot_json, revision, status, created_at, updated_at
     ) VALUES (?, 2025, 0, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)`
  ).run(
    id,
    snapshot.donor.key,
    snapshot.donor.name,
    snapshot.donor.email,
    snapshot.hash,
    snapshot.canonicalJson,
    revision,
    "2026-01-10T11:00:00.000Z",
    "2026-01-10T11:00:00.000Z"
  );
}
