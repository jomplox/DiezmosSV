import { Repository, RETENTION_SNAPSHOT_TABLES, RETENTION_WINDOWED_TABLES } from "../storage/repository";
import type { AuthUser } from "./auth";
import type { Env } from "../types";
import { sha256Hex } from "../utils/encoding";
import { newId } from "../utils/ids";
import { sendOperationalAlert } from "./alerts";
import {
  DOCUMENT_SEQUENCES_SNAPSHOT,
  FISCAL_CORRECTION_LATEST_SNAPSHOT,
  RETENTION_KEY_ROOT,
  elSalvadorMonth,
  previousElSalvadorMonth,
  retentionManifestKey,
  retentionTableKey,
  type RetentionManifest
} from "./retention";

type BackupMonthStatus = "archivado" | "faltante" | "en_curso";

// Keep the convenience full-month ZIP endpoint within the Workers memory budget.
// The ZIP writer is intentionally dependency-free and buffers the resulting archive,
// so reject archives whose raw R2 payloads would make that bounded buffering unsafe.
export const BACKUP_MONTH_DOWNLOAD_MAX_BYTES = 32 * 1024 * 1024;

export class BackupArchiveTooLargeError extends Error {
  constructor(readonly limitBytes: number) {
    super("Backup archive is too large to download as a ZIP");
    this.name = "BackupArchiveTooLargeError";
  }
}

interface BackupMonth {
  month: string;
  status: BackupMonthStatus;
  exportedAt: string | null;
  totalRows: number | null;
  tables: string[];
}

export interface BackupsGrid {
  months: BackupMonth[];
}

interface BackupVerifyFile {
  table: string;
  ok: boolean;
  expected: string;
  actual: string;
}

export interface BackupVerifyResult {
  ok: boolean;
  files: BackupVerifyFile[];
}

const RETENTION_DOWNLOAD_TABLES = new Set<string>([
  ...RETENTION_WINDOWED_TABLES,
  ...RETENTION_SNAPSHOT_TABLES,
  FISCAL_CORRECTION_LATEST_SNAPSHOT,
  DOCUMENT_SEQUENCES_SNAPSHOT
]);

export async function isManifestedBackupTable(env: Env, month: string, table: string): Promise<boolean> {
  if (!RETENTION_DOWNLOAD_TABLES.has(table)) {
    return false;
  }
  const manifest = await getManifest(env, month);
  return manifest !== null
    && typeof manifest.tables === "object"
    && manifest.tables !== null
    && Object.hasOwn(manifest.tables, table);
}

// Ground truth is the set of manifests in R2, never the audit log. A month is
// "archivado" only when its manifest.json exists and parses; the current (still
// open) El Salvador month is always "en_curso"; every other expected month with
// no manifest is "faltante".
export async function listBackupMonths(env: Env, repo: Repository, now: Date): Promise<BackupsGrid> {
  const manifests = await listArchivedManifests(env);
  const earliestDocIso = await repo.earliestDteDocumentCreatedAt();
  const earliestDocMonth = earliestDocIso ? elSalvadorMonth(new Date(earliestDocIso)) : null;

  // No documents and no manifests -> nothing to show.
  const archivedMonths = [...manifests.keys()];
  if (archivedMonths.length === 0 && !earliestDocMonth) {
    return { months: [] };
  }

  const lastClosedMonth = previousElSalvadorMonth(now);
  const currentMonth = elSalvadorMonth(now);

  const candidateStarts = [...archivedMonths];
  if (earliestDocMonth) {
    candidateStarts.push(earliestDocMonth);
  }
  const startMonth = candidateStarts.sort()[0];

  // The range runs through the current month so it can be shown as en_curso, even
  // though it is never expected to have a manifest yet.
  const expectedMonths = monthRange(minMonth(startMonth, lastClosedMonth), maxMonth(lastClosedMonth, currentMonth));

  const months: BackupMonth[] = expectedMonths.map((month) => {
    if (month > lastClosedMonth) {
      return { month, status: "en_curso", exportedAt: null, totalRows: null, tables: [] };
    }
    const manifest = manifests.get(month);
    if (manifest) {
      return {
        month,
        status: "archivado",
        exportedAt: manifest.generatedAt,
        totalRows: Object.values(manifest.tables).reduce((sum, entry) => sum + entry.rowCount, 0),
        tables: Object.keys(manifest.tables)
      };
    }
    return { month, status: "faltante", exportedAt: null, totalRows: null, tables: [] };
  });

  // Newest month first.
  months.sort((left, right) => (left.month < right.month ? 1 : left.month > right.month ? -1 : 0));
  return { months };
}

// Re-read every object named in the month's manifest, recompute its SHA-256, and
// compare against the manifest's recorded checksums. A full match audits
// RETENTION_VERIFIED; any mismatch (or a missing object) audits
// RETENTION_VERIFY_FAILED and fires an operational alert, so silent tampering or
// bit-rot does not wait for someone to reopen the panel.
export async function verifyBackupMonth(env: Env, repo: Repository, month: string, actor: AuthUser): Promise<BackupVerifyResult | null> {
  const manifest = await getManifest(env, month);
  if (!manifest) {
    return null;
  }
  const incidentId = newId("retention_verify");

  const files: BackupVerifyFile[] = [];
  for (const [table, entry] of Object.entries(manifest.tables)) {
    const object = await env.ARCHIVE.get(retentionTableKey(month, table));
    if (!object) {
      files.push({ table, ok: false, expected: entry.sha256, actual: "" });
      continue;
    }
    const actual = await sha256Hex(new Uint8Array(await object.arrayBuffer()));
    files.push({ table, ok: actual === entry.sha256, expected: entry.sha256, actual });
  }

  const ok = files.every((file) => file.ok);
  if (ok) {
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "RETENTION_VERIFIED",
      entityType: "retention_export",
      entityId: month,
      summary: `Respaldo de ${month} verificado: ${files.length} archivo(s) íntegro(s)`,
      metadata: { month, files }
    });
  } else {
    const mismatches = files.filter((file) => !file.ok).map((file) => file.table);
    await repo.createAudit({
      actorType: "USER",
      actorId: actor.id,
      action: "RETENTION_VERIFY_FAILED",
      entityType: "retention_export",
      entityId: month,
      summary: `Respaldo de ${month} con discrepancias: ${mismatches.join(", ")}`,
      metadata: { month, mismatches, files, incidentId }
    });
    await sendOperationalAlert(env, repo, {
      kind: "RETENTION_VERIFY_FAILED",
      title: `Respaldo de ${month} corrupto o alterado`,
      detail: `La verificación del respaldo de ${month} falló. Archivos con discrepancia: ${mismatches.join(", ")}.`,
      entityType: "retention_export",
      entityId: month,
      incidentId
    });
  }
  return { ok, files };
}

// Collects every R2 object of a month's archive (the manifest.json plus each table's
// NDJSON snapshot) as ZIP entries, so the whole month downloads as one file. Returns
// null when the month has no manifest (never archived) so the route can 404 exactly
// like the per-table download. A table named in the manifest but missing from R2 is
// skipped defensively rather than aborting the whole archive. The manifest is placed
// first so the archive is self-describing.
export async function collectBackupMonthObjects(env: Env, month: string): Promise<Array<{ name: string; data: Uint8Array }> | null> {
  const manifestObject = await env.ARCHIVE.get(retentionManifestKey(month));
  if (!manifestObject) {
    return null;
  }
  enforceBackupArchiveLimit(manifestObject.size);
  const manifestBytes = new Uint8Array(await manifestObject.arrayBuffer());
  let totalBytes = manifestBytes.byteLength;
  enforceBackupArchiveLimit(totalBytes);

  let manifest: RetentionManifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as RetentionManifest;
  } catch {
    return null;
  }

  const entries: Array<{ name: string; data: Uint8Array }> = [{ name: "manifest.json", data: manifestBytes }];
  for (const table of Object.keys(manifest.tables)) {
    const object = await env.ARCHIVE.get(retentionTableKey(month, table));
    if (!object) {
      continue;
    }
    enforceBackupArchiveLimit(totalBytes + object.size);
    const data = new Uint8Array(await object.arrayBuffer());
    totalBytes += data.byteLength;
    enforceBackupArchiveLimit(totalBytes);
    entries.push({ name: `${table}.ndjson`, data });
  }
  return entries;
}

function enforceBackupArchiveLimit(totalBytes: number): void {
  if (totalBytes > BACKUP_MONTH_DOWNLOAD_MAX_BYTES) {
    throw new BackupArchiveTooLargeError(BACKUP_MONTH_DOWNLOAD_MAX_BYTES);
  }
}

async function getManifest(env: Env, month: string): Promise<RetentionManifest | null> {
  const object = await env.ARCHIVE.get(retentionManifestKey(month));
  if (!object) {
    return null;
  }
  try {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(await object.arrayBuffer()))) as RetentionManifest;
  } catch {
    return null;
  }
}

async function listArchivedManifests(env: Env): Promise<Map<string, RetentionManifest>> {
  const manifests = new Map<string, RetentionManifest>();
  const listed = await env.ARCHIVE.list({ prefix: `${RETENTION_KEY_ROOT}/` });
  const manifestKeys = (listed.objects ?? []).map((object) => object.key).filter((key) => key.endsWith("/manifest.json"));
  for (const key of manifestKeys) {
    // retention/<YYYY>/<YYYY-MM>/manifest.json
    const month = key.split("/").at(-2) ?? "";
    if (!/^\d{4}-\d{2}$/.test(month)) {
      continue;
    }
    const manifest = await getManifest(env, month);
    if (manifest) {
      manifests.set(month, manifest);
    }
  }
  return manifests;
}

function monthRange(startMonth: string, endMonth: string): string[] {
  if (startMonth > endMonth) {
    return [];
  }
  const months: string[] = [];
  let [year, month] = startMonth.split("-").map(Number);
  const [endYear, endMonthNumber] = endMonth.split("-").map(Number);
  while (year < endYear || (year === endYear && month <= endMonthNumber)) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return months;
}

function minMonth(a: string, b: string): string {
  return a < b ? a : b;
}

function maxMonth(a: string, b: string): string {
  return a > b ? a : b;
}
