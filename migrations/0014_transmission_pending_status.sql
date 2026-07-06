-- Transmisión diferida por reintento ("En trámite").
--
-- Normativa: el Anexo de validaciones del evento de contingencia (campo 35) solo
-- admite los tipos de DTE 01, 03, 04, 05, 06, 07, 11, 14 y 18 — el CDE (tipo 15)
-- está EXCLUIDO, por lo que un CDE nunca se emite en contingencia. Cuando el
-- Ministerio de Hacienda no está disponible, el CDE se firma con forma NORMAL y
-- queda TRANSMISSION_PENDING; el cron de 15 minutos reintenta la transmisión.
--
-- SQLite no permite modificar un CHECK, así que se reconstruye dte_documents con
-- el nuevo estado permitido. Orden create-new → copy → drop-old → rename: al no
-- renombrar la tabla original, las cláusulas FOREIGN KEY de las tablas hijas
-- (dte_events, contingency_batch_lines, email_deliveries, donation_intents)
-- siguen apuntando a "dte_documents" y resuelven a la tabla nueva al terminar.

PRAGMA defer_foreign_keys = ON;

CREATE TABLE dte_documents_new (
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
    'TRANSMISSION_PENDING',
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

INSERT INTO dte_documents_new (
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
FROM dte_documents;

DROP TABLE dte_documents;
ALTER TABLE dte_documents_new RENAME TO dte_documents;

-- Índices de 0005 y 0006, eliminados junto con la tabla anterior.
CREATE INDEX idx_dte_documents_status ON dte_documents(status);
CREATE INDEX idx_dte_documents_environment ON dte_documents(environment);
CREATE INDEX idx_dte_documents_wompi ON dte_documents(wompi_event_id);
CREATE INDEX idx_dte_documents_created_at_id ON dte_documents(created_at DESC, id DESC);
CREATE INDEX idx_dte_documents_status_created_at_id ON dte_documents(status, created_at DESC, id DESC);

-- Los periodos de contingencia que quedaron abiertos ya no tienen maquinaria que
-- los cierre (la emisión en contingencia se eliminó); se cierran como históricos.
UPDATE contingency_periods
SET status = 'CLOSED', ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE status IN ('OPEN', 'EVENT_ACCEPTED');
