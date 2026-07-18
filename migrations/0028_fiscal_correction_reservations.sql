ALTER TABLE fiscal_corrections ADD COLUMN reserved_control_prefix TEXT;
ALTER TABLE fiscal_corrections ADD COLUMN reserved_control_sequence INTEGER;
ALTER TABLE fiscal_corrections ADD COLUMN reserved_codigo_generacion TEXT;
ALTER TABLE fiscal_corrections ADD COLUMN reserved_numero_control TEXT;

CREATE UNIQUE INDEX uq_fiscal_corrections_reserved_codigo
  ON fiscal_corrections(reserved_codigo_generacion)
  WHERE reserved_codigo_generacion IS NOT NULL;

CREATE UNIQUE INDEX uq_fiscal_corrections_reserved_numero
  ON fiscal_corrections(reserved_numero_control)
  WHERE reserved_numero_control IS NOT NULL;

CREATE TRIGGER trg_fiscal_correction_reservation_complete
BEFORE UPDATE OF reserved_control_sequence ON fiscal_corrections
WHEN (
  NEW.reserved_control_sequence IS NOT NULL
  AND (
    NEW.reserved_control_prefix IS NULL
    OR NEW.reserved_codigo_generacion IS NULL
    OR NEW.reserved_numero_control IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'incomplete fiscal correction identifier reservation');
END;

-- The token-qualified correction UPDATE owns the legal sequence increment.
-- SQLite executes this trigger in the same statement transaction, so recovery
-- can reuse one persisted reservation without allocating another sequence.
CREATE TRIGGER trg_fiscal_correction_reserve_sequence
AFTER UPDATE OF reserved_control_sequence ON fiscal_corrections
WHEN (
  OLD.reserved_control_sequence IS NULL
  AND NEW.reserved_control_sequence IS NOT NULL
)
BEGIN
  UPDATE document_sequences
     SET next_value = next_value + 1
   WHERE environment = NEW.environment
     AND control_prefix = NEW.reserved_control_prefix
     AND next_value = NEW.reserved_control_sequence;

  SELECT RAISE(ABORT, 'fiscal correction sequence reservation failed')
   WHERE changes() <> 1;
END;
