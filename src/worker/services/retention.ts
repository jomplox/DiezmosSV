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
import { hexFromBytes, utf8Bytes } from "../utils/encoding";
import { sendOperationalAlert } from "./alerts";

const EL_SALVADOR_TIME_ZONE = "America/El_Salvador";
const EL_SALVADOR_UTC_OFFSET_HOURS = 6;

export interface RetentionExportResult {
  status: "completed" | "skipped" | "failed";
  month: string;
  totalRows?: number;
  error?: string;
}

export interface TableManifestEntry {
  rowCount: number;
  sha256: string;
}

export interface RetentionManifest {
  month: string;
  generatedAt: string;
  tables: Record<string, TableManifestEntry>;
}

// Single source of truth for the R2 archive key layout, shared with the backups
// service so month listing/verification/download derive keys the same way the
// export writes them: retention/<YYYY>/<YYYY-MM>/{manifest.json,<table>.ndjson}.
export const RETENTION_KEY_ROOT = "retention";

export function retentionMonthPrefix(month: string): string {
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
    for (const table of RETENTION_SNAPSHOT_TABLES) {
      const entry = await exportSnapshotTable(env, repo, table, prefix);
      manifest.tables[table] = entry;
      totalRows += entry.rowCount;
    }
    const sequenceEntry = await exportDocumentSequences(env, repo, prefix);
    manifest.tables.document_sequences = sequenceEntry;
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
      summary: message
    });
    // A failed monthly export leaves a gap in the immutable archive; alert an operator
    // rather than waiting for someone to open the backups panel. Deduped per month via
    // the ALERT_SENT:<kind> pattern, so repeated failing runs for the same month notify once.
    await sendOperationalAlert(env, repo, {
      kind: "RETENTION_EXPORT_FAILED",
      title: `Exportación de retención ${month} fallida`,
      detail: `La exportación de retención del mes ${month} falló: ${message}`,
      entityType: "retention_export",
      entityId: month
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

async function exportSnapshotTable(env: Env, repo: Repository, table: RetentionSnapshotTable, prefix: string): Promise<TableManifestEntry> {
  const cursorColumn = table === "wompi_events" ? "received_at" : "created_at";
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
  const identity = new TransformStream<Uint8Array, Uint8Array>();
  const digest = new crypto.DigestStream("SHA-256");
  const bodyWriter = identity.writable.getWriter();
  const digestWriter = digest.getWriter();
  const digestResultPromise = digest.digest.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error })
  );
  const putPromise = env.ARCHIVE.put(tempKey, identity.readable);
  void putPromise.catch((error) => bodyWriter.abort(error).catch(() => undefined));
  let cursor: Cursor | null = null;
  let rowCount = 0;

  try {
    for (;;) {
      const rows = await readPage(cursor);
      if (rows.length === 0) break;
      for (const row of rows) {
        const bytes = utf8Bytes(`${JSON.stringify(row)}\n`);
        await Promise.all([bodyWriter.write(bytes), digestWriter.write(bytes)]);
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
    await bodyWriter.close();
    await putPromise;
    const tempObject = await env.ARCHIVE.get(tempKey);
    if (!tempObject) {
      throw new Error("retention_temp_object_missing");
    }
    await env.ARCHIVE.put(key, tempObject.body);
    await cleanupRetentionTempObject(env, tempKey);
    const sha256 = hexFromBytes(new Uint8Array(digestResult.value));
    return { rowCount, sha256 };
  } catch (error) {
    await Promise.allSettled([bodyWriter.abort(error), digestWriter.abort(error)]);
    await Promise.allSettled([putPromise, digestResultPromise]);
    try {
      await env.ARCHIVE.delete(tempKey);
    } catch (cleanupError) {
      try {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        console.error("Retention partial-object cleanup failed", { key: tempKey, error: message });
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
      const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      console.error("Retention temp-object cleanup failed", { key: tempKey, error: message });
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
