import type { Ambiente, DteDocumentRecord } from "../../types";
import { nowIso } from "../../utils/dates";
import { newId, normalizeControlPrefix } from "../../utils/ids";

export interface DteDocumentListPage {
  documents: DteDocumentRecord[];
  hasMore: boolean;
  nextCursor: string | null;
  limit: number;
}

interface DteDocumentCursor {
  createdAt: string;
  id: string;
}

export interface DteDocumentHost {
  getDteDocument(id: string): Promise<DteDocumentRecord | null>;
  indexDteDocumentById(id: string): Promise<void>;
  indexDteDocument(record: DteDocumentRecord): Promise<void>;
}

const POST_ACCEPT_FINALIZATION_STALE_MS = 15 * 60 * 1000;
const POST_ACCEPT_FINALIZATION_CLAIMABLE_PREDICATE = `(
  post_accept_finalization_claim_id IS NULL
  OR (
    post_accept_finalization_claimed_at < ?
    AND (
      donor_email IS NULL
      OR post_accept_email_dispatch_started_at IS NULL
      OR EXISTS (
        SELECT 1 FROM email_deliveries
         WHERE document_id = dte_documents.id
           AND email_type = 'dteReceipt' AND status IN ('SENT', 'FAILED')
           AND document_status_at_send = 'ACCEPTED'
      )
    )
  )
)`;

export async function nextControlSequence(
  db: D1Database,
  environment: Ambiente,
  controlPrefix: string
): Promise<number> {
  const normalizedPrefix = normalizeControlPrefix(controlPrefix);
  await db
    .prepare("INSERT OR IGNORE INTO document_sequences (environment, control_prefix, next_value) VALUES (?, ?, 1)")
    .bind(environment, normalizedPrefix)
    .run();
  const row = await db
    .prepare("UPDATE document_sequences SET next_value = next_value + 1 WHERE environment = ? AND control_prefix = ? RETURNING next_value - 1 AS value")
    .bind(environment, normalizedPrefix)
    .first<{ value: number }>();
  if (!row) {
    throw new Error("No se pudo asignar la secuencia de control");
  }
  return row.value;
}

export async function createDteDocument(
  db: D1Database,
  host: DteDocumentHost,
  input: {
    wompiEventId?: string | null;
    environment: Ambiente;
    codigoGeneracion: string;
    numeroControl: string;
    plainJson: Record<string, unknown>;
    donorEmail: string | null;
    donorName: string | null;
    amountCents: number;
    issuedAt: string;
    status?: string;
    contingencyPeriodId?: string | null;
  }
): Promise<DteDocumentRecord> {
  const id = newId("dte");
  const insert = db
    .prepare(
      `INSERT INTO dte_documents (
          id, wompi_event_id, environment, codigo_generacion, numero_control, status, plain_json,
          donor_email, donor_name, amount_cents, issued_at, contingency_period_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.wompiEventId ?? null,
      input.environment,
      input.codigoGeneracion,
      input.numeroControl,
      input.status ?? "PENDING",
      JSON.stringify(input.plainJson),
      input.donorEmail,
      input.donorName,
      input.amountCents,
      input.issuedAt,
      input.contingencyPeriodId ?? null
    );
  if (input.wompiEventId) {
    await db.batch([
      insert,
      wompiDocumentCreatedStatement(db, input.wompiEventId, id, nowIso())
    ]);
  } else {
    await insert.run();
  }
  const record = await host.getDteDocument(id);
  if (!record) {
    throw new Error("No se pudo leer el documento DTE creado");
  }
  await host.indexDteDocument(record);
  return record;
}

export async function createClaimedWompiDteDocument(
  db: D1Database,
  host: DteDocumentHost,
  input: {
    wompiEventId: string;
    issuanceClaimId: string;
    environment: Ambiente;
    codigoGeneracion: string;
    numeroControl: string;
    plainJson: Record<string, unknown>;
    donorEmail: string | null;
    donorName: string | null;
    amountCents: number;
    issuedAt: string;
  }
): Promise<DteDocumentRecord | null> {
  const id = newId("dte");
  const processedAt = nowIso();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE wompi_events
              SET created_document_id = ?, processed_at = ?,
                  issuance_status = 'DOCUMENT_CREATED',
                  issuance_claim_id = NULL, issuance_claimed_at = NULL
            WHERE id = ? AND issuance_claim_id = ?
              AND processed_at IS NULL AND created_document_id IS NULL`
      )
      .bind(id, processedAt, input.wompiEventId, input.issuanceClaimId),
    db
      .prepare(
        `INSERT INTO dte_documents (
             id, wompi_event_id, environment, codigo_generacion, numero_control, status,
             plain_json, donor_email, donor_name, amount_cents, issued_at, contingency_period_id
           )
           SELECT ?, id, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, NULL
             FROM wompi_events
            WHERE id = ? AND created_document_id = ? AND issuance_claim_id IS NULL`
      )
      .bind(
        id,
        input.environment,
        input.codigoGeneracion,
        input.numeroControl,
        JSON.stringify(input.plainJson),
        input.donorEmail,
        input.donorName,
        input.amountCents,
        input.issuedAt,
        input.wompiEventId,
        id
      )
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1 || Number(results[1]?.meta?.changes ?? 0) !== 1) {
    return null;
  }
  const record = await host.getDteDocument(id);
  if (!record) {
    throw new Error("No se pudo leer el documento DTE Wompi creado");
  }
  await host.indexDteDocument(record);
  return record;
}

export async function markWompiDocumentCreated(
  db: D1Database,
  wompiEventId: string,
  documentId: string
): Promise<void> {
  await wompiDocumentCreatedStatement(db, wompiEventId, documentId, nowIso()).run();
}

function wompiDocumentCreatedStatement(
  db: D1Database,
  wompiEventId: string,
  documentId: string,
  processedAt: string
) {
  return db
    .prepare(
      `UPDATE wompi_events
         SET created_document_id = ?,
             processed_at = ?,
             issuance_status = 'DOCUMENT_CREATED'
         WHERE id = ?`
    )
    .bind(documentId, processedAt, wompiEventId);
}

export async function markWompiEventProcessed(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE wompi_events SET processed_at = ? WHERE id = ? AND processed_at IS NULL").bind(nowIso(), id).run();
}

export async function quarantineWompiIntentBinding(
  db: D1Database,
  input: {
    wompiEventId: string;
    intentId: string;
    reason: string;
    expectedLinkId: number | null;
    payloadLinkId: number | null;
  }
): Promise<void> {
  const auditId = `audit_binding_rejected_${input.wompiEventId}`;
  const summary = `La vinculación con la intención ${input.intentId} fue rechazada`;
  const metadataJson = JSON.stringify({
    intentId: input.intentId,
    reason: input.reason,
    expectedLinkId: input.expectedLinkId,
    payloadLinkId: input.payloadLinkId
  });
  const processedAt = nowIso();

  // D1 batch is transactional. The deterministic audit PK closes concurrent insert
  // races, while NOT EXISTS also preserves any audit written by the older random-ID
  // path. Both statements are guarded so an already-processed event gains no late
  // audit, and processed_at advances only when the binding-rejected audit exists.
  await db.batch([
    db
      .prepare(
        `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id,
             summary, metadata_json, actor_ip, actor_context
           )
           SELECT ?, 'SYSTEM', NULL, 'DONATION_INTENT_BINDING_REJECTED',
                  'wompi_event', ?, ?, ?, NULL, NULL
            WHERE EXISTS (
              SELECT 1 FROM wompi_events
               WHERE id = ? AND processed_at IS NULL
            )
              AND NOT EXISTS (
                SELECT 1 FROM audit_logs
                 WHERE action = 'DONATION_INTENT_BINDING_REJECTED'
                   AND entity_id = ?
              )
           ON CONFLICT(id) DO NOTHING`
      )
      .bind(
        auditId,
        input.wompiEventId,
        summary,
        metadataJson,
        input.wompiEventId,
        input.wompiEventId
      ),
    db
      .prepare(
        `UPDATE wompi_events
              SET processed_at = ?
            WHERE id = ?
              AND processed_at IS NULL
              AND EXISTS (
                SELECT 1 FROM audit_logs
                 WHERE action = 'DONATION_INTENT_BINDING_REJECTED'
                   AND entity_id = ?
              )`
      )
      .bind(processedAt, input.wompiEventId, input.wompiEventId)
  ]);
}

export async function getDteDocument(
  db: D1Database,
  id: string
): Promise<DteDocumentRecord | null> {
  return db.prepare("SELECT * FROM dte_documents WHERE id = ?").bind(id).first<DteDocumentRecord>();
}

export async function getDteDocumentByWompiEvent(
  db: D1Database,
  id: string
): Promise<DteDocumentRecord | null> {
  return db.prepare("SELECT * FROM dte_documents WHERE wompi_event_id = ?").bind(id).first<DteDocumentRecord>();
}

export async function listDteDocuments(
  db: D1Database,
  params: {
    status?: string | null;
    attention?: "failures" | null;
    q?: string | null;
    limit?: number;
    cursor?: string | null;
  } = {}
): Promise<DteDocumentListPage> {
  const limit = normalizeDocumentListLimit(params.limit);
  const filters: string[] = [];
  const bindings: Array<string | number> = [];
  if (params.attention === "failures") {
    filters.push(`(
        dte_documents.status IN ('FAILED', 'REJECTED')
        OR (
          dte_documents.status = 'ACCEPTED'
          AND (
            latest_receipt.status = 'FAILED'
            OR (
              latest_receipt.status = 'PENDING'
              AND latest_receipt.provider_dispatch_started_at IS NOT NULL
            )
          )
        )
        OR (
          dte_documents.status IN (
            'PENDING', 'SIGNED', 'CONTINGENCY_PENDING'
          )
          AND dte_documents.fiscal_operation_kind = 'TRANSMISSION'
          AND dte_documents.fiscal_operation_event_id IS NULL
          AND EXISTS (
            SELECT 1
              FROM fiscal_corrections
             WHERE fiscal_corrections.target_kind = 'WOMPI_EVENT'
               AND fiscal_corrections.wompi_event_id =
                   dte_documents.wompi_event_id
               AND fiscal_corrections.status = 'FAILED'
               AND dte_documents.fiscal_operation_claim_id =
                   'fiscal_correction_' || fiscal_corrections.id
          )
        )
      )`);
  } else if (params.status === "TRANSMISSION_PENDING") {
    // Estado VIRTUAL "En trámite": transmisión diferida = SIGNED + marcador. No es
    // un valor real de dte_documents.status (el CHECK no se pudo ampliar en D1);
    // un SIGNED transitorio de pipeline (sin marcador) queda fuera a propósito.
    filters.push("dte_documents.status = 'SIGNED' AND dte_documents.transmission_deferred_at IS NOT NULL");
  } else if (params.status) {
    // Accept a comma-separated status list (e.g. the Fallos view's "FAILED,REJECTED")
    // as a multi-status IN filter, while a single status keeps the equality clause.
    const statuses = params.status.split(",").map((status) => status.trim()).filter(Boolean);
    if (statuses.length === 1) {
      filters.push("dte_documents.status = ?");
      bindings.push(statuses[0]);
    } else if (statuses.length > 1) {
      filters.push(`dte_documents.status IN (${statuses.map(() => "?").join(", ")})`);
      bindings.push(...statuses);
    }
  }
  const ftsQuery = buildDteSearchQuery(params.q);
  if (ftsQuery) {
    filters.push("dte_document_search MATCH ?");
    bindings.push(ftsQuery);
  }
  const cursor = parseDocumentCursor(params.cursor);
  if (cursor) {
    filters.push("(dte_documents.created_at < ? OR (dte_documents.created_at = ? AND dte_documents.id < ?))");
    bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const searchJoin = ftsQuery
    ? "JOIN dte_document_search ON dte_document_search.document_id = dte_documents.id"
    : "";
  const receiptProjection = `latest_receipt.status AS receipt_email_status,
             latest_receipt.outcome_class AS receipt_email_outcome_class,
             latest_receipt.failure_code AS receipt_email_failure_code,
             latest_receipt.retry_safe AS receipt_email_retry_safe,
             CASE
               WHEN latest_receipt.status = 'PENDING'
                AND latest_receipt.provider_dispatch_started_at IS NOT NULL
               THEN 1
               WHEN latest_receipt.status = 'FAILED'
                AND (
                  latest_receipt.outcome_class IS NULL
                  OR latest_receipt.outcome_class = 'UNKNOWN'
                )
               THEN 1
               ELSE 0
             END AS receipt_email_requires_review`;
  const sql = params.attention === "failures"
    ? `WITH latest_receipt AS (
          SELECT document_id,
                 status,
                 outcome_class,
                 failure_code,
                 retry_safe,
                 provider_dispatch_started_at,
                 ROW_NUMBER() OVER (
                   PARTITION BY document_id
                   ORDER BY attempt_no DESC,
                            COALESCE(finalized_at, claim_attempted_at, created_at) DESC,
                            created_at DESC,
                            id DESC
                 ) AS row_num
            FROM email_deliveries
           WHERE email_type IN ('dteReceipt', 'dteReceiptTransitorio')
        )
        SELECT dte_documents.*,
               ${receiptProjection}
          FROM dte_documents
          LEFT JOIN latest_receipt
            ON latest_receipt.document_id = dte_documents.id
           AND latest_receipt.row_num = 1
          ${searchJoin}
          ${where}
         ORDER BY dte_documents.created_at DESC, dte_documents.id DESC
         LIMIT ?`
    : `WITH page_documents AS MATERIALIZED (
          SELECT dte_documents.*
            FROM dte_documents
            ${searchJoin}
            ${where}
           ORDER BY dte_documents.created_at DESC, dte_documents.id DESC
           LIMIT ?
        )
        SELECT page_documents.*,
               ${receiptProjection}
          FROM page_documents
          LEFT JOIN email_deliveries AS latest_receipt
            ON latest_receipt.id = (
              SELECT receipt_candidate.id
                FROM email_deliveries AS receipt_candidate
               WHERE receipt_candidate.document_id = page_documents.id
                 AND receipt_candidate.email_type IN ('dteReceipt', 'dteReceiptTransitorio')
               ORDER BY receipt_candidate.attempt_no DESC,
                        COALESCE(
                          receipt_candidate.finalized_at,
                          receipt_candidate.claim_attempted_at,
                          receipt_candidate.created_at
                        ) DESC,
                        receipt_candidate.created_at DESC,
                        receipt_candidate.id DESC
               LIMIT 1
            )
         ORDER BY page_documents.created_at DESC, page_documents.id DESC`;
  const rows = await db
    .prepare(sql)
    .bind(...bindings, limit + 1)
    .all<DteDocumentRecord>()
    .then((result) => result.results ?? []);
  const documents = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  return {
    documents,
    hasMore,
    nextCursor: hasMore && documents.length > 0 ? encodeDocumentCursor(documents[documents.length - 1]) : null,
    limit
  };
}

export async function updateDocumentSigned(
  db: D1Database,
  id: string,
  signedJws: string,
  expectedStatus: string
): Promise<boolean> {
  const updated = await db
    .prepare(
      "UPDATE dte_documents SET signed_jws = ?, status = 'SIGNED', updated_at = ? " +
        "WHERE id = ? AND status = ? AND fiscal_operation_claim_id IS NULL RETURNING id"
    )
    .bind(signedJws, nowIso(), id, expectedStatus)
    .first<{ id: string }>();
  return Boolean(updated);
}

export async function updateClaimedDocumentSigned(
  db: D1Database,
  id: string,
  signedJws: string,
  expectedStatus: string,
  claimId: string
): Promise<boolean> {
  const updated = await db.prepare(
    `UPDATE dte_documents
          SET signed_jws = ?, status = 'SIGNED', updated_at = ?
        WHERE id = ?
          AND status = ?
          AND fiscal_operation_claim_id = ?
          AND fiscal_operation_kind = 'TRANSMISSION'
          AND fiscal_operation_event_id IS NULL
        RETURNING id`
  ).bind(
    signedJws,
    nowIso(),
    id,
    expectedStatus,
    claimId
  ).first<{ id: string }>();
  return Boolean(updated);
}

export async function claimDocumentTransmission(
  db: D1Database,
  id: string,
  expectedStatus: string,
  signedJws: string,
  claimId: string
): Promise<boolean> {
  const claimedAt = nowIso();
  const row = await db
    .prepare(
      `UPDATE dte_documents
         SET status = 'SIGNED', fiscal_operation_claim_id = ?, fiscal_operation_claimed_at = ?,
             fiscal_operation_kind = 'TRANSMISSION', fiscal_operation_event_id = NULL,
             post_accept_finalized_at = NULL, updated_at = ?
         WHERE id = ? AND status = ? AND signed_jws = ?
           AND fiscal_operation_claim_id IS NULL
           AND NOT EXISTS (
             SELECT 1
               FROM fiscal_corrections
              WHERE dte_documents.wompi_event_id IS NOT NULL
                AND target_kind = 'WOMPI_EVENT'
                AND wompi_event_id = dte_documents.wompi_event_id
                AND status IN ('QUEUED', 'PROCESSING', 'REVIEW_REQUIRED')
                AND ? <> 'fiscal_correction_' || fiscal_corrections.id
           )
         RETURNING id`
    )
    .bind(claimId, claimedAt, claimedAt, id, expectedStatus, signedJws, claimId)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function claimDocumentInvalidation(
  db: D1Database,
  id: string,
  claimId: string
): Promise<boolean> {
  const claimedAt = nowIso();
  const row = await db
    .prepare(
      `UPDATE dte_documents
         SET fiscal_operation_claim_id = ?, fiscal_operation_claimed_at = ?,
             fiscal_operation_kind = 'INVALIDATION', fiscal_operation_event_id = NULL,
             updated_at = ?
         WHERE id = ? AND status = 'ACCEPTED'
           AND sello_recibido IS NOT NULL AND accepted_at IS NOT NULL
           AND post_accept_finalized_at IS NOT NULL
           AND fiscal_operation_claim_id IS NULL
         RETURNING id`
    )
    .bind(claimId, claimedAt, claimedAt, id)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function createAndAttachDocumentInvalidationEvent(
  db: D1Database,
  input: {
    documentId: string;
    claimId: string;
    environment: Ambiente;
    codigoGeneracion: string;
    plainJson: Record<string, unknown>;
    signedJws: string;
    legalDeadlineAt: string;
    createdBy: string;
  }
): Promise<string> {
  const eventId = newId("event");
  const updatedAt = nowIso();
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO dte_events (
             id, document_id, event_type, environment, codigo_generacion,
             status, plain_json, signed_jws, legal_deadline_at, created_by
           )
           SELECT ?, id, 'INVALIDACION', ?, ?, 'SIGNED', ?, ?, ?, ?
             FROM dte_documents
            WHERE id = ? AND status = 'ACCEPTED'
              AND fiscal_operation_claim_id = ?
              AND fiscal_operation_kind = 'INVALIDATION'
              AND fiscal_operation_event_id IS NULL`
      )
      .bind(
        eventId,
        input.environment,
        input.codigoGeneracion,
        JSON.stringify(input.plainJson),
        input.signedJws,
        input.legalDeadlineAt,
        input.createdBy,
        input.documentId,
        input.claimId
      ),
    db
      .prepare(
        `UPDATE dte_documents
              SET fiscal_operation_event_id = ?, updated_at = ?
            WHERE id = ? AND status = 'ACCEPTED'
              AND fiscal_operation_claim_id = ?
              AND fiscal_operation_kind = 'INVALIDATION'
              AND fiscal_operation_event_id IS NULL
              AND EXISTS (
                SELECT 1 FROM dte_events
                 WHERE id = ? AND document_id = dte_documents.id
                   AND event_type = 'INVALIDACION' AND status = 'SIGNED'
              )`
      )
      .bind(eventId, updatedAt, input.documentId, input.claimId, eventId)
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1 || Number(results[1]?.meta?.changes ?? 0) !== 1) {
    throw new Error("La invalidación no pudo crear y vincular su evento bajo el mismo reclamo fiscal");
  }
  return eventId;
}

export async function releaseDocumentInvalidationBeforeDispatch(
  db: D1Database,
  documentId: string,
  claimId: string,
  eventId: string,
  reason: string
): Promise<boolean> {
  const updatedAt = nowIso();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE dte_events
              SET status = 'FAILED', sello_recibido = NULL,
                  mh_estado = 'PRE_DISPATCH_FAILED', mh_observaciones_json = ?,
                  accepted_at = NULL
            WHERE id = ? AND document_id = ?
              AND event_type = 'INVALIDACION' AND status = 'SIGNED'
              AND EXISTS (
                SELECT 1 FROM dte_documents
                 WHERE id = ? AND status = 'ACCEPTED'
                   AND fiscal_operation_claim_id = ?
                   AND fiscal_operation_kind = 'INVALIDATION'
                   AND fiscal_operation_event_id = ?
              )`
      )
      .bind(JSON.stringify([reason]), eventId, documentId, documentId, claimId, eventId),
    db
      .prepare(
        `UPDATE dte_documents
              SET fiscal_operation_claim_id = NULL,
                  fiscal_operation_claimed_at = NULL,
                  fiscal_operation_kind = NULL,
                  fiscal_operation_event_id = NULL,
                  updated_at = ?
            WHERE id = ? AND status = 'ACCEPTED'
              AND fiscal_operation_claim_id = ?
              AND fiscal_operation_kind = 'INVALIDATION'
              AND fiscal_operation_event_id = ?
              AND EXISTS (
                SELECT 1 FROM dte_events
                 WHERE id = ? AND document_id = dte_documents.id
                   AND event_type = 'INVALIDACION' AND status = 'FAILED'
                   AND mh_estado = 'PRE_DISPATCH_FAILED'
              )`
      )
      .bind(updatedAt, documentId, claimId, eventId, eventId)
  ]);
  return Number(results[0]?.meta?.changes ?? 0) === 1 && Number(results[1]?.meta?.changes ?? 0) === 1;
}

export async function completeDocumentInvalidation(
  db: D1Database,
  input: {
    documentId: string;
    claimId: string;
    eventId: string;
    accepted: boolean;
    sello: string | null;
    mhEstado: string;
    observaciones: string[];
    acceptedAt: string | null;
    actorId: string;
    raw: unknown;
  }
): Promise<boolean> {
  const eventStatus = input.accepted ? "ACCEPTED" : "REJECTED";
  const documentStatus = input.accepted ? "INVALIDATED" : "ACCEPTED";
  const auditAction = input.accepted ? "DTE_INVALIDATED" : "DTE_INVALIDATION_REJECTED";
  const updatedAt = nowIso();
  const auditId = `audit_invalidation_${input.eventId}`;
  const results = await db.batch([
    db
      .prepare(
        `UPDATE dte_events
              SET status = ?, sello_recibido = ?, mh_estado = ?,
                  mh_observaciones_json = ?, accepted_at = ?
            WHERE id = ? AND document_id = ?
              AND event_type = 'INVALIDACION' AND status = 'SIGNED'
              AND EXISTS (
                SELECT 1 FROM dte_documents
                 WHERE id = ? AND status = 'ACCEPTED'
                   AND fiscal_operation_claim_id = ?
                   AND fiscal_operation_kind = 'INVALIDATION'
                   AND fiscal_operation_event_id = ?
              )`
      )
      .bind(
        eventStatus,
        input.sello,
        input.mhEstado,
        JSON.stringify(input.observaciones),
        input.acceptedAt,
        input.eventId,
        input.documentId,
        input.documentId,
        input.claimId,
        input.eventId
      ),
    db
      .prepare(
        `UPDATE dte_documents
              SET status = ?, fiscal_operation_claim_id = NULL,
                  fiscal_operation_claimed_at = NULL,
                  fiscal_operation_kind = NULL,
                  fiscal_operation_event_id = NULL,
                  updated_at = ?
            WHERE id = ? AND status = 'ACCEPTED'
              AND fiscal_operation_claim_id = ?
              AND fiscal_operation_kind = 'INVALIDATION'
              AND fiscal_operation_event_id = ?
              AND EXISTS (
                SELECT 1 FROM dte_events
                 WHERE id = ? AND document_id = dte_documents.id
                   AND event_type = 'INVALIDACION' AND status = ?
              )`
      )
      .bind(documentStatus, updatedAt, input.documentId, input.claimId, input.eventId, input.eventId, eventStatus),
    db
      .prepare(
        `INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id,
             summary, metadata_json
           )
           SELECT ?, 'USER', ?, ?, 'dte_document', ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM dte_events
               WHERE id = ? AND document_id = ?
                 AND event_type = 'INVALIDACION' AND status = ?
            )
              AND EXISTS (
                SELECT 1 FROM dte_documents
                 WHERE id = ? AND status = ?
                   AND fiscal_operation_claim_id IS NULL
              )
           ON CONFLICT(id) DO NOTHING`
      )
      .bind(
        auditId,
        input.actorId,
        auditAction,
        input.documentId,
        input.mhEstado,
        JSON.stringify(input.raw ?? {}),
        input.eventId,
        input.documentId,
        eventStatus,
        input.documentId,
        documentStatus
      )
  ]);
  return Number(results[0]?.meta?.changes ?? 0) === 1 && Number(results[1]?.meta?.changes ?? 0) === 1;
}

export async function completeDocumentTransmission(
  db: D1Database,
  id: string,
  claimId: string,
  result: {
    status: "ACCEPTED" | "REJECTED";
    sello: string | null;
    mhEstado: string;
    observaciones: string[];
    acceptedAt: string | null;
  }
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE dte_documents
         SET status = ?, sello_recibido = ?, mh_estado = ?, mh_observaciones_json = ?, accepted_at = ?,
             fiscal_operation_claim_id = NULL, fiscal_operation_claimed_at = NULL,
             fiscal_operation_kind = NULL, fiscal_operation_event_id = NULL, updated_at = ?
         WHERE id = ? AND status = 'SIGNED' AND fiscal_operation_claim_id = ?
         RETURNING id`
    )
    .bind(result.status, result.sello, result.mhEstado, JSON.stringify(result.observaciones), result.acceptedAt, nowIso(), id, claimId)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function markDocumentFailed(
  db: D1Database,
  id: string,
  claimId: string | null,
  result: { mhEstado: string; observaciones: string[] }
): Promise<boolean> {
  const claimPredicate = claimId ? "fiscal_operation_claim_id = ?" : "fiscal_operation_claim_id IS NULL";
  const bindings: unknown[] = [result.mhEstado, JSON.stringify(result.observaciones), nowIso(), id];
  if (claimId) bindings.push(claimId);
  const row = await db
    .prepare(
      `UPDATE dte_documents
         SET status = 'FAILED', sello_recibido = NULL, mh_estado = ?, mh_observaciones_json = ?,
             fiscal_operation_claim_id = NULL, fiscal_operation_claimed_at = NULL,
             fiscal_operation_kind = NULL, fiscal_operation_event_id = NULL, updated_at = ?
         WHERE id = ? AND status NOT IN ('ACCEPTED', 'REJECTED', 'INVALIDATED')
           AND ${claimPredicate}
         RETURNING id`
    )
    .bind(...bindings)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function releaseDocumentFiscalOperation(
  db: D1Database,
  id: string,
  claimId: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE dte_documents
         SET fiscal_operation_claim_id = NULL, fiscal_operation_claimed_at = NULL,
             fiscal_operation_kind = NULL, fiscal_operation_event_id = NULL, updated_at = ?
         WHERE id = ? AND fiscal_operation_claim_id = ?
         RETURNING id`
    )
    .bind(nowIso(), id, claimId)
    .first<{ id: string }>();
  return Boolean(row);
}

// Marca un CDE como diferido: estado SIGNED + transmission_deferred_at (no hay un
// valor de status nuevo — dte_documents es padre de cuatro FKs y D1 no puede
// reconstruir la tabla para ampliar su CHECK). El marcador NO se limpia al resolver:
// queda como evidencia histórica ("estuvo diferido desde"), y es el status al salir
// de SIGNED (ACCEPTED/REJECTED) lo que retira al documento del barrido de reintento.
export async function markDocumentTransmissionDeferred(
  db: D1Database,
  id: string,
  claimId: string,
  reason: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE dte_documents
         SET status = 'SIGNED', transmission_deferred_at = ?, sello_recibido = NULL,
             mh_estado = ?, mh_observaciones_json = ?, fiscal_operation_claim_id = NULL,
             fiscal_operation_claimed_at = NULL, fiscal_operation_kind = NULL,
             fiscal_operation_event_id = NULL, updated_at = ?
         WHERE id = ? AND status = 'SIGNED' AND fiscal_operation_claim_id = ?
         RETURNING id`
    )
    .bind(nowIso(), "MH_NO_DISPONIBLE", JSON.stringify([reason]), nowIso(), id, claimId)
    .first<{ id: string }>();
  return Boolean(row);
}

// CDE con transmisión diferida (MH no disponible al emitir): el cron de 15 minutos
// los recupera en orden de emisión. Lee por el índice idx_dte_documents_status.
export async function listDeferredTransmissionDocuments(
  db: D1Database,
  limit = 100
): Promise<DteDocumentRecord[]> {
  return db
    .prepare("SELECT * FROM dte_documents WHERE status = ? AND transmission_deferred_at IS NOT NULL AND fiscal_operation_claim_id IS NULL ORDER BY created_at ASC LIMIT ?")
    .bind("SIGNED", Math.min(Math.max(Math.trunc(limit), 1), 500))
    .all<DteDocumentRecord>()
    .then((result) => result.results ?? []);
}

export async function listAcceptedWompiDocumentsMissingFinalization(
  db: D1Database,
  limit = 100
): Promise<DteDocumentRecord[]> {
  return db
    .prepare(
      `SELECT d.* FROM dte_documents d
         WHERE d.status = 'ACCEPTED'
           AND d.wompi_event_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM audit_logs a
             WHERE a.action = 'DTE_ACCEPTED_FINALIZED'
               AND a.entity_type = 'dte_document'
               AND a.entity_id = d.id
           )
         ORDER BY COALESCE(d.accepted_at, d.created_at) ASC, d.id ASC
         LIMIT ?`
    )
    .bind(Math.min(Math.max(Math.trunc(limit), 1), 500))
    .all<DteDocumentRecord>()
    .then((result) => result.results ?? []);
}

export async function listPendingPostAcceptFinalizations(
  db: D1Database,
  limit = 100
): Promise<DteDocumentRecord[]> {
  const staleBefore = new Date(Date.now() - POST_ACCEPT_FINALIZATION_STALE_MS).toISOString();
  return db
    .prepare(
      `SELECT * FROM dte_documents
         WHERE status = 'ACCEPTED' AND post_accept_finalized_at IS NULL
           AND fiscal_operation_claim_id IS NULL
           AND ${POST_ACCEPT_FINALIZATION_CLAIMABLE_PREDICATE}
         ORDER BY created_at ASC, id ASC LIMIT ?`
    )
    .bind(staleBefore, Math.min(Math.max(Math.trunc(limit), 1), 500))
    .all<DteDocumentRecord>()
    .then((result) => result.results ?? []);
}

export async function claimDocumentPostAcceptFinalization(
  db: D1Database,
  id: string,
  claimId: string
): Promise<boolean> {
  const claimedAt = nowIso();
  const staleBefore = new Date(Date.now() - POST_ACCEPT_FINALIZATION_STALE_MS).toISOString();
  const row = await db
    .prepare(
      `UPDATE dte_documents
            SET post_accept_finalization_claim_id = ?,
                post_accept_finalization_claimed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'ACCEPTED'
            AND post_accept_finalized_at IS NULL
            AND fiscal_operation_claim_id IS NULL
            AND ${POST_ACCEPT_FINALIZATION_CLAIMABLE_PREDICATE}
          RETURNING id`
    )
    .bind(claimId, claimedAt, claimedAt, id, staleBefore)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function markDocumentPostAcceptEmailDispatchStarted(
  db: D1Database,
  id: string,
  claimId: string
): Promise<boolean> {
  const startedAt = nowIso();
  const row = await db
    .prepare(
      `UPDATE dte_documents
            SET post_accept_email_dispatch_started_at = ?, updated_at = ?
          WHERE id = ? AND status = 'ACCEPTED'
            AND post_accept_finalized_at IS NULL
            AND post_accept_finalization_claim_id = ?
            AND post_accept_email_dispatch_started_at IS NULL
          RETURNING id`
    )
    .bind(startedAt, startedAt, id, claimId)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function releaseDocumentPostAcceptFinalization(
  db: D1Database,
  id: string,
  claimId: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `UPDATE dte_documents
            SET post_accept_finalization_claim_id = NULL,
                post_accept_finalization_claimed_at = NULL,
                post_accept_email_dispatch_started_at = NULL,
                updated_at = ?
          WHERE id = ? AND status = 'ACCEPTED'
            AND post_accept_finalized_at IS NULL
            AND post_accept_finalization_claim_id = ?
          RETURNING id`
    )
    .bind(nowIso(), id, claimId)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function markDocumentPostAcceptFinalized(
  db: D1Database,
  id: string,
  claimId: string
): Promise<boolean> {
  const finalizedAt = nowIso();
  const row = await db
    .prepare(
      `UPDATE dte_documents
         SET post_accept_finalized_at = ?,
             post_accept_finalization_claim_id = NULL,
             post_accept_finalization_claimed_at = NULL,
             post_accept_email_dispatch_started_at = NULL,
             updated_at = ?
         WHERE id = ? AND status = 'ACCEPTED'
           AND post_accept_finalized_at IS NULL
           AND fiscal_operation_claim_id IS NULL
           AND post_accept_finalization_claim_id = ?
         RETURNING id`
    )
    .bind(finalizedAt, finalizedAt, id, claimId)
    .first<{ id: string }>();
  return Boolean(row);
}

// Dedupe de evidencia de correo: ¿ya existe un envío SENT de este tipo para el
// documento? Evita que una reentrega de cola duplique el comprobante transitorio.
export async function hasSentEmail(
  db: D1Database,
  documentId: string,
  emailType: string
): Promise<boolean> {
  const row = await db
    .prepare("SELECT id FROM email_deliveries WHERE document_id = ? AND email_type = ? AND status = 'SENT' LIMIT 1")
    .bind(documentId, emailType)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function hasHandledEmail(
  db: D1Database,
  documentId: string,
  emailType: string,
  documentStatusAtSend: string
): Promise<boolean> {
  const row = await db
    .prepare(
      "SELECT id FROM email_deliveries WHERE document_id = ? AND email_type = ? AND status IN ('SENT', 'FAILED') AND document_status_at_send = ? LIMIT 1"
    )
    .bind(documentId, emailType, documentStatusAtSend)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function updateDocumentDonorEmail(
  db: D1Database,
  host: DteDocumentHost,
  id: string,
  email: string
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE dte_documents
            SET donor_email = ?, updated_at = ?
          WHERE id = ? AND post_accept_finalization_claim_id IS NULL`
    )
    .bind(email, nowIso(), id)
    .run();
  if (Number(result.meta?.changes ?? 0) !== 1) {
    return false;
  }
  await host.indexDteDocumentById(id);
  return true;
}

export async function indexDteDocumentById(
  host: DteDocumentHost,
  id: string
): Promise<void> {
  const record = await host.getDteDocument(id);
  if (record) {
    await host.indexDteDocument(record);
  }
}

export async function indexDteDocument(
  db: D1Database,
  record: DteDocumentRecord
): Promise<void> {
  await db.prepare("DELETE FROM dte_document_search WHERE document_id = ?").bind(record.id).run();
  await db
    .prepare(
      `INSERT INTO dte_document_search (
          document_id, codigo_generacion, codigo_generacion_compact, numero_control, numero_control_compact,
          numero_control_serial, donor_email, donor_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      record.id,
      record.codigo_generacion,
      compactSearchIdentifier(record.codigo_generacion),
      record.numero_control,
      compactSearchIdentifier(record.numero_control),
      controlSerial(record.numero_control),
      record.donor_email,
      record.donor_name
    )
    .run();
}

function normalizeDocumentListLimit(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return 50;
  }
  return Math.min(Math.trunc(value), 100);
}

function encodeDocumentCursor(record: DteDocumentRecord): string {
  return `${encodeURIComponent(record.created_at)}|${encodeURIComponent(record.id)}`;
}

function parseDocumentCursor(value: string | null | undefined): DteDocumentCursor | null {
  if (!value) {
    return null;
  }
  const parts = value.split("|");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return null;
  }
  try {
    return {
      createdAt: decodeURIComponent(parts[0]),
      id: decodeURIComponent(parts[1])
    };
  } catch {
    return null;
  }
}

function buildDteSearchQuery(value: string | null | undefined): string | null {
  const tokens = Array.from((value ?? "").toLowerCase().matchAll(/[\p{L}\p{N}]+/gu), (match) => match[0])
    .filter((token) => token.length > 0)
    .slice(0, 8)
    .map((token) => token.slice(0, 64));
  if (tokens.length === 0) {
    return null;
  }
  return tokens.map((token) => `${token}*`).join(" AND ");
}

function compactSearchIdentifier(value: string | null | undefined): string {
  return (value ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function controlSerial(value: string | null | undefined): string {
  const lastSegment = (value ?? "").split("-").at(-1) ?? "";
  return lastSegment.replace(/^0+/, "") || lastSegment || "";
}
