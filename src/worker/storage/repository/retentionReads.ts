import type {
  Ambiente,
  DonationGiftType,
  DteDocumentRecord
} from "../../types";
import type { ContactSourceRow } from "../../services/contacts";
import { redactSensitiveAuditRows } from "../shared";

export const RETENTION_PAGE_SIZE = 500;

export const RETENTION_WINDOWED_TABLES = [
  "dte_documents",
  "fiscal_corrections",
  "donation_intents",
  "dte_events",
  "email_deliveries",
  "audit_logs"
] as const;
export type RetentionTable = (typeof RETENTION_WINDOWED_TABLES)[number];

export const RETENTION_SNAPSHOT_TABLES = [
  "wompi_events",
  "contingency_periods",
  "contingency_batches",
  "contingency_batch_lines"
] as const;
export type RetentionSnapshotTable = (typeof RETENTION_SNAPSHOT_TABLES)[number];

export interface RetentionCursor {
  createdAt: string;
  id: string;
}

export interface DocumentSequenceRetentionCursor {
  environment: string;
  controlPrefix: string;
}

function retentionSnapshotTimestampColumn(
  table: RetentionSnapshotTable
): "created_at" | "received_at" {
  return table === "wompi_events" ? "received_at" : "created_at";
}

// Raw D1 column shape for the contacts export join (snake_case, intent_* columns
// null when a document has no correlated COMPLETED intent). Mapped to the camelCase
// ContactSourceRow before it leaves the repository.
interface ContactSourceRowRow {
  id: string;
  donor_email: string | null;
  donor_name: string | null;
  amount_cents: number;
  issued_at: string;
  intent_donor_phone: string | null;
  intent_direccion_complemento: string | null;
  intent_direccion_departamento: string | null;
  intent_donor_pais: string | null;
  intent_gift_type: DonationGiftType | null;
  intent_created_at: string | null;
}

function mapContactSourceRow(row: ContactSourceRowRow): ContactSourceRow {
  return {
    id: row.id,
    donorEmail: row.donor_email,
    donorName: row.donor_name,
    amountCents: row.amount_cents,
    issuedAt: row.issued_at,
    donorPhone: row.intent_donor_phone,
    direccionComplemento: row.intent_direccion_complemento,
    direccionDepartamento: row.intent_direccion_departamento,
    donorPais: row.intent_donor_pais,
    giftType: row.intent_gift_type,
    intentCreatedAt: row.intent_created_at
  };
}

export async function listAcceptedDteDocumentsForExport(
  db: D1Database
): Promise<DteDocumentRecord[]> {
  return db
    .prepare(
       `SELECT * FROM dte_documents
       WHERE status = 'ACCEPTED' AND sello_recibido IS NOT NULL
         AND fiscal_operation_claim_id IS NULL
       ORDER BY issued_at ASC`
    )
    .all<DteDocumentRecord>()
    .then((result) => result.results ?? []);
}

// Keyset-paged read of ACCEPTED documents issued within [startIso, endIso) for the
// annual donor certificate (Task 4). Mirrors the retention paged-read style: a
// (issued_at, id) cursor bounds each page so a busy year is read in fixed chunks
// rather than one unpaged scan. INVALIDATED (and every non-ACCEPTED) status is
// excluded by the WHERE clause, matching the certificate's "accepted only" rule.
export async function listAcceptedDocumentsInYear(
  db: D1Database,
  range: { startIso: string; endIso: string },
  cursor: { issuedAt: string; id: string } | null,
  limit: number
): Promise<DteDocumentRecord[]> {
  const conditions = [
    "status = 'ACCEPTED'",
    "fiscal_operation_claim_id IS NULL",
    "issued_at >= ?",
    "issued_at < ?"
  ];
  const bindings: Array<string | number> = [range.startIso, range.endIso];
  if (cursor) {
    conditions.push("(issued_at, id) > (?, ?)");
    bindings.push(cursor.issuedAt, cursor.id);
  }
  const rows = await db
    .prepare(`SELECT * FROM dte_documents WHERE ${conditions.join(" AND ")} ORDER BY issued_at ASC, id ASC LIMIT ?`)
    .bind(...bindings, limit)
    .all<DteDocumentRecord>();
  return rows.results ?? [];
}

// Keyset-paged read of Wompi-lane ACCEPTED documents for one ambiente, LEFT JOINed
// to their correlated COMPLETED donation intent (0 or 1 per document via
// donation_intents.document_id, idx_donation_intents_document_id from migration
// 0009). Feeds the CRM contacts export (aggregateDonorContacts): only online
// (wompi_event_id NOT NULL), accepted donations, enriched with the intent's
// contact fields. The (issued_at, id) cursor bounds each page so a busy
// environment is read in fixed chunks, mirroring the annual-certificate paging.
export async function listAcceptedWompiContactRows(
  db: D1Database,
  environment: Ambiente,
  cursor: { issuedAt: string; id: string } | null,
  limit: number,
  window?: { startIso: string; endIso: string }
): Promise<ContactSourceRow[]> {
  const conditions = [
    "dte_documents.status = 'ACCEPTED'",
    "dte_documents.fiscal_operation_claim_id IS NULL",
    "dte_documents.wompi_event_id IS NOT NULL",
    "dte_documents.environment = ?",
    "dte_documents.issued_at >= ?"
  ];
  // Lower bound is always present: "" (matches everything) when no window is given,
  // else the window start. The optional upper bound is added only when windowed, so
  // the unfiltered export keeps its original single-bound query shape.
  const bindings: Array<string | number> = [environment, window ? window.startIso : ""];
  if (window) {
    conditions.push("dte_documents.issued_at < ?");
    bindings.push(window.endIso);
  }
  if (cursor) {
    conditions.push("(dte_documents.issued_at, dte_documents.id) > (?, ?)");
    bindings.push(cursor.issuedAt, cursor.id);
  }
  const rows = await db
    .prepare(
      `SELECT dte_documents.id AS id,
              dte_documents.donor_email AS donor_email,
              dte_documents.donor_name AS donor_name,
              dte_documents.amount_cents AS amount_cents,
              dte_documents.issued_at AS issued_at,
              donation_intents.donor_phone AS intent_donor_phone,
              donation_intents.direccion_complemento AS intent_direccion_complemento,
              donation_intents.direccion_departamento AS intent_direccion_departamento,
              donation_intents.donor_pais AS intent_donor_pais,
              donation_intents.gift_type AS intent_gift_type,
              donation_intents.created_at AS intent_created_at
       FROM dte_documents
       LEFT JOIN donation_intents
         ON donation_intents.document_id = dte_documents.id AND donation_intents.status = 'COMPLETED'
       WHERE ${conditions.join(" AND ")}
       ORDER BY dte_documents.issued_at ASC, dte_documents.id ASC
       LIMIT ?`
    )
    .bind(...bindings, limit)
    .all<ContactSourceRowRow>();
  return (rows.results ?? []).map(mapContactSourceRow);
}

export async function listStalledApprovedWompiEvents(
  db: D1Database,
  cutoffIso: string
): Promise<Array<Record<string, unknown>>> {
  // wompi_events has no created_at column — it records received_at (migrations/0001_init.sql).
  const rows = await db
    .prepare(
      `SELECT id, transaction_id, environment, received_at, issuance_attempt_id, issuance_last_attempt_at FROM wompi_events
       WHERE created_document_id IS NULL
         AND result = 'ExitosaAprobada'
         AND NOT EXISTS (
           SELECT 1
             FROM fiscal_corrections
            WHERE target_kind = 'WOMPI_EVENT'
              AND wompi_event_id = wompi_events.id
              AND (
                status IN ('QUEUED', 'PROCESSING', 'REVIEW_REQUIRED', 'ACCEPTED')
                OR (
                  issuance_attempt_id IS NOT NULL
                  AND issuance_attempt_id = wompi_events.issuance_attempt_id
                )
              )
         )
         AND (
           (
             processed_at IS NULL
             AND issuance_status IS NULL
             AND received_at < ?
           )
           OR (
             processed_at IS NULL
             AND
             issuance_status IN ('RETRY_QUEUED', 'PROCESSING')
             AND COALESCE(issuance_last_attempt_at, received_at) < ?
           )
         )`
    )
    .bind(cutoffIso, cutoffIso)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

export async function countAuditEntries(
  db: D1Database,
  action: string,
  entityId: string
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = ? AND entity_id = ?")
    .bind(action, entityId)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

// Windowed variant for the auth rate limiter: counts (action, entity_id) audits
// whose created_at is at or after `sinceIso`. Reads use the (action, entity_id,
// created_at) index added in migration 0008.
export async function countAuditEntriesSince(
  db: D1Database,
  action: string,
  entityId: string,
  sinceIso: string
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = ? AND entity_id = ? AND created_at >= ?")
    .bind(action, entityId, sinceIso)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

// Same rolling-window count as above, but additionally scoped to the caller's IP
// (null-safe via IS). Used by the login throttle so an attacker cannot lock out a
// victim's email by seeding failures from a different address.
export async function countAuditEntriesSinceForIp(
  db: D1Database,
  action: string,
  entityId: string,
  actorIp: string | null,
  sinceIso: string
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = ? AND entity_id = ? AND created_at >= ? AND actor_ip IS ?")
    .bind(action, entityId, sinceIso, actorIp)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

// Paged reads for the monthly legal-retention export (Task 1). Each call reads at
// most `limit` rows via a (timestamp, id) keyset cursor so a month with more rows
// than fit in memory at once is still read in bounded chunks — never an unpaged
// full-table scan. `cursor` is the (timestamp, id) of the last row from the
// previous page, or null for the first page. Mutable wompi_events are intentionally
// excluded from this received-month path and exported as a full snapshot below.
export async function listRowsCreatedBetween(
  db: D1Database,
  table: RetentionTable,
  range: { startIso: string; endIso: string },
  cursor: RetentionCursor | null,
  limit: number
): Promise<Array<Record<string, unknown>>> {
  const column = "created_at";
  const conditions = [`${column} >= ?`, `${column} < ?`];
  const bindings: Array<string | number> = [range.startIso, range.endIso];
  if (cursor) {
    conditions.push(`(${column}, id) > (?, ?)`);
    bindings.push(cursor.createdAt, cursor.id);
  }
  const rows = await db
    .prepare(`SELECT * FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY ${column} ASC, id ASC LIMIT ?`)
    .bind(...bindings, limit)
    .all<Record<string, unknown>>();
  const results = rows.results ?? [];
  return table === "audit_logs" ? redactSensitiveAuditRows(results) : results;
}

// Full-snapshot paged reads for mutable Wompi lifecycle state and the small
// contingency tables. Wompi has received_at rather than created_at, but retains
// the same bounded (timestamp, id) cursor shape.
export async function listAllRowsPaged(
  db: D1Database,
  table: RetentionSnapshotTable,
  cursor: RetentionCursor | null,
  limit: number
): Promise<Array<Record<string, unknown>>> {
  const column = retentionSnapshotTimestampColumn(table);
  const conditions: string[] = [];
  const bindings: Array<string | number> = [];
  if (cursor) {
    conditions.push(`(${column}, id) > (?, ?)`);
    bindings.push(cursor.createdAt, cursor.id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await db
    .prepare(`SELECT * FROM ${table} ${where} ORDER BY ${column} ASC, id ASC LIMIT ?`)
    .bind(...bindings, limit)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}

export async function listDocumentSequencesPaged(
  db: D1Database,
  cursor: DocumentSequenceRetentionCursor | null,
  limit: number
): Promise<Array<Record<string, unknown>>> {
  const conditions: string[] = [];
  const bindings: Array<string | number> = [];
  if (cursor) {
    conditions.push("(environment, control_prefix) > (?, ?)");
    bindings.push(cursor.environment, cursor.controlPrefix);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const rows = await db
    .prepare(
      `SELECT environment, control_prefix, next_value
       FROM document_sequences ${where}
       ORDER BY environment ASC, control_prefix ASC LIMIT ?`
    )
    .bind(...bindings, limit)
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}
