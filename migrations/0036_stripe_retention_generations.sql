-- Monotonic membership fence for referentially consistent Stripe retention
-- exports. A generation changes only when a row is inserted or when a field
-- that controls paging or a foreign-key identity changes. Mutable lifecycle,
-- refund, and delivery state keeps its generation and remains snapshot-visible.
CREATE TABLE stripe_retention_generations (
  generation INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL CHECK (table_name IN (
    'stripe_checkout_sessions',
    'stripe_webhook_events',
    'stripe_gifts',
    'stripe_acknowledgment_deliveries',
    'stripe_annual_statement_deliveries'
  )),
  row_id TEXT NOT NULL,
  UNIQUE (table_name, row_id)
);

INSERT INTO stripe_retention_generations (table_name, row_id)
SELECT 'stripe_checkout_sessions', id FROM stripe_checkout_sessions ORDER BY rowid;
INSERT INTO stripe_retention_generations (table_name, row_id)
SELECT 'stripe_webhook_events', id FROM stripe_webhook_events ORDER BY rowid;
INSERT INTO stripe_retention_generations (table_name, row_id)
SELECT 'stripe_gifts', id FROM stripe_gifts ORDER BY rowid;
INSERT INTO stripe_retention_generations (table_name, row_id)
SELECT 'stripe_acknowledgment_deliveries', id
  FROM stripe_acknowledgment_deliveries ORDER BY rowid;
INSERT INTO stripe_retention_generations (table_name, row_id)
SELECT 'stripe_annual_statement_deliveries', id
  FROM stripe_annual_statement_deliveries ORDER BY rowid;

CREATE TRIGGER stripe_checkout_retention_generation_insert
AFTER INSERT ON stripe_checkout_sessions
BEGIN
  INSERT INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_checkout_sessions', NEW.id);
END;

CREATE TRIGGER stripe_checkout_retention_generation_delete
AFTER DELETE ON stripe_checkout_sessions
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_checkout_sessions' AND row_id = OLD.id;
END;

CREATE TRIGGER stripe_checkout_retention_generation_update
AFTER UPDATE OF id, created_at ON stripe_checkout_sessions
WHEN NEW.id IS NOT OLD.id OR NEW.created_at IS NOT OLD.created_at
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_checkout_sessions' AND row_id = OLD.id;
  INSERT INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_checkout_sessions', NEW.id);
END;

CREATE TRIGGER stripe_webhook_retention_generation_insert
AFTER INSERT ON stripe_webhook_events
BEGIN
  INSERT INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_webhook_events', NEW.id);
END;

CREATE TRIGGER stripe_webhook_retention_generation_delete
AFTER DELETE ON stripe_webhook_events
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_webhook_events' AND row_id = OLD.id;
END;

CREATE TRIGGER stripe_webhook_retention_generation_update
AFTER UPDATE OF id, received_at ON stripe_webhook_events
WHEN NEW.id IS NOT OLD.id OR NEW.received_at IS NOT OLD.received_at
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_webhook_events' AND row_id = OLD.id;
  INSERT INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_webhook_events', NEW.id);
END;

CREATE TRIGGER stripe_gift_retention_generation_insert
AFTER INSERT ON stripe_gifts
BEGIN
  INSERT INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_gifts', NEW.id);
END;

CREATE TRIGGER stripe_gift_retention_generation_delete
AFTER DELETE ON stripe_gifts
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_gifts' AND row_id = OLD.id;
END;

CREATE TRIGGER stripe_gift_retention_generation_update
AFTER UPDATE OF id, checkout_id, created_at ON stripe_gifts
WHEN NEW.id IS NOT OLD.id
  OR NEW.checkout_id IS NOT OLD.checkout_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_gifts' AND row_id = OLD.id;
  INSERT INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_gifts', NEW.id);
END;

CREATE TRIGGER stripe_acknowledgment_retention_generation_insert
AFTER INSERT ON stripe_acknowledgment_deliveries
BEGIN
  INSERT INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_acknowledgment_deliveries', NEW.id);
END;

CREATE TRIGGER stripe_acknowledgment_retention_generation_delete
AFTER DELETE ON stripe_acknowledgment_deliveries
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_acknowledgment_deliveries' AND row_id = OLD.id;
END;

CREATE TRIGGER stripe_acknowledgment_retention_generation_update
AFTER UPDATE OF id, gift_id, created_at ON stripe_acknowledgment_deliveries
WHEN NEW.id IS NOT OLD.id
  OR NEW.gift_id IS NOT OLD.gift_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_acknowledgment_deliveries' AND row_id = OLD.id;
  INSERT INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_acknowledgment_deliveries', NEW.id);
END;

CREATE TRIGGER stripe_annual_statement_retention_generation_insert
AFTER INSERT ON stripe_annual_statement_deliveries
BEGIN
  INSERT INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_annual_statement_deliveries', NEW.id);
END;

CREATE TRIGGER stripe_annual_statement_retention_generation_delete
AFTER DELETE ON stripe_annual_statement_deliveries
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_annual_statement_deliveries' AND row_id = OLD.id;
END;

CREATE TRIGGER stripe_annual_statement_retention_generation_update
AFTER UPDATE OF id, supersedes_delivery_id, created_at
ON stripe_annual_statement_deliveries
WHEN NEW.id IS NOT OLD.id
  OR NEW.supersedes_delivery_id IS NOT OLD.supersedes_delivery_id
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_annual_statement_deliveries' AND row_id = OLD.id;
  INSERT INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_annual_statement_deliveries', NEW.id);
END;
