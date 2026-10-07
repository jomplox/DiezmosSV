-- Monthly subscriptions created by retired donation sites on the shared Stripe
-- account can be adopted into this lane by an OWNER. Their earlier invoices are
-- recorded without acknowledgments, and the first acknowledgment after adoption
-- introduces the current donation site exactly once.
ALTER TABLE stripe_checkout_sessions ADD COLUMN adopted_at TEXT;
ALTER TABLE stripe_checkout_sessions ADD COLUMN adoption_intro_delivery_id TEXT;

ALTER TABLE stripe_gifts
  ADD COLUMN acknowledgment_suppressed INTEGER NOT NULL DEFAULT 0
  CHECK (acknowledgment_suppressed IN (0, 1));

-- Backstop: a silently recorded gift must never reach a donor's inbox, including
-- through a later refund correction.
CREATE TRIGGER stripe_suppressed_gift_acknowledgment_forbidden
BEFORE INSERT ON stripe_acknowledgment_deliveries
WHEN (SELECT acknowledgment_suppressed FROM stripe_gifts WHERE id = NEW.gift_id) = 1
BEGIN
  SELECT RAISE(ABORT, 'stripe_acknowledgment_suppressed');
END;
