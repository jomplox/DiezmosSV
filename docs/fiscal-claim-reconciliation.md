# Fiscal outcome reconciliation

A non-null `dte_documents.fiscal_operation_claim_id` means an MH-facing call may have reached the external service, but its terminal result is not known locally. The claim has no automatic expiry. Queue redelivery, scheduled retry, manual retry, receipt resend, invalidation, and status-dependent exports fail closed while the relevant claim is present.

The application shows **Resultado fiscal pendiente de conciliación**, the operation kind, and the claim timestamp. Reconciliation is restricted to a deployment operator because an incorrect release can authorize a duplicate legal submission.

## Evidence first

1. Record the document id, `codigo_generacion`, `numero_control`, status, `fiscal_operation_claim_id`, `fiscal_operation_claimed_at`, `fiscal_operation_kind`, and `fiscal_operation_event_id`. Do not copy donor data into the incident.
2. For `INVALIDATION`, verify that `fiscal_operation_event_id` names exactly one `SIGNED` `dte_events` row whose `document_id` is the document and whose `event_type` is `INVALIDACION`.
3. Check that exact operation through an authoritative MH channel. A timeout, connection reset, HTTP 408/429/5xx, empty or malformed 2xx body, missing local audit, or elapsed time is not proof that MH did not process it.
4. Preserve the MH case/reference and a second-person approval. Take a D1 backup and keep issuance/invalidation quiesced during the incident change.

## Outcome 1: still unknown

Leave the document, event, and all four claim columns unchanged. Do not retry, resend a receipt, export the document as definitively accepted, or create a replacement operation. Escalate with MH and retain the evidence.

## Supported atomic execution

Do not put `BEGIN`, `BEGIN IMMEDIATE`, or `COMMIT` in a Wrangler D1 file: D1 executes a `--file` batch transactionally and rejects embedded transaction statements. Prefer a reviewed one-use maintenance Worker that passes bound statements to `env.DB.batch([...])` and checks every returned `meta.changes` value.

If the reviewed incident uses Wrangler instead, place only the approved statements (no transaction wrappers) in an out-of-tree `0600` file and run the exact environment command:

```bash
rtk npx wrangler d1 execute diezmossv-staging-resource-example --env staging --remote --file "$RECONCILIATION_SQL"
rtk npx wrangler d1 execute diezmossv-production-resource-example --env production --remote --file "$RECONCILIATION_SQL"
```

Run only one of those commands. The operator must verify the target database first, inspect the per-statement results, and require the change counts specified below. Never paste a generic claim-clear statement into the console.

## Outcome 2: MH confirms NOT_RECEIVED

MH must explicitly confirm that the exact operation was not received. Use a unique reconciliation id, audit id, and timestamp. The expected document status is the status captured during evidence collection; do not use a wildcard.

### Transmission NOT_RECEIVED

The atomic batch must contain exactly these effects:

1. Update one document using all of these predicates: exact document id, exact claim id, exact expected status, `fiscal_operation_kind = 'TRANSMISSION'`, and `fiscal_operation_event_id IS NULL`.
2. Clear `fiscal_operation_claim_id`, `fiscal_operation_claimed_at`, `fiscal_operation_kind`, and `fiscal_operation_event_id`; stamp the unique reconciliation timestamp in `updated_at`. Do not change the document status or fiscal identity.
3. Insert one `FISCAL_CLAIM_RELEASED_AFTER_RECONCILIATION` audit row only when that same document has the reconciliation timestamp, all claim fields are null, and the expected status is unchanged. Metadata must contain `outcome: NOT_RECEIVED`, the non-secret MH reference, operation kind, prior claim id, and reconciliation id.

The document update and audit insert must each report `changes = 1`. Otherwise stop and do not retry.

### Invalidation NOT_RECEIVED

The atomic batch must bind the exact `fiscal_operation_event_id` and perform these ordered, mutually dependent effects:

1. Update exactly one event from `SIGNED` to `FAILED` with `mh_estado = 'NOT_RECEIVED'`, the non-secret MH reference/reconciliation id in `mh_observaciones_json`, and predicates for exact event id, document id, and `event_type = 'INVALIDACION'`. The event update must also require an existing document with the exact claim id, expected status, `fiscal_operation_kind = 'INVALIDATION'`, and matching `fiscal_operation_event_id`.
2. Update exactly that document using the same claim/status/kind/event predicates and an `EXISTS` check for the event's unique NOT_RECEIVED reconciliation marker. Clear all four claim columns and stamp the reconciliation timestamp; keep the document `ACCEPTED`.
3. Insert one `FISCAL_CLAIM_RELEASED_AFTER_RECONCILIATION` audit row only when both the event marker and reconciled document state match.

The event update, document update, and audit insert must each report `changes = 1`. A different event, a latest-event lookup, or an event left `SIGNED` is not acceptable. Once verified, the ordinary operator route may create one new claimed invalidation.

## Outcome 3: MH confirms a definitive result

Never clear a definitive result merely to retry. Implement a reviewed incident batch that persists the terminal result under the exact current owner and verifies one changed row per required statement.

### Definitive transmission result

- Require exact document id, claim id, expected `SIGNED` status, `fiscal_operation_kind = 'TRANSMISSION'`, and `fiscal_operation_event_id IS NULL`.
- For acceptance, persist `status = 'ACCEPTED'`, `sello_recibido`, MH state/observations, and `accepted_at`; clear all four claim columns; set `post_accept_finalized_at = NULL`; and insert `DTE_ACCEPTED` audit evidence in the same batch.
- For explicit rejection, persist `status = 'REJECTED'`, the MH state/observations, and null acceptance/seal fields; clear all four claim columns; and insert `DTE_REJECTED` audit evidence in the same batch.
- After an accepted batch, the scheduled post-accept finalizer must first win `post_accept_finalization_claim_id`, complete the correlated donation intent and definitive `dteReceipt`, then owner-qualify `post_accept_finalized_at`. Immediately before the external email call it sets `post_accept_email_dispatch_started_at`. A stale lease with a null dispatch marker may be recovered automatically; a non-null marker without `SENT` or `FAILED` delivery evidence is outcome-ambiguous and remains locked for operator reconciliation. HTTP-provider sends carry the stable key `dte-email:<document id>:dteReceipt`; the finalization claim protects providers without idempotency support. Verify the intent/document link, one sent-or-explicitly-failed/skipped delivery record, the terminal audit, and cleared finalization-claim and dispatch-marker columns before closing the incident. If the intent cannot be correlated exactly, leave finalization pending and stop.

### Definitive invalidation result

- Require exact document id, claim id, expected `ACCEPTED` status, `fiscal_operation_kind = 'INVALIDATION'`, and exact `fiscal_operation_event_id`.
- Require that exact event to belong to the document, have `event_type = 'INVALIDACION'`, and still be `SIGNED`.
- For acceptance, atomically set that event to `ACCEPTED` with its MH evidence, set the document to `INVALIDATED`, clear all four claim columns, and insert `DTE_INVALIDATED` audit evidence.
- For explicit rejection, atomically set that event to `REJECTED` with its MH evidence, keep the document `ACCEPTED`, clear all four claim columns, and insert `DTE_INVALIDATION_REJECTED` audit evidence.
- After accepted invalidation, send the invalidation notice exactly once through a reviewed incident action and record its delivery/audit evidence. A rejected invalidation sends no invalidation notice.

For every definitive path, verify the exact document/event terminal state, claim fields, audit, intent (when applicable), and email evidence before restoring normal operations. Never use a latest-event query, partial direct edit, or bulk claim clear.
