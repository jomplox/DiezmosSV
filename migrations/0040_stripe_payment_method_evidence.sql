-- Persist only the non-sensitive classification of the payment method Stripe
-- actually used. Eligible Checkout methods remain Dashboard-controlled; these
-- fields come from signed Charge evidence and never contain PAN or bank data.

ALTER TABLE stripe_checkout_sessions
  ADD COLUMN payment_method_type TEXT
  CHECK (payment_method_type IS NULL OR (
    length(payment_method_type) BETWEEN 1 AND 64
    AND payment_method_type NOT GLOB '*[^a-z0-9_]*'
  ));
ALTER TABLE stripe_checkout_sessions
  ADD COLUMN payment_method_wallet TEXT
  CHECK (payment_method_wallet IS NULL OR (
    length(payment_method_wallet) BETWEEN 1 AND 64
    AND payment_method_wallet NOT GLOB '*[^a-z0-9_]*'
  ));
ALTER TABLE stripe_checkout_sessions
  ADD COLUMN payment_method_charge_id TEXT
  CHECK (payment_method_charge_id IS NULL OR payment_method_charge_id GLOB 'ch_*');
ALTER TABLE stripe_checkout_sessions
  ADD COLUMN payment_method_event_id TEXT
  CHECK (payment_method_event_id IS NULL OR payment_method_event_id GLOB 'evt_*');

-- Dahlia Charge payloads no longer expose an invoice identifier. Preserve the
-- signed Charge-to-PaymentIntent mapping on the existing webhook replay row so
-- monthly InvoicePayment evidence can converge in either delivery order.
ALTER TABLE stripe_webhook_events
  ADD COLUMN stripe_payment_intent_id TEXT
  CHECK (stripe_payment_intent_id IS NULL OR stripe_payment_intent_id GLOB 'pi_*');
ALTER TABLE stripe_webhook_events
  ADD COLUMN payment_method_type TEXT
  CHECK (payment_method_type IS NULL OR (
    length(payment_method_type) BETWEEN 1 AND 64
    AND payment_method_type NOT GLOB '*[^a-z0-9_]*'
  ));
ALTER TABLE stripe_webhook_events
  ADD COLUMN payment_method_wallet TEXT
  CHECK (payment_method_wallet IS NULL OR (
    length(payment_method_wallet) BETWEEN 1 AND 64
    AND payment_method_wallet NOT GLOB '*[^a-z0-9_]*'
  ));
ALTER TABLE stripe_webhook_events
  ADD COLUMN payment_method_charge_id TEXT
  CHECK (payment_method_charge_id IS NULL OR payment_method_charge_id GLOB 'ch_*');
ALTER TABLE stripe_webhook_events
  ADD COLUMN payment_method_amount_cents INTEGER
  CHECK (
    payment_method_amount_cents IS NULL
    OR payment_method_amount_cents BETWEEN 100 AND 500000
  );

CREATE UNIQUE INDEX idx_stripe_webhook_charge_payment_intent
  ON stripe_webhook_events(stripe_payment_intent_id)
  WHERE event_type = 'charge.succeeded'
    AND stripe_payment_intent_id IS NOT NULL;

ALTER TABLE stripe_gifts
  ADD COLUMN payment_method_type TEXT
  CHECK (payment_method_type IS NULL OR (
    length(payment_method_type) BETWEEN 1 AND 64
    AND payment_method_type NOT GLOB '*[^a-z0-9_]*'
  ));
ALTER TABLE stripe_gifts
  ADD COLUMN payment_method_wallet TEXT
  CHECK (payment_method_wallet IS NULL OR (
    length(payment_method_wallet) BETWEEN 1 AND 64
    AND payment_method_wallet NOT GLOB '*[^a-z0-9_]*'
  ));
ALTER TABLE stripe_gifts
  ADD COLUMN payment_method_charge_id TEXT
  CHECK (payment_method_charge_id IS NULL OR payment_method_charge_id GLOB 'ch_*');
ALTER TABLE stripe_gifts
  ADD COLUMN payment_method_event_id TEXT
  CHECK (payment_method_event_id IS NULL OR payment_method_event_id GLOB 'evt_*');

ALTER TABLE stripe_invoice_settlements
  ADD COLUMN payment_method_type TEXT
  CHECK (payment_method_type IS NULL OR (
    length(payment_method_type) BETWEEN 1 AND 64
    AND payment_method_type NOT GLOB '*[^a-z0-9_]*'
  ));
ALTER TABLE stripe_invoice_settlements
  ADD COLUMN payment_method_wallet TEXT
  CHECK (payment_method_wallet IS NULL OR (
    length(payment_method_wallet) BETWEEN 1 AND 64
    AND payment_method_wallet NOT GLOB '*[^a-z0-9_]*'
  ));
ALTER TABLE stripe_invoice_settlements
  ADD COLUMN payment_method_charge_id TEXT
  CHECK (payment_method_charge_id IS NULL OR payment_method_charge_id GLOB 'ch_*');
ALTER TABLE stripe_invoice_settlements
  ADD COLUMN payment_method_event_id TEXT
  CHECK (payment_method_event_id IS NULL OR payment_method_event_id GLOB 'evt_*');
ALTER TABLE stripe_invoice_settlements
  ADD COLUMN payment_method_payment_intent_id TEXT
  CHECK (
    payment_method_payment_intent_id IS NULL
    OR payment_method_payment_intent_id GLOB 'pi_*'
  );
ALTER TABLE stripe_invoice_settlements
  ADD COLUMN payment_method_amount_cents INTEGER
  CHECK (
    payment_method_amount_cents IS NULL
    OR payment_method_amount_cents BETWEEN 100 AND 500000
  );
ALTER TABLE stripe_invoice_settlements
  ADD COLUMN payment_method_livemode INTEGER
  CHECK (payment_method_livemode IS NULL OR payment_method_livemode IN (0, 1));

-- Existing gifts predate method evidence. Keep them dispatchable without
-- pretending an exact instrument is known; renderers preserve their legacy
-- wording while all newly settled gifts wait for signed Charge evidence.
UPDATE stripe_gifts
   SET payment_method_type = 'legacy_stripe'
 WHERE payment_method_type IS NULL;

CREATE TRIGGER stripe_checkout_payment_method_immutable
BEFORE UPDATE OF payment_method_type, payment_method_wallet,
  payment_method_charge_id, payment_method_event_id
ON stripe_checkout_sessions
WHEN OLD.payment_method_type IS NOT NULL
 AND OLD.payment_method_type <> 'legacy_stripe'
 AND (
   NEW.payment_method_type IS NOT OLD.payment_method_type
   OR NEW.payment_method_wallet IS NOT OLD.payment_method_wallet
   OR NEW.payment_method_charge_id IS NOT OLD.payment_method_charge_id
   OR NEW.payment_method_event_id IS NOT OLD.payment_method_event_id
 )
BEGIN
  SELECT RAISE(ABORT, 'stripe_payment_method_immutable');
END;

CREATE TRIGGER stripe_webhook_payment_method_immutable
BEFORE UPDATE OF stripe_payment_intent_id, payment_method_type,
  payment_method_wallet, payment_method_charge_id, payment_method_amount_cents
ON stripe_webhook_events
WHEN OLD.payment_method_type IS NOT NULL
 AND (
   NEW.stripe_payment_intent_id IS NOT OLD.stripe_payment_intent_id
   OR NEW.payment_method_type IS NOT OLD.payment_method_type
   OR NEW.payment_method_wallet IS NOT OLD.payment_method_wallet
   OR NEW.payment_method_charge_id IS NOT OLD.payment_method_charge_id
   OR NEW.payment_method_amount_cents IS NOT OLD.payment_method_amount_cents
 )
BEGIN
  SELECT RAISE(ABORT, 'stripe_payment_method_immutable');
END;

CREATE TRIGGER stripe_gift_payment_method_immutable
BEFORE UPDATE OF payment_method_type, payment_method_wallet,
  payment_method_charge_id, payment_method_event_id
ON stripe_gifts
WHEN OLD.payment_method_type IS NOT NULL
 AND OLD.payment_method_type <> 'legacy_stripe'
 AND (
   NEW.payment_method_type IS NOT OLD.payment_method_type
   OR NEW.payment_method_wallet IS NOT OLD.payment_method_wallet
   OR NEW.payment_method_charge_id IS NOT OLD.payment_method_charge_id
   OR NEW.payment_method_event_id IS NOT OLD.payment_method_event_id
 )
BEGIN
  SELECT RAISE(ABORT, 'stripe_payment_method_immutable');
END;

CREATE TRIGGER stripe_invoice_payment_method_immutable
BEFORE UPDATE OF payment_method_type, payment_method_wallet,
  payment_method_charge_id, payment_method_event_id,
  payment_method_payment_intent_id, payment_method_amount_cents,
  payment_method_livemode
ON stripe_invoice_settlements
WHEN OLD.payment_method_type IS NOT NULL
 AND OLD.payment_method_type <> 'legacy_stripe'
 AND (
   NEW.payment_method_type IS NOT OLD.payment_method_type
   OR NEW.payment_method_wallet IS NOT OLD.payment_method_wallet
   OR NEW.payment_method_charge_id IS NOT OLD.payment_method_charge_id
   OR NEW.payment_method_event_id IS NOT OLD.payment_method_event_id
   OR NEW.payment_method_payment_intent_id IS NOT OLD.payment_method_payment_intent_id
   OR NEW.payment_method_amount_cents IS NOT OLD.payment_method_amount_cents
   OR NEW.payment_method_livemode IS NOT OLD.payment_method_livemode
 )
BEGIN
  SELECT RAISE(ABORT, 'stripe_payment_method_immutable');
END;
