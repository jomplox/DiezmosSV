CREATE TABLE IF NOT EXISTS security_rate_limit_claims (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('donation_intent', 'password_reset')),
  key_hash TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_security_rate_limit_claims_scope_key_claimed
  ON security_rate_limit_claims(scope, key_hash, claimed_at);

CREATE INDEX IF NOT EXISTS idx_security_rate_limit_claims_expires_at
  ON security_rate_limit_claims(expires_at);

ALTER TABLE donation_intents ADD COLUMN rate_limit_claim_id TEXT;
ALTER TABLE audit_logs ADD COLUMN rate_limit_claim_id TEXT;

CREATE INDEX IF NOT EXISTS idx_donation_intents_client_ip_created_at
  ON donation_intents(client_ip, created_at);
