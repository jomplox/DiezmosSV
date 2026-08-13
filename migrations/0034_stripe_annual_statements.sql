-- Immutable, retry-safe annual statements for the U.S. Stripe lane. This table is
-- deliberately separate from immediate acknowledgments and every SV/CDE table.
CREATE TABLE stripe_annual_statement_deliveries (
  id TEXT PRIMARY KEY,
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 9999),
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  donor_key TEXT NOT NULL CHECK (LENGTH(donor_key) > 0),
  donor_name TEXT NOT NULL CHECK (LENGTH(donor_name) > 0),
  donor_email TEXT,
  snapshot_hash TEXT NOT NULL CHECK (LENGTH(snapshot_hash) = 64),
  snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  supersedes_delivery_id TEXT REFERENCES stripe_annual_statement_deliveries(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'REVIEW')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  processing_claim_id TEXT,
  dispatch_started_at TEXT,
  provider_id_hash TEXT,
  failure_code TEXT,
  retry_safe INTEGER NOT NULL DEFAULT 0 CHECK (retry_safe IN (0, 1)),
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (year, livemode, donor_key, snapshot_hash),
  UNIQUE (year, livemode, donor_key, revision),
  CHECK (supersedes_delivery_id IS NULL OR supersedes_delivery_id <> id),
  CHECK (
    (status = 'PROCESSING' AND processing_claim_id IS NOT NULL AND attempt_count >= 1)
    OR (status <> 'PROCESSING' AND processing_claim_id IS NULL)
  ),
  CHECK (
    (status = 'SENT' AND sent_at IS NOT NULL AND dispatch_started_at IS NOT NULL
      AND provider_id_hash IS NOT NULL AND failure_code IS NULL AND retry_safe = 0)
    OR status <> 'SENT'
  ),
  CHECK ((status IN ('FAILED', 'REVIEW') AND failure_code IS NOT NULL) OR status NOT IN ('FAILED', 'REVIEW')),
  CHECK (retry_safe = 0 OR status = 'FAILED')
);

CREATE INDEX idx_stripe_annual_statement_work
  ON stripe_annual_statement_deliveries(status, retry_safe, updated_at);
CREATE INDEX idx_stripe_annual_statement_donor
  ON stripe_annual_statement_deliveries(year, livemode, donor_key, revision DESC);

-- Snapshot identity, contents, and revision lineage are write-once audit evidence.
CREATE TRIGGER stripe_annual_statement_snapshot_immutable
BEFORE UPDATE OF year, livemode, donor_key, donor_name, donor_email,
  snapshot_hash, snapshot_json, revision, supersedes_delivery_id
ON stripe_annual_statement_deliveries
BEGIN
  SELECT RAISE(ABORT, 'stripe_annual_statement_snapshot_immutable');
END;
