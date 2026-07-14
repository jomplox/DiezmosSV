-- One durable owner for any MH-facing operation on a fiscal document.
--
-- The claim is acquired atomically immediately before transmission or
-- invalidation and cleared only by the matching owner when the operation reaches a
-- known local state. A non-null claim after an interrupted/ambiguous call is kept
-- for reconciliation instead of authorizing a second legal submission.
ALTER TABLE dte_documents ADD COLUMN fiscal_operation_claim_id TEXT;
ALTER TABLE dte_documents ADD COLUMN fiscal_operation_claimed_at TEXT;
ALTER TABLE dte_documents ADD COLUMN fiscal_operation_kind TEXT
  CHECK (fiscal_operation_kind IN ('TRANSMISSION', 'INVALIDATION'));
ALTER TABLE dte_documents ADD COLUMN fiscal_operation_event_id TEXT;

CREATE INDEX idx_dte_documents_fiscal_claims
  ON dte_documents(fiscal_operation_claimed_at, id)
  WHERE fiscal_operation_claim_id IS NOT NULL;

-- A document claim begins too late to serialize two deliveries of the same paid
-- Wompi event: both could otherwise allocate and insert distinct CDEs first. Claim
-- the source event before sequence allocation, and keep a database uniqueness guard
-- as defense in depth for every non-null Wompi source.
ALTER TABLE wompi_events ADD COLUMN issuance_claim_id TEXT;
ALTER TABLE wompi_events ADD COLUMN issuance_claimed_at TEXT;

CREATE INDEX idx_wompi_events_issuance_claims
  ON wompi_events(issuance_claimed_at, id)
  WHERE issuance_claim_id IS NOT NULL;

CREATE UNIQUE INDEX idx_dte_documents_unique_wompi_event
  ON dte_documents(wompi_event_id)
  WHERE wompi_event_id IS NOT NULL;

-- `/datos` attempts need their own budget: failed capability guesses must consume
-- capacity without reducing the separate donation-intent creation allowance.
DROP INDEX IF EXISTS idx_security_rate_limit_claims_scope_key_claimed;
DROP INDEX IF EXISTS idx_security_rate_limit_claims_expires_at;

ALTER TABLE security_rate_limit_claims RENAME TO security_rate_limit_claims_old;

CREATE TABLE security_rate_limit_claims (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('donation_intent', 'donation_datos', 'password_reset')),
  key_hash TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

INSERT INTO security_rate_limit_claims (id, scope, key_hash, claimed_at, expires_at)
SELECT id, scope, key_hash, claimed_at, expires_at
FROM security_rate_limit_claims_old;

DROP TABLE security_rate_limit_claims_old;

CREATE INDEX idx_security_rate_limit_claims_scope_key_claimed
  ON security_rate_limit_claims(scope, key_hash, claimed_at);

CREATE INDEX idx_security_rate_limit_claims_expires_at
  ON security_rate_limit_claims(expires_at);
