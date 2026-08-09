# Reconcile Open PRs and Migration History

> **Execution method:** Use `superpowers:subagent-driven-development`. Every implementation task gets a fresh implementer, failing-test evidence, self-review, a committed result, and a fresh task reviewer before the next task begins.

**Goal:** Land the two validated report fixes and the safe intent of every currently open review branch on current `main`, without publishing private deployment data, rewriting an applied migration, losing fiscal provenance, or claiming a deployment that this work does not perform.

**Scope:** every open review branch in the reconciliation inventory; the invalidation event-date report; and the legacy Wompi issuance migration report.

**Assumptions and boundaries:**

- `main` and the exact review-branch heads are re-fetched before each remote mutation.
- The backup-download branch is the only current head that is safe and current enough to merge unchanged. All other open heads remain forensic references and are superseded only after their corrected behavior lands.
- Migrations `0001` through `0029` stay byte-for-byte identical to the starting `main`. Canonical new public files are `0030_wompi_reconciliation_lifecycle.sql` and `0031_repair_wompi_payment_link_backfill.sql`; do not reuse either number for another body.
- The public repository contains only inert/example configuration. Actual domains, routes, resource IDs, account data, row counts, timestamps, logs, credentials, and private Wrangler contents never enter commits, PR text, tests, or command transcripts intended for GitHub.
- This work changes source and GitHub state only. It does not run a staging or production migration and does not deploy a Worker.
- Every shell command is prefixed with `rtk`. Temporary Miniflare/Playwright/D1 state lives outside the repository.

## Task 1: Merge the independently safe backup-download branch

**Checkable outcome:** `main` contains the exact backup-download commit through a normal protected merge, and this integration worktree advances to that new `origin/main` without losing the plan.

- [x] Re-fetch `origin`, re-read the branch head SHA, mergeability, required checks, reviews/comments, and current base SHA.
- [x] Verify the diff still changes only `src/worker/services/backups.ts`, `src/worker/services/retention.ts`, and `test/worker/workerFetch.retention-admin.test.ts`; verify manifest-membership authorization and unknown-table denial remain intact.
- [x] Merge using the expected head SHA; wait for the merge and required checks to report successful.
- [x] Fetch the new `origin/main`, fast-forward this still-uncommitted integration branch, and run the focused retention-admin test.

## Task 2: Correct the invalidation event emission date

**Files:**

- Modify: `src/worker/domain/dteBuilder.ts`
- Modify: `test/worker/dteBuilder.test.ts`
- Modify only if route-level coverage requires it: `test/worker/workerFetch.contingency-invalidation.test.ts`

**Checkable outcome:** `identificacion.fecEmi` and `identificacion.horEmi` both describe the actual invalidation event instant in El Salvador time, while `documento.fecEmi` remains the original CDE date. The already-correct next-month ten-business-day window remains unchanged.

- [x] First add/strengthen a regression test using different original-document and invalidation dates; run it against the fault and capture the expected failure.
- [x] Make `buildInvalidacionEvent` use the date and time returned by `mhDateTime(emittedAt)` for `identificacion`, preserving the original date under `documento`.
- [x] Run the focused builder and invalidation-route tests, then commit only these files.

## Task 3: Reconcile divergent D1 histories without rewriting them

**Findings:** attached legacy issuance report and the migration-history review branches

**Files:**

- Add: `migrations/0030_wompi_reconciliation_lifecycle.sql`
- Add: `migrations/0031_repair_wompi_payment_link_backfill.sql`
- Add/modify: `scripts/d1-schema-compatibility.mjs` and its `.d.mts`
- Add: `scripts/check-migration-immutability.mjs` and its `.d.mts`
- Modify: `scripts/run-private-wrangler.mjs` and its `.d.mts`
- Modify: `scripts/private-wrangler-config.mjs` and its `.d.mts` only as required to pass a private migration-directory override safely
- Modify: `package.json`, `.github/workflows/ci.yml`
- Add/modify tests: `test/scripts/d1SchemaCompatibility.test.ts`, `test/scripts/migrationImmutability.test.ts`, `test/scripts/deployScripts.test.ts`, `test/worker/wompiIssuanceSchema.test.ts`, `test/worker/wompiEventsSchema.test.ts`

**Checkable outcome:** fresh schemas, legacy ledgers that recorded `0019_wompi_issuance_lifecycle.sql`, current ledgers, and partially patched `0023`/`0024` schemas converge without duplicate-column crashes or loss of populated attempt, claim, idempotency, token, or rate-limit provenance. The exact old `0029` wildcard damage is corrected by new `0031`, not by editing `0029`.

- [x] Pin and test the starting hashes/names of every migration through `0029`; prove the guard fails when a historical file is temporarily changed, renamed, or removed.
- [x] Add canonical `0030` with exactly `ALTER TABLE wompi_events ADD COLUMN stalled_requeue_epoch_at TEXT;`.
- [x] Add `0031` that clears only approved Wompi rows whose stored positive `payment_link_id` equals the link ID in `raw_body`, whose commerce identifier matched old `LIKE 'di_%'`, and which does not match literal `GLOB 'di_*'`. Preserve literal `di_`, rejected, unrelated, null, and deliberately different runtime values.
- [x] Build an allowlisted compatibility manifest for all `0023` postconditions, both `0024` rate-limit columns, the email idempotency index, and the `0030` stalled epoch. Treat legacy `0019_wompi_issuance_lifecycle.sql` as a verified predecessor of current `0023`; add only absent fields/objects and alias a current filename in `d1_migrations` only after full postcondition verification.
- [x] Reject duplicate unique-key/index preconditions and wrong column/index shapes without choosing, deleting, rebuilding, or overwriting any row. Make every repair interruption-safe and idempotent.
- [x] For the `0024` partial case, use a private temporary migration overlay so Wrangler records `0024` without re-adding an existing column; never rebuild `donation_intents` or `audit_logs`.
- [x] Run compatibility before Wrangler migration apply in both staging and production package commands, entirely through the selected owner-only Wrangler config.
- [x] Write real-SQLite historical fixtures for: old core-only `0019`; late-mutated `0019` with populated values; recorded-current-but-missing-field `0023`; zero/one/two-column `0024` variants with populated IDs; duplicate email keys; recorded `0030` missing its column; and fresh full-chain application. Run every converged case twice and compare schema, ledger, row counts, and populated values.
- [x] Temporarily reproduce the attached old-`0019` crash against the current claim SQL, then show the compatibility path removes the crash and allows initial claim/recovery queries.
- [x] Commit this migration train as one reviewable unit so the wrapper, immutable SQL files, and guards cannot land separately.

## Task 4: Block the conditional `0004` evidence-loss state

**Files:**

- Modify: `scripts/d1-migration-preflight.mjs`
- Modify: `test/scripts/d1MigrationPreflight.test.ts`
- Add/modify: `test/migrations/emailDeliveryEvidenceMigration.test.ts`

**Checkable outcome:** `0001_init.sql` and `0004_email_delivery_evidence.sql` remain unchanged; normal fresh/legacy/already-applied paths pass; a target with `0004` pending plus any populated evidence field is blocked before Wrangler can run the destructive rebuild, with a count-only, no-PII error.

- [x] Add pure parsers/classifiers for the exact `0004` ledger name, table existence, seven evidence-column names, and aggregate populated-evidence count.
- [x] Query evidence counts only when `0004` is pending and evidence columns already exist. Do not log row identifiers, addresses, provider IDs, hashes, or values.
- [x] Prove with real SQLite that current `0004` preserves the seven legacy/base fields and that the synthetic populated-evidence/pending-ledger state is blocked before migration.
- [x] Cover fresh DB, legacy pending, recorded `0004`, partial columns with all evidence null, and partial columns with populated evidence. No rescue migration is added unless an authorized target inspection later proves one is needed.

## Task 5: Complete repeat-safe Wompi stalled episodes

**Files:**

- Modify: `src/worker/storage/repository/wompiIssuance.ts`
- Modify: `src/worker/storage/repository/retentionReads.ts`
- Modify: `src/worker/services/pipeline.ts`
- Modify: `src/worker/types.ts`
- Modify: `test/worker/support/inMemoryD1.ts`
- Modify: `test/worker/workerFetch.wompi-issuance-recovery.test.ts`
- Modify: `test/worker/workerFetch.sweep-cron-cert-expiry.test.ts`

**Checkable outcome:** an automatic stalled episode is capped and alerted once; a successful operator retry atomically starts a new epoch; a later episode receives its own three automatic retries and one new audit/alert; already-sent channels are deduplicated only within the same episode.

- [x] First add a failing two-episode route/cron test that reaches the first cap, performs an operator retry, then reaches a second cap.
- [x] On successful operator retry CAS, rotate `stalled_requeue_epoch_at` to the new retry timestamp atomically with status/attempt changes.
- [x] Count both requeue and stalled audits from the current epoch and use that epoch in the incident identity. Preserve retry of failed notification channels within an episode.
- [x] Verify real SQLite schema/claim behavior in addition to the in-memory recognizer; run the focused Wompi recovery and sweep suites.

## Task 6: Make password verification perform constant work

**Files:**

- Modify: `src/worker/services/auth.ts`
- Modify: `test/worker/auth.test.ts`
- Modify only required fixtures/assertions in: `test/worker/workerFetch.auth-infra.test.ts`, `test/worker/workerFetch.user-administration.test.ts`
- Add a workerd/Miniflare timing probe test or script under `test/worker/` or `scripts/` with synthetic accounts only

**Checkable outcome:** every verification path — legacy, versioned, and current stored formats, account-present-invalid, disabled, malformed, and account-absent — performs the same work before returning, so response timing does not distinguish them. A successful legacy login upgrades the stored format by compare-and-swap.

- [x] Write work-count tests first and prove the current account-present/absent and legacy/current paths differ.
- [x] Parse only explicitly recognized stored formats; reject anything else rather than falling back. Perform the full work on every path, using a dummy comparison where a step is not semantically needed.
- [x] Keep the external invalid-credential response identical and preserve session credential fencing and opportunistic rehash behavior.
- [x] Benchmark repeated synthetic unknown-account, disabled-account, and wrong-password requests in the repository's workerd-equivalent test runtime; use distribution/median evidence with a documented non-flaky tolerance rather than one wall-clock sample. Record the observed numbers in the private execution ledger, not the public test output.
- [x] Run focused auth/infrastructure/user-administration suites and commit only auth-related changes.

## Task 7: Bound annual certificates with truthful continuation

**Files:**

- Modify: `src/worker/storage/repository/retentionReads.ts`, `src/worker/storage/repository.ts`, `src/worker/storage/repository/dteDocuments.ts`
- Modify: `src/worker/services/certificate.ts`, `src/worker/index.ts`
- Modify: `src/client/App.tsx`, `src/client/exportsPanel.tsx`
- Modify: `test/worker/certificate.test.ts`, `test/worker/workerFetch.annual-certificates.test.ts`, `test/client/annualCertificateUi.test.ts`

**Checkable outcome:** preview retains at most 51 donor summaries, bulk processing examines at most 11 eligible unsent targets and processes 10, and a single dossier reads at most 26 rows and renders at most 25. API/UI expose deterministic continuation rather than silently truncating or claiming full-year totals.

- [x] Add constants: preview page 50, bulk donor batch 10, dossier document limit 25.
- [x] Add repository queries grouped/keyset-ordered by canonical recipient key `COALESCE(NULLIF(TRIM(donor_email), ''), NULLIF(TRIM(donor_name), ''), '(sin identificar)')`; target reads use `limit + 1`, dossier reads use 26, and all source filters remain accepted/non-claimed/year-bounded.
- [x] Bulk target selection excludes no-email and already-sent audit entries before the 11-row sentinel fetch; retain a final audit recheck before send. Preview search reuses existing accent-insensitive DTE search tokenization and computes complete-year summaries only for matched recipients.
- [x] Return `{ processed, sent, skipped, failed, hasMore, nextCursor }` for bulk and explicit `{ mode: 'single' }` semantics for per-row resend. Reject bodies containing both `donor` and `after`. Never write an email-derived continuation cursor to audit metadata.
- [x] Before PDF/email, reject a target count or 26-row read above 25. Bulk records one failed donor and continues; single returns HTTP 422. Prove PDF and email were never invoked.
- [x] Separate preview pagination state from bulk-send state in the client; show `Ver más donantes` and `Enviar siguiente tanda`, reset cursors on year/search/new traversal, and remove whole-year population/total claims that a bounded page cannot support.
- [x] Test 50+1 preview/resume, 10+1 bulk/resume, replay idempotence, 26-document bulk and single behavior, search, single resend, permissions, and year validation.

## Task 8: Reconcile public/private configuration and sender validation

**Files:**

- Modify: `wrangler.toml`, `README.md`, `docs/cloudflare-staging-uat.md`
- Modify: `scripts/private-wrangler-config.mjs` and its `.d.mts`
- Modify/add tests: `test/worker/environmentPolicy.test.ts`, `test/worker/emailBindingConfig.test.ts`, `test/scripts/productionProvisioningDocs.test.ts`, `test/scripts/privateWranglerConfig.test.ts`, `test/scripts/deployScripts.test.ts`, `test/scripts/privateBoundary.test.ts`

**Checkable outcome:** the public config has no active placeholder route, retains inert `.invalid` `APP_ORIGIN` and zero/example resource data, and has exactly one unrestricted `EMAIL` binding in each of root/staging/production. The selected private TOML is rejected if any root/environment/inline Email Service binding contains `allowed_sender_addresses` or if the required environment binding shape is wrong.

- [x] Remove only the active production route from public `wrangler.toml`; retain the inert origin so generated types do not drift. Prove `npm run types:check` remains green.
- [x] Rewrite provisioning docs to put real IDs/routes/origins/resource names only in the absolute, out-of-repo, owner-only `0600` config selected by `DIEZMOSSV_WRANGLER_CONFIG`, and route remote operations through existing private wrappers.
- [x] Remove sender allowlists from all three public example `EMAIL` bindings.
- [x] Parse and validate synthetic selected-private TOML root, named-environment, and inline binding forms before copying/executing it. Reject any sender allowlist and malformed/duplicate/missing expected bindings without reading a real private config in tests.
- [x] Run focused config/docs/boundary/type tests; commit no generated private value or live example.

## Task 9: Whole-branch review, privacy gate, publication, and main reconciliation

**Checkable outcome:** the candidate is clean, current with `origin/main`, independently reviewed, passes all local and required remote checks, merges into protected `main`, and every original open review branch is either merged or closed as superseded with its immutable head SHA and the merged successor reference.

- [ ] Generate a final review package for `origin/main...HEAD`; have a fresh high-capability reviewer check requirement coverage, migration history, fiscal/data preservation, auth timing design, bounded resource use, privacy, and tests. Resolve every blocker through the original task implementer and re-review.
- [ ] Run focused suites from every task, `npm test`, `npm run build`, `npm run types:check`, migration immutability, and local D1 full-chain migration.
- [ ] Stop any preview using port 8787, create a fresh external `PW_PERSIST_TO`, and run `npx playwright test` with an external `MINIFLARE_CACHE_DIR`.
- [ ] Run `npm run security:check-private-boundary` and the locally available privacy filter against the exact public payload (`origin/main...HEAD` diff plus the proposed review title, body, and comments). Do not publish if either gate is unavailable or fails.
- [ ] Fetch/rebase or merge current `origin/main`, rerun affected gates, push the reconciliation branch, and open one public-safe reconciliation review covering every inventory branch plus both reports, without private deployment facts.
- [ ] Wait for fresh strict `test-and-build` and `e2e` checks on the exact head. Merge with expected-head protection only after both succeed.
- [ ] Verify the merged `main` SHA and source files on the remote. Close each superseded branch with a concise comment that cites its preserved head SHA and merged successor, and verify none from this inventory remains open.
- [ ] Do not deploy or migrate a remote environment. Report source verification separately from the remaining controlled deployment/migration validation.

## Task 10: Fail closed when annual-certificate source rows change mid-send

**Authorization:** after the Task 7 five-round breaker exposed this race during whole-branch review, the user explicitly authorized a new follow-on task on 2026-08-08.

**Files:**

- Modify: `src/worker/services/certificate.ts`, `src/worker/index.ts`
- Modify/add focused tests: `test/worker/certificate.test.ts`, `test/worker/workerFetch.annual-certificates.test.ts`, and one real-Repository/SQLite certificate-race fixture if required

**Checkable outcome:** after the bounded dossier document read and before any PDF or email work, the service derives the current document count, amount total, test-environment flag, and canonical earliest-row donor identity from the returned records. A zero-document dossier or any mismatch with the earlier target aggregate fails closed. Bulk records one failed audit and continues; explicit single sends return sanitized HTTP 409 `certificate_dossier_changed`. Neither path renders a PDF, calls the provider, writes a SENT audit, or loops/retries automatically.

- [x] Preserve the whole-review real-SQLite RED for a two-row target that becomes zero after both rows are claimed, proving the current code emails a stale nonempty summary.
- [x] Preserve the whole-review real-SQLite RED for a one-row target that gains a second accepted row under the 25-document cap, proving the current code emails stale count/total with both CDE pages.
- [x] Derive the post-read snapshot from `documents` and require nonzero count plus exact equality with the target count, total, environment, group/email, and canonical donor identity before `donorSummary`, PDF rendering, or email dispatch. Build the successful summary from the current snapshot rather than stale target fields.
- [x] Keep the existing over-25 `CertificateDossierLimitError`/HTTP 422 contract unchanged. Add a separate sanitized changed-dossier error mapped to HTTP 409 for explicit single sends; bulk audits failure and continues to later targets.
- [x] Test downward-to-zero, under-cap insertion, amount-only drift, environment-only drift, same-aggregate identity replacement, unchanged success, bulk continuation, single 409, zero PDF/provider/SENT side effects, one FAILED audit, and mutation removal of each comparison.
- [x] Run focused certificate/repository/route/browser contracts, full test/build/type/migration/privacy gates, and commit only Task 10 files. Do not deploy, migrate remotely, push, or mutate GitHub in this task.

## Required handoff evidence

- Exact merged `main` SHA and the reconciliation review reference.
- Per-branch disposition and which corrected task captured its intent.
- Red/green proof for both attached findings.
- Focused/full/build/e2e/privacy results on the exact merged candidate.
- Explicit statement that no staging/production deployment or remote migration was performed, plus any deployment-only verification still required.
