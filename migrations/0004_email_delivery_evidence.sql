-- Adds outbound-email evidence columns to email_deliveries.
--
-- Idempotent by design: commit 4fe442a also added these columns to the fresh
-- schema in 0001_init.sql, so on a brand-new database the table already has
-- them and a bare `ALTER TABLE ADD COLUMN` would fail with "duplicate column
-- name". To work on BOTH a fresh DB (columns present) and a DB migrated before
-- 4fe442a (columns absent), we rebuild the table to its canonical shape and
-- copy only the seven columns that exist in every prior version. The evidence
-- columns default to NULL, which is exactly their value on any pre-existing row.
--
-- Databases that already applied the previous version of this migration keep it
-- recorded as applied and never re-run it, so this rewrite only affects fresh
-- databases (e.g. CI runners).
--
-- email_deliveries has no inbound foreign keys and no indexes, so a rebuild is
-- safe; defer_foreign_keys keeps its outbound FK to dte_documents happy while
-- the table is swapped.
PRAGMA defer_foreign_keys = ON;

ALTER TABLE email_deliveries RENAME TO email_deliveries_pre0004;

CREATE TABLE email_deliveries (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES dte_documents(id),
  to_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  provider_response_json TEXT NOT NULL DEFAULT '{}',
  email_type TEXT,
  document_status_at_send TEXT,
  template_version TEXT,
  pdf_renderer_version TEXT,
  pdf_sha256 TEXT,
  dte_json_sha256 TEXT,
  provider_delivery_id TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO email_deliveries (
  id,
  document_id,
  to_email,
  status,
  provider_response_json,
  sent_at,
  created_at
)
SELECT
  id,
  document_id,
  to_email,
  status,
  provider_response_json,
  sent_at,
  created_at
FROM email_deliveries_pre0004;

DROP TABLE email_deliveries_pre0004;
