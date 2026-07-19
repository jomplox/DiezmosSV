import type {
  Ambiente,
  DteDocumentRecord,
  FiscalCorrectionRecord,
  FiscalCorrectionStatus,
  WompiDocumentIdentifiers
} from "../../types";
import { normalizeAuditIp, serializeAuditContext, type AuditRequestContext } from "../../services/requestContext";
import { nowIso } from "../../utils/dates";
import { sha256Hex, utf8Bytes } from "../../utils/encoding";
import { newId, normalizeControlPrefix } from "../../utils/ids";
import { indexDteDocument } from "./dteDocuments";

export interface FailedWompiFiscalCorrectionSummary {
  id: string;
  status: "FAILED";
  failureCode: string | null;
  failureMessage: string | null;
}

interface FiscalCorrectionClaimBaseInput {
  requestId: string;
  requestPayloadSha256: string;
  environment: Ambiente;
  beforeReceptorJson: string;
  correctedReceptorJson: string;
  changedFieldsJson: string;
  createdBy: string;
}

export interface WompiFiscalCorrectionClaimInput extends FiscalCorrectionClaimBaseInput {
  wompiEventId: string;
}

export interface DocumentFiscalCorrectionClaimInput extends FiscalCorrectionClaimBaseInput {
  documentId: string;
}

export type FiscalCorrectionClaimResult =
  | { kind: "claimed"; correction: FiscalCorrectionRecord }
  | { kind: "duplicate"; correction: FiscalCorrectionRecord }
  | { kind: "conflict"; correction: FiscalCorrectionRecord }
  | { kind: "ineligible" };

export interface FiscalCorrectionOutcome {
  status: Exclude<FiscalCorrectionStatus, "QUEUED" | "PROCESSING">;
  failureCode?: string | null;
  failureMessage?: string | null;
  document?: FiscalCorrectionDocumentEvidence;
}

export interface FiscalCorrectionDocumentEvidence {
  documentId: string;
  documentClaimId: string;
  signedJws: string;
}

export interface FiscalCorrectionMhDispatchInput extends FiscalCorrectionDocumentEvidence {
  correctionId: string;
  processingClaimId: string;
}

export type FiscalCorrectionAuditTransition =
  | "QUEUED"
  | "STARTED"
  | "ACCEPTED"
  | "REJECTED"
  | "FAILED"
  | "REVIEW_REQUIRED";

const FISCAL_CORRECTION_AUDIT_FIELDS = new Set([
  "tipoDocumento",
  "numDocumento",
  "nrc",
  "nombre",
  "codActividad",
  "descActividad",
  "correo",
  "telefono",
  "codDomiciliado",
  "codPais",
  "departamento",
  "municipio",
  "distrito",
  "complemento"
]);

const FISCAL_CORRECTION_AUDIT_SUMMARIES: Record<
  FiscalCorrectionAuditTransition,
  string
> = {
  QUEUED: "Corrección fiscal en cola",
  STARTED: "Procesamiento de corrección fiscal iniciado",
  ACCEPTED: "Corrección fiscal aceptada",
  REJECTED: "Corrección fiscal rechazada",
  FAILED: "Corrección fiscal fallida",
  REVIEW_REQUIRED: "Corrección fiscal requiere revisión"
};

function fiscalCorrectionAuditFields(changedFieldsJson: string): string[] {
  let parsedFields: unknown;
  try {
    parsedFields = JSON.parse(changedFieldsJson);
  } catch {
    parsedFields = [];
  }
  return Array.isArray(parsedFields)
    ? parsedFields.reduce<string[]>((safeFields, value) => {
        if (
          typeof value === "string"
          && FISCAL_CORRECTION_AUDIT_FIELDS.has(value)
          && !safeFields.includes(value)
        ) {
          safeFields.push(value);
        }
        return safeFields;
      }, [])
    : [];
}
export interface FiscalCorrectionHost {
  getDteDocument(id: string): Promise<DteDocumentRecord | null>;
  getFiscalCorrection(id: string): Promise<FiscalCorrectionRecord | null>;
  getFiscalCorrectionByRequestId(
    requestId: string
  ): Promise<FiscalCorrectionRecord | null>;
  reconcileFiscalCorrectionAudits(
    correction: FiscalCorrectionRecord
  ): Promise<void>;
}

async function indexDteDocumentById(
  db: D1Database,
  host: FiscalCorrectionHost,
  id: string
): Promise<void> {
  const record = await host.getDteDocument(id);
  if (record) {
    await indexDteDocument(db, record);
  }
}

export async function claimWompiFiscalCorrection(
  db: D1Database,
  auditContext: AuditRequestContext | undefined,
  host: FiscalCorrectionHost,
  input: WompiFiscalCorrectionClaimInput
): Promise<FiscalCorrectionClaimResult> {
  const requestIdHash = await sha256Hex(utf8Bytes(input.requestId));
  const changedFields = fiscalCorrectionAuditFields(input.changedFieldsJson);
  for (let collisionRetry = 0; collisionRetry < 3; collisionRetry += 1) {
    const correctionId = newId("fiscal_correction");
    const issuanceAttemptId = newId("issuance_attempt");
    const processingClaimId = newId("correction_processing");
    const claimedAt = nowIso();
    await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO fiscal_corrections (
             id, request_id, request_payload_sha256, attempt_number, target_kind,
             wompi_event_id, document_id, environment, status, before_receptor_json,
             corrected_receptor_json, changed_fields_json,
             source_document_snapshot_json, issuance_attempt_id, fiscal_claim_id,
             processing_claim_id, created_by
           )
           SELECT ?, ?, ?,
                  COALESCE((
                    SELECT MAX(existing.attempt_number)
                      FROM fiscal_corrections AS existing
                     WHERE existing.target_kind = 'WOMPI_EVENT'
                       AND existing.wompi_event_id = wompi_events.id
                  ), 0) + 1,
                  'WOMPI_EVENT', id, NULL, environment, 'QUEUED', ?, ?, ?,
                  NULL, ?, NULL, ?, ?
             FROM wompi_events
            WHERE id = ?
              AND environment = ?
              AND created_document_id IS NULL
              AND issuance_claim_id IS NULL
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
      ).bind(
        correctionId,
        input.requestId,
        input.requestPayloadSha256,
        input.beforeReceptorJson,
        input.correctedReceptorJson,
        input.changedFieldsJson,
        issuanceAttemptId,
        processingClaimId,
        input.createdBy,
        input.wompiEventId,
        input.environment
      ),
      db.prepare(
        `UPDATE wompi_events
              SET processed_at = NULL,
                  issuance_status = 'RETRY_QUEUED',
                  issuance_attempt_id = ?,
                  issuance_last_attempt_at = ?
            WHERE id = ?
              AND environment = ?
              AND created_document_id IS NULL
              AND issuance_claim_id IS NULL
              AND (
                issuance_status IN ('FAILED', 'DEAD_LETTERED')
                OR (
                  issuance_status IN ('RETRY_QUEUED', 'PROCESSING')
                  AND processed_at IS NOT NULL
                )
              )
              AND EXISTS (
                SELECT 1 FROM fiscal_corrections
                 WHERE id = ?
                   AND wompi_event_id = wompi_events.id
                   AND issuance_attempt_id = ?
              )`
      ).bind(
        issuanceAttemptId,
        claimedAt,
        input.wompiEventId,
        input.environment,
        correctionId,
        issuanceAttemptId
      ),
      fiscalCorrectionAuditInsertStatement(db, auditContext, {
        correctionId,
        transition: "QUEUED",
        requestIdHash,
        changedFields,
        outcomeCode: "QUEUED",
        actorType: "USER",
        actorId: input.createdBy,
        includeRequestContext: true
      })
    ]);

    const existing = await host.getFiscalCorrectionByRequestId(input.requestId);
    if (existing) {
      const resolved = resolveFiscalCorrectionClaim(existing, correctionId, {
        targetKind: "WOMPI_EVENT",
        targetId: input.wompiEventId,
        requestPayloadSha256: input.requestPayloadSha256
      });
      if (resolved.kind === "duplicate") {
        await host.reconcileFiscalCorrectionAudits(existing);
      }
      return resolved;
    }
    const eligible = await db.prepare(
      `SELECT id FROM wompi_events
          WHERE id = ?
            AND environment = ?
            AND created_document_id IS NULL
            AND issuance_claim_id IS NULL
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
    ).bind(input.wompiEventId, input.environment).first<{ id: string }>();
    if (!eligible) return { kind: "ineligible" };
  }
  return { kind: "ineligible" };
}

export async function claimDocumentFiscalCorrection(
  db: D1Database,
  auditContext: AuditRequestContext | undefined,
  host: FiscalCorrectionHost,
  input: DocumentFiscalCorrectionClaimInput
): Promise<FiscalCorrectionClaimResult> {
  const requestIdHash = await sha256Hex(utf8Bytes(input.requestId));
  const changedFields = fiscalCorrectionAuditFields(input.changedFieldsJson);
  for (let collisionRetry = 0; collisionRetry < 3; collisionRetry += 1) {
    const correctionId = newId("fiscal_correction");
    const fiscalClaimId = newId("fiscal_claim");
    const processingClaimId = newId("correction_processing");
    const claimedAt = nowIso();
    await db.batch([
      db.prepare(
        `INSERT OR IGNORE INTO fiscal_corrections (
             id, request_id, request_payload_sha256, attempt_number, target_kind,
             wompi_event_id, document_id, environment, status, before_receptor_json,
             corrected_receptor_json, changed_fields_json,
             source_document_snapshot_json, issuance_attempt_id, fiscal_claim_id,
             processing_claim_id, created_by, created_at, updated_at
           )
           SELECT ?, ?, ?,
                  COALESCE((
                    SELECT MAX(existing.attempt_number)
                      FROM fiscal_corrections AS existing
                     WHERE existing.target_kind = 'DTE_DOCUMENT'
                       AND existing.document_id = dte_documents.id
                  ), 0) + 1,
                  'DTE_DOCUMENT', NULL, id, environment, 'QUEUED', ?, ?, ?,
                  json_object(
                    'id', id,
                    'wompi_event_id', wompi_event_id,
                    'tipo_dte', tipo_dte,
                    'environment', environment,
                    'codigo_generacion', codigo_generacion,
                    'numero_control', numero_control,
                    'status', status,
                    'plain_json', plain_json,
                    'signed_jws', signed_jws,
                    'sello_recibido', sello_recibido,
                    'mh_estado', mh_estado,
                    'mh_observaciones_json', mh_observaciones_json,
                    'donor_email', donor_email,
                    'donor_name', donor_name,
                    'amount_cents', amount_cents,
                    'issued_at', issued_at,
                    'accepted_at', accepted_at,
                    'contingency_period_id', contingency_period_id,
                    'transmission_deferred_at', transmission_deferred_at,
                    'created_at', created_at,
                    'updated_at', updated_at
                  ),
                  NULL, ?, ?, ?, ?, ?
             FROM dte_documents
            WHERE id = ?
              AND environment = ?
              AND status = 'REJECTED'
              AND fiscal_operation_claim_id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM fiscal_corrections AS blocking_correction
                 WHERE blocking_correction.status
                       IN ('QUEUED', 'PROCESSING', 'REVIEW_REQUIRED', 'ACCEPTED')
                   AND (
                     (
                       blocking_correction.target_kind = 'DTE_DOCUMENT'
                       AND blocking_correction.document_id = dte_documents.id
                     )
                     OR (
                       blocking_correction.target_kind = 'WOMPI_EVENT'
                       AND blocking_correction.wompi_event_id = dte_documents.wompi_event_id
                     )
                   )
              )`
      ).bind(
        correctionId,
        input.requestId,
        input.requestPayloadSha256,
        input.beforeReceptorJson,
        input.correctedReceptorJson,
        input.changedFieldsJson,
        fiscalClaimId,
        processingClaimId,
        input.createdBy,
        claimedAt,
        claimedAt,
        input.documentId,
        input.environment
      ),
      db.prepare(
        `UPDATE dte_documents
              SET fiscal_operation_claim_id = ?,
                  fiscal_operation_claimed_at = ?,
                  fiscal_operation_kind = 'TRANSMISSION',
                  fiscal_operation_event_id = NULL
            WHERE id = ?
              AND environment = ?
              AND status = 'REJECTED'
              AND fiscal_operation_claim_id IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM fiscal_corrections AS blocking_correction
                 WHERE blocking_correction.id <> ?
                   AND blocking_correction.status
                       IN ('QUEUED', 'PROCESSING', 'REVIEW_REQUIRED', 'ACCEPTED')
                   AND (
                     (
                       blocking_correction.target_kind = 'DTE_DOCUMENT'
                       AND blocking_correction.document_id = dte_documents.id
                     )
                     OR (
                       blocking_correction.target_kind = 'WOMPI_EVENT'
                       AND blocking_correction.wompi_event_id = dte_documents.wompi_event_id
                     )
                   )
              )
              AND EXISTS (
                SELECT 1 FROM fiscal_corrections
                 WHERE id = ?
                   AND document_id = dte_documents.id
                   AND fiscal_claim_id = ?
              )`
      ).bind(
        fiscalClaimId,
        claimedAt,
        input.documentId,
        input.environment,
        correctionId,
        correctionId,
        fiscalClaimId
      ),
      fiscalCorrectionAuditInsertStatement(db, auditContext, {
        correctionId,
        transition: "QUEUED",
        requestIdHash,
        changedFields,
        outcomeCode: "QUEUED",
        actorType: "USER",
        actorId: input.createdBy,
        includeRequestContext: true
      })
    ]);

    const existing = await host.getFiscalCorrectionByRequestId(input.requestId);
    if (existing) {
      const resolved = resolveFiscalCorrectionClaim(existing, correctionId, {
        targetKind: "DTE_DOCUMENT",
        targetId: input.documentId,
        requestPayloadSha256: input.requestPayloadSha256
      });
      if (resolved.kind === "duplicate") {
        await host.reconcileFiscalCorrectionAudits(existing);
      }
      return resolved;
    }
    const eligible = await db.prepare(
      `SELECT id FROM dte_documents
          WHERE id = ?
            AND environment = ?
            AND status = 'REJECTED'
            AND fiscal_operation_claim_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM fiscal_corrections AS blocking_correction
               WHERE blocking_correction.status
                     IN ('QUEUED', 'PROCESSING', 'REVIEW_REQUIRED', 'ACCEPTED')
                 AND (
                   (
                     blocking_correction.target_kind = 'DTE_DOCUMENT'
                     AND blocking_correction.document_id = dte_documents.id
                   )
                   OR (
                     blocking_correction.target_kind = 'WOMPI_EVENT'
                     AND blocking_correction.wompi_event_id = dte_documents.wompi_event_id
                   )
                 )
            )`
    ).bind(input.documentId, input.environment).first<{ id: string }>();
    if (!eligible) return { kind: "ineligible" };
  }
  return { kind: "ineligible" };
}

export async function getFiscalCorrection(
  db: D1Database,
  id: string): Promise<FiscalCorrectionRecord | null> {
  return db.prepare(
    "SELECT * FROM fiscal_corrections WHERE id = ?"
  ).bind(id).first<FiscalCorrectionRecord>();
}

export async function getFiscalCorrectionByRequestId(
  db: D1Database,
  requestId: string
): Promise<FiscalCorrectionRecord | null> {
  return db.prepare(
    "SELECT * FROM fiscal_corrections WHERE request_id = ?"
  ).bind(requestId).first<FiscalCorrectionRecord>();
}

function fiscalCorrectionAuditInsertStatement(
  db: D1Database,
  auditContext: AuditRequestContext | undefined,
  input: {
  correctionId: string;
  transition: FiscalCorrectionAuditTransition;
  requestIdHash: string;
  changedFields: string[];
  outcomeCode: string;
  actorType?: "SYSTEM" | "USER";
  actorId?: string | null;
  includeRequestContext?: boolean;
  auditRecovered?: boolean;
}): D1PreparedStatement {
  const actorType = input.actorType
    ?? (input.transition === "QUEUED" ? "USER" : "SYSTEM");
  const actorIp = input.transition === "QUEUED" && input.includeRequestContext
    ? normalizeAuditIp(auditContext?.ip ?? null)
    : null;
  const actorContext = input.transition === "QUEUED" && input.includeRequestContext
    ? serializeAuditContext(auditContext?.context)
    : null;
  const statePredicate = input.transition === "QUEUED"
    ? "1 = 1"
    : input.transition === "STARTED"
      ? "(processing_started_at IS NOT NULL OR status <> 'QUEUED')"
      : "status = ?";
  const statement = db.prepare(
    `INSERT INTO audit_logs (
         id, actor_type, actor_id, action, entity_type, entity_id, summary,
         metadata_json, actor_ip, actor_context
       )
       SELECT ?, ?, CASE WHEN ? = 'USER' THEN COALESCE(?, created_by) ELSE NULL END,
              ?, 'fiscal_correction', id, ?,
              json_patch(
                json_object(
                  'correctionId', id,
                  'target', json_object(
                    'kind', target_kind,
                    'id', CASE
                      WHEN target_kind = 'WOMPI_EVENT' THEN wompi_event_id
                      ELSE document_id
                    END
                  ),
                  'requestIdHash', ?,
                  'attemptNumber', attempt_number,
                  'changedFields', json(?),
                  'outcomeCode', ?
                ),
                CASE WHEN ? = 1
                  THEN json_object('auditRecovered', json('true'))
                  ELSE json_object()
                END
              ),
              ?, ?
         FROM fiscal_corrections
        WHERE id = ?
          AND ${statePredicate}
       ON CONFLICT(id) DO NOTHING`
  );
  const args: unknown[] = [
    `fiscal_correction_audit:${input.correctionId}:${input.transition}`,
    actorType,
    actorType,
    input.actorId ?? null,
    `FISCAL_CORRECTION_${input.transition}`,
    FISCAL_CORRECTION_AUDIT_SUMMARIES[input.transition],
    input.requestIdHash,
    JSON.stringify(input.changedFields),
    input.outcomeCode,
    input.auditRecovered ? 1 : 0,
    actorIp,
    actorContext,
    input.correctionId
  ];
  if (
    input.transition !== "QUEUED"
    && input.transition !== "STARTED"
  ) {
    args.push(input.transition);
  }
  return statement.bind(...args);
}

async function fiscalCorrectionAuditStatements(
  db: D1Database,
  auditContext: AuditRequestContext | undefined,
  correction: FiscalCorrectionRecord,
  transitions: Array<{
    transition: FiscalCorrectionAuditTransition;
    outcomeCode: string;
  }>
): Promise<D1PreparedStatement[]> {
  const requestIdHash = await sha256Hex(utf8Bytes(correction.request_id));
  const changedFields = fiscalCorrectionAuditFields(
    correction.changed_fields_json
  );
  return transitions.map(({ transition, outcomeCode }) =>
    fiscalCorrectionAuditInsertStatement(db, auditContext, {
      correctionId: correction.id,
      transition,
      requestIdHash,
      changedFields,
      outcomeCode,
      actorType: transition === "QUEUED" ? "USER" : "SYSTEM",
      actorId: transition === "QUEUED" ? correction.created_by : null,
      auditRecovered: true
    })
  );
}

export async function createFiscalCorrectionAudit(
  db: D1Database,
  auditContext: AuditRequestContext | undefined,
  correction: FiscalCorrectionRecord,
  transition: FiscalCorrectionAuditTransition,
  actor?: { type: "SYSTEM" | "USER"; id?: string | null }
): Promise<boolean> {
  const requestIdHash = await sha256Hex(utf8Bytes(correction.request_id));
  const outcomeCode = transition === "STARTED"
    ? "PROCESSING"
    : correction.failure_code ?? transition;
  const result = await fiscalCorrectionAuditInsertStatement(db, auditContext, {
    correctionId: correction.id,
    transition,
    requestIdHash,
    changedFields: fiscalCorrectionAuditFields(correction.changed_fields_json),
    outcomeCode,
    actorType: actor?.type,
    actorId: actor?.id
  }).run();
  return Number(result.meta?.changes ?? 0) === 1;
}

export async function reconcileFiscalCorrectionAudits(
  db: D1Database,
  auditContext: AuditRequestContext | undefined,
  correction: FiscalCorrectionRecord
): Promise<void> {
  const transitions: Array<{
    transition: FiscalCorrectionAuditTransition;
    outcomeCode: string;
  }> = [{ transition: "QUEUED", outcomeCode: "QUEUED" }];
  if (
    correction.processing_started_at
    || correction.status !== "QUEUED"
  ) {
    transitions.push({ transition: "STARTED", outcomeCode: "PROCESSING" });
  }
  if (
    correction.status === "ACCEPTED"
    || correction.status === "REJECTED"
    || correction.status === "FAILED"
    || correction.status === "REVIEW_REQUIRED"
  ) {
    transitions.push({
      transition: correction.status,
      outcomeCode: correction.failure_code ?? correction.status
    });
  }
  await db.batch(
    await fiscalCorrectionAuditStatements(db, auditContext, correction, transitions)
  );
}

export async function getActiveFiscalCorrectionForTarget(
  db: D1Database,
  targetKind: FiscalCorrectionRecord["target_kind"],
  targetId: string
): Promise<Pick<FiscalCorrectionRecord, "id" | "status"> | null> {
  const targetColumn = targetKind === "WOMPI_EVENT"
    ? "wompi_event_id"
    : "document_id";
  return db.prepare(
    `SELECT id, status
         FROM fiscal_corrections
        WHERE target_kind = ?
          AND ${targetColumn} = ?
          AND status IN ('QUEUED', 'PROCESSING', 'REVIEW_REQUIRED')
        ORDER BY attempt_number DESC
        LIMIT 1`
  ).bind(targetKind, targetId).first<Pick<FiscalCorrectionRecord, "id" | "status">>();
}

export async function claimFiscalCorrectionProcessing(
  db: D1Database,
  auditContext: AuditRequestContext | undefined,
  host: FiscalCorrectionHost,
  input: {
  id: string;
  processingClaimId: string;
  issuanceAttemptId?: string;
  fiscalClaimId?: string;
}): Promise<"claimed" | "busy" | "terminal"> {
  const correctionBeforeClaim = await host.getFiscalCorrection(input.id);
  if (!correctionBeforeClaim) return "busy";
  const requestIdHash = await sha256Hex(
    utf8Bytes(correctionBeforeClaim.request_id)
  );
  const changedFields = fiscalCorrectionAuditFields(
    correctionBeforeClaim.changed_fields_json
  );
  const processingStartedAt = nowIso();
  const results = await db.batch([
    db.prepare(
    `UPDATE fiscal_corrections
          SET status = 'PROCESSING',
              processing_started_at = ?,
              updated_at = ?
        WHERE id = ?
          AND status = 'QUEUED'
          AND processing_claim_id = ?
          AND (
            (
              target_kind = 'WOMPI_EVENT'
              AND issuance_attempt_id = ?
              AND EXISTS (
                SELECT 1 FROM wompi_events
                 WHERE id = fiscal_corrections.wompi_event_id
                   AND issuance_status = 'RETRY_QUEUED'
                   AND issuance_attempt_id = fiscal_corrections.issuance_attempt_id
              )
            )
            OR
            (
              target_kind = 'DTE_DOCUMENT'
              AND fiscal_claim_id = ?
              AND EXISTS (
                SELECT 1 FROM dte_documents
                 WHERE id = fiscal_corrections.document_id
                   AND status = 'REJECTED'
                   AND fiscal_operation_claim_id = fiscal_corrections.fiscal_claim_id
                   AND fiscal_operation_kind = 'TRANSMISSION'
              )
            )
          )`
    ).bind(
      processingStartedAt,
      processingStartedAt,
      input.id,
      input.processingClaimId,
      input.issuanceAttemptId ?? null,
      input.fiscalClaimId ?? null
    ),
    fiscalCorrectionAuditInsertStatement(db, auditContext, {
      correctionId: input.id,
      transition: "QUEUED",
      requestIdHash,
      changedFields,
      outcomeCode: "QUEUED",
      actorType: "USER",
      actorId: correctionBeforeClaim.created_by,
      auditRecovered: true
    }),
    fiscalCorrectionAuditInsertStatement(db, auditContext, {
      correctionId: input.id,
      transition: "STARTED",
      requestIdHash,
      changedFields,
      outcomeCode: "PROCESSING"
    })
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) === 1) return "claimed";
  const correction = await host.getFiscalCorrection(input.id);
  if (correction && ["ACCEPTED", "REJECTED", "FAILED", "REVIEW_REQUIRED"].includes(correction.status)) {
    return "terminal";
  }
  return "busy";
}

export async function markFiscalCorrectionMhDispatchStarted(
  db: D1Database,
  input: FiscalCorrectionMhDispatchInput
): Promise<boolean> {
  const dispatchStartedAt = nowIso();
  const row = await db.prepare(
    `UPDATE fiscal_corrections
          SET mh_dispatch_started_at = ?,
              updated_at = ?
        WHERE id = ?
          AND status = 'PROCESSING'
          AND processing_claim_id = ?
          AND mh_dispatch_started_at IS NULL
          AND EXISTS (
            SELECT 1
              FROM dte_documents
             WHERE id = ?
               AND status = 'SIGNED'
               AND fiscal_operation_claim_id = ?
               AND fiscal_operation_kind = 'TRANSMISSION'
               AND signed_jws = ?
               AND (
                 (
                   fiscal_corrections.target_kind = 'DTE_DOCUMENT'
                   AND fiscal_corrections.document_id = dte_documents.id
                   AND fiscal_corrections.fiscal_claim_id = ?
                 )
                 OR
                 (
                   fiscal_corrections.target_kind = 'WOMPI_EVENT'
                   AND fiscal_corrections.wompi_event_id = dte_documents.wompi_event_id
                   AND EXISTS (
                     SELECT 1
                       FROM wompi_events
                      WHERE id = fiscal_corrections.wompi_event_id
                        AND created_document_id = dte_documents.id
                   )
                 )
               )
          )
        RETURNING id`
  ).bind(
    dispatchStartedAt,
    dispatchStartedAt,
    input.correctionId,
    input.processingClaimId,
    input.documentId,
    input.documentClaimId,
    input.signedJws,
    input.documentClaimId
  ).first<{ id: string }>();
  return Boolean(row);
}

export async function clearFiscalCorrectionMhDispatchStarted(
  db: D1Database,
  id: string, claimId: string): Promise<boolean> {
  const row = await db.prepare(
    `UPDATE fiscal_corrections
          SET mh_dispatch_started_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND status = 'PROCESSING'
          AND processing_claim_id = ?
          AND mh_dispatch_started_at IS NOT NULL
        RETURNING id`
  ).bind(nowIso(), id, claimId).first<{ id: string }>();
  return Boolean(row);
}

export async function reserveFiscalCorrectionDocumentIdentifiers(
  db: D1Database,
  input: {
  correctionId: string;
  documentId: string;
  processingClaimId: string;
  fiscalClaimId: string;
  environment: Ambiente;
  controlPrefix: string;
  codigoGeneracion: string;
}): Promise<WompiDocumentIdentifiers | null> {
  const controlPrefix = normalizeControlPrefix(input.controlPrefix);
  await db.prepare(
    `INSERT OR IGNORE INTO document_sequences (
         environment, control_prefix, next_value
       ) VALUES (?, ?, 1)`
  ).bind(input.environment, controlPrefix).run();
  const updatedAt = nowIso();
  const reserved = await db.prepare(
    `UPDATE fiscal_corrections
          SET reserved_control_prefix = ?,
              reserved_control_sequence = (
                SELECT next_value
                  FROM document_sequences
                 WHERE environment = ? AND control_prefix = ?
              ),
              reserved_codigo_generacion = ?,
              reserved_numero_control = 'DTE-15-' || ? || '-' || printf(
                '%015d',
                (
                  SELECT next_value
                    FROM document_sequences
                  WHERE environment = ? AND control_prefix = ?
                )
              ),
              processing_started_at = ?,
              updated_at = ?
        WHERE id = ?
          AND target_kind = 'DTE_DOCUMENT'
          AND document_id = ?
          AND environment = ?
          AND status = 'PROCESSING'
          AND processing_claim_id = ?
          AND fiscal_claim_id = ?
          AND reserved_control_sequence IS NULL
          AND reserved_codigo_generacion IS NULL
          AND reserved_numero_control IS NULL
          AND EXISTS (
            SELECT 1
              FROM dte_documents
             WHERE id = fiscal_corrections.document_id
               AND environment = fiscal_corrections.environment
               AND status = 'REJECTED'
               AND fiscal_operation_claim_id = fiscal_corrections.fiscal_claim_id
               AND fiscal_operation_kind = 'TRANSMISSION'
               AND fiscal_operation_event_id IS NULL
          )
        RETURNING reserved_control_sequence AS sequence,
                  reserved_codigo_generacion AS codigoGeneracion,
                  reserved_numero_control AS numeroControl`
  ).bind(
    controlPrefix,
    input.environment,
    controlPrefix,
    input.codigoGeneracion,
    controlPrefix,
    input.environment,
    controlPrefix,
    updatedAt,
    updatedAt,
    input.correctionId,
    input.documentId,
    input.environment,
    input.processingClaimId,
    input.fiscalClaimId
  ).first<WompiDocumentIdentifiers>();
  if (reserved) return reserved;
  return db.prepare(
    `UPDATE fiscal_corrections
          SET processing_started_at = ?,
              updated_at = ?
        WHERE id = ?
          AND target_kind = 'DTE_DOCUMENT'
          AND document_id = ?
          AND environment = ?
          AND status = 'PROCESSING'
          AND processing_claim_id = ?
          AND fiscal_claim_id = ?
          AND reserved_control_prefix = ?
          AND reserved_control_sequence IS NOT NULL
          AND reserved_codigo_generacion IS NOT NULL
          AND reserved_numero_control IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM dte_documents
             WHERE id = fiscal_corrections.document_id
               AND environment = fiscal_corrections.environment
               AND status IN ('REJECTED', 'SIGNED')
               AND fiscal_operation_claim_id = fiscal_corrections.fiscal_claim_id
               AND fiscal_operation_kind = 'TRANSMISSION'
               AND fiscal_operation_event_id IS NULL
          )
        RETURNING reserved_control_sequence AS sequence,
                  reserved_codigo_generacion AS codigoGeneracion,
                  reserved_numero_control AS numeroControl`
  ).bind(
    updatedAt,
    updatedAt,
    input.correctionId,
    input.documentId,
    input.environment,
    input.processingClaimId,
    input.fiscalClaimId,
    controlPrefix
  ).first<WompiDocumentIdentifiers>();
}

export async function renewFiscalCorrectionDocumentSigningLease(
  db: D1Database,
  input: {
  correctionId: string;
  documentId: string;
  processingClaimId: string;
  fiscalClaimId: string;
  codigoGeneracion: string;
  numeroControl: string;
}): Promise<boolean> {
  const renewedAt = nowIso();
  const row = await db.prepare(
    `UPDATE fiscal_corrections
          SET processing_started_at = ?,
              updated_at = ?
        WHERE id = ?
          AND target_kind = 'DTE_DOCUMENT'
          AND document_id = ?
          AND status = 'PROCESSING'
          AND processing_claim_id = ?
          AND fiscal_claim_id = ?
          AND reserved_codigo_generacion = ?
          AND reserved_numero_control = ?
          AND EXISTS (
            SELECT 1
              FROM dte_documents
             WHERE id = fiscal_corrections.document_id
               AND environment = fiscal_corrections.environment
               AND status = 'REJECTED'
               AND fiscal_operation_claim_id = fiscal_corrections.fiscal_claim_id
               AND fiscal_operation_kind = 'TRANSMISSION'
               AND fiscal_operation_event_id IS NULL
          )
        RETURNING id`
  ).bind(
    renewedAt,
    renewedAt,
    input.correctionId,
    input.documentId,
    input.processingClaimId,
    input.fiscalClaimId,
    input.codigoGeneracion,
    input.numeroControl
  ).first<{ id: string }>();
  return Boolean(row);
}

export async function prepareClaimedFiscalCorrectionDocument(
  db: D1Database,
  host: FiscalCorrectionHost,
  input: {
  correctionId: string;
  documentId: string;
  processingClaimId: string;
  claimId: string;
  codigoGeneracion: string;
  numeroControl: string;
  plainJson: Record<string, unknown>;
  signedJws: string;
  donorName: string | null;
  donorEmail: string | null;
}): Promise<boolean> {
  const updatedAt = nowIso();
  const row = await db.prepare(
    `UPDATE dte_documents
          SET codigo_generacion = ?,
              numero_control = ?,
              plain_json = ?,
              signed_jws = ?,
              donor_name = ?,
              donor_email = ?,
              status = 'SIGNED',
              sello_recibido = NULL,
              mh_estado = NULL,
              mh_observaciones_json = '[]',
              accepted_at = NULL,
              contingency_period_id = NULL,
              transmission_deferred_at = NULL,
              post_accept_finalized_at = NULL,
              post_accept_finalization_claim_id = NULL,
              post_accept_finalization_claimed_at = NULL,
              post_accept_email_dispatch_started_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND status = 'REJECTED'
          AND fiscal_operation_claim_id = ?
          AND fiscal_operation_kind = 'TRANSMISSION'
          AND fiscal_operation_event_id IS NULL
          AND EXISTS (
            SELECT 1 FROM fiscal_corrections
             WHERE id = ?
               AND target_kind = 'DTE_DOCUMENT'
               AND document_id = dte_documents.id
               AND environment = dte_documents.environment
               AND status = 'PROCESSING'
               AND processing_claim_id = ?
               AND fiscal_claim_id = ?
               AND reserved_codigo_generacion = ?
               AND reserved_numero_control = ?
               AND source_document_snapshot_json IS NOT NULL
          )
        RETURNING id`
  ).bind(
    input.codigoGeneracion,
    input.numeroControl,
    JSON.stringify(input.plainJson),
    input.signedJws,
    input.donorName,
    input.donorEmail,
    updatedAt,
    input.documentId,
    input.claimId,
    input.correctionId,
    input.processingClaimId,
    input.claimId,
    input.codigoGeneracion,
    input.numeroControl
  ).first<{ id: string }>();
  if (!row) return false;
  await indexDteDocumentById(db, host, input.documentId);
  return true;
}

export async function finalizeDirectFiscalCorrectionGenerationDisabled(
  db: D1Database,
  auditContext: AuditRequestContext | undefined,
  host: FiscalCorrectionHost,
  id: string,
  processingClaimId: string
): Promise<boolean> {
  const correction = await host.getFiscalCorrection(id);
  if (!correction) return false;
  let source: DteDocumentRecord;
  try {
    source = JSON.parse(
      correction.source_document_snapshot_json ?? ""
    ) as DteDocumentRecord;
  } catch {
    return false;
  }
  if (
    correction.target_kind !== "DTE_DOCUMENT"
    || correction.wompi_event_id !== null
    || correction.issuance_attempt_id !== null
    || !correction.document_id
    || !correction.fiscal_claim_id
    || source.id !== correction.document_id
    || source.wompi_event_id !== null
    || source.environment !== correction.environment
    || source.status !== "REJECTED"
    || typeof source.codigo_generacion !== "string"
    || typeof source.numero_control !== "string"
    || typeof source.plain_json !== "string"
    || typeof source.mh_observaciones_json !== "string"
    || typeof source.amount_cents !== "number"
    || typeof source.issued_at !== "string"
  ) {
    return false;
  }
  const completedAt = nowIso();
  const failureCode = "FISCAL_CORRECTION_DIRECT_GENERATION_DISABLED";
  const failureMessage =
    "La corrección de CDE directos está deshabilitada en este despliegue.";
  const restoreDocument = db.prepare(
    `UPDATE dte_documents
          SET codigo_generacion = ?,
              numero_control = ?,
              status = 'REJECTED',
              plain_json = ?,
              signed_jws = ?,
              sello_recibido = ?,
              mh_estado = ?,
              mh_observaciones_json = ?,
              donor_email = ?,
              donor_name = ?,
              amount_cents = ?,
              issued_at = ?,
              accepted_at = ?,
              contingency_period_id = ?,
              transmission_deferred_at = ?,
              fiscal_operation_claim_id = NULL,
              fiscal_operation_claimed_at = NULL,
              fiscal_operation_kind = NULL,
              fiscal_operation_event_id = NULL,
              transmission_claim_id = NULL,
              post_accept_finalized_at = NULL,
              post_accept_finalization_claim_id = NULL,
              post_accept_finalization_claimed_at = NULL,
              post_accept_email_dispatch_started_at = NULL,
              updated_at = ?
        WHERE id = ?
          AND wompi_event_id IS NULL
          AND environment = ?
          AND status IN ('REJECTED', 'SIGNED')
          AND fiscal_operation_claim_id = ?
          AND fiscal_operation_kind = 'TRANSMISSION'
          AND fiscal_operation_event_id IS NULL
          AND transmission_claim_id IS NULL
          AND (
            status = 'REJECTED'
            OR (
              codigo_generacion = (
                SELECT reserved_codigo_generacion FROM fiscal_corrections
                 WHERE id = ? AND processing_claim_id = ?
              )
              AND numero_control = (
                SELECT reserved_numero_control FROM fiscal_corrections
                 WHERE id = ? AND processing_claim_id = ?
              )
            )
          )
          AND EXISTS (
            SELECT 1
              FROM fiscal_corrections
             WHERE id = ?
               AND document_id = dte_documents.id
               AND environment = dte_documents.environment
               AND target_kind = 'DTE_DOCUMENT'
               AND wompi_event_id IS NULL
               AND issuance_attempt_id IS NULL
               AND status = 'PROCESSING'
               AND processing_claim_id = ?
               AND fiscal_claim_id = dte_documents.fiscal_operation_claim_id
               AND mh_dispatch_started_at IS NULL
               AND source_document_snapshot_json = ?
          )`
  ).bind(
    source.codigo_generacion,
    source.numero_control,
    source.plain_json,
    source.signed_jws,
    source.sello_recibido,
    source.mh_estado,
    source.mh_observaciones_json,
    source.donor_email,
    source.donor_name,
    source.amount_cents,
    source.issued_at,
    source.accepted_at,
    source.contingency_period_id,
    source.transmission_deferred_at,
    completedAt,
    correction.document_id,
    correction.environment,
    correction.fiscal_claim_id,
    id,
    processingClaimId,
    id,
    processingClaimId,
    id,
    processingClaimId,
    correction.source_document_snapshot_json
  );
  const correctionUpdate = db.prepare(
    `UPDATE fiscal_corrections
          SET status = 'FAILED',
              failure_code = ?,
              failure_message = ?,
              completed_at = ?,
              updated_at = ?
        WHERE id = ?
          AND document_id = ?
          AND environment = ?
          AND target_kind = 'DTE_DOCUMENT'
          AND wompi_event_id IS NULL
          AND issuance_attempt_id IS NULL
          AND status = 'PROCESSING'
          AND processing_claim_id = ?
          AND fiscal_claim_id = ?
          AND mh_dispatch_started_at IS NULL
          AND source_document_snapshot_json = ?
          AND EXISTS (
            SELECT 1
              FROM dte_documents
             WHERE id = fiscal_corrections.document_id
               AND wompi_event_id IS NULL
               AND environment = fiscal_corrections.environment
               AND status = 'REJECTED'
               AND codigo_generacion = ?
               AND numero_control = ?
               AND plain_json = ?
               AND fiscal_operation_claim_id IS NULL
               AND fiscal_operation_claimed_at IS NULL
               AND fiscal_operation_kind IS NULL
               AND fiscal_operation_event_id IS NULL
               AND transmission_claim_id IS NULL
          )`
  ).bind(
    failureCode,
    failureMessage,
    completedAt,
    completedAt,
    id,
    correction.document_id,
    correction.environment,
    processingClaimId,
    correction.fiscal_claim_id,
    correction.source_document_snapshot_json,
    source.codigo_generacion,
    source.numero_control,
    source.plain_json
  );
  const auditStatements = await fiscalCorrectionAuditStatements(db, auditContext, 
    correction,
    [
      { transition: "QUEUED", outcomeCode: "QUEUED" },
      { transition: "STARTED", outcomeCode: "PROCESSING" },
      { transition: "FAILED", outcomeCode: failureCode }
    ]
  );
  const results = await db.batch([
    restoreDocument,
    correctionUpdate,
    ...auditStatements
  ]);
  const finalized = Number(results[0]?.meta?.changes ?? 0) === 1
    && Number(results[1]?.meta?.changes ?? 0) === 1;
  if (finalized && correction.document_id) {
    await indexDteDocumentById(db, host, correction.document_id);
  }
  return finalized;
}

export async function finalizeFiscalCorrection(
  db: D1Database,
  auditContext: AuditRequestContext | undefined,
  host: FiscalCorrectionHost,
  id: string,
  claimId: string,
  outcome: FiscalCorrectionOutcome
): Promise<boolean> {
  const correction = await host.getFiscalCorrection(id);
  if (!correction) return false;
  const completedAt = nowIso();
  const document = outcome.document;
  if (outcome.status !== "FAILED" && !document) {
    return false;
  }
  const documentPredicate = outcome.status === "FAILED"
    ? "mh_dispatch_started_at IS NULL"
    : outcome.status === "REVIEW_REQUIRED"
      ? `mh_dispatch_started_at IS NOT NULL
           AND EXISTS (
             SELECT 1
               FROM dte_documents
              WHERE id = ?
                AND status = 'SIGNED'
                AND fiscal_operation_claim_id = ?
                AND fiscal_operation_kind = 'TRANSMISSION'
                AND signed_jws = ?
                AND (
                  (
                    fiscal_corrections.target_kind = 'DTE_DOCUMENT'
                    AND fiscal_corrections.document_id = dte_documents.id
                    AND fiscal_corrections.fiscal_claim_id = ?
                  )
                  OR
                  (
                    fiscal_corrections.target_kind = 'WOMPI_EVENT'
                    AND fiscal_corrections.wompi_event_id = dte_documents.wompi_event_id
                    AND EXISTS (
                      SELECT 1
                        FROM wompi_events
                       WHERE id = fiscal_corrections.wompi_event_id
                         AND created_document_id = dte_documents.id
                    )
                  )
                )
           )`
      : `mh_dispatch_started_at IS NOT NULL
           AND EXISTS (
             SELECT 1
               FROM dte_documents
              WHERE id = ?
                AND status = ?
                AND fiscal_operation_claim_id IS NULL
                AND fiscal_operation_claimed_at IS NULL
                AND fiscal_operation_kind IS NULL
                AND fiscal_operation_event_id IS NULL
                AND signed_jws = ?
                AND (
                  (
                    fiscal_corrections.target_kind = 'DTE_DOCUMENT'
                    AND fiscal_corrections.document_id = dte_documents.id
                    AND fiscal_corrections.fiscal_claim_id = ?
                    AND fiscal_corrections.reserved_codigo_generacion =
                        dte_documents.codigo_generacion
                    AND fiscal_corrections.reserved_numero_control =
                        dte_documents.numero_control
                  )
                  OR
                  (
                    fiscal_corrections.target_kind = 'WOMPI_EVENT'
                    AND fiscal_corrections.wompi_event_id = dte_documents.wompi_event_id
                    AND EXISTS (
                      SELECT 1
                        FROM wompi_events
                       WHERE id = fiscal_corrections.wompi_event_id
                         AND created_document_id = dte_documents.id
                         AND issuance_attempt_id =
                             fiscal_corrections.issuance_attempt_id
                         AND reserved_codigo_generacion =
                             dte_documents.codigo_generacion
                         AND reserved_numero_control =
                             dte_documents.numero_control
                    )
                  )
                )
           )`;
  const correctionUpdate = db.prepare(
    `UPDATE fiscal_corrections
          SET status = ?,
              failure_code = ?,
              failure_message = ?,
              completed_at = ?,
              updated_at = ?
        WHERE id = ?
          AND status = 'PROCESSING'
          AND processing_claim_id = ?
          AND ${documentPredicate}`
  );
  const boundCorrectionUpdate = outcome.status === "FAILED"
    ? correctionUpdate.bind(
        outcome.status,
        outcome.failureCode ?? null,
        outcome.failureMessage ?? null,
        completedAt,
        completedAt,
        id,
        claimId
      )
    : outcome.status === "REVIEW_REQUIRED"
      ? correctionUpdate.bind(
          outcome.status,
          outcome.failureCode ?? null,
          outcome.failureMessage ?? null,
          completedAt,
          completedAt,
          id,
          claimId,
          document!.documentId,
          document!.documentClaimId,
          document!.signedJws,
          document!.documentClaimId
        )
      : correctionUpdate.bind(
          outcome.status,
          outcome.failureCode ?? null,
          outcome.failureMessage ?? null,
          completedAt,
          completedAt,
          id,
          claimId,
          document!.documentId,
          outcome.status,
          document!.signedJws,
          document!.documentClaimId
        );
  const auditStatements = await fiscalCorrectionAuditStatements(db, auditContext, 
    correction,
    [
      { transition: "QUEUED", outcomeCode: "QUEUED" },
      { transition: "STARTED", outcomeCode: "PROCESSING" },
      {
        transition: outcome.status,
        outcomeCode: outcome.failureCode ?? outcome.status
      }
    ]
  );
  const results = await db.batch([
    boundCorrectionUpdate,
    db.prepare(
      `UPDATE dte_documents
            SET fiscal_operation_claim_id = NULL,
                fiscal_operation_claimed_at = NULL,
                fiscal_operation_kind = NULL,
                fiscal_operation_event_id = NULL,
                updated_at = ?
          WHERE id = (
            SELECT document_id FROM fiscal_corrections
             WHERE id = ?
               AND processing_claim_id = ?
               AND status = ?
               AND target_kind = 'DTE_DOCUMENT'
               AND status = 'FAILED'
               AND mh_dispatch_started_at IS NULL
          )
            AND fiscal_operation_claim_id = (
              SELECT fiscal_claim_id FROM fiscal_corrections
               WHERE id = ? AND processing_claim_id = ?
            )`
    ).bind(completedAt, id, claimId, outcome.status, id, claimId),
    ...auditStatements
  ]);
  return Number(results[0]?.meta?.changes ?? 0) === 1;
}

export async function claimWompiFiscalCorrectionDocument(
  db: D1Database,
  input: {
  correctionId: string;
  processingClaimId: string;
  issuanceAttemptId: string;
  documentId: string;
}): Promise<boolean> {
  const claimId = `fiscal_correction_${input.correctionId}`;
  const claimedAt = nowIso();
  const row = await db.prepare(
    `UPDATE dte_documents
          SET fiscal_operation_claim_id = ?,
              fiscal_operation_claimed_at = ?,
              fiscal_operation_kind = 'TRANSMISSION',
              fiscal_operation_event_id = NULL,
              updated_at = ?
        WHERE id = ?
          AND status IN ('PENDING', 'SIGNED', 'FAILED', 'CONTINGENCY_PENDING')
          AND transmission_claim_id IS NULL
          AND (
            fiscal_operation_claim_id IS NULL
            OR (
              fiscal_operation_claim_id = ?
              AND fiscal_operation_kind = 'TRANSMISSION'
              AND fiscal_operation_event_id IS NULL
            )
          )
          AND EXISTS (
            SELECT 1
              FROM fiscal_corrections
              JOIN wompi_events
                ON wompi_events.id = fiscal_corrections.wompi_event_id
             WHERE fiscal_corrections.id = ?
               AND fiscal_corrections.target_kind = 'WOMPI_EVENT'
               AND fiscal_corrections.document_id IS NULL
               AND fiscal_corrections.status = 'PROCESSING'
               AND fiscal_corrections.processing_claim_id = ?
               AND fiscal_corrections.issuance_attempt_id = ?
               AND fiscal_corrections.mh_dispatch_started_at IS NULL
               AND wompi_events.created_document_id = dte_documents.id
               AND wompi_events.environment = dte_documents.environment
               AND wompi_events.issuance_status = 'DOCUMENT_CREATED'
               AND wompi_events.issuance_attempt_id =
                   fiscal_corrections.issuance_attempt_id
               AND dte_documents.wompi_event_id = wompi_events.id
          )
        RETURNING id`
  ).bind(
    claimId,
    claimedAt,
    claimedAt,
    input.documentId,
    claimId,
    input.correctionId,
    input.processingClaimId,
    input.issuanceAttemptId
  ).first<{ id: string }>();
  return Boolean(row);
}

export async function finalizeWompiFiscalCorrectionFailure(
  db: D1Database,
  auditContext: AuditRequestContext | undefined,
  host: FiscalCorrectionHost,
  id: string,
  claimId: string,
  outcome: Pick<FiscalCorrectionOutcome, "failureCode" | "failureMessage">
): Promise<boolean> {
  const correction = await host.getFiscalCorrection(id);
  if (!correction) return false;
  const completedAt = nowIso();
  const failureCode = outcome.failureCode ?? "FISCAL_CORRECTION_FAILED";
  const failureMessage = outcome.failureMessage ?? "La corrección fiscal falló antes de crear el CDE.";
  const auditStatements = await fiscalCorrectionAuditStatements(db, auditContext, 
    correction,
    [
      { transition: "QUEUED", outcomeCode: "QUEUED" },
      { transition: "STARTED", outcomeCode: "PROCESSING" },
      { transition: "FAILED", outcomeCode: failureCode }
    ]
  );
  const results = await db.batch([
    db.prepare(
      `UPDATE wompi_events
            SET issuance_status = 'FAILED',
                issuance_attempt_count = issuance_attempt_count + 1,
                issuance_error_code = ?,
                issuance_error_message = ?,
                issuance_last_attempt_at = ?,
                issuance_failed_at = ?,
                processed_at = ?,
                issuance_attempt_id = NULL,
                issuance_claim_id = NULL,
                issuance_claimed_at = NULL
          WHERE id = (
            SELECT wompi_event_id
              FROM fiscal_corrections
             WHERE id = ?
               AND target_kind = 'WOMPI_EVENT'
               AND status = 'PROCESSING'
               AND processing_claim_id = ?
               AND mh_dispatch_started_at IS NULL
          )
            AND created_document_id IS NULL
            AND processed_at IS NULL
            AND issuance_status IN ('RETRY_QUEUED', 'PROCESSING')
            AND issuance_attempt_id = (
              SELECT issuance_attempt_id
                FROM fiscal_corrections
               WHERE id = ?
                 AND processing_claim_id = ?
            )`
    ).bind(
      failureCode,
      failureMessage,
      completedAt,
      completedAt,
      completedAt,
      id,
      claimId,
      id,
      claimId
    ),
    db.prepare(
      `UPDATE fiscal_corrections
            SET status = 'FAILED',
                failure_code = ?,
                failure_message = ?,
                completed_at = ?,
                updated_at = ?
          WHERE id = ?
            AND target_kind = 'WOMPI_EVENT'
            AND status = 'PROCESSING'
            AND processing_claim_id = ?
            AND mh_dispatch_started_at IS NULL
            AND EXISTS (
              SELECT 1
                FROM wompi_events
               WHERE id = fiscal_corrections.wompi_event_id
                 AND created_document_id IS NULL
                 AND issuance_status = 'FAILED'
                 AND processed_at = ?
                 AND issuance_attempt_id IS NULL
                 AND issuance_claim_id IS NULL
                 AND issuance_error_code = ?
            )`
    ).bind(
      failureCode,
      failureMessage,
      completedAt,
      completedAt,
      id,
      claimId,
      completedAt,
      failureCode
    ),
    ...auditStatements
  ]);
  return (
    Number(results[0]?.meta?.changes ?? 0) === 1
    && Number(results[1]?.meta?.changes ?? 0) === 1
  );
}

export async function listRecoverableFiscalCorrections(
  db: D1Database,
  staleBefore: string,
  limit = 100
): Promise<FiscalCorrectionRecord[]> {
  const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500));
  const rows = await db.prepare(
    `SELECT * FROM fiscal_corrections
        WHERE (
          status = 'QUEUED'
          AND updated_at < ?
        ) OR (
          status = 'PROCESSING'
          AND processing_started_at < ?
          AND mh_dispatch_started_at IS NULL
        ) OR (
          status = 'PROCESSING'
          AND processing_started_at < ?
          AND mh_dispatch_started_at IS NOT NULL
          AND EXISTS (
            SELECT 1
              FROM dte_documents
             WHERE status IN ('ACCEPTED', 'REJECTED')
               AND signed_jws IS NOT NULL
               AND fiscal_operation_claim_id IS NULL
               AND fiscal_operation_claimed_at IS NULL
               AND fiscal_operation_kind IS NULL
               AND fiscal_operation_event_id IS NULL
               AND (
                 (
                   fiscal_corrections.target_kind = 'DTE_DOCUMENT'
                   AND id = fiscal_corrections.document_id
                   AND codigo_generacion = fiscal_corrections.reserved_codigo_generacion
                   AND numero_control = fiscal_corrections.reserved_numero_control
                 )
                 OR
                 (
                   fiscal_corrections.target_kind = 'WOMPI_EVENT'
                   AND wompi_event_id = fiscal_corrections.wompi_event_id
                   AND EXISTS (
                     SELECT 1
                       FROM wompi_events
                      WHERE id = fiscal_corrections.wompi_event_id
                        AND created_document_id = dte_documents.id
                        AND issuance_attempt_id = fiscal_corrections.issuance_attempt_id
                        AND reserved_codigo_generacion = dte_documents.codigo_generacion
                        AND reserved_numero_control = dte_documents.numero_control
                   )
                 )
               )
          )
        )
        ORDER BY COALESCE(processing_started_at, updated_at), id
        LIMIT ?`
  ).bind(staleBefore, staleBefore, staleBefore, safeLimit).all<FiscalCorrectionRecord>();
  return rows.results ?? [];
}

export async function recoverFiscalCorrectionProcessingClaim(
  db: D1Database,
  auditContext: AuditRequestContext | undefined,
  host: FiscalCorrectionHost,
  input: {
  id: string;
  currentProcessingClaimId: string;
  nextProcessingClaimId: string;
  staleBefore: string;
}): Promise<FiscalCorrectionRecord | null> {
  const correction = await host.getFiscalCorrection(input.id);
  if (!correction) return null;
  const recoveredAt = nowIso();
  const auditStatements = await fiscalCorrectionAuditStatements(db, auditContext, 
    correction,
    [
      { transition: "QUEUED", outcomeCode: "QUEUED" },
      { transition: "STARTED", outcomeCode: "PROCESSING" }
    ]
  );
  const results = await db.batch([
    db.prepare(
    `UPDATE fiscal_corrections
          SET status = 'PROCESSING',
              processing_claim_id = ?,
              processing_started_at = ?,
              updated_at = ?
        WHERE id = ?
          AND processing_claim_id = ?
          AND mh_dispatch_started_at IS NULL
          AND (
            (status = 'QUEUED' AND updated_at < ?)
            OR
            (status = 'PROCESSING' AND processing_started_at < ?)
          )
          AND (
            (
              target_kind = 'WOMPI_EVENT'
              AND issuance_attempt_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM wompi_events
                 WHERE id = fiscal_corrections.wompi_event_id
                   AND issuance_attempt_id = fiscal_corrections.issuance_attempt_id
                   AND issuance_claim_id IS NULL
                   AND issuance_status IN (
                     'RETRY_QUEUED', 'PROCESSING', 'DOCUMENT_CREATED'
                   )
              )
            )
            OR
            (
              target_kind = 'DTE_DOCUMENT'
              AND fiscal_claim_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM dte_documents
                 WHERE id = fiscal_corrections.document_id
                   AND status IN ('REJECTED', 'SIGNED')
                   AND fiscal_operation_claim_id = fiscal_corrections.fiscal_claim_id
                   AND fiscal_operation_kind = 'TRANSMISSION'
              )
            )
          )`
    ).bind(
      input.nextProcessingClaimId,
      recoveredAt,
      recoveredAt,
      input.id,
      input.currentProcessingClaimId,
      input.staleBefore,
      input.staleBefore
    ),
    ...auditStatements
  ]);
  if (Number(results[0]?.meta?.changes ?? 0) !== 1) return null;
  return host.getFiscalCorrection(input.id);
}

function resolveFiscalCorrectionClaim(

  correction: FiscalCorrectionRecord,
  correctionId: string,
  expected: {
    targetKind: FiscalCorrectionRecord["target_kind"];
    targetId: string;
    requestPayloadSha256: string;
  }
): FiscalCorrectionClaimResult {
  const targetId = correction.target_kind === "WOMPI_EVENT"
    ? correction.wompi_event_id
    : correction.document_id;
  if (
    correction.target_kind !== expected.targetKind
    || targetId !== expected.targetId
    || correction.request_payload_sha256 !== expected.requestPayloadSha256
  ) {
    return { kind: "conflict", correction };
  }
  return {
    kind: correction.id === correctionId ? "claimed" : "duplicate",
    correction
  };
}

export async function getFailedWompiFiscalCorrectionForDocument(
  db: D1Database,
  documentId: string
): Promise<FailedWompiFiscalCorrectionSummary | null> {
  const row = await db.prepare(
    `SELECT fiscal_corrections.id,
              fiscal_corrections.status,
              fiscal_corrections.failure_code,
              fiscal_corrections.failure_message
         FROM dte_documents
         JOIN fiscal_corrections
           ON fiscal_corrections.target_kind = 'WOMPI_EVENT'
          AND fiscal_corrections.wompi_event_id = dte_documents.wompi_event_id
          AND fiscal_corrections.status = 'FAILED'
          AND dte_documents.fiscal_operation_claim_id =
              'fiscal_correction_' || fiscal_corrections.id
        WHERE dte_documents.id = ?
          AND dte_documents.fiscal_operation_kind = 'TRANSMISSION'
          AND dte_documents.fiscal_operation_event_id IS NULL
        ORDER BY fiscal_corrections.attempt_number DESC
        LIMIT 1`
  ).bind(documentId).first<{
    id: string;
    status: "FAILED";
    failure_code: string | null;
    failure_message: string | null;
  }>();
  return row
    ? {
        id: row.id,
        status: row.status,
        failureCode: row.failure_code,
        failureMessage: row.failure_message
      }
    : null;
}
