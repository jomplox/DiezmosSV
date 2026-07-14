import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { legacyIssuanceAttemptId, Repository } from "../../src/worker/storage/repository";

const initMigrationPath = resolve(import.meta.dirname, "../../migrations/0001_init.sql");
const auditActorMigrationPath = resolve(import.meta.dirname, "../../migrations/0013_audit_actor_context.sql");
const transmissionPendingMigrationPath = resolve(import.meta.dirname, "../../migrations/0014_transmission_pending_status.sql");
const issuanceMigrationPath = resolve(import.meta.dirname, "../../migrations/0019_wompi_issuance_lifecycle.sql");

describe("Wompi issuance reservation migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(readFileSync(initMigrationPath, "utf8"));
    database.exec(readFileSync(auditActorMigrationPath, "utf8"));
    database.exec(readFileSync(transmissionPendingMigrationPath, "utf8"));
    database.exec(readFileSync(issuanceMigrationPath, "utf8"));
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

    expect(columns.map((column) => column.name)).toContain("issuance_attempt_id");
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

  it("excludes an active email claim, reclaims failed/stale work with the same key, and leaves legacy PENDING manual", async () => {
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
    const failedRetry = await repo.claimEmailDelivery(input);
    expect(failedRetry).toMatchObject({
      id: first!.id,
      idempotencyKey: first!.idempotencyKey,
      claimToken: expect.any(String)
    });
    expect(failedRetry!.claimToken).not.toBe(first!.claimToken);

    database.prepare(
      "UPDATE email_deliveries SET claim_attempted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
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

  it("fences an expired DTE claimant from storing a result or deferring a newer lease", async () => {
    insertAcceptedDocument(database, "wompi_a", "dte_fenced_claim");
    database.prepare(
      `UPDATE dte_documents
       SET status = 'SIGNED', sello_recibido = NULL, accepted_at = NULL
       WHERE id = 'dte_fenced_claim'`
    ).run();
    const repo = new Repository(sqliteD1(database));

    const firstClaim = await repo.claimDteTransmission(
      "dte_fenced_claim",
      "stable-signed-jws",
      "2026-07-13T19:00:00.000Z"
    );
    expect(firstClaim).toEqual(expect.any(String));
    database.prepare(
      "UPDATE dte_documents SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = 'dte_fenced_claim'"
    ).run();
    const secondClaim = await repo.claimDteTransmission(
      "dte_fenced_claim",
      "stable-signed-jws",
      "2026-07-13T19:00:00.000Z"
    );
    expect(secondClaim).toEqual(expect.any(String));
    expect(secondClaim).not.toBe(firstClaim);

    await expect(repo.updateDocumentMhResult("dte_fenced_claim", firstClaim!, {
      status: "ACCEPTED",
      sello: "STALE-SEAL",
      mhEstado: "PROCESADO",
      observaciones: [],
      acceptedAt: "2026-07-13T20:00:00.000Z"
    })).resolves.toBe(false);
    await expect(repo.updateDocumentMhResult("dte_fenced_claim", firstClaim!, {
      status: "FAILED",
      sello: null,
      mhEstado: "PIPELINE_ERROR",
      observaciones: ["stale claimant failed"],
      acceptedAt: null
    })).resolves.toBe(false);
    await expect(repo.markDocumentTransmissionDeferred(
      "dte_fenced_claim",
      firstClaim!,
      "stale claimant timeout"
    )).resolves.toBe(false);
    await expect(repo.updateDocumentMhResult("dte_fenced_claim", secondClaim!, {
      status: "ACCEPTED",
      sello: "CURRENT-SEAL",
      mhEstado: "PROCESADO",
      observaciones: [],
      acceptedAt: "2026-07-13T20:01:00.000Z"
    })).resolves.toBe(true);

    expect(database.prepare(
      `SELECT status, sello_recibido, transmission_claim_id
       FROM dte_documents WHERE id = 'dte_fenced_claim'`
    ).get()).toEqual({
      status: "ACCEPTED",
      sello_recibido: "CURRENT-SEAL",
      transmission_claim_id: null
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

function sqliteD1(database: DatabaseSync): D1Database {
  function prepare(query: string): D1PreparedStatement {
    let boundValues: unknown[] = [];
    const statement = {
      bind(...values: unknown[]) {
        boundValues = values;
        return statement;
      },
      async first<T>() {
        return (database.prepare(query).get(...sqliteValues(boundValues)) ?? null) as T | null;
      },
      async run() {
        const result = database.prepare(query).run(...sqliteValues(boundValues));
        return {
          success: true,
          meta: { changes: Number(result.changes) },
          results: []
        } as unknown as D1Result;
      },
      async all<T>() {
        return {
          success: true,
          meta: {},
          results: database.prepare(query).all(...sqliteValues(boundValues)) as T[]
        } as unknown as D1Result<T>;
      },
      raw: async () => [],
      columnNames: async () => []
    };
    return statement as unknown as D1PreparedStatement;
  }

  return {
    prepare,
    async batch<T = unknown>(statements: D1PreparedStatement[]) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results: D1Result<T>[] = [];
        for (const statement of statements) {
          results.push(await statement.run<T>());
        }
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async () => ({ count: 0, duration: 0 }),
    dump: async () => new ArrayBuffer(0)
  } as unknown as D1Database;
}

function sqliteValues(values: unknown[]): Array<string | number | bigint | Uint8Array | null> {
  return values.map((value) => {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "bigint" ||
      value instanceof Uint8Array
    ) {
      return value;
    }
    throw new TypeError(`Unsupported SQLite bind value: ${typeof value}`);
  });
}
