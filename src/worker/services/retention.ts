import {
  Repository,
  RETENTION_PAGE_SIZE,
  RETENTION_SNAPSHOT_TABLES,
  RETENTION_WINDOWED_TABLES,
  type DocumentSequenceRetentionCursor,
  type RetentionCursor,
  type RetentionSnapshotTable,
  type RetentionTable
} from "../storage/repository";
import type { Env } from "../types";
import { EL_SALVADOR_TIME_ZONE } from "../../shared/legalWindows";
import { hexFromBytes, utf8Bytes } from "../utils/encoding";
import { sendOperationalAlert } from "./alerts";
import { logWorkerError } from "./observability";

const EL_SALVADOR_UTC_OFFSET_HOURS = 6;
const RETENTION_MULTIPART_PART_SIZE = 5 * 1024 * 1024;

export interface RetentionExportResult {
  status: "completed" | "skipped" | "failed";
  month: string;
  totalRows?: number;
  error?: string;
}

interface TableManifestEntry {
  rowCount: number;
  sha256: string;
}

export interface RetentionManifest {
  month: string;
  generatedAt: string;
  tables: Record<string, TableManifestEntry>;
}

interface RetentionForeignKeyPhase {
  name: string;
  tables: readonly string[];
}

interface RetentionAuthoritativeOverlay {
  archiveTable: string;
  targetTable: string;
  conflictTarget: string;
  updateColumns: readonly string[];
  suspendedTriggers: readonly RetentionSuspendedTrigger[];
}

interface RetentionSuspendedTrigger {
  name: string;
  dropSql: string;
  createSql: string;
}

export const FISCAL_CORRECTION_LATEST_SNAPSHOT = "fiscal_corrections_latest";
export const DOCUMENT_SEQUENCES_SNAPSHOT = "document_sequences";

const FISCAL_CORRECTION_RESTORE_UPDATE_COLUMNS = [
  "request_id",
  "request_payload_sha256",
  "attempt_number",
  "target_kind",
  "wompi_event_id",
  "document_id",
  "environment",
  "status",
  "before_receptor_json",
  "corrected_receptor_json",
  "changed_fields_json",
  "source_document_snapshot_json",
  "issuance_attempt_id",
  "fiscal_claim_id",
  "processing_claim_id",
  "mh_dispatch_started_at",
  "failure_code",
  "failure_message",
  "created_by",
  "created_at",
  "processing_started_at",
  "completed_at",
  "updated_at",
  "reserved_control_prefix",
  "reserved_control_sequence",
  "reserved_codigo_generacion",
  "reserved_numero_control"
] as const;

const FISCAL_CORRECTION_RESERVATION_TRIGGER: RetentionSuspendedTrigger = {
  name: "trg_fiscal_correction_reserve_sequence",
  dropSql: "DROP TRIGGER IF EXISTS trg_fiscal_correction_reserve_sequence",
  createSql: `CREATE TRIGGER trg_fiscal_correction_reserve_sequence
AFTER UPDATE OF reserved_control_sequence ON fiscal_corrections
WHEN (
  OLD.reserved_control_sequence IS NULL
  AND NEW.reserved_control_sequence IS NOT NULL
)
BEGIN
  UPDATE document_sequences
     SET next_value = next_value + 1
   WHERE environment = NEW.environment
     AND control_prefix = NEW.reserved_control_prefix
     AND next_value = NEW.reserved_control_sequence;

  SELECT RAISE(ABORT, 'fiscal correction sequence reservation failed')
   WHERE changes() <> 1;
END;`
};

// Wrangler wraps each D1 --file execution in a transaction, so the file itself
// must not contain transaction statements. Local SQLite rehearsals still need
// an explicit outer transaction. contingency_periods, dte_events, and
// dte_documents form a real cycle, so both paths defer and verify foreign keys.
export const RETENTION_FOREIGN_KEY_PROTOCOL: {
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
  restorePhases: readonly RetentionForeignKeyPhase[];
  deletePhases: readonly RetentionForeignKeyPhase[];
  authoritativeOverlays: readonly RetentionAuthoritativeOverlay[];
} = {
  wranglerFile: {
    deferForeignKeys: "PRAGMA defer_foreign_keys = ON",
    verify: "PRAGMA foreign_key_check",
    forbiddenTransactionStatements: ["BEGIN", "COMMIT", "ROLLBACK"]
  },
  localSqliteTransaction: {
    begin: "BEGIN IMMEDIATE",
    commit: "COMMIT",
    rollback: "ROLLBACK"
  },
  restorePhases: [
    {
      name: "roots",
      tables: [
        "wompi_events",
        "document_sequences",
        "stripe_checkout_sessions",
        "stripe_webhook_events"
      ]
    },
    {
      name: "deferred-cycle",
      tables: ["contingency_periods", "dte_documents", "dte_events"]
    },
    {
      name: "dependents",
      tables: [
        "fiscal_corrections",
        "email_deliveries",
        "contingency_batches",
        "donation_intents",
        "stripe_gifts"
      ]
    },
    {
      name: "leaves",
      tables: [
        "contingency_batch_lines",
        "audit_logs",
        "stripe_acknowledgment_deliveries",
        "stripe_annual_statement_deliveries"
      ]
    }
  ],
  deletePhases: [
    {
      name: "leaves",
      tables: [
        "stripe_acknowledgment_deliveries",
        "stripe_annual_statement_deliveries",
        "contingency_batch_lines",
        "audit_logs"
      ]
    },
    {
      name: "dependents",
      tables: [
        "fiscal_corrections",
        "email_deliveries",
        "contingency_batches",
        "donation_intents",
        "stripe_gifts"
      ]
    },
    {
      name: "deferred-cycle",
      tables: ["dte_events", "dte_documents", "contingency_periods"]
    },
    {
      name: "roots",
      tables: [
        "wompi_events",
        "document_sequences",
        "stripe_checkout_sessions",
        "stripe_webhook_events"
      ]
    }
  ],
  authoritativeOverlays: [
    {
      archiveTable: FISCAL_CORRECTION_LATEST_SNAPSHOT,
      targetTable: "fiscal_corrections",
      conflictTarget: "id",
      updateColumns: FISCAL_CORRECTION_RESTORE_UPDATE_COLUMNS,
      suspendedTriggers: [FISCAL_CORRECTION_RESERVATION_TRIGGER]
    }
  ]
};

// Single source of truth for the R2 archive key layout, shared with the backups
// service so month listing/verification/download derive keys the same way the
// export writes them: retention/<YYYY>/<YYYY-MM>/{manifest.json,<table>.ndjson}.
export const RETENTION_KEY_ROOT = "retention";

function retentionMonthPrefix(month: string): string {
  return `${RETENTION_KEY_ROOT}/${month.slice(0, 4)}/${month}`;
}

export function retentionManifestKey(month: string): string {
  return `${retentionMonthPrefix(month)}/manifest.json`;
}

export function retentionTableKey(month: string, table: string): string {
  return `${retentionMonthPrefix(month)}/${table}.ndjson`;
}

// Every month, snapshot all legal records into R2 so they survive D1 loss, an
// account compromise limited to the DB, or a bad migration. `now` is injectable
// for tests; `options.month` lets the manual verification endpoint re-run (or
// backfill) an explicit YYYY-MM instead of "the previous calendar month".
export async function runRetentionExport(env: Env, now: Date, options: { month?: string } = {}): Promise<RetentionExportResult> {
  const month = options.month ?? previousElSalvadorMonth(now);
  const incidentId = `${month}:${now.toISOString()}`;
  const repo = new Repository(env.DB);
  const prefix = retentionMonthPrefix(month);
  const manifestKey = retentionManifestKey(month);

  try {
    const existingManifest = await env.ARCHIVE.head(manifestKey);
    if (existingManifest) {
      await repo.createAudit({
        action: "RETENTION_EXPORT_SKIPPED",
        entityType: "retention_export",
        entityId: month,
        summary: `Exportación de retención ${month} ya existe; se omite (idempotente)`
      });
      return { status: "skipped", month };
    }

    const manifest: RetentionManifest = {
      month,
      generatedAt: now.toISOString(),
      tables: {}
    };
    let totalRows = 0;

    const { startIso, endIso } = elSalvadorMonthWindow(month);
    for (const table of RETENTION_WINDOWED_TABLES) {
      const entry = await exportWindowedTable(env, repo, table, prefix, startIso, endIso);
      manifest.tables[table] = entry;
      totalRows += entry.rowCount;
    }
    const fiscalCorrectionSnapshotEntry = await exportFiscalCorrectionSnapshot(env, prefix);
    manifest.tables[FISCAL_CORRECTION_LATEST_SNAPSHOT] = fiscalCorrectionSnapshotEntry;
    totalRows += fiscalCorrectionSnapshotEntry.rowCount;
    for (const table of RETENTION_SNAPSHOT_TABLES) {
      const entry = await exportSnapshotTable(env, repo, table, prefix);
      manifest.tables[table] = entry;
      totalRows += entry.rowCount;
    }
    const sequenceEntry = await exportDocumentSequences(env, repo, prefix);
    manifest.tables[DOCUMENT_SEQUENCES_SNAPSHOT] = sequenceEntry;
    totalRows += sequenceEntry.rowCount;

    // Manifest last: its existence is the idempotency/completion marker.
    await env.ARCHIVE.put(manifestKey, utf8Bytes(JSON.stringify(manifest, null, 2)));

    await repo.createAudit({
      action: "RETENTION_EXPORT_COMPLETED",
      entityType: "retention_export",
      entityId: month,
      summary: `Exportación de retención ${month} completada: ${totalRows} filas`,
      metadata: { month, totalRows, tables: manifest.tables }
    });
    return { status: "completed", month, totalRows };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await repo.createAudit({
      action: "RETENTION_EXPORT_FAILED",
      entityType: "retention_export",
      entityId: month,
      summary: message,
      metadata: { incidentId }
    });
    // A failed monthly export leaves a gap in the immutable archive. The scheduled
    // timestamp identifies this attempt, so a replay of it dedupes while a later
    // deliberate export attempt can alert again.
    await sendOperationalAlert(env, repo, {
      kind: "RETENTION_EXPORT_FAILED",
      title: `Exportación de retención ${month} fallida`,
      detail: `La exportación de retención del mes ${month} falló: ${message}`,
      entityType: "retention_export",
      entityId: month,
      incidentId
    });
    return { status: "failed", month, error: message };
  }
}

async function exportWindowedTable(
  env: Env,
  repo: Repository,
  table: RetentionTable,
  prefix: string,
  startIso: string,
  endIso: string
): Promise<TableManifestEntry> {
  return streamRetentionTable<RetentionCursor>(
    env,
    `${prefix}/${table}.ndjson`,
    (cursor) => repo.listRowsCreatedBetween(table, { startIso, endIso }, cursor, RETENTION_PAGE_SIZE),
    (row) => ({
      createdAt: String(row.created_at),
      id: String(row.id)
    })
  );
}

async function exportFiscalCorrectionSnapshot(
  env: Env,
  prefix: string
): Promise<TableManifestEntry> {
  return streamRetentionTable<RetentionCursor>(
    env,
    `${prefix}/${FISCAL_CORRECTION_LATEST_SNAPSHOT}.ndjson`,
    async (cursor) => {
      const conditions: string[] = [];
      const bindings: Array<string | number> = [];
      if (cursor) {
        conditions.push("(created_at, id) > (?, ?)");
        bindings.push(cursor.createdAt, cursor.id);
      }
      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = await env.DB
        .prepare(
          `SELECT * FROM fiscal_corrections ${where}
           ORDER BY created_at ASC, id ASC LIMIT ?`
        )
        .bind(...bindings, RETENTION_PAGE_SIZE)
        .all<Record<string, unknown>>();
      return rows.results ?? [];
    },
    (row) => ({
      createdAt: String(row.created_at),
      id: String(row.id)
    })
  );
}

async function exportSnapshotTable(env: Env, repo: Repository, table: RetentionSnapshotTable, prefix: string): Promise<TableManifestEntry> {
  const cursorColumn = table === "wompi_events" || table === "stripe_webhook_events"
    ? "received_at"
    : "created_at";
  return streamRetentionTable<RetentionCursor>(
    env,
    `${prefix}/${table}.ndjson`,
    (cursor) => repo.listAllRowsPaged(table, cursor, RETENTION_PAGE_SIZE),
    (row) => ({
      createdAt: String(row[cursorColumn]),
      id: String(row.id)
    })
  );
}

async function exportDocumentSequences(
  env: Env,
  repo: Repository,
  prefix: string
): Promise<TableManifestEntry> {
  return streamRetentionTable<DocumentSequenceRetentionCursor>(
    env,
    `${prefix}/document_sequences.ndjson`,
    (cursor) => repo.listDocumentSequencesPaged(cursor, RETENTION_PAGE_SIZE),
    (row) => ({
      environment: String(row.environment),
      controlPrefix: String(row.control_prefix)
    })
  );
}

async function streamRetentionTable<Cursor>(
  env: Env,
  key: string,
  readPage: (cursor: Cursor | null) => Promise<Array<Record<string, unknown>>>,
  cursorFrom: (row: Record<string, unknown>) => Cursor
): Promise<TableManifestEntry> {
  const tempKey = `${key}.tmp.${crypto.randomUUID()}`;
  const digest = new crypto.DigestStream("SHA-256");
  const digestWriter = digest.getWriter();
  const digestResultPromise = digest.digest.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  );
  let multipartUpload: R2MultipartUpload | null = null;
  let multipartCompleted = false;
  const uploadedParts: R2UploadedPart[] = [];
  let partNumber = 1;
  let partBuffer = new Uint8Array(RETENTION_MULTIPART_PART_SIZE);
  let partOffset = 0;
  let cursor: Cursor | null = null;
  let rowCount = 0;

  try {
    multipartUpload = await env.ARCHIVE.createMultipartUpload(tempKey);
    for (;;) {
      const rows = await readPage(cursor);
      if (rows.length === 0) break;
      for (const row of rows) {
        const bytes = utf8Bytes(`${JSON.stringify(row)}\n`);
        await digestWriter.write(bytes);
        let sourceOffset = 0;
        while (sourceOffset < bytes.byteLength) {
          const copyLength = Math.min(
            bytes.byteLength - sourceOffset,
            RETENTION_MULTIPART_PART_SIZE - partOffset
          );
          partBuffer.set(bytes.subarray(sourceOffset, sourceOffset + copyLength), partOffset);
          sourceOffset += copyLength;
          partOffset += copyLength;
          if (partOffset === RETENTION_MULTIPART_PART_SIZE) {
            uploadedParts.push(await multipartUpload.uploadPart(partNumber, partBuffer));
            partNumber += 1;
            partBuffer = new Uint8Array(RETENTION_MULTIPART_PART_SIZE);
            partOffset = 0;
          }
        }
        rowCount += 1;
      }
      cursor = cursorFrom(rows[rows.length - 1]);
      if (rows.length < RETENTION_PAGE_SIZE) break;
    }

    await digestWriter.close();
    const digestResult = await digestResultPromise;
    if (!digestResult.ok) {
      throw digestResult.error;
    }
    if (partOffset > 0 || uploadedParts.length === 0) {
      uploadedParts.push(
        await multipartUpload.uploadPart(partNumber, partBuffer.subarray(0, partOffset))
      );
    }
    await multipartUpload.complete(uploadedParts);
    multipartCompleted = true;
    const tempObject = await env.ARCHIVE.get(tempKey);
    if (!tempObject) {
      throw new Error("retention_temp_object_missing");
    }
    await env.ARCHIVE.put(key, tempObject.body);
    await cleanupRetentionTempObject(env, tempKey);
    const sha256 = hexFromBytes(new Uint8Array(digestResult.value));
    return { rowCount, sha256 };
  } catch (error) {
    await Promise.allSettled([digestWriter.abort(error), digestResultPromise]);
    const cleanupResults = await Promise.allSettled([
      multipartUpload && !multipartCompleted ? multipartUpload.abort() : Promise.resolve(),
      env.ARCHIVE.delete(tempKey)
    ]);
    for (const cleanupResult of cleanupResults) {
      if (cleanupResult.status !== "rejected") continue;
      try {
        logWorkerError(env, "retention_partial_object_cleanup_failed", cleanupResult.reason);
      } catch {
        // Cleanup diagnostics must never replace the primary export failure.
      }
    }
    throw error;
  }
}

async function cleanupRetentionTempObject(env: Env, tempKey: string): Promise<void> {
  try {
    await env.ARCHIVE.delete(tempKey);
  } catch (cleanupError) {
    try {
      logWorkerError(env, "retention_temp_object_cleanup_failed", cleanupError);
    } catch {
      // Cleanup diagnostics must never replace a successful export.
    }
  }
}

// "Previous calendar month" in El Salvador local time (UTC-6, no DST): if `now`
// falls on the 1st of the month before 06:00 UTC (= midnight El Salvador), the
// El Salvador calendar date is still the last day of the prior month, so the
// "previous month" shifts back one further. Using Intl with the IANA zone
// handles this correctly without hand-rolling the UTC-6 offset for `now` itself.
export function previousElSalvadorMonth(now: Date): string {
  const { year, month } = elSalvadorYearMonth(now);
  const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
  return `${previous.year}-${String(previous.month).padStart(2, "0")}`;
}

// The YYYY-MM (El Salvador local time) that a given instant falls in. The backups
// panel uses this to place the earliest document in its calendar month.
export function elSalvadorMonth(date: Date): string {
  const { year, month } = elSalvadorYearMonth(date);
  return `${year}-${String(month).padStart(2, "0")}`;
}

function elSalvadorYearMonth(date: Date): { year: number; month: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: EL_SALVADOR_TIME_ZONE,
    year: "numeric",
    month: "2-digit"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: value("year"), month: value("month") };
}

// [startIso, endIso) in UTC representing the given YYYY-MM month as observed in
// El Salvador local time (fixed UTC-6, no DST — a constant offset is exact).
function elSalvadorMonthWindow(month: string): { startIso: string; endIso: string } {
  const [yearStr, monthStr] = month.split("-");
  const year = Number(yearStr);
  const monthNumber = Number(monthStr);
  const start = new Date(Date.UTC(year, monthNumber - 1, 1, EL_SALVADOR_UTC_OFFSET_HOURS, 0, 0));
  const end = new Date(Date.UTC(year, monthNumber, 1, EL_SALVADOR_UTC_OFFSET_HOURS, 0, 0));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}
