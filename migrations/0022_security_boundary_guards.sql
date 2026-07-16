-- A reset admission consumes both its source/account-pair budget and its
-- account-wide budget in one row. Existing claims remain valid for their pair key;
-- the linked legacy audits are counted during the short cutover window.
ALTER TABLE security_rate_limit_claims ADD COLUMN subject_key_hash TEXT;

CREATE INDEX idx_security_rate_limit_claims_scope_subject_claimed
  ON security_rate_limit_claims(scope, subject_key_hash, claimed_at)
  WHERE subject_key_hash IS NOT NULL;

-- Older releases recorded the OWNER-only alert recipient in the audit summary and
-- metadata. Canonicalize those D1 rows so future retention exports cannot archive
-- the historical value even if another reader bypasses the normal projection.
UPDATE audit_logs
   SET summary = CASE
         WHEN action = 'ALERT_EMAIL_UPDATED'
           THEN 'Correo de alertas actualizado'
         ELSE summary
       END,
       metadata_json = '{}'
 WHERE entity_type = 'app_setting'
   AND entity_id = 'alert_email';
