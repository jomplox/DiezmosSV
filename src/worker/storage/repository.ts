import type { Ambiente, ContingencyBatchLineRecord, ContingencyBatchRecord, DonationGiftType, DonationIntentListItem, DonationIntentRecord, DteDocumentRecord, FiscalCorrectionRecord, FiscalCorrectionStatus, WompiDocumentIdentifiers, WompiEventRecord, WompiIssuanceFailureItem, WompiIssuanceRetrySnapshot, WompiPaymentLink, WompiWebhook } from "../types";
import { nowIso } from "../utils/dates";
import { newId, normalizeControlPrefix } from "../utils/ids";
import { normalizeAuditIp, serializeAuditContext, type AuditRequestContext } from "../services/requestContext";
import type { ContactSourceRow } from "../services/contacts";
import { sha256Hex, utf8Bytes } from "../utils/encoding";
import { redactSensitiveAuditRows } from "./shared";
import {
  INTENT_EXPIRY_SWEEP_LIMIT as DONATION_INTENT_EXPIRY_SWEEP_LIMIT,
  applyIntentDatosWithCapability as applyIntentDatosWithCapabilityRepository,
  attachIntentLink as attachIntentLinkRepository,
  completeIntentForPostAcceptOwner as completeIntentForPostAcceptOwnerRepository,
  createDonationIntent as createDonationIntentRepository,
  expireDonationIntentsByIds as expireDonationIntentsByIdsRepository,
  getCompletedIntentForDocument as getCompletedIntentForDocumentRepository,
  getDonationIntent as getDonationIntentRepository,
  hasAuditAction as hasAuditActionRepository,
  listIntentsExpiringBefore as listIntentsExpiringBeforeRepository,
  listRecentDonationIntents as listRecentDonationIntentsRepository,
  markIntentCompleted as markIntentCompletedRepository,
  markIntentPaid as markIntentPaidRepository,
  type CreateDonationIntentInput,
  type IntentDatosInput
} from "./repository/donationIntents";
import { getSetting, setSetting } from "./repository/settings";
import {
  claimCorrectedWompiEventIssuance as claimCorrectedWompiEventIssuanceRepository,
  claimInitialWompiIssuanceAttempt as claimInitialWompiIssuanceAttemptRepository,
  claimStalledWompiIssuanceAttempt as claimStalledWompiIssuanceAttemptRepository,
  claimWompiEventIssuance as claimWompiEventIssuanceRepository,
  claimWompiIssuanceRetry as claimWompiIssuanceRetryRepository,
  createWompiAttemptAudit as createWompiAttemptAuditRepository,
  getWompiEventById as getWompiEventByIdRepository,
  getWompiEventByTransaction as getWompiEventByTransactionRepository,
  getWompiIssuanceFailureById as getWompiIssuanceFailureByIdRepository,
  getWompiIssuanceRetrySnapshotById as getWompiIssuanceRetrySnapshotByIdRepository,
  insertWompiEvent as insertWompiEventRepository,
  listWompiIssuanceFailures as listWompiIssuanceFailuresRepository,
  markWompiIssuanceDeadLettered as markWompiIssuanceDeadLetteredRepository,
  markWompiIssuanceIgnored as markWompiIssuanceIgnoredRepository,
  markWompiIssuanceProcessing as markWompiIssuanceProcessingRepository,
  recordWompiIssuanceFailure as recordWompiIssuanceFailureRepository,
  releaseWompiEventIssuance as releaseWompiEventIssuanceRepository,
  reserveWompiDocumentIdentifiers as reserveWompiDocumentIdentifiersRepository
} from "./repository/wompiIssuance";
import {
  claimDocumentInvalidation as claimDocumentInvalidationRepository,
  claimDocumentPostAcceptFinalization as claimDocumentPostAcceptFinalizationRepository,
  claimDocumentTransmission as claimDocumentTransmissionRepository,
  completeDocumentInvalidation as completeDocumentInvalidationRepository,
  completeDocumentTransmission as completeDocumentTransmissionRepository,
  createAndAttachDocumentInvalidationEvent as createAndAttachDocumentInvalidationEventRepository,
  createClaimedWompiDteDocument as createClaimedWompiDteDocumentRepository,
  createDteDocument as createDteDocumentRepository,
  getDteDocument as getDteDocumentRepository,
  getDteDocumentByWompiEvent as getDteDocumentByWompiEventRepository,
  hasHandledEmail as hasHandledEmailRepository,
  hasSentEmail as hasSentEmailRepository,
  indexDteDocument as indexDteDocumentRepository,
  indexDteDocumentById as indexDteDocumentByIdRepository,
  listAcceptedWompiDocumentsMissingFinalization as listAcceptedWompiDocumentsMissingFinalizationRepository,
  listDeferredTransmissionDocuments as listDeferredTransmissionDocumentsRepository,
  listDteDocuments as listDteDocumentsRepository,
  listPendingPostAcceptFinalizations as listPendingPostAcceptFinalizationsRepository,
  markDocumentFailed as markDocumentFailedRepository,
  markDocumentPostAcceptEmailDispatchStarted as markDocumentPostAcceptEmailDispatchStartedRepository,
  markDocumentPostAcceptFinalized as markDocumentPostAcceptFinalizedRepository,
  markDocumentTransmissionDeferred as markDocumentTransmissionDeferredRepository,
  markWompiDocumentCreated as markWompiDocumentCreatedRepository,
  markWompiEventProcessed as markWompiEventProcessedRepository,
  nextControlSequence as nextControlSequenceRepository,
  quarantineWompiIntentBinding as quarantineWompiIntentBindingRepository,
  releaseDocumentFiscalOperation as releaseDocumentFiscalOperationRepository,
  releaseDocumentInvalidationBeforeDispatch as releaseDocumentInvalidationBeforeDispatchRepository,
  releaseDocumentPostAcceptFinalization as releaseDocumentPostAcceptFinalizationRepository,
  updateClaimedDocumentSigned as updateClaimedDocumentSignedRepository,
  updateDocumentDonorEmail as updateDocumentDonorEmailRepository,
  updateDocumentSigned as updateDocumentSignedRepository,
  type DteDocumentHost,
  type DteDocumentListPage
} from "./repository/dteDocuments";

export { legacyIssuanceAttemptId } from "./repository/wompiIssuance";
export { INTENT_EXPIRY_SWEEP_LIMIT } from "./repository/donationIntents";
export type { DteDocumentListPage } from "./repository/dteDocuments";

export interface ReceiptEmailDeliveryState {
  status: "PENDING" | "SENT" | "FAILED";
  outcomeClass: EmailDeliveryOutcomeClass | null;
  failureCode: string | null;
  retrySafe: boolean;
  requiresReview: boolean;
  attemptNo: number;
  occurredAt: string;
}

export interface FailedWompiFiscalCorrectionSummary {
  id: string;
  status: "FAILED";
  failureCode: string | null;
  failureMessage: string | null;
}

export const RETENTION_PAGE_SIZE = 500;

export class OwnerTargetProtectedError extends Error {
  constructor() {
    super("Solo un propietario puede modificar a otro propietario");
    this.name = "OwnerTargetProtectedError";
  }
}

export class UserMutationConflictError extends Error {
  constructor() {
    super("El usuario cambió mientras se procesaba la solicitud; vuelva a cargar e intente de nuevo");
    this.name = "UserMutationConflictError";
  }
}

const EMAIL_DELIVERY_CLAIM_LEASE_MS = 15 * 60 * 1000;

export type EmailDeliveryOutcomeClass = "NOT_SENT" | "NOT_DELIVERED" | "UNKNOWN";

export type ManualEmailDeliveryClaim =
  | {
      kind: "claimed";
      id: string;
      idempotencyKey: string;
      claimToken: string;
      attemptNo: number;
    }
  | { kind: "already_sent"; id: string; attemptNo: number }
  | { kind: "in_progress"; id: string; attemptNo: number }
  | {
      kind: "manual_review";
      id: string;
      attemptNo: number;
      outcomeClass: EmailDeliveryOutcomeClass | null;
    }
  | { kind: "conflict"; id: string; attemptNo: number };

export type OperationalAlertDeliveryClaim =
  | { kind: "claimed"; id: string; claimToken: string }
  | { kind: "already_sent"; id: string }
  | { kind: "in_progress"; id: string }
  | {
      kind: "manual_review";
      id: string;
      outcomeClass: EmailDeliveryOutcomeClass | null;
    };

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

async function emailDeliveryIdempotencyKey(
  documentId: string,
  emailType: string,
  documentStatusAtSend: string
): Promise<string> {
  // Keep the established ACCEPTED key stable, while separating provisional or
  // rejected receipts from the later definitive acceptance for the same document.
  const evidenceType = documentStatusAtSend === "ACCEPTED"
    ? emailType
    : `${emailType}:${documentStatusAtSend}`;
  const digest = await sha256Hex(utf8Bytes(`example-worker:receipt:v1:${documentId}:${evidenceType}`));
  return `dsv-receipt-v1-${digest}`;
}

async function manualEmailDeliveryIdempotencyKey(
  documentId: string,
  resendRequestId: string
): Promise<string> {
  const digest = await sha256Hex(
    utf8Bytes(`example-worker:receipt-resend:v1:${documentId}:${resendRequestId}`)
  );
  return `dsv-receipt-resend-v1-${digest}`;
}

export const RETENTION_WINDOWED_TABLES = ["dte_documents", "fiscal_corrections", "donation_intents", "dte_events", "email_deliveries", "audit_logs"] as const;
export type RetentionTable = (typeof RETENTION_WINDOWED_TABLES)[number];

export const RETENTION_SNAPSHOT_TABLES = ["wompi_events", "contingency_periods", "contingency_batches", "contingency_batch_lines"] as const;
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

export class Repository {
  // Optional per-request actor context. When handleApi/webhook build the Repository
  // with a request, every createAudit call inherits the caller's IP and cf context
  // without touching a single call site. Cron/queue handlers omit it, so their
  // SYSTEM audits stay NULL — which is exactly what we want (no request => no actor).
  constructor(
    private readonly db: D1Database,
    private readonly auditContext?: AuditRequestContext
  ) {}

  async getSetting(key: string): Promise<string | null> {
    return getSetting(this.db, key);
  }

  async setSetting(key: string, value: string, updatedBy?: string | null): Promise<void> {
    return setSetting(this.db, key, value, updatedBy);
  }

  async insertWompiEvent(payload: WompiWebhook, rawBody: string, headers: Record<string, string>, environment: Ambiente): Promise<{ record: WompiEventRecord; inserted: boolean }> {
    return insertWompiEventRepository(this.db, this, payload, rawBody, headers, environment);
  }

  async getWompiEventById(id: string): Promise<WompiEventRecord | null> {
    return getWompiEventByIdRepository(this.db, id);
  }

  async getWompiEventByTransaction(transactionId: string): Promise<WompiEventRecord | null> {
    return getWompiEventByTransactionRepository(this.db, transactionId);
  }

  async claimWompiFiscalCorrection(
    input: WompiFiscalCorrectionClaimInput
  ): Promise<FiscalCorrectionClaimResult> {
    const requestIdHash = await sha256Hex(utf8Bytes(input.requestId));
    const changedFields = fiscalCorrectionAuditFields(input.changedFieldsJson);
    for (let collisionRetry = 0; collisionRetry < 3; collisionRetry += 1) {
      const correctionId = newId("fiscal_correction");
      const issuanceAttemptId = newId("issuance_attempt");
      const processingClaimId = newId("correction_processing");
      const claimedAt = nowIso();
      await this.db.batch([
        this.db.prepare(
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
        this.db.prepare(
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
        this.fiscalCorrectionAuditInsertStatement({
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

      const existing = await this.getFiscalCorrectionByRequestId(input.requestId);
      if (existing) {
        const resolved = this.resolveFiscalCorrectionClaim(existing, correctionId, {
          targetKind: "WOMPI_EVENT",
          targetId: input.wompiEventId,
          requestPayloadSha256: input.requestPayloadSha256
        });
        if (resolved.kind === "duplicate") {
          await this.reconcileFiscalCorrectionAudits(existing);
        }
        return resolved;
      }
      const eligible = await this.db.prepare(
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

  // dte_documents.wompi_event_id is a unique foreign key when present, so matching
  // it to a WOMPI_EVENT correction identifies the exact durable event/document pair.
  async claimDocumentFiscalCorrection(
    input: DocumentFiscalCorrectionClaimInput
  ): Promise<FiscalCorrectionClaimResult> {
    const requestIdHash = await sha256Hex(utf8Bytes(input.requestId));
    const changedFields = fiscalCorrectionAuditFields(input.changedFieldsJson);
    for (let collisionRetry = 0; collisionRetry < 3; collisionRetry += 1) {
      const correctionId = newId("fiscal_correction");
      const fiscalClaimId = newId("fiscal_claim");
      const processingClaimId = newId("correction_processing");
      const claimedAt = nowIso();
      await this.db.batch([
        this.db.prepare(
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
        this.db.prepare(
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
        this.fiscalCorrectionAuditInsertStatement({
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

      const existing = await this.getFiscalCorrectionByRequestId(input.requestId);
      if (existing) {
        const resolved = this.resolveFiscalCorrectionClaim(existing, correctionId, {
          targetKind: "DTE_DOCUMENT",
          targetId: input.documentId,
          requestPayloadSha256: input.requestPayloadSha256
        });
        if (resolved.kind === "duplicate") {
          await this.reconcileFiscalCorrectionAudits(existing);
        }
        return resolved;
      }
      const eligible = await this.db.prepare(
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

  async getFiscalCorrection(id: string): Promise<FiscalCorrectionRecord | null> {
    return this.db.prepare(
      "SELECT * FROM fiscal_corrections WHERE id = ?"
    ).bind(id).first<FiscalCorrectionRecord>();
  }

  async getFiscalCorrectionByRequestId(
    requestId: string
  ): Promise<FiscalCorrectionRecord | null> {
    return this.db.prepare(
      "SELECT * FROM fiscal_corrections WHERE request_id = ?"
    ).bind(requestId).first<FiscalCorrectionRecord>();
  }

  private fiscalCorrectionAuditInsertStatement(input: {
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
      ? normalizeAuditIp(this.auditContext?.ip ?? null)
      : null;
    const actorContext = input.transition === "QUEUED" && input.includeRequestContext
      ? serializeAuditContext(this.auditContext?.context)
      : null;
    const statePredicate = input.transition === "QUEUED"
      ? "1 = 1"
      : input.transition === "STARTED"
        ? "(processing_started_at IS NOT NULL OR status <> 'QUEUED')"
        : "status = ?";
    const statement = this.db.prepare(
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

  private async fiscalCorrectionAuditStatements(
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
      this.fiscalCorrectionAuditInsertStatement({
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

  async createFiscalCorrectionAudit(
    correction: FiscalCorrectionRecord,
    transition: FiscalCorrectionAuditTransition,
    actor?: { type: "SYSTEM" | "USER"; id?: string | null }
  ): Promise<boolean> {
    const requestIdHash = await sha256Hex(utf8Bytes(correction.request_id));
    const outcomeCode = transition === "STARTED"
      ? "PROCESSING"
      : correction.failure_code ?? transition;
    const result = await this.fiscalCorrectionAuditInsertStatement({
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

  async reconcileFiscalCorrectionAudits(
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
    await this.db.batch(
      await this.fiscalCorrectionAuditStatements(correction, transitions)
    );
  }

  async getActiveFiscalCorrectionForTarget(
    targetKind: FiscalCorrectionRecord["target_kind"],
    targetId: string
  ): Promise<Pick<FiscalCorrectionRecord, "id" | "status"> | null> {
    const targetColumn = targetKind === "WOMPI_EVENT"
      ? "wompi_event_id"
      : "document_id";
    return this.db.prepare(
      `SELECT id, status
         FROM fiscal_corrections
        WHERE target_kind = ?
          AND ${targetColumn} = ?
          AND status IN ('QUEUED', 'PROCESSING', 'REVIEW_REQUIRED')
        ORDER BY attempt_number DESC
        LIMIT 1`
    ).bind(targetKind, targetId).first<Pick<FiscalCorrectionRecord, "id" | "status">>();
  }

  async claimFiscalCorrectionProcessing(input: {
    id: string;
    processingClaimId: string;
    issuanceAttemptId?: string;
    fiscalClaimId?: string;
  }): Promise<"claimed" | "busy" | "terminal"> {
    const correctionBeforeClaim = await this.getFiscalCorrection(input.id);
    if (!correctionBeforeClaim) return "busy";
    const requestIdHash = await sha256Hex(
      utf8Bytes(correctionBeforeClaim.request_id)
    );
    const changedFields = fiscalCorrectionAuditFields(
      correctionBeforeClaim.changed_fields_json
    );
    const processingStartedAt = nowIso();
    const results = await this.db.batch([
      this.db.prepare(
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
      this.fiscalCorrectionAuditInsertStatement({
        correctionId: input.id,
        transition: "QUEUED",
        requestIdHash,
        changedFields,
        outcomeCode: "QUEUED",
        actorType: "USER",
        actorId: correctionBeforeClaim.created_by,
        auditRecovered: true
      }),
      this.fiscalCorrectionAuditInsertStatement({
        correctionId: input.id,
        transition: "STARTED",
        requestIdHash,
        changedFields,
        outcomeCode: "PROCESSING"
      })
    ]);
    if (Number(results[0]?.meta?.changes ?? 0) === 1) return "claimed";
    const correction = await this.getFiscalCorrection(input.id);
    if (correction && ["ACCEPTED", "REJECTED", "FAILED", "REVIEW_REQUIRED"].includes(correction.status)) {
      return "terminal";
    }
    return "busy";
  }

  async markFiscalCorrectionMhDispatchStarted(
    input: FiscalCorrectionMhDispatchInput
  ): Promise<boolean> {
    const dispatchStartedAt = nowIso();
    const row = await this.db.prepare(
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

  async clearFiscalCorrectionMhDispatchStarted(id: string, claimId: string): Promise<boolean> {
    const row = await this.db.prepare(
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

  async reserveFiscalCorrectionDocumentIdentifiers(input: {
    correctionId: string;
    documentId: string;
    processingClaimId: string;
    fiscalClaimId: string;
    environment: Ambiente;
    controlPrefix: string;
    codigoGeneracion: string;
  }): Promise<WompiDocumentIdentifiers | null> {
    const controlPrefix = normalizeControlPrefix(input.controlPrefix);
    await this.db.prepare(
      `INSERT OR IGNORE INTO document_sequences (
         environment, control_prefix, next_value
       ) VALUES (?, ?, 1)`
    ).bind(input.environment, controlPrefix).run();
    const updatedAt = nowIso();
    const reserved = await this.db.prepare(
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
    return this.db.prepare(
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

  async renewFiscalCorrectionDocumentSigningLease(input: {
    correctionId: string;
    documentId: string;
    processingClaimId: string;
    fiscalClaimId: string;
    codigoGeneracion: string;
    numeroControl: string;
  }): Promise<boolean> {
    const renewedAt = nowIso();
    const row = await this.db.prepare(
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

  async prepareClaimedFiscalCorrectionDocument(input: {
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
    const row = await this.db.prepare(
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
    await this.indexDteDocumentById(input.documentId);
    return true;
  }

  async finalizeDirectFiscalCorrectionGenerationDisabled(
    id: string,
    processingClaimId: string
  ): Promise<boolean> {
    const correction = await this.getFiscalCorrection(id);
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
    const restoreDocument = this.db.prepare(
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
    const correctionUpdate = this.db.prepare(
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
    const auditStatements = await this.fiscalCorrectionAuditStatements(
      correction,
      [
        { transition: "QUEUED", outcomeCode: "QUEUED" },
        { transition: "STARTED", outcomeCode: "PROCESSING" },
        { transition: "FAILED", outcomeCode: failureCode }
      ]
    );
    const results = await this.db.batch([
      restoreDocument,
      correctionUpdate,
      ...auditStatements
    ]);
    const finalized = Number(results[0]?.meta?.changes ?? 0) === 1
      && Number(results[1]?.meta?.changes ?? 0) === 1;
    if (finalized && correction.document_id) {
      await this.indexDteDocumentById(correction.document_id);
    }
    return finalized;
  }

  async finalizeFiscalCorrection(
    id: string,
    claimId: string,
    outcome: FiscalCorrectionOutcome
  ): Promise<boolean> {
    const correction = await this.getFiscalCorrection(id);
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
    const correctionUpdate = this.db.prepare(
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
    const auditStatements = await this.fiscalCorrectionAuditStatements(
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
    const results = await this.db.batch([
      boundCorrectionUpdate,
      this.db.prepare(
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

  async claimWompiFiscalCorrectionDocument(input: {
    correctionId: string;
    processingClaimId: string;
    issuanceAttemptId: string;
    documentId: string;
  }): Promise<boolean> {
    const claimId = `fiscal_correction_${input.correctionId}`;
    const claimedAt = nowIso();
    const row = await this.db.prepare(
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

  async finalizeWompiFiscalCorrectionFailure(
    id: string,
    claimId: string,
    outcome: Pick<FiscalCorrectionOutcome, "failureCode" | "failureMessage">
  ): Promise<boolean> {
    const correction = await this.getFiscalCorrection(id);
    if (!correction) return false;
    const completedAt = nowIso();
    const failureCode = outcome.failureCode ?? "FISCAL_CORRECTION_FAILED";
    const failureMessage = outcome.failureMessage ?? "La corrección fiscal falló antes de crear el CDE.";
    const auditStatements = await this.fiscalCorrectionAuditStatements(
      correction,
      [
        { transition: "QUEUED", outcomeCode: "QUEUED" },
        { transition: "STARTED", outcomeCode: "PROCESSING" },
        { transition: "FAILED", outcomeCode: failureCode }
      ]
    );
    const results = await this.db.batch([
      this.db.prepare(
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
      this.db.prepare(
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

  async listRecoverableFiscalCorrections(
    staleBefore: string,
    limit = 100
  ): Promise<FiscalCorrectionRecord[]> {
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 500));
    const rows = await this.db.prepare(
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

  async recoverFiscalCorrectionProcessingClaim(input: {
    id: string;
    currentProcessingClaimId: string;
    nextProcessingClaimId: string;
    staleBefore: string;
  }): Promise<FiscalCorrectionRecord | null> {
    const correction = await this.getFiscalCorrection(input.id);
    if (!correction) return null;
    const recoveredAt = nowIso();
    const auditStatements = await this.fiscalCorrectionAuditStatements(
      correction,
      [
        { transition: "QUEUED", outcomeCode: "QUEUED" },
        { transition: "STARTED", outcomeCode: "PROCESSING" }
      ]
    );
    const results = await this.db.batch([
      this.db.prepare(
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
    return this.getFiscalCorrection(input.id);
  }

  private resolveFiscalCorrectionClaim(
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

  async claimWompiEventIssuance(id: string, claimId: string): Promise<boolean> {
    return claimWompiEventIssuanceRepository(this.db, id, claimId);
  }

  async claimCorrectedWompiEventIssuance(input: {
    id: string;
    claimId: string;
    correctionId: string;
    processingClaimId: string;
    issuanceAttemptId: string;
  }): Promise<boolean> {
    return claimCorrectedWompiEventIssuanceRepository(this.db, input);
  }

  async releaseWompiEventIssuance(id: string, claimId: string): Promise<boolean> {
    return releaseWompiEventIssuanceRepository(this.db, id, claimId);
  }

  async listWompiIssuanceFailures(limit = 100): Promise<WompiIssuanceFailureItem[]> {
    return listWompiIssuanceFailuresRepository(this.db, limit);
  }

  async getWompiIssuanceFailureById(wompiEventId: string): Promise<WompiIssuanceFailureItem | null> {
    return getWompiIssuanceFailureByIdRepository(this.db, wompiEventId);
  }

  async getWompiIssuanceRetrySnapshotById(
    wompiEventId: string
  ): Promise<WompiIssuanceRetrySnapshot | null> {
    return getWompiIssuanceRetrySnapshotByIdRepository(this.db, wompiEventId);
  }

  async claimInitialWompiIssuanceAttempt(wompiEventId: string): Promise<string | null> {
    return claimInitialWompiIssuanceAttemptRepository(this.db, wompiEventId);
  }

  async claimWompiIssuanceRetry(
    wompiEventId: string,
    actorId: string,
    observed: WompiIssuanceRetrySnapshot
  ): Promise<string | null> {
    return claimWompiIssuanceRetryRepository(
      this.db,
      this.auditContext,
      wompiEventId,
      actorId,
      observed
    );
  }

  async claimStalledWompiIssuanceAttempt(
    wompiEventId: string,
    currentAttemptId: string | null,
    staleBefore: string
  ): Promise<string | null> {
    return claimStalledWompiIssuanceAttemptRepository(
      this.db,
      wompiEventId,
      currentAttemptId,
      staleBefore
    );
  }

  async createWompiAttemptAudit(input: {
    wompiEventId: string;
    attemptId: string;
    action: string;
    summary: string;
    metadata?: unknown;
  }): Promise<boolean> {
    return createWompiAttemptAuditRepository(this.db, input);
  }

  async reserveWompiDocumentIdentifiers(
    wompiEventId: string,
    environment: Ambiente,
    controlPrefix: string
  ): Promise<WompiDocumentIdentifiers> {
    return reserveWompiDocumentIdentifiersRepository(
      this.db,
      this,
      wompiEventId,
      environment,
      controlPrefix
    );
  }

  async markWompiIssuanceProcessing(
    wompiEventId: string,
    attemptId: string,
    legacyMessage = false
  ): Promise<boolean> {
    return markWompiIssuanceProcessingRepository(
      this.db,
      wompiEventId,
      attemptId,
      legacyMessage
    );
  }

  async recordWompiIssuanceFailure(
    wompiEventId: string,
    attemptId: string,
    evidence: { code: string; message: string }
  ): Promise<boolean> {
    return recordWompiIssuanceFailureRepository(
      this.db,
      wompiEventId,
      attemptId,
      evidence
    );
  }

  async markWompiIssuanceDeadLettered(
    wompiEventId: string,
    attemptId: string,
    legacyMessage = false
  ): Promise<boolean> {
    return markWompiIssuanceDeadLetteredRepository(
      this.db,
      wompiEventId,
      attemptId,
      legacyMessage
    );
  }

  async markWompiIssuanceIgnored(wompiEventId: string): Promise<void> {
    return markWompiIssuanceIgnoredRepository(this.db, wompiEventId);
  }

  async createDonationIntent(input: CreateDonationIntentInput): Promise<DonationIntentRecord> {
    return createDonationIntentRepository(this.db, this, input);
  }

  async getDonationIntent(id: string): Promise<DonationIntentRecord | null> {
    return getDonationIntentRepository(this.db, id);
  }

  async attachIntentLink(id: string, link: WompiPaymentLink): Promise<void> {
    return attachIntentLinkRepository(this.db, id, link);
  }

  async applyIntentDatosWithCapability(
    id: string,
    datosTokenHash: string,
    data: IntentDatosInput
  ): Promise<{ id: string; urlEnlace: string; urlEnlaceLargo: string } | null> {
    return applyIntentDatosWithCapabilityRepository(this.db, id, datosTokenHash, data);
  }

  async markIntentCompleted(id: string, documentId: string): Promise<boolean> {
    return markIntentCompletedRepository(this.db, id, documentId);
  }

  async completeIntentForPostAcceptOwner(
    id: string,
    documentId: string,
    claimId: string
  ): Promise<boolean> {
    return completeIntentForPostAcceptOwnerRepository(this.db, id, documentId, claimId);
  }

  async markIntentPaid(id: string, expectedLinkId: number): Promise<void> {
    return markIntentPaidRepository(this.db, id, expectedLinkId);
  }

  async listIntentsExpiringBefore(
    nowIso: string,
    limit = DONATION_INTENT_EXPIRY_SWEEP_LIMIT
  ): Promise<Array<Pick<DonationIntentRecord, "id" | "wompi_id_enlace" | "amount_cents" | "status" | "gift_type">>> {
    return listIntentsExpiringBeforeRepository(this.db, nowIso, limit);
  }

  async expireDonationIntentsByIds(ids: string[], updatedAt: string): Promise<void> {
    return expireDonationIntentsByIdsRepository(this.db, ids, updatedAt);
  }

  async listRecentDonationIntents(
    limit = 50
  ): Promise<DonationIntentListItem[]> {
    return listRecentDonationIntentsRepository(this.db, limit);
  }

  async getCompletedIntentForDocument(documentId: string): Promise<{ id: string } | null> {
    return getCompletedIntentForDocumentRepository(this.db, documentId);
  }

  async hasAuditAction(action: string, entityType: string, entityId: string): Promise<boolean> {
    return hasAuditActionRepository(this.db, action, entityType, entityId);
  }

  async nextControlSequence(environment: Ambiente, controlPrefix: string): Promise<number> {
    return nextControlSequenceRepository(this.db, environment, controlPrefix);
  }

  async createDteDocument(input: {
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
  }): Promise<DteDocumentRecord> {
    return createDteDocumentRepository(this.db, this as unknown as DteDocumentHost, input);
  }

  async createClaimedWompiDteDocument(input: {
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
  }): Promise<DteDocumentRecord | null> {
    return createClaimedWompiDteDocumentRepository(
      this.db,
      this as unknown as DteDocumentHost,
      input
    );
  }

  async markWompiDocumentCreated(wompiEventId: string, documentId: string): Promise<void> {
    return markWompiDocumentCreatedRepository(this.db, wompiEventId, documentId);
  }

  async markWompiEventProcessed(id: string): Promise<void> {
    return markWompiEventProcessedRepository(this.db, id);
  }

  async quarantineWompiIntentBinding(input: {
    wompiEventId: string;
    intentId: string;
    reason: string;
    expectedLinkId: number | null;
    payloadLinkId: number | null;
  }): Promise<void> {
    return quarantineWompiIntentBindingRepository(this.db, input);
  }

  async getDteDocument(id: string): Promise<DteDocumentRecord | null> {
    return getDteDocumentRepository(this.db, id);
  }

  async getDteDocumentByWompiEvent(id: string): Promise<DteDocumentRecord | null> {
    return getDteDocumentByWompiEventRepository(this.db, id);
  }

  async getLatestReceiptEmailDelivery(documentId: string): Promise<ReceiptEmailDeliveryState | null> {
    const row = await this.db
      .prepare(
        `SELECT status, outcome_class, failure_code, retry_safe, attempt_no,
                provider_dispatch_started_at,
                COALESCE(
                  finalized_at,
                  sent_at,
                  provider_dispatch_started_at,
                  claim_attempted_at,
                  created_at
                ) AS occurred_at
           FROM email_deliveries
          WHERE document_id = ?
            AND email_type IN ('dteReceipt', 'dteReceiptTransitorio')
          ORDER BY attempt_no DESC, created_at DESC, id DESC
          LIMIT 1`
      )
      .bind(documentId)
      .first<{
        status: "PENDING" | "SENT" | "FAILED";
        outcome_class: EmailDeliveryOutcomeClass | null;
        failure_code: string | null;
        retry_safe: number;
        provider_dispatch_started_at: string | null;
        attempt_no: number;
        occurred_at: string;
      }>();
    return row
      ? {
          status: row.status,
          outcomeClass: row.outcome_class,
          failureCode: row.failure_code,
          retrySafe: Number(row.retry_safe) === 1,
          requiresReview:
            (row.status === "PENDING" && row.provider_dispatch_started_at !== null) ||
            (
              row.status === "FAILED" &&
              (row.outcome_class === null || row.outcome_class === "UNKNOWN")
            ),
          attemptNo: Number(row.attempt_no),
          occurredAt: row.occurred_at
        }
      : null;
  }

  async getFailedWompiFiscalCorrectionForDocument(
    documentId: string
  ): Promise<FailedWompiFiscalCorrectionSummary | null> {
    const row = await this.db.prepare(
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

  async listDteDocuments(params: {
    status?: string | null;
    attention?: "failures" | null;
    q?: string | null;
    limit?: number;
    cursor?: string | null;
  } = {}): Promise<DteDocumentListPage> {
    return listDteDocumentsRepository(this.db, params);
  }
  // Earliest issued document's created_at, used by the backups panel to bound the
  // expected month range when the archive predates (or is emptier than) the DB.
  // Returns null when there are no documents at all.
  async earliestDteDocumentCreatedAt(): Promise<string | null> {
    const row = await this.db.prepare("SELECT MIN(created_at) AS earliest FROM dte_documents").first<{ earliest: string | null }>();
    return row?.earliest ?? null;
  }

  async listAcceptedDteDocumentsForExport(): Promise<DteDocumentRecord[]> {
    return this.db
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
  async listAcceptedDocumentsInYear(
    range: { startIso: string; endIso: string },
    cursor: { issuedAt: string; id: string } | null,
    limit = RETENTION_PAGE_SIZE
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
    const rows = await this.db
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
  async listAcceptedWompiContactRows(
    environment: Ambiente,
    cursor: { issuedAt: string; id: string } | null,
    limit = RETENTION_PAGE_SIZE,
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
    const rows = await this.db
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
    return (rows.results ?? []).map((row) => ({
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
    }));
  }

  // ----- Analítica (carril Wompi) -----
  //
  // Lectores paginados por keyset (mismo estilo que aggregateAnnualDonors) que
  // alimentan las funciones puras de src/worker/services/analytics.ts. TODOS filtran
  // por environment y por el rango [startIso, endIso), y el carril Wompi se restringe
  // con wompi_event_id IS NOT NULL: los CDE emitidos a mano (rápido/avanzado) quedan
  // fuera POR DISEÑO porque nunca llevan wompi_event_id.

  // Documentos del carril Wompi emitidos en el rango, con la geografía y el tipo de
  // regalo del intent correlacionado (LEFT JOIN por document_id) proyectados a cada
  // fila para que la función pura no tenga que unir en memoria. Filtra por issued_at
  // y pagina por (issued_at, id).
  async listWompiLaneDocumentsForAnalytics(
    range: { startIso: string; endIso: string },
    environment: Ambiente,
    cursor: { issuedAt: string; id: string } | null,
    limit = RETENTION_PAGE_SIZE
  ): Promise<
    Array<
      Pick<
        DteDocumentRecord,
        "id" | "wompi_event_id" | "environment" | "status" | "donor_email" | "donor_name" | "amount_cents" | "issued_at" | "accepted_at" | "transmission_deferred_at"
      > & { direccion_departamento: string | null; donor_pais: string | null; gift_type: string | null }
    >
  > {
    const conditions = [
      "d.wompi_event_id IS NOT NULL",
      "d.fiscal_operation_claim_id IS NULL",
      "d.environment = ?",
      "d.issued_at >= ?",
      "d.issued_at < ?"
    ];
    const bindings: Array<string | number> = [environment, range.startIso, range.endIso];
    if (cursor) {
      conditions.push("(d.issued_at, d.id) > (?, ?)");
      bindings.push(cursor.issuedAt, cursor.id);
    }
    const rows = await this.db
      .prepare(
        `SELECT d.id, d.wompi_event_id, d.environment, d.status, d.donor_email, d.donor_name,
                d.amount_cents, d.issued_at, d.accepted_at, d.transmission_deferred_at,
                i.direccion_departamento AS direccion_departamento, i.donor_pais AS donor_pais, i.gift_type AS gift_type
         FROM dte_documents d
         LEFT JOIN donation_intents i ON i.document_id = d.id
         WHERE ${conditions.join(" AND ")}
         ORDER BY d.issued_at ASC, d.id ASC LIMIT ?`
      )
      .bind(...bindings, limit)
      .all<
        Pick<
          DteDocumentRecord,
          "id" | "wompi_event_id" | "environment" | "status" | "donor_email" | "donor_name" | "amount_cents" | "issued_at" | "accepted_at" | "transmission_deferred_at"
        > & { direccion_departamento: string | null; donor_pais: string | null; gift_type: string | null }
      >();
    return rows.results ?? [];
  }

  // Intents del carril Wompi creados en el rango, correlacionados a su ambiente vía el
  // documento emitido (intents COMPLETED) o, para los no completados, por el ambiente
  // activo (los intents no guardan environment). Aquí filtramos por environment del
  // documento cuando existe; los intents sin documento se atribuyen a `environment`
  // pasado por el endpoint (el ambiente activo de emisión). Pagina por (created_at, id).
  async listDonationIntentsForAnalytics(
    range: { startIso: string; endIso: string },
    environment: Ambiente,
    cursor: { createdAt: string; id: string } | null,
    limit = RETENTION_PAGE_SIZE
  ): Promise<
    Array<
      Pick<DonationIntentRecord, "id" | "status" | "document_id" | "donor_document" | "gift_type" | "created_at" | "paid_at"> & { direccion_departamento: string | null; donor_pais: string | null }
    >
  > {
    // Intent belongs to the requested ambiente when its emitted document is in that
    // ambiente; intents that never produced a document (PENDING/LINK_CREATED/EXPIRED)
    // have no environment column, so they are attributed to the requested ambiente
    // only when it matches the active emission environment the endpoint passes. To keep
    // the funnel honest per-ambiente we require: either the joined doc is in `environment`,
    // or there is no joined doc (unpaid/abandoned) — those are lane intents of the active
    // ambiente the endpoint is scoped to.
    const conditions = ["i.created_at >= ?", "i.created_at < ?", "(d.environment = ? OR d.id IS NULL)"];
    const bindings: Array<string | number> = [range.startIso, range.endIso, environment];
    if (cursor) {
      conditions.push("(i.created_at, i.id) > (?, ?)");
      bindings.push(cursor.createdAt, cursor.id);
    }
    const rows = await this.db
      .prepare(
        `SELECT i.id, i.status, i.document_id, i.donor_document, i.gift_type, i.created_at, i.paid_at,
                i.direccion_departamento AS direccion_departamento, i.donor_pais AS donor_pais
         FROM donation_intents i
         LEFT JOIN dte_documents d ON d.id = i.document_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY i.created_at ASC, i.id ASC LIMIT ?`
      )
      .bind(...bindings, limit)
      .all<
        Pick<DonationIntentRecord, "id" | "status" | "document_id" | "donor_document" | "gift_type" | "created_at" | "paid_at"> & { direccion_departamento: string | null; donor_pais: string | null }
      >();
    return rows.results ?? [];
  }

  // Entregas de correo del carril Wompi en el rango: solo las adjuntas a documentos con
  // wompi_event_id en el ambiente pedido. Pagina por (created_at, id).
  async listEmailDeliveriesForAnalytics(
    range: { startIso: string; endIso: string },
    environment: Ambiente,
    cursor: { createdAt: string; id: string } | null,
    limit = RETENTION_PAGE_SIZE
  ): Promise<Array<{ id: string; document_id: string; status: string; created_at: string }>> {
    const conditions = ["e.created_at >= ?", "e.created_at < ?", "d.wompi_event_id IS NOT NULL", "d.environment = ?"];
    const bindings: Array<string | number> = [range.startIso, range.endIso, environment];
    if (cursor) {
      conditions.push("(e.created_at, e.id) > (?, ?)");
      bindings.push(cursor.createdAt, cursor.id);
    }
    const rows = await this.db
      .prepare(
        `SELECT e.id, e.document_id, e.status, e.created_at
         FROM email_deliveries e
         JOIN dte_documents d ON d.id = e.document_id
         WHERE ${conditions.join(" AND ")}
         ORDER BY e.created_at ASC, e.id ASC LIMIT ?`
      )
      .bind(...bindings, limit)
      .all<{ id: string; document_id: string; status: string; created_at: string }>();
    return rows.results ?? [];
  }

  async updateDocumentSigned(id: string, signedJws: string, expectedStatus: string): Promise<boolean> {
    return updateDocumentSignedRepository(this.db, id, signedJws, expectedStatus);
  }

  async updateClaimedDocumentSigned(
    id: string,
    signedJws: string,
    expectedStatus: string,
    claimId: string
  ): Promise<boolean> {
    return updateClaimedDocumentSignedRepository(
      this.db,
      id,
      signedJws,
      expectedStatus,
      claimId
    );
  }

  async claimDocumentTransmission(id: string, expectedStatus: string, signedJws: string, claimId: string): Promise<boolean> {
    return claimDocumentTransmissionRepository(
      this.db,
      id,
      expectedStatus,
      signedJws,
      claimId
    );
  }

  async claimDocumentInvalidation(id: string, claimId: string): Promise<boolean> {
    return claimDocumentInvalidationRepository(this.db, id, claimId);
  }

  async createAndAttachDocumentInvalidationEvent(input: {
    documentId: string;
    claimId: string;
    environment: Ambiente;
    codigoGeneracion: string;
    plainJson: Record<string, unknown>;
    signedJws: string;
    legalDeadlineAt: string;
    createdBy: string;
  }): Promise<string> {
    return createAndAttachDocumentInvalidationEventRepository(this.db, input);
  }

  async releaseDocumentInvalidationBeforeDispatch(
    documentId: string,
    claimId: string,
    eventId: string,
    reason: string
  ): Promise<boolean> {
    return releaseDocumentInvalidationBeforeDispatchRepository(
      this.db,
      documentId,
      claimId,
      eventId,
      reason
    );
  }

  async completeDocumentInvalidation(input: {
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
  }): Promise<boolean> {
    return completeDocumentInvalidationRepository(this.db, input);
  }

  async completeDocumentTransmission(
    id: string,
    claimId: string,
    result: { status: "ACCEPTED" | "REJECTED"; sello: string | null; mhEstado: string; observaciones: string[]; acceptedAt: string | null }
  ): Promise<boolean> {
    return completeDocumentTransmissionRepository(this.db, id, claimId, result);
  }

  async markDocumentFailed(
    id: string,
    claimId: string | null,
    result: { mhEstado: string; observaciones: string[] }
  ): Promise<boolean> {
    return markDocumentFailedRepository(this.db, id, claimId, result);
  }

  async releaseDocumentFiscalOperation(id: string, claimId: string): Promise<boolean> {
    return releaseDocumentFiscalOperationRepository(this.db, id, claimId);
  }

  async markDocumentTransmissionDeferred(id: string, claimId: string, reason: string): Promise<boolean> {
    return markDocumentTransmissionDeferredRepository(this.db, id, claimId, reason);
  }

  async listDeferredTransmissionDocuments(limit = 100): Promise<DteDocumentRecord[]> {
    return listDeferredTransmissionDocumentsRepository(this.db, limit);
  }

  async listAcceptedWompiDocumentsMissingFinalization(limit = 100): Promise<DteDocumentRecord[]> {
    return listAcceptedWompiDocumentsMissingFinalizationRepository(this.db, limit);
  }

  async listPendingPostAcceptFinalizations(limit = 100): Promise<DteDocumentRecord[]> {
    return listPendingPostAcceptFinalizationsRepository(this.db, limit);
  }

  async claimDocumentPostAcceptFinalization(id: string, claimId: string): Promise<boolean> {
    return claimDocumentPostAcceptFinalizationRepository(this.db, id, claimId);
  }

  async markDocumentPostAcceptEmailDispatchStarted(id: string, claimId: string): Promise<boolean> {
    return markDocumentPostAcceptEmailDispatchStartedRepository(this.db, id, claimId);
  }

  async releaseDocumentPostAcceptFinalization(id: string, claimId: string): Promise<boolean> {
    return releaseDocumentPostAcceptFinalizationRepository(this.db, id, claimId);
  }

  async markDocumentPostAcceptFinalized(id: string, claimId: string): Promise<boolean> {
    return markDocumentPostAcceptFinalizedRepository(this.db, id, claimId);
  }

  async hasSentEmail(documentId: string, emailType: string): Promise<boolean> {
    return hasSentEmailRepository(this.db, documentId, emailType);
  }

  async hasHandledEmail(documentId: string, emailType: string, documentStatusAtSend: string): Promise<boolean> {
    return hasHandledEmailRepository(this.db, documentId, emailType, documentStatusAtSend);
  }

  async updateDocumentDonorEmail(id: string, email: string): Promise<boolean> {
    return updateDocumentDonorEmailRepository(
      this.db,
      this as unknown as DteDocumentHost,
      id,
      email
    );
  }

  private async indexDteDocumentById(id: string): Promise<void> {
    void this.indexDteDocument;
    return indexDteDocumentByIdRepository(this as unknown as DteDocumentHost, id);
  }

  private async indexDteDocument(record: DteDocumentRecord): Promise<void> {
    return indexDteDocumentRepository(this.db, record);
  }
  async createAudit(input: {
    actorType?: "SYSTEM" | "USER";
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    summary: string;
    metadata?: unknown;
    // Explicit overrides win over the request-scoped context injected at construction;
    // callers rarely need them since handleApi/webhook inject the context once.
    actorIp?: string | null;
    actorContext?: unknown;
    rateLimitClaimId?: string | null;
  }): Promise<void> {
    const actorIp = normalizeAuditIp(
      input.actorIp ?? this.auditContext?.ip ?? null
    );
    // Persist context only when there is something to persist; an absent request
    // (cron/queue) or an all-undefined cf blob leaves actor_context NULL.
    const actorContext = serializeAuditContext(
      input.actorContext ?? this.auditContext?.context
    );
    await this.db
      .prepare(
        `INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, summary, metadata_json, actor_ip, actor_context, rate_limit_claim_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        newId("audit"),
        input.actorType ?? "SYSTEM",
        input.actorId ?? null,
        input.action,
        input.entityType,
        input.entityId,
        input.summary,
        JSON.stringify(input.metadata ?? {}),
        actorIp,
        actorContext,
        input.rateLimitClaimId ?? null
      )
      .run();
  }

  async ensurePostAcceptAudit(input: {
    auditId: string;
    documentId: string;
    claimId: string;
    action: string;
    entityType: string;
    entityId: string;
    summary: string;
    metadata?: unknown;
  }): Promise<boolean> {
    const row = await this.db
      .prepare(
        `INSERT INTO audit_logs (
           id, actor_type, actor_id, action, entity_type, entity_id, summary,
           metadata_json, actor_ip, actor_context, rate_limit_claim_id
         )
         SELECT ?, 'SYSTEM', NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL
           FROM dte_documents
          WHERE id = ? AND status = 'ACCEPTED'
            AND post_accept_finalized_at IS NULL
            AND fiscal_operation_claim_id IS NULL
            AND post_accept_finalization_claim_id = ?
         ON CONFLICT(id) DO UPDATE SET id = excluded.id
         RETURNING id`
      )
      .bind(
        input.auditId,
        input.action,
        input.entityType,
        input.entityId,
        input.summary,
        JSON.stringify(input.metadata ?? {}),
        input.documentId,
        input.claimId
      )
      .first<{ id: string }>();
    return Boolean(row);
  }

  // Idempotent lifecycle evidence. The existence check and insert live in one
  // SQLite/D1 statement so concurrent queue deliveries cannot both observe an
  // absent logical audit key and append duplicate evidence.
  async createAuditIfAbsent(input: {
    actorType?: "SYSTEM" | "USER";
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId: string;
    summary: string;
    metadata?: unknown;
    actorIp?: string | null;
    actorContext?: unknown;
  }): Promise<boolean> {
    const actorIp = normalizeAuditIp(
      input.actorIp ?? this.auditContext?.ip ?? null
    );
    const actorContext = serializeAuditContext(
      input.actorContext ?? this.auditContext?.context
    );
    const result = await this.db
      .prepare(
        `INSERT INTO audit_logs (id, actor_type, actor_id, action, entity_type, entity_id, summary, metadata_json, actor_ip, actor_context)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM audit_logs
           WHERE action = ? AND entity_type = ? AND entity_id = ?
         )`
      )
      .bind(
        newId("audit"),
        input.actorType ?? "SYSTEM",
        input.actorId ?? null,
        input.action,
        input.entityType,
        input.entityId,
        input.summary,
        JSON.stringify(input.metadata ?? {}),
        actorIp,
        actorContext,
        input.action,
        input.entityType,
        input.entityId
      )
      .run();
    return Number(result.meta?.changes ?? 0) === 1;
  }

  async listAudit(entityType?: string, entityId?: string): Promise<Array<Record<string, unknown>>> {
    // LEFT JOIN users on actor_id so USER rows resolve to a display name/email while
    // SYSTEM rows (and USER rows whose account was later deleted) fall through to NULL.
    // The join is on the users PK, so it is index-backed and does not touch the
    // audit_logs hot path beyond the existing ordered scan.
    if (entityType && entityId) {
      return this.db
        .prepare(
          `SELECT a.*, u.name AS actor_name, u.email AS actor_email
           FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
           WHERE a.entity_type = ? AND a.entity_id = ? ORDER BY a.created_at DESC LIMIT 100`
        )
        .bind(entityType, entityId)
        .all<Record<string, unknown>>()
        .then((result) => redactSensitiveAuditRows(result.results ?? []));
    }
    return this.db
      .prepare(
        `SELECT a.*, u.name AS actor_name, u.email AS actor_email
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
         ORDER BY a.created_at DESC LIMIT 100`
      )
      .all<Record<string, unknown>>()
      .then((result) => redactSensitiveAuditRows(result.results ?? []));
  }

  // Página del historial general de auditoría: keyset (created_at, id) DESC — el mismo
  // patrón de cursor del listado de documentos, porque OFFSET degenera con miles de
  // filas. Devuelve limit+1 filas para que la ruta derive nextCursor sin un COUNT.
  async listAuditPage(cursor: { createdAt: string; id: string } | null, limit: number): Promise<Array<Record<string, unknown>>> {
    const bounded = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const where = cursor ? "WHERE (a.created_at, a.id) < (?, ?)" : "";
    const bindings: string[] = cursor ? [cursor.createdAt, cursor.id] : [];
    return this.db
      .prepare(
        `SELECT a.*, u.name AS actor_name, u.email AS actor_email
         FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
         ${where}
         ORDER BY a.created_at DESC, a.id DESC LIMIT ?`
      )
      .bind(...bindings, bounded + 1)
      .all<Record<string, unknown>>()
      .then((result) => redactSensitiveAuditRows(result.results ?? []));
  }

  // Lectura histórica: la emisión en contingencia se eliminó (el Anexo del evento
  // de contingencia, campo 35, excluye el tipo 15/CDE), y la migración 0014 cierra
  // los periodos que quedaron abiertos — esto existe para la vista de historial.
  async getOpenContingency(environment?: Ambiente): Promise<Record<string, unknown> | null> {
    if (environment) {
      return this.db
        .prepare("SELECT * FROM contingency_periods WHERE environment = ? AND status IN ('OPEN', 'EVENT_ACCEPTED') ORDER BY started_at DESC LIMIT 1")
        .bind(environment)
        .first<Record<string, unknown>>();
    }
    return this.db
      .prepare("SELECT * FROM contingency_periods WHERE status IN ('OPEN', 'EVENT_ACCEPTED') ORDER BY started_at DESC LIMIT 1")
      .first<Record<string, unknown>>();
  }

  async listContingencyPeriods(limit = 20): Promise<Array<Record<string, unknown>>> {
    return this.db
      .prepare("SELECT * FROM contingency_periods ORDER BY started_at DESC LIMIT ?")
      .bind(Math.min(limit, 100))
      .all<Record<string, unknown>>()
      .then((result) => result.results ?? []);
  }

  async listContingencyDocuments(periodId: string): Promise<DteDocumentRecord[]> {
    return this.db
      .prepare("SELECT * FROM dte_documents WHERE contingency_period_id = ? AND status = 'CONTINGENCY_PENDING' ORDER BY created_at ASC")
      .bind(periodId)
      .all<DteDocumentRecord>()
      .then((result) => result.results ?? []);
  }

  async listContingencyBatches(periodId?: string): Promise<ContingencyBatchRecord[]> {
    if (periodId) {
      return this.db
        .prepare("SELECT * FROM contingency_batches WHERE contingency_period_id = ? ORDER BY created_at ASC")
        .bind(periodId)
        .all<ContingencyBatchRecord>()
        .then((result) => result.results ?? []);
    }
    return this.db
      .prepare("SELECT * FROM contingency_batches ORDER BY created_at DESC LIMIT 100")
      .all<ContingencyBatchRecord>()
      .then((result) => result.results ?? []);
  }

  async listContingencyBatchLines(input: { periodId?: string; batchId?: string } = {}): Promise<ContingencyBatchLineRecord[]> {
    if (input.batchId) {
      return this.db
        .prepare("SELECT * FROM contingency_batch_lines WHERE batch_id = ? ORDER BY line_no ASC")
        .bind(input.batchId)
        .all<ContingencyBatchLineRecord>()
        .then((result) => result.results ?? []);
    }
    if (input.periodId) {
      return this.db
        .prepare("SELECT * FROM contingency_batch_lines WHERE contingency_period_id = ? ORDER BY created_at ASC, line_no ASC")
        .bind(input.periodId)
        .all<ContingencyBatchLineRecord>()
        .then((result) => result.results ?? []);
    }
    return this.db
      .prepare("SELECT * FROM contingency_batch_lines ORDER BY created_at DESC LIMIT 500")
      .all<ContingencyBatchLineRecord>()
      .then((result) => result.results ?? []);
  }

  async listDteEventsByType(eventType: "INVALIDACION" | "CONTINGENCIA", limit = 20): Promise<Array<Record<string, unknown>>> {
    return this.db
      .prepare(
        `SELECT id, document_id, event_type, environment, codigo_generacion, status, sello_recibido,
                mh_estado, mh_observaciones_json, legal_deadline_at, created_by, created_at, accepted_at
         FROM dte_events
         WHERE event_type = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .bind(eventType, Math.min(limit, 100))
      .all<Record<string, unknown>>()
      .then((result) => result.results ?? []);
  }

  async recordEmailDelivery(input: {
    documentId: string;
    toEmail: string;
    status: "SENT" | "FAILED";
    providerResponse?: unknown;
    emailType?: string | null;
    documentStatusAtSend?: string | null;
    templateVersion?: string | null;
    pdfRendererVersion?: string | null;
    pdfSha256?: string | null;
    dteJsonSha256?: string | null;
    providerDeliveryId?: string | null;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO email_deliveries (
           id, document_id, to_email, status, provider_response_json, sent_at,
           email_type, document_status_at_send, template_version, pdf_renderer_version,
           pdf_sha256, dte_json_sha256, provider_delivery_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        newId("email"),
        input.documentId,
        input.toEmail,
        input.status,
        JSON.stringify(input.providerResponse ?? {}),
        input.status === "SENT" ? nowIso() : null,
        input.emailType ?? null,
        input.documentStatusAtSend ?? null,
        input.templateVersion ?? null,
        input.pdfRendererVersion ?? null,
        input.pdfSha256 ?? null,
        input.dteJsonSha256 ?? null,
        input.providerDeliveryId ?? null
      )
      .run();
  }

  // Claim one receipt type before contacting the external provider. A current
  // PENDING claim and SENT evidence both block a competing delivery. Only a FAILED
  // outcome explicitly proven retry-safe, or a stale pre-dispatch PENDING claim,
  // reuses the same row and provider identity. Legacy and post-dispatch PENDING rows
  // remain blocked for manual review because provider acceptance is unknown.
  async claimEmailDelivery(input: {
    documentId: string;
    toEmail: string;
    emailType: string;
    documentStatusAtSend: string;
  }): Promise<{ id: string; idempotencyKey: string; claimToken: string } | null> {
    const id = newId("email");
    const claimToken = newId("email_claim");
    const claimedAt = nowIso();
    const staleBefore = new Date(Date.now() - EMAIL_DELIVERY_CLAIM_LEASE_MS).toISOString();
    const idempotencyKey = await emailDeliveryIdempotencyKey(
      input.documentId,
      input.emailType,
      input.documentStatusAtSend
    );
    const row = await this.db
      .prepare(
         `INSERT INTO email_deliveries (
           id, document_id, to_email, status, provider_response_json,
           email_type, document_status_at_send, claim_attempted_at,
           idempotency_key, claim_token, attempt_no
         )
         SELECT ?, ?, ?, 'PENDING', '{}', ?, ?, ?, ?, ?,
                COALESCE((
                  SELECT MAX(attempt_no) FROM email_deliveries
                   WHERE document_id = ?
                ), 0) + 1
         WHERE NOT EXISTS (
           SELECT 1 FROM email_deliveries
           WHERE document_id = ? AND email_type = ? AND document_status_at_send = ?
             AND (
               status = 'SENT'
               OR (
                 status = 'PENDING'
                 AND (
                   provider_dispatch_started_at IS NOT NULL
                   OR claim_attempted_at IS NULL
                   OR claim_attempted_at >= ?
                 )
               )
               OR (status = 'FAILED' AND retry_safe = 0)
             )
         )
         ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL
         DO UPDATE SET
           to_email = excluded.to_email,
           status = 'PENDING',
           provider_response_json = '{}',
           document_status_at_send = excluded.document_status_at_send,
           claim_attempted_at = excluded.claim_attempted_at,
           claim_token = excluded.claim_token,
           provider_dispatch_started_at = NULL,
           finalized_at = NULL,
           outcome_class = NULL,
           failure_code = NULL,
           retry_safe = 0,
           attempt_no = excluded.attempt_no
         WHERE (
              email_deliveries.status = 'FAILED'
              AND email_deliveries.retry_safe = 1
            )
            OR (
              email_deliveries.status = 'PENDING'
              AND email_deliveries.provider_dispatch_started_at IS NULL
              AND email_deliveries.claim_attempted_at IS NOT NULL
              AND email_deliveries.claim_attempted_at < ?
            )
         RETURNING id, idempotency_key, claim_token`
      )
      .bind(
        id,
        input.documentId,
        input.toEmail,
        input.emailType,
        input.documentStatusAtSend,
        claimedAt,
        idempotencyKey,
        claimToken,
        input.documentId,
        input.documentId,
        input.emailType,
        input.documentStatusAtSend,
        staleBefore,
        staleBefore
      )
      .first<{ id: string; idempotency_key: string; claim_token: string }>();
    return row ? {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      claimToken: row.claim_token
    } : null;
  }

  // One resendRequestId represents one deliberate operator action. Repeated HTTP
  // requests reuse its row and provider identity; a new operator action uses a new
  // request ID. Only proven NOT_SENT failures or stale pre-dispatch work can reclaim
  // the row. SENT is a successful duplicate, while ambiguous work requires review.
  async claimManualEmailDelivery(input: {
    documentId: string;
    toEmail: string;
    emailType: string;
    documentStatusAtSend: string;
    resendRequestId: string;
  }): Promise<ManualEmailDeliveryClaim> {
    const id = newId("email");
    const claimToken = newId("email_claim");
    const claimedAt = nowIso();
    const staleBefore = new Date(Date.now() - EMAIL_DELIVERY_CLAIM_LEASE_MS).toISOString();
    const idempotencyKey = await manualEmailDeliveryIdempotencyKey(
      input.documentId,
      input.resendRequestId
    );
    const reclaimed = await this.db
      .prepare(
        `UPDATE email_deliveries
         SET
           status = 'PENDING',
           provider_response_json = '{}',
           sent_at = NULL,
           claim_attempted_at = ?,
           claim_token = ?,
           provider_dispatch_started_at = NULL,
           finalized_at = NULL,
           outcome_class = NULL,
           failure_code = NULL,
           retry_safe = 0,
           template_version = NULL,
           pdf_renderer_version = NULL,
           pdf_sha256 = NULL,
           dte_json_sha256 = NULL,
           provider_delivery_id = NULL,
           attempt_no = COALESCE((
             SELECT MAX(other.attempt_no)
               FROM email_deliveries AS other
              WHERE other.document_id = email_deliveries.document_id
           ), 0) + 1
         WHERE resend_request_id = ?
           AND document_id = ?
           AND to_email = ?
           AND email_type = ?
           AND document_status_at_send = ?
           AND id = (
             SELECT candidate.id
               FROM email_deliveries AS candidate
              WHERE candidate.document_id = email_deliveries.document_id
                AND candidate.email_type = email_deliveries.email_type
              ORDER BY candidate.attempt_no DESC,
                       COALESCE(
                         candidate.finalized_at,
                         candidate.claim_attempted_at,
                         candidate.created_at
                       ) DESC,
                       candidate.created_at DESC,
                       candidate.id DESC
              LIMIT 1
           )
           AND (
             (
               status = 'FAILED'
               AND retry_safe = 1
             )
             OR (
               status = 'PENDING'
               AND provider_dispatch_started_at IS NULL
               AND claim_attempted_at IS NOT NULL
               AND claim_attempted_at < ?
             )
           )
         RETURNING id, idempotency_key, claim_token, attempt_no`
      )
      .bind(
        claimedAt,
        claimToken,
        input.resendRequestId,
        input.documentId,
        input.toEmail,
        input.emailType,
        input.documentStatusAtSend,
        staleBefore
      )
      .first<{
        id: string;
        idempotency_key: string;
        claim_token: string;
        attempt_no: number;
      }>();
    if (reclaimed) {
      return {
        kind: "claimed",
        id: reclaimed.id,
        idempotencyKey: reclaimed.idempotency_key,
        claimToken: reclaimed.claim_token,
        attemptNo: Number(reclaimed.attempt_no)
      };
    }

    const claimed = await this.db
      .prepare(
        `INSERT OR IGNORE INTO email_deliveries (
           id, document_id, to_email, status, provider_response_json,
           email_type, document_status_at_send, claim_attempted_at,
           idempotency_key, claim_token, resend_request_id, attempt_no
         )
         SELECT ?, ?, ?, 'PENDING', '{}', ?, ?, ?, ?, ?, ?,
                COALESCE((
                  SELECT MAX(attempt_no) FROM email_deliveries
                   WHERE document_id = ?
                ), 0) + 1
          WHERE NOT EXISTS (
            SELECT 1
              FROM email_deliveries AS latest
             WHERE latest.id = (
               SELECT candidate.id
                 FROM email_deliveries AS candidate
                WHERE candidate.document_id = ?
                  AND candidate.email_type = ?
                ORDER BY candidate.attempt_no DESC,
                         COALESCE(
                           candidate.finalized_at,
                           candidate.claim_attempted_at,
                           candidate.created_at
                         ) DESC,
                         candidate.created_at DESC,
                         candidate.id DESC
                LIMIT 1
             )
               AND (
                 latest.status = 'PENDING'
                 OR (
                   latest.status = 'FAILED'
                   AND (
                     latest.outcome_class IS NULL
                     OR latest.outcome_class = 'UNKNOWN'
                   )
                 )
               )
          )
         RETURNING id, idempotency_key, claim_token, attempt_no`
      )
      .bind(
        id,
        input.documentId,
        input.toEmail,
        input.emailType,
        input.documentStatusAtSend,
        claimedAt,
        idempotencyKey,
        claimToken,
        input.resendRequestId,
        input.documentId,
        input.documentId,
        input.emailType
      )
      .first<{
        id: string;
        idempotency_key: string;
        claim_token: string;
        attempt_no: number;
      }>();
    if (claimed) {
      return {
        kind: "claimed",
        id: claimed.id,
        idempotencyKey: claimed.idempotency_key,
        claimToken: claimed.claim_token,
        attemptNo: Number(claimed.attempt_no)
      };
    }

    const existing = await this.db
      .prepare(
        `SELECT id, document_id, to_email, status, email_type,
                document_status_at_send, claim_attempted_at,
                provider_dispatch_started_at, outcome_class, attempt_no
           FROM email_deliveries
          WHERE resend_request_id = ?`
      )
      .bind(input.resendRequestId)
      .first<{
        id: string;
        document_id: string;
        to_email: string;
        status: "PENDING" | "SENT" | "FAILED";
        email_type: string;
        document_status_at_send: string;
        claim_attempted_at: string | null;
        provider_dispatch_started_at: string | null;
        outcome_class: EmailDeliveryOutcomeClass | null;
        attempt_no: number;
      }>();
    const attemptNo = Number(existing?.attempt_no ?? 0);
    const sameRequest = existing &&
      existing.document_id === input.documentId &&
      existing.to_email === input.toEmail &&
      existing.email_type === input.emailType &&
      existing.document_status_at_send === input.documentStatusAtSend;
    if (existing && !sameRequest) {
      return { kind: "conflict", id: existing.id, attemptNo };
    }
    if (existing?.status === "SENT") {
      return { kind: "already_sent", id: existing.id, attemptNo };
    }

    const blocker = await this.db
      .prepare(
        `SELECT id, status, outcome_class, attempt_no
           FROM email_deliveries
          WHERE id = (
            SELECT candidate.id
              FROM email_deliveries AS candidate
             WHERE candidate.document_id = ?
               AND candidate.email_type = ?
             ORDER BY candidate.attempt_no DESC,
                      COALESCE(
                        candidate.finalized_at,
                        candidate.claim_attempted_at,
                        candidate.created_at
                      ) DESC,
                      candidate.created_at DESC,
                      candidate.id DESC
             LIMIT 1
          )
            AND (
              status = 'PENDING'
              OR (
                status = 'FAILED'
                AND (outcome_class IS NULL OR outcome_class = 'UNKNOWN')
              )
            )
          LIMIT 1`
      )
      .bind(input.documentId, input.emailType)
      .first<{
        id: string;
        status: "PENDING" | "FAILED";
        outcome_class: EmailDeliveryOutcomeClass | null;
        attempt_no: number;
      }>();
    if (blocker?.status === "PENDING") {
      return {
        kind: "in_progress",
        id: blocker.id,
        attemptNo: Number(blocker.attempt_no)
      };
    }
    if (blocker) {
      return {
        kind: "manual_review",
        id: blocker.id,
        attemptNo: Number(blocker.attempt_no),
        outcomeClass: blocker.outcome_class
      };
    }
    if (!existing) {
      throw new Error("No se pudo recuperar la reserva del reenvío");
    }
    return {
      kind: "manual_review",
      id: existing.id,
      attemptNo,
      outcomeClass: existing.outcome_class
    };
  }

  async markEmailDeliveryDispatchStarted(id: string, claimToken: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `UPDATE email_deliveries
            SET provider_dispatch_started_at = ?
          WHERE id = ?
            AND status = 'PENDING'
            AND claim_token = ?
            AND provider_dispatch_started_at IS NULL
          RETURNING id`
      )
      .bind(nowIso(), id, claimToken)
      .first<{ id: string }>();
    return Boolean(row);
  }

  // Finalize the exact PENDING row won above. This deliberately updates instead of
  // appending a second delivery row, keeping the claim and its outcome one evidence
  // record even when the provider fails.
  async finalizeEmailDeliveryClaim(
    id: string,
    claimToken: string,
    input: {
      status: "SENT" | "FAILED";
      providerResponse?: unknown;
      emailType: string;
      documentStatusAtSend: string;
      templateVersion?: string | null;
      pdfRendererVersion?: string | null;
      pdfSha256?: string | null;
      dteJsonSha256?: string | null;
      providerDeliveryId?: string | null;
      outcomeClass?: EmailDeliveryOutcomeClass | null;
      failureCode?: string | null;
      retrySafe?: boolean;
    }
  ): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE email_deliveries
         SET status = ?, provider_response_json = ?, sent_at = ?,
             finalized_at = ?,
             email_type = ?, document_status_at_send = ?, template_version = ?,
             pdf_renderer_version = ?, pdf_sha256 = ?, dte_json_sha256 = ?,
             provider_delivery_id = ?, outcome_class = ?, failure_code = ?,
             retry_safe = ?
         WHERE id = ? AND status = 'PENDING' AND claim_token = ?`
      )
      .bind(
        input.status,
        JSON.stringify(input.providerResponse ?? {}),
        input.status === "SENT" ? nowIso() : null,
        nowIso(),
        input.emailType,
        input.documentStatusAtSend,
        input.templateVersion ?? null,
        input.pdfRendererVersion ?? null,
        input.pdfSha256 ?? null,
        input.dteJsonSha256 ?? null,
        input.providerDeliveryId ?? null,
        input.outcomeClass ?? null,
        input.failureCode ?? null,
        input.retrySafe ? 1 : 0,
        id,
        claimToken
      )
      .run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new Error(`La reserva de correo ${id} ya no está pendiente`);
    }
  }

  // Rol del usuario objetivo para los guards de gestión de usuarios (un ADMIN nunca
  // toca a un OWNER). Null cuando el usuario no existe.
  async getUserRole(id: string): Promise<string | null> {
    const row = await this.db.prepare("SELECT role FROM users WHERE id = ?").bind(id).first<{ role: string }>();
    return row?.role ?? null;
  }

  async listUsers(): Promise<Array<Record<string, unknown>>> {
    return this.db
      .prepare("SELECT id, email, name, role, disabled_at, created_at, updated_at FROM users ORDER BY created_at DESC LIMIT 100")
      .all<Record<string, unknown>>()
      .then((result) => result.results ?? []);
  }

  async countUsers(): Promise<number> {
    const row = await this.db.prepare("SELECT COUNT(*) AS count FROM users").first<{ count: number }>();
    return row?.count ?? 0;
  }

  async createInitialOwner(input: { email: string; name: string; passwordHash: string; passwordSalt: string }): Promise<Record<string, unknown> | null> {
    const id = newId("user");
    return this.db
      .prepare(
        `INSERT INTO users (id, email, name, role, password_hash, password_salt)
         SELECT ?, ?, ?, 'OWNER', ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM users)
         RETURNING id, email, name, role, disabled_at, created_at, updated_at`
      )
      .bind(id, input.email.toLowerCase(), input.name, input.passwordHash, input.passwordSalt)
      .first<Record<string, unknown>>();
  }

  async createUser(input: { email: string; name: string; role: string; passwordHash: string; passwordSalt: string }): Promise<Record<string, unknown>> {
    const id = newId("user");
    await this.db
      .prepare("INSERT INTO users (id, email, name, role, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, input.email.toLowerCase(), input.name, input.role, input.passwordHash, input.passwordSalt)
      .run();
    const user = await this.db
      .prepare("SELECT id, email, name, role, disabled_at, created_at, updated_at FROM users WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>();
    if (!user) {
      throw new Error("No se pudo leer el usuario creado");
    }
    return user;
  }

  async getUserForLogin(email: string): Promise<Record<string, string> | null> {
    return this.db
      .prepare("SELECT id, email, name, role, password_hash, password_salt, disabled_at, auth_generation FROM users WHERE email = ?")
      .bind(email.toLowerCase())
      .first<Record<string, string>>();
  }

  async claimDonationIntentRateLimit(
    keyHash: string,
    clientIp: string,
    now: string,
    cutoff: string,
    expiresAt: string,
    limit: number
  ): Promise<string | null> {
    // Unattributed rows are legacy activity, including old-version requests that
    // finish after the first new claim. New-version rows carry their claim id.
    const id = newId("rate");
    const row = await this.db
      .prepare(
        `INSERT INTO security_rate_limit_claims (
           id, scope, key_hash, claimed_at, expires_at
         )
         SELECT ?, 'donation_intent', ?, ?, ?
          WHERE (
            (
              SELECT COUNT(*)
                FROM security_rate_limit_claims
               WHERE scope = 'donation_intent'
                 AND key_hash = ?
                 AND claimed_at >= ?
            ) + (
              SELECT COUNT(*)
               FROM donation_intents
               WHERE client_ip = ?
                 AND created_at >= ?
                 AND rate_limit_claim_id IS NULL
            )
          ) < ?
         RETURNING id`
      )
      .bind(id, keyHash, now, expiresAt, keyHash, cutoff, clientIp, cutoff, limit)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  async claimDonationDatosRateLimit(
    keyHash: string,
    now: string,
    cutoff: string,
    expiresAt: string,
    limit: number
  ): Promise<string | null> {
    const id = newId("rate");
    const row = await this.db
      .prepare(
        `INSERT INTO security_rate_limit_claims (
           id, scope, key_hash, claimed_at, expires_at
         )
         SELECT ?, 'donation_datos', ?, ?, ?
          WHERE (
            SELECT COUNT(*)
              FROM security_rate_limit_claims
             WHERE scope = 'donation_datos'
               AND key_hash = ?
               AND claimed_at >= ?
          ) < ?
         RETURNING id`
      )
      .bind(id, keyHash, now, expiresAt, keyHash, cutoff, limit)
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  async claimPasswordResetBudgets(
    pairKeyHash: string,
    accountKeyHash: string,
    accountId: string,
    now: string,
    cutoff: string,
    expiresAt: string,
    pairLimit: number,
    accountLimit: number
  ): Promise<string | null> {
    const id = newId("rate");
    const row = await this.db
      .prepare(
        `INSERT INTO security_rate_limit_claims (
           id, scope, key_hash, subject_key_hash, claimed_at, expires_at
         )
         SELECT ?, 'password_reset', ?, ?, ?, ?
          WHERE (
            SELECT COUNT(*)
              FROM security_rate_limit_claims
             WHERE scope = 'password_reset'
               AND key_hash = ?
               AND claimed_at >= ?
          ) < ?
            AND (
              (
                SELECT COUNT(*)
                  FROM security_rate_limit_claims
                 WHERE scope = 'password_reset'
                   AND subject_key_hash = ?
                   AND claimed_at >= ?
              ) + (
                SELECT COUNT(*)
                  FROM audit_logs AS audit
                  LEFT JOIN security_rate_limit_claims AS legacy_claim
                    ON legacy_claim.id = audit.rate_limit_claim_id
                 WHERE audit.entity_id = ?
                   AND audit.action IN ('PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_EMAIL_FAILED')
                   AND audit.created_at >= ?
                   AND (
                     audit.rate_limit_claim_id IS NULL
                     OR legacy_claim.subject_key_hash IS NULL
                   )
              )
            ) < ?
         RETURNING id`
      )
      .bind(
        id,
        pairKeyHash,
        accountKeyHash,
        now,
        expiresAt,
        pairKeyHash,
        cutoff,
        pairLimit,
        accountKeyHash,
        cutoff,
        accountId,
        cutoff,
        accountLimit
      )
      .first<{ id: string }>();
    return row?.id ?? null;
  }

  async claimLoginAttempt(
    keyHash: string,
    now: string,
    cutoff: string,
    expiresAt: string,
    limit: number
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `INSERT INTO login_rate_limits (
           key_hash, window_started_at, attempt_count, expires_at
         ) VALUES (?, ?, 1, ?)
         ON CONFLICT(key_hash) DO UPDATE SET
           window_started_at = CASE
             WHEN login_rate_limits.window_started_at <= ?
               THEN excluded.window_started_at
             ELSE login_rate_limits.window_started_at
           END,
           attempt_count = CASE
             WHEN login_rate_limits.window_started_at <= ?
               THEN 1
             ELSE login_rate_limits.attempt_count + 1
           END,
           expires_at = CASE
             WHEN login_rate_limits.window_started_at <= ?
               THEN excluded.expires_at
             ELSE login_rate_limits.expires_at
           END
         WHERE login_rate_limits.window_started_at <= ?
            OR login_rate_limits.attempt_count < ?
         RETURNING attempt_count`
      )
      .bind(keyHash, now, expiresAt, cutoff, cutoff, cutoff, cutoff, limit)
      .first<{ attempt_count: number }>();
    return row !== null;
  }

  async deleteExpiredLoginRateLimits(now: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM login_rate_limits WHERE expires_at <= ?")
      .bind(now)
      .run();
  }

  async deleteExpiredSecurityRateLimitClaims(now: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM security_rate_limit_claims WHERE expires_at <= ?")
      .bind(now)
      .run();
  }

  async createSessionIfCredentialsCurrent(input: {
    userId: string;
    expectedPasswordHash: string;
    expectedPasswordSalt: string;
    expectedEmail: string;
    expectedAuthGeneration: number;
    tokenHash: string;
    expiresAt: string;
  }): Promise<boolean> {
    const id = newId("session");
    const createdAt = nowIso();
    const guard = [
      input.userId,
      input.expectedPasswordHash,
      input.expectedPasswordSalt,
      input.expectedEmail,
      input.expectedAuthGeneration
    ] as const;
    const results = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM sessions
            WHERE user_id = ?
              AND (revoked_at IS NOT NULL OR expires_at <= ?)
              AND EXISTS (
                SELECT 1 FROM users
                 WHERE id = ?
                   AND disabled_at IS NULL
                   AND password_hash = ?
                   AND password_salt = ?
                   AND email = ?
                   AND auth_generation = ?
              )`
        )
        .bind(input.userId, createdAt, ...guard),
      this.db
        .prepare(
          `DELETE FROM sessions
            WHERE id IN (
              SELECT id FROM sessions
               WHERE user_id = ?
                 AND revoked_at IS NULL
                 AND expires_at > ?
               ORDER BY created_at DESC, id DESC
               LIMIT -1 OFFSET 7
            )
              AND EXISTS (
                SELECT 1 FROM users
                 WHERE id = ?
                   AND disabled_at IS NULL
                   AND password_hash = ?
                   AND password_salt = ?
                   AND email = ?
                   AND auth_generation = ?
              )`
        )
        .bind(input.userId, createdAt, ...guard),
      this.db
        .prepare(
          `INSERT INTO sessions (
             id, user_id, token_hash, expires_at, created_at
           )
           SELECT ?, id, ?, ?, ?
             FROM users
            WHERE id = ?
              AND disabled_at IS NULL
              AND password_hash = ?
              AND password_salt = ?
              AND email = ?
              AND auth_generation = ?`
        )
        .bind(
          id,
          input.tokenHash,
          input.expiresAt,
          createdAt,
          ...guard
        )
    ]);
    return Number(results[2]?.meta?.changes ?? 0) === 1;
  }

  async getSessionUser(tokenHash: string): Promise<Record<string, string> | null> {
    return this.db
      .prepare(
        `SELECT users.id, users.email, users.name, users.role
         FROM sessions
         JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ?
           AND sessions.revoked_at IS NULL
           AND sessions.expires_at > ?
           AND users.disabled_at IS NULL`
      )
      .bind(tokenHash, nowIso())
      .first<Record<string, string>>();
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE sessions
            SET revoked_at = ?
          WHERE token_hash = ?
            AND revoked_at IS NULL`
      )
      .bind(nowIso(), tokenHash)
      .run();
  }

  async updateUser(
    id: string,
    input: { role?: string; disabled?: boolean; name?: string; email?: string },
    allowOwnerTarget = false
  ): Promise<Record<string, unknown>> {
    const existing = await this.db.prepare("SELECT id, email, name, role, disabled_at, auth_generation FROM users WHERE id = ?").bind(id).first<Record<string, unknown>>();
    if (!existing) {
      throw new Error("Usuario no encontrado");
    }
    const changedAt = nowIso();
    const currentEmail = String(existing.email).toLowerCase();
    const nextEmail = String(input.email ?? existing.email).trim().toLowerCase();
    const wasDisabled = existing.disabled_at != null && existing.disabled_at !== "";
    const willBeDisabled = input.disabled === undefined ? wasDisabled : input.disabled;
    const nextDisabledAt =
      input.disabled === undefined
        ? existing.disabled_at
        : willBeDisabled
          ? changedAt
          : null;
    const invalidatesCapabilities =
      nextEmail !== currentEmail || willBeDisabled !== wasDisabled;
    const observedAuthGeneration = Number(existing.auth_generation ?? 0);
    const nextAuthGeneration = observedAuthGeneration + (invalidatesCapabilities ? 1 : 0);

    const update = this.db
      .prepare(
        `UPDATE users
            SET name = ?, email = ?, role = ?, disabled_at = ?, updated_at = ?,
                auth_generation = auth_generation + ?
          WHERE id = ?
            AND (? = 1 OR role IN ('VIEWER','OPERATOR','ADMIN'))
            AND email = ?
            AND disabled_at IS ?
            AND auth_generation = ?
            AND name = ?
            AND role = ?`
      )
      .bind(
        input.name ?? existing.name,
        nextEmail,
        input.role ?? existing.role,
        nextDisabledAt,
        changedAt,
        invalidatesCapabilities ? 1 : 0,
        id,
        allowOwnerTarget ? 1 : 0,
        currentEmail,
        existing.disabled_at ?? null,
        observedAuthGeneration,
        existing.name,
        existing.role
      );

    if (invalidatesCapabilities) {
      const results = await this.db.batch([
        update,
        this.db
          .prepare(
            `UPDATE sessions
                SET revoked_at = ?
              WHERE user_id = ?
                AND revoked_at IS NULL
                AND EXISTS (
                  SELECT 1 FROM users
                   WHERE id = ?
                     AND email = ?
                     AND disabled_at IS ?
                     AND auth_generation = ?
                )`
          )
          .bind(changedAt, id, id, nextEmail, nextDisabledAt, nextAuthGeneration),
        this.db
          .prepare(
            `UPDATE password_reset_tokens
                SET used_at = ?
              WHERE user_id = ?
                AND used_at IS NULL
                AND EXISTS (
                  SELECT 1 FROM users
                   WHERE id = ?
                     AND email = ?
                     AND disabled_at IS ?
                     AND auth_generation = ?
                )`
          )
          .bind(changedAt, id, id, nextEmail, nextDisabledAt, nextAuthGeneration)
      ]);
      if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
        await this.throwUserMutationFailure(id, allowOwnerTarget);
      }
    } else {
      const result = await update.run();
      if (Number(result.meta?.changes ?? 0) !== 1) {
        await this.throwUserMutationFailure(id, allowOwnerTarget);
      }
    }
    const updated = await this.db
      .prepare("SELECT id, email, name, role, disabled_at, created_at, updated_at FROM users WHERE id = ?")
      .bind(id)
      .first<Record<string, unknown>>();
    if (!updated) {
      throw new Error("No se pudo leer el usuario actualizado");
    }
    return updated;
  }

  private async throwUserMutationFailure(id: string, allowOwnerTarget: boolean): Promise<never> {
    const currentRole = await this.getUserRole(id);
    if (currentRole === null) {
      throw new Error("Usuario no encontrado");
    }
    if (!allowOwnerTarget && currentRole === "OWNER") {
      throw new OwnerTargetProtectedError();
    }
    throw new UserMutationConflictError();
  }

  async listStalledApprovedWompiEvents(cutoffIso: string): Promise<Array<Record<string, unknown>>> {
    // wompi_events has no created_at column — it records received_at (migrations/0001_init.sql).
    const rows = await this.db
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

  async countAuditEntries(action: string, entityId: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = ? AND entity_id = ?")
      .bind(action, entityId)
      .first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  async claimOperationalAlertDelivery(input: {
    kind: string;
    entityType: string;
    entityId: string;
    incidentId: string;
    channel: "email";
    targetKey: string;
  }): Promise<OperationalAlertDeliveryClaim> {
    const id = newId("alert_delivery");
    const claimToken = newId("alert_claim");
    const claimedAt = nowIso();
    const staleBefore = new Date(Date.now() - EMAIL_DELIVERY_CLAIM_LEASE_MS).toISOString();
    const entityKeyHash = await sha256Hex(
      utf8Bytes(`${input.entityType}:${input.entityId}`)
    );
    const targetKeyHash = await sha256Hex(utf8Bytes(input.targetKey));
    const claimed = await this.db
      .prepare(
        `INSERT INTO operational_alert_deliveries (
           id, kind, entity_type, entity_key_hash, incident_id, channel,
           target_key_hash, status, claim_token, claim_attempted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
         ON CONFLICT(
           kind, entity_type, entity_key_hash, incident_id, channel, target_key_hash
         ) DO UPDATE SET
           status = 'PENDING',
           claim_token = excluded.claim_token,
           claim_attempted_at = excluded.claim_attempted_at,
           provider_dispatch_started_at = NULL,
           finalized_at = NULL,
           outcome_class = NULL,
           failure_code = NULL,
           retry_safe = 0
         WHERE (
           operational_alert_deliveries.status = 'FAILED'
           AND operational_alert_deliveries.retry_safe = 1
         ) OR (
           operational_alert_deliveries.status = 'PENDING'
           AND operational_alert_deliveries.provider_dispatch_started_at IS NULL
           AND operational_alert_deliveries.claim_attempted_at < ?
         )
         RETURNING id, claim_token`
      )
      .bind(
        id,
        input.kind,
        input.entityType,
        entityKeyHash,
        input.incidentId,
        input.channel,
        targetKeyHash,
        claimToken,
        claimedAt,
        staleBefore
      )
      .first<{ id: string; claim_token: string }>();
    if (claimed) {
      return {
        kind: "claimed",
        id: claimed.id,
        claimToken: claimed.claim_token
      };
    }
    const existing = await this.db
      .prepare(
        `SELECT id, status, outcome_class
           FROM operational_alert_deliveries
          WHERE kind = ?
            AND entity_type = ?
            AND entity_key_hash = ?
            AND incident_id = ?
            AND channel = ?
            AND target_key_hash = ?`
      )
      .bind(
        input.kind,
        input.entityType,
        entityKeyHash,
        input.incidentId,
        input.channel,
        targetKeyHash
      )
      .first<{
        id: string;
        status: "PENDING" | "SENT" | "FAILED";
        outcome_class: EmailDeliveryOutcomeClass | null;
      }>();
    if (!existing) {
      throw new Error("No se pudo recuperar la reserva de alerta");
    }
    if (existing.status === "SENT") {
      return { kind: "already_sent", id: existing.id };
    }
    if (existing.status === "PENDING") {
      return { kind: "in_progress", id: existing.id };
    }
    return {
      kind: "manual_review",
      id: existing.id,
      outcomeClass: existing.outcome_class
    };
  }

  async markOperationalAlertDispatchStarted(
    id: string,
    claimToken: string
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `UPDATE operational_alert_deliveries
            SET provider_dispatch_started_at = ?
          WHERE id = ?
            AND status = 'PENDING'
            AND claim_token = ?
            AND provider_dispatch_started_at IS NULL
          RETURNING id`
      )
      .bind(nowIso(), id, claimToken)
      .first<{ id: string }>();
    return Boolean(row);
  }

  async finalizeOperationalAlertDelivery(
    id: string,
    claimToken: string,
    input: {
      status: "SENT" | "FAILED";
      outcomeClass?: EmailDeliveryOutcomeClass | null;
      failureCode?: string | null;
      retrySafe?: boolean;
    }
  ): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE operational_alert_deliveries
            SET status = ?, finalized_at = ?, outcome_class = ?,
                failure_code = ?, retry_safe = ?
          WHERE id = ?
            AND status = 'PENDING'
            AND claim_token = ?`
      )
      .bind(
        input.status,
        nowIso(),
        input.outcomeClass ?? null,
        input.failureCode ?? null,
        input.retrySafe ? 1 : 0,
        id,
        claimToken
      )
      .run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      throw new Error(`La reserva de alerta ${id} ya no está pendiente`);
    }
  }

  // Windowed variant for the auth rate limiter: counts (action, entity_id) audits
  // whose created_at is at or after `sinceIso`. Reads use the (action, entity_id,
  // created_at) index added in migration 0008.
  async countAuditEntriesSince(action: string, entityId: string, sinceIso: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = ? AND entity_id = ? AND created_at >= ?")
      .bind(action, entityId, sinceIso)
      .first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  // Same rolling-window count as above, but additionally scoped to the caller's IP
  // (null-safe via IS). Used by the login throttle so an attacker cannot lock out a
  // victim's email by seeding failures from a different address.
  async countAuditEntriesSinceForIp(action: string, entityId: string, actorIp: string | null, sinceIso: string): Promise<number> {
    const row = await this.db
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
  async listRowsCreatedBetween(
    table: RetentionTable,
    range: { startIso: string; endIso: string },
    cursor: RetentionCursor | null,
    limit = RETENTION_PAGE_SIZE
  ): Promise<Array<Record<string, unknown>>> {
    const column = "created_at";
    const conditions = [`${column} >= ?`, `${column} < ?`];
    const bindings: Array<string | number> = [range.startIso, range.endIso];
    if (cursor) {
      conditions.push(`(${column}, id) > (?, ?)`);
      bindings.push(cursor.createdAt, cursor.id);
    }
    const rows = await this.db
      .prepare(`SELECT * FROM ${table} WHERE ${conditions.join(" AND ")} ORDER BY ${column} ASC, id ASC LIMIT ?`)
      .bind(...bindings, limit)
      .all<Record<string, unknown>>();
    const results = rows.results ?? [];
    return table === "audit_logs" ? redactSensitiveAuditRows(results) : results;
  }

  // Full-snapshot paged reads for mutable Wompi lifecycle state and the small
  // contingency tables. Wompi has received_at rather than created_at, but retains
  // the same bounded (timestamp, id) cursor shape.
  async listAllRowsPaged(table: RetentionSnapshotTable, cursor: RetentionCursor | null, limit = RETENTION_PAGE_SIZE): Promise<Array<Record<string, unknown>>> {
    const column = retentionSnapshotTimestampColumn(table);
    const conditions: string[] = [];
    const bindings: Array<string | number> = [];
    if (cursor) {
      conditions.push(`(${column}, id) > (?, ?)`);
      bindings.push(cursor.createdAt, cursor.id);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await this.db
      .prepare(`SELECT * FROM ${table} ${where} ORDER BY ${column} ASC, id ASC LIMIT ?`)
      .bind(...bindings, limit)
      .all<Record<string, unknown>>();
    return rows.results ?? [];
  }

  async listDocumentSequencesPaged(
    cursor: DocumentSequenceRetentionCursor | null,
    limit = RETENTION_PAGE_SIZE
  ): Promise<Array<Record<string, unknown>>> {
    const conditions: string[] = [];
    const bindings: Array<string | number> = [];
    if (cursor) {
      conditions.push("(environment, control_prefix) > (?, ?)");
      bindings.push(cursor.environment, cursor.controlPrefix);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const rows = await this.db
      .prepare(
        `SELECT environment, control_prefix, next_value
         FROM document_sequences ${where}
         ORDER BY environment ASC, control_prefix ASC LIMIT ?`
      )
      .bind(...bindings, limit)
      .all<Record<string, unknown>>();
    return rows.results ?? [];
  }

  async createPasswordResetToken(
    userId: string,
    tokenHash: string,
    expiresAt: string,
    expectedEmail: string,
    expectedAuthGeneration: number,
    expectedPasswordHash: string,
    expectedPasswordSalt: string
  ): Promise<string | null> {
    const id = newId("reset");
    const created = await this.db
      .prepare(
        `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
         SELECT ?, id, ?, ?
         FROM users
         WHERE id = ? AND disabled_at IS NULL
           AND email = ? AND auth_generation = ?
           AND password_hash = ? AND password_salt = ?
         RETURNING id`
      )
      .bind(
        id,
        tokenHash,
        expiresAt,
        userId,
        expectedEmail,
        expectedAuthGeneration,
        expectedPasswordHash,
        expectedPasswordSalt
      )
      .first<{ id: string }>();
    return created?.id ?? null;
  }

  async invalidatePasswordResetToken(id: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE password_reset_tokens
            SET used_at = ?
          WHERE id = ?
            AND used_at IS NULL`
      )
      .bind(nowIso(), id)
      .run();
  }

  async getActivePasswordResetUser(tokenHash: string): Promise<Record<string, string> | null> {
    return this.db
      .prepare(
        `SELECT users.id, users.email, users.name, users.role, users.id AS user_id, password_reset_tokens.id AS token_id
         FROM password_reset_tokens
         JOIN users ON users.id = password_reset_tokens.user_id
         WHERE password_reset_tokens.token_hash = ?
           AND password_reset_tokens.used_at IS NULL
           AND password_reset_tokens.expires_at > ?
           AND users.disabled_at IS NULL`
      )
      .bind(tokenHash, nowIso())
      .first<Record<string, string>>();
  }

  async resetPasswordWithToken(
    userId: string,
    tokenHash: string,
    passwordHash: string,
    passwordSalt: string
  ): Promise<boolean> {
    const changedAt = nowIso();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE users
              SET password_hash = ?, password_salt = ?, updated_at = ?
            WHERE id = ?
              AND disabled_at IS NULL
              AND EXISTS (
                SELECT 1
                  FROM password_reset_tokens
                 WHERE user_id = ?
                   AND token_hash = ?
                   AND used_at IS NULL
                   AND expires_at > ?
              )`
        )
        .bind(passwordHash, passwordSalt, changedAt, userId, userId, tokenHash, changedAt),
      this.db
        .prepare(
          `UPDATE sessions
              SET revoked_at = ?
            WHERE user_id = ?
              AND revoked_at IS NULL
              AND EXISTS (
                SELECT 1
                  FROM users
                 WHERE id = ?
                   AND password_hash = ?
                   AND password_salt = ?
                   AND updated_at = ?
              )`
        )
        .bind(changedAt, userId, userId, passwordHash, passwordSalt, changedAt),
      this.db
        .prepare(
          `UPDATE password_reset_tokens
              SET used_at = ?
            WHERE user_id = ?
              AND used_at IS NULL
              AND EXISTS (
                SELECT 1
                  FROM users
                 WHERE id = ?
                   AND password_hash = ?
                   AND password_salt = ?
                   AND updated_at = ?
              )`
        )
        .bind(changedAt, userId, userId, passwordHash, passwordSalt, changedAt)
    ]);
    return Number(results[0]?.meta?.changes ?? 0) === 1;
  }

  async setUserPassword(
    userId: string,
    passwordHash: string,
    passwordSalt: string,
    allowOwnerTarget = false
  ): Promise<boolean> {
    const changedAt = nowIso();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE users
              SET password_hash = ?, password_salt = ?, updated_at = ?
            WHERE id = ?
              AND (? = 1 OR role IN ('VIEWER','OPERATOR','ADMIN'))`
        )
        .bind(passwordHash, passwordSalt, changedAt, userId, allowOwnerTarget ? 1 : 0),
      this.db
        .prepare(
          `UPDATE sessions
              SET revoked_at = ?
            WHERE user_id = ?
              AND revoked_at IS NULL
              AND EXISTS (
                SELECT 1
                  FROM users
                 WHERE id = ?
                   AND password_hash = ?
                   AND password_salt = ?
                   AND updated_at = ?
              )`
        )
        .bind(changedAt, userId, userId, passwordHash, passwordSalt, changedAt),
      this.db
        .prepare(
          `UPDATE password_reset_tokens
              SET used_at = ?
            WHERE user_id = ?
              AND used_at IS NULL
              AND EXISTS (
                SELECT 1
                  FROM users
                 WHERE id = ?
                   AND password_hash = ?
                   AND password_salt = ?
                   AND updated_at = ?
              )`
        )
        .bind(changedAt, userId, userId, passwordHash, passwordSalt, changedAt)
    ]);
    const changed = Number(results[0]?.meta?.changes ?? 0) === 1;
    if (!changed && !allowOwnerTarget && (await this.getUserRole(userId)) === "OWNER") {
      throw new OwnerTargetProtectedError();
    }
    return changed;
  }

  // Opportunistic PBKDF2 rehash on successful login. Unlike setUserPassword this does
  // NOT revoke sessions — the credential is unchanged, only its stored encoding. The
  // update is compare-and-swap guarded so a stale login cannot overwrite a concurrent
  // password reset/change that landed after verification.
  async updateUserPasswordHashIfCurrent(
    userId: string,
    currentPasswordHash: string,
    currentPasswordSalt: string,
    passwordHash: string,
    passwordSalt: string
  ): Promise<boolean> {
    const updated = await this.db
      .prepare(
        `UPDATE users
            SET password_hash = ?, password_salt = ?, updated_at = ?
          WHERE id = ? AND password_hash = ? AND password_salt = ?
          RETURNING id`
      )
      .bind(passwordHash, passwordSalt, nowIso(), userId, currentPasswordHash, currentPasswordSalt)
      .first<{ id: string }>();
    return Boolean(updated);
  }
}
