PRAGMA defer_foreign_keys = ON;

ALTER TABLE email_deliveries RENAME TO email_deliveries_old;
ALTER TABLE contingency_batch_lines RENAME TO contingency_batch_lines_old;
ALTER TABLE contingency_batches RENAME TO contingency_batches_old;
ALTER TABLE contingency_periods RENAME TO contingency_periods_old;
ALTER TABLE dte_events RENAME TO dte_events_old;
ALTER TABLE dte_documents RENAME TO dte_documents_old;

CREATE TABLE dte_documents (
  id TEXT PRIMARY KEY,
  wompi_event_id TEXT REFERENCES wompi_events(id),
  tipo_dte TEXT NOT NULL DEFAULT '15',
  environment TEXT NOT NULL CHECK (environment IN ('00', '01')),
  codigo_generacion TEXT NOT NULL UNIQUE,
  numero_control TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'PENDING',
    'SIGNED',
    'TRANSMITTED',
    'ACCEPTED',
    'REJECTED',
    'CONTINGENCY_PENDING',
    'INVALIDATED',
    'FAILED'
  )),
  plain_json TEXT NOT NULL,
  signed_jws TEXT,
  sello_recibido TEXT,
  mh_estado TEXT,
  mh_observaciones_json TEXT NOT NULL DEFAULT '[]',
  donor_email TEXT,
  donor_name TEXT,
  amount_cents INTEGER NOT NULL,
  issued_at TEXT NOT NULL,
  accepted_at TEXT,
  contingency_period_id TEXT REFERENCES contingency_periods(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE dte_events (
  id TEXT PRIMARY KEY,
  document_id TEXT REFERENCES dte_documents(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('INVALIDACION', 'CONTINGENCIA')),
  environment TEXT NOT NULL CHECK (environment IN ('00', '01')),
  codigo_generacion TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SIGNED', 'TRANSMITTED', 'ACCEPTED', 'REJECTED', 'FAILED')),
  plain_json TEXT NOT NULL,
  signed_jws TEXT,
  sello_recibido TEXT,
  mh_estado TEXT,
  mh_observaciones_json TEXT NOT NULL DEFAULT '[]',
  legal_deadline_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  accepted_at TEXT
);

CREATE TABLE contingency_periods (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL CHECK (environment IN ('00', '01')),
  status TEXT NOT NULL CHECK (status IN ('OPEN', 'EVENT_ACCEPTED', 'CLOSED', 'FAILED')),
  reason TEXT NOT NULL,
  tipo_contingencia INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  event_id TEXT REFERENCES dte_events(id),
  event_sello TEXT,
  transmit_deadline_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE contingency_batches (
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

CREATE TABLE contingency_batch_lines (
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

INSERT INTO contingency_periods (
  id,
  environment,
  status,
  reason,
  tipo_contingencia,
  started_at,
  ended_at,
  event_id,
  event_sello,
  transmit_deadline_at,
  created_at
)
SELECT
  id,
  environment,
  status,
  reason,
  tipo_contingencia,
  started_at,
  ended_at,
  NULL,
  event_sello,
  transmit_deadline_at,
  created_at
FROM contingency_periods_old;

INSERT INTO dte_documents (
  id,
  wompi_event_id,
  tipo_dte,
  environment,
  codigo_generacion,
  numero_control,
  status,
  plain_json,
  signed_jws,
  sello_recibido,
  mh_estado,
  mh_observaciones_json,
  donor_email,
  donor_name,
  amount_cents,
  issued_at,
  accepted_at,
  contingency_period_id,
  created_at,
  updated_at
)
SELECT
  id,
  wompi_event_id,
  tipo_dte,
  environment,
  codigo_generacion,
  numero_control,
  status,
  plain_json,
  signed_jws,
  sello_recibido,
  mh_estado,
  mh_observaciones_json,
  donor_email,
  donor_name,
  amount_cents,
  issued_at,
  accepted_at,
  contingency_period_id,
  created_at,
  updated_at
FROM dte_documents_old;

INSERT INTO dte_events (
  id,
  document_id,
  event_type,
  environment,
  codigo_generacion,
  status,
  plain_json,
  signed_jws,
  sello_recibido,
  mh_estado,
  mh_observaciones_json,
  legal_deadline_at,
  created_by,
  created_at,
  accepted_at
)
SELECT
  id,
  document_id,
  event_type,
  environment,
  codigo_generacion,
  status,
  plain_json,
  signed_jws,
  sello_recibido,
  mh_estado,
  mh_observaciones_json,
  legal_deadline_at,
  created_by,
  created_at,
  accepted_at
FROM dte_events_old;

UPDATE contingency_periods
SET event_id = (
  SELECT event_id
  FROM contingency_periods_old
  WHERE contingency_periods_old.id = contingency_periods.id
);

INSERT INTO contingency_batches (
  id,
  contingency_period_id,
  environment,
  id_envio,
  status,
  codigo_lote,
  request_json,
  response_json,
  last_error,
  line_count,
  accepted_count,
  rejected_count,
  pending_count,
  created_at,
  submitted_at,
  last_polled_at,
  updated_at
)
SELECT
  id,
  contingency_period_id,
  environment,
  id_envio,
  status,
  codigo_lote,
  request_json,
  response_json,
  last_error,
  line_count,
  accepted_count,
  rejected_count,
  pending_count,
  created_at,
  submitted_at,
  last_polled_at,
  updated_at
FROM contingency_batches_old;

INSERT INTO contingency_batch_lines (
  id,
  batch_id,
  contingency_period_id,
  document_id,
  line_no,
  status,
  codigo_generacion,
  tipo_dte,
  signed_jws,
  sello_recibido,
  mh_estado,
  mh_observaciones_json,
  last_error,
  created_at,
  updated_at
)
SELECT
  id,
  batch_id,
  contingency_period_id,
  document_id,
  line_no,
  status,
  codigo_generacion,
  tipo_dte,
  signed_jws,
  sello_recibido,
  mh_estado,
  mh_observaciones_json,
  last_error,
  created_at,
  updated_at
FROM contingency_batch_lines_old;

INSERT INTO email_deliveries (
  id,
  document_id,
  to_email,
  status,
  provider_response_json,
  email_type,
  document_status_at_send,
  template_version,
  pdf_renderer_version,
  pdf_sha256,
  dte_json_sha256,
  provider_delivery_id,
  sent_at,
  created_at
)
SELECT
  id,
  document_id,
  to_email,
  status,
  provider_response_json,
  email_type,
  document_status_at_send,
  template_version,
  pdf_renderer_version,
  pdf_sha256,
  dte_json_sha256,
  provider_delivery_id,
  sent_at,
  created_at
FROM email_deliveries_old;

DROP TABLE email_deliveries_old;
DROP TABLE contingency_batch_lines_old;
DROP TABLE contingency_batches_old;
UPDATE dte_documents_old SET contingency_period_id = NULL;
UPDATE contingency_periods_old SET event_id = NULL;
UPDATE dte_events_old SET document_id = NULL;
DROP TABLE contingency_periods_old;
DROP TABLE dte_events_old;
DROP TABLE dte_documents_old;

CREATE INDEX idx_dte_documents_status ON dte_documents(status);
CREATE INDEX idx_dte_documents_environment ON dte_documents(environment);
CREATE INDEX idx_dte_documents_wompi ON dte_documents(wompi_event_id);
CREATE INDEX idx_contingency_batches_period ON contingency_batches(contingency_period_id, status);
CREATE UNIQUE INDEX idx_contingency_batches_codigo_lote ON contingency_batches(codigo_lote) WHERE codigo_lote IS NOT NULL;
CREATE INDEX idx_contingency_batch_lines_batch ON contingency_batch_lines(batch_id, status);
CREATE INDEX idx_contingency_batch_lines_period ON contingency_batch_lines(contingency_period_id, status);
