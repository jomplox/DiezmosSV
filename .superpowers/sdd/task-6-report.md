# Task 6 report: recovery, retention, audit labels, and operator runbook

## Summary

Implemented safe scheduled recovery for stalled fiscal corrections, retained their
complete immutable evidence, added PII-safe lifecycle audits and Spanish labels, and
documented the guarded operator workflow.

Recovery is deliberately pre-dispatch only. The scheduled invocation rotates the
correction processing token with a compare-and-swap update, verifies the matching
Wompi issuance or DTE fiscal claim, and queues the exact correction with its fresh
ownership tokens. It never calls Ministerio de Hacienda directly. A correction whose
MH dispatch marker exists remains untouched and requires review.

## RED

Command:

```bash
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmos-miniflare-task6-red npm test -- test/worker/workerFetch.test.ts test/worker/retention.test.ts test/client/displayText.test.ts
```

Result: failed as expected. The three new assertions failed because scheduled fiscal
correction recovery, the `fiscal_corrections` retention object, and the Spanish audit
labels did not yet exist. The run reported 508 passing and 3 failing tests across the
three requested files.

## Changes

- `src/worker/storage/repository.ts`
  - registers `fiscal_corrections` as a monthly retention table;
  - adds a compare-and-swap recovery claim limited to stale, proven pre-dispatch work;
  - verifies the matching Wompi issuance attempt or DTE fiscal claim before recovery;
  - centralizes immutable lifecycle audits with correction ID, target, hashed request
    ID, attempt number, allowlisted changed-field names, and safe outcome code;
  - excludes receptor snapshots and raw request IDs from audit metadata.
- `src/worker/services/pipeline.ts`
  - adds `recoverStalledFiscalCorrections(limit?)`;
  - queues recovered work with fresh correction ownership and matching operational
    tokens without transmitting to MH in cron;
  - resumes an already-signed corrected DTE without rebuilding it or allocating
    another control sequence;
  - routes lifecycle audit writes through the repository helper.
- `src/worker/index.ts`
  - runs recovery after the stalled-Wompi sweep in an isolated scheduled-handler
    boundary;
  - records the initial `QUEUED` audit before sending a correction queue message.
- `src/worker/services/retention.ts`
  - publishes dependency-aware restore and reverse deletion orders so corrections are
    restored after, and deleted before, their referenced Wompi/DTE parents.
- `src/client/displayText.ts`
  - adds all six requested Spanish fiscal-correction audit labels.
- `docs/runbook-operador.md`
  - documents pre-CDE versus rejected-DTE correction, editable and protected fields,
    the single guarded action, lifecycle states, uncertain-outcome escalation, and
    manual review of pre-existing records.
- `docs/retention-restore.md`
  - documents the new archive object and its restore/deletion dependency order.
- Tests cover the recovery safety boundary, token rotation, signed-DTE continuation,
  real SQLite ownership checks, retention payload/hash/order, audit PII exclusion,
  labels, and operator guidance.

## GREEN

Focused acceptance tests:

```bash
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmos-miniflare-task6-final-focused npm test -- test/worker/workerFetch.test.ts test/worker/retention.test.ts test/client/displayText.test.ts
```

Result: 3 files passed, 513 tests passed.

Real SQLite and schema-contract tests:

```bash
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmos-miniflare-task6-final-sql npm test -- test/worker/repositoryFiscalSql.test.ts test/worker/wompiEventsSchema.test.ts
```

Result: 2 files passed, 44 tests passed.

Full suite:

```bash
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmos-miniflare-task6-full2 npm test
```

Result: 74 files passed; 1,350 tests passed and 1 test skipped. The first full-suite
attempt exposed an existing SQL-contract guard that treats `created_at` as forbidden
in Wompi lifecycle queries. Recovery now uses `updated_at` for stale queued work; the
schema test and full suite passed on rerun.

Static checks:

```bash
rtk npm run typecheck
rtk git diff --check
```

Result: both passed.

## Self-review and remaining risk

- Recovery cannot reclaim terminal corrections or any processing row marked as having
  started MH dispatch.
- Operational ownership is checked again atomically while rotating the processing
  token, preventing an old queue owner from resuming work.
- Signed DTE recovery reuses the persisted signed payload and identifiers.
- Retention keeps full before/after receptor evidence, while audit rows contain only
  field names and safe identifiers.
- Queue-send failure after claim rotation leaves a pre-dispatch processing row that
  becomes safely recoverable after the same lease window.
- The test runner still prints the repository's known non-blocking Fontconfig warning.

No emails, database rows, Cloudflare resources, deployments, or other external systems
were mutated by this task.
