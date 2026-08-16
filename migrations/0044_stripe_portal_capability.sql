-- A paid Stripe Checkout Session is public browser state and is not sufficient
-- authority to create a Billing Portal session. Store only a hash of a separate,
-- short-lived browser capability; the raw value is delivered in an HttpOnly cookie.
ALTER TABLE stripe_checkout_sessions
  ADD COLUMN portal_capability_hash TEXT
  CHECK (
    portal_capability_hash IS NULL
    OR (
      length(portal_capability_hash) = 64
      AND portal_capability_hash = lower(portal_capability_hash)
      AND portal_capability_hash NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE stripe_checkout_sessions
  ADD COLUMN portal_capability_expires_at TEXT;

ALTER TABLE stripe_checkout_sessions
  ADD COLUMN portal_capability_revoked_at TEXT;

-- Portal creation has a dedicated rolling ledger because the older generic
-- security_rate_limit_claims table intentionally constrains its scope enum.
CREATE TABLE stripe_portal_rate_limit_claims (
  id TEXT PRIMARY KEY,
  ip_key_hash TEXT NOT NULL,
  customer_key_hash TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX idx_stripe_portal_rate_limits_ip_claimed
  ON stripe_portal_rate_limit_claims(ip_key_hash, claimed_at);

CREATE INDEX idx_stripe_portal_rate_limits_customer_claimed
  ON stripe_portal_rate_limit_claims(customer_key_hash, claimed_at);

CREATE INDEX idx_stripe_portal_rate_limits_expires
  ON stripe_portal_rate_limit_claims(expires_at);

CREATE TRIGGER stripe_checkout_portal_capability_state_insert
BEFORE INSERT ON stripe_checkout_sessions
WHEN (NEW.portal_capability_hash IS NULL) IS NOT (NEW.portal_capability_expires_at IS NULL)
  OR (NEW.portal_capability_revoked_at IS NOT NULL AND NEW.portal_capability_hash IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'stripe_checkout_portal_capability_state_invalid');
END;

CREATE TRIGGER stripe_checkout_portal_capability_state_update
BEFORE UPDATE OF portal_capability_hash, portal_capability_expires_at, portal_capability_revoked_at
ON stripe_checkout_sessions
WHEN (NEW.portal_capability_hash IS NULL) IS NOT (NEW.portal_capability_expires_at IS NULL)
  OR (NEW.portal_capability_revoked_at IS NOT NULL AND NEW.portal_capability_hash IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'stripe_checkout_portal_capability_state_invalid');
END;
