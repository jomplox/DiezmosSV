import type { Ambiente, ContingencyBatchLineRecord, ContingencyBatchRecord, DonationGiftType, DonationIntentDocumentType, DonationIntentListItem, DonationIntentRecord, DteDocumentRecord, WompiDocumentIdentifiers, WompiEventRecord, WompiIssuanceFailureItem, WompiPaymentLink, WompiWebhook } from "../types";
import { nowIso } from "../utils/dates";
import { generationCode, newId, normalizeControlPrefix, numeroControl } from "../utils/ids";
import { amountCents, donorName } from "../domain/wompi";
import { normalizeAuditIp, serializeAuditContext, type AuditRequestContext } from "../services/requestContext";
import type { ContactSourceRow } from "../services/contacts";
import { sha256Hex, utf8Bytes } from "../utils/encoding";

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

// Rows one cron sweep may expire (and deactivate the Wompi links of) per tick. Caps
// the outbound Wompi fanout so attacker-created expired intents cannot translate into
// an unbounded burst of API calls in a single invocation; the remainder is picked up
// by the next tick.
export const INTENT_EXPIRY_SWEEP_LIMIT = 100;
const POST_ACCEPT_FINALIZATION_STALE_MS = 15 * 60 * 1000;
const WOMPI_ISSUANCE_CLAIM_STALE_MS = 15 * 60 * 1000;
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
const EMAIL_DELIVERY_CLAIM_LEASE_MS = 15 * 60 * 1000;

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

const ISSUANCE_RETRIES_EXHAUSTED_CODE = "ISSUANCE_RETRIES_EXHAUSTED";
const ISSUANCE_RETRIES_EXHAUSTED_MESSAGE =
  "El mensaje de emisión agotó sus reintentos antes de crear el CDE.";

export function legacyIssuanceAttemptId(wompiEventId: string): string {
  return `legacy:${wompiEventId}`;
}

const WOMPI_ISSUANCE_FAILURE_COLUMNS = `id, environment, amount_cents, donor_name, donor_email,
  received_at, issuance_status, issuance_attempt_count, issuance_error_code,
  issuance_error_message, issuance_last_attempt_at, issuance_failed_at,
  issuance_dead_lettered_at, reserved_numero_control`;

export const RETENTION_WINDOWED_TABLES = ["dte_documents", "donation_intents", "dte_events", "email_deliveries", "audit_logs"] as const;
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

// The alert-email setting is OWNER-only, but its ALERT_EMAIL_UPDATED audit rows are
// readable by lower roles through the audit trail. Newer writes never record the
// address, but rows written before that fix still carry it in the summary/metadata, so
// the read path scrubs those columns for the app_setting/alert_email entity regardless
// of role. It keeps that an update happened; it only drops the address value.
function redactSensitiveAuditRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => {
    if (row.entity_type !== "app_setting" || row.entity_id !== "alert_email") {
      return row;
    }
    return {
      ...row,
      summary: row.action === "ALERT_EMAIL_UPDATED" ? "Correo de alertas actualizado" : row.summary,
      metadata_json: "{}"
    };
  });
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
    const row = await this.db.prepare("SELECT value FROM app_settings WHERE key = ?").bind(key).first<{ value: string }>();
    return row?.value ?? null;
  }

  async setSetting(key: string, value: string, updatedBy?: string | null): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO app_settings (key, value, updated_by, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`
      )
      .bind(key, value, updatedBy ?? null, nowIso())
      .run();
  }

  async insertWompiEvent(payload: WompiWebhook, rawBody: string, headers: Record<string, string>, environment: Ambiente): Promise<{ record: WompiEventRecord; inserted: boolean }> {
    const existing = await this.getWompiEventByTransaction(payload.IdTransaccion);
    if (existing) {
      return { record: existing, inserted: false };
    }
    const id = newId("wompi");
    await this.db
      .prepare(
        `INSERT INTO wompi_events (
          id, transaction_id, environment, result, amount_cents, donor_email, donor_name, raw_body, headers_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        payload.IdTransaccion,
        environment,
        payload.ResultadoTransaccion,
        amountCents(payload),
        payload.Cliente?.EMail ?? null,
        donorName(payload),
        rawBody,
        JSON.stringify(headers)
      )
      .run();
    const record = await this.getWompiEventById(id);
    if (!record) {
      throw new Error("No se pudo leer el evento Wompi creado");
    }
    return { record, inserted: true };
  }

  async getWompiEventById(id: string): Promise<WompiEventRecord | null> {
    return this.db.prepare("SELECT * FROM wompi_events WHERE id = ?").bind(id).first<WompiEventRecord>();
  }

  async getWompiEventByTransaction(transactionId: string): Promise<WompiEventRecord | null> {
    return this.db.prepare("SELECT * FROM wompi_events WHERE transaction_id = ?").bind(transactionId).first<WompiEventRecord>();
  }

  async claimWompiEventIssuance(id: string, claimId: string): Promise<boolean> {
    const claimedAt = nowIso();
    const staleBefore = new Date(Date.now() - WOMPI_ISSUANCE_CLAIM_STALE_MS).toISOString();
    const row = await this.db
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

  async releaseWompiEventIssuance(id: string, claimId: string): Promise<boolean> {
    const row = await this.db
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

  async listWompiIssuanceFailures(limit = 100): Promise<WompiIssuanceFailureItem[]> {
    const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const rows = await this.db
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

  async getWompiIssuanceFailureById(wompiEventId: string): Promise<WompiIssuanceFailureItem | null> {
    return this.db
      .prepare(`SELECT ${WOMPI_ISSUANCE_FAILURE_COLUMNS} FROM wompi_events WHERE id = ?`)
      .bind(wompiEventId)
      .first<WompiIssuanceFailureItem>();
  }

  async claimInitialWompiIssuanceAttempt(wompiEventId: string): Promise<string | null> {
    const attemptId = newId("issuance_attempt");
    const queuedAt = nowIso();
    const result = await this.db
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

  async claimWompiIssuanceRetry(wompiEventId: string, actorId: string): Promise<string | null> {
    const attemptId = newId("issuance_attempt");
    const retryQueuedAt = nowIso();
    const actorIp = normalizeAuditIp(this.auditContext?.ip ?? null);
    const actorContext = serializeAuditContext(this.auditContext?.context);
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE wompi_events
           SET issuance_status = 'RETRY_QUEUED',
               issuance_attempt_id = ?,
               issuance_last_attempt_at = ?
           WHERE id = ?
             AND created_document_id IS NULL
             AND issuance_status IN ('FAILED', 'DEAD_LETTERED')`
        )
        .bind(attemptId, retryQueuedAt, wompiEventId),
      this.db
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

  async claimStalledWompiIssuanceAttempt(
    wompiEventId: string,
    currentAttemptId: string | null,
    staleBefore: string
  ): Promise<string | null> {
    const attemptId = newId("issuance_attempt");
    const queuedAt = nowIso();
    // Operator retries from DEAD_LETTERED keep processed_at as historical evidence,
    // so tokenized work is fenced by attempt + eligible status. Only the legacy
    // null-token path also requires processed_at to remain null.
    const statement = currentAttemptId
      ? this.db.prepare(
          `UPDATE wompi_events
           SET issuance_status = 'RETRY_QUEUED',
               issuance_attempt_id = ?,
               issuance_last_attempt_at = ?
           WHERE id = ?
             AND created_document_id IS NULL
             AND issuance_attempt_id = ?
             AND issuance_status IN ('RETRY_QUEUED', 'PROCESSING')
             AND COALESCE(issuance_last_attempt_at, received_at) < ?`
        ).bind(attemptId, queuedAt, wompiEventId, currentAttemptId, staleBefore)
      : this.db.prepare(
          `UPDATE wompi_events
           SET issuance_status = 'RETRY_QUEUED',
               issuance_attempt_id = ?,
               issuance_last_attempt_at = ?
           WHERE id = ?
             AND created_document_id IS NULL
             AND issuance_attempt_id IS NULL
             AND processed_at IS NULL
             AND issuance_status IS NULL
             AND COALESCE(issuance_last_attempt_at, received_at) < ?`
        ).bind(attemptId, queuedAt, wompiEventId, staleBefore);
    const result = await statement.run();
    return Number(result.meta?.changes ?? 0) === 1 ? attemptId : null;
  }

  async createWompiAttemptAudit(input: {
    wompiEventId: string;
    attemptId: string;
    action: string;
    summary: string;
    metadata?: unknown;
  }): Promise<boolean> {
    const result = await this.db
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

  async reserveWompiDocumentIdentifiers(
    wompiEventId: string,
    environment: Ambiente,
    controlPrefix: string
  ): Promise<WompiDocumentIdentifiers> {
    const normalizedPrefix = normalizeControlPrefix(controlPrefix);

    const event = await this.getWompiEventById(wompiEventId);
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

    await this.db
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

    const reservedEvent = await this.getWompiEventById(wompiEventId);
    if (!reservedEvent || reservedEvent.environment !== environment) {
      throw new Error("No se pudo leer la reserva de identificadores Wompi");
    }
    const reserved = wompiDocumentIdentifiersForPrefix(reservedEvent, normalizedPrefix);
    if (!reserved) {
      throw new Error("No se pudo reservar los identificadores del documento Wompi");
    }
    return reserved;
  }

  async markWompiIssuanceProcessing(
    wompiEventId: string,
    attemptId: string,
    legacyMessage = false
  ): Promise<boolean> {
    const attemptedAt = nowIso();
    const statement = legacyMessage
      ? this.db.prepare(
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
      : this.db.prepare(
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

  async recordWompiIssuanceFailure(
    wompiEventId: string,
    attemptId: string,
    evidence: { code: string; message: string }
  ): Promise<boolean> {
    const failedAt = nowIso();
    const results = await this.db.batch([
      this.db
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
      this.db
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

  async markWompiIssuanceDeadLettered(
    wompiEventId: string,
    attemptId: string,
    legacyMessage = false
  ): Promise<boolean> {
    const deadLetteredAt = nowIso();
    const attemptPredicate = legacyMessage
      ? "(issuance_attempt_id IS NULL OR issuance_attempt_id = ?)"
      : "issuance_attempt_id = ?";
    const row = await this.db
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

  async markWompiIssuanceIgnored(wompiEventId: string): Promise<void> {
    const processedAt = nowIso();
    await this.db
      .prepare(
        `UPDATE wompi_events
         SET issuance_status = 'IGNORED',
             processed_at = COALESCE(processed_at, ?)
         WHERE id = ? AND created_document_id IS NULL`
      )
      .bind(processedAt, wompiEventId)
      .run();
  }

  async createDonationIntent(input: {
    id: string;
    amountCents: number;
    // Name and email are collected on Wompi's sheet (not the /donar form), so both
    // are nullable; donorName carries the razón social for NIT (36) intents only.
    donorName: string | null;
    donorDocumentType: DonationIntentDocumentType;
    // Document + address are nullable so a DRAFT intent (background link mint on
    // Paso 1→2, before the fiscal data exists) can be persisted; the /datos endpoint
    // fills them in later. A full create passes them all non-null.
    donorDocument: string | null;
    donorEmail: string | null;
    donorPhone: string | null;
    direccionDepartamento: string | null;
    direccionMunicipio: string | null;
    direccionDistrito: string | null;
    direccionComplemento: string | null;
    // CAT-020 country for the foreign path (00/00/00 geography); null domestic.
    donorPais: string | null;
    // Diezmo/Ofrenda (SV flow only); null for legacy and US paths.
    giftType: DonationGiftType | null;
    clientIp: string | null;
    expiresAt: string;
    datosTokenHash: string | null;
    rateLimitClaimId: string;
  }): Promise<DonationIntentRecord> {
    // Capability hash is appended after gift_type so the established donor-field
    // bindings remain stable. Full creates pass NULL; only drafts receive a hash.
    await this.db
      .prepare(
        `INSERT INTO donation_intents (
          id, status, amount_cents, donor_name, donor_document_type, donor_document, donor_email, donor_phone,
          direccion_departamento, direccion_municipio, direccion_distrito, direccion_complemento, donor_pais, client_ip, expires_at, gift_type,
          datos_token_hash, rate_limit_claim_id
        ) VALUES (?, 'PENDING', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        input.amountCents,
        input.donorName,
        input.donorDocumentType,
        input.donorDocument,
        input.donorEmail,
        input.donorPhone,
        input.direccionDepartamento,
        input.direccionMunicipio,
        input.direccionDistrito,
        input.direccionComplemento,
        input.donorPais,
        input.clientIp,
        input.expiresAt,
        input.giftType,
        input.datosTokenHash,
        input.rateLimitClaimId
      )
      .run();
    const record = await this.getDonationIntent(input.id);
    if (!record) {
      throw new Error("No se pudo leer la intención de donación creada");
    }
    return record;
  }

  async getDonationIntent(id: string): Promise<DonationIntentRecord | null> {
    return this.db.prepare("SELECT * FROM donation_intents WHERE id = ?").bind(id).first<DonationIntentRecord>();
  }

  async attachIntentLink(id: string, link: WompiPaymentLink): Promise<void> {
    await this.db
      .prepare(
        `UPDATE donation_intents
         SET wompi_id_enlace = ?, wompi_url_enlace = ?, wompi_url_enlace_largo = ?, status = 'LINK_CREATED', updated_at = ?
         WHERE id = ?`
      )
      .bind(link.idEnlace, link.urlEnlace, link.urlEnlaceLargo, nowIso(), id)
      .run();
  }

  // Attaches the donor's fiscal data to a minted draft (the /datos completion). Amount,
  // gift type, status, and the Wompi link are deliberately NOT in the SET clause: those
  // were locked when the link was minted, and datos must never move them.
  async applyIntentDatosWithCapability(
    id: string,
    datosTokenHash: string,
    data: {
      donorDocumentType: DonationIntentDocumentType;
      donorDocument: string;
      donorName: string | null;
      donorPhone: string | null;
      direccionDepartamento: string;
      direccionMunicipio: string;
      direccionDistrito: string;
      direccionComplemento: string;
      donorPais: string | null;
    }
  ): Promise<{ id: string; urlEnlace: string; urlEnlaceLargo: string } | null> {
    const changedAt = nowIso();
    const updated = await this.db
      .prepare(
        `UPDATE donation_intents
         SET donor_document_type = ?, donor_document = ?, donor_name = ?, donor_phone = ?,
             direccion_departamento = ?, direccion_municipio = ?, direccion_distrito = ?,
             direccion_complemento = ?, donor_pais = ?, datos_token_hash = NULL, updated_at = ?
         WHERE id = ?
           AND datos_token_hash = ?
           AND status = 'LINK_CREATED'
           AND paid_at IS NULL
           AND donor_document IS NULL
           AND expires_at > ?
         RETURNING id, wompi_url_enlace, wompi_url_enlace_largo`
      )
      .bind(
        data.donorDocumentType,
        data.donorDocument,
        data.donorName,
        data.donorPhone,
        data.direccionDepartamento,
        data.direccionMunicipio,
        data.direccionDistrito,
        data.direccionComplemento,
        data.donorPais,
        changedAt,
        id,
        datosTokenHash,
        changedAt
      )
      .first<{
        id: string;
        wompi_url_enlace: string | null;
        wompi_url_enlace_largo: string | null;
      }>();
    if (
      updated?.id !== id ||
      !updated.wompi_url_enlace ||
      !updated.wompi_url_enlace_largo
    ) {
      return null;
    }
    return {
      id: updated.id,
      urlEnlace: updated.wompi_url_enlace,
      urlEnlaceLargo: updated.wompi_url_enlace_largo
    };
  }

  async markIntentCompleted(id: string, documentId: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE donation_intents
            SET status = 'COMPLETED', document_id = ?, updated_at = ?
          WHERE id = ?
            AND (
              (status IN ('LINK_CREATED', 'EXPIRED') AND document_id IS NULL)
              OR (status = 'COMPLETED' AND document_id = ?)
            )`
      )
      .bind(documentId, nowIso(), id, documentId)
      .run();
    return Number(result.meta?.changes ?? 0) === 1;
  }

  async completeIntentForPostAcceptOwner(
    id: string,
    documentId: string,
    claimId: string
  ): Promise<boolean> {
    const updatedAt = nowIso();
    const row = await this.db
      .prepare(
        `UPDATE donation_intents
            SET status = 'COMPLETED', document_id = ?, updated_at = ?
          WHERE id = ?
            AND (
              (status IN ('LINK_CREATED', 'EXPIRED') AND document_id IS NULL)
              OR (status = 'COMPLETED' AND document_id = ?)
            )
            AND EXISTS (
              SELECT 1 FROM dte_documents
               WHERE id = ? AND status = 'ACCEPTED'
                 AND post_accept_finalized_at IS NULL
                 AND fiscal_operation_claim_id IS NULL
                 AND post_accept_finalization_claim_id = ?
            )
          RETURNING id`
      )
      .bind(documentId, updatedAt, id, documentId, documentId, claimId)
      .first<{ id: string }>();
    return Boolean(row);
  }

  // Stamp the donor's payment (migration 0016). Called by the Wompi webhook when an
  // approved payment correlates to this intent. Deliberately does NOT touch status:
  // COMPLETED stays reserved for MH acceptance of the CDE. The `paid_at IS NULL` guard
  // makes it idempotent — a webhook replay never moves the timestamp, and an unknown or
  // already-paid intent simply matches nothing (no-op, no error).
  async markIntentPaid(id: string, expectedLinkId: number): Promise<void> {
    await this.db
      .prepare(
        `UPDATE donation_intents
            SET paid_at = ?, updated_at = ?
          WHERE id = ?
            AND wompi_id_enlace = ?
            AND status IN ('LINK_CREATED', 'EXPIRED')
            AND paid_at IS NULL`
      )
      .bind(nowIso(), nowIso(), id, expectedLinkId)
      .run();
  }

  // The intents the next expireUnpaidIntentsBefore(nowIso) call will flip: same
  // (status, expires_at) predicate as the UPDATE, so the sweep can deactivate the
  // Wompi links of exactly the rows it is about to expire. Read this BEFORE the
  // UPDATE (afterwards the rows no longer match) — its results feed
  // WompiApiService.deactivatePaymentLink.
  async listIntentsExpiringBefore(nowIso: string, limit = INTENT_EXPIRY_SWEEP_LIMIT): Promise<Array<Pick<DonationIntentRecord, "id" | "wompi_id_enlace" | "amount_cents" | "status" | "gift_type">>> {
    // gift_type is projected so the deactivation sweep can resend the SAME
    // nombreProducto the create sent (a PUT replaces the whole link object). The page
    // is capped and ordered oldest-first so attacker-created expired intents cannot
    // force one cron invocation to snapshot (or deactivate) an unbounded row set; the
    // next tick continues from the remaining PENDING/LINK_CREATED rows.
    const safeLimit = Math.max(1, Math.min(Math.trunc(limit), INTENT_EXPIRY_SWEEP_LIMIT));
    const result = await this.db
      .prepare("SELECT id, wompi_id_enlace, amount_cents, status, gift_type FROM donation_intents WHERE status IN ('PENDING','LINK_CREATED') AND expires_at < ? ORDER BY expires_at ASC, id ASC LIMIT ?")
      .bind(nowIso, safeLimit)
      .all<Pick<DonationIntentRecord, "id" | "wompi_id_enlace" | "amount_cents" | "status" | "gift_type">>();
    return result.results;
  }

  // Marks only the bounded page the cron sweep just snapshotted as EXPIRED, so link
  // deactivation and status expiry stay in the same capped unit of work and a later
  // tick can continue from rows this one did not process.
  async expireDonationIntentsByIds(ids: string[], updatedAt: string): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    const placeholders = ids.map(() => "?").join(", ");
    await this.db
      .prepare(`UPDATE donation_intents SET status = 'EXPIRED', updated_at = ? WHERE status IN ('PENDING','LINK_CREATED') AND id IN (${placeholders})`)
      .bind(updatedAt, ...ids)
      .run();
  }

  // Newest-first listing for the admin "Donaciones en línea" panel (Task 5). The
  // LEFT JOIN exposes the emitted CDE's numero_control AND its donor_name for
  // COMPLETED intents (which carry document_id) and leaves both null for every other
  // status. The donante shown in the panel comes from the document (lifted from the
  // webhook), since the intent no longer stores name/email.
  async listRecentDonationIntents(limit = 50): Promise<DonationIntentListItem[]> {
    // Least privilege: allowlist only the columns the admin "Donaciones en línea" panel
    // renders (status, tipo, amount, donante-from-document, numero de control, fecha).
    // A prior `SELECT donation_intents.*` shipped donor PII (donor_document, donor_email),
    // the client IP, and the Wompi payment-link URLs to the browser even though nothing
    // renders them.
    const rows = await this.db
      .prepare(
        `SELECT donation_intents.id,
                donation_intents.status,
                donation_intents.amount_cents,
                donation_intents.document_id,
                donation_intents.gift_type,
                donation_intents.created_at,
                dte_documents.numero_control AS numero_control,
                dte_documents.donor_name AS document_donor_name
         FROM donation_intents
         LEFT JOIN dte_documents ON dte_documents.id = donation_intents.document_id
         ORDER BY donation_intents.created_at DESC, donation_intents.id DESC
         LIMIT ?`
      )
      .bind(Math.min(Math.max(Math.trunc(limit), 1), 100))
      .all<DonationIntentListItem>();
    return rows.results ?? [];
  }

  // Single indexed lookup (idx_donation_intents_document_id, migration 0009) for the
  // document detail's donor-data-verified badge: is there a COMPLETED intent that
  // produced this CDE?
  async getCompletedIntentForDocument(documentId: string): Promise<{ id: string } | null> {
    return this.db
      .prepare("SELECT id FROM donation_intents WHERE document_id = ? AND status = 'COMPLETED' LIMIT 1")
      .bind(documentId)
      .first<{ id: string }>();
  }

  async hasAuditAction(action: string, entityType: string, entityId: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT id FROM audit_logs WHERE action = ? AND entity_type = ? AND entity_id = ? LIMIT 1")
      .bind(action, entityType, entityId)
      .first<{ id: string }>();
    return Boolean(row);
  }

  async nextControlSequence(environment: Ambiente, controlPrefix: string): Promise<number> {
    const normalizedPrefix = normalizeControlPrefix(controlPrefix);
    await this.db
      .prepare("INSERT OR IGNORE INTO document_sequences (environment, control_prefix, next_value) VALUES (?, ?, 1)")
      .bind(environment, normalizedPrefix)
      .run();
    const row = await this.db
      .prepare("UPDATE document_sequences SET next_value = next_value + 1 WHERE environment = ? AND control_prefix = ? RETURNING next_value - 1 AS value")
      .bind(environment, normalizedPrefix)
      .first<{ value: number }>();
    if (!row) {
      throw new Error("No se pudo asignar la secuencia de control");
    }
    return row.value;
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
    const id = newId("dte");
    const insert = this.db
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
      await this.db.batch([
        insert,
        this.wompiDocumentCreatedStatement(input.wompiEventId, id, nowIso())
      ]);
    } else {
      await insert.run();
    }
    const record = await this.getDteDocument(id);
    if (!record) {
      throw new Error("No se pudo leer el documento DTE creado");
    }
    await this.indexDteDocument(record);
    return record;
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
    const id = newId("dte");
    const processedAt = nowIso();
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE wompi_events
              SET created_document_id = ?, processed_at = ?,
                  issuance_status = 'DOCUMENT_CREATED',
                  issuance_claim_id = NULL, issuance_claimed_at = NULL
            WHERE id = ? AND issuance_claim_id = ?
              AND processed_at IS NULL AND created_document_id IS NULL`
        )
        .bind(id, processedAt, input.wompiEventId, input.issuanceClaimId),
      this.db
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
    const record = await this.getDteDocument(id);
    if (!record) {
      throw new Error("No se pudo leer el documento DTE Wompi creado");
    }
    await this.indexDteDocument(record);
    return record;
  }

  async markWompiDocumentCreated(wompiEventId: string, documentId: string): Promise<void> {
    await this.wompiDocumentCreatedStatement(wompiEventId, documentId, nowIso()).run();
  }

  private wompiDocumentCreatedStatement(
    wompiEventId: string,
    documentId: string,
    processedAt: string
  ) {
    return this.db
      .prepare(
        `UPDATE wompi_events
         SET created_document_id = ?,
             processed_at = ?,
             issuance_status = 'DOCUMENT_CREATED'
         WHERE id = ?`
      )
      .bind(documentId, processedAt, wompiEventId);
  }

  async markWompiEventProcessed(id: string): Promise<void> {
    await this.db.prepare("UPDATE wompi_events SET processed_at = ? WHERE id = ? AND processed_at IS NULL").bind(nowIso(), id).run();
  }

  async quarantineWompiIntentBinding(input: {
    wompiEventId: string;
    intentId: string;
    reason: string;
    expectedLinkId: number | null;
    payloadLinkId: number | null;
  }): Promise<void> {
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
    await this.db.batch([
      this.db
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
      this.db
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

  async getDteDocument(id: string): Promise<DteDocumentRecord | null> {
    return this.db.prepare("SELECT * FROM dte_documents WHERE id = ?").bind(id).first<DteDocumentRecord>();
  }

  async getDteDocumentByWompiEvent(id: string): Promise<DteDocumentRecord | null> {
    return this.db.prepare("SELECT * FROM dte_documents WHERE wompi_event_id = ?").bind(id).first<DteDocumentRecord>();
  }

  async listDteDocuments(params: {
    status?: string | null;
    attention?: "failures" | null;
    q?: string | null;
    limit?: number;
    cursor?: string | null;
  } = {}): Promise<DteDocumentListPage> {
    const limit = normalizeDocumentListLimit(params.limit);
    const filters: string[] = [];
    const bindings: Array<string | number> = [];
    if (params.attention === "failures") {
      filters.push(`(
        dte_documents.status IN ('FAILED', 'REJECTED')
        OR (
          dte_documents.status = 'ACCEPTED'
          AND latest_receipt.status = 'FAILED'
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
    const from = `FROM dte_documents
      LEFT JOIN latest_receipt
        ON latest_receipt.document_id = dte_documents.id
       AND latest_receipt.row_num = 1
      ${ftsQuery ? "JOIN dte_document_search ON dte_document_search.document_id = dte_documents.id" : ""}`;
    const rows = await this.db
      .prepare(`WITH latest_receipt AS (
        SELECT document_id,
               status,
               ROW_NUMBER() OVER (
                 PARTITION BY document_id
                 ORDER BY COALESCE(claim_attempted_at, created_at) DESC,
                          created_at DESC,
                          id DESC
               ) AS row_num
          FROM email_deliveries
         WHERE email_type IN ('dteReceipt', 'dteReceiptTransitorio')
      )
      SELECT dte_documents.*,
             latest_receipt.status AS receipt_email_status
        ${from}
        ${where}
       ORDER BY dte_documents.created_at DESC, dte_documents.id DESC
       LIMIT ?`)
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
    const updated = await this.db
      .prepare(
        "UPDATE dte_documents SET signed_jws = ?, status = 'SIGNED', updated_at = ? " +
          "WHERE id = ? AND status = ? AND fiscal_operation_claim_id IS NULL RETURNING id"
      )
      .bind(signedJws, nowIso(), id, expectedStatus)
      .first<{ id: string }>();
    return Boolean(updated);
  }

  // Claim before allocating a new fiscal control sequence. A concurrent loser must
  // stop here so it cannot burn a permanent number for a DTE it will never transmit.
  async claimRejectedWompiRetry(id: string, wompiEventId: string, claimId: string): Promise<boolean> {
    const claimedAt = nowIso();
    const row = await this.db
      .prepare(
        `UPDATE dte_documents
         SET fiscal_operation_claim_id = ?, fiscal_operation_claimed_at = ?,
             fiscal_operation_kind = 'TRANSMISSION', fiscal_operation_event_id = NULL,
             post_accept_finalized_at = NULL, updated_at = ?
         WHERE id = ? AND wompi_event_id = ? AND status = 'REJECTED'
           AND fiscal_operation_claim_id IS NULL
         RETURNING id`
      )
      .bind(claimId, claimedAt, claimedAt, id, wompiEventId)
      .first<{ id: string }>();
    return Boolean(row);
  }

  // Only the claim owner may replace the rejected payload and move it to SIGNED.
  // The claim remains attached across the fiscal POST until that owner records MH's
  // definitive verdict (or proves dispatch never began).
  async prepareClaimedRejectedWompiRebuild(
    id: string,
    wompiEventId: string,
    claimId: string,
    input: { codigoGeneracion: string; numeroControl: string; plainJson: Record<string, unknown>; signedJws: string | null }
  ): Promise<boolean> {
    const row = await this.db
      .prepare(
        `UPDATE dte_documents
         SET codigo_generacion = ?, numero_control = ?, plain_json = ?, signed_jws = ?,
             status = 'SIGNED', sello_recibido = NULL, mh_estado = NULL, mh_observaciones_json = '[]',
             post_accept_finalized_at = NULL, updated_at = ?
         WHERE id = ? AND wompi_event_id = ? AND status = 'REJECTED'
           AND fiscal_operation_claim_id = ?
         RETURNING id`
      )
      .bind(
        input.codigoGeneracion,
        input.numeroControl,
        JSON.stringify(input.plainJson),
        input.signedJws,
        nowIso(),
        id,
        wompiEventId,
        claimId
      )
      .first<{ id: string }>();
    if (!row) {
      return false;
    }
    await this.indexDteDocumentById(id);
    return true;
  }

  async claimDocumentTransmission(id: string, expectedStatus: string, signedJws: string, claimId: string): Promise<boolean> {
    const claimedAt = nowIso();
    const row = await this.db
      .prepare(
        `UPDATE dte_documents
         SET status = 'SIGNED', fiscal_operation_claim_id = ?, fiscal_operation_claimed_at = ?,
             fiscal_operation_kind = 'TRANSMISSION', fiscal_operation_event_id = NULL,
             post_accept_finalized_at = NULL, updated_at = ?
         WHERE id = ? AND status = ? AND signed_jws = ?
           AND fiscal_operation_claim_id IS NULL
         RETURNING id`
      )
      .bind(claimId, claimedAt, claimedAt, id, expectedStatus, signedJws)
      .first<{ id: string }>();
    return Boolean(row);
  }

  async claimDocumentInvalidation(id: string, claimId: string): Promise<boolean> {
    const claimedAt = nowIso();
    const row = await this.db
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
    const eventId = newId("event");
    const updatedAt = nowIso();
    const results = await this.db.batch([
      this.db
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
      this.db
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

  async releaseDocumentInvalidationBeforeDispatch(
    documentId: string,
    claimId: string,
    eventId: string,
    reason: string
  ): Promise<boolean> {
    const updatedAt = nowIso();
    const results = await this.db.batch([
      this.db
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
      this.db
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
    const eventStatus = input.accepted ? "ACCEPTED" : "REJECTED";
    const documentStatus = input.accepted ? "INVALIDATED" : "ACCEPTED";
    const auditAction = input.accepted ? "DTE_INVALIDATED" : "DTE_INVALIDATION_REJECTED";
    const updatedAt = nowIso();
    const auditId = `audit_invalidation_${input.eventId}`;
    const results = await this.db.batch([
      this.db
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
      this.db
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
      this.db
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

  async completeDocumentTransmission(
    id: string,
    claimId: string,
    result: { status: "ACCEPTED" | "REJECTED"; sello: string | null; mhEstado: string; observaciones: string[]; acceptedAt: string | null }
  ): Promise<boolean> {
    const row = await this.db
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

  async markDocumentFailed(
    id: string,
    claimId: string | null,
    result: { mhEstado: string; observaciones: string[] }
  ): Promise<boolean> {
    const claimPredicate = claimId ? "fiscal_operation_claim_id = ?" : "fiscal_operation_claim_id IS NULL";
    const bindings: unknown[] = [result.mhEstado, JSON.stringify(result.observaciones), nowIso(), id];
    if (claimId) bindings.push(claimId);
    const row = await this.db
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

  async releaseDocumentFiscalOperation(id: string, claimId: string): Promise<boolean> {
    const row = await this.db
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
  async markDocumentTransmissionDeferred(id: string, claimId: string, reason: string): Promise<boolean> {
    const row = await this.db
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

  // CDE con transmisión diferida (MH no disponible al emitir) y reconstrucciones
  // Wompi que pudieron quedar SIGNED antes de transmitir: el cron de 15 minutos los
  // recupera en orden de emisión. Lee por el índice idx_dte_documents_status.
  async listDeferredTransmissionDocuments(limit = 100): Promise<DteDocumentRecord[]> {
    return this.db
      .prepare("SELECT * FROM dte_documents WHERE status = ? AND transmission_deferred_at IS NOT NULL AND fiscal_operation_claim_id IS NULL ORDER BY created_at ASC LIMIT ?")
      .bind("SIGNED", Math.min(Math.max(Math.trunc(limit), 1), 500))
      .all<DteDocumentRecord>()
      .then((result) => result.results ?? []);
  }

  async listAcceptedWompiDocumentsMissingFinalization(limit = 100): Promise<DteDocumentRecord[]> {
    return this.db
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

  async listPendingPostAcceptFinalizations(limit = 100): Promise<DteDocumentRecord[]> {
    const staleBefore = new Date(Date.now() - POST_ACCEPT_FINALIZATION_STALE_MS).toISOString();
    return this.db
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

  async claimDocumentPostAcceptFinalization(id: string, claimId: string): Promise<boolean> {
    const claimedAt = nowIso();
    const staleBefore = new Date(Date.now() - POST_ACCEPT_FINALIZATION_STALE_MS).toISOString();
    const row = await this.db
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

  async markDocumentPostAcceptEmailDispatchStarted(id: string, claimId: string): Promise<boolean> {
    const startedAt = nowIso();
    const row = await this.db
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

  async releaseDocumentPostAcceptFinalization(id: string, claimId: string): Promise<boolean> {
    const row = await this.db
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

  async markDocumentPostAcceptFinalized(id: string, claimId: string): Promise<boolean> {
    const finalizedAt = nowIso();
    const row = await this.db
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
  async hasSentEmail(documentId: string, emailType: string): Promise<boolean> {
    const row = await this.db
      .prepare("SELECT id FROM email_deliveries WHERE document_id = ? AND email_type = ? AND status = 'SENT' LIMIT 1")
      .bind(documentId, emailType)
      .first<{ id: string }>();
    return Boolean(row);
  }

  async hasHandledEmail(documentId: string, emailType: string, documentStatusAtSend: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        "SELECT id FROM email_deliveries WHERE document_id = ? AND email_type = ? AND status IN ('SENT', 'FAILED') AND document_status_at_send = ? LIMIT 1"
      )
      .bind(documentId, emailType, documentStatusAtSend)
      .first<{ id: string }>();
    return Boolean(row);
  }

  async updateDocumentDonorEmail(id: string, email: string): Promise<boolean> {
    const result = await this.db
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
    await this.indexDteDocumentById(id);
    return true;
  }

  private async indexDteDocumentById(id: string): Promise<void> {
    const record = await this.getDteDocument(id);
    if (record) {
      await this.indexDteDocument(record);
    }
  }

  private async indexDteDocument(record: DteDocumentRecord): Promise<void> {
    await this.db.prepare("DELETE FROM dte_document_search WHERE document_id = ?").bind(record.id).run();
    await this.db
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
  // PENDING claim and SENT evidence both block a competing delivery. FAILED or
  // lease-expired PENDING work reuses the same row and provider identity. Legacy
  // PENDING rows have no attempt timestamp and deliberately remain blocked for
  // manual review: we cannot know whether their provider request succeeded.
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
           idempotency_key, claim_token
         )
         SELECT ?, ?, ?, 'PENDING', '{}', ?, ?, ?, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM email_deliveries
           WHERE document_id = ? AND email_type = ? AND document_status_at_send = ?
             AND (
               status = 'SENT'
               OR (
                 status = 'PENDING'
                 AND (claim_attempted_at IS NULL OR claim_attempted_at >= ?)
               )
             )
         )
         ON CONFLICT(idempotency_key) WHERE idempotency_key IS NOT NULL
         DO UPDATE SET
           to_email = excluded.to_email,
           status = 'PENDING',
           provider_response_json = '{}',
           document_status_at_send = excluded.document_status_at_send,
           claim_attempted_at = excluded.claim_attempted_at,
           claim_token = excluded.claim_token
         WHERE email_deliveries.status = 'FAILED'
            OR (
              email_deliveries.status = 'PENDING'
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
    }
  ): Promise<void> {
    const result = await this.db
      .prepare(
        `UPDATE email_deliveries
         SET status = ?, provider_response_json = ?, sent_at = ?,
             email_type = ?, document_status_at_send = ?, template_version = ?,
             pdf_renderer_version = ?, pdf_sha256 = ?, dte_json_sha256 = ?,
             provider_delivery_id = ?
         WHERE id = ? AND status = 'PENDING' AND claim_token = ?`
      )
      .bind(
        input.status,
        JSON.stringify(input.providerResponse ?? {}),
        input.status === "SENT" ? nowIso() : null,
        input.emailType,
        input.documentStatusAtSend,
        input.templateVersion ?? null,
        input.pdfRendererVersion ?? null,
        input.pdfSha256 ?? null,
        input.dteJsonSha256 ?? null,
        input.providerDeliveryId ?? null,
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
           AND (
             (
               processed_at IS NULL
               AND issuance_status IS NULL
               AND received_at < ?
             )
             OR (
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
