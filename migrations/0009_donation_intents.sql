-- Donor-checkout Task 1: a validated donation intent is persisted before the
-- worker mints a single-use Wompi payment link, and the later payment webhook is
-- correlated back to it. The id doubles as identificadorEnlaceComercio on the link.
CREATE TABLE IF NOT EXISTS donation_intents (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING',
    'LINK_CREATED',
    'COMPLETED',
    'EXPIRED'
  )),
  amount_cents INTEGER NOT NULL,
  donor_name TEXT NOT NULL,
  donor_document_type TEXT NOT NULL CHECK (donor_document_type IN ('13', '37')),
  donor_document TEXT NOT NULL,
  donor_email TEXT NOT NULL,
  donor_phone TEXT,
  direccion_departamento TEXT NOT NULL,
  direccion_municipio TEXT NOT NULL,
  direccion_distrito TEXT NOT NULL,
  direccion_complemento TEXT NOT NULL,
  wompi_id_enlace INTEGER,
  wompi_url_enlace TEXT,
  wompi_url_enlace_largo TEXT,
  -- Set on MH acceptance to the CDE that closed this intent, so the admin panel
  -- (Task 5) can surface the emitted numero de control for a COMPLETED intent.
  document_id TEXT,
  client_ip TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL
);

-- Sweep of PENDING intents past their expiry filters on (status, expires_at).
CREATE INDEX IF NOT EXISTS idx_donation_intents_status_expires_at ON donation_intents(status, expires_at);
-- Per-IP throttle counts recent intents by created_at.
CREATE INDEX IF NOT EXISTS idx_donation_intents_created_at ON donation_intents(created_at);
-- The admin document detail (Task 5) looks up the COMPLETED intent that produced a
-- given CDE by document_id to surface the "donor data verified" badge.
CREATE INDEX IF NOT EXISTS idx_donation_intents_document_id ON donation_intents(document_id);
