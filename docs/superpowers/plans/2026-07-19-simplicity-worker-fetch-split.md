# Simplicity Worker Fetch Test Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 18,432-line `test/worker/workerFetch.test.ts` monofile with nineteen domain test files while preserving all 46 top-level descriptions, all 513 executed tests, every test name/assertion, and all per-test global cleanup.

**Architecture:** Move whole top-level `describe` blocks verbatim into domain files, one domain file per commit. Keep `workerFetch.test.ts` as a shrinking shell through Task 18 and delete it only in Task 19. Extract only genuinely cross-file helpers into focused `test/worker/support/` modules when the first second consumer appears. Every domain file explicitly registers the shared crypto/mock lifecycle through `installWorkerFetchGlobals()` so Vitest file isolation cannot make tests order-dependent.

**Tech Stack:** TypeScript, Vitest, Cloudflare Worker test doubles, Node's built-in SQLite.

## Global Constraints

- Prerequisite: route-table and repository-split plans are complete and reviewed on `codex/simplicity-large-splits`.
- Staging-only development scope. Never deploy or mutate production. Do not push or deploy during these tasks.
- Starting monofile invariant: 46 top-level `describe`s and 513 executed tests.
- Expected full-suite invariant: 1,480 passed / 2 skipped. No task adds, deletes, renames, skips, or rewrites a test.
- Move every `describe`, `it`, and `it.each` as a complete syntactic unit; preserve order within each `describe`.
- Preserve all assertions and test names byte-for-byte. Import rewrites and helper relocation are the only allowed edits.
- Each test file calls `installWorkerFetchGlobals()` exactly once. Do not depend on side-effect-only import caching.
- Keep helper state local unless two target files truly consume it. Do not create a catch-all fixture module.
- Keep the two correlation/deferred `seedIntentRow`/`seedWompiEvent` pairs local and separate during the move; their defaults differ. Record deduplication as a follow-up, not part of this behavior-preserving split.
- After every task, aggregate workerFetch tests must remain exactly 513:

```bash
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmos-worker-split-aggregate npm test -- test/worker/workerFetch*.test.ts
```

- Full gates after every task:

```bash
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmos-worker-split-full npm test
rtk npm run typecheck
rtk npm run build
rtk env WRANGLER_LOG_PATH=/private/tmp/diezmos-worker-split-wrangler.log npm run types:check
rtk git diff --check
rtk git status --short --branch
```

- The pre-existing Vite `>500 kB` chunk warning is non-blocking; new warnings are not.

---

### Task 1: Infrastructure and global test lifecycle

**Files:**
- Create: `test/worker/support/workerFetchGlobals.ts`
- Create: `test/worker/workerFetch.infra.test.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `Worker fetch error handling` — 2 tests
- `Worker non-fetch handler error containment` — 2 tests
- `static document security policy` — 2 tests
- Domain total: 6 tests

- [ ] **Step 1: Extract the global lifecycle**

Move `nativeCrypto` and `TestDigestStream` into the support module. Export:

```ts
export function installWorkerFetchGlobals(): void {
  beforeEach(() => {
    vi.stubGlobal("crypto", {
      ...nativeCrypto,
      subtle: nativeCrypto.subtle,
      getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto),
      randomUUID: nativeCrypto.randomUUID.bind(nativeCrypto),
      DigestStream: TestDigestStream
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
}
```

Call `installWorkerFetchGlobals()` once in the new infra file and once in the shrinking shell.

- [ ] **Step 2: Move the three complete descriptions**

Import only `describe`, `expect`, `it`, `worker`, `Env`, and dependencies actually referenced by these six tests.

- [ ] **Step 3: Verify**

```bash
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmos-worker-split-1-focused npm test -- test/worker/workerFetch.infra.test.ts
```

Expected: 6/6. Run the aggregate invariant (513/513) and full gates (1,480/2).

- [ ] **Step 4: Commit**

```bash
rtk git add test/worker/support/workerFetchGlobals.ts test/worker/workerFetch.infra.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split worker fetch infrastructure tests"
```

### Task 2: Wompi issuance recovery tests

**Files:**
- Create: `test/worker/workerFetch.wompi-issuance-recovery.test.ts`
- Create: `test/worker/support/wompiEventFixtures.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `Wompi document identifier reservation` — 7 tests
- `Wompi issuance failure recovery API` — 9 tests after the merged dead-path deletion
- Domain total: 16 tests

- [ ] **Step 1: Move both descriptions verbatim**

Register global hooks. Move `wompiEventForReservation` into `support/wompiEventFixtures.ts` because later fiscal/queue/sweep files also consume it; preserve all defaults.

- [ ] **Step 2: Verify**

Run the new file (16/16), aggregate workerFetch tests (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.wompi-issuance-recovery.test.ts test/worker/support/wompiEventFixtures.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split Wompi issuance recovery tests"
```

### Task 3: Guarded fiscal-correction tests

**Files:**
- Create: `test/worker/workerFetch.fiscal-correction.test.ts`
- Create: `test/worker/support/dteFixtures.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `guarded fiscal correction API` — 63 tests

- [ ] **Step 1: Move the one complete description**

Do not split its reservation/receptor/production/recovery subsections. Register hooks; import shared Wompi fixtures from Task 2. Move only DTE fixture helpers with later cross-file consumers into `support/dteFixtures.ts`.

- [ ] **Step 2: Verify**

Run the new file (63/63), aggregate (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.fiscal-correction.test.ts test/worker/support/dteFixtures.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split guarded fiscal correction tests"
```

### Task 4: Request and authentication infrastructure tests

**Files:**
- Create: `test/worker/workerFetch.auth-infra.test.ts`
- Create: `test/worker/support/workerFetchRequests.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `request body limits` — 5
- `document route authorization order` — 2
- `owner bootstrap` — 9
- `auth rate limiting` — 17
- `session logout` — 1
- `credential-current session issuance` — 8
- Domain total: 42 tests

- [ ] **Step 1: Move the six descriptions verbatim**

Register hooks. Move `bootstrapRequest`, `executionContextCapturing`, and `fetchAndWaitUntil` into the request support module when cross-file usage is confirmed. Keep bootstrap token constants local.

- [ ] **Step 2: Verify**

Run the new file (42/42), aggregate (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.auth-infra.test.ts test/worker/support/workerFetchRequests.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split worker authentication infrastructure tests"
```

### Task 5: Donation-intent tests

**Files:**
- Create: `test/worker/workerFetch.donation-intents.test.ts`
- Create: `test/worker/support/userFixtures.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `donation intents` — 60 tests

- [ ] **Step 1: Move the description verbatim**

Register hooks. Move `seededUserLifecycleDb` to `support/userFixtures.ts` because password-reset and user-administration files also consume it. Preserve row defaults and timestamps.

- [ ] **Step 2: Verify**

Run the new file (60/60), aggregate (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.donation-intents.test.ts test/worker/support/userFixtures.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split donation intent route tests"
```

### Task 6: Password-reset tests

**Files:**
- Create: `test/worker/workerFetch.password-reset.test.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `password reset` — 20 tests

- [ ] **Step 1: Move the description verbatim**

Register hooks and import `seededUserLifecycleDb` from Task 5. Keep password-reset-only tokens/helpers local.

- [ ] **Step 2: Verify**

Run the new file (20/20), aggregate (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.password-reset.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split password reset route tests"
```

### Task 7: Document read-model tests

**Files:**
- Create: `test/worker/workerFetch.document-reads.test.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `document listing` — 2
- `online donation intents listing` — 2
- `document detail donor-data-verified flag` — 4
- Domain total: 8 tests

- [ ] **Step 1: Move all three descriptions verbatim**

Register hooks. Keep read-model-only fixtures local; import shared DTE/user fixtures only when already extracted.

- [ ] **Step 2: Verify**

Run the new file (8/8), aggregate (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.document-reads.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split document read route tests"
```

### Task 8: User-administration tests

**Files:**
- Create: `test/worker/workerFetch.user-administration.test.ts`
- Create: `test/worker/support/documentDeliveryFixtures.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `user administration` — 19 tests

- [ ] **Step 1: Move the description verbatim**

Register hooks and import `seededUserLifecycleDb`. Move `emailResendDb` and `resendDocument` to `support/documentDeliveryFixtures.ts` because Task 9 also consumes them.

- [ ] **Step 2: Verify**

Run the new file (19/19), aggregate (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.user-administration.test.ts test/worker/support/documentDeliveryFixtures.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split user administration route tests"
```

### Task 9: Document delivery and retry tests

**Files:**
- Create: `test/worker/workerFetch.document-delivery.test.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `document email resend` — 20
- `document contact email` — 2
- `document JSON download` — 1
- `document retry` — 6
- Domain total: 29 tests

- [ ] **Step 1: Move the four descriptions verbatim**

Register hooks; import the delivery fixtures from Task 8. Keep `TEST_RESEND_REQUEST_ID` in this file.

- [ ] **Step 2: Verify**

Run the new file (29/29), aggregate (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.document-delivery.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split document delivery route tests"
```

### Task 10: Contingency and invalidation tests

**Files:**
- Create: `test/worker/workerFetch.contingency-invalidation.test.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `contingency history (read-only)` — 3
- `document invalidation` — 12
- Domain total: 15 tests

- [ ] **Step 1: Move both descriptions verbatim**

Register hooks. Import only the signing, MH, email, document, and environment helpers these tests use.

- [ ] **Step 2: Verify**

Run the new file (15/15), aggregate (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.contingency-invalidation.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split contingency and invalidation tests"
```

### Task 11: Export tests

**Files:**
- Create: `test/worker/workerFetch.exports.test.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `F960 CSV export` — 5
- `CRM contacts export` — 8
- Domain total: 13 tests

- [ ] **Step 1: Move both descriptions verbatim**

Register hooks. Keep export-only fixtures local and preserve all CSV text assertions byte-for-byte.

- [ ] **Step 2: Verify**

Run the new file (13/13), aggregate (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.exports.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split export route tests"
```

### Task 12: Annual-certificate tests

**Files:**
- Create: `test/worker/workerFetch.annual-certificates.test.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `annual donor certificates` — 11 tests

- [ ] **Step 1: Move the description verbatim**

Register hooks. Keep Node temp-file/`execFileSync` dependencies and certificate-only XML fixtures in this file.

- [ ] **Step 2: Verify**

Run the new file (11/11), aggregate (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.annual-certificates.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split annual certificate route tests"
```

### Task 13: Advanced CDE and Wompi webhook tests

**Files:**
- Create: `test/worker/workerFetch.advanced-cde-webhook.test.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `advanced CDE generation` — 17
- `Wompi webhook integration` — 13
- Domain total: 30 tests

- [ ] **Step 1: Move both descriptions verbatim**

Register hooks. Import `wompiSample` only here and reuse shared DTE fixtures without changing defaults.

- [ ] **Step 2: Verify**

Run the new file (30/30), aggregate (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.advanced-cde-webhook.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split advanced CDE and Wompi webhook tests"
```

### Task 14: Donation correlation and deferred-transmission tests

**Files:**
- Create: `test/worker/workerFetch.donation-correlation-deferred.test.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `donation intent correlation` — 39
- `deferred transmission when MH is unavailable` — 15
- Domain total: 54 tests

- [ ] **Step 1: Move both descriptions verbatim**

Register hooks. Keep both local `seedIntentRow`/`seedWompiEvent` pairs separate: correlation includes `datos_token_hash: null`, deferred omits it, and their default IDs differ.

- [ ] **Step 2: Verify**

Run the new file (54/54), aggregate (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.donation-correlation-deferred.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split correlation and deferred transmission tests"
```

### Task 15: Audit, alert, queue, and transmission-claim tests

**Files:**
- Create: `test/worker/workerFetch.audit-alerts-queue.test.ts`
- Create: `test/worker/support/workerFetchHelpers.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `audit pagination` — 1
- `pipeline failure alerts` — 6
- `advanced DTE queue idempotency` — 18
- `DTE transmission claim` — 3
- Domain total: 28 tests

- [ ] **Step 1: Move all four descriptions verbatim**

Register hooks. Move the existing `jsonResponse`, `signWompiBody`, and `sha256Hex` helpers to the focused support module and update every already-moved consumer to import the exact helper; preserve their bodies and signatures.

- [ ] **Step 2: Verify**

Run the new file (28/28), aggregate (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.audit-alerts-queue.test.ts test/worker/support/workerFetchHelpers.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split audit alert and queue tests"
```

### Task 16: Sweep, cron, and certificate-expiry tests

**Files:**
- Create: `test/worker/workerFetch.sweep-cron-cert-expiry.test.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `issuance dead-letter and stalled-event sweep` — 18
- `scheduled cron dispatch` — 3
- `certificate expiry alerts (15-minute cron)` — 6
- Domain total: 27 tests

- [ ] **Step 1: Move all three descriptions verbatim**

Register hooks. Keep `queuedNoop`, `certXmlWithExpiry`, and `stalledWompiEventFixture` local unless an existing extracted module is already a genuine second consumer.

- [ ] **Step 2: Verify**

Run the new file (27/27), aggregate (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.sweep-cron-cert-expiry.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split sweep cron and certificate expiry tests"
```

### Task 17: Credential and settings tests

**Files:**
- Create: `test/worker/workerFetch.admin-settings.test.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `credential administration` — 5
- `email template settings` — 1
- `alert email setting` — 7
- Domain total: 13 tests

- [ ] **Step 1: Move all three descriptions verbatim**

Register hooks. Keep credential-token and settings fixtures local; preserve secret and PII redaction assertions.

- [ ] **Step 2: Verify**

Run the new file (13/13), aggregate (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.admin-settings.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split credential and settings route tests"
```

### Task 18: Retention administration tests

**Files:**
- Create: `test/worker/workerFetch.retention-admin.test.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Moves:**
- `manual retention export endpoint` — 5
- `admin backups panel` — 12
- Domain total: 17 tests

- [ ] **Step 1: Move both descriptions verbatim**

Register hooks. Keep `FakeArchiveBucket`, ZIP/NDJSON, and month/table fixtures scoped to this file.

- [ ] **Step 2: Verify**

Run the new file (17/17), aggregate (513/513), and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add test/worker/workerFetch.retention-admin.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "refactor: split retention administration tests"
```

### Task 19: Audit-context, branding, and analytics tests; delete shell

**Files:**
- Create: `test/worker/workerFetch.audit-context-branding-analytics.test.ts`
- Delete: `test/worker/workerFetch.test.ts`

**Moves:**
- `audit actor context` — 9
- `branding` — 20
- `analytics endpoint (Wompi lane)` — 13
- Domain total: 42 tests

- [ ] **Step 1: Move the final three descriptions verbatim**

Register hooks. Keep analytics byte-cap constants and analytics-only builders local. Import request helpers only when used.

- [ ] **Step 2: Prove the shell is empty, then delete it**

Before deletion, confirm it contains no `describe`, `it`, helper, or import that is not present in a destination/support file.

- [ ] **Step 3: Verify final split**

Run the new file (42/42), aggregate workerFetch files (19 files, 513/513), and full gates (expected 100 test files, 1,480 passed / 2 skipped).

- [ ] **Step 4: Commit**

```bash
rtk git add test/worker/workerFetch.audit-context-branding-analytics.test.ts
rtk git rm test/worker/workerFetch.test.ts
rtk git commit -m "refactor: complete worker fetch test split"
```

---

**Final deliverable:** nineteen reviewed commits; nineteen `workerFetch.*.test.ts` domain files; 46 descriptions and 513 executed workerFetch tests preserved; 100 full-suite files with 1,480 passed / 2 skipped; no production or deployment action. The duplicate correlation/deferred builders remain a documented follow-up.
