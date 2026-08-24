import type {
  Ambiente,
  WompiDocumentIdentifiers,
  WompiEventRecord,
  WompiIssuanceFailureItem,
  WompiIssuanceRetrySnapshot,
  WompiWebhook
} from "../../types";
import {
  ambienteFromWompi,
  amountCents,
  donorName,
  isApprovedDonation,
  normalizeWompiWebhook
} from "../../domain/wompi";
import {
  normalizeAuditIp,
  serializeAuditContext,
  type AuditRequestContext
} from "../../services/requestContext";
import { nowIso } from "../../utils/dates";
import {
  generationCode,
  newId,
  normalizeControlPrefix,
  numeroControl
} from "../../utils/ids";
import type { Repository } from "../repository";

type WompiHost = Pick<
  Repository,
  "getWompiEventById" | "getWompiEventByTransaction" | "getWompiEventByPaymentLinkId"
>;

export type WompiEventConflictField =
  | "identity"
  | "environment"
  | "result"
  | "amount"
  | "payment_link"
  | "commerce_intent"
  | "normalized_body";

export type WompiEventInsertResult =
  | {
      kind: "inserted" | "equivalent_replay";
      record: WompiEventRecord;
      canonicalPayload: WompiWebhook;
    }
  | {
      kind: "conflict";
      record: WompiEventRecord;
      reason: "identity_lookup_conflict" | "canonical_mismatch";
      fields: WompiEventConflictField[];
    };

const WOMPI_ISSUANCE_CLAIM_STALE_MS = 15 * 60 * 1000;
const ISSUANCE_RETRIES_EXHAUSTED_CODE = "ISSUANCE_RETRIES_EXHAUSTED";
const ISSUANCE_RETRIES_EXHAUSTED_MESSAGE =
  "El mensaje de emisión agotó sus reintentos antes de crear el CDE.";
const WOMPI_ISSUANCE_FAILURE_COLUMNS = `id, environment, amount_cents, donor_name, donor_email,
  received_at, processed_at, issuance_status, issuance_attempt_count, issuance_error_code,
  issuance_error_message, issuance_last_attempt_at, issuance_failed_at,
  issuance_dead_lettered_at, reserved_numero_control`;

export function legacyIssuanceAttemptId(wompiEventId: string): string {
  return `legacy:${wompiEventId}`;
}

export async function insertWompiEvent(
  db: D1Database,
  host: WompiHost,
  payload: WompiWebhook,
  rawBody: string,
  headers: Record<string, string>,
  environment: Ambiente
): Promise<WompiEventInsertResult> {
  const paymentLinkId = dynamicApprovedPaymentLinkId(payload);
  const id = newId("wompi");
  const result = await db
    .prepare(
`INSERT OR IGNORE INTO wompi_events (
          id, transaction_id, payment_link_id, environment, result, amount_cents,
          donor_email, donor_name, raw_body, headers_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      payload.IdTransaccion,
      paymentLinkId,
      environment,
      payload.ResultadoTransaccion,
      amountCents(payload),
      payload.Cliente?.EMail ?? null,
      donorName(payload),
      rawBody,
      JSON.stringify(headers)
    )
    .run();
  const inserted = Number(result.meta?.changes ?? 0) === 1;
  if (inserted) {
    const record = await host.getWompiEventById(id);
    if (!record) {
      throw new Error("No se pudo leer el evento Wompi creado");
    }
    const canonicalPayload = storedCanonicalPayload(record);
    if (!canonicalPayload) {
      throw new Error("No se pudo reconstruir el evento Wompi creado");
    }
    return { kind: "inserted", record, canonicalPayload };
  }

  // A uniqueness race can happen after any pre-read, so an ignored insert is
  // always resolved by fresh reads of both provider identifiers.
  const transactionRecord = await host.getWompiEventByTransaction(payload.IdTransaccion);
  const paymentLinkRecord = paymentLinkId === null
    ? null
    : await host.getWompiEventByPaymentLinkId(paymentLinkId);
  if (transactionRecord && paymentLinkRecord && transactionRecord.id !== paymentLinkRecord.id) {
    return {
      kind: "conflict",
      record: transactionRecord,
      reason: "identity_lookup_conflict",
      fields: ["identity"]
    };
  }
  const record = transactionRecord ?? paymentLinkRecord;
  if (!record) {
    throw new Error("No se pudo leer el evento Wompi creado o deduplicado");
  }
  return compareWompiReplay(record, payload, environment);
}

export async function getWompiEventById(
  db: D1Database,
  id: string
): Promise<WompiEventRecord | null> {
  return db.prepare("SELECT * FROM wompi_events WHERE id = ?").bind(id).first<WompiEventRecord>();
}

export async function getWompiEventByTransaction(
  db: D1Database,
  transactionId: string
): Promise<WompiEventRecord | null> {
  return db.prepare("SELECT * FROM wompi_events WHERE transaction_id = ?").bind(transactionId).first<WompiEventRecord>();
}

export async function getWompiEventByPaymentLinkId(
  db: D1Database,
  paymentLinkId: number
): Promise<WompiEventRecord | null> {
  return db.prepare("SELECT * FROM wompi_events WHERE payment_link_id = ?").bind(paymentLinkId).first<WompiEventRecord>();
}

function dynamicApprovedPaymentLinkId(payload: WompiWebhook): number | null {
  const intentId = payload.EnlacePago?.IdentificadorEnlaceComercio?.trim() ?? "";
  const linkId = payload.EnlacePago?.Id;
  return (
    isApprovedDonation(payload)
    && intentId.startsWith("di_")
    && Number.isInteger(linkId)
    && Number(linkId) > 0
  )
    ? Number(linkId)
    : null;
}

function compareWompiReplay(
  record: WompiEventRecord,
  incoming: WompiWebhook,
  incomingEnvironment: Ambiente
): WompiEventInsertResult {
  const stored = storedCanonicalPayload(record);
  if (!stored) {
    return canonicalConflict(record, ["normalized_body"]);
  }

  const fields: WompiEventConflictField[] = [];
  addConflict(
    fields,
    "environment",
    record.environment !== ambienteFromWompi(stored)
      || record.environment !== incomingEnvironment
  );
  addConflict(
    fields,
    "result",
    record.result !== stored.ResultadoTransaccion
      || record.result !== incoming.ResultadoTransaccion
  );
  addConflict(
    fields,
    "amount",
    record.amount_cents !== amountCents(stored)
      || record.amount_cents !== amountCents(incoming)
  );

  const storedPaymentLink = paymentLinkIdentifier(stored);
  const incomingPaymentLink = paymentLinkIdentifier(incoming);
  addConflict(
    fields,
    "payment_link",
    record.payment_link_id !== dynamicApprovedPaymentLinkId(stored)
      || storedPaymentLink !== incomingPaymentLink
  );

  const storedIntent = commerceIntentIdentifier(stored);
  const incomingIntent = commerceIntentIdentifier(incoming);
  addConflict(fields, "commerce_intent", storedIntent !== incomingIntent);

  const sameTransaction = record.transaction_id === incoming.IdTransaccion;
  const canonicalStored = canonicalNormalizedPayload(stored, !sameTransaction);
  const canonicalIncoming = canonicalNormalizedPayload(incoming, !sameTransaction);
  const alternateTransactionAllowed = sameTransaction || (
    record.transaction_id === stored.IdTransaccion
    && dynamicApprovedPaymentLinkId(stored) !== null
    && dynamicApprovedPaymentLinkId(stored) === dynamicApprovedPaymentLinkId(incoming)
    && storedIntent === incomingIntent
  );
  addConflict(
    fields,
    "normalized_body",
    canonicalStored !== canonicalIncoming || !alternateTransactionAllowed
  );

  return fields.length === 0
    ? { kind: "equivalent_replay", record, canonicalPayload: stored }
    : canonicalConflict(record, fields);
}

function canonicalConflict(
  record: WompiEventRecord,
  fields: WompiEventConflictField[]
): Extract<WompiEventInsertResult, { kind: "conflict" }> {
  return {
    kind: "conflict",
    record,
    reason: "canonical_mismatch",
    fields
  };
}

function addConflict(
  fields: WompiEventConflictField[],
  field: WompiEventConflictField,
  conflicting: boolean
): void {
  if (conflicting && !fields.includes(field)) {
    fields.push(field);
  }
}

function storedCanonicalPayload(record: WompiEventRecord): WompiWebhook | null {
  try {
    return normalizeWompiWebhook(JSON.parse(record.raw_body));
  } catch {
    return null;
  }
}

function paymentLinkIdentifier(payload: WompiWebhook): number | null {
  const linkId = payload.EnlacePago?.Id;
  return Number.isInteger(linkId) && Number(linkId) > 0 ? Number(linkId) : null;
}

function commerceIntentIdentifier(payload: WompiWebhook): string | null {
  return payload.EnlacePago?.IdentificadorEnlaceComercio?.trim() || null;
}

function canonicalNormalizedPayload(
  payload: WompiWebhook,
  excludeTransactionId: boolean
): string {
  if (!excludeTransactionId) {
    return stableJson(payload);
  }
  const { IdTransaccion: _excludedTransactionId, ...withoutTransactionId } = payload;
  return stableJson(withoutTransactionId);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, member]) => member !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, member]) => [key, sortJson(member)])
    );
  }
  return value;
}

export async function claimWompiEventIssuance(
  db: D1Database,
  id: string,
  claimId: string
): Promise<boolean> {
  const claimedAt = nowIso();
  const staleBefore = new Date(Date.now() - WOMPI_ISSUANCE_CLAIM_STALE_MS).toISOString();
  const row = await db
    .prepare(
`UPDATE wompi_events
            SET issuance_claim_id = ?, issuance_claimed_at = ?
          WHERE id = ? AND processed_at IS NULL AND created_document_id IS NULL
            AND (
              issuance_claim_id IS NULL
              OR issuance_claimed_at < ?
            )
          RETURNING id`
    )
    .bind(claimId, claimedAt, id, staleBefore)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function claimCorrectedWompiEventIssuance(
  db: D1Database,
  input: {
    id: string;
    claimId: string;
    correctionId: string;
    processingClaimId: string;
    issuanceAttemptId: string;
  }
): Promise<boolean> {
  const claimedAt = nowIso();
  const row = await db
    .prepare(
`UPDATE wompi_events
            SET issuance_claim_id = ?, issuance_claimed_at = ?
          WHERE id = ?
            AND processed_at IS NULL
            AND created_document_id IS NULL
            AND issuance_attempt_id = ?
            AND issuance_status IN ('RETRY_QUEUED', 'PROCESSING')
            AND (issuance_claim_id IS NULL OR issuance_claim_id = ?)
            AND EXISTS (
              SELECT 1 FROM fiscal_corrections
               WHERE id = ?
                 AND target_kind = 'WOMPI_EVENT'
                 AND wompi_event_id = wompi_events.id
                 AND status = 'PROCESSING'
                 AND processing_claim_id = ?
                 AND issuance_attempt_id = wompi_events.issuance_attempt_id
            )
          RETURNING id`
    )
    .bind(
      input.claimId,
      claimedAt,
      input.id,
      input.issuanceAttemptId,
      input.claimId,
      input.correctionId,
      input.processingClaimId
    )
    .first<{ id: string }>();
  return Boolean(row);
}

export async function releaseWompiEventIssuance(
  db: D1Database,
  id: string,
  claimId: string
): Promise<boolean> {
  const row = await db
    .prepare(
`UPDATE wompi_events
            SET issuance_claim_id = NULL, issuance_claimed_at = NULL
          WHERE id = ? AND processed_at IS NULL AND created_document_id IS NULL
            AND issuance_claim_id = ?
          RETURNING id`
    )
    .bind(id, claimId)
    .first<{ id: string }>();
  return Boolean(row);
}

export async function listWompiIssuanceFailures(
  db: D1Database,
  limit = 100
): Promise<WompiIssuanceFailureItem[]> {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const rows = await db
    .prepare(
`SELECT ${WOMPI_ISSUANCE_FAILURE_COLUMNS}
         FROM wompi_events
         WHERE created_document_id IS NULL
           AND issuance_error_message IS NOT NULL
           AND issuance_status IN ('FAILED', 'DEAD_LETTERED', 'RETRY_QUEUED', 'PROCESSING')
         ORDER BY issuance_failed_at DESC, id DESC
         LIMIT ?`
    )
    .bind(safeLimit)
    .all<WompiIssuanceFailureItem>();
  return rows.results ?? [];
}

export async function getWompiIssuanceFailureById(
  db: D1Database,
  wompiEventId: string
): Promise<WompiIssuanceFailureItem | null> {
  return db
    .prepare(
`SELECT ${WOMPI_ISSUANCE_FAILURE_COLUMNS}
       FROM wompi_events
      WHERE id = ?
        AND created_document_id IS NULL
        AND issuance_error_message IS NOT NULL
        AND issuance_status IN ('FAILED', 'DEAD_LETTERED', 'RETRY_QUEUED', 'PROCESSING')`
    )
    .bind(wompiEventId)
    .first<WompiIssuanceFailureItem>();
}

export async function getWompiIssuanceRetrySnapshotById(
  db: D1Database,
  wompiEventId: string
): Promise<WompiIssuanceRetrySnapshot | null> {
  return db
    .prepare(
`SELECT ${WOMPI_ISSUANCE_FAILURE_COLUMNS}, issuance_attempt_id, issuance_claim_id,
           stalled_requeue_epoch_at
           FROM wompi_events
          WHERE id = ?`
    )
    .bind(wompiEventId)
    .first<WompiIssuanceRetrySnapshot>();
}

export async function claimInitialWompiIssuanceAttempt(
  db: D1Database,
  wompiEventId: string
): Promise<string | null> {
  const attemptId = newId("issuance_attempt");
  const queuedAt = nowIso();
  const result = await db
    .prepare(
`UPDATE wompi_events
         SET issuance_status = 'RETRY_QUEUED',
             issuance_attempt_id = ?,
             issuance_last_attempt_at = ?
         WHERE id = ?
           AND created_document_id IS NULL
           AND issuance_attempt_id IS NULL
           AND issuance_status IS NULL`
    )
    .bind(attemptId, queuedAt, wompiEventId)
    .run();
  return Number(result.meta?.changes ?? 0) === 1 ? attemptId : null;
}

export async function claimWompiIssuanceRetry(
  db: D1Database,
  auditContext: AuditRequestContext | undefined,
  wompiEventId: string,
  actorId: string,
  observed: WompiIssuanceRetrySnapshot
): Promise<string | null> {
  const attemptId = newId("issuance_attempt");
  const retryQueuedAt = nextStalledRequeueEpoch(
    nowIso(),
    observed.stalled_requeue_epoch_at,
    observed.issuance_last_attempt_at
  );
  const actorIp = normalizeAuditIp(auditContext?.ip ?? null);
  const actorContext = serializeAuditContext(auditContext?.context);
  const results = await db.batch([
    db
      .prepare(
`UPDATE wompi_events
           SET processed_at = NULL,
               issuance_status = 'RETRY_QUEUED',
               issuance_attempt_id = ?,
               issuance_last_attempt_at = ?,
               stalled_requeue_epoch_at = ?
           WHERE id = ?
             AND created_document_id IS NULL
             AND issuance_claim_id IS NULL
             AND issuance_status IS ?
             AND processed_at IS ?
             AND issuance_attempt_id IS ?
             AND issuance_claim_id IS ?
             AND issuance_error_code IS ?
             AND issuance_error_message IS ?
             AND issuance_last_attempt_at IS ?
             AND stalled_requeue_epoch_at IS ?
             AND (
               issuance_status IN ('FAILED', 'DEAD_LETTERED')
               OR (
                 issuance_status IN ('RETRY_QUEUED', 'PROCESSING')
                 AND processed_at IS NOT NULL
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM fiscal_corrections AS blocking_correction
                WHERE blocking_correction.target_kind = 'WOMPI_EVENT'
                  AND blocking_correction.wompi_event_id = wompi_events.id
                  AND blocking_correction.status IN (
                    'QUEUED', 'PROCESSING', 'REVIEW_REQUIRED', 'ACCEPTED'
                  )
             )`
      )
      .bind(
        attemptId,
        retryQueuedAt,
        retryQueuedAt,
        wompiEventId,
        observed.issuance_status,
        observed.processed_at,
        observed.issuance_attempt_id,
        observed.issuance_claim_id,
        observed.issuance_error_code,
        observed.issuance_error_message,
        observed.issuance_last_attempt_at,
        observed.stalled_requeue_epoch_at
      ),
    db
      .prepare(
`INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id,
             summary, metadata_json, actor_ip, actor_context
           )
           SELECT ?, 'USER', ?, 'WOMPI_ISSUANCE_RETRY_QUEUED',
                  'wompi_event', id, ?, ?, ?, ?
           FROM wompi_events
           WHERE id = ?
             AND created_document_id IS NULL
             AND issuance_status = 'RETRY_QUEUED'
             AND issuance_attempt_id = ?`
      )
      .bind(
        newId("audit"),
        actorId,
        "Reintento de creación de CDE en cola",
        JSON.stringify({ attemptId }),
        actorIp,
        actorContext,
        wompiEventId,
        attemptId
      )
  ]);
  return Number(results[0]?.meta?.changes ?? 0) === 1 ? attemptId : null;
}

function nextStalledRequeueEpoch(
  candidateIso: string,
  previousEpochIso: string | null,
  previousAttemptIso: string | null
): string {
  const candidateMs = isoTimestampMilliseconds(candidateIso);
  if (candidateMs === null) {
    throw new Error("Invalid current retry timestamp");
  }
  const validPredecessors = [previousEpochIso, previousAttemptIso]
    .map(isoTimestampMilliseconds)
    .filter((value): value is number => value !== null);
  const latestPredecessorMs = validPredecessors.length > 0
    ? Math.max(...validPredecessors)
    : Number.NEGATIVE_INFINITY;
  if (candidateMs > latestPredecessorMs) {
    return candidateIso;
  }
  const advanced = new Date(latestPredecessorMs + 1);
  if (!Number.isFinite(advanced.getTime())) {
    throw new Error("Cannot advance retry timestamp");
  }
  const advancedIso = advanced.toISOString();
  if (isoTimestampMilliseconds(advancedIso) === null) {
    throw new Error("Cannot advance retry timestamp");
  }
  return advancedIso;
}

function isoTimestampMilliseconds(value: string | null): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
}

export async function claimStalledWompiIssuanceAttempt(
  db: D1Database,
  wompiEventId: string,
  currentAttemptId: string | null,
  staleBefore: string
): Promise<string | null> {
  const attemptId = newId("issuance_attempt");
  const queuedAt = nowIso();
  // Runnable retry work always has processed_at NULL. A non-null value is terminal
  // evidence that only an explicit operator retry or guarded correction may clear.
  const statement = currentAttemptId
    ? db.prepare(
`UPDATE wompi_events
           SET issuance_status = 'RETRY_QUEUED',
               issuance_attempt_id = ?,
               stalled_requeue_epoch_at = COALESCE(stalled_requeue_epoch_at, issuance_last_attempt_at, received_at),
               issuance_last_attempt_at = ?
           WHERE id = ?
             AND created_document_id IS NULL
             AND issuance_attempt_id = ?
             AND processed_at IS NULL
             AND issuance_status IN ('RETRY_QUEUED', 'PROCESSING')
             AND COALESCE(issuance_last_attempt_at, received_at) < ?
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
             )`
      ).bind(attemptId, queuedAt, wompiEventId, currentAttemptId, staleBefore)
    : db.prepare(
`UPDATE wompi_events
           SET issuance_status = 'RETRY_QUEUED',
               issuance_attempt_id = ?,
               stalled_requeue_epoch_at = COALESCE(stalled_requeue_epoch_at, issuance_last_attempt_at, received_at),
               issuance_last_attempt_at = ?
           WHERE id = ?
             AND created_document_id IS NULL
             AND issuance_attempt_id IS NULL
             AND processed_at IS NULL
             AND issuance_status IS NULL
             AND COALESCE(issuance_last_attempt_at, received_at) < ?
             AND NOT EXISTS (
               SELECT 1
                 FROM fiscal_corrections
                WHERE target_kind = 'WOMPI_EVENT'
                  AND wompi_event_id = wompi_events.id
                  AND status IN (
                    'QUEUED', 'PROCESSING', 'REVIEW_REQUIRED', 'ACCEPTED'
                  )
             )`
      ).bind(attemptId, queuedAt, wompiEventId, staleBefore);
  const result = await statement.run();
  return Number(result.meta?.changes ?? 0) === 1 ? attemptId : null;
}

export async function createWompiAttemptAudit(
  db: D1Database,
  input: {
    wompiEventId: string;
    attemptId: string;
    action: string;
    summary: string;
    metadata?: unknown;
  }
): Promise<boolean> {
  const result = await db
    .prepare(
`INSERT INTO audit_logs (
           id, actor_type, actor_id, action, entity_type, entity_id,
           summary, metadata_json, actor_ip, actor_context
         )
         SELECT ?, 'SYSTEM', NULL, ?, 'wompi_event', id, ?, ?, NULL, NULL
         FROM wompi_events
         WHERE id = ?
           AND created_document_id IS NULL
           AND issuance_attempt_id = ?`
    )
    .bind(
      newId("audit"),
      input.action,
      input.summary,
      JSON.stringify(input.metadata ?? {}),
      input.wompiEventId,
      input.attemptId
    )
    .run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function reserveWompiDocumentIdentifiers(
  db: D1Database,
  host: WompiHost,
  wompiEventId: string,
  environment: Ambiente,
  controlPrefix: string
): Promise<WompiDocumentIdentifiers> {
  const normalizedPrefix = normalizeControlPrefix(controlPrefix);

  const event = await host.getWompiEventById(wompiEventId);
  if (!event) {
    throw new Error("No se encontró el evento Wompi para reservar identificadores");
  }
  if (event.environment !== environment) {
    throw new Error("El ambiente del evento Wompi no coincide con la reserva");
  }

  const existing = wompiDocumentIdentifiersForPrefix(event, normalizedPrefix);
  if (existing) {
    return existing;
  }

  await db
    .prepare(
`UPDATE wompi_events
         SET control_prefix = ?, reserved_codigo_generacion = ?
         WHERE id = ?
           AND environment = ?
           AND control_prefix IS NULL
           AND control_sequence IS NULL
           AND reserved_numero_control IS NULL
           AND reserved_codigo_generacion IS NULL`
    )
    .bind(normalizedPrefix, generationCode(), wompiEventId, environment)
    .run();

  const reservedEvent = await host.getWompiEventById(wompiEventId);
  if (!reservedEvent || reservedEvent.environment !== environment) {
    throw new Error("No se pudo leer la reserva de identificadores Wompi");
  }
  const reserved = wompiDocumentIdentifiersForPrefix(reservedEvent, normalizedPrefix);
  if (!reserved) {
    throw new Error("No se pudo reservar los identificadores del documento Wompi");
  }
  return reserved;
}

export async function markWompiIssuanceProcessing(
  db: D1Database,
  wompiEventId: string,
  attemptId: string,
  legacyMessage = false
): Promise<boolean> {
  const attemptedAt = nowIso();
  const statement = legacyMessage
    ? db.prepare(
`UPDATE wompi_events
           SET issuance_status = 'PROCESSING',
               issuance_attempt_id = COALESCE(issuance_attempt_id, ?),
               issuance_last_attempt_at = ?
           WHERE id = ?
             AND created_document_id IS NULL
             AND (issuance_attempt_id IS NULL OR issuance_attempt_id = ?)
             AND (issuance_status IS NULL OR issuance_status IN ('RETRY_QUEUED', 'PROCESSING', 'FAILED'))
           RETURNING id`
      ).bind(attemptId, attemptedAt, wompiEventId, attemptId)
    : db.prepare(
`UPDATE wompi_events
           SET issuance_status = 'PROCESSING', issuance_last_attempt_at = ?
           WHERE id = ?
             AND created_document_id IS NULL
             AND issuance_attempt_id = ?
             AND issuance_status IN ('RETRY_QUEUED', 'PROCESSING', 'FAILED')
           RETURNING id`
      ).bind(attemptedAt, wompiEventId, attemptId);
  return (await statement.first<{ id: string }>()) !== null;
}

export async function recordWompiIssuanceFailure(
  db: D1Database,
  wompiEventId: string,
  attemptId: string,
  evidence: { code: string; message: string }
): Promise<boolean> {
  const failedAt = nowIso();
  const results = await db.batch([
    db
      .prepare(
`UPDATE wompi_events
           SET issuance_status = 'FAILED',
               issuance_attempt_count = issuance_attempt_count + 1,
               issuance_error_code = ?,
               issuance_error_message = ?,
               issuance_last_attempt_at = ?,
               issuance_failed_at = ?
           WHERE id = ?
             AND created_document_id IS NULL
             AND issuance_attempt_id = ?
             AND issuance_status = 'PROCESSING'`
      )
      .bind(
        evidence.code,
        evidence.message,
        failedAt,
        failedAt,
        wompiEventId,
        attemptId
      ),
    db
      .prepare(
`INSERT INTO audit_logs (
             id, actor_type, actor_id, action, entity_type, entity_id,
             summary, metadata_json, actor_ip, actor_context
           )
           SELECT ?, 'SYSTEM', NULL, 'WOMPI_ISSUANCE_FAILED',
                  'wompi_event', id, ?, ?, NULL, NULL
           FROM wompi_events
           WHERE id = ?
             AND created_document_id IS NULL
             AND issuance_failed_at = ?
             AND issuance_attempt_id = ?
             AND issuance_status = 'FAILED'`
      )
      .bind(
        newId("audit"),
        evidence.message,
        JSON.stringify({ code: evidence.code }),
        wompiEventId,
        failedAt,
        attemptId
      )
  ]);
  return Number(results[0]?.meta?.changes ?? 0) === 1;
}

export async function markWompiIssuanceDeadLettered(
  db: D1Database,
  wompiEventId: string,
  attemptId: string,
  legacyMessage = false
): Promise<boolean> {
  const deadLetteredAt = nowIso();
  const attemptPredicate = legacyMessage
    ? "(issuance_attempt_id IS NULL OR issuance_attempt_id = ?)"
    : "issuance_attempt_id = ?";
  const row = await db
    .prepare(
`UPDATE wompi_events
         SET issuance_status = 'DEAD_LETTERED',
             issuance_attempt_id = COALESCE(issuance_attempt_id, ?),
             issuance_error_code = CASE
               WHEN issuance_error_message IS NULL THEN ?
               ELSE COALESCE(issuance_error_code, ?)
             END,
             issuance_error_message = COALESCE(issuance_error_message, ?),
             issuance_dead_lettered_at = ?,
             processed_at = COALESCE(processed_at, ?)
         WHERE id = ?
           AND created_document_id IS NULL
           AND ${attemptPredicate}
           AND (issuance_status IS NULL OR issuance_status IN ('RETRY_QUEUED', 'PROCESSING', 'FAILED'))
         RETURNING id`
    )
    .bind(
      attemptId,
      ISSUANCE_RETRIES_EXHAUSTED_CODE,
      ISSUANCE_RETRIES_EXHAUSTED_CODE,
      ISSUANCE_RETRIES_EXHAUSTED_MESSAGE,
      deadLetteredAt,
      deadLetteredAt,
      wompiEventId,
      attemptId
    )
    .first<{ id: string }>();
  return row !== null;
}

export async function markWompiIssuanceIgnored(
  db: D1Database,
  wompiEventId: string
): Promise<void> {
  const processedAt = nowIso();
  await db
    .prepare(
`UPDATE wompi_events
         SET issuance_status = 'IGNORED',
             processed_at = COALESCE(processed_at, ?)
         WHERE id = ? AND created_document_id IS NULL`
    )
    .bind(processedAt, wompiEventId)
    .run();
}

function wompiDocumentIdentifiers(event: WompiEventRecord): WompiDocumentIdentifiers | null {
  const reservation = [
    event.control_prefix,
    event.control_sequence,
    event.reserved_numero_control,
    event.reserved_codigo_generacion
  ];
  if (reservation.every((value) => value === null)) {
    return null;
  }
  if (reservation.some((value) => value === null)) {
    throw new Error("El evento Wompi contiene una reserva parcial de identificadores");
  }

  const sequence = event.control_sequence as number;
  const prefix = event.control_prefix as string;
  const expectedNumeroControl = numeroControl(prefix, sequence);
  if (event.reserved_numero_control !== expectedNumeroControl) {
    throw new Error("La reserva Wompi contiene un número de control inconsistente");
  }

  return {
    sequence,
    numeroControl: expectedNumeroControl,
    codigoGeneracion: event.reserved_codigo_generacion as string
  };
}

function wompiDocumentIdentifiersForPrefix(
  event: WompiEventRecord,
  requestedPrefix: string
): WompiDocumentIdentifiers | null {
  const identifiers = wompiDocumentIdentifiers(event);
  if (!identifiers) {
    return null;
  }
  if (
    event.control_prefix !== requestedPrefix ||
    identifiers.numeroControl !== numeroControl(requestedPrefix, identifiers.sequence)
  ) {
    throw new Error("El prefijo de control solicitado no coincide con la reserva Wompi existente");
  }
  return identifiers;
}
