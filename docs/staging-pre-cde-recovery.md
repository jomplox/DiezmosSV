# Staging pre-CDE recovery check

This runbook prepares the recovery of staging event
`wompi_226a47e9-39e3-4418-b1f2-2b46e29849e8`. It does not authorize or perform a
deployment, a remote query, or a database mutation. The commands below are read-only
`SELECT` checks for a separately authorized recovery window.

The recorded incident invariant is:

- test environment `00` and control prefix `M001P004`;
- no `dte_documents` row, signature, or MH response for the event;
- no reservation for sequences 31 through 34;
- the four failed deliveries advanced only the local counter through 31, 32, 33, and
  34, so the recorded pre-recovery `next_value` is 35.

## Pause before recovery

Apply migration `0019_wompi_issuance_lifecycle.sql` and deploy this feature only under
their own approvals; neither action authorizes the historical repair below. Immediately
before running a separately authorized recovery mutation, pause all new staging Wompi
issuance and queue processing. Confirm the pause is effective; a new staging issuance
could legitimately claim sequence 35 and invalidate this plan.

Do not begin recovery unless the feature deployment and migration are complete and the
historical D1 mutation has separate approval. Never run this recovery against production.

## Read-only preflight

These five commands target only the configured `diezmossv-staging-resource-example` D1 database. They
were prepared locally and were not executed while implementing the feature.

### 1. Exact failed Wompi event

```bash
npx wrangler d1 execute diezmossv-staging-resource-example --env staging --remote --command "SELECT id, transaction_id, environment, result, received_at, processed_at, created_document_id, issuance_status, control_prefix, control_sequence, reserved_numero_control, reserved_codigo_generacion, issuance_attempt_count, issuance_error_code, issuance_error_message, issuance_last_attempt_at, issuance_failed_at, issuance_dead_lettered_at FROM wompi_events WHERE id = 'wompi_226a47e9-39e3-4418-b1f2-2b46e29849e8';"
```

Expected before recovery: exactly one `ExitosaAprobada` row in environment `00`, with
`created_document_id`, `control_prefix`, `control_sequence`,
`reserved_numero_control`, and `reserved_codigo_generacion` all null. An older incident
row may also have null lifecycle/error columns after the migration adds them.

### 1b. Recorded dead-letter timestamp

```bash
npx wrangler d1 execute diezmossv-staging-resource-example --env staging --remote --command "SELECT action, summary, created_at FROM audit_logs WHERE entity_type = 'wompi_event' AND entity_id = 'wompi_226a47e9-39e3-4418-b1f2-2b46e29849e8' AND action = 'ISSUANCE_DEAD_LETTERED' ORDER BY created_at, id;"
```

Expected before recovery: exactly one row. Its `created_at` is the recorded terminal
incident timestamp the repair must use; do not infer a timestamp from the alert email's
displayed local time.

### 2. CDE, signature, and MH-response evidence

```bash
npx wrangler d1 execute diezmossv-staging-resource-example --env staging --remote --command "SELECT id, wompi_event_id, environment, numero_control, codigo_generacion, status, CASE WHEN signed_jws IS NOT NULL AND length(trim(signed_jws)) > 0 THEN 1 ELSE 0 END AS has_signature, CASE WHEN sello_recibido IS NOT NULL AND length(trim(sello_recibido)) > 0 THEN 1 ELSE 0 END AS has_mh_seal, CASE WHEN mh_estado IS NOT NULL OR mh_observaciones_json <> '[]' THEN 1 ELSE 0 END AS has_mh_response, mh_estado, issued_at, accepted_at FROM dte_documents WHERE wompi_event_id = 'wompi_226a47e9-39e3-4418-b1f2-2b46e29849e8' OR (environment = '00' AND numero_control IN ('DTE-15-M001P004-000000000000031', 'DTE-15-M001P004-000000000000032', 'DTE-15-M001P004-000000000000033', 'DTE-15-M001P004-000000000000034')) ORDER BY numero_control, id;"
```

Expected before recovery: zero rows. Any row means at least one recorded invariant has
changed, even if its signature or MH-response flags are zero.

### 3. Wompi reservations for 31 through 34

```bash
npx wrangler d1 execute diezmossv-staging-resource-example --env staging --remote --command "SELECT id, environment, created_document_id, issuance_status, control_prefix, control_sequence, reserved_numero_control, reserved_codigo_generacion FROM wompi_events WHERE environment = '00' AND ((control_prefix = 'M001P004' AND control_sequence BETWEEN 31 AND 34) OR reserved_numero_control IN ('DTE-15-M001P004-000000000000031', 'DTE-15-M001P004-000000000000032', 'DTE-15-M001P004-000000000000033', 'DTE-15-M001P004-000000000000034')) ORDER BY control_sequence, id;"
```

Expected before recovery: zero rows.

### 4. Sequence counter

```bash
npx wrangler d1 execute diezmossv-staging-resource-example --env staging --remote --command "SELECT environment, control_prefix, next_value FROM document_sequences WHERE environment = '00' AND control_prefix = 'M001P004';"
```

Expected before recovery: exactly one row with `next_value = 35`.

## Abort invariants

Keep staging issuance paused and abort without mutating D1 if any of these is true:

- the incident event is missing, is not the approved environment-`00` event, already
  links to a document, or already owns any reservation;
- the dead-letter audit is missing, duplicated, or does not belong to the exact event;
- the CDE query returns a row for the event or for control numbers 31 through 34;
- the reservation query returns any row;
- the sequence row is missing, duplicated, uses another prefix/environment, or its
  `next_value` is not exactly 35;
- staging Wompi ingress or queue processing cannot be proven paused.

Do not reinterpret a changed value or choose another number during the recovery window.
Reassess the live state and prepare a new plan instead.

## Separately authorized atomic repair

The future repair must reserve sequence 31 for this exact event, leave the next free
sequence at 32, and establish an honest retryable failure record in one atomic D1
operation. Use a reviewed transactional D1 batch (or an equivalent single guarded
operation) that rechecks the invariants, moves the counter to 31, writes the event's
`M001P004` prefix and a newly generated generation code, lets the
`reserve_wompi_document_identifiers` trigger claim 31, and verifies that the trigger
advanced the counter to 32.

The same guarded operation must set `issuance_status = 'DEAD_LETTERED'`, preserve the
recorded four original deliveries as `issuance_attempt_count = 4`, and store only this
bounded factual evidence:

- `issuance_error_code = 'HISTORICAL_PRE_CDE_FAILURE'`;
- `issuance_error_message = 'Pago recibido; CDE no creado en los cuatro intentos originales.'`;
- `issuance_last_attempt_at`, `issuance_failed_at`, and
  `issuance_dead_lettered_at` set to the exact `ISSUANCE_DEAD_LETTERED` audit
  `created_at` verified in step 1b, never to a guessed timestamp.

It must also write a dedicated recovery audit row. Before committing, verify inside the
same guarded operation that the event has no document, owns sequence 31, has the exact
failure fields above, is eligible for the normal retry compare-and-swap, and would match
the **CDE NO CREADO** list predicate (`issuance_error_message` is non-null and status is
`FAILED` or `DEAD_LETTERED`).

Do not issue separate ad hoc counter and event updates: a partial success would expose
the wrong next value or an incomplete reservation. The atomic operation must roll back
on a failed guard or uniqueness constraint. Writing that mutation, applying the
migration, deploying the Worker, and changing staging D1 all require separate explicit
authorization; this runbook provides none of them.

## Retry, verify the MH test seal, and resume

After the authorized atomic repair succeeds:

1. Re-run the event, reservation, and counter `SELECT` checks. The event must own
   sequence 31 and `DTE-15-M001P004-000000000000031`, have the exact retryable failure
   fields above, and appear as **CDE NO CREADO** in Fallos; the counter must be 32; no
   other event may own 31 through 34.
2. Use the normal **Fallos → CDE NO CREADO → Reintentar creación** operator action for
   the exact event. Do not construct a second payload or a synthetic `dte_documents`
   row.
3. Run this read-only seal check:

```bash
npx wrangler d1 execute diezmossv-staging-resource-example --env staging --remote --command "SELECT id, wompi_event_id, environment, numero_control, codigo_generacion, status, CASE WHEN signed_jws IS NOT NULL AND length(trim(signed_jws)) > 0 THEN 1 ELSE 0 END AS has_signature, sello_recibido, mh_estado, accepted_at FROM dte_documents WHERE wompi_event_id = 'wompi_226a47e9-39e3-4418-b1f2-2b46e29849e8';"
```

Expected: exactly one environment-`00` row using control number 31, `status =
'ACCEPTED'`, `has_signature = 1`, and a non-empty MH test `sello_recibido`.

4. Re-run the sequence-counter query and confirm it still returns `next_value = 32`.
5. Confirm the event now links to that document with `issuance_status =
   'DOCUMENT_CREATED'` and the original reservation unchanged.
6. Resume staging Wompi ingress and queue processing only after every post-recovery
   check passes and the MH test seal has been recorded.

If the retry fails or the seal/counter differs, keep staging issuance paused and
escalate. Do not retry a mutation, allocate a replacement number, or resume issuance
without a new reviewed recovery decision.
