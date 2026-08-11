-- Existing Stripe rows predate an explicit donor classification. Preserve them
-- for reporting, but do not let a new checkout or gift silently inherit it.
ALTER TABLE stripe_checkout_sessions
  ADD COLUMN gift_type TEXT NOT NULL DEFAULT 'UNSPECIFIED'
  CHECK (gift_type IN ('TITHE', 'OFFERING', 'UNSPECIFIED'));

ALTER TABLE stripe_gifts
  ADD COLUMN gift_type TEXT NOT NULL DEFAULT 'UNSPECIFIED'
  CHECK (gift_type IN ('TITHE', 'OFFERING', 'UNSPECIFIED'));

CREATE TRIGGER stripe_checkout_sessions_require_gift_type
BEFORE INSERT ON stripe_checkout_sessions
WHEN NEW.gift_type = 'UNSPECIFIED'
BEGIN
  SELECT RAISE(ABORT, 'gift_type_required');
END;

CREATE TRIGGER stripe_gifts_require_gift_type
BEFORE INSERT ON stripe_gifts
WHEN NEW.gift_type = 'UNSPECIFIED'
BEGIN
  SELECT RAISE(ABORT, 'gift_type_required');
END;
