-- n1co is a donor-selected alternative to Wompi on the SV door. An intent starts
-- on Wompi; when the donor chooses n1co, its Wompi link is deactivated and the
-- intent moves to n1co exactly once. The binding resolver accepts an approved
-- payment only from the intent's current provider, so a late payment through the
-- abandoned provider is quarantined instead of producing a second CDE.
ALTER TABLE donation_intents
  ADD COLUMN payment_provider TEXT NOT NULL DEFAULT 'WOMPI'
  CHECK (payment_provider IN ('WOMPI', 'N1CO'));
ALTER TABLE donation_intents ADD COLUMN n1co_order_id INTEGER;
ALTER TABLE donation_intents ADD COLUMN n1co_order_code TEXT;
ALTER TABLE donation_intents ADD COLUMN n1co_payment_link_url TEXT;
-- First time this Worker saw the order PAID. It becomes the event's
-- FechaTransaccion, so webhook and reconciliation replays stay byte-identical.
ALTER TABLE donation_intents ADD COLUMN n1co_paid_observed_at TEXT;
ALTER TABLE donation_intents ADD COLUMN n1co_checked_at TEXT;

CREATE UNIQUE INDEX donation_intents_n1co_order_id_unique
  ON donation_intents (n1co_order_id)
  WHERE n1co_order_id IS NOT NULL;
CREATE UNIQUE INDEX donation_intents_n1co_order_code_unique
  ON donation_intents (n1co_order_code)
  WHERE n1co_order_code IS NOT NULL;

-- The provider switch is one-way and only for an unpaid intent carrying the
-- complete n1co order identity.
CREATE TRIGGER donation_intents_payment_provider_switch_guard
BEFORE UPDATE OF payment_provider ON donation_intents
FOR EACH ROW
WHEN NEW.payment_provider IS NOT OLD.payment_provider
BEGIN
  SELECT RAISE(ABORT, 'donation_intent_provider_switch_invalid')
  WHERE OLD.payment_provider <> 'WOMPI'
     OR NEW.payment_provider <> 'N1CO'
     OR OLD.paid_at IS NOT NULL
     OR NEW.n1co_order_id IS NULL
     OR NEW.n1co_order_code IS NULL
     OR NEW.n1co_payment_link_url IS NULL;
END;

-- Once set, the n1co order identity never changes.
CREATE TRIGGER donation_intents_n1co_identity_immutable
BEFORE UPDATE OF n1co_order_id, n1co_order_code, n1co_payment_link_url ON donation_intents
FOR EACH ROW
WHEN (OLD.n1co_order_id IS NOT NULL AND NEW.n1co_order_id IS NOT OLD.n1co_order_id)
  OR (OLD.n1co_order_code IS NOT NULL AND NEW.n1co_order_code IS NOT OLD.n1co_order_code)
  OR (OLD.n1co_payment_link_url IS NOT NULL AND NEW.n1co_payment_link_url IS NOT OLD.n1co_payment_link_url)
BEGIN
  SELECT RAISE(ABORT, 'donation_intent_n1co_identity_immutable');
END;
