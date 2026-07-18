CREATE TABLE fiscal_corrections (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_payload_sha256 TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('WOMPI_EVENT', 'DTE_DOCUMENT')),
  wompi_event_id TEXT REFERENCES wompi_events(id),
  document_id TEXT REFERENCES dte_documents(id),
  environment TEXT NOT NULL CHECK (environment IN ('00', '01')),
  status TEXT NOT NULL CHECK (status IN (
    'QUEUED', 'PROCESSING', 'ACCEPTED', 'REJECTED', 'FAILED', 'REVIEW_REQUIRED'
  )),
  before_receptor_json TEXT NOT NULL CHECK (json_valid(before_receptor_json)),
  corrected_receptor_json TEXT NOT NULL CHECK (json_valid(corrected_receptor_json)),
  changed_fields_json TEXT NOT NULL CHECK (json_valid(changed_fields_json)),
  source_document_snapshot_json TEXT
    CHECK (source_document_snapshot_json IS NULL OR json_valid(source_document_snapshot_json)),
  issuance_attempt_id TEXT,
  fiscal_claim_id TEXT,
  processing_claim_id TEXT NOT NULL,
  mh_dispatch_started_at TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processing_started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (target_kind = 'WOMPI_EVENT' AND wompi_event_id IS NOT NULL AND document_id IS NULL)
    OR
    (
      target_kind = 'DTE_DOCUMENT'
      AND document_id IS NOT NULL
      AND source_document_snapshot_json IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX uq_fiscal_corrections_wompi_attempt
  ON fiscal_corrections(wompi_event_id, attempt_number)
  WHERE target_kind = 'WOMPI_EVENT';
CREATE UNIQUE INDEX uq_fiscal_corrections_document_attempt
  ON fiscal_corrections(document_id, attempt_number)
  WHERE target_kind = 'DTE_DOCUMENT';
CREATE INDEX idx_fiscal_corrections_wompi
  ON fiscal_corrections(wompi_event_id, created_at);
CREATE INDEX idx_fiscal_corrections_document
  ON fiscal_corrections(document_id, created_at);
CREATE INDEX idx_fiscal_corrections_recovery
  ON fiscal_corrections(status, processing_started_at, created_at);
