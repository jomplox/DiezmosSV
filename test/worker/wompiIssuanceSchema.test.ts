import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { legacyIssuanceAttemptId, Repository } from "../../src/worker/storage/repository";
import { InMemoryD1 } from "./support/inMemoryD1";
import { applyMigrations } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";

const migrationsDirectory = resolve(import.meta.dirname, "../../migrations");
const initMigrationPath = resolve(migrationsDirectory, "0001_init.sql");
const auditActorMigrationPath = resolve(migrationsDirectory, "0013_audit_actor_context.sql");
const issuanceMigrationPath = resolve(migrationsDirectory, "0023_wompi_issuance_lifecycle.sql");

describe("Wompi issuance reservation migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    applyMigrations(database);
    insertApprovedWompiEvent(database, "wompi_a");
    insertApprovedWompiEvent(database, "wompi_b");
  });

  afterEach(() => {
    database.close();
  });

  it("reserves one stable control sequence per Wompi event", () => {
    reserve(database, "wompi_a", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA");
    expect(reservation(database, "wompi_a")).toEqual({
      control_sequence: 1,
      reserved_numero_control: "DTE-15-M001P004-000000000000001",
      reserved_codigo_generacion: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
    });
    expect(nextValue(database)).toBe(2);

    reserve(database, "wompi_a", "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB");
    expect(reservation(database, "wompi_a")?.control_sequence).toBe(1);
    expect(nextValue(database)).toBe(2);

    reserve(database, "wompi_b", "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC");
    expect(reservation(database, "wompi_b")?.control_sequence).toBe(2);
    expect(nextValue(database)).toBe(3);
  });

  it("persists the queue-attempt epoch used to reject stale failures and DLQs", () => {
    const columns = database
      .prepare("PRAGMA table_info(wompi_events)")
      .all() as Array<{ name: string }>;

    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "issuance_attempt_id",
      "stalled_requeue_epoch_at"
    ]));
  });

  it("persists constrained fiscal correction history and per-target attempts", () => {
    const columns = database
      .prepare("PRAGMA table_info(fiscal_corrections)")
      .all() as Array<{ name: string }>;
    const indexes = database
      .prepare("PRAGMA index_list(fiscal_corrections)")
      .all() as Array<{ name: string; unique: number }>;

    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "request_id",
      "attempt_number",
      "processing_claim_id",
      "processing_started_at",
      "mh_dispatch_started_at",
      "source_document_snapshot_json"
    ]));
    expect(indexes).toContainEqual(expect.objectContaining({
      name: "uq_fiscal_corrections_wompi_attempt",
      unique: 1
    }));
    expect(indexes).toContainEqual(expect.objectContaining({
      name: "uq_fiscal_corrections_document_attempt",
      unique: 1
    }));

    insertRawFiscalCorrection(database, {
      id: "correction_one",
      requestId: "request_one",
      attemptNumber: 1,
      wompiEventId: "wompi_a"
    });
    expect(() => insertRawFiscalCorrection(database, {
      id: "correction_duplicate_request",
      requestId: "request_one",
      attemptNumber: 2,
      wompiEventId: "wompi_a"
    })).toThrow(/UNIQUE constraint failed: fiscal_corrections\.request_id/);
    expect(() => insertRawFiscalCorrection(database, {
      id: "correction_duplicate_attempt",
      requestId: "request_two",
      attemptNumber: 1,
      wompiEventId: "wompi_a"
    })).toThrow(/UNIQUE constraint failed: fiscal_corrections\.wompi_event_id, fiscal_corrections\.attempt_number/);
  });

  it("rejects invalid correction JSON and target/snapshot combinations", () => {
    expect(() => insertRawFiscalCorrection(database, {
      id: "correction_invalid_json",
      requestId: "request_invalid_json",
      attemptNumber: 1,
      wompiEventId: "wompi_a",
      correctedReceptorJson: "not-json"
    })).toThrow(/CHECK constraint failed/);
    expect(() => database.prepare(
      `INSERT INTO fiscal_corrections (
         id, request_id, request_payload_sha256, attempt_number, target_kind,
         document_id, environment, status, before_receptor_json,
         corrected_receptor_json, changed_fields_json,
         source_document_snapshot_json, processing_claim_id, created_by
       ) VALUES ('correction_missing_snapshot', 'request_missing_snapshot', 'sha',
         1, 'DTE_DOCUMENT', 'missing-document', '00', 'QUEUED', '{}', '{}',
         '[]', NULL, 'processing', 'user_operator')`
    ).run()).toThrow(/CHECK constraint failed/);
    expect(() => database.prepare(
      `INSERT INTO fiscal_corrections (
         id, request_id, request_payload_sha256, attempt_number, target_kind,
         wompi_event_id, document_id, environment, status, before_receptor_json,
         corrected_receptor_json, changed_fields_json,
         source_document_snapshot_json, processing_claim_id, created_by
       ) VALUES ('correction_two_targets', 'request_two_targets', 'sha', 1,
         'WOMPI_EVENT', 'wompi_b', 'document_too', '00', 'QUEUED', '{}', '{}',
         '[]', NULL, 'processing', 'user_operator')`
    ).run()).toThrow(/CHECK constraint failed/);

    insertAcceptedDocument(database, "wompi_a", "doc_dte_target_integrity");
    expect(() => database.prepare(
      `INSERT INTO fiscal_corrections (
         id, request_id, request_payload_sha256, attempt_number, target_kind,
         wompi_event_id, document_id, environment, status, before_receptor_json,
         corrected_receptor_json, changed_fields_json,
         source_document_snapshot_json, processing_claim_id, created_by
       ) VALUES ('correction_dte_with_wompi_target', 'request_dte_with_wompi_target',
         'sha', 1, 'DTE_DOCUMENT', 'wompi_a', 'doc_dte_target_integrity', '00',
         'QUEUED', '{}', '{}', '[]', '{}', 'processing', 'user_operator')`
    ).run()).toThrow(/CHECK constraint failed/);
  });

  it("persists claimant fencing tokens for DTE transmission and receipt delivery", () => {
    const documentColumns = database
      .prepare("PRAGMA table_info(dte_documents)")
      .all() as Array<{ name: string }>;
    const emailColumns = database
      .prepare("PRAGMA table_info(email_deliveries)")
      .all() as Array<{ name: string }>;

    expect(documentColumns.map((column) => column.name)).toContain("transmission_claim_id");
    expect(emailColumns.map((column) => column.name)).toContain("claim_token");
  });

  it("persists recoverable email claim evidence and a unique stable provider key", () => {
    const columns = database
      .prepare("PRAGMA table_info(email_deliveries)")
      .all() as Array<{ name: string }>;
    const indexes = database
      .prepare("PRAGMA index_list(email_deliveries)")
      .all() as Array<{ name: string; unique: number }>;

    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "claim_attempted_at",
      "idempotency_key"
    ]));
    expect(indexes).toContainEqual(expect.objectContaining({
      name: "idx_email_deliveries_idempotency_key",
      unique: 1
    }));
  });

  it("persists provider-dispatch, typed outcome, and deliberate resend evidence", () => {
    const columns = database
      .prepare("PRAGMA table_info(email_deliveries)")
      .all() as Array<{ name: string }>;
    const indexes = database
      .prepare("PRAGMA index_list(email_deliveries)")
      .all() as Array<{ name: string; unique: number }>;

    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "provider_dispatch_started_at",
      "outcome_class",
      "failure_code",
      "retry_safe",
      "resend_request_id",
      "attempt_no"
    ]));
    expect(indexes).toContainEqual(expect.objectContaining({
      name: "idx_email_deliveries_resend_request_id",
      unique: 1
    }));
    expect(indexes).toContainEqual(expect.objectContaining({
      name: "idx_email_deliveries_latest_receipt"
    }));
  });

  it("excludes active or unsafe email claims, reclaims proven-safe/stale pre-dispatch work, and leaves legacy PENDING manual", async () => {
    insertAcceptedDocument(database, "wompi_a", "dte_email_claim");
    const repo = new Repository(sqliteD1(database));
    const input = {
      documentId: "dte_email_claim",
      toEmail: "donor@example.org",
      emailType: "dteReceipt",
      documentStatusAtSend: "ACCEPTED"
    };

    const first = await repo.claimEmailDelivery(input);
    expect(first).toMatchObject({
      id: expect.any(String),
      idempotencyKey: expect.stringMatching(/^dsv-receipt-v1-[a-f0-9]{64}$/),
      claimToken: expect.any(String)
    });
    await expect(repo.claimEmailDelivery(input)).resolves.toBeNull();

    database.prepare(
      "UPDATE email_deliveries SET status = 'FAILED' WHERE id = ?"
    ).run(first!.id);
    await expect(repo.claimEmailDelivery(input)).resolves.toBeNull();

    database.prepare(
      "UPDATE email_deliveries SET retry_safe = 1, outcome_class = 'NOT_SENT' WHERE id = ?"
    ).run(first!.id);
    const failedRetry = await repo.claimEmailDelivery(input);
    expect(failedRetry).toMatchObject({
      id: first!.id,
      idempotencyKey: first!.idempotencyKey,
      claimToken: expect.any(String)
    });
    expect(failedRetry!.claimToken).not.toBe(first!.claimToken);

    database.prepare(
      `UPDATE email_deliveries
          SET claim_attempted_at = '2000-01-01T00:00:00.000Z',
              provider_dispatch_started_at = NULL
        WHERE id = ?`
    ).run(first!.id);
    const staleRetry = await repo.claimEmailDelivery(input);
    expect(staleRetry).toMatchObject({
      id: first!.id,
      idempotencyKey: first!.idempotencyKey,
      claimToken: expect.any(String)
    });
    expect(staleRetry!.claimToken).not.toBe(failedRetry!.claimToken);

    await expect(repo.finalizeEmailDeliveryClaim(
      failedRetry!.id,
      failedRetry!.claimToken,
      {
        status: "FAILED",
        emailType: input.emailType,
        documentStatusAtSend: input.documentStatusAtSend
      }
    )).rejects.toThrow(/ya no está pendiente/);
    await expect(repo.finalizeEmailDeliveryClaim(
      staleRetry!.id,
      staleRetry!.claimToken,
      {
        status: "SENT",
        emailType: input.emailType,
        documentStatusAtSend: input.documentStatusAtSend
      }
    )).resolves.toBeUndefined();
    expect(database.prepare(
      "SELECT status, idempotency_key, claim_token FROM email_deliveries WHERE id = ?"
    ).get(first!.id)).toEqual({
      status: "SENT",
      idempotency_key: first!.idempotencyKey,
      claim_token: staleRetry!.claimToken
    });

    database.prepare(
      `INSERT INTO email_deliveries (
         id, document_id, to_email, status, email_type, document_status_at_send,
         claim_attempted_at, idempotency_key
       ) VALUES ('legacy_pending', 'dte_email_claim', 'donor@example.org', 'PENDING',
         'dteReceiptTransitorio', 'SIGNED', NULL, NULL)`
    ).run();
    await expect(repo.claimEmailDelivery({
      ...input,
      emailType: "dteReceiptTransitorio",
      documentStatusAtSend: "SIGNED"
    })).resolves.toBeNull();
  });

  it("enforces attempt CAS and the legacy fallback against real SQLite", async () => {
    const repo = new Repository(sqliteD1(database));
    database.prepare(
      `UPDATE wompi_events
       SET issuance_status = 'RETRY_QUEUED', issuance_attempt_id = 'attempt-old'
       WHERE id = 'wompi_a'`
    ).run();

    await expect(repo.markWompiIssuanceProcessing(
      "wompi_a",
      "attempt-old"
    )).resolves.toBe(true);
    database.prepare(
      `UPDATE wompi_events
       SET issuance_status = 'RETRY_QUEUED', issuance_attempt_id = 'attempt-current'
       WHERE id = 'wompi_a'`
    ).run();

    await expect(repo.recordWompiIssuanceFailure(
      "wompi_a",
      "attempt-old",
      { code: "ISSUANCE_ERROR", message: "Fallo anterior" }
    )).resolves.toBe(false);
    await expect(repo.markWompiIssuanceDeadLettered(
      "wompi_a",
      "attempt-old"
    )).resolves.toBe(false);
    expect(database.prepare(
      `SELECT issuance_status, issuance_attempt_id, issuance_error_message
       FROM wompi_events WHERE id = 'wompi_a'`
    ).get()).toEqual({
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: "attempt-current",
      issuance_error_message: null
    });

    await expect(repo.markWompiIssuanceProcessing(
      "wompi_a",
      "attempt-current"
    )).resolves.toBe(true);
    await expect(repo.markWompiIssuanceDeadLettered(
      "wompi_a",
      "attempt-current"
    )).resolves.toBe(true);
    expect(database.prepare(
      `SELECT issuance_status, issuance_attempt_id, issuance_error_code
       FROM wompi_events WHERE id = 'wompi_a'`
    ).get()).toEqual({
      issuance_status: "DEAD_LETTERED",
      issuance_attempt_id: "attempt-current",
      issuance_error_code: "ISSUANCE_RETRIES_EXHAUSTED"
    });

    const legacyAttempt = legacyIssuanceAttemptId("wompi_b");
    await expect(repo.markWompiIssuanceProcessing(
      "wompi_b",
      legacyAttempt,
      true
    )).resolves.toBe(true);
    expect(database.prepare(
      "SELECT issuance_attempt_id FROM wompi_events WHERE id = 'wompi_b'"
    ).get()).toEqual({ issuance_attempt_id: legacyAttempt });
  });

  it("mints a new attempt when requeuing stalled work so an old failure cannot win", async () => {
    const repo = new Repository(sqliteD1(database));
    database.prepare(
      `UPDATE wompi_events
       SET issuance_status = 'PROCESSING',
           issuance_attempt_id = 'attempt-stalled',
           issuance_last_attempt_at = '2026-07-13T18:00:00.000Z'
       WHERE id = 'wompi_a'`
    ).run();

    const requeuedAttempt = await repo.claimStalledWompiIssuanceAttempt(
      "wompi_a",
      "attempt-stalled",
      "2026-07-13T19:00:00.000Z"
    );

    expect(requeuedAttempt).toEqual(expect.any(String));
    expect(requeuedAttempt).not.toBe("attempt-stalled");
    expect(database.prepare(
      "SELECT issuance_status, issuance_attempt_id FROM wompi_events WHERE id = 'wompi_a'"
    ).get()).toEqual({
      issuance_status: "RETRY_QUEUED",
      issuance_attempt_id: requeuedAttempt
    });
    await expect(repo.recordWompiIssuanceFailure(
      "wompi_a",
      "attempt-stalled",
      { code: "ISSUANCE_ERROR", message: "Entrega anterior" }
    )).resolves.toBe(false);
    await expect(repo.markWompiIssuanceDeadLettered(
      "wompi_a",
      "attempt-stalled"
    )).resolves.toBe(false);
  });

  it("establishes the stalled epoch from the pre-claim attempt against real SQLite", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-13T20:00:00.000Z"));
      const repo = new Repository(sqliteD1(database));
      database.prepare(
        `UPDATE wompi_events
         SET issuance_status = 'PROCESSING',
             issuance_attempt_id = 'attempt-stalled-epoch',
             issuance_last_attempt_at = '2026-07-13T18:00:00.000Z',
             stalled_requeue_epoch_at = NULL
         WHERE id = 'wompi_a'`
      ).run();

      const attemptId = await repo.claimStalledWompiIssuanceAttempt(
        "wompi_a",
        "attempt-stalled-epoch",
        "2026-07-13T19:00:00.000Z"
      );

      expect(database.prepare(
        `SELECT issuance_attempt_id, issuance_last_attempt_at, stalled_requeue_epoch_at
         FROM wompi_events WHERE id = 'wompi_a'`
      ).get()).toEqual({
        issuance_attempt_id: attemptId,
        issuance_last_attempt_at: "2026-07-13T20:00:00.000Z",
        stalled_requeue_epoch_at: "2026-07-13T18:00:00.000Z"
      });
      await expect(repo.listStalledApprovedWompiEvents(
        "2026-07-13T21:00:00.000Z"
      )).resolves.toContainEqual(expect.objectContaining({
        id: "wompi_a",
        stalled_requeue_epoch_at: "2026-07-13T18:00:00.000Z"
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("rotates the stalled epoch with a successful operator retry against real SQLite", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-14T10:00:00.000Z"));
      const repo = new Repository(sqliteD1(database));
      database.prepare(
        `UPDATE wompi_events
         SET issuance_status = 'FAILED',
             issuance_attempt_id = 'attempt-before-operator',
             issuance_error_code = 'ISSUANCE_ERROR',
             issuance_error_message = 'Fallo transitorio',
             issuance_last_attempt_at = '2026-07-13T22:00:00.000Z',
             stalled_requeue_epoch_at = '2026-07-13T18:00:00.000Z'
         WHERE id = 'wompi_a'`
      ).run();
      const observed = await repo.getWompiIssuanceRetrySnapshotById("wompi_a");

      const attemptId = await repo.claimWompiIssuanceRetry(
        "wompi_a",
        "user_operator",
        observed!
      );

      expect(database.prepare(
        `SELECT issuance_status, issuance_attempt_id, issuance_last_attempt_at,
                stalled_requeue_epoch_at
         FROM wompi_events WHERE id = 'wompi_a'`
      ).get()).toEqual({
        issuance_status: "RETRY_QUEUED",
        issuance_attempt_id: attemptId,
        issuance_last_attempt_at: "2026-07-14T10:00:00.000Z",
        stalled_requeue_epoch_at: "2026-07-14T10:00:00.000Z"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rotates the operator epoch monotonically when the wall clock does not advance", async () => {
    vi.useFakeTimers();
    try {
      const boundary = "2026-07-14T10:00:00.000Z";
      vi.setSystemTime(new Date(boundary));
      const repo = new Repository(sqliteD1(database));
      database.prepare(
        `UPDATE wompi_events
         SET issuance_status = 'FAILED',
             issuance_attempt_id = 'attempt-before-monotonic-retry',
             issuance_error_code = 'ISSUANCE_ERROR',
             issuance_error_message = 'Fallo transitorio',
             issuance_last_attempt_at = ?,
             stalled_requeue_epoch_at = ?
         WHERE id = 'wompi_a'`
      ).run(boundary, boundary);

      const firstObserved = await repo.getWompiIssuanceRetrySnapshotById("wompi_a");
      await expect(repo.claimWompiIssuanceRetry(
        "wompi_a",
        "user_operator",
        firstObserved!
      )).resolves.not.toBeNull();
      expect(database.prepare(
        `SELECT issuance_last_attempt_at, stalled_requeue_epoch_at
         FROM wompi_events WHERE id = 'wompi_a'`
      ).get()).toEqual({
        issuance_last_attempt_at: "2026-07-14T10:00:00.001Z",
        stalled_requeue_epoch_at: "2026-07-14T10:00:00.001Z"
      });

      database.prepare(
        `UPDATE wompi_events
         SET issuance_status = 'FAILED',
             issuance_error_code = 'ISSUANCE_ERROR',
             issuance_error_message = 'Segundo fallo transitorio'
         WHERE id = 'wompi_a'`
      ).run();
      const secondObserved = await repo.getWompiIssuanceRetrySnapshotById("wompi_a");
      await expect(repo.claimWompiIssuanceRetry(
        "wompi_a",
        "user_operator",
        secondObserved!
      )).resolves.not.toBeNull();
      expect(database.prepare(
        `SELECT issuance_last_attempt_at, stalled_requeue_epoch_at
         FROM wompi_events WHERE id = 'wompi_a'`
      ).get()).toEqual({
        issuance_last_attempt_at: "2026-07-14T10:00:00.002Z",
        stalled_requeue_epoch_at: "2026-07-14T10:00:00.002Z"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rotates past the latest valid attempt when the operator clock regresses", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-14T09:00:00.000Z"));
      const repo = new Repository(sqliteD1(database));
      database.prepare(
        `UPDATE wompi_events
         SET issuance_status = 'FAILED',
             issuance_attempt_id = 'attempt-before-regressed-clock',
             issuance_error_code = 'ISSUANCE_ERROR',
             issuance_error_message = 'Fallo transitorio',
             issuance_last_attempt_at = '2026-07-14T12:00:00.000Z',
             stalled_requeue_epoch_at = '2026-07-14T10:00:00.000Z'
         WHERE id = 'wompi_a'`
      ).run();
      const observed = await repo.getWompiIssuanceRetrySnapshotById("wompi_a");

      await expect(repo.claimWompiIssuanceRetry(
        "wompi_a",
        "user_operator",
        observed!
      )).resolves.not.toBeNull();
      expect(database.prepare(
        `SELECT issuance_last_attempt_at, stalled_requeue_epoch_at
         FROM wompi_events WHERE id = 'wompi_a'`
      ).get()).toEqual({
        issuance_last_attempt_at: "2026-07-14T12:00:00.001Z",
        stalled_requeue_epoch_at: "2026-07-14T12:00:00.001Z"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses valid predecessors and tolerates malformed stored timestamps", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-14T09:00:00.000Z"));
      const repo = new Repository(sqliteD1(database));
      database.prepare(
        `UPDATE wompi_events
         SET issuance_status = 'FAILED',
             issuance_attempt_id = 'attempt-before-malformed-timestamp',
             issuance_error_code = 'ISSUANCE_ERROR',
             issuance_error_message = 'Fallo transitorio',
             issuance_last_attempt_at = '2026-07-14T12:00:00.000Z',
             stalled_requeue_epoch_at = 'not-an-iso-timestamp'
         WHERE id = 'wompi_a'`
      ).run();
      const observed = await repo.getWompiIssuanceRetrySnapshotById("wompi_a");

      await expect(repo.claimWompiIssuanceRetry(
        "wompi_a",
        "user_operator",
        observed!
      )).resolves.not.toBeNull();
      expect(database.prepare(
        `SELECT issuance_last_attempt_at, stalled_requeue_epoch_at
         FROM wompi_events WHERE id = 'wompi_a'`
      ).get()).toEqual({
        issuance_last_attempt_at: "2026-07-14T12:00:00.001Z",
        stalled_requeue_epoch_at: "2026-07-14T12:00:00.001Z"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat an impossible calendar timestamp as a valid predecessor", async () => {
    vi.useFakeTimers();
    try {
      const currentTime = "2026-02-28T12:00:00.000Z";
      vi.setSystemTime(new Date(currentTime));
      const repo = new Repository(sqliteD1(database));
      database.prepare(
        `UPDATE wompi_events
         SET issuance_status = 'FAILED',
             issuance_attempt_id = 'attempt-before-invalid-calendar',
             issuance_error_code = 'ISSUANCE_ERROR',
             issuance_error_message = 'Fallo transitorio',
             issuance_last_attempt_at = 'not-an-iso-timestamp',
             stalled_requeue_epoch_at = '2026-02-31T00:00:00.000Z'
         WHERE id = 'wompi_a'`
      ).run();
      const observed = await repo.getWompiIssuanceRetrySnapshotById("wompi_a");

      await expect(repo.claimWompiIssuanceRetry(
        "wompi_a",
        "user_operator",
        observed!
      )).resolves.not.toBeNull();
      expect(database.prepare(
        `SELECT issuance_last_attempt_at, stalled_requeue_epoch_at
         FROM wompi_events WHERE id = 'wompi_a'`
      ).get()).toEqual({
        issuance_last_attempt_at: currentTime,
        stalled_requeue_epoch_at: currentTime
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails closed when the latest valid predecessor cannot be advanced", async () => {
    vi.useFakeTimers();
    try {
      const maximumIso = "9999-12-31T23:59:59.999Z";
      vi.setSystemTime(new Date("2026-02-28T12:00:00.000Z"));
      const repo = new Repository(sqliteD1(database));
      database.prepare(
        `UPDATE wompi_events
         SET issuance_status = 'FAILED',
             issuance_attempt_id = 'attempt-at-maximum-timestamp',
             issuance_error_code = 'ISSUANCE_ERROR',
             issuance_error_message = 'Fallo transitorio',
             issuance_last_attempt_at = ?,
             stalled_requeue_epoch_at = ?
         WHERE id = 'wompi_a'`
      ).run(maximumIso, maximumIso);
      const observed = await repo.getWompiIssuanceRetrySnapshotById("wompi_a");

      await expect(repo.claimWompiIssuanceRetry(
        "wompi_a",
        "user_operator",
        observed!
      )).rejects.toThrow();
      expect(database.prepare(
        `SELECT issuance_status, issuance_attempt_id, issuance_last_attempt_at,
                stalled_requeue_epoch_at
         FROM wompi_events WHERE id = 'wompi_a'`
      ).get()).toEqual({
        issuance_status: "FAILED",
        issuance_attempt_id: "attempt-at-maximum-timestamp",
        issuance_last_attempt_at: maximumIso,
        stalled_requeue_epoch_at: maximumIso
      });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM audit_logs
         WHERE action = 'WOMPI_ISSUANCE_RETRY_QUEUED'
           AND entity_id = 'wompi_a'`
      ).get()).toEqual({ count: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses an exclusive legacy Wompi boundary without changing the inclusive auth counter", async () => {
    const boundary = "2026-07-14T10:00:00.000Z";
    const repo = new Repository(sqliteD1(database));
    database.prepare(
      `INSERT INTO audit_logs (
         id, actor_type, action, entity_type, entity_id, summary, created_at
       ) VALUES
         ('audit_wompi_boundary', 'SYSTEM', 'WOMPI_EVENT_STALLED',
          'wompi_event', 'wompi_boundary', 'old episode', ?),
         ('audit_auth_boundary', 'SYSTEM', 'LOGIN_FAILED',
          'auth', 'login@example.org', 'boundary login', ?)`
    ).run(boundary, boundary);

    await expect(repo.countAuditEntriesSince(
      "WOMPI_EVENT_STALLED",
      "wompi_boundary",
      boundary
    )).resolves.toBe(0);
    await expect(repo.countAuditEntriesSinceForIp(
      "LOGIN_FAILED",
      "login@example.org",
      null,
      boundary
    )).resolves.toBe(1);
  });

  it("counts current-episode requeues even when their audit clock is behind the epoch", async () => {
    const auditClock = "2026-07-14T10:00:00.000Z";
    const episodeId = "2026-07-14T10:00:00.001Z";
    const repo = new Repository(sqliteD1(database));
    const insert = database.prepare(
      `INSERT INTO audit_logs (
         id, actor_type, action, entity_type, entity_id, summary,
         metadata_json, created_at
       ) VALUES (?, 'SYSTEM', 'WOMPI_EVENT_REQUEUED', 'wompi_event',
         'wompi_frozen_clock', 'new episode', ?, ?)`
    );
    for (let index = 1; index <= 3; index += 1) {
      insert.run(
        `audit_frozen_${index}`,
        JSON.stringify({ stalledRequeueEpochAt: episodeId }),
        auditClock
      );
    }

    await expect(repo.countAuditEntriesSince(
      "WOMPI_EVENT_REQUEUED",
      "wompi_frozen_clock",
      episodeId
    )).resolves.toBe(3);
  });

  it("treats only a non-empty JSON string as a stalled-episode audit identity", async () => {
    const episodeId = "2026-07-14T10:00:00.001Z";
    const afterBoundary = "2026-07-14T10:00:00.002Z";
    const beforeBoundary = "2026-07-14T10:00:00.000Z";
    const repo = new Repository(sqliteD1(database));
    const fixtures = [
      { id: "malformed", metadata: "not-json", createdAt: afterBoundary, expected: 1 },
      { id: "json-null", metadata: "null", createdAt: afterBoundary, expected: 1 },
      { id: "scalar", metadata: "42", createdAt: afterBoundary, expected: 1 },
      { id: "array", metadata: "[]", createdAt: afterBoundary, expected: 1 },
      { id: "missing", metadata: "{}", createdAt: afterBoundary, expected: 1 },
      { id: "empty", metadata: '{"stalledRequeueEpochAt":""}', createdAt: afterBoundary, expected: 1 },
      { id: "number", metadata: '{"stalledRequeueEpochAt":7}', createdAt: afterBoundary, expected: 1 },
      { id: "exact", metadata: JSON.stringify({ stalledRequeueEpochAt: episodeId }), createdAt: beforeBoundary, expected: 1 },
      { id: "different", metadata: '{"stalledRequeueEpochAt":"2026-07-14T09:00:00.000Z"}', createdAt: afterBoundary, expected: 0 }
    ] as const;
    const insert = database.prepare(
      `INSERT INTO audit_logs (
         id, actor_type, action, entity_type, entity_id, summary,
         metadata_json, created_at
       ) VALUES (?, 'SYSTEM', 'WOMPI_EVENT_REQUEUED', 'wompi_event', ?,
         'episode metadata fixture', ?, ?)`
    );
    for (const fixture of fixtures) {
      insert.run(`audit_metadata_${fixture.id}`, `wompi_metadata_${fixture.id}`, fixture.metadata, fixture.createdAt);
    }

    for (const fixture of fixtures) {
      await expect(repo.countAuditEntriesSince(
        "WOMPI_EVENT_REQUEUED",
        `wompi_metadata_${fixture.id}`,
        episodeId
      ), fixture.id).resolves.toBe(fixture.expected);
    }
  });

  it("mirrors typed stalled-episode audit identities in the in-memory repository", async () => {
    const episodeId = "2026-07-14T10:00:00.001Z";
    const afterBoundary = "2026-07-14T10:00:00.002Z";
    const beforeBoundary = "2026-07-14T10:00:00.000Z";
    const db = new InMemoryD1();
    const repo = new Repository(db as unknown as D1Database);
    const fixtures = [
      { id: "malformed", metadata: "not-json", createdAt: afterBoundary, expected: 1 },
      { id: "json-null", metadata: "null", createdAt: afterBoundary, expected: 1 },
      { id: "scalar", metadata: "42", createdAt: afterBoundary, expected: 1 },
      { id: "array", metadata: "[]", createdAt: afterBoundary, expected: 1 },
      { id: "missing", metadata: "{}", createdAt: afterBoundary, expected: 1 },
      { id: "empty", metadata: '{"stalledRequeueEpochAt":""}', createdAt: afterBoundary, expected: 1 },
      { id: "number", metadata: '{"stalledRequeueEpochAt":7}', createdAt: afterBoundary, expected: 1 },
      { id: "exact", metadata: JSON.stringify({ stalledRequeueEpochAt: episodeId }), createdAt: beforeBoundary, expected: 1 },
      { id: "different", metadata: '{"stalledRequeueEpochAt":"2026-07-14T09:00:00.000Z"}', createdAt: afterBoundary, expected: 0 }
    ] as const;
    for (const fixture of fixtures) {
      db.audits.push({
        id: `audit_in_memory_metadata_${fixture.id}`,
        actor_type: "SYSTEM",
        actor_id: null,
        action: "WOMPI_EVENT_REQUEUED",
        entity_type: "wompi_event",
        entity_id: `wompi_in_memory_metadata_${fixture.id}`,
        summary: "episode metadata fixture",
        metadata_json: fixture.metadata,
        created_at: fixture.createdAt
      });
    }

    for (const fixture of fixtures) {
      await expect(repo.countAuditEntriesSince(
        "WOMPI_EVENT_REQUEUED",
        `wompi_in_memory_metadata_${fixture.id}`,
        episodeId
      ), fixture.id).resolves.toBe(fixture.expected);
    }
  });

  const duplicateEpisodeId = "2026-07-14T10:00:00.001Z";
  const duplicateEpisodeFixtures = [
    {
      id: "string-then-current",
      metadata: `{"stalledRequeueEpochAt":"prior","stalledRequeueEpochAt":"${duplicateEpisodeId}"}`,
      createdAt: "2026-07-14T10:00:00.000Z",
      expectedCount: 1,
      expectedStalledTotal: 1
    },
    {
      id: "current-then-string",
      metadata: `{"stalledRequeueEpochAt":"${duplicateEpisodeId}","stalledRequeueEpochAt":"prior"}`,
      createdAt: "2026-07-14T10:00:00.002Z",
      expectedCount: 0,
      expectedStalledTotal: 2
    },
    {
      id: "string-then-number",
      metadata: `{"stalledRequeueEpochAt":"${duplicateEpisodeId}","stalledRequeueEpochAt":7}`,
      createdAt: "2026-07-14T10:00:00.000Z",
      expectedCount: 0,
      expectedStalledTotal: 2
    },
    {
      id: "string-then-null",
      metadata: `{"stalledRequeueEpochAt":"${duplicateEpisodeId}","stalledRequeueEpochAt":null}`,
      createdAt: "2026-07-14T10:00:00.000Z",
      expectedCount: 0,
      expectedStalledTotal: 2
    },
    {
      id: "string-then-empty",
      metadata: `{"stalledRequeueEpochAt":"${duplicateEpisodeId}","stalledRequeueEpochAt":""}`,
      createdAt: "2026-07-14T10:00:00.000Z",
      expectedCount: 0,
      expectedStalledTotal: 2
    },
    {
      id: "escaped-current-last",
      metadata: `{"stalledRequeueEpochAt":"prior","stalled\\u0052equeueEpochAt":"${duplicateEpisodeId}"}`,
      createdAt: "2026-07-14T10:00:00.000Z",
      expectedCount: 1,
      expectedStalledTotal: 1
    },
    {
      id: "nested-current-ignored",
      metadata: `{"stalledRequeueEpochAt":"prior","nested":{"stalledRequeueEpochAt":"${duplicateEpisodeId}"}}`,
      createdAt: "2026-07-14T10:00:00.002Z",
      expectedCount: 0,
      expectedStalledTotal: 2
    }
  ] as const;

  it("uses the last decoded root duplicate key when counting in SQLite and memory", async () => {
    const real = new Repository(sqliteD1(database));
    const memoryDb = new InMemoryD1();
    const memory = new Repository(memoryDb as unknown as D1Database);
    const insert = database.prepare(
      `INSERT INTO audit_logs (
         id, actor_type, action, entity_type, entity_id, summary,
         metadata_json, created_at
       ) VALUES (?, 'SYSTEM', 'WOMPI_EVENT_REQUEUED', 'wompi_event', ?,
         'duplicate episode key', ?, ?)`
    );
    for (const fixture of duplicateEpisodeFixtures) {
      const audit = {
        id: `audit_duplicate_count_${fixture.id}`,
        actor_type: "SYSTEM",
        actor_id: null,
        action: "WOMPI_EVENT_REQUEUED",
        entity_type: "wompi_event",
        entity_id: `wompi_duplicate_count_${fixture.id}`,
        summary: "duplicate episode key",
        metadata_json: fixture.metadata,
        created_at: fixture.createdAt
      };
      insert.run(audit.id, audit.entity_id, audit.metadata_json, audit.created_at);
      memoryDb.audits.push(audit);
    }

    for (const fixture of duplicateEpisodeFixtures) {
      const entityId = `wompi_duplicate_count_${fixture.id}`;
      await expect(real.countAuditEntriesSince(
        "WOMPI_EVENT_REQUEUED",
        entityId,
        duplicateEpisodeId
      ), `SQLite ${fixture.id}`).resolves.toBe(fixture.expectedCount);
      await expect(memory.countAuditEntriesSince(
        "WOMPI_EVENT_REQUEUED",
        entityId,
        duplicateEpisodeId
      ), `memory ${fixture.id}`).resolves.toBe(fixture.expectedCount);
    }
  });

  it("uses the last decoded root duplicate key for atomic stalled inserts in SQLite and memory", async () => {
    const real = new Repository(sqliteD1(database));
    const memoryDb = new InMemoryD1();
    const memory = new Repository(memoryDb as unknown as D1Database);
    const insert = database.prepare(
      `INSERT INTO audit_logs (
         id, actor_type, action, entity_type, entity_id, summary,
         metadata_json, created_at
       ) VALUES (?, 'SYSTEM', 'WOMPI_EVENT_STALLED', 'wompi_event', ?,
         'duplicate episode key', ?, ?)`
    );
    for (const fixture of duplicateEpisodeFixtures) {
      const audit = {
        id: `audit_duplicate_stalled_${fixture.id}`,
        actor_type: "SYSTEM",
        actor_id: null,
        action: "WOMPI_EVENT_STALLED",
        entity_type: "wompi_event",
        entity_id: `wompi_duplicate_stalled_${fixture.id}`,
        summary: "duplicate episode key",
        metadata_json: fixture.metadata,
        created_at: fixture.createdAt
      };
      insert.run(audit.id, audit.entity_id, audit.metadata_json, audit.created_at);
      memoryDb.audits.push(audit);
      const current = {
        action: "WOMPI_EVENT_STALLED",
        entityType: "wompi_event",
        entityId: audit.entity_id,
        summary: "current episode",
        metadata: { stalledRequeueEpochAt: duplicateEpisodeId }
      };
      await real.createAudit(current);
      await memory.createAudit(current);
    }

    for (const fixture of duplicateEpisodeFixtures) {
      const entityId = `wompi_duplicate_stalled_${fixture.id}`;
      await expect(real.countAuditEntries(
        "WOMPI_EVENT_STALLED",
        entityId
      ), `SQLite ${fixture.id}`).resolves.toBe(fixture.expectedStalledTotal);
      await expect(memory.countAuditEntries(
        "WOMPI_EVENT_STALLED",
        entityId
      ), `memory ${fixture.id}`).resolves.toBe(fixture.expectedStalledTotal);
    }
  });

  it("uses the same typed episode identity when atomically inserting stalled audits", async () => {
    const episodeId = "2026-07-14T10:00:00.001Z";
    const beforeBoundary = "2026-07-14T10:00:00.000Z";
    const afterBoundary = "2026-07-14T10:00:00.002Z";
    const repo = new Repository(sqliteD1(database));
    const fixtures = [
      { id: "malformed", metadata: "not-json", createdAt: beforeBoundary, expectedTotal: 2 },
      { id: "json-null", metadata: "null", createdAt: afterBoundary, expectedTotal: 1 },
      { id: "scalar", metadata: "42", createdAt: afterBoundary, expectedTotal: 1 },
      { id: "array", metadata: "[]", createdAt: afterBoundary, expectedTotal: 1 },
      { id: "missing", metadata: "{}", createdAt: afterBoundary, expectedTotal: 1 },
      { id: "empty", metadata: '{"stalledRequeueEpochAt":""}', createdAt: afterBoundary, expectedTotal: 1 },
      { id: "number", metadata: '{"stalledRequeueEpochAt":7}', createdAt: afterBoundary, expectedTotal: 1 },
      { id: "exact", metadata: JSON.stringify({ stalledRequeueEpochAt: episodeId }), createdAt: beforeBoundary, expectedTotal: 1 },
      { id: "different", metadata: '{"stalledRequeueEpochAt":"2026-07-14T09:00:00.000Z"}', createdAt: afterBoundary, expectedTotal: 2 }
    ] as const;
    const insert = database.prepare(
      `INSERT INTO audit_logs (
         id, actor_type, action, entity_type, entity_id, summary,
         metadata_json, created_at
       ) VALUES (?, 'SYSTEM', 'WOMPI_EVENT_STALLED', 'wompi_event', ?,
         'prior episode metadata fixture', ?, ?)`
    );
    for (const fixture of fixtures) {
      const entityId = `wompi_stalled_metadata_${fixture.id}`;
      insert.run(`audit_stalled_metadata_${fixture.id}`, entityId, fixture.metadata, fixture.createdAt);
      await repo.createAudit({
        action: "WOMPI_EVENT_STALLED",
        entityType: "wompi_event",
        entityId,
        summary: "current episode",
        metadata: { stalledRequeueEpochAt: episodeId }
      });
      await expect(repo.countAuditEntries(
        "WOMPI_EVENT_STALLED",
        entityId
      ), fixture.id).resolves.toBe(fixture.expectedTotal);
    }
  });

  it("atomically records one stalled audit for concurrent observers of one episode", async () => {
    const episodeId = "2026-07-14T10:00:00.001Z";
    const repo = new Repository(sqliteD1(database));
    const audit = () => repo.createAudit({
      action: "WOMPI_EVENT_STALLED",
      entityType: "wompi_event",
      entityId: "wompi_atomic_stalled",
      summary: "stalled",
      metadata: { stalledRequeueEpochAt: episodeId }
    });

    await Promise.all([audit(), audit()]);

    await expect(repo.countAuditEntriesSince(
      "WOMPI_EVENT_STALLED",
      "wompi_atomic_stalled",
      episodeId
    )).resolves.toBe(1);
  });

  it("records a new stalled audit for a later episode instead of lifetime-deduplicating", async () => {
    const firstEpisode = "2026-07-14T10:00:00.001Z";
    const secondEpisode = "2026-07-14T10:00:00.002Z";
    const repo = new Repository(sqliteD1(database));
    const createForEpisode = (episodeId: string) => repo.createAudit({
      action: "WOMPI_EVENT_STALLED",
      entityType: "wompi_event",
      entityId: "wompi_later_stalled_episode",
      summary: "stalled",
      metadata: { stalledRequeueEpochAt: episodeId }
    });

    await createForEpisode(firstEpisode);
    await createForEpisode(secondEpisode);

    await expect(repo.countAuditEntries(
      "WOMPI_EVENT_STALLED",
      "wompi_later_stalled_episode"
    )).resolves.toBe(2);
    await expect(repo.countAuditEntriesSince(
      "WOMPI_EVENT_STALLED",
      "wompi_later_stalled_episode",
      secondEpisode
    )).resolves.toBe(1);
  });

  it("leaves the stalled epoch unchanged when the operator retry CAS loses against real SQLite", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-14T10:00:00.000Z"));
      const repo = new Repository(sqliteD1(database));
      database.prepare(
        `UPDATE wompi_events
         SET issuance_status = 'FAILED',
             issuance_attempt_id = 'attempt-before-lost-cas',
             issuance_error_code = 'ISSUANCE_ERROR',
             issuance_error_message = 'Fallo observado',
             issuance_last_attempt_at = '2026-07-13T22:00:00.000Z',
             stalled_requeue_epoch_at = '2026-07-13T18:00:00.000Z'
         WHERE id = 'wompi_a'`
      ).run();
      const observed = await repo.getWompiIssuanceRetrySnapshotById("wompi_a");
      database.prepare(
        "UPDATE wompi_events SET issuance_error_message = 'Fallo concurrente' WHERE id = 'wompi_a'"
      ).run();

      await expect(repo.claimWompiIssuanceRetry(
        "wompi_a",
        "user_operator",
        observed!
      )).resolves.toBeNull();
      expect(database.prepare(
        `SELECT issuance_attempt_id, issuance_last_attempt_at, stalled_requeue_epoch_at
         FROM wompi_events WHERE id = 'wompi_a'`
      ).get()).toEqual({
        issuance_attempt_id: "attempt-before-lost-cas",
        issuance_last_attempt_at: "2026-07-13T22:00:00.000Z",
        stalled_requeue_epoch_at: "2026-07-13T18:00:00.000Z"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not overwrite a concurrent epoch rotation when the other retry snapshot fields still match", async () => {
    vi.useFakeTimers();
    try {
      const boundary = "2026-07-14T10:00:00.000Z";
      const concurrentEpoch = "2026-07-14T10:00:00.005Z";
      vi.setSystemTime(new Date(boundary));
      const repo = new Repository(sqliteD1(database));
      database.prepare(
        `UPDATE wompi_events
         SET issuance_status = 'FAILED',
             issuance_attempt_id = 'attempt-before-concurrent-epoch',
             issuance_error_code = 'ISSUANCE_ERROR',
             issuance_error_message = 'Fallo observado',
             issuance_last_attempt_at = ?,
             stalled_requeue_epoch_at = ?
         WHERE id = 'wompi_a'`
      ).run(boundary, boundary);
      const observed = await repo.getWompiIssuanceRetrySnapshotById("wompi_a");
      database.prepare(
        "UPDATE wompi_events SET stalled_requeue_epoch_at = ? WHERE id = 'wompi_a'"
      ).run(concurrentEpoch);

      await expect(repo.claimWompiIssuanceRetry(
        "wompi_a",
        "user_operator",
        observed!
      )).resolves.toBeNull();
      expect(database.prepare(
        `SELECT issuance_attempt_id, issuance_last_attempt_at, stalled_requeue_epoch_at
         FROM wompi_events WHERE id = 'wompi_a'`
      ).get()).toEqual({
        issuance_attempt_id: "attempt-before-concurrent-epoch",
        issuance_last_attempt_at: boundary,
        stalled_requeue_epoch_at: concurrentEpoch
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not overwrite a concurrent last-attempt-only change or append a retry audit", async () => {
    vi.useFakeTimers();
    try {
      const boundary = "2026-07-14T10:00:00.000Z";
      const concurrentAttemptAt = "2026-07-14T10:00:00.005Z";
      vi.setSystemTime(new Date(boundary));
      const repo = new Repository(sqliteD1(database));
      database.prepare(
        `UPDATE wompi_events
         SET issuance_status = 'FAILED',
             issuance_attempt_id = 'attempt-before-concurrent-timestamp',
             issuance_error_code = 'ISSUANCE_ERROR',
             issuance_error_message = 'Fallo observado',
             issuance_last_attempt_at = ?,
             stalled_requeue_epoch_at = ?
         WHERE id = 'wompi_a'`
      ).run(boundary, boundary);
      const observed = await repo.getWompiIssuanceRetrySnapshotById("wompi_a");
      database.prepare(
        "UPDATE wompi_events SET issuance_last_attempt_at = ? WHERE id = 'wompi_a'"
      ).run(concurrentAttemptAt);

      await expect(repo.claimWompiIssuanceRetry(
        "wompi_a",
        "user_operator",
        observed!
      )).resolves.toBeNull();
      expect(database.prepare(
        `SELECT issuance_status, issuance_attempt_id, issuance_last_attempt_at,
                stalled_requeue_epoch_at
         FROM wompi_events WHERE id = 'wompi_a'`
      ).get()).toEqual({
        issuance_status: "FAILED",
        issuance_attempt_id: "attempt-before-concurrent-timestamp",
        issuance_last_attempt_at: concurrentAttemptAt,
        stalled_requeue_epoch_at: boundary
      });
      expect(database.prepare(
        `SELECT COUNT(*) AS count FROM audit_logs
         WHERE action = 'WOMPI_ISSUANCE_RETRY_QUEUED'
           AND entity_id = 'wompi_a'`
      ).get()).toEqual({ count: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not revive a current attempt after its DLQ wins the stalled-sweep race", async () => {
    const repo = new Repository(sqliteD1(database));
    database.prepare(
      `UPDATE wompi_events
       SET issuance_status = 'PROCESSING',
           issuance_attempt_id = 'attempt-dlq-winner',
           issuance_last_attempt_at = '2026-07-13T18:00:00.000Z'
       WHERE id = 'wompi_a'`
    ).run();

    await expect(repo.markWompiIssuanceDeadLettered(
      "wompi_a",
      "attempt-dlq-winner"
    )).resolves.toBe(true);
    await expect(repo.claimStalledWompiIssuanceAttempt(
      "wompi_a",
      "attempt-dlq-winner",
      "2026-07-13T19:00:00.000Z"
    )).resolves.toBeNull();

    expect(database.prepare(
      `SELECT issuance_status, issuance_attempt_id, processed_at
       FROM wompi_events WHERE id = 'wompi_a'`
    ).get()).toEqual({
      issuance_status: "DEAD_LETTERED",
      issuance_attempt_id: "attempt-dlq-winner",
      processed_at: expect.any(String)
    });
  });

  it("claims only unprocessed status-null work through the null-attempt legacy path", async () => {
    insertApprovedWompiEvent(database, "wompi_processed_legacy");
    insertApprovedWompiEvent(database, "wompi_eligible_legacy");
    database.prepare(
      `UPDATE wompi_events
       SET received_at = '2026-07-13T18:00:00.000Z'
       WHERE id IN ('wompi_a', 'wompi_b', 'wompi_processed_legacy', 'wompi_eligible_legacy')`
    ).run();
    database.prepare(
      `UPDATE wompi_events
       SET issuance_status = 'FAILED',
           issuance_attempt_id = NULL,
           issuance_last_attempt_at = '2026-07-13T18:00:00.000Z'
       WHERE id = 'wompi_b'`
    ).run();
    database.prepare(
      `UPDATE wompi_events
       SET processed_at = '2026-07-13T18:30:00.000Z'
       WHERE id = 'wompi_processed_legacy'`
    ).run();
    const repo = new Repository(sqliteD1(database));

    const stalled = await repo.listStalledApprovedWompiEvents(
      "2026-07-13T19:00:00.000Z"
    );
    const failedClaim = await repo.claimStalledWompiIssuanceAttempt(
      "wompi_b",
      null,
      "2026-07-13T19:00:00.000Z"
    );
    const processedClaim = await repo.claimStalledWompiIssuanceAttempt(
      "wompi_processed_legacy",
      null,
      "2026-07-13T19:00:00.000Z"
    );
    const eligibleClaim = await repo.claimStalledWompiIssuanceAttempt(
      "wompi_eligible_legacy",
      null,
      "2026-07-13T19:00:00.000Z"
    );

    expect(stalled.map((event) => event.id).sort()).toEqual([
      "wompi_a",
      "wompi_eligible_legacy"
    ]);
    expect(failedClaim).toBeNull();
    expect(processedClaim).toBeNull();
    expect(eligibleClaim).toEqual(expect.any(String));
  });

  it("keeps an outcome-ambiguous fiscal claim non-expiring until reconciliation", async () => {
    insertAcceptedDocument(database, "wompi_a", "dte_fenced_claim");
    database.prepare(
      `UPDATE dte_documents
       SET status = 'SIGNED', signed_jws = 'stable-signed-jws', sello_recibido = NULL, accepted_at = NULL
       WHERE id = 'dte_fenced_claim'`
    ).run();
    const repo = new Repository(sqliteD1(database));

    const firstClaim = "fiscal-first";
    const secondClaim = "fiscal-second";
    await expect(repo.claimDocumentTransmission(
      "dte_fenced_claim",
      "SIGNED",
      "stable-signed-jws",
      firstClaim
    )).resolves.toBe(true);
    database.prepare(
      "UPDATE dte_documents SET fiscal_operation_claimed_at = '2000-01-01T00:00:00.000Z' WHERE id = 'dte_fenced_claim'"
    ).run();
    await expect(repo.claimDocumentTransmission(
      "dte_fenced_claim",
      "SIGNED",
      "stable-signed-jws",
      secondClaim
    )).resolves.toBe(false);

    await expect(repo.completeDocumentTransmission("dte_fenced_claim", secondClaim, {
      status: "ACCEPTED",
      sello: "STALE-SEAL",
      mhEstado: "PROCESADO",
      observaciones: [],
      acceptedAt: "2026-07-13T20:00:00.000Z"
    })).resolves.toBe(false);
    await expect(repo.completeDocumentTransmission("dte_fenced_claim", firstClaim, {
      status: "ACCEPTED",
      sello: "CURRENT-SEAL",
      mhEstado: "PROCESADO",
      observaciones: [],
      acceptedAt: "2026-07-13T20:01:00.000Z"
    })).resolves.toBe(true);

    expect(database.prepare(
      `SELECT status, sello_recibido, fiscal_operation_claim_id
       FROM dte_documents WHERE id = 'dte_fenced_claim'`
    ).get()).toEqual({
      status: "ACCEPTED",
      sello_recibido: "CURRENT-SEAL",
      fiscal_operation_claim_id: null
    });
  });

  it("rejects duplicate reserved generation codes", () => {
    reserve(database, "wompi_a", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA");

    expect(() =>
      reserve(database, "wompi_b", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")
    ).toThrow(/UNIQUE constraint failed: wompi_events\.reserved_codigo_generacion/);
  });

  it("rejects duplicate environment, prefix, and control-sequence reservations", () => {
    reserve(database, "wompi_a", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA");

    expect(() =>
      database
        .prepare(
          `UPDATE wompi_events
           SET control_prefix = ?, control_sequence = ?
           WHERE id = ?`
        )
        .run("M001P004", 1, "wompi_b")
    ).toThrow(/UNIQUE constraint failed: wompi_events\.environment, wompi_events\.control_prefix, wompi_events\.control_sequence/);
  });

  it("canonicalizes a lowercase-only legacy sequence before reserving", () => {
    const legacy = new DatabaseSync(":memory:");
    try {
      legacy.exec(readFileSync(initMigrationPath, "utf8"));
      legacy.exec(readFileSync(auditActorMigrationPath, "utf8"));
      legacy.prepare(
        "INSERT INTO document_sequences (environment, control_prefix, next_value) VALUES ('00', 'm001p004', 17)"
      ).run();

      legacy.exec(readFileSync(issuanceMigrationPath, "utf8"));
      insertApprovedWompiEvent(legacy, "wompi_legacy_lowercase");
      reserve(legacy, "wompi_legacy_lowercase", "DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD");

      expect(reservation(legacy, "wompi_legacy_lowercase")?.control_sequence).toBe(17);
      expect(sequenceRows(legacy)).toEqual([
        { environment: "00", control_prefix: "M001P004", next_value: 18 }
      ]);
    } finally {
      legacy.close();
    }
  });

  it("merges case-colliding legacy sequences using the highest next value", () => {
    const legacy = new DatabaseSync(":memory:");
    try {
      legacy.exec(readFileSync(initMigrationPath, "utf8"));
      legacy.exec(readFileSync(auditActorMigrationPath, "utf8"));
      legacy.exec(`
        INSERT INTO document_sequences (environment, control_prefix, next_value)
        VALUES ('00', 'M001P004', 4), ('00', 'm001p004', 23);
      `);

      legacy.exec(readFileSync(issuanceMigrationPath, "utf8"));
      insertApprovedWompiEvent(legacy, "wompi_legacy_collision");
      reserve(legacy, "wompi_legacy_collision", "EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE");

      expect(reservation(legacy, "wompi_legacy_collision")?.control_sequence).toBe(23);
      expect(sequenceRows(legacy)).toEqual([
        { environment: "00", control_prefix: "M001P004", next_value: 24 }
      ]);
    } finally {
      legacy.close();
    }
  });
});

function insertApprovedWompiEvent(database: DatabaseSync, id: string): void {
  database
    .prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body
       ) VALUES (?, ?, '00', 'ExitosaAprobada', 1000, '{}')`
    )
    .run(id, `transaction_${id}`);
}

function insertAcceptedDocument(
  database: DatabaseSync,
  wompiEventId: string,
  documentId: string
): void {
  database.prepare(
    `INSERT INTO dte_documents (
       id, wompi_event_id, environment, codigo_generacion, numero_control,
       status, plain_json, sello_recibido, mh_estado, donor_email,
       amount_cents, issued_at, accepted_at
     ) VALUES (?, ?, '00', ?, ?, 'ACCEPTED', '{}', 'SELLO', 'PROCESADO',
       'donor@example.org', 1000, '2026-07-13T18:00:00.000Z',
       '2026-07-13T18:00:01.000Z')`
  ).run(
    documentId,
    wompiEventId,
    `AAAAAAAA-AAAA-4AAA-8AAA-${documentId.padEnd(12, "A").slice(0, 12)}`,
    `DTE-15-M001P004-${documentId.padEnd(15, "0").slice(0, 15)}`
  );
}

function reserve(database: DatabaseSync, id: string, codigoGeneracion: string): void {
  database
    .prepare(
      `UPDATE wompi_events
       SET control_prefix = ?, reserved_codigo_generacion = ?
       WHERE id = ?
         AND control_prefix IS NULL
         AND reserved_codigo_generacion IS NULL`
    )
    .run("M001P004", codigoGeneracion, id);
}

function reservation(database: DatabaseSync, id: string): {
  control_sequence: number;
  reserved_numero_control: string;
  reserved_codigo_generacion: string;
} | undefined {
  return database
    .prepare(
      `SELECT control_sequence, reserved_numero_control, reserved_codigo_generacion
       FROM wompi_events
       WHERE id = ?`
    )
    .get(id) as
    | {
        control_sequence: number;
        reserved_numero_control: string;
        reserved_codigo_generacion: string;
      }
    | undefined;
}

function nextValue(database: DatabaseSync): number | undefined {
  return database
    .prepare(
      `SELECT next_value
       FROM document_sequences
       WHERE environment = '00' AND control_prefix = 'M001P004'`
    )
    .get()?.next_value as number | undefined;
}

function sequenceRows(database: DatabaseSync): Array<{
  environment: string;
  control_prefix: string;
  next_value: number;
}> {
  return database
    .prepare(
      `SELECT environment, control_prefix, next_value
       FROM document_sequences
       ORDER BY environment, control_prefix`
    )
    .all() as Array<{
      environment: string;
      control_prefix: string;
      next_value: number;
    }>;
}

function insertRawFiscalCorrection(
  database: DatabaseSync,
  input: {
    id: string;
    requestId: string;
    attemptNumber: number;
    wompiEventId: string;
    correctedReceptorJson?: string;
  }
): void {
  database.prepare(
    `INSERT INTO fiscal_corrections (
       id, request_id, request_payload_sha256, attempt_number, target_kind,
       wompi_event_id, environment, status, before_receptor_json,
       corrected_receptor_json, changed_fields_json, processing_claim_id, created_by
     ) VALUES (?, ?, 'sha', ?, 'WOMPI_EVENT', ?, '00', 'QUEUED', '{}', ?, '[]',
       'processing', 'user_operator')`
  ).run(
    input.id,
    input.requestId,
    input.attemptNumber,
    input.wompiEventId,
    input.correctedReceptorJson ?? "{}"
  );
}
