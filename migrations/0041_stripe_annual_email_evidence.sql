-- Preserve the exact editable annual-email envelope independently from the
-- fixed legal statement snapshot. A safe retry therefore reuses the same
-- subject/body/HTML and provider idempotency key even if an owner edits the
-- template after the first pre-provider attempt.
ALTER TABLE stripe_annual_statement_deliveries
ADD COLUMN email_content_json TEXT
CHECK (email_content_json IS NULL OR json_valid(email_content_json));

CREATE TRIGGER stripe_annual_statement_email_content_immutable
BEFORE UPDATE OF email_content_json
ON stripe_annual_statement_deliveries
WHEN NEW.email_content_json IS NOT OLD.email_content_json
 AND NOT (
   OLD.email_content_json IS NULL
   AND NEW.email_content_json IS NOT NULL
   AND OLD.dispatch_started_at IS NULL
   AND (
     OLD.status = 'PENDING'
     OR (OLD.status = 'FAILED' AND OLD.retry_safe = 1)
     OR (OLD.status = 'PROCESSING' AND OLD.dispatch_started_at IS NULL)
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'stripe_annual_statement_email_content_immutable');
END;
