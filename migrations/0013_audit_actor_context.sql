-- Enrich the audit trail with actor request context.
--
-- audit_logs is the largest live table, so we deliberately AVOID a table rebuild:
-- SQLite supports ALTER TABLE ... ADD COLUMN for nullable columns as an O(1)
-- metadata-only change. Pre-existing rows keep NULL for both columns (they were
-- written before this context was captured).
--
-- actor_ip      : real client IP taken from the cf-connecting-ip header.
-- actor_context : JSON blob of request.cf / user-agent fields (country, city,
--                 region, timezone, asn, asOrganization, colo, httpProtocol,
--                 tlsVersion, userAgent). Undefined fields are dropped before
--                 serialization, so the blob only carries what Cloudflare exposed.
ALTER TABLE audit_logs ADD COLUMN actor_ip TEXT;
ALTER TABLE audit_logs ADD COLUMN actor_context TEXT;
