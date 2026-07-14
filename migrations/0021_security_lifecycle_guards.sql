-- Keep accepted-document follow-up recoverable. The timestamp remains NULL until
-- donation-intent completion, definitive receipt handling, and required audits have
-- all run; the scheduled worker retries NULL rows without retransmitting to MH.
ALTER TABLE dte_documents ADD COLUMN post_accept_finalized_at TEXT;
ALTER TABLE dte_documents ADD COLUMN post_accept_finalization_claim_id TEXT;
ALTER TABLE dte_documents ADD COLUMN post_accept_finalization_claimed_at TEXT;
ALTER TABLE dte_documents ADD COLUMN post_accept_email_dispatch_started_at TEXT;

-- The new finalizer is only for acceptances created by claim-aware workers. Historical
-- accepted rows already ran the legacy follow-up path; queueing all of them would resend
-- old receipts whose pre-0004 evidence deliberately has no email_type discriminator.
UPDATE dte_documents
   SET post_accept_finalized_at = COALESCE(accepted_at, updated_at, created_at)
 WHERE status = 'ACCEPTED';

CREATE INDEX idx_dte_documents_post_accept_pending
  ON dte_documents(created_at, id)
  WHERE status = 'ACCEPTED' AND post_accept_finalized_at IS NULL;

CREATE INDEX idx_dte_documents_post_accept_claims
  ON dte_documents(post_accept_finalization_claimed_at, id)
  WHERE post_accept_finalization_claim_id IS NOT NULL;

-- Monotonic account lifecycle generation. Email changes and disable/enable
-- transitions increment it in the same D1 batch that revokes sessions/reset tokens.
-- A login or stale admin patch that observed an older generation cannot commit.
ALTER TABLE users ADD COLUMN auth_generation INTEGER NOT NULL DEFAULT 0;
