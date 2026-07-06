-- Premint del enlace Wompi fuera de la ruta crítica del donante (2026-07-06): el
-- asistente público /donar acuña el enlace Wompi EN SEGUNDO PLANO al ENTRAR al Paso 2
-- (cuando ya se conocen monto + tipo), y adjunta los datos fiscales al enviar el
-- Paso 2 con una llamada rápida solo-D1. Para acuñar el enlace antes de tener los
-- datos del donante, la intención nace como BORRADOR: fila con monto (+ tipo opcional)
-- y enlace Wompi, pero SIN documento ni dirección todavía.
--
-- Esto exige que donor_document y las cuatro columnas de dirección
-- (direccion_departamento/municipio/distrito/complemento) pasen a ser NULLABLE: el
-- borrador las deja en NULL hasta que el donante completa el Paso 2. El marcador de
-- borrador es donor_document IS NULL (una cadena vacía NO es aceptable: el guard de
-- correlación distingue NULL/"" de un documento real). SQLite no permite quitar un
-- NOT NULL en su sitio, así que se reconstruye la tabla — mismo patrón de 0010/0011/
-- 0012, todas ya aplicadas en staging Y producción; esta es una NUEVA migración que
-- preserva los datos.
--
-- POR QUÉ reconstruir es seguro aquí: donation_intents NO es tabla PADRE de ningún
-- FK (ninguna tabla la referencia con REFERENCES donation_intents — verificado por
-- grep). Su única referencia saliente es document_id (nullable, sin FK declarado)
-- hacia dte_documents. El DROP de donation_intents no dispara SQLITE_CONSTRAINT_
-- FOREIGNKEY porque nada apunta a ella como padre. NUNCA se reconstruye dte_documents
-- ni ninguna tabla PADRE de FK (fallo documentado en 0014). Cada fila se copia
-- íntegra; todas las filas previas a 0015 ya tienen documento y dirección completos.
PRAGMA defer_foreign_keys = ON;

ALTER TABLE donation_intents RENAME TO donation_intents_pre0015;

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
  -- Documento y dirección ahora NULLABLE: el borrador los deja en NULL hasta el Paso 2.
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
  gift_type,
  wompi_id_enlace,
  wompi_url_enlace,
  wompi_url_enlace_largo,
  document_id,
  client_ip,
  created_at,
  updated_at,
  expires_at
FROM donation_intents_pre0015;

DROP TABLE donation_intents_pre0015;

-- Recreate the three indexes from 0009 verbatim.
CREATE INDEX IF NOT EXISTS idx_donation_intents_status_expires_at ON donation_intents(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_donation_intents_created_at ON donation_intents(created_at);
CREATE INDEX IF NOT EXISTS idx_donation_intents_document_id ON donation_intents(document_id);
