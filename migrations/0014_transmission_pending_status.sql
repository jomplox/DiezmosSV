-- Transmisión diferida por reintento ("En trámite").
--
-- Normativa: el Anexo de validaciones del evento de contingencia (campo 35) solo
-- admite los tipos de DTE 01, 03, 04, 05, 06, 07, 11, 14 y 18 — el CDE (tipo 15)
-- está EXCLUIDO, por lo que un CDE nunca se emite en contingencia. Cuando el
-- Ministerio de Hacienda no está disponible, el CDE se firma con forma NORMAL y
-- queda diferido; el cron de 15 minutos reintenta la transmisión.
--
-- POR QUÉ una columna marcador y NO un nuevo valor en el CHECK de status:
-- dte_documents es tabla PADRE de cuatro FKs (dte_events, email_deliveries,
-- donation_intents, contingency_batch_lines) y SQLite solo permite modificar un
-- CHECK reconstruyendo la tabla. El API remoto de D1 no mantiene
-- PRAGMA defer_foreign_keys a lo largo del script como sqlite3 local, así que el
-- DROP de un padre referenciado aborta con SQLITE_CONSTRAINT_FOREIGNKEY (esta
-- migración falló y se revirtió atómicamente en staging con esa forma).
-- Reconstruir tablas padre de FK es efectivamente inviable en D1.
--
-- El estado diferido se representa entonces como:
--   status = 'SIGNED' AND transmission_deferred_at IS NOT NULL
-- El marcador se conserva tras la resolución como evidencia histórica ("estuvo
-- diferido desde"); es el status al salir de SIGNED (ACCEPTED/REJECTED) lo que
-- saca al documento del barrido de reintento.
ALTER TABLE dte_documents ADD COLUMN transmission_deferred_at TEXT;

-- Los periodos de contingencia que quedaron abiertos ya no tienen maquinaria que
-- los cierre (la emisión en contingencia se eliminó); se cierran como históricos.
UPDATE contingency_periods
SET status = 'CLOSED', ended_at = COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
WHERE status IN ('OPEN', 'EVENT_ACCEPTED');
