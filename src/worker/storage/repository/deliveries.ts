import { nowIso } from "../../utils/dates";
import { sha256Hex, utf8Bytes } from "../../utils/encoding";
import { newId } from "../../utils/ids";

export interface ReceiptEmailDeliveryState {
  status: "PENDING" | "SENT" | "FAILED";
  outcomeClass: EmailDeliveryOutcomeClass | null;
  failureCode: string | null;
  retrySafe: boolean;
  requiresReview: boolean;
  attemptNo: number;
  occurredAt: string;
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

export async function getLatestReceiptEmailDelivery(
  db: D1Database,
  documentId: string
): Promise<ReceiptEmailDeliveryState | null> {
  const row = await db
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

export async function recordEmailDelivery(
  db: D1Database,
  input: {
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
  }
): Promise<void> {
  await db
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
export async function claimEmailDelivery(
  db: D1Database,
  input: {
    documentId: string;
    toEmail: string;
    emailType: string;
    documentStatusAtSend: string;
  }
): Promise<{ id: string; idempotencyKey: string; claimToken: string } | null> {
  const id = newId("email");
  const claimToken = newId("email_claim");
  const claimedAt = nowIso();
  const staleBefore = new Date(Date.now() - EMAIL_DELIVERY_CLAIM_LEASE_MS).toISOString();
  const idempotencyKey = await emailDeliveryIdempotencyKey(
    input.documentId,
    input.emailType,
    input.documentStatusAtSend
  );
  const row = await db
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
export async function claimManualEmailDelivery(
  db: D1Database,
  input: {
    documentId: string;
    toEmail: string;
    emailType: string;
    documentStatusAtSend: string;
    resendRequestId: string;
  }
): Promise<ManualEmailDeliveryClaim> {
  const id = newId("email");
  const claimToken = newId("email_claim");
  const claimedAt = nowIso();
  const staleBefore = new Date(Date.now() - EMAIL_DELIVERY_CLAIM_LEASE_MS).toISOString();
  const idempotencyKey = await manualEmailDeliveryIdempotencyKey(
    input.documentId,
    input.resendRequestId
  );
  const reclaimed = await db
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

  const claimed = await db
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

  const existing = await db
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

  const blocker = await db
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

export async function markEmailDeliveryDispatchStarted(
  db: D1Database,
  id: string,
  claimToken: string
): Promise<boolean> {
  const row = await db
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
export async function finalizeEmailDeliveryClaim(
  db: D1Database,
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
  const result = await db
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

export async function claimOperationalAlertDelivery(
  db: D1Database,
  input: {
    kind: string;
    entityType: string;
    entityId: string;
    incidentId: string;
    channel: "email";
    targetKey: string;
  }
): Promise<OperationalAlertDeliveryClaim> {
  const id = newId("alert_delivery");
  const claimToken = newId("alert_claim");
  const claimedAt = nowIso();
  const staleBefore = new Date(Date.now() - EMAIL_DELIVERY_CLAIM_LEASE_MS).toISOString();
  const entityKeyHash = await sha256Hex(
    utf8Bytes(`${input.entityType}:${input.entityId}`)
  );
  const targetKeyHash = await sha256Hex(utf8Bytes(input.targetKey));
  const claimed = await db
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
  const existing = await db
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

export async function markOperationalAlertDispatchStarted(
  db: D1Database,
  id: string,
  claimToken: string
): Promise<boolean> {
  const row = await db
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

export async function finalizeOperationalAlertDelivery(
  db: D1Database,
  id: string,
  claimToken: string,
  input: {
    status: "SENT" | "FAILED";
    outcomeClass?: EmailDeliveryOutcomeClass | null;
    failureCode?: string | null;
    retrySafe?: boolean;
  }
): Promise<void> {
  const result = await db
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
