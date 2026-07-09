-- One-time authorization capability for the public /datos completion call.
-- Only the SHA-256 hash is persisted; the raw capability is returned once to the
-- donor wizard and held in memory until fiscal data is attached. Existing and
-- full-create intents receive NULL and therefore cannot use the draft-only path.
ALTER TABLE donation_intents ADD COLUMN datos_token_hash TEXT;
