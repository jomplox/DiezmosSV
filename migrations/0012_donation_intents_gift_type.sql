-- Diezmo vs Ofrenda selector (2026-07-06): the public /donar SV (Wompi/CDE) form
-- gains a REQUIRED "Tipo" field so the donor states whether the gift is a diezmo
-- or an ofrenda. It rides on the intent as a new nullable donor-facing enum
-- gift_type ('DIEZMO' | 'OFRENDA'); it is informational only — the legal CDE
-- descripcion stays "DONACIÓN". ABSENT stays allowed: legacy rows and the US
-- (Givebutter/FMCE) path never carry it, so the column is nullable with no default.
--
-- SQLite cannot add a CHECK constraint to an existing column in place, so we
-- rebuild the table (same pattern as 0010/0011, both already applied on staging AND
-- production — this must be a NEW data-preserving migration). Every row is copied
-- across with gift_type NULL (all pre-0012 intents predate the selector).
-- donation_intents has an outbound reference only via document_id (nullable, no FK
-- declared) and three indexes, all recreated below.
PRAGMA defer_foreign_keys = ON;

ALTER TABLE donation_intents RENAME TO donation_intents_pre0012;

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
  gift_type TEXT CHECK (gift_type IN ('DIEZMO', 'OFRENDA')),
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
  gift_type,
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
  donor_pais,
  NULL,
  wompi_id_enlace,
  wompi_url_enlace,
  wompi_url_enlace_largo,
  document_id,
  client_ip,
  created_at,
  updated_at,
  expires_at
FROM donation_intents_pre0012;

DROP TABLE donation_intents_pre0012;

-- Recreate the three indexes from 0009 verbatim.
CREATE INDEX IF NOT EXISTS idx_donation_intents_status_expires_at ON donation_intents(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_donation_intents_created_at ON donation_intents(created_at);
CREATE INDEX IF NOT EXISTS idx_donation_intents_document_id ON donation_intents(document_id);
