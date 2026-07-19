# Simplicity Repository Facade Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 5,774-line `Repository` implementation into twelve storage-domain modules while preserving `new Repository(db, auditContext?)`, every prototype method, every SQL statement, and every caller.

**Architecture:** `src/worker/storage/repository.ts` remains the compatibility facade. Each public prototype method becomes an explicit wrapper around a plain function in `src/worker/storage/repository/*.ts`; no `Object.assign`, arrow-field methods, mixin mutation, factory, or caller-side sub-repository is allowed. When one repository method currently calls another, the domain function receives a narrow host interface and calls the facade method so existing `vi.spyOn(Repository.prototype, ...)` seams continue to work. Domain-private SQL helpers stay with their domain.

**Tech Stack:** TypeScript, Cloudflare D1, Vitest, Node's built-in SQLite test adapter.

## Global Constraints

- Prerequisite: the route-table plan is complete and reviewed on `codex/simplicity-large-splits`.
- Staging-only development scope. Never deploy or mutate production. Do not push or deploy during these tasks.
- Zero call-site diffs outside `src/worker/storage/**`.
- Preserve the public import surface of `src/worker/storage/repository.ts`, including types, constants, errors, `legacyIssuanceAttemptId`, and `Repository`.
- Preserve all method names, parameter order, return types, thrown errors, and ordinary prototype placement.
- Preserve SQL text semantically and preserve every `.bind(...)` value/order, conditional predicate, `RETURNING`, unique/idempotency key, timestamp evaluation point, and `db.batch` statement order.
- Never introduce a fresh `Repository`, fresh ID, fresh timestamp, or sequential-await replacement inside a moved state machine.
- Keep fiscal claim/lease/audit behavior exact. Any changed `claimed`/`busy`/`terminal` result, audit row, identifier, delivery classification, or post-accept state is a regression.
- Keep `ContactSourceRow` a type-only storage dependency; do not create a runtime services↔storage cycle.
- The expected full count after the route plan is 1,480 passed / 2 skipped. Repository tasks add no tests and must preserve that count.
- Full gates after every task:

```bash
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmos-repository-split-full npm test
rtk npm run typecheck
rtk npm run build
rtk env WRANGLER_LOG_PATH=/private/tmp/diezmos-repository-split-wrangler.log npm run types:check
rtk git diff --check
rtk git status --short --branch
```

- The pre-existing Vite `>500 kB` chunk warning is non-blocking; new warnings are not.

---

### Task 1: Shared storage extraction foundation

**Files:**
- Create: `src/worker/storage/shared.ts`
- Modify: `src/worker/storage/repository.ts`

**Interfaces:**
- Produces only domain-neutral types/helpers used by two or more future modules.
- Domain-specific helpers remain in `repository.ts` until their owning task moves them.
- `repository.ts` remains the sole public compatibility import.

- [ ] **Step 1: Inventory module-private declarations and consumers**

Classify the existing top-level declarations into: compatibility types/constants, fiscal helpers, delivery helpers, Wompi helpers, retention helpers, DTE search helpers, and domain-neutral storage helpers. Do not move a helper used by only one future module into `shared.ts`.

- [ ] **Step 2: Move only genuinely shared declarations**

At minimum, define the narrow host pattern used by cross-method modules:

```ts
export type RepositoryHost<TRepository, TMethod extends keyof TRepository> =
  Pick<TRepository, TMethod>;
```

If TypeScript inference is clearer without this alias, use explicit per-module `Pick<Repository, "...">` types instead and leave `shared.ts` limited to shared row/cursor helpers. Do not re-export `nowIso`, `newId`, or JSON utilities merely to add an indirection; they already have canonical utility homes.

- [ ] **Step 3: Verify**

Run `typecheck`, `git diff --check`, then full gates. Expected: 1,480 passed / 2 skipped.

- [ ] **Step 4: Commit**

```bash
rtk git add src/worker/storage/shared.ts src/worker/storage/repository.ts
rtk git commit -m "refactor: establish shared repository extraction support"
```

### Task 2: Settings seam

**Files:**
- Create: `src/worker/storage/repository/settings.ts`
- Modify: `src/worker/storage/repository.ts`
- Test: `test/worker/workerFetch.test.ts`

**Methods:**
- `getSetting`
- `setSetting`

**Interfaces:**

```ts
export function getSetting(db: D1Database, key: string): Promise<string | null>;
export function setSetting(
  db: D1Database,
  key: string,
  value: string,
  updatedBy?: string | null
): Promise<void>;
```

- [ ] **Step 1: Move both bodies mechanically**

Replace `this.db` with the `db` parameter only. Keep the UPSERT and single `nowIso()` evaluation exact.

- [ ] **Step 2: Add explicit facade wrappers**

```ts
async getSetting(key: string): Promise<string | null> {
  return getSetting(this.db, key);
}
```

Keep wrappers on `Repository.prototype`.

- [ ] **Step 3: Verify**

Run the admin-settings/branding portions of `workerFetch.test.ts`, then full gates (1,480/2).

- [ ] **Step 4: Commit**

```bash
rtk git add src/worker/storage/repository/settings.ts src/worker/storage/repository.ts
rtk git commit -m "refactor: extract repository settings seam"
```

### Task 3: Wompi intake and issuance seam

**Files:**
- Create: `src/worker/storage/repository/wompiIssuance.ts`
- Modify: `src/worker/storage/repository.ts`
- Test: `test/worker/wompiIssuanceSchema.test.ts`
- Test: `test/worker/wompiEventsSchema.test.ts`
- Test: `test/worker/repositoryFiscalSql.test.ts`
- Test: `test/worker/issuanceFailure.test.ts`

**Methods:**
- Intake: `insertWompiEvent`, `getWompiEventById`, `getWompiEventByTransaction`
- Claims/read models: `claimWompiEventIssuance`, `claimCorrectedWompiEventIssuance`, `releaseWompiEventIssuance`, `listWompiIssuanceFailures`, `getWompiIssuanceFailureById`, `getWompiIssuanceRetrySnapshotById`
- Attempts: `claimInitialWompiIssuanceAttempt`, `claimWompiIssuanceRetry`, `claimStalledWompiIssuanceAttempt`, `createWompiAttemptAudit`
- Reservation/lifecycle: `reserveWompiDocumentIdentifiers`, `markWompiIssuanceProcessing`, `recordWompiIssuanceFailure`, `markWompiIssuanceDeadLettered`, `markWompiIssuanceIgnored`
- Compatibility: `legacyIssuanceAttemptId`

**Interfaces:**
- Keep Wompi failure columns, retry constants, and reservation validation module-private unless currently exported.
- `insertWompiEvent` and reservation functions receive a narrow host for their existing calls to `getWompiEventByTransaction`/`getWompiEventById`.

```ts
type WompiHost = Pick<Repository,
  "getWompiEventById" | "getWompiEventByTransaction"
>;
```

- [ ] **Step 1: Move the listed declarations without reformatting SQL**

Use `host.getWompiEventByTransaction(...)` and `host.getWompiEventById(...)` where the class currently uses `this.*`; do not bypass facade spies.

- [ ] **Step 2: Write explicit facade wrappers and re-exports**

All current imports from `repository.ts` stay valid.

- [ ] **Step 3: Verify**

Run the four named focused files, then full gates (1,480/2).

- [ ] **Step 4: Commit**

```bash
rtk git add src/worker/storage/repository/wompiIssuance.ts src/worker/storage/repository.ts
rtk git commit -m "refactor: extract repository Wompi issuance seam"
```

### Task 4: Donation-intent seam

**Files:**
- Create: `src/worker/storage/repository/donationIntents.ts`
- Modify: `src/worker/storage/repository.ts`
- Test: `test/worker/donationIntents.test.ts`
- Test: `test/worker/donationIntentBinding.test.ts`
- Test: `test/worker/workerFetch.test.ts`

**Methods:**
- `createDonationIntent`, `getDonationIntent`, `attachIntentLink`, `applyIntentDatosWithCapability`
- `markIntentCompleted`, `completeIntentForPostAcceptOwner`, `markIntentPaid`
- `listIntentsExpiringBefore`, `expireDonationIntentsByIds`, `listRecentDonationIntents`
- `getCompletedIntentForDocument`, `hasAuditAction`

**Interfaces:**
- `createDonationIntent` receives a host containing `getDonationIntent` so the existing read-after-write and prototype seam remain exact.
- Keep `INTENT_EXPIRY_SWEEP_LIMIT` importable from `repository.ts`.

- [ ] **Step 1: Move all methods and intent-specific helpers**

Preserve draft capability CAS rules, locked payment fields, paid/completed/expired guards, document binding, list ordering, and limit behavior.

- [ ] **Step 2: Add facade wrappers and compatibility re-export**

- [ ] **Step 3: Verify**

Run the three named focused files, then full gates (1,480/2).

- [ ] **Step 4: Commit**

```bash
rtk git add src/worker/storage/repository/donationIntents.ts src/worker/storage/repository.ts
rtk git commit -m "refactor: extract repository donation intent seam"
```

### Task 5: DTE document state-machine seam

**Files:**
- Create: `src/worker/storage/repository/dteDocuments.ts`
- Modify: `src/worker/storage/repository.ts`
- Test: `test/worker/repositoryFiscalSql.test.ts`
- Test: `test/worker/workerFetch.test.ts`

**Methods:**
- Create/link: `nextControlSequence`, `createDteDocument`, `createClaimedWompiDteDocument`, `markWompiDocumentCreated`, `markWompiEventProcessed`, `quarantineWompiIntentBinding`
- Core reads/list: `getDteDocument`, `getDteDocumentByWompiEvent`, `listDteDocuments`
- Transmission/invalidation: `updateDocumentSigned`, `updateClaimedDocumentSigned`, `claimDocumentTransmission`, `claimDocumentInvalidation`, `createAndAttachDocumentInvalidationEvent`, `releaseDocumentInvalidationBeforeDispatch`, `completeDocumentInvalidation`, `completeDocumentTransmission`, `markDocumentFailed`, `releaseDocumentFiscalOperation`, `markDocumentTransmissionDeferred`, `listDeferredTransmissionDocuments`
- Post-accept/indexing: `listAcceptedWompiDocumentsMissingFinalization`, `listPendingPostAcceptFinalizations`, `claimDocumentPostAcceptFinalization`, `markDocumentPostAcceptEmailDispatchStarted`, `releaseDocumentPostAcceptFinalization`, `markDocumentPostAcceptFinalized`, `hasSentEmail`, `hasHandledEmail`, `updateDocumentDonorEmail`
- Private helpers: `wompiDocumentCreatedStatement`, `indexDteDocumentById`, `indexDteDocument`, document cursor/search helpers

**Interfaces:**
- Move reader methods assigned to analytics/retention/delivery/fiscal tasks only when those tasks execute; do not duplicate them here.
- Use a narrow host for existing calls to `getDteDocument`, `markWompiDocumentCreated`, and indexing methods.
- Export `indexDteDocument` only as an internal storage-module function for the later fiscal module; it is not re-exported from `repository.ts` and is not a new caller API.

- [ ] **Step 1: Move the complete DTE operational state machine**

Preserve exact fiscal-operation exclusion predicates, sequence allocation, event/document linking, invalidation batch order, transmission ownership, deferred markers, post-accept leases, and index-after-durable-write order.

- [ ] **Step 2: Add facade wrappers**

Every wrapper remains an `async` prototype method with its original signature.

- [ ] **Step 3: Verify**

Run `repositoryFiscalSql.test.ts` and `workerFetch.test.ts` (513 worker tests), then full gates (1,480/2).

- [ ] **Step 4: Commit**

```bash
rtk git add src/worker/storage/repository/dteDocuments.ts src/worker/storage/repository.ts
rtk git commit -m "refactor: extract repository DTE document seam"
```

### Task 6: Generic audit seam

**Files:**
- Create: `src/worker/storage/repository/audit.ts`
- Modify: `src/worker/storage/repository.ts`
- Test: `test/worker/auditProjection.test.ts`
- Test: `test/worker/workerFetch.test.ts`

**Methods:**
- `createAudit`, `ensurePostAcceptAudit`, `createAuditIfAbsent`, `listAudit`, `listAuditPage`

**Interfaces:**
- Audit mutations receive `auditContext?: AuditRequestContext` as an explicit parameter from the facade.
- Keep request-context normalization/serialization and alert-email redaction exact.
- Do not rewrite specialized fiscal/Wompi audit statements to call this module.

- [ ] **Step 1: Move the generic audit methods**

Preserve fixed audit IDs, `ON CONFLICT DO NOTHING`, cursor ordering, actor fields, normalized IP/context, and null context for system callers.

- [ ] **Step 2: Add facade wrappers that pass `this.auditContext`**

- [ ] **Step 3: Verify**

Run `auditProjection.test.ts` and `workerFetch.test.ts`, then full gates (1,480/2).

- [ ] **Step 4: Commit**

```bash
rtk git add src/worker/storage/repository/audit.ts src/worker/storage/repository.ts
rtk git commit -m "refactor: extract repository audit seam"
```

### Task 7: Contingency read seam

**Files:**
- Create: `src/worker/storage/repository/contingency.ts`
- Modify: `src/worker/storage/repository.ts`
- Test: `test/worker/workerFetch.test.ts`

**Methods:**
- `getOpenContingency`, `listContingencyPeriods`, `listContingencyDocuments`
- `listContingencyBatches`, `listContingencyBatchLines`, `listDteEventsByType`

- [ ] **Step 1: Move the six read methods**

Preserve filters, ordering, optional period IDs, and record projection. Add no write API.

- [ ] **Step 2: Add facade wrappers**

- [ ] **Step 3: Verify**

Run the contingency portion of `workerFetch.test.ts`, then full gates (1,480/2).

- [ ] **Step 4: Commit**

```bash
rtk git add src/worker/storage/repository/contingency.ts src/worker/storage/repository.ts
rtk git commit -m "refactor: extract repository contingency seam"
```

### Task 8: Email and operational-alert delivery seam

**Files:**
- Create: `src/worker/storage/repository/deliveries.ts`
- Modify: `src/worker/storage/repository.ts`
- Test: `test/worker/alerts.test.ts`
- Test: `test/worker/workerFetch.test.ts`

**Methods:**
- Receipt state: `getLatestReceiptEmailDelivery`
- Email: `recordEmailDelivery`, `claimEmailDelivery`, `claimManualEmailDelivery`, `markEmailDeliveryDispatchStarted`, `finalizeEmailDeliveryClaim`
- Operational alerts: `claimOperationalAlertDelivery`, `markOperationalAlertDispatchStarted`, `finalizeOperationalAlertDelivery`

**Interfaces:**
- Move `EmailDeliveryOutcomeClass`, `ManualEmailDeliveryClaim`, `OperationalAlertDeliveryClaim`, lease constants, and idempotency-key helpers with the module; re-export their public names from `repository.ts`.
- Do not unify email and alert SQL/result unions.

- [ ] **Step 1: Move delivery functions and helpers**

Preserve stable accepted-receipt keys, manual resend keys, stale lease rules, provider-dispatch marker behavior, manual-review classification, retry safety, and attempt numbering.

- [ ] **Step 2: Add facade wrappers and re-exports**

- [ ] **Step 3: Verify**

Run `alerts.test.ts` and `workerFetch.test.ts`, then full gates (1,480/2).

- [ ] **Step 4: Commit**

```bash
rtk git add src/worker/storage/repository/deliveries.ts src/worker/storage/repository.ts
rtk git commit -m "refactor: extract repository delivery seam"
```

### Task 9: Users, sessions, and password-reset seam

**Files:**
- Create: `src/worker/storage/repository/identity.ts`
- Modify: `src/worker/storage/repository.ts`
- Test: `test/worker/auth.test.ts`
- Test: `test/worker/credentials.test.ts`
- Test: `test/worker/workerFetch.test.ts`

**Methods:**
- Users: `getUserRole`, `listUsers`, `countUsers`, `createInitialOwner`, `createUser`, `getUserForLogin`, `updateUser`
- Sessions: `createSessionIfCredentialsCurrent`, `getSessionUser`, `revokeSession`
- Password reset/change: `createPasswordResetToken`, `invalidatePasswordResetToken`, `getActivePasswordResetUser`, `resetPasswordWithToken`, `setUserPassword`, `updateUserPasswordHashIfCurrent`
- Private error helper: `throwUserMutationFailure`

**Interfaces:**
- Move `OwnerTargetProtectedError` and `UserMutationConflictError` with the module and re-export them from `repository.ts`.
- `updateUser`/`setUserPassword` use a host containing `getUserRole` so existing prototype seams remain.

- [ ] **Step 1: Move identity methods**

Preserve owner protection, optimistic concurrency, credential-current session creation, token single-use, session revocation batch order, and password rehash CAS semantics.

- [ ] **Step 2: Add facade wrappers and re-exports**

- [ ] **Step 3: Verify**

Run the three named focused files, then full gates (1,480/2).

- [ ] **Step 4: Commit**

```bash
rtk git add src/worker/storage/repository/identity.ts src/worker/storage/repository.ts
rtk git commit -m "refactor: extract repository identity seam"
```

### Task 10: Security rate-limit seam

**Files:**
- Create: `src/worker/storage/repository/rateLimits.ts`
- Modify: `src/worker/storage/repository.ts`
- Test: `test/worker/workerFetch.test.ts`

**Methods:**
- `claimDonationIntentRateLimit`, `claimDonationDatosRateLimit`
- `claimPasswordResetBudgets`, `claimLoginAttempt`
- `deleteExpiredLoginRateLimits`, `deleteExpiredSecurityRateLimitClaims`

- [ ] **Step 1: Move all rate-limit methods**

Preserve key granularity, inclusive/exclusive window predicates, thresholds, expiry timestamps, atomic UPSERT/claim behavior, and cleanup tables.

- [ ] **Step 2: Add facade wrappers**

- [ ] **Step 3: Verify**

Run auth-rate-limit, bootstrap, password-reset, and donation-intent portions of `workerFetch.test.ts`, then full gates (1,480/2).

- [ ] **Step 4: Commit**

```bash
rtk git add src/worker/storage/repository/rateLimits.ts src/worker/storage/repository.ts
rtk git commit -m "refactor: extract repository rate-limit seam"
```

### Task 11: Analytics read seam

**Files:**
- Create: `src/worker/storage/repository/analyticsReads.ts`
- Modify: `src/worker/storage/repository.ts`
- Test: `test/worker/analytics.test.ts`
- Test: `test/worker/workerFetch.test.ts`

**Methods:**
- `listWompiLaneDocumentsForAnalytics`
- `listDonationIntentsForAnalytics`
- `listEmailDeliveriesForAnalytics`
- `earliestDteDocumentCreatedAt`

- [ ] **Step 1: Move analytics-only readers**

Preserve environment/date filters, fiscal-operation exclusion, row caps, ordering, and selected columns. Do not move analytics computation into storage.

- [ ] **Step 2: Add facade wrappers**

- [ ] **Step 3: Verify**

Run `analytics.test.ts` and `workerFetch.test.ts`, then full gates (1,480/2).

- [ ] **Step 4: Commit**

```bash
rtk git add src/worker/storage/repository/analyticsReads.ts src/worker/storage/repository.ts
rtk git commit -m "refactor: extract repository analytics read seam"
```

### Task 12: Retention and reporting read seam

**Files:**
- Create: `src/worker/storage/repository/retentionReads.ts`
- Modify: `src/worker/storage/repository.ts`
- Test: `test/worker/retention.test.ts`
- Test: `test/worker/certificate.test.ts`
- Test: `test/worker/contacts.test.ts`

**Methods:**
- Reporting/export: `listAcceptedDteDocumentsForExport`, `listAcceptedDocumentsInYear`, `listAcceptedWompiContactRows`
- Operational readers: `listStalledApprovedWompiEvents`
- Audit counts: `countAuditEntries`, `countAuditEntriesSince`, `countAuditEntriesSinceForIp`
- Retention: `listRowsCreatedBetween`, `listAllRowsPaged`, `listDocumentSequencesPaged`

**Interfaces:**
- Move retention table/cursor types, `RETENTION_PAGE_SIZE`, timestamp-column helper, raw contact row mapper, and sensitive-audit redaction with the module; re-export public names from `repository.ts`.

- [ ] **Step 1: Move reporting and retention readers**

Preserve closed table unions, `received_at` for Wompi snapshots, bounded keyset limits, cursor order, audit redaction, accepted-document filters, and fiscal-operation exclusion.

- [ ] **Step 2: Add facade wrappers and re-exports**

- [ ] **Step 3: Verify**

Run the three named focused files, then full gates (1,480/2).

- [ ] **Step 4: Commit**

```bash
rtk git add src/worker/storage/repository/retentionReads.ts src/worker/storage/repository.ts
rtk git commit -m "refactor: extract repository retention read seam"
```

### Task 13: Fiscal-correction seam and thin-facade cleanup

**Files:**
- Create: `src/worker/storage/repository/fiscalCorrections.ts`
- Modify: `src/worker/storage/repository.ts`
- Test: `test/worker/repositoryFiscalSql.test.ts`
- Test: `test/worker/fiscalCorrection.test.ts`
- Test: `test/worker/workerFetch.test.ts`

**Methods:**
- Claims/read/audit: `claimWompiFiscalCorrection`, `claimDocumentFiscalCorrection`, `getFiscalCorrection`, `getFiscalCorrectionByRequestId`, `createFiscalCorrectionAudit`, `reconcileFiscalCorrectionAudits`, `getActiveFiscalCorrectionForTarget`
- Processing/leases: `claimFiscalCorrectionProcessing`, `markFiscalCorrectionMhDispatchStarted`, `clearFiscalCorrectionMhDispatchStarted`, `reserveFiscalCorrectionDocumentIdentifiers`, `renewFiscalCorrectionDocumentSigningLease`, `prepareClaimedFiscalCorrectionDocument`
- Terminal/recovery: `finalizeDirectFiscalCorrectionGenerationDisabled`, `finalizeFiscalCorrection`, `claimWompiFiscalCorrectionDocument`, `finalizeWompiFiscalCorrectionFailure`, `listRecoverableFiscalCorrections`, `recoverFiscalCorrectionProcessingClaim`
- Private helpers: audit statement builders and `resolveFiscalCorrectionClaim`
- Cross-domain read: `getFailedWompiFiscalCorrectionForDocument`

**Interfaces:**
- Move fiscal claim/input/outcome/audit types and fiscal audit allowlist/summaries with this module; re-export every current public name from `repository.ts`.
- Use a narrow host for existing calls to facade methods such as `getFiscalCorrection`, `getFiscalCorrectionByRequestId`, and `reconcileFiscalCorrectionAudits`. Import the internal `indexDteDocument` function from `dteDocuments.ts` and pass the same injected `db`; never construct a second repository.

- [ ] **Step 1: Move the complete fiscal block as one unit**

Preserve request/payload hash idempotency, one-active-target rules, processing/signing/fiscal/issuance claim IDs, identifier reservations, MH-dispatch evidence, captured snapshot restore, deterministic audit IDs, stale recovery, and every `db.batch` order.

- [ ] **Step 2: Add explicit facade wrappers and clean imports**

`repository.ts` should now contain compatibility types/re-exports, constructor state, and explicit prototype wrappers only. Remove only imports/helpers made unused by these tasks.

- [ ] **Step 3: Verify focused fiscal behavior**

Run all three named files. Expected `workerFetch.test.ts`: 513/513. Then run full gates: 1,480 passed / 2 skipped.

- [ ] **Step 4: Commit**

```bash
rtk git add src/worker/storage/repository/fiscalCorrections.ts src/worker/storage/repository.ts
rtk git commit -m "refactor: complete repository facade split"
```

---

**Final deliverable:** thirteen reviewed move-only commits; twelve domain modules; unchanged `Repository` public/prototype surface; zero call-site diffs outside storage; exact SQL/claim/lease/audit behavior; 1,480 passed / 2 skipped; no production or deployment action.
