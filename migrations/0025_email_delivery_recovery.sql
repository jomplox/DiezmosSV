-- Adds provider-dispatch and typed outcome evidence to the existing receipt claim.
-- UNKNOWN/NOT_DELIVERED outcomes remain manual-review; only retry_safe=1 may be
-- reclaimed automatically. resend_request_id fences one deliberate operator action.

ALTER TABLE email_deliveries ADD COLUMN provider_dispatch_started_at TEXT;
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
