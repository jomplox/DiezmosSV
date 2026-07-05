CREATE INDEX IF NOT EXISTS idx_audit_logs_action_entity ON audit_logs(action, entity_id, created_at);
