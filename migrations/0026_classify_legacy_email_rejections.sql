-- Pre-0025 receipt failures did not store typed delivery outcomes. Cloudflare
-- rejected this exact disallowed-header request before accepting the message, so
-- these legacy rows are safe for a deliberate operator resend. Every other legacy
-- or post-dispatch failure remains manual-review-only.
UPDATE email_deliveries
   SET outcome_class = 'NOT_SENT',
       failure_code = 'E_HEADER_NOT_ALLOWED',
       retry_safe = 1,
       finalized_at = COALESCE(finalized_at, claim_attempted_at, created_at)
 WHERE status = 'FAILED'
   AND email_type IN ('dteReceipt', 'dteReceiptTransitorio')
   AND provider_dispatch_started_at IS NULL
   AND outcome_class IS NULL
   AND failure_code IS NULL
   AND retry_safe = 0
   AND json_valid(provider_response_json)
   AND json_extract(provider_response_json, '$.error') =
       'custom header ''Idempotency-Key'' is not allowed. Only whitelisted headers and X-* headers are accepted.';
