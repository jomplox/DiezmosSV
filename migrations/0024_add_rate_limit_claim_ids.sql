-- Add rate-limit provenance columns in an append-only migration.
--
-- These columns were accidentally added to 0019 after some D1 databases could
-- already have recorded that migration as applied. Rebuild the two affected
-- tables here instead of using bare ADD COLUMN so this migration is safe for
-- both stale databases that lack the columns and fresh/test databases whose
-- 0019 history may already include them.
PRAGMA defer_foreign_keys = ON;

ALTER TABLE donation_intents RENAME TO donation_intents_pre0024;

CREATE TABLE donation_intents (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING',
    'LINK_CREATED',
    'COMPLETED',
    'EXPIRED'
  )),
  amount_cents INTEGER NOT NULL,
  donor_name TEXT,
  donor_document_type TEXT NOT NULL CHECK (donor_document_type IN ('36', '13', '37', '03', '02')),
  donor_document TEXT,
  donor_email TEXT,
  donor_phone TEXT,
  direccion_departamento TEXT,
  direccion_municipio TEXT,
  direccion_distrito TEXT,
  direccion_complemento TEXT,
  donor_pais TEXT,
  gift_type TEXT CHECK (gift_type IN ('DIEZMO', 'OFRENDA')),
  wompi_id_enlace INTEGER,
  wompi_url_enlace TEXT,
  wompi_url_enlace_largo TEXT,
  document_id TEXT,
  client_ip TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  paid_at TEXT,
  datos_token_hash TEXT,
  rate_limit_claim_id TEXT
);

INSERT INTO donation_intents (
  id, status, amount_cents, donor_name, donor_document_type, donor_document,
  donor_email, donor_phone, direccion_departamento, direccion_municipio,
  direccion_distrito, direccion_complemento, donor_pais, gift_type,
  wompi_id_enlace, wompi_url_enlace, wompi_url_enlace_largo, document_id,
  client_ip, created_at, updated_at, expires_at, paid_at, datos_token_hash
)
SELECT
  id, status, amount_cents, donor_name, donor_document_type, donor_document,
  donor_email, donor_phone, direccion_departamento, direccion_municipio,
  direccion_distrito, direccion_complemento, donor_pais, gift_type,
  wompi_id_enlace, wompi_url_enlace, wompi_url_enlace_largo, document_id,
  client_ip, created_at, updated_at, expires_at, paid_at, datos_token_hash
FROM donation_intents_pre0024;

DROP TABLE donation_intents_pre0024;

CREATE INDEX IF NOT EXISTS idx_donation_intents_status_expires_at ON donation_intents(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_donation_intents_created_at ON donation_intents(created_at);
CREATE INDEX IF NOT EXISTS idx_donation_intents_document_id ON donation_intents(document_id);
CREATE INDEX IF NOT EXISTS idx_donation_intents_client_ip_created_at ON donation_intents(client_ip, created_at);

ALTER TABLE audit_logs RENAME TO audit_logs_pre0024;

CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM', 'USER')),
  actor_id TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor_ip TEXT,
  actor_context TEXT,
  rate_limit_claim_id TEXT
);

INSERT INTO audit_logs (
  id, actor_type, actor_id, action, entity_type, entity_id, summary,
  metadata_json, created_at, actor_ip, actor_context
)
SELECT
  id, actor_type, actor_id, action, entity_type, entity_id, summary,
  metadata_json, created_at, actor_ip, actor_context
FROM audit_logs_pre0024;

DROP TABLE audit_logs_pre0024;

CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_entity ON audit_logs(action, entity_id, created_at);
