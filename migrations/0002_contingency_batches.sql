CREATE TABLE IF NOT EXISTS contingency_batches (
  id TEXT PRIMARY KEY,
  contingency_period_id TEXT NOT NULL REFERENCES contingency_periods(id),
  environment TEXT NOT NULL CHECK (environment IN ('00', '01')),
  id_envio TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'SUBMITTED', 'PROCESSING', 'DONE', 'PARTIAL', 'REJECTED', 'FAILED')),
  codigo_lote TEXT,
  request_json TEXT NOT NULL DEFAULT '{}',
  response_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT,
  line_count INTEGER NOT NULL DEFAULT 0,
  accepted_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  pending_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  submitted_at TEXT,
  last_polled_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_contingency_batches_period ON contingency_batches(contingency_period_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contingency_batches_codigo_lote ON contingency_batches(codigo_lote) WHERE codigo_lote IS NOT NULL;

CREATE TABLE IF NOT EXISTS contingency_batch_lines (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES contingency_batches(id),
  contingency_period_id TEXT NOT NULL REFERENCES contingency_periods(id),
  document_id TEXT NOT NULL REFERENCES dte_documents(id),
  line_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('LOCAL_ISSUED', 'BATCH_SENT', 'ACCEPTED', 'REJECTED', 'MANUAL_REVIEW')),
  codigo_generacion TEXT NOT NULL,
  tipo_dte TEXT NOT NULL DEFAULT '15',
  signed_jws TEXT,
  sello_recibido TEXT,
  mh_estado TEXT,
  mh_observaciones_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (document_id)
);

CREATE INDEX IF NOT EXISTS idx_contingency_batch_lines_batch ON contingency_batch_lines(batch_id, status);
CREATE INDEX IF NOT EXISTS idx_contingency_batch_lines_period ON contingency_batch_lines(contingency_period_id, status);
