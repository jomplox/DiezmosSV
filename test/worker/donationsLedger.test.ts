import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Repository } from "../../src/worker/storage/repository";
import { migratedDatabase } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";

function seedSvGift(
  database: DatabaseSync,
  input: {
    id: string;
    status?: "PENDING" | "LINK_CREATED" | "COMPLETED" | "EXPIRED";
    paidAt?: string | null;
    createdAt?: string;
    amountCents?: number;
    giftType?: "DIEZMO" | "OFRENDA" | null;
    document?: { donorName: string; donorEmail: string | null; numeroControl: string; status?: string };
  }
): void {
  const documentId = input.document ? `doc_${input.id}` : null;
  if (input.document) {
    database.prepare(
      `INSERT INTO dte_documents (
         id, environment, codigo_generacion, numero_control, status, plain_json,
         donor_email, donor_name, amount_cents, issued_at
       ) VALUES (?, '01', ?, ?, ?, '{}', ?, ?, ?, ?)`
    ).run(
      documentId,
      `generation-${input.id}`,
      input.document.numeroControl,
      input.document.status ?? "ACCEPTED",
      input.document.donorEmail,
      input.document.donorName,
      input.amountCents ?? 2_500,
      input.paidAt ?? "2026-09-01T00:00:00.000Z"
    );
  }
  const createdAt = input.createdAt ?? input.paidAt ?? "2026-09-01T00:00:00.000Z";
  database.prepare(
    `INSERT INTO donation_intents (
       id, status, amount_cents, donor_document_type, gift_type, document_id,
       paid_at, created_at, updated_at, expires_at
     ) VALUES (?, ?, ?, '13', ?, ?, ?, ?, ?, '2030-01-01T00:00:00.000Z')`
  ).run(
    input.id,
    input.status ?? "COMPLETED",
    input.amountCents ?? 2_500,
    input.giftType ?? null,
    documentId,
    input.paidAt ?? null,
    createdAt,
    createdAt
  );
}

function seedUsGift(
  database: DatabaseSync,
  input: {
    id: string;
    settledAt: string;
    donorName?: string;
    donorEmail?: string | null;
    amountCents?: number;
    giftType?: "TITHE" | "OFFERING";
    refundedAmountCents?: number;
    status?: "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED";
    acknowledgment?: "SENT" | "PENDING";
    suppressed?: boolean;
  }
): void {
  const checkoutId = `checkout_${input.id}`;
  database.prepare(
    `INSERT INTO stripe_checkout_sessions (
       id, request_id, request_fingerprint, frequency, gift_type, amount_cents,
       livemode, status, payment_status
     ) VALUES (?, ?, ?, 'ONCE', ?, ?, 1, 'COMPLETE', 'PAID')`
  ).run(checkoutId, `request_${input.id}`, `fingerprint_${input.id}`, input.giftType ?? "TITHE", input.amountCents ?? 1_000);
  database.prepare(
    `INSERT INTO stripe_gifts (
       id, source_type, source_id, checkout_id, stripe_payment_intent_id,
       frequency, gift_type, amount_cents, donor_name, donor_email, settled_at,
       status, refunded_amount_cents, acknowledgment_suppressed
     ) VALUES (?, 'PAYMENT_INTENT', ?, ?, ?, 'ONCE', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.id,
    `pi_${input.id}`,
    checkoutId,
    `pi_${input.id}`,
    input.giftType ?? "TITHE",
    input.amountCents ?? 1_000,
    input.donorName ?? "Donante",
    input.donorEmail === undefined ? `${input.id}@example.org` : input.donorEmail,
    input.settledAt,
    input.status ?? "PAID",
    input.refundedAmountCents ?? 0,
    input.suppressed ? 1 : 0
  );
  if (input.acknowledgment) {
    const sent = input.acknowledgment === "SENT";
    database.prepare(
      `INSERT INTO stripe_acknowledgment_deliveries (
         id, gift_id, revision, kind, evidence_refunded_amount_cents, status,
         attempt_count, dispatch_started_at, sent_at, created_at, updated_at
       ) VALUES (?, ?, 1, 'ORIGINAL', 0, ?, ?, ?, ?, ?, ?)`
    ).run(
      `ack_${input.id}`,
      input.id,
      input.acknowledgment,
      sent ? 1 : 0,
      sent ? input.settledAt : null,
      sent ? input.settledAt : null,
      input.settledAt,
      input.settledAt
    );
  }
}

describe("donations ledger repository", () => {
  let database: DatabaseSync;
  let repo: Repository;

  beforeEach(() => {
    database = migratedDatabase();
    repo = new Repository(sqliteD1(database));
  });

  afterEach(() => database.close());

  it("lists received gifts from both lanes newest first, skipping unpaid intents", async () => {
    seedSvGift(database, {
      id: "di_sv_paid",
      paidAt: "2026-09-29T15:00:00.000Z",
      giftType: "DIEZMO",
      amountCents: 5_000,
      document: { donorName: "Beto Ruiz", donorEmail: "beto@example.org", numeroControl: "DTE-15-M001P004-000000000000042" }
    });
    seedSvGift(database, {
      id: "di_sv_paid_awaiting_cde",
      status: "LINK_CREATED",
      paidAt: "2026-09-30T15:00:00.000Z"
    });
    seedSvGift(database, { id: "di_sv_expired", status: "EXPIRED", createdAt: "2026-09-30T16:00:00.000Z" });
    seedSvGift(database, { id: "di_sv_pending", status: "PENDING", createdAt: "2026-09-30T17:00:00.000Z" });
    seedUsGift(database, {
      id: "stripe_gift_ana",
      settledAt: "2026-09-28T16:00:44.000Z",
      donorName: "Ana C Delgado",
      donorEmail: "ana@example.org",
      amountCents: 22_500,
      acknowledgment: "SENT"
    });
    seedUsGift(database, {
      id: "stripe_gift_legacy",
      settledAt: "2026-03-01T12:00:00.000Z",
      giftType: "OFFERING",
      refundedAmountCents: 400,
      status: "PARTIALLY_REFUNDED",
      suppressed: true
    });

    const page = await repo.listDonations({ limit: 25 });

    expect(page.donations.map((row) => row.id)).toEqual([
      "di_sv_paid_awaiting_cde",
      "di_sv_paid",
      "stripe_gift_ana",
      "stripe_gift_legacy"
    ]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.donations[1]).toEqual({
      id: "di_sv_paid",
      lane: "SV",
      receivedAt: "2026-09-29T15:00:00.000Z",
      amountCents: 5_000,
      refundedAmountCents: 0,
      frequency: "ONCE",
      giftType: "DIEZMO",
      donorName: "Beto Ruiz",
      donorEmail: "beto@example.org",
      documentId: "doc_di_sv_paid",
      numeroControl: "DTE-15-M001P004-000000000000042",
      documentStatus: "ACCEPTED",
      giftStatus: null,
      acknowledgmentStatus: null
    });
    expect(page.donations[0]).toMatchObject({ lane: "SV", documentId: null, numeroControl: null, donorName: null });
    expect(page.donations[2]).toEqual({
      id: "stripe_gift_ana",
      lane: "US",
      receivedAt: "2026-09-28T16:00:44.000Z",
      amountCents: 22_500,
      refundedAmountCents: 0,
      frequency: "ONCE",
      giftType: "DIEZMO",
      donorName: "Ana C Delgado",
      donorEmail: "ana@example.org",
      documentId: null,
      numeroControl: null,
      documentStatus: null,
      giftStatus: "PAID",
      acknowledgmentStatus: "SENT"
    });
    expect(page.donations[3]).toMatchObject({
      lane: "US",
      giftType: "OFRENDA",
      refundedAmountCents: 400,
      giftStatus: "PARTIALLY_REFUNDED",
      acknowledgmentStatus: "SUPPRESSED"
    });
  });

  it("includes Wompi CDEs paid through the static payment link, but not hand-issued CDEs", async () => {
    database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body, headers_json
       ) VALUES ('wompi_static', 'transaction_static', '01', 'Exitosa', 4000, '{}', '{}')`
    ).run();
    database.prepare(
      `INSERT INTO dte_documents (
         id, wompi_event_id, environment, codigo_generacion, numero_control, status, plain_json,
         donor_email, donor_name, amount_cents, issued_at, created_at
       ) VALUES
         ('doc_static', 'wompi_static', '01', 'generation-static', 'DTE-15-M001P004-000000000000077',
          'ACCEPTED', '{}', 'link@example.org', 'Donante Enlace', 4000,
          '2026-09-20T15:00:00.000Z', '2026-09-20T15:00:00.000Z'),
         ('doc_manual', NULL, '01', 'generation-manual', 'DTE-15-M001P004-000000000000078',
          'ACCEPTED', '{}', NULL, 'Donante Manual', 9000,
          '2026-09-21T15:00:00.000Z', '2026-09-21T15:00:00.000Z')`
    ).run();
    seedSvGift(database, {
      id: "di_wizard",
      paidAt: "2026-09-22T15:00:00.000Z",
      document: { donorName: "Donante Formulario", donorEmail: null, numeroControl: "DTE-15-M001P004-000000000000079" }
    });

    const page = await repo.listDonations({ limit: 25 });

    expect(page.donations.map((row) => row.id)).toEqual(["di_wizard", "doc_static"]);
    expect(page.donations[1]).toMatchObject({
      lane: "SV",
      receivedAt: "2026-09-20T15:00:00.000Z",
      amountCents: 4_000,
      giftType: null,
      donorName: "Donante Enlace",
      documentId: "doc_static",
      numeroControl: "DTE-15-M001P004-000000000000077",
      documentStatus: "ACCEPTED"
    });
  });

  it("filters by lane, by name, email or control number, and by El Salvador calendar day", async () => {
    seedSvGift(database, {
      id: "di_beto",
      paidAt: "2026-09-29T15:00:00.000Z",
      document: { donorName: "Beto Ruiz", donorEmail: "beto@example.org", numeroControl: "DTE-15-M001P004-000000000000042" }
    });
    seedUsGift(database, { id: "stripe_gift_ana", settledAt: "2026-09-28T16:00:44.000Z", donorName: "Ana C Delgado", donorEmail: "delgado@example.org" });
    // 2026-09-29 00:30 El Salvador time, but 2026-09-29 06:30 UTC.
    seedUsGift(database, { id: "stripe_gift_late", settledAt: "2026-09-29T06:30:00.000Z", donorName: "Carla Late" });
    // 2026-09-28 23:30 El Salvador time, although already 2026-09-29 in UTC.
    seedUsGift(database, { id: "stripe_gift_edge", settledAt: "2026-09-29T05:30:00.000Z", donorName: "Diego Edge" });

    const ids = async (filters: Parameters<Repository["listDonations"]>[0]) =>
      (await repo.listDonations(filters)).donations.map((row) => row.id);

    expect(await ids({ limit: 25, lane: "US" })).toEqual(["stripe_gift_late", "stripe_gift_edge", "stripe_gift_ana"]);
    expect(await ids({ limit: 25, lane: "SV" })).toEqual(["di_beto"]);
    expect(await ids({ limit: 25, q: "DELGADO" })).toEqual(["stripe_gift_ana"]);
    expect(await ids({ limit: 25, q: "beto@" })).toEqual(["di_beto"]);
    expect(await ids({ limit: 25, q: "000000000000042" })).toEqual(["di_beto"]);
    expect(await ids({ limit: 25, q: "%" })).toEqual([]);
    expect(await ids({ limit: 25, from: "2026-09-29", to: "2026-09-29" })).toEqual(["di_beto", "stripe_gift_late"]);
    expect(await ids({ limit: 25, to: "2026-09-28" })).toEqual(["stripe_gift_edge", "stripe_gift_ana"]);
  });

  it("pages with a stable keyset cursor across both lanes, including timestamp ties", async () => {
    const tie = "2026-09-28T16:00:00.000Z";
    seedSvGift(database, { id: "di_a", paidAt: tie });
    seedUsGift(database, { id: "stripe_gift_b", settledAt: tie });
    seedSvGift(database, { id: "di_c", paidAt: "2026-09-27T16:00:00.000Z" });
    seedUsGift(database, { id: "stripe_gift_d", settledAt: "2026-09-26T16:00:00.000Z" });
    seedSvGift(database, { id: "di_e", paidAt: "2026-09-25T16:00:00.000Z" });

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await repo.listDonations({ limit: 2, cursor });
      seen.push(...page.donations.map((row) => row.id));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);

    expect(seen).toEqual(["stripe_gift_b", "di_a", "di_c", "stripe_gift_d", "di_e"]);
    expect(pages).toBe(3);
  });
});
