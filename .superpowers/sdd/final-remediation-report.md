# Final production-readiness remediation report

## Status

**PASS** — all eight required remediation areas are implemented locally on
`codex/cde-no-creado`. The approved **CDE NO CREADO** behavior and the invariant that
an MH retry reuses the same legal control number are preserved.

No dependency was added. No remote Wrangler command, deployment, historical event
recovery, or production mutation was performed in this worktree.

## Assumption and checkable goal

The implementation treats an online payment as a durable Wompi issuance lifecycle:
before MH acceptance the UI may truthfully show **CDE NO CREADO**, and all retries for
that issuance reuse its reserved DTE/control number. Completion means every finding in
`final-remediation-brief.md` is fixed, focused regressions and the original nine-file
suite pass, and the repository-wide gates remain green.

## Changes

| Area | Commit | Result |
| --- | --- | --- |
| Migration guard and counter normalization | `e3f1eb8` | Staging and production migration scripts now run a mandatory duplicate-Wompi-link D1 preflight. Migration 0019 canonicalizes case-colliding sequence prefixes with the maximum counter before enforcing uniqueness; future allocation canonicalizes identically. Real-SQLite and preflight regressions cover lowercase and duplicate cases. |
| Serialized MH transmission | `5bf6cb1` | Every production MH-send path uses an atomic `TRANSMITTED` claim with a recoverable lease. Claim losers do not send. Terminal status/seal writes are preserved, late results cannot replace a terminal verdict, and stale claims are recoverable. |
| Operator-safe failure evidence | `ddbdf61` | Untrusted errors map to fixed generic evidence. Only an explicit trusted projection can retain bounded operator-safe detail. Token, donor, URL/newline, response-body, thrown-object, certificate-like, and stack-like leakage regressions are covered. |
| Attempt-safe queue and DLQ lifecycle | `805a073` | A persisted issuance attempt ID now follows new messages. Current-attempt compare-and-swap transitions protect enqueue, processing, failures, retries, stalled recovery, and DLQ; stale deliveries cannot overwrite a newer attempt. Legacy messages retain a safe fallback, and a current hard termination remains visible in Fallos. Retry actor evidence is recorded at the claim boundary. |
| Accepted finalization and stable email claims | `28800de` | Acceptance finalization is idempotent across queue, deferred, and scheduled recovery without retransmitting to MH. A durable completion marker is written only after acceptance audit, intent/correlation work, and definitive receipt/no-email handling. Receipt claims have a lease and deterministic non-PII provider identity reused across stale/failed replays; Cloudflare and HTTP sends receive stable idempotency headers. |
| Mutable retention and counter snapshots | `de229c7` | Each monthly archive contains a full current-state Wompi snapshot and a fully paged `document_sequences` snapshot. Manifest/object layout and restore guidance now require the latest snapshots and reconcile each counter as `MAX(snapshot next_value, restored document maximum + 1, restored reservation maximum + 1)` without moving a target counter backward. |
| Honest Fallos loading state | `6d3dafd` | Fallos enters a visible “Revisando pagos sin CDE creado…” state before the first paint can claim “Todo en orden.” Latest-request invalidation protects both loading and result commits from stale overlapping responses. |

## TDD evidence

Focused regressions were observed failing before each implementation slice. The last
three slices, where the new recovery behavior was most extensive, produced these RED
signals before their corresponding fixes:

- Accepted finalization/email recovery: missing finalization marker and email-claim
  columns/identity produced 7 focused failures; HTTP idempotency propagation had a
  separate focused failure.
- Mutable retention: the post-month lifecycle snapshot, sequence manifest/object, and
  bounded sequence paging expectations produced 5 focused failures.
- Fallos loading: loading copy and stale-overlap expectations produced 3 focused
  failures, plus the transition-before-first-paint regression failed until loading was
  committed synchronously.

After implementation, focused coverage includes real SQLite migration/claim behavior,
two-delivery MH concurrency, stale claim recovery, terminal result preservation,
stale-DLQ/current-attempt races, hard termination, legacy messages, queue-send failure,
accepted crash windows, deferred and scheduled finalization, email lease/replay
identity, post-month Wompi mutation, 1,200 sequence rows across exactly three bounded
pages, and overlapping client requests.

## Final verification

Fresh checks on implementation HEAD `6d3dafd`:

| Check | Result |
| --- | --- |
| Exact original nine-file suite (`dteBuilder`, `wompiIssuanceSchema`, `issuanceFailure`, `workerFetch`, `retention`, `preCdeFailures`, `viewText`, `visualConsistency`, `displayText`) | PASS — 9 files, 473 tests |
| `npm run typecheck` | PASS — both TypeScript configurations |
| `npm run build` | PASS — 1,795 modules transformed |
| `npm run security:check-private-boundary` | PASS — `Private artifact boundary: clean` |
| `npm test` | PASS — 63 files, 1,043 passed, 2 skipped, 0 failed |
| `git diff --check` | PASS |
| Worktree/artifact audit | PASS — clean worktree; no unrelated `tmp/` or ` 2` artifact in `33e9fc2..HEAD` |

## Remaining risk and deployment boundary

- Migration 0019 is additive. A target database with duplicate non-null Wompi links
  will intentionally fail the preflight and require human review; the tool does not
  guess which legal DTE row to keep.
- Legacy `PENDING` email rows without a claim-attempt timestamp are intentionally not
  auto-reclaimed. They remain a manual-review boundary because their in-flight state
  cannot be established safely.
- Stable provider identity prevents this application from creating a new send identity
  on replay. Final duplicate suppression still depends on the configured provider
  honoring the idempotency header or deterministic `Message-ID`.
- Monthly snapshots are bounded and restartable, but are not a cross-table database
  transaction. Restore must follow the documented latest-snapshot and counter-max
  reconciliation procedure.
- The build retains its pre-existing advisory that the main browser chunk exceeds
  500 kB after minification; it is non-blocking and unrelated to this remediation.
- Deployment, applying the migration to Cloudflare, and live staging validation are
  deliberately outside this local remediation task and must be performed separately.

## Commit sequence

1. `e3f1eb8 fix: guard issuance migration and normalize counters`
2. `5bf6cb1 fix: serialize MH document transmission`
3. `ddbdf61 fix: bound issuance failure evidence`
4. `805a073 fix: bind issuance lifecycle to queue attempts`
5. `28800de fix: recover accepted receipt finalization`
6. `de229c7 fix: snapshot mutable retention state`
7. `6d3dafd fix: show honest failure loading state`
