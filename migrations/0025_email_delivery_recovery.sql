-- Adds provider-dispatch and typed outcome evidence to the existing receipt claim.
-- UNKNOWN/NOT_DELIVERED outcomes remain manual-review; only retry_safe=1 may be
-- reclaimed automatically. resend_request_id fences one deliberate operator action.

ALTER TABLE email_deliveries ADD COLUMN provider_dispatch_started_at TEXT;
ALTER TABLE email_deliveries ADD COLUMN finalized_at TEXT;
ALTER TABLE email_deliveries ADD COLUMN outcome_class TEXT
  CHECK (outcome_class IS NULL OR outcome_class IN ('NOT_SENT', 'NOT_DELIVERED', 'UNKNOWN'));
ALTER TABLE email_deliveries ADD COLUMN failure_code TEXT;
ALTER TABLE email_deliveries ADD COLUMN retry_safe INTEGER NOT NULL DEFAULT 0
  CHECK (retry_safe IN (0, 1));
ALTER TABLE email_deliveries ADD COLUMN resend_request_id TEXT;
ALTER TABLE email_deliveries ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 1
  CHECK (attempt_no >= 1);

CREATE UNIQUE INDEX idx_email_deliveries_resend_request_id
  ON email_deliveries(resend_request_id)
  WHERE resend_request_id IS NOT NULL;

CREATE INDEX idx_email_deliveries_latest_receipt
  ON email_deliveries(document_id, email_type, attempt_no DESC, created_at DESC, id DESC);

-- Pre-0025 could contain more than one claimed failure for the same receipt
-- identity, or an older claimed ambiguity followed by a newer append-only terminal
-- resend. Keep claim ownership only on the latest receipt row. Preserve every older
-- evidence row without ownership so populated D1 data can satisfy the new fence.
UPDATE email_deliveries
   SET claim_token = NULL
 WHERE id IN (
   SELECT id
     FROM (
       SELECT id,
              claim_token,
              status,
              outcome_class,
              ROW_NUMBER() OVER (
                PARTITION BY document_id, email_type
                ORDER BY COALESCE(
                           provider_dispatch_started_at,
                           claim_attempted_at,
                           created_at
                         ) DESC,
                         created_at DESC,
                         id DESC
              ) AS unresolved_rank
         FROM email_deliveries
        WHERE email_type IN ('dteReceipt', 'dteReceiptTransitorio')
     )
    WHERE unresolved_rank > 1
      AND claim_token IS NOT NULL
      AND (
        status = 'PENDING'
        OR (
          status = 'FAILED'
          AND (outcome_class IS NULL OR outcome_class = 'UNKNOWN')
        )
      )
 );

-- A current or ambiguous claimed receipt is a hard document/type fence.
CREATE UNIQUE INDEX idx_email_deliveries_unresolved_receipt_claim
  ON email_deliveries(document_id, email_type)
  WHERE claim_token IS NOT NULL
    AND email_type IN ('dteReceipt', 'dteReceiptTransitorio')
    AND (
      status = 'PENDING'
      OR (
        status = 'FAILED'
        AND (outcome_class IS NULL OR outcome_class = 'UNKNOWN')
      )
    );

-- Independent operational-alert targets need their own durable fence because
-- audit_logs are append-only history, not a safe claim. Recipient and entity
-- identities are stored only as hashes.
CREATE TABLE operational_alert_deliveries (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_key_hash TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'webhook')),
  target_key_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  claim_token TEXT NOT NULL,
  claim_attempted_at TEXT NOT NULL,
  provider_dispatch_started_at TEXT,
  finalized_at TEXT,
  outcome_class TEXT
    CHECK (outcome_class IS NULL OR outcome_class IN ('NOT_SENT', 'NOT_DELIVERED', 'UNKNOWN')),
  failure_code TEXT,
  retry_safe INTEGER NOT NULL DEFAULT 0 CHECK (retry_safe IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (kind, entity_type, entity_key_hash, incident_id, channel, target_key_hash)
);

CREATE INDEX idx_operational_alert_deliveries_incident
  ON operational_alert_deliveries(kind, entity_type, entity_key_hash, incident_id);
