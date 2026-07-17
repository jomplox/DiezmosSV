import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { Repository } from "../../src/worker/storage/repository";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");

describe("fiscal repository SQL on SQLite", () => {
  it("scopes successful operational alerts by incident and channel", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    const repository = new Repository(d1.database);

    await repository.createAudit({
      action: "ALERT_SENT:EMAIL_FAILED",
      entityType: "dte_document",
      entityId: "doc_alert",
      summary: "sent",
      metadata: { incidentId: "delivery_1", channel: "email" }
    });
    await repository.createAudit({
      action: "ALERT_FAILED:EMAIL_FAILED",
      entityType: "dte_document",
      entityId: "doc_alert",
      summary: "failed",
      metadata: { incidentId: "delivery_2", channel: "webhook" }
    });

    expect(await repository.hasOperationalAlertChannelResult({
      action: "ALERT_SENT:EMAIL_FAILED",
      entityType: "dte_document",
      entityId: "doc_alert",
      incidentId: "delivery_1",
      channel: "email"
    })).toBe(true);
    expect(await repository.hasOperationalAlertChannelResult({
      action: "ALERT_SENT:EMAIL_FAILED",
      entityType: "dte_document",
      entityId: "doc_alert",
      incidentId: "delivery_1",
      channel: "webhook"
    })).toBe(false);
    expect(await repository.hasOperationalAlertChannelResult({
      action: "ALERT_SENT:EMAIL_FAILED",
      entityType: "dte_document",
      entityId: "doc_alert",
      incidentId: "delivery_2",
      channel: "email"
    })).toBe(false);

    database.close();
  });

  it("atomically attaches and completes an accepted invalidation", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_invalidation", "2026-06-01T12:00:02.000Z");
    const repository = new Repository(d1.database);

    expect(await repository.claimDocumentInvalidation("doc_invalidation", "claim_invalidation")).toBe(true);
    const eventId = await repository.createAndAttachDocumentInvalidationEvent({
      documentId: "doc_invalidation",
      claimId: "claim_invalidation",
      environment: "00",
      codigoGeneracion: "70000003-2222-4222-8222-700000032222",
      plainJson: { identificacion: { tipoDte: "15" } },
      signedJws: "signed-invalidation",
      legalDeadlineAt: "2026-07-15T05:59:59.000Z",
      createdBy: "user_operator"
    });

    expect(await repository.completeDocumentInvalidation({
      documentId: "doc_invalidation",
      claimId: "claim_invalidation",
      eventId,
      accepted: true,
      sello: "INVALIDATION-SEAL",
      mhEstado: "PROCESADO",
      observaciones: [],
      acceptedAt: "2026-07-01T15:00:00.000Z",
      actorId: "user_operator",
      raw: { estado: "PROCESADO" }
    })).toBe(true);

    expect(database.prepare(
      `SELECT status, fiscal_operation_claim_id, fiscal_operation_kind,
              fiscal_operation_event_id
         FROM dte_documents WHERE id = ?`
    ).get("doc_invalidation")).toEqual({
      status: "INVALIDATED",
      fiscal_operation_claim_id: null,
      fiscal_operation_kind: null,
      fiscal_operation_event_id: null
    });
    expect(database.prepare(
      "SELECT status, sello_recibido, mh_estado FROM dte_events WHERE id = ?"
    ).get(eventId)).toEqual({
      status: "ACCEPTED",
      sello_recibido: "INVALIDATION-SEAL",
      mh_estado: "PROCESADO"
    });
    expect(database.prepare(
      "SELECT action, entity_id FROM audit_logs WHERE id = ?"
    ).get(`audit_invalidation_${eventId}`)).toEqual({
      action: "DTE_INVALIDATED",
      entity_id: "doc_invalidation"
    });
    database.close();
  });

  it("excludes every claimed document from status-dependent readers", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body
       ) VALUES (?, ?, '00', 'Exitosa', 2500, '{}')`
    ).run("wompi_claimed", "transaction_claimed");
    seedAcceptedDocument(database, "doc_claimed_reader", "2026-06-01T12:00:02.000Z", "donor@example.org");
    database.prepare(
      `UPDATE dte_documents
          SET wompi_event_id = ?, fiscal_operation_claim_id = ?,
              fiscal_operation_claimed_at = ?, fiscal_operation_kind = 'TRANSMISSION'
        WHERE id = ?`
    ).run("wompi_claimed", "ambiguous_transmission", "2026-07-14T12:00:00.000Z", "doc_claimed_reader");
    const repository = new Repository(d1.database);
    const range = { startIso: "2026-01-01T00:00:00.000Z", endIso: "2027-01-01T00:00:00.000Z" };

    expect(await repository.listAcceptedDteDocumentsForExport()).toEqual([]);
    expect(await repository.listAcceptedDocumentsInYear(range, null)).toEqual([]);
    expect(await repository.listAcceptedWompiContactRows("00", null, 100, range)).toEqual([]);
    expect(await repository.listWompiLaneDocumentsForAnalytics(range, "00", null)).toEqual([]);
    database.close();
  });

  it("claims and owner-qualifies post-accept finalization", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_finalization", null, "donor@example.org");
    const repository = new Repository(d1.database);

    expect(await repository.claimDocumentPostAcceptFinalization("doc_finalization", "finalize_owner")).toBe(true);
    expect(await repository.claimDocumentPostAcceptFinalization("doc_finalization", "finalize_loser")).toBe(false);
    expect(await repository.markDocumentPostAcceptEmailDispatchStarted("doc_finalization", "finalize_loser")).toBe(false);
    expect(await repository.markDocumentPostAcceptEmailDispatchStarted("doc_finalization", "finalize_owner")).toBe(true);
    expect(await repository.markDocumentPostAcceptFinalized("doc_finalization", "finalize_loser")).toBe(false);
    expect(await repository.markDocumentPostAcceptFinalized("doc_finalization", "finalize_owner")).toBe(true);

    expect(database.prepare(
      `SELECT post_accept_finalized_at, post_accept_finalization_claim_id,
              post_accept_finalization_claimed_at, post_accept_email_dispatch_started_at
         FROM dte_documents WHERE id = ?`
    ).get("doc_finalization")).toMatchObject({
      post_accept_finalized_at: expect.any(String),
      post_accept_finalization_claim_id: null,
      post_accept_finalization_claimed_at: null,
      post_accept_email_dispatch_started_at: null
    });
    database.close();
  });

  it("serializes donor-email corrections with accepted-document finalization", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_email_owner", null, "original@example.org");
    const repository = new Repository(d1.database);

    expect(await repository.updateDocumentDonorEmail("doc_email_owner", "before-claim@example.org")).toBe(true);
    expect(await repository.claimDocumentPostAcceptFinalization("doc_email_owner", "finalize_owner")).toBe(true);
    expect(await repository.updateDocumentDonorEmail("doc_email_owner", "racing@example.org")).toBe(false);
    expect(database.prepare("SELECT donor_email FROM dte_documents WHERE id = ?").get("doc_email_owner")).toEqual({
      donor_email: "before-claim@example.org"
    });

    expect(await repository.markDocumentPostAcceptFinalized("doc_email_owner", "finalize_owner")).toBe(true);
    expect(await repository.updateDocumentDonorEmail("doc_email_owner", "after-finalization@example.org")).toBe(true);
    expect(database.prepare("SELECT donor_email FROM dte_documents WHERE id = ?").get("doc_email_owner")).toEqual({
      donor_email: "after-finalization@example.org"
    });
    database.close();
  });

  it("prevents a stale finalizer from completing intent or audit bookkeeping", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_stale_owner", null, null);
    database.prepare(
      `INSERT INTO donation_intents (
         id, status, amount_cents, donor_name, donor_document_type, donor_document,
         donor_email, direccion_departamento, direccion_municipio, direccion_distrito,
         direccion_complemento, expires_at
       ) VALUES (?, 'LINK_CREATED', 2500, 'Donor', '13', '100000001',
                 'donor@example.org', '06', '22', '01', 'Address', ?)`
    ).run("intent_stale_owner", "2099-01-01T00:00:00.000Z");
    const repository = new Repository(d1.database);

    expect(await repository.claimDocumentPostAcceptFinalization("doc_stale_owner", "owner_a")).toBe(true);
    database.prepare(
      `UPDATE dte_documents
          SET post_accept_finalization_claim_id = ?, post_accept_finalization_claimed_at = ?
        WHERE id = ?`
    ).run("owner_b", "2026-07-14T12:00:00.000Z", "doc_stale_owner");

    expect(await repository.completeIntentForPostAcceptOwner(
      "intent_stale_owner",
      "doc_stale_owner",
      "owner_a"
    )).toBe(false);
    expect(await repository.ensurePostAcceptAudit({
      auditId: "audit_post_accept_doc_stale_owner",
      documentId: "doc_stale_owner",
      claimId: "owner_a",
      action: "ADVANCED_CDE_ACCEPTED",
      entityType: "dte_document",
      entityId: "doc_stale_owner",
      summary: "stale owner must not write"
    })).toBe(false);

    expect(await repository.completeIntentForPostAcceptOwner(
      "intent_stale_owner",
      "doc_stale_owner",
      "owner_b"
    )).toBe(true);
    const audit = {
      auditId: "audit_post_accept_doc_stale_owner",
      documentId: "doc_stale_owner",
      claimId: "owner_b",
      action: "ADVANCED_CDE_ACCEPTED",
      entityType: "dte_document",
      entityId: "doc_stale_owner",
      summary: "current owner writes once"
    };
    expect(await repository.ensurePostAcceptAudit(audit)).toBe(true);
    expect(await repository.ensurePostAcceptAudit(audit)).toBe(true);
    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM audit_logs WHERE id = ?"
    ).get(audit.auditId)).toEqual({ count: 1 });
    database.close();
  });

  it("recovers a stale pre-dispatch lease but locks an ambiguous post-dispatch lease", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_finalization_crash", null, "donor@example.org");
    const repository = new Repository(d1.database);

    expect(await repository.claimDocumentPostAcceptFinalization("doc_finalization_crash", "owner_before_crash")).toBe(true);
    database.prepare(
      "UPDATE dte_documents SET post_accept_finalization_claimed_at = ? WHERE id = ?"
    ).run("2000-01-01T00:00:00.000Z", "doc_finalization_crash");

    expect(await repository.claimDocumentPostAcceptFinalization("doc_finalization_crash", "owner_before_dispatch")).toBe(true);
    expect(await repository.markDocumentPostAcceptEmailDispatchStarted("doc_finalization_crash", "owner_before_dispatch")).toBe(true);
    database.prepare(
      "UPDATE dte_documents SET post_accept_finalization_claimed_at = ? WHERE id = ?"
    ).run("2000-01-01T00:00:00.000Z", "doc_finalization_crash");

    expect(await repository.claimDocumentPostAcceptFinalization("doc_finalization_crash", "owner_ambiguous_retry")).toBe(false);
    expect(database.prepare(
      `SELECT post_accept_finalization_claim_id, post_accept_email_dispatch_started_at
         FROM dte_documents WHERE id = ?`
    ).get("doc_finalization_crash")).toMatchObject({
      post_accept_finalization_claim_id: "owner_before_dispatch",
      post_accept_email_dispatch_started_at: expect.any(String)
    });

    await repository.recordEmailDelivery({
      documentId: "doc_finalization_crash",
      toEmail: "donor@example.org",
      status: "FAILED",
      emailType: "dteReceipt",
      documentStatusAtSend: "REJECTED"
    });
    expect(await repository.hasHandledEmail("doc_finalization_crash", "dteReceipt", "ACCEPTED")).toBe(false);
    expect(await repository.claimDocumentPostAcceptFinalization("doc_finalization_crash", "owner_with_rejected_evidence")).toBe(false);

    await repository.recordEmailDelivery({
      documentId: "doc_finalization_crash",
      toEmail: "donor@example.org",
      status: "FAILED",
      emailType: "dteReceipt",
      documentStatusAtSend: "ACCEPTED"
    });
    expect(await repository.hasHandledEmail("doc_finalization_crash", "dteReceipt", "ACCEPTED")).toBe(true);
    expect(await repository.claimDocumentPostAcceptFinalization("doc_finalization_crash", "owner_with_evidence")).toBe(true);
    database.close();
  });

  it("reclaims only proven-safe or stale pre-dispatch receipt claims", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_delivery_recovery", "2026-06-01T12:00:02.000Z", "donor@example.org");
    const repository = new Repository(d1.database);

    const safeInput = {
      documentId: "doc_delivery_recovery",
      toEmail: "donor@example.org",
      emailType: "dteReceipt",
      documentStatusAtSend: "ACCEPTED"
    };
    const safeClaim = await repository.claimEmailDelivery(safeInput);
    expect(safeClaim).not.toBeNull();
    expect(await repository.markEmailDeliveryDispatchStarted(safeClaim!.id, "wrong-token")).toBe(false);
    expect(await repository.markEmailDeliveryDispatchStarted(safeClaim!.id, safeClaim!.claimToken)).toBe(true);
    await repository.finalizeEmailDeliveryClaim(safeClaim!.id, safeClaim!.claimToken, {
      status: "FAILED",
      providerResponse: { code: "E_HEADER_NOT_ALLOWED" },
      emailType: safeInput.emailType,
      documentStatusAtSend: safeInput.documentStatusAtSend,
      outcomeClass: "NOT_SENT",
      failureCode: "E_HEADER_NOT_ALLOWED",
      retrySafe: true
    });
    await expect(repository.claimEmailDelivery(safeInput)).resolves.toMatchObject({
      id: safeClaim!.id,
      claimToken: expect.any(String)
    });

    const unknownInput = { ...safeInput, emailType: "dteReceiptUnknown" };
    const unknownClaim = await repository.claimEmailDelivery(unknownInput);
    expect(unknownClaim).not.toBeNull();
    expect(await repository.markEmailDeliveryDispatchStarted(unknownClaim!.id, unknownClaim!.claimToken)).toBe(true);
    await repository.finalizeEmailDeliveryClaim(unknownClaim!.id, unknownClaim!.claimToken, {
      status: "FAILED",
      providerResponse: { code: "E_INTERNAL_SERVER_ERROR" },
      emailType: unknownInput.emailType,
      documentStatusAtSend: unknownInput.documentStatusAtSend,
      outcomeClass: "UNKNOWN",
      failureCode: "E_INTERNAL_SERVER_ERROR",
      retrySafe: false
    });
    await expect(repository.claimEmailDelivery(unknownInput)).resolves.toBeNull();

    const preDispatchInput = { ...safeInput, emailType: "dteReceiptPreDispatch" };
    const preDispatchClaim = await repository.claimEmailDelivery(preDispatchInput);
    expect(preDispatchClaim).not.toBeNull();
    database.prepare(
      "UPDATE email_deliveries SET claim_attempted_at = ? WHERE id = ?"
    ).run("2000-01-01T00:00:00.000Z", preDispatchClaim!.id);
    await expect(repository.claimEmailDelivery(preDispatchInput)).resolves.toMatchObject({
      id: preDispatchClaim!.id,
      claimToken: expect.any(String)
    });

    const postDispatchInput = { ...safeInput, emailType: "dteReceiptPostDispatch" };
    const postDispatchClaim = await repository.claimEmailDelivery(postDispatchInput);
    expect(postDispatchClaim).not.toBeNull();
    expect(await repository.markEmailDeliveryDispatchStarted(postDispatchClaim!.id, postDispatchClaim!.claimToken)).toBe(true);
    database.prepare(
      "UPDATE email_deliveries SET claim_attempted_at = ? WHERE id = ?"
    ).run("2000-01-01T00:00:00.000Z", postDispatchClaim!.id);
    await expect(repository.claimEmailDelivery(postDispatchInput)).resolves.toBeNull();

    database.close();
  });

  it("deduplicates a deliberate resend request and only retries proven-safe outcomes", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    seedAcceptedDocument(database, "doc_manual_resend", "2026-06-01T12:00:02.000Z", "donor@example.org");
    const repository = new Repository(d1.database);
    const input = {
      documentId: "doc_manual_resend",
      toEmail: "donor@example.org",
      emailType: "dteReceipt",
      documentStatusAtSend: "ACCEPTED",
      resendRequestId: "11111111-1111-4111-8111-111111111111"
    };

    const first = await repository.claimManualEmailDelivery(input);
    expect(first).toMatchObject({
      kind: "claimed",
      id: expect.any(String),
      idempotencyKey: expect.stringMatching(/^dsv-receipt-resend-v1-[a-f0-9]{64}$/),
      claimToken: expect.any(String),
      attemptNo: 1
    });
    if (first.kind !== "claimed") throw new Error("expected first manual resend claim");
    expect(await repository.markEmailDeliveryDispatchStarted(first.id, first.claimToken)).toBe(true);
    await repository.finalizeEmailDeliveryClaim(first.id, first.claimToken, {
      status: "SENT",
      providerResponse: { messageId: "manual-resend-1" },
      emailType: input.emailType,
      documentStatusAtSend: input.documentStatusAtSend,
      providerDeliveryId: "manual-resend-1"
    });

    await expect(repository.claimManualEmailDelivery(input)).resolves.toMatchObject({
      kind: "already_sent",
      id: first.id,
      attemptNo: 1
    });
    await expect(repository.claimManualEmailDelivery({
      ...input,
      toEmail: "other@example.org"
    })).resolves.toMatchObject({
      kind: "conflict",
      id: first.id
    });

    const retryInput = {
      ...input,
      resendRequestId: "70000003-2222-4222-8222-700000032222"
    };
    const retryFirst = await repository.claimManualEmailDelivery(retryInput);
    if (retryFirst.kind !== "claimed") throw new Error("expected retry-safe manual resend claim");
    expect(await repository.markEmailDeliveryDispatchStarted(retryFirst.id, retryFirst.claimToken)).toBe(true);
    await repository.finalizeEmailDeliveryClaim(retryFirst.id, retryFirst.claimToken, {
      status: "FAILED",
      providerResponse: { code: "E_HEADER_NOT_ALLOWED" },
      emailType: retryInput.emailType,
      documentStatusAtSend: retryInput.documentStatusAtSend,
      outcomeClass: "NOT_SENT",
      failureCode: "E_HEADER_NOT_ALLOWED",
      retrySafe: true
    });
    await expect(repository.claimManualEmailDelivery(retryInput)).resolves.toMatchObject({
      kind: "claimed",
      id: retryFirst.id,
      idempotencyKey: retryFirst.idempotencyKey,
      claimToken: expect.any(String),
      attemptNo: 2
    });

    const reviewInput = {
      ...input,
      resendRequestId: "33333333-3333-4333-8333-333333333333"
    };
    const reviewFirst = await repository.claimManualEmailDelivery(reviewInput);
    if (reviewFirst.kind !== "claimed") throw new Error("expected manual-review resend claim");
    expect(await repository.markEmailDeliveryDispatchStarted(reviewFirst.id, reviewFirst.claimToken)).toBe(true);
    await repository.finalizeEmailDeliveryClaim(reviewFirst.id, reviewFirst.claimToken, {
      status: "FAILED",
      providerResponse: { code: "E_INTERNAL_SERVER_ERROR" },
      emailType: reviewInput.emailType,
      documentStatusAtSend: reviewInput.documentStatusAtSend,
      outcomeClass: "UNKNOWN",
      failureCode: "E_INTERNAL_SERVER_ERROR",
      retrySafe: false
    });
    await expect(repository.claimManualEmailDelivery(reviewInput)).resolves.toMatchObject({
      kind: "manual_review",
      id: reviewFirst.id,
      attemptNo: 1,
      outcomeClass: "UNKNOWN"
    });

    database.close();
  });

  it("skips more than one page of reconciliation-locked fiscal work", async () => {
    const database = migratedDatabase();
    const d1 = new SqliteD1(database);
    const insert = database.prepare(
      `INSERT INTO dte_documents (
         id, environment, codigo_generacion, numero_control, status, plain_json,
         signed_jws, sello_recibido, mh_estado, amount_cents, issued_at,
         accepted_at, transmission_deferred_at, post_accept_finalized_at,
         fiscal_operation_claim_id, fiscal_operation_claimed_at, fiscal_operation_kind,
         post_accept_finalization_claim_id, post_accept_finalization_claimed_at,
         post_accept_email_dispatch_started_at, donor_email, created_at, updated_at
       ) VALUES (?, '00', ?, ?, ?, '{}', 'signed-document', ?, ?, 2500, ?, ?, ?, NULL,
                 ?, ?, 'TRANSMISSION', ?, ?, ?, 'donor@example.org', ?, ?)`
    );
    for (let index = 0; index < 101; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const createdAt = `2026-01-01T00:00:${String(index % 60).padStart(2, "0")}.${suffix}Z`;
      insert.run(
        `accepted_locked_${suffix}`,
        `accepted-generation-${suffix}`,
        `accepted-control-${suffix}`,
        "ACCEPTED",
        "DOCUMENT-SEAL",
        "PROCESADO",
        createdAt,
        createdAt,
        null,
        `transmission_claim_${suffix}`,
        "2000-01-01T00:00:00.000Z",
        `finalization_claim_${suffix}`,
        "2000-01-01T00:00:00.000Z",
        "2000-01-01T00:00:01.000Z",
        createdAt,
        createdAt
      );
      insert.run(
        `deferred_locked_${suffix}`,
        `deferred-generation-${suffix}`,
        `deferred-control-${suffix}`,
        "SIGNED",
        null,
        "MH_NO_DISPONIBLE",
        createdAt,
        null,
        createdAt,
        `deferred_claim_${suffix}`,
        "2000-01-01T00:00:00.000Z",
        null,
        null,
        null,
        createdAt,
        createdAt
      );
    }
    insert.run(
      "accepted_claimable_after_locked",
      "accepted-generation-claimable",
      "accepted-control-claimable",
      "ACCEPTED",
      "DOCUMENT-SEAL",
      "PROCESADO",
      "2026-12-01T00:00:00.000Z",
      "2026-12-01T00:00:01.000Z",
      null,
      null,
      null,
      null,
      null,
      null,
      "2026-12-01T00:00:00.000Z",
      "2026-12-01T00:00:00.000Z"
    );
    insert.run(
      "deferred_claimable_after_locked",
      "deferred-generation-claimable",
      "deferred-control-claimable",
      "SIGNED",
      null,
      "MH_NO_DISPONIBLE",
      "2026-12-01T00:00:00.000Z",
      null,
      "2026-12-01T00:00:01.000Z",
      null,
      null,
      null,
      null,
      null,
      "2026-12-01T00:00:00.000Z",
      "2026-12-01T00:00:00.000Z"
    );
    const repository = new Repository(d1.database);

    expect((await repository.listPendingPostAcceptFinalizations(100)).map((row) => row.id)).toEqual([
      "accepted_claimable_after_locked"
    ]);
    expect((await repository.listDeferredTransmissionDocuments(100)).map((row) => row.id)).toEqual([
      "deferred_claimable_after_locked"
    ]);
    database.close();
  });
});

class SqliteD1 {
  constructor(private readonly sqlite: DatabaseSync) {}

  readonly database = {
    prepare: (sql: string) => new SqliteStatement(this.sqlite, sql),
    batch: async (statements: SqliteStatement[]) => {
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.runSync());
        this.sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  } as unknown as D1Database;
}

class SqliteStatement {
  private args: SQLInputValue[] = [];
  private readonly statement: StatementSync;

  constructor(database: DatabaseSync, sql: string) {
    this.statement = database.prepare(sql);
  }

  bind(...args: unknown[]): this {
    this.args = args as SQLInputValue[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.args) as T[] };
  }

  async run(): Promise<D1Result> {
    return this.runSync() as unknown as D1Result;
  }

  runSync(): { success: true; meta: { changes: number }; results: never[] } {
    const result = this.statement.run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) }, results: [] };
  }
}

function migratedDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync(migrationsDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
    database.exec(readFileSync(resolve(migrationsDirectory, filename), "utf8"));
  }
  database.prepare(
    `INSERT INTO users (id, email, name, role, password_hash, password_salt)
     VALUES ('user_operator', 'operator@example.org', 'Operator', 'OPERATOR', 'hash', 'salt')`
  ).run();
  return database;
}

function seedAcceptedDocument(
  database: DatabaseSync,
  id: string,
  finalizedAt: string | null,
  donorEmail: string | null = null
): void {
  const suffix = id === "doc_invalidation" ? "3" : "4";
  database.prepare(
    `INSERT INTO dte_documents (
       id, environment, codigo_generacion, numero_control, status, plain_json,
       signed_jws, sello_recibido, mh_estado, amount_cents, issued_at,
       accepted_at, post_accept_finalized_at, donor_email, created_at, updated_at
     ) VALUES (?, '00', ?, ?, 'ACCEPTED', '{}', 'signed-document',
               'DOCUMENT-SEAL', 'PROCESADO', 2500, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    `33333333-3333-4333-8333-33333333333${suffix}`,
    `DTE-15-M001P001-00000000000000${suffix}`,
    "2026-06-01T12:00:00.000Z",
    "2026-06-01T12:00:01.000Z",
    finalizedAt,
    donorEmail,
    "2026-06-01T12:00:00.000Z",
    "2026-06-01T12:00:01.000Z"
  );
}
