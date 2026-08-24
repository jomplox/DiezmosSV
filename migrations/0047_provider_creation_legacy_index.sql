-- Bound rolling-deploy Stripe legacy counts to the recent unattributed slice.
CREATE INDEX idx_stripe_checkout_legacy_created
  ON stripe_checkout_sessions(created_at)
  WHERE provider_creation_claim_id IS NULL;
