import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RETENTION_FOREIGN_KEY_PROTOCOL,
  previousElSalvadorMonth,
  runRetentionExport
} from "../../src/worker/services/retention";
import type { Env } from "../../src/worker/types";
import { sha256Hex, utf8Bytes } from "../../src/worker/utils/encoding";

const nativeCrypto = crypto;

class TestDigestStream extends WritableStream<ArrayBuffer | ArrayBufferView> {
  static readonly instances: TestDigestStream[] = [];

  readonly digest: Promise<ArrayBuffer>;
  readonly abortReasons: unknown[];
  readonly settled: Promise<void>;

  constructor() {
    const chunks: Uint8Array[] = [];
    const abortReasons: unknown[] = [];
    let resolveDigest!: (value: ArrayBuffer) => void;
    let rejectDigest!: (reason: unknown) => void;
    let resolveSettled!: () => void;
    const digest = new Promise<ArrayBuffer>((resolve, reject) => {
      resolveDigest = resolve;
      rejectDigest = reject;
    });
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    super({
      write(chunk) {
        const view =
          chunk instanceof ArrayBuffer
            ? new Uint8Array(chunk)
            : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        chunks.push(view.slice());
      },
      async close() {
        const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        try {
          resolveDigest(await nativeCrypto.subtle.digest("SHA-256", bytes));
        } catch (error) {
          rejectDigest(error);
        }
      },
      abort(reason) {
        abortReasons.push(reason);
        rejectDigest(reason);
      }
    });
    this.digest = digest.finally(resolveSettled);
    this.abortReasons = abortReasons;
    this.settled = settled;
    TestDigestStream.instances.push(this);
  }
}

interface FakeR2Object {
  key: string;
  body: Uint8Array;
}

class FakeArchiveBucket implements Partial<R2Bucket> {
  readonly objects = new Map<string, FakeR2Object>();
  readonly putCalls: Array<{ key: string; bytes: Uint8Array; streamed: boolean }> = [];
  readonly deleteCalls: string[] = [];
  readonly headCalls: string[] = [];

  async put(key: string, value: unknown): Promise<R2Object> {
    const bytes =
      value instanceof ReadableStream
        ? new Uint8Array(await new Response(value).arrayBuffer())
        : value instanceof Uint8Array
          ? value
          : utf8Bytes(String(value));
    this.objects.set(key, { key, body: bytes });
    this.putCalls.push({ key, bytes, streamed: value instanceof ReadableStream });
    return { key } as R2Object;
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    this.objects.delete(key);
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const object = this.objects.get(key);
    if (!object) return null;
    return { key, body: new Response(object.body).body } as R2ObjectBody;
  }

  async head(key: string): Promise<R2Object | null> {
    this.headCalls.push(key);
    return this.objects.has(key) ? ({ key } as R2Object) : null;
  }
}

class Deferred {
  readonly promise: Promise<void>;
  private resolvePromise!: () => void;

  constructor() {
    this.promise = new Promise<void>((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  resolve(): void {
    this.resolvePromise();
  }
}

function mergeTestChunks(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

class SlowArchiveBucket extends FakeArchiveBucket {
  readonly firstChunkRead = new Deferred();
  readonly resume = new Deferred();

  override async put(key: string, value: unknown): Promise<R2Object> {
    if (!(value instanceof ReadableStream) || !(key.endsWith(".ndjson") || key.includes(".ndjson.tmp."))) {
      return super.put(key, value);
    }
    const reader = value.getReader();
    const chunks: Uint8Array[] = [];
    let first = true;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value);
      if (first) {
        first = false;
        this.firstChunkRead.resolve();
        await this.resume.promise;
      }
    }
    return super.put(key, mergeTestChunks(chunks));
  }
}

class FailingArchiveBucket extends FakeArchiveBucket {
  override async put(key: string, value: unknown): Promise<R2Object> {
    if (value instanceof ReadableStream && key.includes(".ndjson.tmp.")) {
      const reader = value.getReader();
      const first = await reader.read();
      if (!first.done) {
        this.objects.set(key, { key, body: first.value.slice() });
      }
      await reader.cancel(new Error("stream upload failed"));
      throw new Error("stream upload failed");
    }
    return super.put(key, value);
  }
}

class SettlingArchiveBucket extends FakeArchiveBucket {
  readonly uploadSettled = new Deferred();
  readonly uploadErrors: unknown[] = [];

  override async put(key: string, value: unknown): Promise<R2Object> {
    if (!(value instanceof ReadableStream) || !(key.endsWith(".ndjson") || key.includes(".ndjson.tmp."))) {
      return super.put(key, value);
    }
    try {
      return await super.put(key, value);
    } catch (error) {
      this.uploadErrors.push(error);
      throw error;
    } finally {
      this.uploadSettled.resolve();
    }
  }
}

class DeleteFailingArchiveBucket extends SettlingArchiveBucket {
  override async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    throw new Error("partial delete failed");
  }
}

class DigestPausedArchiveBucket extends FakeArchiveBucket {
  readonly firstChunkRead = new Deferred();
  readonly uploadSettled = new Deferred();
  readonly release = new Deferred();
  readonly streamErrors: unknown[] = [];

  override async put(key: string, value: unknown): Promise<R2Object> {
    if (!(value instanceof ReadableStream) || !(key.endsWith(".ndjson") || key.includes(".ndjson.tmp."))) {
      return super.put(key, value);
    }
    const reader = value.getReader();
    const first = await reader.read();
    if (!first.done) {
      this.objects.set(key, { key, body: first.value.slice() });
    }
    this.firstChunkRead.resolve();
    try {
      try {
        await reader.closed;
      } catch (error) {
        this.streamErrors.push(error);
        throw error;
      }
      await this.release.promise;
      return { key } as R2Object;
    } finally {
      this.uploadSettled.resolve();
    }
  }
}

interface RejectingDigestProbe {
  readonly finalized: Deferred;
  readonly settled: Deferred;
  readonly abortReasons: unknown[];
}

function rejectingFinalizeDigestStream(error: Error, probe: RejectingDigestProbe): typeof TestDigestStream {
  return class extends WritableStream<ArrayBuffer | ArrayBufferView> {
    readonly digest: Promise<ArrayBuffer>;

    constructor() {
      let rejectDigest!: (reason: unknown) => void;
      const digest = new Promise<ArrayBuffer>((_resolve, reject) => {
        rejectDigest = reject;
      });
      super({
        write() {
          // Consume bytes like the Worker stream; failure is injected at finalization.
        },
        close() {
          probe.finalized.resolve();
          rejectDigest(error);
        },
        abort(reason) {
          probe.abortReasons.push(reason);
          rejectDigest(reason);
        }
      });
      this.digest = digest.finally(() => probe.settled.resolve());
    }
  } as typeof TestDigestStream;
}

class UnhandledRejectionProbe {
  readonly reasons: unknown[] = [];
  private readonly listener = (reason: unknown): void => {
    this.reasons.push(reason);
  };

  start(): void {
    process.on("unhandledRejection", this.listener);
  }

  async flush(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  stop(): void {
    process.off("unhandledRejection", this.listener);
  }
}

beforeEach(() => {
  TestDigestStream.instances.length = 0;
  vi.stubGlobal("crypto", {
    ...nativeCrypto,
    subtle: nativeCrypto.subtle,
    getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto),
    randomUUID: nativeCrypto.randomUUID.bind(nativeCrypto),
    DigestStream: TestDigestStream
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function envWithArchive(db: InMemoryRetentionD1, archive: FakeArchiveBucket, overrides: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    ISSUANCE_QUEUE: { send: async () => undefined } as unknown as Queue,
    ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } as unknown as Fetcher,
    ARCHIVE: archive as unknown as R2Bucket,
    ...overrides
  };
}

// Minimal in-memory D1 fake scoped to what runRetentionExport needs: paged reads
// by created_at window for the windowed tables, and full-table paged reads for
// the small contingency tables, plus createAudit.
class InMemoryRetentionD1 {
  readonly dteDocuments: Array<Record<string, unknown>> = [];
  readonly donationIntents: Array<Record<string, unknown>> = [];
  readonly dteEvents: Array<Record<string, unknown>> = [];
  readonly emailDeliveries: Array<Record<string, unknown>> = [];
  readonly fiscalCorrections: Array<Record<string, unknown>> = [];
  readonly wompiEvents: Array<Record<string, unknown>> = [];
  readonly auditLogs: Array<Record<string, unknown>> = [];
  readonly contingencyPeriods: Array<Record<string, unknown>> = [];
  readonly contingencyBatches: Array<Record<string, unknown>> = [];
  readonly contingencyBatchLines: Array<Record<string, unknown>> = [];
  readonly documentSequences: Array<Record<string, unknown>> = [];
  readonly audits: Array<Record<string, unknown>> = [];
  readonly alertDeliveries: Array<Record<string, unknown>> = [];
  readonly settings: Array<Record<string, unknown>> = [];
  readonly preparedSql: string[] = [];
  readonly appliedLimits: number[] = [];
  retentionPageError: Error | null = null;

  tableFor(sql: string): Array<Record<string, unknown>> | null {
    if (sql.includes("FROM dte_documents")) return this.dteDocuments;
    if (sql.includes("FROM donation_intents")) return this.donationIntents;
    if (sql.includes("FROM dte_events")) return this.dteEvents;
    if (sql.includes("FROM email_deliveries")) return this.emailDeliveries;
    if (sql.includes("FROM fiscal_corrections")) return this.fiscalCorrections;
    if (sql.includes("FROM wompi_events")) return this.wompiEvents;
    if (sql.includes("FROM audit_logs")) return this.auditLogs;
    if (sql.includes("FROM contingency_periods")) return this.contingencyPeriods;
    if (sql.includes("FROM contingency_batch_lines")) return this.contingencyBatchLines;
    if (sql.includes("FROM contingency_batches")) return this.contingencyBatches;
    if (sql.includes("FROM document_sequences")) return this.documentSequences;
    return null;
  }

  prepare(sql: string): RetentionStatement {
    this.preparedSql.push(sql);
    return new RetentionStatement(this, sql);
  }
}

class RetentionStatement {
  private args: unknown[] = [];

  constructor(
    private readonly db: InMemoryRetentionD1,
    private readonly sql: string
  ) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("SELECT value FROM app_settings WHERE key = ?")) {
      return (this.db.settings.find((setting) => setting.key === this.args[0]) ?? null) as T | null;
    }
    if (
      this.sql.includes("INSERT INTO operational_alert_deliveries") &&
      this.sql.includes("RETURNING id, claim_token")
    ) {
      const [
        id,
        kind,
        entityType,
        entityKeyHash,
        incidentId,
        channel,
        targetKeyHash,
        claimToken,
        claimAttemptedAt,
        staleBefore
      ] = this.args;
      const existing = this.db.alertDeliveries.find(
        (row) =>
          row.kind === kind &&
          row.entity_type === entityType &&
          row.entity_key_hash === entityKeyHash &&
          row.incident_id === incidentId &&
          row.channel === channel &&
          row.target_key_hash === targetKeyHash
      );
      if (!existing) {
        this.db.alertDeliveries.push({
          id,
          kind,
          entity_type: entityType,
          entity_key_hash: entityKeyHash,
          incident_id: incidentId,
          channel,
          target_key_hash: targetKeyHash,
          status: "PENDING",
          claim_token: claimToken,
          claim_attempted_at: claimAttemptedAt,
          provider_dispatch_started_at: null,
          finalized_at: null,
          outcome_class: null,
          failure_code: null,
          retry_safe: 0
        });
        return { id, claim_token: claimToken } as T;
      }
      const reclaimable =
        (existing.status === "FAILED" && Number(existing.retry_safe ?? 0) === 1) ||
        (
          existing.status === "PENDING" &&
          existing.provider_dispatch_started_at == null &&
          String(existing.claim_attempted_at) < String(staleBefore)
        );
      if (!reclaimable) return null;
      existing.status = "PENDING";
      existing.claim_token = claimToken;
      existing.claim_attempted_at = claimAttemptedAt;
      existing.provider_dispatch_started_at = null;
      existing.finalized_at = null;
      existing.outcome_class = null;
      existing.failure_code = null;
      existing.retry_safe = 0;
      return { id: existing.id, claim_token: claimToken } as T;
    }
    if (
      this.sql.includes("SELECT id, status, outcome_class") &&
      this.sql.includes("FROM operational_alert_deliveries")
    ) {
      const [kind, entityType, entityKeyHash, incidentId, channel, targetKeyHash] = this.args;
      return (this.db.alertDeliveries.find(
        (row) =>
          row.kind === kind &&
          row.entity_type === entityType &&
          row.entity_key_hash === entityKeyHash &&
          row.incident_id === incidentId &&
          row.channel === channel &&
          row.target_key_hash === targetKeyHash
      ) ?? null) as T | null;
    }
    if (
      this.sql.includes("UPDATE operational_alert_deliveries") &&
      this.sql.includes("SET provider_dispatch_started_at = ?") &&
      this.sql.includes("RETURNING id")
    ) {
      const [startedAt, id, claimToken] = this.args;
      const row = this.db.alertDeliveries.find(
        (delivery) =>
          delivery.id === id &&
          delivery.status === "PENDING" &&
          delivery.claim_token === claimToken &&
          delivery.provider_dispatch_started_at == null
      );
      if (!row) return null;
      row.provider_dispatch_started_at = startedAt;
      return { id } as T;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM audit_logs")) {
      const [action, entityId] = this.args.map(String);
      return { count: this.db.audits.filter((audit) => audit.action === action && audit.entity_id === entityId).length } as T;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const table = this.db.tableFor(this.sql);
    if (!table) return { results: [] };
    if (this.db.retentionPageError) {
      throw this.db.retentionPageError;
    }
    if (this.sql.includes("FROM document_sequences")) {
      let rows = [...table].sort(
        (left, right) =>
          String(left.environment).localeCompare(String(right.environment)) ||
          String(left.control_prefix).localeCompare(String(right.control_prefix))
      );
      if (this.sql.includes("(environment, control_prefix) > (?, ?)")) {
        const [afterEnvironment, afterPrefix] = this.args.slice(-3, -1).map(String);
        rows = rows.filter(
          (row) =>
            String(row.environment) > afterEnvironment ||
            (
              String(row.environment) === afterEnvironment &&
              String(row.control_prefix) > afterPrefix
            )
        );
      }
      const limit = Number(this.args.at(-1) ?? 500);
      this.db.appliedLimits.push(limit);
      return { results: rows.slice(0, limit) as T[] };
    }
    const column = this.sql.includes("received_at") ? "received_at" : "created_at";
    let rows = [...table];
    if (this.sql.includes(`${column} >= ?`) && this.sql.includes(`${column} < ?`)) {
      const [start, end] = this.args.map(String);
      rows = rows.filter((row) => String(row[column]) >= start && String(row[column]) < end);
    }
    rows.sort((left, right) => String(left[column]).localeCompare(String(right[column])) || String(left.id).localeCompare(String(right.id)));
    // keyset pagination: (column, id) > cursor
    if (this.sql.includes(`(dte_documents.${column}, dte_documents.id) > (?, ?)`) || this.sql.includes(`(${column}, id) > (?, ?)`)) {
      const cursor = this.args.slice(-3, -1);
      const [afterColumn, afterId] = cursor.map(String);
      rows = rows.filter((row) => {
        const value = String(row[column]);
        const id = String(row.id);
        return value > afterColumn || (value === afterColumn && id > afterId);
      });
    }
    const limit = Number(this.args.at(-1) ?? 500);
    this.db.appliedLimits.push(limit);
    return { results: rows.slice(0, limit) as T[] };
  }

  async run(): Promise<Record<string, never>> {
    if (
      this.sql.includes("UPDATE operational_alert_deliveries") &&
      this.sql.includes("SET status = ?, finalized_at = ?")
    ) {
      const [
        status,
        finalizedAt,
        outcomeClass,
        failureCode,
        retrySafe,
        id,
        claimToken
      ] = this.args;
      const row = this.db.alertDeliveries.find(
        (delivery) =>
          delivery.id === id &&
          delivery.status === "PENDING" &&
          delivery.claim_token === claimToken
      );
      if (row) {
        row.status = status;
        row.finalized_at = finalizedAt;
        row.outcome_class = outcomeClass;
        row.failure_code = failureCode;
        row.retry_safe = retrySafe;
      }
      return {
        success: true,
        meta: { changes: row ? 1 : 0 }
      } as unknown as Record<string, never>;
    }
    if (this.sql.includes("INSERT INTO audit_logs")) {
      const [id, actorType, actorId, action, entityType, entityId, summary, metadataJson] = this.args;
      this.db.audits.push({
        id,
        actor_type: actorType,
        actor_id: actorId,
        action,
        entity_type: entityType,
        entity_id: entityId,
        summary,
        metadata_json: metadataJson,
        created_at: "2026-07-01T09:00:00.000Z"
      });
    }
    return {};
  }
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "row_1",
    created_at: "2026-06-15T12:00:00.000Z",
    value: "x",
    ...overrides
  };
}

describe("runRetentionExport", () => {
  it("exports the previous El Salvador calendar month for windowed tables into NDJSON keyed objects", async () => {
    const db = new InMemoryRetentionD1();
    db.dteDocuments.push(
      row({ id: "dte_1", created_at: "2026-06-01T06:00:00.000Z" }), // June 1 00:00 El Salvador -> in June window
      row({ id: "dte_2", created_at: "2026-06-30T05:59:59.000Z" }), // June 29 23:59:59 El Salvador -> in June window
      row({ id: "dte_3", created_at: "2026-06-30T06:00:00.000Z" }), // June 30 00:00 El Salvador -> in June window
      row({ id: "dte_4", created_at: "2026-07-01T06:00:00.000Z" }) // July 1 00:00 El Salvador -> excluded (current month)
    );
    const archive = new FakeArchiveBucket();
    const env = envWithArchive(db, archive);

    // "now" = July 4th: previous calendar month (El Salvador) is June 2026.
    const now = new Date("2026-07-04T15:00:00.000Z");
    const result = await runRetentionExport(env, now);

    expect(result.status).toBe("completed");
    expect(result.month).toBe("2026-06");

    const dteKey = "retention/2026/2026-06/dte_documents.ndjson";
    expect(archive.objects.has(dteKey)).toBe(true);
    const body = new TextDecoder().decode(archive.objects.get(dteKey)!.body);
    const lines = body.split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(["dte_1", "dte_2", "dte_3"]);
  });

  it("writes a manifest last with per-table row counts and matching SHA-256 hashes", async () => {
    const db = new InMemoryRetentionD1();
    db.dteDocuments.push(row({ id: "dte_1", created_at: "2026-06-10T00:00:00.000Z" }));
    db.contingencyPeriods.push(row({ id: "cont_1", created_at: "2026-05-01T00:00:00.000Z" }));
    const archive = new FakeArchiveBucket();
    const env = envWithArchive(db, archive);

    const now = new Date("2026-07-04T15:00:00.000Z");
    await runRetentionExport(env, now);

    const manifestKey = "retention/2026/2026-06/manifest.json";
    expect(archive.objects.has(manifestKey)).toBe(true);
    const manifest = JSON.parse(new TextDecoder().decode(archive.objects.get(manifestKey)!.body)) as {
      month: string;
      tables: Record<string, { rowCount: number; sha256: string }>;
    };
    expect(manifest.month).toBe("2026-06");

    for (const table of ["dte_documents", "fiscal_corrections", "donation_intents", "dte_events", "email_deliveries", "wompi_events", "audit_logs", "contingency_periods", "contingency_batches", "contingency_batch_lines", "document_sequences"]) {
      expect(manifest.tables[table]).toBeDefined();
    }
    expect(manifest.tables.dte_documents.rowCount).toBe(1);
    expect(manifest.tables.contingency_periods.rowCount).toBe(1);

    const dteBody = archive.objects.get("retention/2026/2026-06/dte_documents.ndjson")!.body;
    expect(manifest.tables.dte_documents.sha256).toBe(await sha256Hex(dteBody));

    // manifest must be the last object written
    expect(archive.putCalls.at(-1)?.key).toBe(manifestKey);
  });

  it("retains Wompi issuance lifecycle evidence with a valid manifest count and digest", async () => {
    const db = new InMemoryRetentionD1();
    db.wompiEvents.push(
      row({
        id: "wompi_failed_1",
        created_at: undefined,
        received_at: "2026-06-15T12:00:00.000Z",
        issuance_status: "FAILED",
        control_prefix: "M001P004",
        control_sequence: 42,
        reserved_numero_control: "DTE-15-M001P004-000000000000042",
        reserved_codigo_generacion: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
        issuance_attempt_count: 3,
        issuance_error_code: "CDE_SCHEMA",
        issuance_error_message: "El documento del donante no es válido.",
        issuance_last_attempt_at: "2026-06-15T12:03:00.000Z",
        issuance_failed_at: "2026-06-15T12:03:00.000Z",
        issuance_dead_lettered_at: null
      })
    );
    const archive = new FakeArchiveBucket();

    await runRetentionExport(envWithArchive(db, archive), new Date("2026-07-04T15:00:00.000Z"));

    const wompiKey = "retention/2026/2026-06/wompi_events.ndjson";
    const wompiBody = archive.objects.get(wompiKey)!.body;
    const exportedRows = new TextDecoder().decode(wompiBody).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(exportedRows).toHaveLength(1);
    expect(exportedRows[0]).toMatchObject({
      issuance_status: "FAILED",
      control_prefix: "M001P004",
      control_sequence: 42,
      reserved_numero_control: "DTE-15-M001P004-000000000000042",
      reserved_codigo_generacion: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      issuance_attempt_count: 3,
      issuance_error_code: "CDE_SCHEMA",
      issuance_error_message: "El documento del donante no es válido.",
      issuance_last_attempt_at: "2026-06-15T12:03:00.000Z",
      issuance_failed_at: "2026-06-15T12:03:00.000Z",
      issuance_dead_lettered_at: null
    });
    expect(exportedRows[0].reserved_numero_control).toBe(
      `DTE-15-${exportedRows[0].control_prefix}-${String(exportedRows[0].control_sequence).padStart(15, "0")}`
    );
    expect(exportedRows[0].issuance_error_code).toMatch(/^[A-Z][A-Z0-9_]*$/);

    const manifest = JSON.parse(
      new TextDecoder().decode(archive.objects.get("retention/2026/2026-06/manifest.json")!.body)
    ) as { tables: Record<string, { rowCount: number; sha256: string }> };
    expect(manifest.tables.wompi_events.rowCount).toBe(1);
    expect(manifest.tables.wompi_events.sha256).toBe(await sha256Hex(wompiBody));
  });

  it("retains complete fiscal correction evidence with safe audit metadata and dependency order", async () => {
    const db = new InMemoryRetentionD1();
    const beforeReceptor = JSON.stringify({
      tipoDocumento: "13",
      numDocumento: "12345678-9",
      nombre: "Nombre original"
    });
    const correctedReceptor = JSON.stringify({
      tipoDocumento: "13",
      numDocumento: "10000002-7",
      nombre: "Nombre corregido"
    });
    db.fiscalCorrections.push(
      row({
        id: "fiscal_correction_1",
        request_id: "11111111-1111-4111-8111-111111111111",
        target_kind: "WOMPI_EVENT",
        wompi_event_id: "wompi_1",
        document_id: null,
        before_receptor_json: beforeReceptor,
        corrected_receptor_json: correctedReceptor,
        changed_fields_json: JSON.stringify(["nombre", "numDocumento"])
      })
    );
    db.auditLogs.push(
      row({
        id: "audit_fiscal_correction_1",
        action: "FISCAL_CORRECTION_ACCEPTED",
        entity_type: "fiscal_correction",
        entity_id: "fiscal_correction_1",
        summary: "Corrección fiscal aceptada",
        metadata_json: JSON.stringify({
          correctionId: "fiscal_correction_1",
          target: { kind: "WOMPI_EVENT", id: "wompi_1" },
          requestIdHash: "a".repeat(64),
          attemptNumber: 1,
          changedFields: ["nombre", "numDocumento"],
          outcomeCode: "ACCEPTED"
        })
      })
    );
    const archive = new FakeArchiveBucket();

    await runRetentionExport(
      envWithArchive(db, archive),
      new Date("2026-07-04T15:00:00.000Z")
    );

    const correctionKey = "retention/2026/2026-06/fiscal_corrections.ndjson";
    const correctionBody = archive.objects.get(correctionKey)!.body;
    const exported = new TextDecoder()
      .decode(correctionBody)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(exported).toHaveLength(1);
    expect(exported[0]).toMatchObject({
      before_receptor_json: beforeReceptor,
      corrected_receptor_json: correctedReceptor
    });

    const manifest = JSON.parse(
      new TextDecoder().decode(
        archive.objects.get("retention/2026/2026-06/manifest.json")!.body
      )
    ) as { tables: Record<string, { rowCount: number; sha256: string }> };
    expect(manifest.tables.fiscal_corrections).toEqual({
      rowCount: 1,
      sha256: await sha256Hex(correctionBody)
    });

    const auditBody = new TextDecoder().decode(
      archive.objects.get("retention/2026/2026-06/audit_logs.ndjson")!.body
    );
    expect(auditBody).not.toContain("12345678-9");
    expect(auditBody).not.toContain("10000002-7");
    expect(auditBody).not.toContain("Nombre original");
    expect(auditBody).not.toContain("Nombre corregido");

    const restorePhase = (table: string) =>
      RETENTION_FOREIGN_KEY_PROTOCOL.restorePhases.findIndex(
        (phase) => phase.tables.includes(table)
      );
    const deletePhase = (table: string) =>
      RETENTION_FOREIGN_KEY_PROTOCOL.deletePhases.findIndex(
        (phase) => phase.tables.includes(table)
      );
    expect(restorePhase("fiscal_corrections")).toBeGreaterThan(
      restorePhase("dte_documents")
    );
    expect(restorePhase("fiscal_corrections")).toBeGreaterThan(
      restorePhase("wompi_events")
    );
    expect(deletePhase("fiscal_corrections")).toBeLessThan(
      deletePhase("dte_documents")
    );
    expect(deletePhase("fiscal_corrections")).toBeLessThan(
      deletePhase("wompi_events")
    );
  });

  it("snapshots the current Wompi lifecycle again after its received-month archive", async () => {
    const db = new InMemoryRetentionD1();
    const wompi = row({
      id: "wompi_mutated_after_received_month",
      created_at: undefined,
      received_at: "2026-05-15T12:00:00.000Z",
      issuance_status: "PROCESSING",
      processed_at: null,
      created_document_id: null
    });
    db.wompiEvents.push(wompi);
    const archive = new FakeArchiveBucket();
    const runtime = envWithArchive(db, archive);

    await runRetentionExport(runtime, new Date("2026-06-04T15:00:00.000Z"), {
      month: "2026-05"
    });
    wompi.issuance_status = "DOCUMENT_CREATED";
    wompi.processed_at = "2026-06-20T12:00:00.000Z";
    wompi.created_document_id = "dte_created_later";
    await runRetentionExport(runtime, new Date("2026-07-04T15:00:00.000Z"), {
      month: "2026-06"
    });

    const readSnapshot = (month: string) =>
      new TextDecoder()
        .decode(archive.objects.get(`retention/2026/${month}/wompi_events.ndjson`)!.body)
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    expect(readSnapshot("2026-05")).toContainEqual(expect.objectContaining({
      id: "wompi_mutated_after_received_month",
      issuance_status: "PROCESSING",
      created_document_id: null
    }));
    expect(readSnapshot("2026-06")).toContainEqual(expect.objectContaining({
      id: "wompi_mutated_after_received_month",
      issuance_status: "DOCUMENT_CREATED",
      created_document_id: "dte_created_later"
    }));
  });

  it("snapshots the latest fiscal correction state after its created-month archive", async () => {
    const db = new InMemoryRetentionD1();
    const correction: Record<string, unknown> = {
      id: "fiscal_correction_completed_later",
      request_id: "11111111-1111-4111-8111-111111111111",
      request_payload_sha256: "a".repeat(64),
      attempt_number: 1,
      target_kind: "WOMPI_EVENT",
      wompi_event_id: "wompi_1",
      document_id: null,
      environment: "00",
      status: "PROCESSING",
      before_receptor_json: JSON.stringify({ nombre: "Nombre original" }),
      corrected_receptor_json: JSON.stringify({ nombre: "Nombre corregido" }),
      changed_fields_json: JSON.stringify(["nombre"]),
      source_document_snapshot_json: null,
      issuance_attempt_id: "issuance_1",
      fiscal_claim_id: "fiscal_claim_1",
      processing_claim_id: "processing_claim_1",
      mh_dispatch_started_at: null,
      failure_code: null,
      failure_message: null,
      created_by: "user_1",
      created_at: "2026-05-15T12:00:00.000Z",
      processing_started_at: "2026-05-15T12:01:00.000Z",
      completed_at: null,
      updated_at: "2026-05-15T12:01:00.000Z"
    };
    db.fiscalCorrections.push(correction);
    const archive = new FakeArchiveBucket();
    const runtime = envWithArchive(db, archive);

    await runRetentionExport(runtime, new Date("2026-06-04T15:00:00.000Z"), {
      month: "2026-05"
    });
    correction.status = "ACCEPTED";
    correction.completed_at = "2026-06-20T12:00:00.000Z";
    correction.updated_at = "2026-06-20T12:00:00.000Z";
    correction.reserved_control_prefix = "M001P004";
    correction.reserved_control_sequence = 42;
    correction.reserved_codigo_generacion =
      "70000003-2222-4222-8222-700000032222";
    correction.reserved_numero_control =
      "DTE-15-M001P004-000000000000042";
    await runRetentionExport(runtime, new Date("2026-07-04T15:00:00.000Z"), {
      month: "2026-06"
    });

    const readRows = (month: string, name: string) =>
      new TextDecoder()
        .decode(archive.objects.get(`retention/2026/${month}/${name}.ndjson`)!.body)
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(readRows("2026-05", "fiscal_corrections")).toContainEqual(
      expect.objectContaining({ id: correction.id, status: "PROCESSING", completed_at: null })
    );
    expect(readRows("2026-06", "fiscal_corrections")).toEqual([]);
    expect(readRows("2026-06", "fiscal_corrections_latest")).toEqual([correction]);

    const manifest = JSON.parse(
      new TextDecoder().decode(
        archive.objects.get("retention/2026/2026-06/manifest.json")!.body
      )
    ) as { tables: Record<string, { rowCount: number; sha256: string }> };
    const latestBody = archive.objects.get(
      "retention/2026/2026-06/fiscal_corrections_latest.ndjson"
    )!.body;
    expect(manifest.tables.fiscal_corrections_latest).toEqual({
      rowCount: 1,
      sha256: await sha256Hex(latestBody)
    });
  });

  it("exports a bounded full document-sequence snapshot with a composite cursor", async () => {
    const db = new InMemoryRetentionD1();
    for (let index = 0; index < 1_200; index += 1) {
      db.documentSequences.push({
        environment: index < 600 ? "00" : "01",
        control_prefix: `P${String(index).padStart(7, "0")}`,
        next_value: index + 10
      });
    }
    const archive = new FakeArchiveBucket();

    await runRetentionExport(
      envWithArchive(db, archive),
      new Date("2026-07-04T15:00:00.000Z")
    );

    const key = "retention/2026/2026-06/document_sequences.ndjson";
    const body = archive.objects.get(key)!.body;
    const exported = new TextDecoder().decode(body).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    expect(exported).toHaveLength(1_200);
    expect(exported[0]).toEqual({
      environment: "00",
      control_prefix: "P0000000",
      next_value: 10
    });
    expect(exported.at(-1)).toEqual({
      environment: "01",
      control_prefix: "P0001199",
      next_value: 1_209
    });
    const sequenceReads = db.preparedSql.filter((sql) => sql.includes("FROM document_sequences"));
    expect(sequenceReads).toHaveLength(3);
    expect(sequenceReads.every((sql) => sql.includes("LIMIT ?"))).toBe(true);
    expect(sequenceReads.some((sql) => sql.includes("(environment, control_prefix) > (?, ?)"))).toBe(true);
    const manifest = JSON.parse(
      new TextDecoder().decode(archive.objects.get("retention/2026/2026-06/manifest.json")!.body)
    ) as { tables: Record<string, { rowCount: number; sha256: string }> };
    expect(manifest.tables.document_sequences).toEqual({
      rowCount: 1_200,
      sha256: await sha256Hex(body)
    });
  });

  it("windows donation_intents into the manifest by created_at like the other windowed tables", async () => {
    const db = new InMemoryRetentionD1();
    db.donationIntents.push(
      row({ id: "intent_1", created_at: "2026-06-10T00:00:00.000Z" }), // in June window
      row({ id: "intent_2", created_at: "2026-07-01T06:00:00.000Z" }) // July -> excluded (current month)
    );
    const archive = new FakeArchiveBucket();
    const env = envWithArchive(db, archive);

    const result = await runRetentionExport(env, new Date("2026-07-04T15:00:00.000Z"));

    expect(result.status).toBe("completed");
    const key = "retention/2026/2026-06/donation_intents.ndjson";
    expect(archive.objects.has(key)).toBe(true);
    const lines = new TextDecoder().decode(archive.objects.get(key)!.body).split("\n").filter(Boolean);
    expect(lines.map((line) => JSON.parse(line).id)).toEqual(["intent_1"]);

    const manifest = JSON.parse(new TextDecoder().decode(archive.objects.get("retention/2026/2026-06/manifest.json")!.body)) as {
      tables: Record<string, { rowCount: number }>;
    };
    expect(manifest.tables.donation_intents.rowCount).toBe(1);
  });

  it("redacts historical alert-email values before audit rows enter R2", async () => {
    const db = new InMemoryRetentionD1();
    db.auditLogs.push(
      row({
        id: "audit_alert_email",
        action: "ALERT_EMAIL_UPDATED",
        entity_type: "app_setting",
        entity_id: "alert_email",
        summary: "Correo de alertas configurado a owner@example.org",
        metadata_json: JSON.stringify({ alertEmail: "owner@example.org" })
      }),
      row({
        id: "audit_unrelated",
        action: "USER_UPDATED",
        entity_type: "user",
        entity_id: "user_operator",
        summary: "Usuario actualizado",
        metadata_json: JSON.stringify({ role: "OPERATOR" })
      })
    );
    const archive = new FakeArchiveBucket();

    await runRetentionExport(envWithArchive(db, archive), new Date("2026-07-04T15:00:00.000Z"));

    const key = "retention/2026/2026-06/audit_logs.ndjson";
    const records = new TextDecoder()
      .decode(archive.objects.get(key)!.body)
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records).toContainEqual(expect.objectContaining({
      id: "audit_alert_email",
      summary: "Correo de alertas actualizado",
      metadata_json: "{}"
    }));
    expect(JSON.stringify(records)).not.toContain("owner@example.org");
    expect(records).toContainEqual(expect.objectContaining({
      id: "audit_unrelated",
      summary: "Usuario actualizado",
      metadata_json: JSON.stringify({ role: "OPERATOR" })
    }));
  });

  it("audits RETENTION_EXPORT_COMPLETED with month and total rows", async () => {
    const db = new InMemoryRetentionD1();
    db.dteDocuments.push(row({ id: "dte_1", created_at: "2026-06-10T00:00:00.000Z" }));
    db.wompiEvents.push(row({ id: "wompi_1", created_at: undefined, received_at: "2026-06-11T00:00:00.000Z" }));
    const archive = new FakeArchiveBucket();
    const env = envWithArchive(db, archive);

    await runRetentionExport(env, new Date("2026-07-04T15:00:00.000Z"));

    const completed = db.audits.find((audit) => audit.action === "RETENTION_EXPORT_COMPLETED");
    expect(completed).toBeTruthy();
    expect(String(completed?.summary)).toContain("2026-06");
    expect(String(completed?.summary)).toMatch(/\b2\b/);
  });

  it("skips and audits RETENTION_EXPORT_SKIPPED when the manifest already exists (idempotent)", async () => {
    const db = new InMemoryRetentionD1();
    db.dteDocuments.push(row({ id: "dte_1", created_at: "2026-06-10T00:00:00.000Z" }));
    const archive = new FakeArchiveBucket();
    // Pre-seed the manifest as if a previous run already completed.
    archive.objects.set("retention/2026/2026-06/manifest.json", { key: "retention/2026/2026-06/manifest.json", body: utf8Bytes("{}") });
    const env = envWithArchive(db, archive);

    const result = await runRetentionExport(env, new Date("2026-07-04T15:00:00.000Z"));

    expect(result.status).toBe("skipped");
    expect(archive.putCalls).toHaveLength(0); // no re-export, no re-write of manifest
    expect(db.audits.find((audit) => audit.action === "RETENTION_EXPORT_SKIPPED")).toBeTruthy();
  });

  it("supports exporting an explicit month for the manual verification endpoint", async () => {
    const db = new InMemoryRetentionD1();
    db.dteDocuments.push(row({ id: "dte_1", created_at: "2026-03-15T00:00:00.000Z" }));
    const archive = new FakeArchiveBucket();
    const env = envWithArchive(db, archive);

    const result = await runRetentionExport(env, new Date("2026-07-04T15:00:00.000Z"), { month: "2026-03" });

    expect(result.status).toBe("completed");
    expect(result.month).toBe("2026-03");
    expect(archive.objects.has("retention/2026/2026-03/manifest.json")).toBe(true);
  });

  it("paginates windowed reads in pages of 500 rows instead of an unpaged full-table read", async () => {
    const db = new InMemoryRetentionD1();
    // June 2026 in El Salvador local time starts at 2026-06-01T06:00:00Z (UTC-6).
    // Spread 1200 rows across strictly increasing (created_at, id) within the window.
    for (let index = 0; index < 1200; index += 1) {
      const minute = Math.floor(index / 60);
      const second = index % 60;
      db.dteDocuments.push(
        row({
          id: `dte_${String(index).padStart(4, "0")}`,
          created_at: `2026-06-01T06:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`
        })
      );
    }
    const archive = new FakeArchiveBucket();
    const env = envWithArchive(db, archive);

    const result = await runRetentionExport(env, new Date("2026-07-04T15:00:00.000Z"));

    expect(result.status).toBe("completed");
    const body = new TextDecoder().decode(archive.objects.get("retention/2026/2026-06/dte_documents.ndjson")!.body);
    const lines = body.split("\n").filter(Boolean);
    expect(lines).toHaveLength(1200);
    // Confirm every page request was bounded to 500 rows (3 pages for 1200 rows),
    // never a single unpaged read of everything at once.
    expect(db.appliedLimits.length).toBeGreaterThanOrEqual(3);
    expect(db.appliedLimits.every((limit) => limit === 500)).toBe(true);
  });

  it("puts every table as a stream and preserves exact NDJSON digests", async () => {
    const db = new InMemoryRetentionD1();
    for (let index = 0; index < 1_200; index += 1) {
      db.dteDocuments.push(
        row({
          id: `dte_stream_${String(index).padStart(4, "0")}`,
          created_at: "2026-06-15T12:00:00.000Z"
        })
      );
    }
    const archive = new FakeArchiveBucket();
    const result = await runRetentionExport(envWithArchive(db, archive), new Date("2026-07-04T15:00:00.000Z"));

    expect(result.status).toBe("completed");
    const finalTablePuts = archive.putCalls.filter((call) => call.key.endsWith(".ndjson"));
    const tempTablePuts = archive.putCalls.filter((call) => call.key.includes(".ndjson.tmp."));
    expect(finalTablePuts).toHaveLength(12);
    expect(tempTablePuts).toHaveLength(12);
    expect(tempTablePuts.every((call) => call.streamed)).toBe(true);
    const key = "retention/2026/2026-06/dte_documents.ndjson";
    const bytes = archive.objects.get(key)!.body;
    const expectedBytes = utf8Bytes(db.dteDocuments.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    expect(bytes).toEqual(expectedBytes);
    const manifest = JSON.parse(
      new TextDecoder().decode(archive.objects.get("retention/2026/2026-06/manifest.json")!.body)
    ) as { tables: Record<string, { rowCount: number; sha256: string }> };
    expect(manifest.tables.dte_documents.rowCount).toBe(1_200);
    expect(manifest.tables.dte_documents.sha256).toBe(await sha256Hex(bytes));
  });

  it("does not read the next D1 page while R2 backpressure is active (bounded read-ahead)", async () => {
    const db = new InMemoryRetentionD1();
    for (let index = 0; index < 1_200; index += 1) {
      db.dteDocuments.push(
        row({
          id: `dte_slow_${String(index).padStart(4, "0")}`,
          created_at: "2026-06-15T12:00:00.000Z"
        })
      );
    }
    const archive = new SlowArchiveBucket();
    const exportPromise = runRetentionExport(envWithArchive(db, archive), new Date("2026-07-04T15:00:00.000Z"));

    await archive.firstChunkRead.promise;
    expect(db.appliedLimits).toEqual([500]);
    archive.resume.resolve();
    await expect(exportPromise).resolves.toMatchObject({ status: "completed", totalRows: 1_200 });
  });

  it("deletes a partial table object after a streamed write failure and never writes the manifest", async () => {
    const db = new InMemoryRetentionD1();
    db.dteDocuments.push(row({ id: "dte_failure" }));
    const archive = new FailingArchiveBucket();
    const result = await runRetentionExport(envWithArchive(db, archive), new Date("2026-07-04T15:00:00.000Z"));

    const key = "retention/2026/2026-06/dte_documents.ndjson";
    expect(result.status).toBe("failed");
    expect(archive.deleteCalls.some((deleteKey) => deleteKey.startsWith(`${key}.tmp.`))).toBe(true);
    expect(archive.deleteCalls).not.toContain(key);
    expect(archive.objects.has(key)).toBe(false);
    expect(archive.objects.has("retention/2026/2026-06/manifest.json")).toBe(false);
  });

  it("does not delete an existing canonical table object when a streamed export fails", async () => {
    const db = new InMemoryRetentionD1();
    db.dteDocuments.push(row({ id: "dte_failure" }));
    const archive = new FailingArchiveBucket();
    const env = envWithArchive(db, archive);
    const key = "retention/2026/2026-06/dte_documents.ndjson";
    const existingBytes = utf8Bytes('{"id":"valid_concurrent_export"}\n');
    archive.objects.set(key, { key, body: existingBytes });

    const result = await runRetentionExport(env, new Date("2026-07-04T15:00:00.000Z"));

    expect(result.status).toBe("failed");
    expect(archive.deleteCalls.some((deleteKey) => deleteKey.startsWith(`${key}.tmp.`))).toBe(true);
    expect(archive.deleteCalls).not.toContain(key);
    expect(archive.objects.get(key)?.body).toEqual(existingBytes);
    expect(archive.objects.has("retention/2026/2026-06/manifest.json")).toBe(false);
  });

  it("settles upload and digest cleanup when a retention page read rejects", async () => {
    const primaryError = new Error("page read failed");
    const db = new InMemoryRetentionD1();
    db.retentionPageError = primaryError;
    const archive = new SettlingArchiveBucket();
    const unhandled = new UnhandledRejectionProbe();
    unhandled.start();

    try {
      const result = await runRetentionExport(envWithArchive(db, archive), new Date("2026-07-04T15:00:00.000Z"));
      await archive.uploadSettled.promise;
      const digest = TestDigestStream.instances[0];
      await digest.settled;
      await unhandled.flush();

      const key = "retention/2026/2026-06/dte_documents.ndjson";
      expect(result).toMatchObject({ status: "failed", error: "page read failed" });
      expect(digest.abortReasons).toContain(primaryError);
      expect(archive.uploadErrors).toHaveLength(1);
      expect(archive.deleteCalls.some((deleteKey) => deleteKey.startsWith(`${key}.tmp.`))).toBe(true);
      expect(archive.deleteCalls).not.toContain(key);
      expect(archive.objects.has("retention/2026/2026-06/manifest.json")).toBe(false);
      expect(unhandled.reasons).toEqual([]);
    } finally {
      unhandled.stop();
    }
  });

  it("preserves the primary page-read error when partial-object deletion rejects", async () => {
    const primaryError = new Error("page read failed before cleanup");
    const db = new InMemoryRetentionD1();
    db.retentionPageError = primaryError;
    const archive = new DeleteFailingArchiveBucket();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const unhandled = new UnhandledRejectionProbe();
    unhandled.start();

    try {
      const result = await runRetentionExport(envWithArchive(db, archive), new Date("2026-07-04T15:00:00.000Z"));
      await archive.uploadSettled.promise;
      const digest = TestDigestStream.instances[0];
      await digest.settled;
      await unhandled.flush();

      const key = "retention/2026/2026-06/dte_documents.ndjson";
      expect(result).toMatchObject({ status: "failed", error: "page read failed before cleanup" });
      expect(digest.abortReasons).toContain(primaryError);
      const deletedTempKey = archive.deleteCalls.find((deleteKey) => deleteKey.startsWith(`${key}.tmp.`));
      expect(deletedTempKey).toBeDefined();
      expect(archive.deleteCalls).not.toContain(key);
      expect(archive.objects.has("retention/2026/2026-06/manifest.json")).toBe(false);
      expect(db.audits).toContainEqual(
        expect.objectContaining({ action: "RETENTION_EXPORT_FAILED", summary: "page read failed before cleanup" })
      );
      expect(consoleError).toHaveBeenCalledWith({
        event: "retention_partial_object_cleanup_failed",
        app_env: "unknown",
        error_name: "error",
        error_code: "unknown"
      });
      expect(unhandled.reasons).toEqual([]);
    } finally {
      unhandled.stop();
      consoleError.mockRestore();
    }
  });

  it("aborts a paused upload promptly when digest finalization rejects", async () => {
    const digestError = new Error("digest finalization failed");
    const digestProbe: RejectingDigestProbe = {
      finalized: new Deferred(),
      settled: new Deferred(),
      abortReasons: []
    };
    vi.stubGlobal("crypto", {
      ...nativeCrypto,
      subtle: nativeCrypto.subtle,
      getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto),
      randomUUID: nativeCrypto.randomUUID.bind(nativeCrypto),
      DigestStream: rejectingFinalizeDigestStream(digestError, digestProbe)
    });
    const db = new InMemoryRetentionD1();
    db.dteDocuments.push(row({ id: "dte_digest_failure" }));
    const archive = new DigestPausedArchiveBucket();
    const unhandled = new UnhandledRejectionProbe();
    unhandled.start();

    try {
      const exportPromise = runRetentionExport(envWithArchive(db, archive), new Date("2026-07-04T15:00:00.000Z"));
      await archive.firstChunkRead.promise;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        exportPromise.then((result) => ({ kind: "settled" as const, result })),
        new Promise<{ kind: "timeout" }>((resolve) => {
          timeout = setTimeout(() => resolve({ kind: "timeout" }), 250);
        })
      ]);
      if (timeout) clearTimeout(timeout);
      const result =
        outcome.kind === "settled"
          ? outcome.result
          : await (async () => {
              archive.release.resolve();
              return exportPromise;
            })();
      await digestProbe.finalized.promise;
      await digestProbe.settled.promise;
      await archive.uploadSettled.promise;
      await unhandled.flush();

      const key = "retention/2026/2026-06/dte_documents.ndjson";
      expect(outcome.kind).toBe("settled");
      expect(result).toMatchObject({ status: "failed", error: "digest finalization failed" });
      expect(digestProbe.abortReasons).toEqual([]);
      expect(archive.streamErrors).toContain(digestError);
      expect(archive.deleteCalls.some((deleteKey) => deleteKey.startsWith(`${key}.tmp.`))).toBe(true);
      expect(archive.deleteCalls).not.toContain(key);
      expect(archive.objects.has(key)).toBe(false);
      expect(archive.objects.has("retention/2026/2026-06/manifest.json")).toBe(false);
      expect(unhandled.reasons).toEqual([]);
    } finally {
      archive.release.resolve();
      unhandled.stop();
    }
  });

  it("audits RETENTION_EXPORT_FAILED and does not throw when the archive write fails", async () => {
    const db = new InMemoryRetentionD1();
    db.dteDocuments.push(row({ id: "dte_1", created_at: "2026-06-10T00:00:00.000Z" }));
    const archive = new FakeArchiveBucket();
    vi.spyOn(archive, "put").mockRejectedValue(new Error("R2 unavailable"));
    const env = envWithArchive(db, archive);

    const result = await runRetentionExport(env, new Date("2026-07-04T15:00:00.000Z"));

    expect(result.status).toBe("failed");
    const failed = db.audits.find((audit) => audit.action === "RETENTION_EXPORT_FAILED");
    expect(failed).toBeTruthy();
    expect(String(failed?.summary)).toContain("R2 unavailable");
  });

  it("sends an operational alert (once per month) when the export fails", async () => {
    const db = new InMemoryRetentionD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.dteDocuments.push(row({ id: "dte_1", created_at: "2026-06-10T00:00:00.000Z" }));
    const archive = new FakeArchiveBucket();
    vi.spyOn(archive, "put").mockRejectedValue(new Error("R2 unavailable"));
    const sent: unknown[] = [];
    const env = envWithArchive(db, archive, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          sent.push(message);
          return { messageId: "retention-alert" };
        }
      } as unknown as Env["EMAIL"]
    });

    await runRetentionExport(env, new Date("2026-07-04T15:00:00.000Z"));
    // A second failing run for the same month must not re-alert (dedupe per month).
    await runRetentionExport(env, new Date("2026-07-04T15:00:00.000Z"));

    expect(sent).toHaveLength(1);
    expect(db.audits.filter((audit) => audit.action === "ALERT_SENT:RETENTION_EXPORT_FAILED")).toHaveLength(1);
  });
});

describe("previousElSalvadorMonth (UTC/El Salvador day seam)", () => {
  it("treats 2026-08-01T05:59:00.000Z (July 31 23:59 El Salvador) as still-July, so previous month is June", () => {
    const now = new Date("2026-08-01T05:59:00.000Z");
    expect(previousElSalvadorMonth(now)).toBe("2026-06");
  });

  it("treats 2026-08-01T06:00:00.000Z (August 1 00:00 El Salvador) as already-August, so previous month is July", () => {
    const now = new Date("2026-08-01T06:00:00.000Z");
    expect(previousElSalvadorMonth(now)).toBe("2026-07");
  });

  it("rolls over the year correctly: 2027-01-01T06:00:00.000Z (Jan 1 El Salvador) -> previous month is 2026-12", () => {
    const now = new Date("2027-01-01T06:00:00.000Z");
    expect(previousElSalvadorMonth(now)).toBe("2026-12");
  });
});

describe("retention restore guidance", () => {
  it("keeps the Wrangler restore file free of nested transaction statements", () => {
    const protocol = RETENTION_FOREIGN_KEY_PROTOCOL as unknown as {
      wranglerFile: {
        deferForeignKeys: string;
        verify: string;
        forbiddenTransactionStatements: readonly string[];
      };
      localSqliteTransaction: {
        begin: string;
        commit: string;
        rollback: string;
      };
    };
    expect(protocol.wranglerFile).toEqual({
      deferForeignKeys: "PRAGMA defer_foreign_keys = ON",
      verify: "PRAGMA foreign_key_check",
      forbiddenTransactionStatements: ["BEGIN", "COMMIT", "ROLLBACK"]
    });
    const expectedWranglerFile = [
      protocol.wranglerFile?.deferForeignKeys,
      "-- ordered restore phases",
      protocol.wranglerFile?.verify
    ].join(";\n");
    expect(expectedWranglerFile).not.toMatch(/\b(?:BEGIN|COMMIT|ROLLBACK)\b/);
    expect(protocol.localSqliteTransaction).toEqual({
      begin: "BEGIN IMMEDIATE",
      commit: "COMMIT",
      rollback: "ROLLBACK"
    });
  });

  it("uses the latest mutable snapshots and advances legacy counters without moving backward", () => {
    const guidance = readFileSync(
      resolve(import.meta.dirname, "../../docs/retention-restore.md"),
      "utf8"
    );

    expect(guidance).toContain("latest `wompi_events.ndjson` snapshot");
    expect(guidance).toContain("latest `document_sequences.ndjson` snapshot");
    expect(guidance.toLowerCase()).toMatch(
      /archives created before\s+`document_sequences\.ndjson`/
    );
    expect(guidance).toContain(
      "MAX(snapshot `next_value`, restored document maximum + 1, restored Wompi reservation maximum + 1, restored fiscal-correction reservation maximum + 1)"
    );
    expect(guidance).toContain("Never move an existing counter backward");
    expect(guidance).toContain(
      "Do not put `BEGIN`, `COMMIT`, or `ROLLBACK` inside `restore.sql`"
    );
    expect(guidance).toContain("Wrangler wraps the file in its own transaction");
    expect(guidance).toContain("BEGIN IMMEDIATE");
    expect(guidance).toContain("PRAGMA defer_foreign_keys = ON");
    expect(guidance).toContain("PRAGMA foreign_key_check");
    expect(guidance).toContain("ROLLBACK");
    expect(guidance).toContain(
      "`contingency_periods` ↔ `dte_events` ↔ `dte_documents`"
    );
    expect(guidance).not.toContain("Foreign keys matter for ordering");
  });

  it("applies the latest fiscal correction snapshot last and idempotently", () => {
    const protocol = RETENTION_FOREIGN_KEY_PROTOCOL as unknown as {
      authoritativeOverlays: Array<{
        archiveTable: string;
        targetTable: string;
        conflictTarget: string;
        updateColumns: string[];
        suspendedTriggers: Array<{
          name: string;
          dropSql: string;
          createSql: string;
        }>;
      }>;
    };
    const overlay = protocol.authoritativeOverlays?.find(
      (candidate) => candidate.targetTable === "fiscal_corrections"
    );
    expect(overlay).toMatchObject({
      archiveTable: "fiscal_corrections_latest",
      targetTable: "fiscal_corrections",
      conflictTarget: "id"
    });
    expect(overlay!.suspendedTriggers).toEqual([
      expect.objectContaining({
        name: "trg_fiscal_correction_reserve_sequence",
        dropSql: "DROP TRIGGER IF EXISTS trg_fiscal_correction_reserve_sequence"
      })
    ]);

    const database = new DatabaseSync(":memory:");
    database.exec(`
      CREATE TABLE wompi_events (id TEXT PRIMARY KEY);
      CREATE TABLE dte_documents (id TEXT PRIMARY KEY);
      CREATE TABLE document_sequences (
        environment TEXT NOT NULL,
        control_prefix TEXT NOT NULL,
        next_value INTEGER NOT NULL,
        PRIMARY KEY (environment, control_prefix)
      );
      INSERT INTO wompi_events (id) VALUES ('wompi_1'), ('wompi_2');
      INSERT INTO document_sequences (environment, control_prefix, next_value)
      VALUES ('00', 'M001P004', 100);
    `);
    database.exec(readFileSync(
      resolve(import.meta.dirname, "../../migrations/0027_fiscal_corrections.sql"),
      "utf8"
    ));
    database.exec(readFileSync(
      resolve(import.meta.dirname, "../../migrations/0028_fiscal_correction_reservations.sql"),
      "utf8"
    ));
    const migratedReservationTrigger = database
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?"
      )
      .get("trg_fiscal_correction_reserve_sequence") as { sql: string };
    const normalizeSql = (sql: string) =>
      sql.replace(/\s+/g, " ").trim().replace(/;$/, "");
    expect(normalizeSql(overlay!.suspendedTriggers[0].createSql)).toBe(
      normalizeSql(migratedReservationTrigger.sql)
    );
    const columns = database
      .prepare("PRAGMA table_info(fiscal_corrections)")
      .all()
      .map((column) => String(column.name));
    expect([overlay!.conflictTarget, ...overlay!.updateColumns]).toEqual(columns);

    const historical = {
      id: "fiscal_correction_restored",
      request_id: "11111111-1111-4111-8111-111111111111",
      request_payload_sha256: "a".repeat(64),
      attempt_number: 1,
      target_kind: "WOMPI_EVENT",
      wompi_event_id: "wompi_1",
      document_id: null,
      environment: "00",
      status: "PROCESSING",
      before_receptor_json: JSON.stringify({ nombre: "Nombre original" }),
      corrected_receptor_json: JSON.stringify({ nombre: "Nombre corregido" }),
      changed_fields_json: JSON.stringify(["nombre"]),
      source_document_snapshot_json: null,
      issuance_attempt_id: "issuance_1",
      fiscal_claim_id: "fiscal_claim_1",
      processing_claim_id: "processing_claim_1",
      mh_dispatch_started_at: null,
      failure_code: null,
      failure_message: null,
      created_by: "user_1",
      created_at: "2026-05-15T12:00:00.000Z",
      processing_started_at: "2026-05-15T12:01:00.000Z",
      completed_at: null,
      updated_at: "2026-05-15T12:01:00.000Z",
      reserved_control_prefix: null,
      reserved_control_sequence: null,
      reserved_codigo_generacion: null,
      reserved_numero_control: null
    };
    const terminal = {
      ...historical,
      status: "ACCEPTED",
      completed_at: "2026-06-20T12:00:00.000Z",
      updated_at: "2026-06-20T12:00:00.000Z",
      reserved_control_prefix: "M001P004",
      reserved_control_sequence: 42,
      reserved_codigo_generacion: "70000003-2222-4222-8222-700000032222",
      reserved_numero_control: "DTE-15-M001P004-000000000000042"
    };
    const placeholders = columns.map(() => "?").join(", ");
    const updates = overlay!.updateColumns
      .map((column) => `${column} = excluded.${column}`)
      .join(", ");
    const values = (record: Record<string, unknown>) =>
      columns.map((column) => record[column] as SQLInputValue);
    const applyOverlay = (record: Record<string, unknown>): void => {
      database.exec("BEGIN IMMEDIATE");
      try {
        for (const trigger of overlay!.suspendedTriggers) {
          database.exec(`${trigger.dropSql};`);
        }
        database
          .prepare(
            `INSERT INTO fiscal_corrections (${columns.join(", ")})
             VALUES (${placeholders})
             ON CONFLICT(${overlay!.conflictTarget}) DO UPDATE SET ${updates}`
          )
          .run(...values(record));
        for (const trigger of overlay!.suspendedTriggers) {
          database.exec(trigger.createSql);
        }
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    };

    applyOverlay(historical);
    applyOverlay(terminal);
    applyOverlay(terminal);

    expect(database.prepare("SELECT * FROM fiscal_corrections").all()).toEqual([
      terminal
    ]);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?"
        )
        .get("trg_fiscal_correction_reserve_sequence")
    ).toEqual({ name: "trg_fiscal_correction_reserve_sequence" });

    const laterReservation = {
      ...historical,
      id: "fiscal_correction_later_reservation",
      request_id: "33333333-3333-4333-8333-333333333333",
      wompi_event_id: "wompi_2",
      issuance_attempt_id: "issuance_2",
      fiscal_claim_id: "fiscal_claim_2",
      processing_claim_id: "processing_claim_2"
    };
    applyOverlay(laterReservation);
    database
      .prepare(
        `UPDATE fiscal_corrections
            SET reserved_control_prefix = ?,
                reserved_control_sequence = ?,
                reserved_codigo_generacion = ?,
                reserved_numero_control = ?
          WHERE id = ?`
      )
      .run(
        "M001P004",
        100,
        "44444444-4444-4444-8444-444444444444",
        "DTE-15-M001P004-000000000000100",
        laterReservation.id
      );
    expect(
      database
        .prepare(
          `SELECT next_value FROM document_sequences
            WHERE environment = '00' AND control_prefix = 'M001P004'`
        )
        .get()
    ).toEqual({ next_value: 101 });
    database.close();
  });

  it("documents the latest correction overlay and legacy archive fallback", () => {
    const guidance = readFileSync(
      resolve(import.meta.dirname, "../../docs/retention-restore.md"),
      "utf8"
    );

    expect(guidance).toContain("latest `fiscal_corrections_latest.ndjson` snapshot");
    expect(guidance).toMatch(
      /after the\s+historical `fiscal_corrections\.ndjson` rows/
    );
    expect(guidance).toContain("ON CONFLICT(id) DO UPDATE");
    expect(guidance).toContain(
      "DROP TRIGGER IF EXISTS trg_fiscal_correction_reserve_sequence"
    );
    expect(guidance).toContain(
      "CREATE TRIGGER trg_fiscal_correction_reserve_sequence"
    );
    expect(guidance).toContain(
      "Archives created before `fiscal_corrections_latest.ndjson`"
    );
  });
});

describe("fiscal correction operator guidance", () => {
  it("documents guarded correction fields and uncertain-outcome escalation", () => {
    const guidance = readFileSync(
      resolve(import.meta.dirname, "../../docs/runbook-operador.md"),
      "utf8"
    );

    expect(guidance).toContain("CDE NO CREADO");
    expect(guidance).toContain("preserva el CDE");
    expect(guidance).toContain("tipo y número de documento");
    expect(guidance).toContain("Guardar y");
    expect(guidance).toContain("reintentar");
    expect(guidance).toContain("Revisión necesaria");
    expect(guidance).toContain("no se corrigen ni se reintentan automáticamente");
    expect(guidance).toContain("no use\nReintentar DTE");
  });
});
