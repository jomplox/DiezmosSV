-- Provider webhook delivery order is not guaranteed. Keep independent clocks for
-- Checkout lifecycle and recurring-subscription state so older/equal deliveries
-- cannot regress a newer durable state. Rank resolves equal-second Stripe events.
ALTER TABLE stripe_checkout_sessions
  ADD COLUMN checkout_event_created INTEGER NOT NULL DEFAULT 0
  CHECK (checkout_event_created >= 0);
ALTER TABLE stripe_checkout_sessions
  ADD COLUMN checkout_event_rank INTEGER NOT NULL DEFAULT 0
  CHECK (checkout_event_rank BETWEEN 0 AND 4);
ALTER TABLE stripe_checkout_sessions
  ADD COLUMN checkout_event_id TEXT;

ALTER TABLE stripe_checkout_sessions
  ADD COLUMN subscription_event_created INTEGER NOT NULL DEFAULT 0
  CHECK (subscription_event_created >= 0);
ALTER TABLE stripe_checkout_sessions
  ADD COLUMN subscription_event_rank INTEGER NOT NULL DEFAULT 0
  CHECK (subscription_event_rank BETWEEN 0 AND 3);
ALTER TABLE stripe_checkout_sessions
  ADD COLUMN subscription_event_id TEXT;
