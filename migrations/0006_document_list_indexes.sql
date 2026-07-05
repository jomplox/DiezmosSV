CREATE INDEX IF NOT EXISTS idx_dte_documents_created_at_id ON dte_documents(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_dte_documents_status_created_at_id ON dte_documents(status, created_at DESC, id DESC);
