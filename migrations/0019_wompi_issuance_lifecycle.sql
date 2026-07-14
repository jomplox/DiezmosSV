ALTER TABLE wompi_events ADD COLUMN issuance_status TEXT
  CHECK (issuance_status IN ('PROCESSING', 'FAILED', 'DEAD_LETTERED', 'RETRY_QUEUED', 'DOCUMENT_CREATED', 'IGNORED'));
ALTER TABLE wompi_events ADD COLUMN control_prefix TEXT;
ALTER TABLE wompi_events ADD COLUMN control_sequence INTEGER;
ALTER TABLE wompi_events ADD COLUMN reserved_numero_control TEXT;
ALTER TABLE wompi_events ADD COLUMN reserved_codigo_generacion TEXT;
ALTER TABLE wompi_events ADD COLUMN issuance_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (issuance_attempt_count >= 0);
ALTER TABLE wompi_events ADD COLUMN issuance_attempt_id TEXT;
ALTER TABLE wompi_events ADD COLUMN issuance_error_code TEXT;
ALTER TABLE wompi_events ADD COLUMN issuance_error_message TEXT;
ALTER TABLE wompi_events ADD COLUMN issuance_last_attempt_at TEXT;
ALTER TABLE wompi_events ADD COLUMN issuance_failed_at TEXT;
ALTER TABLE wompi_events ADD COLUMN issuance_dead_lettered_at TEXT;

-- Legacy sequence prefixes were not normalized at every allocator. Canonicalize
-- case before the reservation trigger can create a parallel uppercase counter.
-- When both spellings exist, the highest next_value is the only safe forward
-- position; moving a legal counter backward is never allowed.
INSERT OR IGNORE INTO document_sequences (environment, control_prefix, next_value)
SELECT environment, UPPER(control_prefix), next_value
FROM document_sequences
WHERE control_prefix <> UPPER(control_prefix);

UPDATE document_sequences
SET next_value = (
  SELECT MAX(source.next_value)
  FROM document_sequences AS source
  WHERE source.environment = document_sequences.environment
    AND UPPER(source.control_prefix) = UPPER(document_sequences.control_prefix)
)
WHERE control_prefix = UPPER(control_prefix);

DELETE FROM document_sequences
WHERE control_prefix <> UPPER(control_prefix);

CREATE UNIQUE INDEX idx_wompi_reserved_control
  ON wompi_events(environment, control_prefix, control_sequence)
  WHERE control_sequence IS NOT NULL;
CREATE UNIQUE INDEX idx_wompi_reserved_generation
  ON wompi_events(reserved_codigo_generacion)
  WHERE reserved_codigo_generacion IS NOT NULL;
CREATE UNIQUE INDEX idx_dte_documents_wompi_unique
  ON dte_documents(wompi_event_id)
  WHERE wompi_event_id IS NOT NULL;

CREATE TRIGGER reserve_wompi_document_identifiers
AFTER UPDATE OF control_prefix, reserved_codigo_generacion ON wompi_events
FOR EACH ROW
WHEN OLD.control_prefix IS NULL
  AND OLD.control_sequence IS NULL
  AND OLD.reserved_numero_control IS NULL
  AND OLD.reserved_codigo_generacion IS NULL
  AND NEW.control_prefix IS NOT NULL
  AND NEW.reserved_codigo_generacion IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO document_sequences (environment, control_prefix, next_value)
  VALUES (NEW.environment, NEW.control_prefix, 1);

  UPDATE wompi_events
  SET control_sequence = (
        SELECT next_value
        FROM document_sequences
        WHERE environment = NEW.environment
          AND control_prefix = NEW.control_prefix
      ),
      reserved_numero_control = 'DTE-15-' || NEW.control_prefix || '-' || printf(
        '%015d',
        (
          SELECT next_value
          FROM document_sequences
          WHERE environment = NEW.environment
            AND control_prefix = NEW.control_prefix
        )
      )
  WHERE id = NEW.id
    AND control_sequence IS NULL
    AND reserved_numero_control IS NULL;

  UPDATE document_sequences
  SET next_value = next_value + 1
  WHERE environment = NEW.environment
    AND control_prefix = NEW.control_prefix
    AND next_value = (
      SELECT control_sequence
      FROM wompi_events
      WHERE id = NEW.id
    );
END;
