import type {
  Ambiente,
  DonationGiftType,
  DteDocumentRecord
} from "../../types";
import type { ContactSourceRow } from "../../services/contacts";
import { redactSensitiveAuditRows } from "../shared";
import { buildDteSearchQuery } from "./dteDocuments";

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
  "contingency_batch_lines",
  "stripe_checkout_sessions",
  "stripe_webhook_events",
  "stripe_gifts",
  "stripe_acknowledgment_deliveries",
  "stripe_annual_statement_deliveries"
] as const;
export type RetentionSnapshotTable = (typeof RETENTION_SNAPSHOT_TABLES)[number];

export const STRIPE_RETENTION_SNAPSHOT_TABLES = [
  "stripe_checkout_sessions",
  "stripe_webhook_events",
  "stripe_gifts",
  "stripe_acknowledgment_deliveries",
  "stripe_annual_statement_deliveries"
] as const;
export type StripeRetentionSnapshotTable = (typeof STRIPE_RETENTION_SNAPSHOT_TABLES)[number];
export interface StripeRetentionFence {
  maxGeneration: string;
}

export interface StripeRetentionCursor {
  generation: string;
}

export interface RetentionCursor {
  createdAt: string;
  id: string;
}

export interface DocumentSequenceRetentionCursor {
  environment: string;
  controlPrefix: string;
}

// The append-only AUTOINCREMENT ledger is shared by all five Stripe tables, so one
// scalar defines their membership boundary. TEXT preserves the full signed 64-bit
// value; SQLite compares the bound decimal without a JS precision loss.
export async function captureStripeRetentionFence(
  db: D1Database
): Promise<StripeRetentionFence> {
  const fence = await db.prepare(
    `SELECT COALESCE(CAST(MAX(generation) AS TEXT), '0') AS maxGeneration
       FROM stripe_retention_generations`
  ).first<{ maxGeneration: string }>();
  if (!fence || !/^(?:0|[1-9]\d*)$/.test(fence.maxGeneration)) {
    throw new Error("retention_stripe_fence_invalid");
  }
  return fence;
}

export interface AnnualCertificateDonorTarget {
  groupKey: string;
  donorName: string;
  donorEmail: string | null;
  count: number;
  totalCents: number;
  hasTestEnvironment: boolean;
}

interface AnnualCertificateDonorTargetRow {
  recipient_key: string;
  donor_name: string;
  donor_email: string | null;
  document_count: number;
  total_cents: number;
  has_test_environment: number;
}

function retentionSnapshotTimestampColumn(
  table: RetentionSnapshotTable
): "created_at" | "received_at" {
  return table === "wompi_events" || table === "stripe_webhook_events"
    ? "received_at"
    : "created_at";
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

// Bounded annual-certificate summary read. The caller supplies the number of rows it
// can display/process; this reader adds exactly one sentinel and never returns more
// than 51 preview summaries or 11 unsent-email summaries. Search chooses matching
// recipient keys through the existing FTS index, while `grouped` still aggregates
// every accepted annual row for each chosen recipient.
export async function listAnnualCertificateDonorTargets(
  db: D1Database,
  range: { startIso: string; endIso: string },
  options: {
    afterGroupKey: string | null;
    limit: number;
    search: string | null;
    unsentEmailOnly: boolean;
    year: number;
    groupKey?: string | null;
  }
): Promise<AnnualCertificateDonorTarget[]> {
  if (!Number.isFinite(options.limit) || !Number.isInteger(options.limit) || options.limit <= 0) {
    throw new RangeError("annual certificate target limit must be a positive finite integer");
  }
  const maximumPageSize = options.unsentEmailOnly ? 10 : 50;
  const pageSize = Math.min(options.limit, maximumPageSize);
  const ftsQuery = buildDteSearchQuery(options.search);
  const bindings: Array<string | number> = [range.startIso, range.endIso];
  const matchingCte = ftsQuery
    ? `,
       matching_recipient_keys AS (
         SELECT DISTINCT filtered.recipient_key
           FROM filtered
           JOIN dte_document_search
             ON dte_document_search.document_id = filtered.id
          WHERE dte_document_search MATCH ?
       )`
    : "";
  if (ftsQuery) {
    bindings.push(ftsQuery);
  }
  const groupedFilter = ftsQuery
    ? "WHERE ranked.recipient_key IN (SELECT recipient_key FROM matching_recipient_keys)"
    : "";
  const outerConditions: string[] = [];
  if (options.groupKey) {
    outerConditions.push("recipient_key = ?");
    bindings.push(options.groupKey);
  } else if (options.afterGroupKey) {
    outerConditions.push("recipient_key > ?");
    bindings.push(options.afterGroupKey);
  }
  if (options.unsentEmailOnly) {
    outerConditions.push("donor_email IS NOT NULL");
    outerConditions.push(
      `NOT EXISTS (
         SELECT 1
           FROM audit_logs
          WHERE audit_logs.action = 'DONOR_CERTIFICATE_SENT'
            AND audit_logs.entity_id = CAST(? AS TEXT) || ':' || grouped.donor_email
       )`
    );
    bindings.push(String(options.year));
  }
  const outerWhere = outerConditions.length ? `WHERE ${outerConditions.join(" AND ")}` : "";
  const rows = await db
    .prepare(
      `/* annual_certificate_targets */
       WITH filtered AS (
         SELECT id,
                environment,
                donor_email,
                donor_name,
                amount_cents,
                issued_at,
                COALESCE(NULLIF(TRIM(donor_email), ''), NULLIF(TRIM(donor_name), ''), '(sin identificar)') AS recipient_key
           FROM dte_documents
          WHERE status = 'ACCEPTED'
            AND fiscal_operation_claim_id IS NULL
            AND issued_at >= ?
            AND issued_at < ?
       ),
       ranked AS (
         SELECT filtered.*,
                ROW_NUMBER() OVER (
                  PARTITION BY recipient_key
                  ORDER BY issued_at ASC, id ASC
                ) AS recipient_row
           FROM filtered
       )
       ${matchingCte},
       grouped AS (
         SELECT ranked.recipient_key,
                MAX(CASE WHEN recipient_row = 1
                  THEN COALESCE(NULLIF(TRIM(donor_name), ''), NULLIF(TRIM(donor_email), ''), '(sin identificar)')
                  ELSE NULL END) AS donor_name,
                MAX(CASE WHEN recipient_row = 1
                  THEN NULLIF(TRIM(donor_email), '')
                  ELSE NULL END) AS donor_email,
                COUNT(*) AS document_count,
                SUM(amount_cents) AS total_cents,
                MAX(CASE WHEN environment = '00' THEN 1 ELSE 0 END) AS has_test_environment
           FROM ranked
           ${groupedFilter}
          GROUP BY ranked.recipient_key
       )
       SELECT recipient_key,
              donor_name,
              donor_email,
              document_count,
              total_cents,
              has_test_environment
         FROM grouped
         ${outerWhere}
        ORDER BY recipient_key ASC
        LIMIT ?`
    )
    .bind(...bindings, pageSize + 1)
    .all<AnnualCertificateDonorTargetRow>();
  return (rows.results ?? []).map((row) => ({
    groupKey: row.recipient_key,
    donorName: row.donor_name,
    donorEmail: row.donor_email,
    count: Number(row.document_count),
    totalCents: Number(row.total_cents),
    hasTestEnvironment: Number(row.has_test_environment) === 1
  }));
}

// Full records are needed only when rendering one dossier. The hard clamp keeps even
// accidental callers at the 25-document cap plus one sentinel.
export async function listAnnualCertificateDonorDocuments(
  db: D1Database,
  range: { startIso: string; endIso: string },
  groupKey: string,
  limit: number
): Promise<DteDocumentRecord[]> {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 26);
  const rows = await db
    .prepare(
      `/* annual_certificate_documents */
       SELECT *
         FROM dte_documents
        WHERE status = 'ACCEPTED'
          AND fiscal_operation_claim_id IS NULL
          AND issued_at >= ?
          AND issued_at < ?
          AND COALESCE(NULLIF(TRIM(donor_email), ''), NULLIF(TRIM(donor_name), ''), '(sin identificar)') = ?
        ORDER BY issued_at ASC, id ASC
        LIMIT ?`
    )
    .bind(range.startIso, range.endIso, groupKey, boundedLimit)
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
      `SELECT id, transaction_id, environment, received_at, issuance_attempt_id, issuance_last_attempt_at, stalled_requeue_epoch_at FROM wompi_events
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

// Wompi stalled-episode count. New audits carry their durable episode identity,
// so a frozen or regressing database clock cannot hide them. Legacy audits have
// no identity and use an exclusive timestamp boundary, keeping an audit written
// exactly at operator rotation in the prior episode.
export async function countAuditEntriesSince(
  db: D1Database,
  action: string,
  entityId: string,
  sinceIso: string
): Promise<number> {
  const row = await db
    .prepare(
      `WITH episode_audits AS (
         SELECT created_at,
                (
                  SELECT CASE WHEN episode_member.type = 'text'
                    THEN NULLIF(episode_member.value, '')
                    ELSE NULL
                  END
                    FROM json_each(
                      CASE WHEN json_valid(candidate_audit.metadata_json)
                        THEN candidate_audit.metadata_json
                        ELSE '{}'
                      END
                    ) AS episode_member
                   WHERE episode_member.parent IS NULL
                     AND episode_member.key = 'stalledRequeueEpochAt'
                   ORDER BY episode_member.id DESC
                   LIMIT 1
                ) AS episode_id
           FROM audit_logs AS candidate_audit
          WHERE candidate_audit.action = ?
            AND candidate_audit.entity_id = ?
       )
       SELECT COUNT(*) AS count
         FROM episode_audits
        WHERE episode_id = ?
           OR (episode_id IS NULL AND created_at > ?)`
    )
    .bind(action, entityId, sinceIso, sinceIso)
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
  cursor: RetentionCursor | StripeRetentionCursor | null,
  limit: number,
  stripeFence?: StripeRetentionFence
): Promise<Array<Record<string, unknown>>> {
  const column = retentionSnapshotTimestampColumn(table);
  const conditions: string[] = [];
  const bindings: Array<string | number> = [];
  const isStripeTable = STRIPE_RETENTION_SNAPSHOT_TABLES.includes(
    table as StripeRetentionSnapshotTable
  );
  const rowAlias = isStripeTable && stripeFence ? "snapshot" : null;
  if (rowAlias && stripeFence) {
    const stripeTable = table as StripeRetentionSnapshotTable;
    conditions.push(`retention_generation.table_name = '${stripeTable}'`);
    if (cursor && "generation" in cursor) {
      conditions.push(`retention_generation.generation > ?`);
      bindings.push(cursor.generation);
    }
    conditions.push(`retention_generation.generation <= ?`);
    bindings.push(stripeFence.maxGeneration);
    if (stripeTable === "stripe_gifts") {
      conditions.push(
        `(${rowAlias}.checkout_id IS NULL OR EXISTS (
          SELECT 1
            FROM stripe_checkout_sessions AS checkout_parent
            JOIN stripe_retention_generations AS checkout_generation
              ON checkout_generation.table_name = 'stripe_checkout_sessions'
             AND checkout_generation.row_id = checkout_parent.id
             AND checkout_generation.generation <= ?
           WHERE checkout_parent.id = ${rowAlias}.checkout_id
        ))`
      );
      bindings.push(stripeFence.maxGeneration);
    } else if (stripeTable === "stripe_acknowledgment_deliveries") {
      conditions.push(
        `EXISTS (
          SELECT 1
            FROM stripe_gifts AS gift_parent
            JOIN stripe_retention_generations AS gift_generation
              ON gift_generation.table_name = 'stripe_gifts'
             AND gift_generation.row_id = gift_parent.id
             AND gift_generation.generation <= ?
           WHERE gift_parent.id = ${rowAlias}.gift_id
             AND (gift_parent.checkout_id IS NULL OR EXISTS (
               SELECT 1
                 FROM stripe_checkout_sessions AS checkout_ancestor
                 JOIN stripe_retention_generations AS checkout_generation
                   ON checkout_generation.table_name = 'stripe_checkout_sessions'
                  AND checkout_generation.row_id = checkout_ancestor.id
                  AND checkout_generation.generation <= ?
                WHERE checkout_ancestor.id = gift_parent.checkout_id
             ))
        )`
      );
      bindings.push(
        stripeFence.maxGeneration,
        stripeFence.maxGeneration
      );
    } else if (stripeTable === "stripe_annual_statement_deliveries") {
      // Migration 0036 assigns every ancestor before its descendants. Migration 0034
      // prevents retargeting, while the FK prevents deleting/renaming a retained
      // parent. The indexed direct-parent check therefore proves the stable transitive
      // chain without a recursive CTE per exported row.
      conditions.push(
        `(${rowAlias}.supersedes_delivery_id IS NULL OR EXISTS (
          SELECT 1
            FROM stripe_retention_generations AS parent_generation
           WHERE parent_generation.table_name = 'stripe_annual_statement_deliveries'
             AND parent_generation.row_id = ${rowAlias}.supersedes_delivery_id
             AND parent_generation.generation <= ?
        ))`
      );
      bindings.push(stripeFence.maxGeneration);
    }
  }
  const columnReference = rowAlias ? `${rowAlias}.${column}` : column;
  const idReference = rowAlias ? `${rowAlias}.id` : "id";
  if (cursor && "createdAt" in cursor) {
    conditions.push(`(${columnReference}, ${idReference}) > (?, ?)`);
    bindings.push(cursor.createdAt, cursor.id);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const from = rowAlias
    ? `stripe_retention_generations AS retention_generation
         INDEXED BY idx_stripe_retention_generations_table_generation
       JOIN ${table} AS ${rowAlias}
         ON ${rowAlias}.id = retention_generation.row_id`
    : table;
  const selection = rowAlias
    ? `${rowAlias}.*,
       CAST(retention_generation.generation AS TEXT) AS __retention_generation`
    : "*";
  const orderBy = rowAlias
    ? "retention_generation.generation ASC"
    : `${columnReference} ASC, ${idReference} ASC`;
  const rows = await db
    .prepare(
      `SELECT ${selection} FROM ${from} ${where}
       ORDER BY ${orderBy} LIMIT ?`
    )
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
