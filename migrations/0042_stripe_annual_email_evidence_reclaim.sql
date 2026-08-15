-- Let a delivery created before 0041 still receive its frozen e-mail envelope.
-- The 0041 exemption also demanded OLD.dispatch_started_at IS NULL, which
-- excluded exactly the retry-safe FAILED rows the claim query re-claims: a
-- statement whose first attempt already reached the provider and came back
-- not-sent keeps its dispatch timestamp, so the NULL -> value backfill of the
-- next claim aborted and wedged that donor's statement on every retry.
-- Write-once is unchanged: OLD.email_content_json IS NULL together with
-- NEW.email_content_json IS NOT NULL still allows exactly one write and no
-- later edit, and the status guard still keeps content out of SENT and REVIEW
-- rows. Only the dispatch timestamp, which never protected write-once, is gone.
DROP TRIGGER IF EXISTS stripe_annual_statement_email_content_immutable;

CREATE TRIGGER stripe_annual_statement_email_content_immutable
BEFORE UPDATE OF email_content_json
ON stripe_annual_statement_deliveries
WHEN NEW.email_content_json IS NOT OLD.email_content_json
 AND NOT (
   OLD.email_content_json IS NULL
   AND NEW.email_content_json IS NOT NULL
   AND (
     OLD.status = 'PENDING'
     OR (OLD.status = 'FAILED' AND OLD.retry_safe = 1)
     OR OLD.status = 'PROCESSING'
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'stripe_annual_statement_email_content_immutable');
END;
