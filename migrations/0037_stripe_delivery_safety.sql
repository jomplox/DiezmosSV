-- Persist webhook verification provenance without retaining any secret value.
-- The generation is a one-way SHA-256 digest used only to bind an observed
-- processed event to the exact active/next secret generation being rotated.
ALTER TABLE stripe_webhook_events
  ADD COLUMN verified_secret_slot TEXT
    CHECK (verified_secret_slot IS NULL OR verified_secret_slot IN ('ACTIVE', 'NEXT'));

ALTER TABLE stripe_webhook_events
  ADD COLUMN verified_secret_generation TEXT
    CHECK (verified_secret_generation IS NULL OR length(verified_secret_generation) = 64);

CREATE INDEX idx_stripe_webhook_events_secret_verification
  ON stripe_webhook_events (
    status, livemode, verified_secret_slot, verified_secret_generation, received_at DESC
  );

ALTER TABLE stripe_checkout_sessions
  ADD COLUMN creation_outcome_class TEXT
    CHECK (creation_outcome_class IS NULL OR creation_outcome_class IN ('DEFINITE_FAILURE', 'AMBIGUOUS'));

ALTER TABLE stripe_checkout_sessions
  ADD COLUMN idempotency_generation INTEGER NOT NULL DEFAULT 1
    CHECK (idempotency_generation >= 1);

ALTER TABLE stripe_acknowledgment_deliveries
  ADD COLUMN next_attempt_at TEXT;

CREATE INDEX idx_stripe_acknowledgment_due
  ON stripe_acknowledgment_deliveries (
    status, retry_safe, next_attempt_at, created_at, id
  );

-- Historical UNSPECIFIED rows remain valid, but once a checkout or gift has an
-- explicit donor classification it is append-only evidence and cannot be downgraded.
CREATE TRIGGER stripe_checkout_sessions_prevent_gift_type_downgrade
BEFORE UPDATE OF gift_type ON stripe_checkout_sessions
WHEN OLD.gift_type IN ('TITHE', 'OFFERING')
 AND NEW.gift_type = 'UNSPECIFIED'
BEGIN
  SELECT RAISE(ABORT, 'stripe_gift_type_downgrade');
END;

CREATE TRIGGER stripe_gifts_prevent_gift_type_downgrade
BEFORE UPDATE OF gift_type ON stripe_gifts
WHEN OLD.gift_type IN ('TITHE', 'OFFERING')
 AND NEW.gift_type = 'UNSPECIFIED'
BEGIN
  SELECT RAISE(ABORT, 'stripe_gift_type_downgrade');
END;
