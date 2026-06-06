PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS wompi_events (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL UNIQUE,
  environment TEXT NOT NULL CHECK (environment IN ('00', '01')),
  result TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  donor_email TEXT,
  donor_name TEXT,
  raw_body TEXT NOT NULL,
  headers_json TEXT NOT NULL DEFAULT '{}',
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processed_at TEXT,
  created_document_id TEXT
);

CREATE TABLE IF NOT EXISTS dte_documents (
  id TEXT PRIMARY KEY,
  wompi_event_id TEXT NOT NULL REFERENCES wompi_events(id),
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

CREATE INDEX IF NOT EXISTS idx_dte_documents_status ON dte_documents(status);
CREATE INDEX IF NOT EXISTS idx_dte_documents_environment ON dte_documents(environment);
CREATE INDEX IF NOT EXISTS idx_dte_documents_wompi ON dte_documents(wompi_event_id);

CREATE TABLE IF NOT EXISTS dte_events (
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

CREATE TABLE IF NOT EXISTS contingency_periods (
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

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM', 'USER')),
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id, created_at);

CREATE TABLE IF NOT EXISTS mh_tokens (
  environment TEXT PRIMARY KEY CHECK (environment IN ('00', '01')),
  token TEXT NOT NULL,
  token_type TEXT NOT NULL DEFAULT 'Bearer',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS document_sequences (
  environment TEXT NOT NULL CHECK (environment IN ('00', '01')),
  control_prefix TEXT NOT NULL,
  next_value INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (environment, control_prefix)
);

CREATE TABLE IF NOT EXISTS email_deliveries (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES dte_documents(id),
  to_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  provider_response_json TEXT NOT NULL DEFAULT '{}',
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('VIEWER', 'OPERATOR', 'ADMIN', 'OWNER')),
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  disabled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  revoked_at TEXT
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
