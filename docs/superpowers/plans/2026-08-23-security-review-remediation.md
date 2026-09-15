# Production Security Review Remediation Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task.

**Goal:** Remediate all eleven user-supplied production security review comments with behavior-level regression proof and no live deployment.

**Architecture:** Strengthen existing integration and request boundaries. Provider readiness and response validation remain in service boundaries; distributed admissions and step-up login state live in D1; webhook collision classification stays in the Wompi repository/ingestion boundary; backup trust is anchored in live D1 export evidence; response/audience policies are enforced before data leaves the Worker.

**Tech Stack:** TypeScript, Cloudflare Workers, D1/SQLite migrations, R2, React, Vitest, Miniflare, Wrangler.

**Authoritative spec:** [docs/superpowers/specs/2026-08-23-security-review-remediation-design.md](../specs/2026-08-23-security-review-remediation-design.md)

**Baseline:** `9712e933a0fc6c4cb93836c60d5bd53694e9e5cb`; `npm test` passed 143 files and 2510 tests (2 skipped) with an external MINIFLARE_CACHE_DIR and sandbox-free loopback.

## Preflight conflict map

| Tasks | Shared surface | Ruling |
|---|---|---|
| 1 and 5 | MH readiness/sanitization concepts and credentials | Task 1 may add a readiness helper; Task 5 owns provider-response sanitization and must reuse, not duplicate, secret selection. |
| 1 and 6 | Runtime configuration | Task 1 owns production mock/manifest rules. Task 6 may read config but must not relax Task 1. |
| 1 and 9 | `src/worker/index.ts` response paths indirectly consume Wompi links | Task 1 completes first and defines typed Wompi errors; Task 9 must preserve them. |
| 3 and 4 | New D1 migrations and rate-limit repository interfaces | Task 3 appends 0045. Task 4 appends 0046 and updates the immutable migration frontier through both; neither edits historical migrations. |
| 3, 4, 5, 7, 8 | `src/worker/index.ts` | Execute sequentially. Every later implementer starts from current HEAD and preserves earlier focused tests. |
| 4 and 6 | Repository facade and cleanup sweep | Task 4 owns provider-claim cleanup; Task 6 adds only the retention-anchor read method. |
| 5 and 7 | Audit logs | Task 5 adds bounded conflict evidence; Task 7 changes only read authorization/projection. |
| 6 and 7 | Audit repository | Task 6 adds a narrowly named retention-anchor query; Task 7 must preserve it. |
| 8 and all route tasks | Outer fetch return wrapper | HSTS is last so its structural wrapper sees all final route forms without causing repetitive merge work. |

## Task 1: Fail closed before real Wompi checkout creation

**Review comments:** 1, 2, 11.

**Files:**

- Modify: `src/worker/config.ts`
- Modify: `src/worker/domain/signer.ts`
- Modify: `src/worker/services/environmentPolicy.ts`
- Modify: `src/worker/services/wompiApi.ts`
- Modify: `scripts/private-wrangler-config.mjs`
- Modify: `test/worker/config.test.ts`
- Modify: `test/worker/signer.test.ts`
- Modify: `test/worker/wompiApi.test.ts`
- Modify: `test/scripts/privateWranglerConfig.test.ts`
- Modify only if assertions require it: `test/scripts/productionProvisioningDocs.test.ts`

### Steps

1. Add failing tests that:
   - reject production shared mock mode at runtime;
   - reject a production private manifest with shared mock enabled or omitted;
   - prove missing/mismatched/inactive/unimportable MH signing material and missing matching MH credentials/endpoints make `createPaymentLink` fail before `fetch`;
   - reject hostile/malformed link response values while accepting the known Wompi hosted-link shapes.
2. Run the focused tests and record the expected failures.
3. Extract a signer readiness check that performs the same active/password/private-key validation used by signing without producing or persisting a fiscal document.
4. Add one fiscal-collection readiness function using deployment policy, issuer config, matching MH lane endpoints/credentials, and signer readiness. Call it in the non-mock branch before token acquisition.
5. Make the shared mock gate throw when `APP_ENV=production`.
6. Extend private target-manifest validation so production requires `MOCK_EXTERNAL_SERVICES === "false"`.
7. Parse Wompi link responses from `unknown`; enforce positive safe ID, HTTPS, no userinfo/fragment/alternate port, exact hosts, and approved path/query shapes. Throw `WompiApiError` without returning an untrusted URL.
8. Run:

```sh
npx vitest run test/worker/config.test.ts test/worker/signer.test.ts test/worker/wompiApi.test.ts test/scripts/privateWranglerConfig.test.ts
```

9. Commit with a message scoped to the provider/fiscal gate.

## Task 2: Include local PDF artifacts in the private boundary

**Review comment:** 3.

**Files:**

- Modify: `scripts/check-private-boundary.mjs`
- Modify: `test/scripts/privateBoundary.test.ts`
- Modify only if absent: `.gitignore`

### Steps

1. Add `tmp/pdfs/donor-render.pdf` to the synthetic failing table and to ignore-alignment coverage. Assert the checker reports only the path, not contents.
2. Run `npx vitest run test/scripts/privateBoundary.test.ts` and observe failure.
3. Add a recursive `collectTree("tmp/pdfs")` boundary check. Preserve the current symlink/non-directory behavior.
4. Mutation-prove the guard by temporarily removing the new collection call, observing the new test fail, and restoring it.
5. Run the focused test and `npm run security:check-private-boundary`.
6. Commit without deleting any artifact.

## Task 3: Add non-locking account step-up MFA after distributed failures

**Review comment:** 4.

**Files:**

- Create: `migrations/0045_login_step_up_mfa.sql`
- Modify: `src/worker/types.ts`
- Modify: `src/worker/services/auth.ts`
- Modify: `src/worker/services/email.ts` and the smallest existing template surface it requires
- Modify: `src/worker/storage/repository/rateLimits.ts`
- Modify: `src/worker/storage/repository/users.ts` or the existing user/session repository module
- Modify: `src/worker/storage/repository.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/worker/routes/apiRoutes.ts` if route registration is separate
- Modify: `src/client/App.tsx`
- Modify: `test/worker/support/inMemoryD1.ts`
- Modify: `test/worker/workerFetch.auth-infra.test.ts`
- Add or modify a focused client login test

### Steps

1. Write failing worker tests for six account failures across distinct IPs followed by:
   - correct credentials returning a verification challenge and no token/session;
   - one-time code completion returning the session;
   - wrong/expired/replayed codes failing and attempts being bounded;
   - email delivery failure creating no usable session;
   - a normal below-threshold login remaining unchanged.
2. Add a failing client behavior test for rendering and submitting the verification-code step in Spanish.
3. Run focused tests and capture red results.
4. Append migration 0045 with a short-lived login step-up challenge table. Store only random continuation/code hashes, auth-generation/credential binding, expiry, attempt count, and consumption state. Add expiry indexes.
5. Split credential verification from session creation inside `AuthService` so the challenged path can prove the password without minting a token. Preserve the existing constant-work missing/disabled-account behavior.
6. Count `LOGIN_FAILED` by normalized account identifier across IPs. Below threshold, keep the current path. At/above threshold, a correct password creates the bounded challenge, sends the code through the existing email integration, and returns only a challenge handle.
7. Add an atomic completion method that consumes a correct challenge once, rechecks auth generation/current credentials, and then creates the session. Bound wrong code attempts and clean expired challenges during the existing scheduled security cleanup.
8. Update the client login panel to support the code step without disclosing whether an arbitrary account exists.
9. Run focused worker/client tests, then `npm run build`.
10. Commit migration and code together.

## Task 4: Bound provider creation globally and normalize IPv6 rate identities

**Review comment:** 8.

**Files:**

- Create: `migrations/0046_provider_creation_budgets.sql`
- Modify: `src/worker/services/donations.ts`
- Modify: `src/worker/storage/repository/rateLimits.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `src/worker/index.ts`
- Modify: `test/worker/support/inMemoryD1.ts`
- Modify: `test/worker/workerFetch.donation-intents.test.ts`
- Modify: `test/worker/stripeRoutes.test.ts`
- Modify: `test/worker/workerFetch.auth-infra.test.ts`
- Modify: `scripts/check-migration-immutability.mjs`
- Modify: `test/scripts/migrationImmutability.test.ts`
- Mirror migration-frontier docs in: `README.md`, `README.es.md`
- Modify relevant provisioning/migration tests.

### Steps

1. Add failing repository/route tests for:
   - IPv6 textual variants and addresses in one /64 sharing the client ceiling;
   - distinct IPs exhausting Wompi provider, Stripe provider, and shared global ceilings;
   - atomic concurrent claims never exceeding a ceiling;
   - Stripe request-id replay consuming no second claim;
   - unused claims being releasable and expired claims being swept.
2. Run focused tests and record red.
3. Append migration 0046 with a provider creation claim table, CHECKed provider discriminator, timestamps/expiry, and indexes for client, provider, and global window counts.
4. Add a strict IP rate-identity normalizer: canonical IPv4, IPv6 /64, otherwise unknown. Keep raw audit/source IP handling separate.
5. Implement one atomic claim statement checking client, provider, and global counts. Use fixed, documented constants chosen above ordinary traffic and below provider/storage exhaustion.
6. Call it before new Wompi and fresh Stripe state/provider creation. Keep existing idempotent replay and release semantics.
7. Extend cleanup and in-memory/SQLite test support.
8. Pin only new migrations 0045 and 0046 in the immutability map and update the frontier assertions/docs in both languages.
9. Run focused tests, `npm run migrations:check-immutability`, and `npm run build`.
10. Commit.

## Task 5: Distinguish Wompi replay from collision

**Review comment:** 5.

**Files:**

- Modify: `src/worker/storage/repository/wompiIssuance.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `src/worker/index.ts`
- Modify: `test/worker/support/inMemoryD1.ts`
- Modify: `test/worker/workerFetch.advanced-cde-webhook.test.ts`
- Modify if reconciliation coverage belongs there: `test/worker/workerFetch.donation-correlation-deferred.test.ts`

### Steps

1. Add failing end-to-end webhook tests for collisions in environment, result, amount, payment-link/intent, and normalized body. Each must prove no paid marker and no queue send. Retain and strengthen the legitimate alternate-transaction/payment-link replay test.
2. Run focused tests and observe the false-paid/queue behavior.
3. Replace the boolean insertion result with an explicit discriminated result: inserted, equivalent replay, conflict.
4. Canonicalize stored and incoming normalized payloads and compare every security-relevant field. Permit alternate transaction IDs only for an otherwise equivalent payment-link event.
5. In ingestion, use the payload reconstructed from `record.raw_body` for all replay environment, paid-marker, and queue decisions.
6. Audit conflicts with bounded field names/reasons only and return a conflict response; do not overwrite canonical storage.
7. Run focused tests and `npm run build`.
8. Commit.

## Task 6: Sanitize MH response evidence and anchor backup verification

This plan keeps two review comments as two independently reviewed commits; execute 6A before 6B.

### Task 6A: Sanitize MH authentication and reception responses

**Review comment:** 6.

**Files:**

- Modify: `src/worker/services/mhClient.ts`
- Modify: `test/worker/mhClient.test.ts`
- Modify only for durable sink proof: `test/worker/pipeline.issuance.test.ts`

#### Steps

1. Add failing tests whose MH auth/reception responses echo the configured username, password, and bearer token in status, description, observations, nested raw fields, and plain-text fallback. Assert no exact secret appears in errors or returned/persisted JSON.
2. Run the focused tests and capture red.
3. Replace auth body-bearing errors with status-only bounded constants and discard token-missing descriptions.
4. Add a boundary sanitizer that recursively replaces every configured exact secret inside strings before deriving estado, observaciones, raw, errors, or metadata. Keep fiscal verdict parsing on sanitized structure.
5. Run `npx vitest run test/worker/mhClient.test.ts test/worker/pipeline.issuance.test.ts` and `npm run build`.
6. Commit.

### Task 6B: Require exact backup manifest and live D1 anchor

**Review comment:** 7.

**Files:**

- Modify: `src/worker/services/retention.ts`
- Modify: `src/worker/services/backups.ts`
- Modify: `src/worker/storage/repository/audit.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `test/worker/support/inMemoryD1.ts`
- Modify: `test/worker/retention.test.ts`
- Modify: `test/worker/workerFetch.retention-admin.test.ts`
- Modify: `docs/retention-restore.md`

#### Steps

1. Replace the existing partial-manifest success fixture with failing tests for empty, partial, extra, malformed, wrong-month/run/key/hash/count, no-anchor, anchor mismatch, and forged manifest plus matching forged bodies.
2. Add a valid exact-manifest plus D1-anchor happy path and run tests red.
3. Centralize the canonical table list and a strict `unknown -> RetentionManifest` parser. Require version 2 and exact run-scoped keys.
4. Add a narrow repository query for the live D1 `RETENTION_EXPORT_COMPLETED` anchor and parse its metadata defensively.
5. Before object hashing, compare the exact manifest table map to the anchor. Treat any failure as a verification failure with audit and alert, never a vacuous success.
6. Include runId, generatedAt, exact tables, total rows, and canonical manifest digest in new completion evidence; support existing correct anchors through exact table-map comparison.
7. Reuse strict parsing in list/table/download helpers so invalid manifests are not reported as archived.
8. Update the restore runbook and run focused tests plus build.
9. Commit.

## Task 7: Enforce the account audit audience before query

**Review comment:** 9.

**Files:**

- Modify: `src/worker/index.ts`
- Modify if a projection helper is cleaner: `src/worker/services/auditProjection.ts`
- Modify: `test/worker/workerFetch.audit-context-branding-analytics.test.ts`
- Modify the contingency-focused test file containing role fixtures.

### Steps

1. Add a failing chained test: VIEWER fetches contingency, extracts `created_by`, and scopes `/api/audit?entityType=user&entityId=...`.
2. Add ADMIN/OWNER preservation tests and run focused tests red.
3. Reject user-scoped filters before repository lookup for VIEWER/OPERATOR.
4. Project contingency events by role and omit `created_by` for VIEWER/OPERATOR.
5. Run focused tests and build.
6. Commit.

## Task 8: Emit HSTS on every production response

**Review comment:** 10.

**Files:**

- Modify: `public/_headers`
- Modify: `src/worker/index.ts`
- Modify: `test/worker/workerFetch.infra.test.ts`

### Steps

1. Add failing tests for production health JSON, asset HTML, redirect, webhook/API error, and 204 response headers. Assert the exact conservative value and absence of includeSubDomains/preload.
2. Run focused tests red.
3. Add the static header and one outer production response wrapper so every fetch return path is covered without duplicating route logic.
4. Mutation-prove at least the error/204 path by removing the wrapper temporarily, observing failure, then restoring.
5. Run focused tests and build.
6. Commit.

## Task 9: Whole-branch verification and review

**Files:** No planned product changes. Fix only validated review findings through the SDD fix loop.

### Steps

1. Run focused suites from Tasks 1-8.
2. Run:

```sh
MINIFLARE_CACHE_DIR=<external-temp> npm test
npm run build
npm run security:check-private-boundary
npm run migrations:check-immutability
```

3. Inspect `git diff --check`, `git status --short`, and the complete merge-base diff.
4. Generate the SDD review package and dispatch a fresh whole-branch reviewer on the most capable model.
5. Resolve all load-bearing findings with the bounded SDD fix loop; record non-load-bearing rulings in the ledger.
6. Remove only this plan's ignored SDD workspace after clean review.
7. Use `superpowers:finishing-a-development-branch` and present its exact three-option handoff menu. Do not merge, push, deploy, or create a PR without the user's explicit choice.
