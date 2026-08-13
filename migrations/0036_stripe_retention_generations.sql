-- Monotonic membership fence for referentially consistent Stripe retention
-- exports. The complete permanent trigger set is installed before backfill, so
-- an insert, update, or delete interleaved between migration statements is
-- tracked without relying on file-wide transactional isolation.
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

CREATE INDEX idx_stripe_retention_generations_table_generation
  ON stripe_retention_generations(table_name, generation, row_id);

-- Membership generations make paged inserts/deletes restorable. This separate
-- epoch also fences every material lifecycle update so a multi-table export can
-- never publish a manifest assembled from different points in time.
CREATE TABLE stripe_retention_material_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  mutation_epoch INTEGER NOT NULL DEFAULT 0 CHECK (mutation_epoch >= 0)
);

INSERT INTO stripe_retention_material_state (singleton, mutation_epoch)
VALUES (1, 0);

CREATE TRIGGER stripe_checkout_retention_material_insert
AFTER INSERT ON stripe_checkout_sessions
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER stripe_checkout_retention_material_update
AFTER UPDATE ON stripe_checkout_sessions
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER stripe_checkout_retention_material_delete
AFTER DELETE ON stripe_checkout_sessions
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER stripe_webhook_retention_material_insert
AFTER INSERT ON stripe_webhook_events
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER stripe_webhook_retention_material_update
AFTER UPDATE ON stripe_webhook_events
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER stripe_webhook_retention_material_delete
AFTER DELETE ON stripe_webhook_events
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER stripe_gift_retention_material_insert
AFTER INSERT ON stripe_gifts
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER stripe_gift_retention_material_update
AFTER UPDATE ON stripe_gifts
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER stripe_gift_retention_material_delete
AFTER DELETE ON stripe_gifts
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER stripe_acknowledgment_retention_material_insert
AFTER INSERT ON stripe_acknowledgment_deliveries
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER stripe_acknowledgment_retention_material_update
AFTER UPDATE ON stripe_acknowledgment_deliveries
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER stripe_acknowledgment_retention_material_delete
AFTER DELETE ON stripe_acknowledgment_deliveries
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER stripe_annual_statement_retention_material_insert
AFTER INSERT ON stripe_annual_statement_deliveries
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER stripe_annual_statement_retention_material_update
AFTER UPDATE ON stripe_annual_statement_deliveries
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER stripe_annual_statement_retention_material_delete
AFTER DELETE ON stripe_annual_statement_deliveries
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER stripe_checkout_retention_generation_insert
AFTER INSERT ON stripe_checkout_sessions
BEGIN
  INSERT OR IGNORE INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_checkout_sessions', NEW.id);
END;

CREATE TRIGGER stripe_checkout_retention_generation_delete
AFTER DELETE ON stripe_checkout_sessions
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_checkout_sessions' AND row_id = OLD.id;
END;

CREATE TRIGGER stripe_checkout_retention_generation_update
AFTER UPDATE OF id ON stripe_checkout_sessions
WHEN NEW.id IS NOT OLD.id
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_checkout_sessions' AND row_id = OLD.id;
  INSERT INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_checkout_sessions', NEW.id);
END;

CREATE TRIGGER stripe_webhook_retention_generation_insert
AFTER INSERT ON stripe_webhook_events
BEGIN
  INSERT OR IGNORE INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_webhook_events', NEW.id);
END;

CREATE TRIGGER stripe_webhook_retention_generation_delete
AFTER DELETE ON stripe_webhook_events
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_webhook_events' AND row_id = OLD.id;
END;

CREATE TRIGGER stripe_webhook_retention_generation_update
AFTER UPDATE OF id ON stripe_webhook_events
WHEN NEW.id IS NOT OLD.id
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_webhook_events' AND row_id = OLD.id;
  INSERT INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_webhook_events', NEW.id);
END;

CREATE TRIGGER stripe_gift_retention_generation_insert
AFTER INSERT ON stripe_gifts
BEGIN
  INSERT OR IGNORE INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_gifts', NEW.id);
END;

CREATE TRIGGER stripe_gift_retention_generation_delete
AFTER DELETE ON stripe_gifts
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_gifts' AND row_id = OLD.id;
END;

CREATE TRIGGER stripe_gift_retention_generation_update
AFTER UPDATE OF id, checkout_id ON stripe_gifts
WHEN NEW.id IS NOT OLD.id OR NEW.checkout_id IS NOT OLD.checkout_id
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_gifts' AND row_id = OLD.id;
  INSERT INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_gifts', NEW.id);
END;

CREATE TRIGGER stripe_acknowledgment_retention_generation_insert
AFTER INSERT ON stripe_acknowledgment_deliveries
BEGIN
  INSERT OR IGNORE INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_acknowledgment_deliveries', NEW.id);
END;

CREATE TRIGGER stripe_acknowledgment_retention_generation_delete
AFTER DELETE ON stripe_acknowledgment_deliveries
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_acknowledgment_deliveries' AND row_id = OLD.id;
END;

CREATE TRIGGER stripe_acknowledgment_retention_generation_update
AFTER UPDATE OF id, gift_id ON stripe_acknowledgment_deliveries
WHEN NEW.id IS NOT OLD.id OR NEW.gift_id IS NOT OLD.gift_id
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_acknowledgment_deliveries' AND row_id = OLD.id;
  INSERT INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_acknowledgment_deliveries', NEW.id);
END;

CREATE TRIGGER stripe_annual_statement_retention_generation_insert
AFTER INSERT ON stripe_annual_statement_deliveries
BEGIN
  -- A migration-time writer can reference a parent that exists but has not yet
  -- been backfilled. Materialize the complete immutable ancestry root-first so
  -- every descendant generation is strictly greater than every ancestor.
  INSERT OR IGNORE INTO stripe_retention_generations (table_name, row_id)
  WITH RECURSIVE annual_ancestry(id, supersedes_delivery_id, depth, path) AS (
    SELECT NEW.id, NEW.supersedes_delivery_id, 0, '|' || NEW.id || '|'
    UNION ALL
    SELECT parent.id, parent.supersedes_delivery_id, ancestry.depth + 1,
           ancestry.path || parent.id || '|'
      FROM stripe_annual_statement_deliveries AS parent
      JOIN annual_ancestry AS ancestry
        ON parent.id = ancestry.supersedes_delivery_id
     WHERE instr(ancestry.path, '|' || parent.id || '|') = 0
  )
  SELECT 'stripe_annual_statement_deliveries', id
    FROM annual_ancestry
   ORDER BY depth DESC;
END;

CREATE TRIGGER stripe_annual_statement_retention_generation_delete
AFTER DELETE ON stripe_annual_statement_deliveries
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_annual_statement_deliveries' AND row_id = OLD.id;
END;

CREATE TRIGGER stripe_annual_statement_retention_generation_update
AFTER UPDATE OF id, supersedes_delivery_id
ON stripe_annual_statement_deliveries
WHEN NEW.id IS NOT OLD.id OR NEW.supersedes_delivery_id IS NOT OLD.supersedes_delivery_id
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_annual_statement_deliveries' AND row_id = OLD.id;
  INSERT INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_annual_statement_deliveries', NEW.id);
END;

-- Idempotent backfills cover rows written before tracking was installed. Rows
-- captured by a trigger while a backfill is running keep their earlier generation.
INSERT OR IGNORE INTO stripe_retention_generations (table_name, row_id)
SELECT 'stripe_checkout_sessions', id FROM stripe_checkout_sessions ORDER BY rowid;
INSERT OR IGNORE INTO stripe_retention_generations (table_name, row_id)
SELECT 'stripe_webhook_events', id FROM stripe_webhook_events ORDER BY rowid;
INSERT OR IGNORE INTO stripe_retention_generations (table_name, row_id)
SELECT 'stripe_gifts', id FROM stripe_gifts ORDER BY rowid;
INSERT OR IGNORE INTO stripe_retention_generations (table_name, row_id)
SELECT 'stripe_acknowledgment_deliveries', id
  FROM stripe_acknowledgment_deliveries ORDER BY rowid;
INSERT OR IGNORE INTO stripe_retention_generations (table_name, row_id)
WITH RECURSIVE annual_lineage(id, depth, path) AS (
  SELECT id, 0, '|' || id || '|'
    FROM stripe_annual_statement_deliveries
   WHERE supersedes_delivery_id IS NULL
  UNION ALL
  SELECT child.id, lineage.depth + 1, lineage.path || child.id || '|'
    FROM stripe_annual_statement_deliveries AS child
    JOIN annual_lineage AS lineage
      ON child.supersedes_delivery_id = lineage.id
   WHERE instr(lineage.path, '|' || child.id || '|') = 0
)
SELECT 'stripe_annual_statement_deliveries', id
  FROM annual_lineage
 ORDER BY depth ASC, id ASC;
