-- Add rate-limit provenance columns in an append-only migration.
--
-- Migration 0019 was recorded on deployed D1 databases before these ALTERs
-- were added to that historical file. Keep 0019 immutable and add the missing
-- columns here without rebuilding either table or rewriting existing rows.
ALTER TABLE donation_intents ADD COLUMN rate_limit_claim_id TEXT;
ALTER TABLE audit_logs ADD COLUMN rate_limit_claim_id TEXT;
