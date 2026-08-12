# Restoring from the legal-retention export

Every month (cron `0 9 1 * *`, 09:00 UTC / 03:00 El Salvador, 1st of the
month) the Worker writes an immutable snapshot of all legal records for the
previous calendar month to the `ARCHIVE` R2 bucket (`diezmossv-local-archive-example`
/ `-staging` / `-production`). This is the recovery path if D1 is ever lost,
the database alone is compromised, or a bad migration corrupts data — the
multi-year retention tax law requires survives independently of D1.

## Object layout

```
retention/<YYYY>/<YYYY-MM>/dte_documents.ndjson
retention/<YYYY>/<YYYY-MM>/fiscal_corrections.ndjson
retention/<YYYY>/<YYYY-MM>/fiscal_corrections_latest.ndjson  (full current-state snapshot)
retention/<YYYY>/<YYYY-MM>/donation_intents.ndjson
retention/<YYYY>/<YYYY-MM>/dte_events.ndjson
retention/<YYYY>/<YYYY-MM>/email_deliveries.ndjson
retention/<YYYY>/<YYYY-MM>/audit_logs.ndjson
retention/<YYYY>/<YYYY-MM>/wompi_events.ndjson              (full current-state snapshot)
retention/<YYYY>/<YYYY-MM>/document_sequences.ndjson        (full current-state snapshot)
retention/<YYYY>/<YYYY-MM>/contingency_periods.ndjson       (full snapshot, not month-windowed)
retention/<YYYY>/<YYYY-MM>/contingency_batches.ndjson       (full snapshot, not month-windowed)
retention/<YYYY>/<YYYY-MM>/contingency_batch_lines.ndjson   (full snapshot, not month-windowed)
retention/<YYYY>/<YYYY-MM>/stripe_checkout_sessions.ndjson  (full current-state snapshot)
retention/<YYYY>/<YYYY-MM>/stripe_webhook_events.ndjson     (full current-state snapshot)
retention/<YYYY>/<YYYY-MM>/stripe_gifts.ndjson              (full current-state snapshot, including refund state)
retention/<YYYY>/<YYYY-MM>/stripe_acknowledgment_deliveries.ndjson  (full current-state snapshot)
retention/<YYYY>/<YYYY-MM>/stripe_annual_statement_deliveries.ndjson (full current-state snapshot)
retention/<YYYY>/<YYYY-MM>/manifest.json
```

Each `.ndjson` file has one JSON object per line (one D1 row per line). The
six windowed tables (`dte_documents`, `fiscal_corrections`,
`donation_intents`, `dte_events`, `email_deliveries`, `audit_logs`) are
filtered to rows whose `created_at`
falls in the given month, evaluated in El Salvador local time (UTC-6, no
DST). The mutable `fiscal_corrections` and `wompi_events` lifecycles, the legal
number counters in `document_sequences`, and the three contingency tables are
also written as full snapshots as of each run. Every Stripe source-of-truth
table is likewise a full snapshot: checkout and webhook lifecycle evidence,
gifts (including durable refund status and `refunded_amount_cents`), immediate
acknowledgments, and annual-statement revision/delivery evidence. The historical
`fiscal_corrections.ndjson` file remains month-windowed and unchanged;
`fiscal_corrections_latest.ndjson` is its authoritative current-state overlay.
Both files contain the same complete correction row shape, while audit history
remains separate in `audit_logs.ndjson`. Reads remain keyset-paged and bounded;
“full” does not mean one unbounded D1 query.

The pre-CDE issuance lifecycle stays inside the existing
`wompi_events.ndjson` row; it does not create a separate export. A Wompi row
can resolve months after it was received, so every run captures it again. The
latest `wompi_events.ndjson` snapshot therefore retains the current
`issuance_status`, reserved control/generation identifiers,
`issuance_attempt_count`, safe error code/message, and attempt/failure
timestamps together with the original event. Archives created before these
columns existed may omit them. Those rows remain valid legacy data: do not
infer a failed issuance from an absent field or invent a reservation/error
during restore.

`manifest.json` is written **last** and is the completion marker: if it
already exists for a given month, a re-run (cron retry or manual trigger)
skips re-exporting and audits `RETENTION_EXPORT_SKIPPED` instead of
duplicating work. It looks like:

```json
{
  "month": "2026-06",
  "generatedAt": "2026-07-01T09:00:03.512Z",
  "tables": {
    "dte_documents": { "rowCount": 412, "sha256": "…64 hex chars…" },
    "fiscal_corrections": { "rowCount": 3, "sha256": "…" },
    "fiscal_corrections_latest": { "rowCount": 7, "sha256": "…" },
    "dte_events": { "rowCount": 8, "sha256": "…" },
    "email_deliveries": { "rowCount": 405, "sha256": "…" },
    "wompi_events": { "rowCount": 420, "sha256": "…" },
    "document_sequences": { "rowCount": 2, "sha256": "…" },
    "audit_logs": { "rowCount": 1890, "sha256": "…" },
    "contingency_periods": { "rowCount": 2, "sha256": "…" },
    "contingency_batches": { "rowCount": 1, "sha256": "…" },
    "contingency_batch_lines": { "rowCount": 3, "sha256": "…" },
    "stripe_checkout_sessions": { "rowCount": 31, "sha256": "…" },
    "stripe_webhook_events": { "rowCount": 84, "sha256": "…" },
    "stripe_gifts": { "rowCount": 27, "sha256": "…" },
    "stripe_acknowledgment_deliveries": { "rowCount": 27, "sha256": "…" },
    "stripe_annual_statement_deliveries": { "rowCount": 8, "sha256": "…" }
  }
}
```

## 1. List what's in the archive

```bash
node scripts/run-private-wrangler.mjs r2 object get diezmossv-staging-archive-example/retention/2026/2026-06/manifest.json --env staging
```

To list all objects for a given month without downloading each one, use the
R2 API/dashboard (`wrangler r2 object` operates on a single key at a time) or
`aws s3 ls` against R2's S3-compatible endpoint if configured.

## 2. Verify manifest hashes match the archived bodies

Download each `.ndjson` referenced in the manifest and confirm its SHA-256
matches the recorded hash before trusting it for a restore:

```bash
node scripts/run-private-wrangler.mjs r2 object get diezmossv-staging-archive-example/retention/2026/2026-06/dte_documents.ndjson \
  --env staging --file dte_documents.ndjson
shasum -a 256 dte_documents.ndjson
# Compare against manifest.json → tables.dte_documents.sha256
```

Repeat for every table listed in the manifest. If any hash mismatches, the
object was corrupted or tampered with after being written — do not use it for
a restore; escalate before proceeding.

## 3. Re-import NDJSON into D1

Each line in a `.ndjson` file is a full row as it existed in D1 at export
time (same column names as the corresponding `CREATE TABLE`). To restore a
table:

1. Confirm the target D1 database/table is actually the one that needs
   restoring (do not overwrite good data). Take a fresh export or backup of
   current state first if the table already has rows.
2. Convert the NDJSON rows into `INSERT` statements matching the table's
   columns, in the same order that appears in `migrations/0001_init.sql` /
   `migrations/0005_nullable_dte_wompi_source.sql` for that table. For
   `wompi_events`, also follow `migrations/0023_wompi_issuance_lifecycle.sql`:
   an older row may use `NULL` for absent nullable lifecycle columns and the
   default `0` for `issuance_attempt_count`; do not manufacture lifecycle
   evidence.
3. Apply via `node scripts/run-private-wrangler.mjs d1 execute <database>
   --env <env> --remote --file restore.sql`, batching inserts (D1 has a
   statement-size limit) rather than issuing thousands of individual
   `d1 execute` calls.
4. Wrangler wraps the file in its own transaction. Do not put `BEGIN`, `COMMIT`, or `ROLLBACK` inside `restore.sql`;
   nested transaction statements make `wrangler d1 execute --file` fail.
   There is no valid flat insert order because
   `contingency_periods` ↔ `dte_events` ↔ `dte_documents` is a real reference
   cycle. Start the generated SQL file with:

   ```sql
   PRAGMA defer_foreign_keys = ON;
   ```

   Insert in these phases:

   1. roots: `wompi_events`, `document_sequences`,
      `stripe_checkout_sessions`, `stripe_webhook_events`;
   2. deferred cycle: `contingency_periods`, `dte_documents`, `dte_events`;
   3. dependents: historical `fiscal_corrections`, `email_deliveries`,
      `contingency_batches`, `donation_intents`, `stripe_gifts`;
   4. authoritative correction overlay: apply the latest verified
      `fiscal_corrections_latest.ndjson` snapshot to `fiscal_corrections`;
   5. leaves: `contingency_batch_lines`, `audit_logs`,
      `stripe_acknowledgment_deliveries`,
      `stripe_annual_statement_deliveries` (ascending `revision` within each
      donor/year/livemode lineage).

   End the same file with:

   ```sql
   PRAGMA foreign_key_check;
   ```

   The command must return no rows. If it reports any row or any statement
   fails, treat the Wrangler execution as failed and repair the archive/input
   mapping; do not disable foreign keys or accept a partial restore.

   Cleanup uses a separate Wrangler file with the same first and last pragmas,
   but reverses dependencies:
   delete Stripe acknowledgments and annual statements before `stripe_gifts`,
   and delete `stripe_gifts` before `stripe_checkout_sessions`. Delete the
   remaining leaves and dependents first (including `fiscal_corrections`), then
   delete `dte_events`, `dte_documents`, and `contingency_periods` as the
   deferred cycle, and finally delete `wompi_events` and
   `document_sequences`.
5. After restoring, spot-check row counts against the manifest's
   `rowCount` for each table, and re-run the read paths (`GET
   /api/documents`, `GET /api/audit`) to confirm the restored data renders
   correctly.

### Local SQLite rehearsal

Wrangler provides the outer transaction remotely. A local `sqlite3` or
`better-sqlite3` rehearsal does not, so wrap the same ordered file contents
explicitly:

```sql
BEGIN IMMEDIATE;
PRAGMA defer_foreign_keys = ON;
-- ordered restore or cleanup phases
PRAGMA foreign_key_check;
COMMIT;
```

If the local foreign-key check reports rows, use `ROLLBACK` instead of
`COMMIT`, repair the input, and repeat the rehearsal.

### Mutable snapshots and legal counter reconciliation

Use only the latest verified Stripe snapshots as a set. Do not mix individual
Stripe tables from different monthly manifests: their foreign-key and delivery
state may describe different provider chronology. Restore all row columns from
migrations 0032–0035, without raw Stripe payloads or secrets, in this order:
`stripe_checkout_sessions`, `stripe_webhook_events`, `stripe_gifts`, then
`stripe_acknowledgment_deliveries` and
`stripe_annual_statement_deliveries`. The refund source of truth is the
`status` plus `refunded_amount_cents` stored on each `stripe_gifts` row; do not
invent a separate refund row. Insert annual revisions in ascending `revision`
order so every `supersedes_delivery_id` already exists. Run
`PRAGMA foreign_key_check` before accepting the restore.

Stripe snapshots are intended for an empty loss-recovery database. If restoring
into a database with existing Stripe rows, compare rows by primary/unique key
and stop for manual review on any difference; never overwrite immutable annual
snapshot/lineage evidence or turn REVIEW/SENT delivery evidence backward.
Archives created before these Stripe snapshot files existed remain valid legacy
archives, but they cannot reconstruct Stripe gifts and no missing row may be
manufactured from an audit entry.

Do not concatenate every repeated Wompi snapshot. Restore historical
windowed records, then overlay rows by `id` from the latest
`wompi_events.ndjson` snapshot whose manifest and hash both verify. This last
snapshot is authoritative for the mutable issuance lifecycle. Archives from
before the full-snapshot change may contain only the Wompi rows received that
month; treat them as legacy partial inputs and overlay the newest verified
full snapshot when one is available.

Restore the latest `fiscal_corrections_latest.ndjson` snapshot after the
historical `fiscal_corrections.ndjson` rows and after both possible parent
tables (`wompi_events` and `dte_documents`). Apply every correction column,
including `reserved_control_prefix`, `reserved_control_sequence`,
`reserved_codigo_generacion`, and `reserved_numero_control`, and use an
idempotent `INSERT ... ON CONFLICT(id) DO UPDATE` upsert keyed by `id`. The
update list in `RETENTION_FOREIGN_KEY_PROTOCOL.authoritativeOverlays` is the
source of truth. Applying the same verified snapshot twice must leave one
identical row. This latest snapshot is authoritative for mutable status,
dispatch, failure, claim, reservation, and completion fields, so a historical
`QUEUED` or `PROCESSING` row cannot overwrite a later `ACCEPTED`, `REJECTED`,
`FAILED`, or `REVIEW_REQUIRED` outcome.

Migration 0028's `trg_fiscal_correction_reserve_sequence` trigger deliberately
allocates a new live sequence when an application update changes
`reserved_control_sequence` from `NULL` to a value. A restore is replaying an
already allocated reservation, not allocating a new one. If
`document_sequences.next_value` is already ahead, leaving that trigger enabled
would abort the authoritative overlay. In the **same atomic restore file**,
temporarily remove only that known allocation trigger, apply all correction
upserts, and recreate it immediately afterward:

```sql
DROP TRIGGER IF EXISTS trg_fiscal_correction_reserve_sequence;

-- INSERT every fiscal_corrections_latest.ndjson row here, including all
-- migration 0028 reservation columns:
-- INSERT INTO fiscal_corrections (...) VALUES (...)
-- ON CONFLICT(id) DO UPDATE SET ...;

CREATE TRIGGER trg_fiscal_correction_reserve_sequence
AFTER UPDATE OF reserved_control_sequence ON fiscal_corrections
WHEN (
  OLD.reserved_control_sequence IS NULL
  AND NEW.reserved_control_sequence IS NOT NULL
)
BEGIN
  UPDATE document_sequences
     SET next_value = next_value + 1
   WHERE environment = NEW.environment
     AND control_prefix = NEW.reserved_control_prefix
     AND next_value = NEW.reserved_control_sequence;

  SELECT RAISE(ABORT, 'fiscal correction sequence reservation failed')
   WHERE changes() <> 1;
END;
```

Do not drop `trg_fiscal_correction_reservation_complete`; it must continue to
reject incomplete four-field reservations. For Wrangler, the drop, upserts,
trigger recreation, and final `PRAGMA foreign_key_check` belong in one
`--file` execution, without explicit transaction statements. For a local
rehearsal they belong inside the existing `BEGIN IMMEDIATE` transaction. An
upsert or trigger-recreation failure must roll back the whole restore; never
leave the allocation trigger absent.

Archives created before `fiscal_corrections_latest.ndjson` are valid legacy
archives. Restore their historical `fiscal_corrections.ndjson` rows as they
exist and do not invent a later outcome. When any newer verified archive
contains the authoritative snapshot, overlay that newest snapshot last. The
snapshot repeats only the already protected correction row in R2; it does not
copy receptor JSON into audit metadata, and it remains behind the same audited
admin-only backup download route.

Restore the latest `document_sequences.ndjson` snapshot after Wompi events and
DTE documents have been restored. After the authoritative fiscal-correction
overlay, reconcile each `(environment, UPPER(control_prefix))` before allowing
any new issuance. For each key, the safe next value is exactly:

**MAX(snapshot `next_value`, restored document maximum + 1, restored Wompi reservation maximum + 1, restored fiscal-correction reservation maximum + 1)**

The restored document maximum is the greatest trailing serial from
`dte_documents.numero_control` for that environment/prefix. The restored
Wompi reservation maximum is the greatest non-null
`wompi_events.control_sequence` for the same environment/prefix. The restored
fiscal-correction reservation maximum is the greatest non-null
`fiscal_corrections.reserved_control_sequence` for the same
environment/`reserved_control_prefix`. If one source has no row, omit that
term (or treat it as `1`). Archives created before
`document_sequences.ndjson` existed are valid legacy archives: derive the
counter from the document, Wompi, and fiscal-correction reservation maxima
instead of assuming `1`.

Never move an existing counter backward. When restoring into a database that
already has a counter, compare its current `next_value` with the formula above
and retain the greater value. Normalize prefixes to uppercase before merging
case-colliding legacy rows, and stop for manual review if restored legal rows
conflict rather than choosing or deleting one automatically.

## Manual verification without waiting for the 1st

`POST /api/admin/retention-export` (OWNER role required) runs the same
export function on demand. Add `?month=YYYY-MM` to export a specific month
(otherwise it exports the previous calendar month, same as the cron). This
is how staging UAT verifies the export works without waiting for the
monthly cron to fire, and it is safe to re-run — idempotency via the
manifest-existence check means a repeat call for a month that already has a
completed export just audits `RETENTION_EXPORT_SKIPPED` and returns without
rewriting anything.
