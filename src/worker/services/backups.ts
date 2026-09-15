import { Repository } from "../storage/repository";
import type { AuthUser } from "./auth";
import type { Env } from "../types";
import { sha256Hex, utf8Bytes } from "../utils/encoding";
import { newId } from "../utils/ids";
import { sendOperationalAlert } from "./alerts";
import {
  RETENTION_CANONICAL_TABLES,
  RETENTION_KEY_ROOT,
  canonicalRetentionManifestJson,
  elSalvadorMonth,
  parseRetentionManifest,
  previousElSalvadorMonth,
  retentionManifestKey,
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
  reason?: BackupVerifyFailureReason;
}

type BackupVerifyFailureReason =
  | "manifest_invalid"
  | "anchor_missing"
  | "anchor_invalid"
  | "anchor_mismatch"
  | "object_mismatch";

type ManifestReadResult =
  | { status: "absent" }
  | { status: "invalid" }
  | { status: "valid"; manifest: RetentionManifest };

const RETENTION_DOWNLOAD_TABLES = new Set<string>(RETENTION_CANONICAL_TABLES);

export async function isManifestedBackupTable(env: Env, month: string, table: string): Promise<boolean> {
  return (await manifestedBackupTableKey(env, month, table)) !== null;
}

export async function manifestedBackupTableKey(
  env: Env,
  month: string,
  table: string
): Promise<string | null> {
  if (!RETENTION_DOWNLOAD_TABLES.has(table)) {
    return null;
  }
  const manifestResult = await readManifest(env, month);
  if (manifestResult.status !== "valid") {
    return null;
  }
  return manifestResult.manifest.tables[table].key;
}

// Ground truth is the set of manifests in R2, never the audit log. A month is
// "archivado" only when its manifest.json passes the exact v2 schema; the current
// (still open) El Salvador month is always "en_curso"; every other expected month
// without a valid manifest is "faltante".
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
  const manifestResult = await readManifest(env, month);
  if (manifestResult.status === "absent") {
    return null;
  }
  const incidentId = newId("retention_verify");
  if (manifestResult.status === "invalid") {
    return failBackupVerification(env, repo, month, actor, incidentId, "manifest_invalid", []);
  }
  const manifest = manifestResult.manifest;

  const anchor = await repo.getLatestRetentionExportCompletionAudit(month);
  if (!anchor) {
    return failBackupVerification(env, repo, month, actor, incidentId, "anchor_missing", []);
  }
  const manifestSha256 = await sha256Hex(utf8Bytes(canonicalRetentionManifestJson(manifest)));
  const anchorStatus = retentionAnchorStatus(anchor.metadataJson, manifest, manifestSha256);
  if (anchorStatus !== "valid") {
    return failBackupVerification(env, repo, month, actor, incidentId, anchorStatus, []);
  }

  const files: BackupVerifyFile[] = [];
  for (const table of RETENTION_CANONICAL_TABLES) {
    const entry = manifest.tables[table];
    const object = await env.ARCHIVE.get(entry.key);
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
    return failBackupVerification(
      env,
      repo,
      month,
      actor,
      incidentId,
      "object_mismatch",
      mismatches,
      files
    );
  }
  return { ok, files };
}

async function failBackupVerification(
  env: Env,
  repo: Repository,
  month: string,
  actor: AuthUser,
  incidentId: string,
  reason: BackupVerifyFailureReason,
  tables: string[],
  files: BackupVerifyFile[] = []
): Promise<BackupVerifyResult> {
  const canonicalTables = RETENTION_CANONICAL_TABLES.filter((table) => tables.includes(table));
  await repo.createAudit({
    actorType: "USER",
    actorId: actor.id,
    action: "RETENTION_VERIFY_FAILED",
    entityType: "retention_export",
    entityId: month,
    summary: `Verificación de respaldo ${month} fallida (${reason})`,
    metadata: { month, reason, tables: canonicalTables, incidentId }
  });
  await sendOperationalAlert(env, repo, {
    kind: "RETENTION_VERIFY_FAILED",
    title: `Verificación de respaldo ${month} fallida`,
    detail: canonicalTables.length > 0
      ? `La verificación falló (${reason}) en: ${canonicalTables.join(", ")}.`
      : `La verificación falló (${reason}) antes de validar archivos.`,
    entityType: "retention_export",
    entityId: month,
    incidentId
  });
  return { ok: false, reason, files };
}

function retentionAnchorStatus(
  metadataJson: unknown,
  manifest: RetentionManifest,
  manifestSha256: string
): "valid" | "anchor_invalid" | "anchor_mismatch" {
  if (typeof metadataJson !== "string") return "anchor_invalid";
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataJson);
  } catch {
    return "anchor_invalid";
  }
  if (!isRecord(metadata)) return "anchor_invalid";

  const legacyFields = ["month", "totalRows", "tables"] as const;
  const newFields = ["month", "runId", "generatedAt", "totalRows", "tables", "manifestSha256"] as const;
  const isLegacy = hasExactFields(metadata, legacyFields);
  const isNew = hasExactFields(metadata, newFields);
  if (!isLegacy && !isNew) return "anchor_invalid";
  if (
    typeof metadata.month !== "string"
    || !Number.isSafeInteger(metadata.totalRows)
    || Number(metadata.totalRows) < 0
  ) {
    return "anchor_invalid";
  }

  const tableStatus = anchorTableStatus(metadata.tables, manifest);
  if (tableStatus !== "valid") return tableStatus;
  const expectedTotalRows = RETENTION_CANONICAL_TABLES.reduce(
    (sum, table) => sum + manifest.tables[table].rowCount,
    0
  );
  if (metadata.month !== manifest.month || metadata.totalRows !== expectedTotalRows) {
    return "anchor_mismatch";
  }
  if (isLegacy) return "valid";

  if (
    typeof metadata.runId !== "string"
    || !/^[A-Za-z0-9_-]{1,100}$/.test(metadata.runId)
    || typeof metadata.generatedAt !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(metadata.generatedAt)
    || Number.isNaN(new Date(metadata.generatedAt).getTime())
    || new Date(metadata.generatedAt).toISOString() !== metadata.generatedAt
    || typeof metadata.manifestSha256 !== "string"
    || !/^[0-9a-f]{64}$/.test(metadata.manifestSha256)
  ) {
    return "anchor_invalid";
  }
  return metadata.runId === manifest.runId
    && metadata.generatedAt === manifest.generatedAt
    && metadata.manifestSha256 === manifestSha256
    ? "valid"
    : "anchor_mismatch";
}

function anchorTableStatus(
  value: unknown,
  manifest: RetentionManifest
): "valid" | "anchor_invalid" | "anchor_mismatch" {
  if (!isRecord(value)) return "anchor_invalid";
  const tableNames = Object.keys(value);
  if (
    tableNames.length !== RETENTION_CANONICAL_TABLES.length
    || RETENTION_CANONICAL_TABLES.some((table) => !Object.hasOwn(value, table))
  ) {
    return "anchor_invalid";
  }
  for (const table of RETENTION_CANONICAL_TABLES) {
    const entry = value[table];
    if (!hasExactFields(entry, ["key", "rowCount", "sha256"] as const)) {
      return "anchor_invalid";
    }
    if (
      typeof entry.key !== "string"
      || !Number.isSafeInteger(entry.rowCount)
      || Number(entry.rowCount) < 0
      || typeof entry.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      return "anchor_invalid";
    }
    const expected = manifest.tables[table];
    if (
      entry.key !== expected.key
      || entry.rowCount !== expected.rowCount
      || entry.sha256 !== expected.sha256
    ) {
      return "anchor_mismatch";
    }
  }
  return "valid";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields<const Fields extends readonly string[]>(
  value: unknown,
  fields: Fields
): value is Record<Fields[number], unknown> {
  return isRecord(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(manifestBytes));
  } catch {
    return null;
  }
  const manifest = parseRetentionManifest(parsed, month);
  if (!manifest) return null;

  const entries: Array<{ name: string; data: Uint8Array }> = [{ name: "manifest.json", data: manifestBytes }];
  for (const table of RETENTION_CANONICAL_TABLES) {
    const object = await env.ARCHIVE.get(manifest.tables[table].key);
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

async function readManifest(env: Env, month: string): Promise<ManifestReadResult> {
  const object = await env.ARCHIVE.get(retentionManifestKey(month));
  if (!object) {
    return { status: "absent" };
  }
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder().decode(new Uint8Array(await object.arrayBuffer()))
    );
    const manifest = parseRetentionManifest(parsed, month);
    return manifest ? { status: "valid", manifest } : { status: "invalid" };
  } catch {
    return { status: "invalid" };
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
    const manifestResult = await readManifest(env, month);
    if (manifestResult.status === "valid") {
      manifests.set(month, manifestResult.manifest);
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
