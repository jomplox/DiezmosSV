CREATE VIRTUAL TABLE IF NOT EXISTS dte_document_search USING fts5(
  document_id UNINDEXED,
  codigo_generacion,
  codigo_generacion_compact,
  numero_control,
  numero_control_compact,
  numero_control_serial,
  donor_email,
  donor_name,
  tokenize = 'unicode61 remove_diacritics 2'
);

DELETE FROM dte_document_search;

INSERT INTO dte_document_search (
  document_id,
  codigo_generacion,
  codigo_generacion_compact,
  numero_control,
  numero_control_compact,
  numero_control_serial,
  donor_email,
  donor_name
)
SELECT
  id,
  codigo_generacion,
  lower(replace(codigo_generacion, '-', '')),
  numero_control,
  lower(replace(numero_control, '-', '')),
  COALESCE(NULLIF(ltrim(substr(numero_control, -15), '0'), ''), substr(numero_control, -15)),
  donor_email,
  donor_name
FROM dte_documents;
