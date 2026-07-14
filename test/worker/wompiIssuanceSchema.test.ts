import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { legacyIssuanceAttemptId, Repository } from "../../src/worker/storage/repository";

const initMigrationPath = resolve(import.meta.dirname, "../../migrations/0001_init.sql");
const auditActorMigrationPath = resolve(import.meta.dirname, "../../migrations/0013_audit_actor_context.sql");
const issuanceMigrationPath = resolve(import.meta.dirname, "../../migrations/0019_wompi_issuance_lifecycle.sql");

describe("Wompi issuance reservation migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(readFileSync(initMigrationPath, "utf8"));
    database.exec(readFileSync(auditActorMigrationPath, "utf8"));
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
      idempotencyKey: expect.stringMatching(/^dsv-receipt-v1-[a-f0-9]{64}$/)
    });
    await expect(repo.claimEmailDelivery(input)).resolves.toBeNull();

    database.prepare(
      "UPDATE email_deliveries SET status = 'FAILED' WHERE id = ?"
    ).run(first!.id);
    const failedRetry = await repo.claimEmailDelivery(input);
    expect(failedRetry).toEqual(first);

    database.prepare(
      "UPDATE email_deliveries SET claim_attempted_at = '2000-01-01T00:00:00.000Z' WHERE id = ?"
    ).run(first!.id);
    const staleRetry = await repo.claimEmailDelivery(input);
    expect(staleRetry).toEqual(first);

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
