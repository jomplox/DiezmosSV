-- Final integrity fences for the isolated U.S. Stripe lane. Applied migrations
-- 0032-0037 remain immutable; this migration rebuilds only Stripe-owned delivery
-- tables whose original uniqueness constraints cannot be relaxed with ALTER TABLE.

CREATE TABLE stripe_provider_recovery_reads (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('OPEN_REPLAY', 'STATUS_RECOVERY')),
  identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64),
  ip_hash TEXT NOT NULL CHECK (length(ip_hash) = 64),
  status TEXT NOT NULL CHECK (status IN ('PROCESSING', 'COMPLETE', 'FAILED')),
  provider_started_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  CHECK ((status = 'PROCESSING' AND completed_at IS NULL)
      OR (status <> 'PROCESSING' AND completed_at IS NOT NULL))
);

CREATE UNIQUE INDEX idx_stripe_provider_recovery_active
  ON stripe_provider_recovery_reads(kind, identity_hash)
  WHERE status = 'PROCESSING';
CREATE INDEX idx_stripe_provider_recovery_identity_budget
  ON stripe_provider_recovery_reads(identity_hash, created_at);
CREATE INDEX idx_stripe_provider_recovery_ip_budget
  ON stripe_provider_recovery_reads(ip_hash, created_at);
CREATE INDEX idx_stripe_provider_recovery_expiry
  ON stripe_provider_recovery_reads(expires_at);
CREATE INDEX idx_stripe_provider_recovery_lease
  ON stripe_provider_recovery_reads(status, lease_expires_at);

-- invoice.paid can also mean an out-of-band/manual payment. Keep each side of
-- Stripe's unordered invoice evidence until a paid InvoicePayment proves that
-- the payment is a PaymentIntent, then record the gift exactly once.
CREATE TABLE stripe_invoice_settlements (
  invoice_id TEXT PRIMARY KEY,
  checkout_id TEXT REFERENCES stripe_checkout_sessions(id),
  subscription_id TEXT,
  amount_cents INTEGER CHECK (amount_cents IS NULL OR amount_cents BETWEEN 100 AND 500000),
  currency TEXT CHECK (currency IS NULL OR currency = 'usd'),
  donor_name TEXT,
  donor_email TEXT,
  settled_at TEXT,
  invoice_livemode INTEGER CHECK (invoice_livemode IS NULL OR invoice_livemode IN (0, 1)),
  invoice_event_id TEXT UNIQUE,
  invoice_payment_id TEXT UNIQUE,
  payment_intent_id TEXT UNIQUE,
  payment_amount_cents INTEGER CHECK (
    payment_amount_cents IS NULL OR payment_amount_cents BETWEEN 100 AND 500000
  ),
  payment_currency TEXT CHECK (payment_currency IS NULL OR payment_currency = 'usd'),
  payment_livemode INTEGER CHECK (payment_livemode IS NULL OR payment_livemode IN (0, 1)),
  payment_event_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RECORDED', 'REVIEW')),
  gift_id TEXT UNIQUE REFERENCES stripe_gifts(id),
  failure_code TEXT,
  recorded_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (invoice_payment_id IS NULL AND payment_intent_id IS NULL
      AND payment_amount_cents IS NULL AND payment_currency IS NULL
      AND payment_livemode IS NULL AND payment_event_id IS NULL)
    OR
    (invoice_payment_id IS NOT NULL AND payment_intent_id IS NOT NULL
      AND payment_amount_cents IS NOT NULL AND payment_currency IS NOT NULL
      AND payment_livemode IS NOT NULL AND payment_event_id IS NOT NULL)
  ),
  CHECK (
    (status = 'RECORDED' AND gift_id IS NOT NULL AND recorded_at IS NOT NULL AND failure_code IS NULL)
    OR status <> 'RECORDED'
  ),
  CHECK ((status = 'REVIEW' AND failure_code IS NOT NULL) OR status <> 'REVIEW')
);

CREATE INDEX idx_stripe_invoice_settlements_pending
  ON stripe_invoice_settlements(status, updated_at);

-- Migration 0036's applied retention-ledger CHECK cannot be widened in place.
-- Give invoice convergence rows their own monotonic membership ledger while the
-- shared material epoch continues to fence cross-table lifecycle mutations.
CREATE TABLE stripe_invoice_settlement_retention_generations (
  generation INTEGER PRIMARY KEY AUTOINCREMENT,
  row_id TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_stripe_invoice_settlement_retention_generation
  ON stripe_invoice_settlement_retention_generations(generation, row_id);

CREATE TRIGGER stripe_invoice_settlement_retention_material_insert
AFTER INSERT ON stripe_invoice_settlements
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;
CREATE TRIGGER stripe_invoice_settlement_retention_material_update
AFTER UPDATE ON stripe_invoice_settlements
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;
CREATE TRIGGER stripe_invoice_settlement_retention_material_delete
AFTER DELETE ON stripe_invoice_settlements
BEGIN
  UPDATE stripe_retention_material_state SET mutation_epoch = mutation_epoch + 1 WHERE singleton = 1;
END;
CREATE TRIGGER stripe_invoice_settlement_retention_generation_insert
AFTER INSERT ON stripe_invoice_settlements
BEGIN
  INSERT OR IGNORE INTO stripe_invoice_settlement_retention_generations (row_id)
  VALUES (NEW.invoice_id);
END;
CREATE TRIGGER stripe_invoice_settlement_retention_generation_delete
AFTER DELETE ON stripe_invoice_settlements
BEGIN
  DELETE FROM stripe_invoice_settlement_retention_generations
   WHERE row_id = OLD.invoice_id;
END;
CREATE TRIGGER stripe_invoice_settlement_retention_generation_update
AFTER UPDATE OF invoice_id, checkout_id, gift_id ON stripe_invoice_settlements
WHEN NEW.invoice_id IS NOT OLD.invoice_id
  OR NEW.checkout_id IS NOT OLD.checkout_id
  OR NEW.gift_id IS NOT OLD.gift_id
BEGIN
  DELETE FROM stripe_invoice_settlement_retention_generations
   WHERE row_id = OLD.invoice_id;
  INSERT INTO stripe_invoice_settlement_retention_generations (row_id)
  VALUES (NEW.invoice_id);
END;

INSERT OR IGNORE INTO stripe_invoice_settlement_retention_generations (row_id)
SELECT invoice_id FROM stripe_invoice_settlements ORDER BY rowid;

DROP TRIGGER stripe_acknowledgment_retention_material_insert;
DROP TRIGGER stripe_acknowledgment_retention_material_update;
DROP TRIGGER stripe_acknowledgment_retention_material_delete;
DROP TRIGGER stripe_acknowledgment_retention_generation_insert;
DROP TRIGGER stripe_acknowledgment_retention_generation_delete;
DROP TRIGGER stripe_acknowledgment_retention_generation_update;

ALTER TABLE stripe_acknowledgment_deliveries
  RENAME TO stripe_acknowledgment_deliveries_0037;

CREATE TABLE stripe_acknowledgment_deliveries (
  id TEXT PRIMARY KEY,
  gift_id TEXT NOT NULL REFERENCES stripe_gifts(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('ORIGINAL', 'PARTIAL_REFUND', 'FULL_REFUND')),
  supersedes_delivery_id TEXT REFERENCES stripe_acknowledgment_deliveries(id),
  evidence_refunded_amount_cents INTEGER NOT NULL CHECK (evidence_refunded_amount_cents >= 0),
  snapshot_hash TEXT CHECK (snapshot_hash IS NULL OR length(snapshot_hash) = 64),
  snapshot_json TEXT CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'REVIEW')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  processing_claim_id TEXT,
  dispatch_started_at TEXT,
  provider_id_hash TEXT,
  failure_code TEXT,
  retry_safe INTEGER NOT NULL DEFAULT 0 CHECK (retry_safe IN (0, 1)),
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (gift_id, revision),
  UNIQUE (gift_id, evidence_refunded_amount_cents),
  CHECK (supersedes_delivery_id IS NULL OR supersedes_delivery_id <> id),
  CHECK ((kind = 'ORIGINAL' AND evidence_refunded_amount_cents = 0)
      OR (kind <> 'ORIGINAL' AND evidence_refunded_amount_cents > 0)),
  CHECK ((snapshot_hash IS NULL AND snapshot_json IS NULL)
      OR (snapshot_hash IS NOT NULL AND snapshot_json IS NOT NULL)),
  CHECK ((status = 'PROCESSING' AND processing_claim_id IS NOT NULL)
      OR (status <> 'PROCESSING' AND processing_claim_id IS NULL)),
  CHECK ((status = 'SENT' AND sent_at IS NOT NULL AND dispatch_started_at IS NOT NULL)
      OR status <> 'SENT'),
  CHECK ((status IN ('FAILED', 'REVIEW') AND failure_code IS NOT NULL)
      OR status NOT IN ('FAILED', 'REVIEW')),
  CHECK (retry_safe = 0 OR status = 'FAILED')
);

INSERT INTO stripe_acknowledgment_deliveries (
  id, gift_id, revision, kind, supersedes_delivery_id,
  evidence_refunded_amount_cents, snapshot_hash, snapshot_json,
  status, attempt_count, processing_claim_id, dispatch_started_at,
  provider_id_hash, failure_code, retry_safe, last_attempt_at,
  next_attempt_at, sent_at, created_at, updated_at
)
SELECT id, gift_id, 1, 'ORIGINAL', NULL, 0, NULL, NULL,
       status, attempt_count, processing_claim_id, dispatch_started_at,
       provider_id_hash, failure_code, retry_safe, last_attempt_at,
       next_attempt_at, sent_at, created_at, updated_at
  FROM stripe_acknowledgment_deliveries_0037;

DROP TABLE stripe_acknowledgment_deliveries_0037;

CREATE INDEX idx_stripe_acknowledgments_retry
  ON stripe_acknowledgment_deliveries(status, retry_safe, updated_at);
CREATE INDEX idx_stripe_acknowledgment_due
  ON stripe_acknowledgment_deliveries(status, retry_safe, next_attempt_at, created_at, id);
CREATE INDEX idx_stripe_acknowledgment_gift_revision
  ON stripe_acknowledgment_deliveries(gift_id, revision DESC);

CREATE TRIGGER stripe_acknowledgment_identity_immutable
BEFORE UPDATE OF gift_id, revision, kind, supersedes_delivery_id,
  evidence_refunded_amount_cents
ON stripe_acknowledgment_deliveries
BEGIN
  SELECT RAISE(ABORT, 'stripe_acknowledgment_identity_immutable');
END;

CREATE TRIGGER stripe_acknowledgment_snapshot_immutable
BEFORE UPDATE OF snapshot_hash, snapshot_json
ON stripe_acknowledgment_deliveries
WHEN OLD.snapshot_hash IS NOT NULL OR OLD.snapshot_json IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'stripe_acknowledgment_snapshot_immutable');
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

DROP TRIGGER stripe_annual_statement_snapshot_immutable;
DROP TRIGGER stripe_annual_statement_retention_material_insert;
DROP TRIGGER stripe_annual_statement_retention_material_update;
DROP TRIGGER stripe_annual_statement_retention_material_delete;
DROP TRIGGER stripe_annual_statement_retention_generation_insert;
DROP TRIGGER stripe_annual_statement_retention_generation_delete;
DROP TRIGGER stripe_annual_statement_retention_generation_update;

ALTER TABLE stripe_annual_statement_deliveries
  RENAME TO stripe_annual_statement_deliveries_0037;

CREATE TABLE stripe_annual_statement_deliveries (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  donor_key TEXT NOT NULL CHECK (length(donor_key) > 0),
  donor_name TEXT NOT NULL CHECK (length(donor_name) > 0),
  donor_email TEXT,
  snapshot_hash TEXT NOT NULL CHECK (length(snapshot_hash) = 64),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  supersedes_delivery_id TEXT REFERENCES stripe_annual_statement_deliveries(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'REVIEW')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  processing_claim_id TEXT,
  lease_expires_at TEXT,
  dispatch_started_at TEXT,
  provider_id_hash TEXT,
  failure_code TEXT,
  retry_safe INTEGER NOT NULL DEFAULT 0 CHECK (retry_safe IN (0, 1)),
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (year, livemode, donor_key, revision),
  CHECK (supersedes_delivery_id IS NULL OR supersedes_delivery_id <> id),
  CHECK ((status = 'PROCESSING' AND processing_claim_id IS NOT NULL
      AND lease_expires_at IS NOT NULL AND attempt_count >= 1)
    OR (status <> 'PROCESSING' AND processing_claim_id IS NULL AND lease_expires_at IS NULL)),
  CHECK ((status = 'SENT' AND sent_at IS NOT NULL AND dispatch_started_at IS NOT NULL
      AND provider_id_hash IS NOT NULL AND failure_code IS NULL AND retry_safe = 0)
    OR status <> 'SENT'),
  CHECK ((status IN ('FAILED', 'REVIEW') AND failure_code IS NOT NULL)
      OR status NOT IN ('FAILED', 'REVIEW')),
  CHECK (retry_safe = 0 OR status = 'FAILED')
);

INSERT INTO stripe_annual_statement_deliveries (
  id, year, livemode, donor_key, donor_name, donor_email,
  snapshot_hash, snapshot_json, revision, supersedes_delivery_id,
  status, attempt_count, processing_claim_id, lease_expires_at,
  dispatch_started_at, provider_id_hash, failure_code, retry_safe,
  sent_at, created_at, updated_at
)
SELECT id, year, livemode, donor_key, donor_name, donor_email,
       snapshot_hash, snapshot_json, revision, supersedes_delivery_id,
       status, attempt_count, processing_claim_id,
       CASE WHEN status = 'PROCESSING'
            THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+5 minutes') ELSE NULL END,
       dispatch_started_at, provider_id_hash, failure_code, retry_safe,
       sent_at, created_at, updated_at
  FROM stripe_annual_statement_deliveries_0037
 ORDER BY year, livemode, donor_key, revision;

DROP TABLE stripe_annual_statement_deliveries_0037;

CREATE INDEX idx_stripe_annual_statement_work
  ON stripe_annual_statement_deliveries(status, retry_safe, lease_expires_at, updated_at);
CREATE INDEX idx_stripe_annual_statement_donor
  ON stripe_annual_statement_deliveries(year, livemode, donor_key, revision DESC);

CREATE TRIGGER stripe_annual_statement_snapshot_immutable
BEFORE UPDATE OF year, livemode, donor_key, donor_name, donor_email,
  snapshot_hash, snapshot_json, revision, supersedes_delivery_id
ON stripe_annual_statement_deliveries
BEGIN
  SELECT RAISE(ABORT, 'stripe_annual_statement_snapshot_immutable');
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
CREATE TRIGGER stripe_annual_statement_retention_generation_insert
AFTER INSERT ON stripe_annual_statement_deliveries
BEGIN
  INSERT OR IGNORE INTO stripe_retention_generations (table_name, row_id)
  WITH RECURSIVE annual_ancestry(id, supersedes_delivery_id, depth, path) AS (
    SELECT NEW.id, NEW.supersedes_delivery_id, 0, '|' || NEW.id || '|'
    UNION ALL
    SELECT parent.id, parent.supersedes_delivery_id, ancestry.depth + 1,
           ancestry.path || parent.id || '|'
      FROM stripe_annual_statement_deliveries AS parent
      JOIN annual_ancestry AS ancestry ON parent.id = ancestry.supersedes_delivery_id
     WHERE instr(ancestry.path, '|' || parent.id || '|') = 0
  )
  SELECT 'stripe_annual_statement_deliveries', id FROM annual_ancestry ORDER BY depth DESC;
END;
CREATE TRIGGER stripe_annual_statement_retention_generation_delete
AFTER DELETE ON stripe_annual_statement_deliveries
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_annual_statement_deliveries' AND row_id = OLD.id;
END;
CREATE TRIGGER stripe_annual_statement_retention_generation_update
AFTER UPDATE OF id, supersedes_delivery_id ON stripe_annual_statement_deliveries
WHEN NEW.id IS NOT OLD.id OR NEW.supersedes_delivery_id IS NOT OLD.supersedes_delivery_id
BEGIN
  DELETE FROM stripe_retention_generations
   WHERE table_name = 'stripe_annual_statement_deliveries' AND row_id = OLD.id;
  INSERT INTO stripe_retention_generations (table_name, row_id)
  VALUES ('stripe_annual_statement_deliveries', NEW.id);
END;

CREATE INDEX idx_stripe_gifts_annual_range
  ON stripe_gifts(settled_at, id, checkout_id)
  WHERE status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED');
CREATE INDEX idx_stripe_gifts_annual_donor_range
  ON stripe_gifts(LOWER(TRIM(donor_email)), settled_at, id)
  WHERE status IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED');
