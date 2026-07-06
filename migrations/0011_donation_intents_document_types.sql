-- Donor-checkout CAT-022 support (2026-07-05): the public /donar form now accepts
-- all five receptor document types — NIT (36), DUI (13), Otro (37), Pasaporte (03),
-- Carnet de Residente (02) — so the donor_document_type CHECK must widen beyond
-- ('13','37'). The foreign-donor path additionally stores the donor's CAT-020
-- country in a new nullable donor_pais column (set only when the direccion carries
-- the 00/00/00 "Otro (Para extranjeros)" geography; never 'SV').
--
-- SQLite cannot alter a CHECK constraint in place, so we rebuild the table (same
-- pattern as 0010, which is already applied on staging AND production — this must
-- be a NEW data-preserving migration). Every row is copied across with donor_pais
-- NULL (all pre-0011 intents are domestic). donation_intents has an outbound
-- reference only via document_id (nullable, no FK declared) and three indexes,
-- all recreated below.
PRAGMA defer_foreign_keys = ON;

ALTER TABLE donation_intents RENAME TO donation_intents_pre0011;

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
  donor_document TEXT NOT NULL,
  donor_email TEXT,
  donor_phone TEXT,
  direccion_departamento TEXT NOT NULL,
  direccion_municipio TEXT NOT NULL,
  direccion_distrito TEXT NOT NULL,
  direccion_complemento TEXT NOT NULL,
  donor_pais TEXT,
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
  donor_pais,
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
  NULL,
  wompi_id_enlace,
  wompi_url_enlace,
  wompi_url_enlace_largo,
  document_id,
  client_ip,
  created_at,
  updated_at,
  expires_at
FROM donation_intents_pre0011;

DROP TABLE donation_intents_pre0011;

-- Recreate the three indexes from 0009 verbatim.
CREATE INDEX IF NOT EXISTS idx_donation_intents_status_expires_at ON donation_intents(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_donation_intents_created_at ON donation_intents(created_at);
CREATE INDEX IF NOT EXISTS idx_donation_intents_document_id ON donation_intents(document_id);
