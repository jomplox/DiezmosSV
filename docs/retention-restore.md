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
retention/<YYYY>/<YYYY-MM>/donation_intents.ndjson
retention/<YYYY>/<YYYY-MM>/dte_events.ndjson
retention/<YYYY>/<YYYY-MM>/email_deliveries.ndjson
retention/<YYYY>/<YYYY-MM>/audit_logs.ndjson
retention/<YYYY>/<YYYY-MM>/wompi_events.ndjson              (full current-state snapshot)
retention/<YYYY>/<YYYY-MM>/document_sequences.ndjson        (full current-state snapshot)
retention/<YYYY>/<YYYY-MM>/contingency_periods.ndjson       (full snapshot, not month-windowed)
retention/<YYYY>/<YYYY-MM>/contingency_batches.ndjson       (full snapshot, not month-windowed)
retention/<YYYY>/<YYYY-MM>/contingency_batch_lines.ndjson   (full snapshot, not month-windowed)
retention/<YYYY>/<YYYY-MM>/manifest.json
```

Each `.ndjson` file has one JSON object per line (one D1 row per line). The
five windowed tables (`dte_documents`, `donation_intents`, `dte_events`,
`email_deliveries`, `audit_logs`) are filtered to rows whose `created_at`
falls in the given month, evaluated in El Salvador local time (UTC-6, no
DST). The mutable `wompi_events` lifecycle, the legal number counters in
`document_sequences`, and the three contingency tables are full snapshots as
of each run. Reads remain keyset-paged and bounded; “full” does not mean one
unbounded D1 query.

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
    "dte_events": { "rowCount": 8, "sha256": "…" },
    "email_deliveries": { "rowCount": 405, "sha256": "…" },
    "wompi_events": { "rowCount": 420, "sha256": "…" },
    "document_sequences": { "rowCount": 2, "sha256": "…" },
    "audit_logs": { "rowCount": 1890, "sha256": "…" },
    "contingency_periods": { "rowCount": 2, "sha256": "…" },
    "contingency_batches": { "rowCount": 1, "sha256": "…" },
    "contingency_batch_lines": { "rowCount": 3, "sha256": "…" }
  }
}
```

## 1. List what's in the archive

```bash
npx wrangler r2 object get diezmossv-staging-archive-example/retention/2026/2026-06/manifest.json --env staging
```

To list all objects for a given month without downloading each one, use the
R2 API/dashboard (`wrangler r2 object` operates on a single key at a time) or
`aws s3 ls` against R2's S3-compatible endpoint if configured.

## 2. Verify manifest hashes match the archived bodies

Download each `.ndjson` referenced in the manifest and confirm its SHA-256
matches the recorded hash before trusting it for a restore:

```bash
npx wrangler r2 object get diezmossv-staging-archive-example/retention/2026/2026-06/dte_documents.ndjson \
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
   `wompi_events`, also follow `migrations/0019_wompi_issuance_lifecycle.sql`:
   an older row may use `NULL` for absent nullable lifecycle columns and the
   default `0` for `issuance_attempt_count`; do not manufacture lifecycle
   evidence.
3. Apply via `wrangler d1 execute <database> --env <env> --remote --file
   restore.sql`, batching inserts (D1 has a statement-size limit) rather
   than issuing thousands of individual `wrangler d1 execute` calls.
4. Foreign keys matter for ordering: restore `dte_documents` and
   `contingency_periods` before `dte_events`, `contingency_batches`, and
   `contingency_batch_lines` (which reference them), and restore
   `wompi_events` before `dte_documents` (which references it).
5. After restoring, spot-check row counts against the manifest's
   `rowCount` for each table, and re-run the read paths (`GET
   /api/documents`, `GET /api/audit`) to confirm the restored data renders
   correctly.

### Mutable snapshots and legal counter reconciliation

Do not concatenate every repeated Wompi snapshot. Restore historical
windowed records, then overlay rows by `id` from the latest
`wompi_events.ndjson` snapshot whose manifest and hash both verify. This last
snapshot is authoritative for the mutable issuance lifecycle. Archives from
before the full-snapshot change may contain only the Wompi rows received that
month; treat them as legacy partial inputs and overlay the newest verified
full snapshot when one is available.

Restore the latest `document_sequences.ndjson` snapshot after Wompi events and
DTE documents have been restored, then reconcile each
`(environment, UPPER(control_prefix))` before allowing any new issuance. For
each key, the safe next value is exactly:

**MAX(snapshot `next_value`, restored document maximum + 1, restored reservation maximum + 1)**

The restored document maximum is the greatest trailing serial from
`dte_documents.numero_control` for that environment/prefix. The restored
reservation maximum is the greatest non-null `wompi_events.control_sequence`
for the same environment/prefix. If one source has no row, omit that term (or
treat it as `1`). Archives created before `document_sequences.ndjson` existed
are valid legacy archives: derive the counter from the document and Wompi
reservation maxima instead of assuming `1`.

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
