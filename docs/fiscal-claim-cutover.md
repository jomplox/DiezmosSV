# Fiscal claim migration cutover

> **Staging record — cutover completed.** Staging already includes migrations
> `0020`/`0021` and the claim-aware Worker. Routine `cf:migrate:staging` and
> `cf:deploy:staging` runs do not require a quiesce acknowledgment.
>
> Use `cf:cutover:staging` only when rebuilding or upgrading a staging environment
> that still must cross `0020` and `0021`.

Migrations `0020_fiscal_operation_claims.sql` and `0021_security_lifecycle_guards.sql`, together with their claim/finalization-aware Worker, must be introduced in one quiesced maintenance window. An old Worker isolate does not understand the new ownership state and can otherwise submit a second fiscal operation or bypass lifecycle-generation guards.

The acknowledgment command does not prove quiescence. Before running `cf:cutover:staging`, the deployment operator must complete these steps in order:

1. Put the Worker behind a maintenance control that blocks all mutating traffic, not only fiscal routes. At minimum it must block login/session creation, `/api/auth/password-reset/request`, `/api/auth/password-reset/confirm`, every `/api/users/` mutation, operator issuance/retry/invalidation, and public donation or webhook writes. Leave only a dedicated health probe or explicitly read-only maintenance response reachable. Pause the issuance queue consumer and every scheduled mutation/finalization sweep.
2. Wait for every HTTP request, queue batch, and scheduled invocation running the old Worker revision to finish. Confirm there are no in-flight account, recovery, donation, or fiscal mutations before continuing.
3. Take the normal D1 backup and keep the maintenance controls active.
4. Before applying `0020`, run `SELECT wompi_event_id, COUNT(*) AS document_count FROM dte_documents WHERE wompi_event_id IS NOT NULL GROUP BY wompi_event_id HAVING COUNT(*) > 1;`. The result must be empty; otherwise stop and reconcile those historical duplicates before creating the unique source-event index.
5. In the same shell, acknowledge the drained state with `export FISCAL_CUTOVER_QUIESCED=1`, then run `npm run cf:cutover:staging`.
6. Verify the deployed revision is claim-aware and that all of these columns exist: `dte_documents.fiscal_operation_claim_id`, `fiscal_operation_claimed_at`, `fiscal_operation_kind`, `fiscal_operation_event_id`, `post_accept_finalized_at`, `post_accept_finalization_claim_id`, `post_accept_finalization_claimed_at`, `post_accept_email_dispatch_started_at`; `wompi_events.issuance_claim_id`, `issuance_claimed_at`; and `users.auth_generation`. Verify indexes `idx_wompi_events_issuance_claims` and `idx_dte_documents_unique_wompi_event` also exist. Do not clear a non-null claim: it records an outcome that may already exist at MH and requires reconciliation. Migration `0021` marks every acceptance that predates the cutover as already finalized, so the new scheduler cannot bulk-resend historical receipts (including pre-0004 deliveries whose `email_type` is null). Only acceptances created by the new Worker may be pending finalization.
7. Count historical accepted rows with `post_accept_finalized_at IS NULL`; the result must be zero before the new Worker is enabled. If a known historical row truly missed its receipt, recover that exact document later through a reviewed operator action—never by clearing the migration backfill or bulk-queueing old acceptances.
8. Re-enable HTTP mutation routes, scheduled work, and queue delivery only after those checks pass. Then `unset FISCAL_CUTOVER_QUIESCED`.

If the drain cannot be proven, stop the cutover. Do not apply migrations `0020`/`0021` or deploy the new release alongside an old fiscal/account writer.
