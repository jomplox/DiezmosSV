# Security Audit Remediation Implementation Plan

> **For Codex:** Execute this plan task-by-task with test-driven development. Preserve the immutable migration history and do not deploy staging or production.

**Goal:** Close the seven validated security-review findings at commit `768c75df82f4883dee1bfb8630b696f10a2f79a7` with observable regression tests, mutation proof, and exact-release verification.

**Architecture:** Strengthen the existing request boundaries instead of adding parallel security systems. Public JSON mutations are rejected before any rate-limit claim. Stripe Billing Portal access gains an independently issued, checkout-bound HttpOnly capability plus atomic application rate limiting. Private operational commands gain a target manifest and exact-SHA/CI/worktree gate. Existing credential-bearing helpers validate target identity before sending credentials and reject redirects. Migration history remains append-only; the new portal columns are introduced by migration `0044`, and every applied migration is pinned by the immutability guard.

**Tech Stack:** TypeScript, React, Cloudflare Workers/D1, Vitest, Playwright, Node.js release scripts, Wrangler, Stripe SDK.

---

## Task 1: Reject unsafe public mutations before consuming rate limits

**Files:**
- Modify: `src/worker/index.ts`
- Modify: `test/worker/workerFetch.auth-infra.test.ts`
- Modify: `test/worker/workerFetch.donation-intents.test.ts`

1. Add failing route tests proving cross-site or non-JSON login, bootstrap-owner, and donation-data requests do not create rate-limit claims.
2. Add a failing bootstrap test proving a missing bootstrap token is rejected before a claim, while an invalid non-empty same-origin attempt still consumes its intended budget.
3. Apply the existing public JSON mutation boundary before rate limiting in all three handlers.
4. Run focused tests, temporarily move one boundary check after the claim to prove the guard fails, restore, and rerun.

## Task 2: Require staging credentials to live outside the repository

**Files:**
- Modify: `scripts/staging-smoke.mjs`
- Modify: `scripts/assert-private-env-file.mjs`
- Modify: `test/scripts/stagingSmoke.test.ts`
- Modify: `test/scripts/privateEnvFiles.test.ts`

1. Add failing tests for relative credential paths and absolute or symlink-resolved paths inside the repository.
2. Preserve local development behavior by making the outside-repository policy explicit to staging smoke only.
3. Accept only an absolute, owner-only, non-symlinked credential file whose real path is outside the repository.
4. Mutation-check the repository containment check and run both focused suites.

## Task 3: Extend migration immutability and append the portal schema

**Files:**
- Create: `migrations/0044_stripe_portal_capability.sql`
- Modify: `scripts/check-migration-immutability.mjs`
- Modify: `test/scripts/migrationImmutability.test.ts`
- Modify: `test/worker/stripeMigration.test.ts`

1. Add failing immutability tests for mutating migration `0043`, duplicating an existing numeric prefix, and accepting only the next unique prefix.
2. Add failing schema-upgrade tests for the portal capability hash, expiry, and revocation columns.
3. Append migration `0044`; do not edit migrations `0001` through `0043`.
4. Pin every migration through `0044`, reject duplicate prefixes across the entire directory, and retain next-migration development support.
5. Mutation-check both the newest hash and duplicate-prefix rejection; run migration, D1 preflight, and compatibility suites.

## Task 4: Bind Stripe Billing Portal access to an independent capability and rate limits

**Files:**
- Modify: `src/worker/index.ts`
- Modify: `src/worker/storage/repository/stripeDonations.ts`
- Modify: `src/worker/storage/repository/rateLimits.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `test/worker/stripeRoutes.test.ts`
- Modify: focused repository/fake-D1 tests as required by the existing test seams

1. Add failing tests proving a paid Checkout Session ID alone cannot create a portal session.
2. Add failing tests for missing, invalid, expired, revoked, and cross-checkout capabilities.
3. Add failing tests for per-IP, per-customer, and aggregate rolling portal limits, including a different-IP bypass attempt and expiry recovery.
4. On monthly checkout creation or safe replay, generate a 256-bit capability, persist only its SHA-256 hash and expiry, and deliver it as a session-bound `HttpOnly; SameSite=Strict` cookie scoped to the portal route.
5. Authorize portal creation by atomically matching checkout, hash, expiry, and revocation state before calling Stripe.
6. Claim application limits atomically before the Stripe portal API call; return a generic public response without leaking authorization state.
7. Mutation-check the independent capability and customer-wide limiter; run focused Worker/repository/browser contracts.

## Task 5: Pin credential-bearing helpers to exact trusted targets

**Files:**
- Modify: `scripts/runtime-branding-logo.mjs`
- Modify: `scripts/staging-smoke.mjs`
- Modify: `src/worker/index.ts`
- Modify: `src/worker/services/credentials.ts`
- Modify: `test/scripts/runtimeBrandingLogo.test.ts`
- Modify: `test/scripts/stagingSmoke.test.ts`
- Modify: focused credential route/service tests

1. Add failing tests proving credentials are never sent after a redirect or to a target whose health identity does not match the configured environment and Worker name.
2. Add the Worker name to `/api/health` without exposing secrets.
3. Require staging smoke and runtime branding to verify exact origin, environment, and Worker identity before authentication; use `redirect: "error"` on every credential-bearing request.
4. Lock the Cloudflare secret writer to `https://api.cloudflare.com/client/v4` and reject redirects or any base-URL override.
5. Mutation-check redirect and identity enforcement; run focused script/Worker tests.

## Task 6: Bind releases to an exact SHA, CI result, and resource manifest

**Files:**
- Create: `scripts/assert-release-provenance.mjs`
- Modify: `scripts/private-deploy-config.mjs`
- Modify: `scripts/private-deploy-config.d.mts`
- Modify: `scripts/private-wrangler-config.mjs`
- Modify: `scripts/run-private-build.mjs`
- Modify: `scripts/run-private-wrangler.mjs`
- Modify: `package.json`
- Modify: `test/scripts/privateDeployConfig.test.ts`
- Modify: `test/scripts/privateWranglerConfig.test.ts`
- Modify: `test/scripts/privateBuildConfig.test.ts`
- Modify: `test/scripts/deployScripts.test.ts`
- Create or modify focused provenance tests
- Mirror documentation changes in `README.md` and `README.es.md` if operator instructions change

1. Add failing tests for missing/mismatched approved SHA, tracked worktree changes, pending/failed/missing CI, mismatched Worker/D1/R2/queue/account/app identifiers, and resource reuse between staging and production.
2. Extend the private deploy configuration to describe the exact reviewed target manifest without logging values.
3. Compare the effective private Wrangler configuration to that manifest before builds, migrations, deploys, tails, or other privileged remote commands.
4. Require `DIEZMOSSV_APPROVED_SHA`, a clean tracked worktree, and successful GitHub checks for that exact SHA.
5. Integrate the provenance gate into the real command paths rather than package-source assertions alone.
6. Mutation-check SHA and one resource binding; run all private build/deploy/wrangler/documentation suites.

## Task 7: Integrated security verification

**Files:**
- Review all files changed by Tasks 1–6

1. Run each focused suite and its documented mutation proof.
2. Run `npm test`, `npm run build`, migration immutability, D1 migration preflight, private-boundary checks, and `git diff --check`.
3. Inspect the exact base-to-head diff for secret disclosure, authorization bypass, unsafe redirects, stale test doubles, or accidental live-environment changes.
4. Confirm staging and production were not mutated.
5. Record exact commit/SHA, remaining operational prerequisites, and rollback boundaries; do not merge, push, or deploy without a separate instruction.
