-- Repository-owned rolling admission for public provider-object creation.
-- Claims deliberately have no parent foreign key: the 15-minute ledger may be
-- swept while the durable intent/session keeps the claim id as provenance.
CREATE TABLE provider_creation_claims (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('WOMPI', 'STRIPE')),
  client_key_hash TEXT NOT NULL,
  stripe_request_id TEXT,
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK (
    (provider = 'WOMPI' AND stripe_request_id IS NULL)
    OR (provider = 'STRIPE' AND stripe_request_id IS NOT NULL)
  )
);

CREATE INDEX idx_provider_creation_claims_client_claimed
  ON provider_creation_claims(client_key_hash, claimed_at);

CREATE INDEX idx_provider_creation_claims_provider_claimed
  ON provider_creation_claims(provider, claimed_at);

CREATE INDEX idx_provider_creation_claims_global_claimed
  ON provider_creation_claims(claimed_at);

CREATE INDEX idx_provider_creation_claims_expires
  ON provider_creation_claims(expires_at);

CREATE UNIQUE INDEX idx_provider_creation_claims_stripe_request
  ON provider_creation_claims(provider, stripe_request_id)
  WHERE provider = 'STRIPE' AND stripe_request_id IS NOT NULL;

ALTER TABLE donation_intents
  ADD COLUMN provider_creation_claim_id TEXT;

ALTER TABLE stripe_checkout_sessions
  ADD COLUMN provider_creation_claim_id TEXT;

CREATE INDEX idx_donation_intents_provider_creation_claim
  ON donation_intents(provider_creation_claim_id)
  WHERE provider_creation_claim_id IS NOT NULL;

CREATE INDEX idx_stripe_checkout_provider_creation_claim
  ON stripe_checkout_sessions(provider_creation_claim_id)
  WHERE provider_creation_claim_id IS NOT NULL;
