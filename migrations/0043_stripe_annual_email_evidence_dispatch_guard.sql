-- Fence mixed-version Workers that do not yet persist the immutable annual
-- e-mail envelope. Existing post-dispatch rows remain recoverable to REVIEW.
CREATE TRIGGER stripe_annual_statement_dispatch_requires_email_content
BEFORE UPDATE OF dispatch_started_at
ON stripe_annual_statement_deliveries
WHEN OLD.dispatch_started_at IS NULL
 AND NEW.dispatch_started_at IS NOT NULL
 AND NEW.email_content_json IS NULL
BEGIN
  SELECT RAISE(ABORT, 'stripe_annual_statement_dispatch_requires_email_content');
END;

CREATE TRIGGER stripe_annual_statement_sent_requires_email_content
BEFORE UPDATE OF status
ON stripe_annual_statement_deliveries
WHEN OLD.status <> 'SENT'
 AND NEW.status = 'SENT'
 AND NEW.email_content_json IS NULL
BEGIN
  SELECT RAISE(ABORT, 'stripe_annual_statement_sent_requires_email_content');
END;
