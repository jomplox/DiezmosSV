import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildStripeAnnualStatementPreview,
  buildStripeAnnualStatementSnapshot,
  renderStripeAnnualStatementPdf,
  sendStripeAnnualStatements,
  stripeAnnualStatementEmailContent,
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
      gifts: gifts.map((row) => row.id === "gift_a" ? { ...row, refunded_amount_cents: 100, status: "PARTIALLY_REFUNDED", net_amount_cents: 9_900 } : row)
    });
    expect(changed.hash).not.toBe(snapshot.hash);
  });

  it("renders the U.S. legal identity, itemized types/refunds, substantiation, and neutral disclaimer", async () => {
    const snapshot = await buildStripeAnnualStatementSnapshot({
      year: 2025,
      livemode: false,
      donorKey: "ana@example.org",
      donorName: "Ana",
      donorEmail: "ana@example.org",
      gifts: [
        gift({ id: "gift_tithe", settled_at: "2025-01-02T12:00:00.000Z", gift_type: "TITHE", amount_cents: 10_000 }),
        gift({ id: "gift_refund", settled_at: "2025-07-01T12:00:00.000Z", gift_type: "OFFERING", amount_cents: 5_000, refunded_amount_cents: 5_000, status: "REFUNDED" })
      ]
    });
    const bytes = await renderStripeAnnualStatementPdf({
      snapshot,
      legalName: "Friends of Example Church, Inc.",
      ein: "12-3456789",
      timeZone: "America/New_York",
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
      .toMatchObject({ sent: 0, skipped: 1 });
    expect(emailSend).toHaveBeenCalledTimes(1);
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
});

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
