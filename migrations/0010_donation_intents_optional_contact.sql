-- Donor-checkout amendment (2026-07-05): Wompi's hosted sheet already requires
-- (and now asks ONLY for) the donor's name + email, so the /donar form stops
-- collecting them. The intent therefore carries identity + address only, and the
-- correlated CDE takes nombre/correo from the webhook. donor_name and donor_email
-- must become nullable.
--
-- SQLite cannot drop a NOT NULL constraint in place, so we rebuild the table into
-- its canonical 0009 shape with donor_name/donor_email nullable and copy every row
-- across (only test rows exist anywhere, but this is written as a correct
-- data-preserving rebuild). donation_intents has an outbound reference only via
-- document_id (nullable, no FK declared) and three indexes, all recreated below.
PRAGMA defer_foreign_keys = ON;

ALTER TABLE donation_intents RENAME TO donation_intents_pre0010;

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
  donor_document_type TEXT NOT NULL CHECK (donor_document_type IN ('13', '37')),
  donor_document TEXT NOT NULL,
  donor_email TEXT,
  donor_phone TEXT,
  direccion_departamento TEXT NOT NULL,
  direccion_municipio TEXT NOT NULL,
  direccion_distrito TEXT NOT NULL,
  direccion_complemento TEXT NOT NULL,
  wompi_id_enlace INTEGER,
  wompi_url_enlace TEXT,
  wompi_url_enlace_largo TEXT,
  document_id TEXT,
  client_ip TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

INSERT INTO donation_intents (
  id,
  status,
  amount_cents,
  donor_name,
  donor_document_type,
  donor_document,
  donor_email,
  donor_phone,
  direccion_departamento,
  direccion_municipio,
  direccion_distrito,
  direccion_complemento,
  wompi_id_enlace,
  wompi_url_enlace,
  wompi_url_enlace_largo,
  document_id,
  client_ip,
  created_at,
  updated_at,
  expires_at
)
SELECT
  id,
  status,
  amount_cents,
  donor_name,
  donor_document_type,
  donor_document,
  donor_email,
  donor_phone,
  direccion_departamento,
  direccion_municipio,
  direccion_distrito,
  direccion_complemento,
  wompi_id_enlace,
  wompi_url_enlace,
  wompi_url_enlace_largo,
  document_id,
  client_ip,
  created_at,
  updated_at,
  expires_at
FROM donation_intents_pre0010;

DROP TABLE donation_intents_pre0010;

-- Recreate the three indexes from 0009 verbatim.
CREATE INDEX IF NOT EXISTS idx_donation_intents_status_expires_at ON donation_intents(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_donation_intents_created_at ON donation_intents(created_at);
CREATE INDEX IF NOT EXISTS idx_donation_intents_document_id ON donation_intents(document_id);
