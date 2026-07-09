# DiezmosSV Security Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce DiezmosSV security invariants through shared request, authorization, state-transition, correlation, environment, audit, and local-artifact boundaries while preserving current donation and legacy Wompi behavior.

**Architecture:** Add small focused helpers rather than refactoring the whole Worker router. Put irreversible state rules in repository CAS/transaction operations, use a shared Wompi binding service for both paid marking and issuance, and use pure policy/projector modules for environment and audit decisions. Move operational private material outside the checkout and make local tooling consume it directly through Wrangler's `--env-file`.

**Tech Stack:** TypeScript 6, Cloudflare Workers/D1/Queues/R2, React 19, Vitest 4, Wrangler 4, Node.js 22.

## Global Constraints

- Preserve every unrelated change represented by `refs/codex/security-hardening-baseline`; review implementation with `git diff refs/codex/security-hardening-baseline`.
- Never print, commit, log, or place in a URL any secret, private-key material, certificate body, token, donor record, or PII value.
- Add no dependencies.
- Preserve the public `/donar` UX, `{status, paid}` polling response, and raw-webhook legacy static-link issuance.
- Do not deploy production or rotate provider credentials without concrete exposure evidence and a safe provider-specific procedure.
- Every behavior change follows RED, observed expected failure, minimal GREEN, focused rerun, then refactor.
- Do not stage overlapping pre-existing dirty files as a side effect of checkpoints.

---

### Task 1: Shared bounded request bodies and authorization-first document routing

**Files:**
- Modify: `src/worker/utils/http.ts`
- Modify: `src/worker/index.ts`
- Test: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Produces: `RequestBodyTooLargeError`, `InvalidJsonBodyError`, `readBodyBytes`, `readBodyText`, and `readJsonObject` from `src/worker/utils/http.ts`.
- Consumers: all inbound body-reading routes in `src/worker/index.ts`.

- [x] **Step 1: Write focused failing request-limit tests**

Add tests that send a declared body over 16 KiB to login, a streamed body over 64 KiB to the Wompi webhook, and a body over 512 KiB to branding upload. Assert 413, the standard error code, zero auth/HMAC side effects where observable, and zero R2 writes for the logo.

```ts
expect(response.status).toBe(413);
await expect(response.json()).resolves.toMatchObject({ error: "request_body_too_large" });
expect(archive.putCalls).toHaveLength(0);
```

Add strict/tolerant malformed JSON cases and an exact-limit success case.

- [x] **Step 2: Verify RED**

Run:

```bash
rtk npx vitest run test/worker/workerFetch.test.ts -t "request body limits"
```

Expected: the auth/webhook/logo cases fail because they still call unbounded platform readers.

- [x] **Step 3: Implement the body primitives**

Replace `readJson` in `src/worker/utils/http.ts` with this public API:

```ts
export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "RequestBodyTooLargeError";
  }
}

export class InvalidJsonBodyError extends Error {
  constructor() {
    super("Invalid JSON body");
    this.name = "InvalidJsonBodyError";
  }
}

export async function readBodyBytes(request: Request, limitBytes: number): Promise<Uint8Array>;
export async function readBodyText(request: Request, limitBytes: number): Promise<string>;
export async function readJsonObject(
  request: Request,
  options: { limitBytes: number; malformed: "throw" | "empty-object" }
): Promise<Record<string, unknown>>;
```

The byte implementation must check `Content-Length`, count every streamed chunk, throw immediately after `total > limitBytes`, release the reader lock, and concatenate only bounded chunks.

- [x] **Step 4: Convert every inbound body read in the Worker dispatcher**

Use constants:

```ts
const PUBLIC_JSON_BODY_LIMIT_BYTES = 16 * 1024;
const AUTHENTICATED_JSON_BODY_LIMIT_BYTES = 256 * 1024;
const WOMPI_WEBHOOK_BODY_LIMIT_BYTES = 64 * 1024;
```

Use `readBodyText` for Wompi, `readBodyBytes` for logos, and `readJsonObject` for JSON routes. Preserve existing `.catch(() => ({}))` behavior with `malformed: "empty-object"`; use `"throw"` for strict routes. Map size and malformed errors in the top-level Worker catch to 413 and 400 JSON responses.

- [x] **Step 5: Add authorization-order RED cases**

Add existing-id and missing-id cases for anonymous document GET and VIEWER mutation requests. Instrument the in-memory D1 fake with a document lookup counter and assert it remains zero.

```ts
expect(existing.status).toBe(401);
expect(missing.status).toBe(401);
expect(db.documentLookupCount).toBe(0);
```

- [x] **Step 6: Verify authorization RED and implement GREEN**

Run:

```bash
rtk npx vitest run test/worker/workerFetch.test.ts -t "authorizes document routes before lookup"
```

Move `requireRole` ahead of `repo.getDteDocument`. Derive VIEWER versus OPERATOR from method/action without loading the object. Rerun the focused body and document tests, then:

```bash
rtk npx vitest run test/worker/workerFetch.test.ts
```

Expected: all worker-fetch tests pass.

- [x] **Step 7: Record the security-only checkpoint**

Run:

```bash
git diff --check
git diff --stat refs/codex/security-hardening-baseline -- src/worker/utils/http.ts src/worker/index.ts test/worker/workerFetch.test.ts
```

Do not stage the two pre-existing dirty files.

---

### Task 2: Atomic password reset and sibling-token invalidation

**Files:**
- Modify: `src/worker/services/auth.ts`
- Modify: `src/worker/storage/repository.ts`
- Test: `test/worker/auth.test.ts`
- Test: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Produces: `Repository.resetPasswordWithToken(input): Promise<Record<string, string> | null>`.
- Consumes: existing password hashing, `getActivePasswordResetUser`, and D1 `batch()`.

- [x] **Step 1: Write RED sibling-token tests**

Create two reset tokens for one user, complete the first, then assert the second returns `invalid_reset_token`, all sessions are revoked, and every unused token for that user has `used_at` set. Add a race harness that starts two confirmations and asserts exactly one fulfilled result.

- [x] **Step 2: Verify RED**

```bash
rtk npx vitest run test/worker/auth.test.ts test/worker/workerFetch.test.ts -t "invalidates sibling password reset tokens"
```

Expected: the second token still succeeds on current code.

- [x] **Step 3: Implement the transactional repository boundary**

Add:

```ts
async resetPasswordWithToken(input: {
  userId: string;
  tokenHash: string;
  passwordHash: string;
  passwordSalt: string;
  now: string;
}): Promise<boolean>
```

Execute one `db.batch()` containing:

```sql
UPDATE users
SET password_hash = ?, password_salt = ?, updated_at = ?
WHERE id = ?
  AND EXISTS (
    SELECT 1 FROM password_reset_tokens
    WHERE user_id = ? AND token_hash = ? AND used_at IS NULL AND expires_at > ?
  )
```

```sql
UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL
```

```sql
UPDATE password_reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL
```

Return true only when the first result reports one changed user row. Update the in-memory D1 fake so batch execution is atomic for these statements and can simulate a rollback on injected failure.

- [x] **Step 4: Use the boundary from AuthService**

Hash the trimmed raw token once, perform the existing active-token read before PBKDF2, then call `resetPasswordWithToken`. If it returns false, throw the existing `PasswordResetError`. Remove the single-token `markPasswordResetTokenUsed` call from the service path.

- [x] **Step 5: Verify GREEN and failure atomicity**

```bash
rtk npx vitest run test/worker/auth.test.ts test/worker/workerFetch.test.ts -t "password reset"
```

Assert a weak password changes nothing and an injected batch failure changes neither password, sessions, nor tokens.

---

### Task 3: One-time donation datos capability

**Files:**
- Create: `migrations/0017_donation_intents_datos_capability.sql`
- Modify: `src/worker/types.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `src/worker/services/donations.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/client/donarPage.tsx`
- Modify: `src/client/donation.ts`
- Test: `test/worker/donationIntents.test.ts`
- Test: `test/worker/workerFetch.test.ts`
- Test: `test/client/donarPage.test.ts`

**Interfaces:**
- Produces: additive `CreatedIntent.datosToken?: string`, `DonationIntentRecord.datos_token_hash`, and `Repository.applyIntentDatosWithCapability`.
- Uses header constant `X-Donation-Datos-Token` in Worker and client.

- [x] **Step 1: Write RED repository and interface tests**

Assert draft creation stores a 64-character SHA-256 hash rather than the raw token. Add `/datos` tests for missing token, wrong token, valid token, replay, `paid_at`, EXPIRED, COMPLETED, and a full-create intent with no token. The valid case must mutate once and clear the hash.

- [x] **Step 2: Verify RED**

```bash
rtk npx vitest run test/worker/donationIntents.test.ts test/worker/workerFetch.test.ts -t "datos capability"
```

Expected: current path accepts missing/replayed tokens and paid/expired rows.

- [x] **Step 3: Add migration and types**

Migration content:

```sql
ALTER TABLE donation_intents ADD COLUMN datos_token_hash TEXT;
```

Add `datos_token_hash: string | null` to `DonationIntentRecord`. Add `datosToken?: string` to the created-intent response type.

- [x] **Step 4: Generate and store the capability**

In draft creation:

```ts
const datosToken = base64UrlFromBytes(crypto.getRandomValues(new Uint8Array(32)));
const datosTokenHash = await sha256Hex(utf8Bytes(datosToken));
```

Pass the hash into the initial intent INSERT and return `datosToken` only from the draft path. Full creation passes null.

- [x] **Step 5: Implement the atomic CAS write**

Add one `UPDATE ... RETURNING id` that sets donor fields and `datos_token_hash = NULL` while matching id, token hash, `LINK_CREATED`, `paid_at IS NULL`, and `donor_document IS NULL`. `applyIntentDatos` hashes the presented token, invokes the CAS once, returns 404 only after confirming the id is absent, and otherwise throws one generic 409 error.

- [x] **Step 6: Carry the token in client memory and header**

Extend `DonarIntent` with optional `datosToken`. When reusing a draft, send:

```ts
headers: { "X-Donation-Datos-Token": draftIntent.intent.datosToken ?? "" }
```

Never persist it to storage or append it to either Wompi URL. A draft without the additive field is not reusable and falls back to full create.

- [x] **Step 7: Verify GREEN and migration shape**

```bash
rtk npx vitest run test/worker/donationIntents.test.ts test/worker/workerFetch.test.ts test/client/donarPage.test.ts -t "datos|draft"
```

Then apply all migrations to a fresh temporary local D1 state and verify column presence without querying values.

---

### Task 4: Shared strict Wompi binding

**Files:**
- Create: `src/worker/services/donationIntentBinding.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/worker/services/pipeline.ts`
- Test: `test/worker/donationIntentBinding.test.ts`
- Test: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Produces: `resolveDonationIntentBinding(repo, payload): Promise<DonationIntentBinding>`.
- Result union: `{kind:"legacy"}`, `{kind:"bound"; intent: DonationIntentRecord}`, or `{kind:"unbound"; intentId:string; reason:string; expectedLinkId:number|null; payloadLinkId:number|null}`.

- [x] **Step 1: Write RED resolver matrix**

Cover legacy identifiers, canonical commerce identifier, `IdExterno`-only app ids, missing numeric link id, missing stored link id, mismatched numeric link id, disagreeing string ids, ineligible status, and exact match.

- [x] **Step 2: Verify RED**

```bash
rtk npx vitest run test/worker/donationIntentBinding.test.ts
```

Expected: module does not exist.

- [x] **Step 3: Implement the resolver**

Use `payload.EnlacePago?.IdentificadorEnlaceComercio` as canonical. Do not query intents for non-`di_` values. Require exact stored/payload numeric link id and eligible `LINK_CREATED` or `EXPIRED` state. Treat present disagreeing `IdExterno` as unbound.

- [x] **Step 4: Replace paid-marker and pipeline correlation paths**

The synchronous marker calls the resolver and marks paid only for `bound`. The pipeline calls the same resolver, audits `unbound` once, returns the bound intent only when donor data is complete, and otherwise retains raw-webhook fallback. Remove the old `IdExterno ?? ...` resolution and conditional mismatch guard.

- [x] **Step 5: Verify both sinks and compatibility**

```bash
rtk npx vitest run test/worker/donationIntentBinding.test.ts test/worker/workerFetch.test.ts -t "paid_at|correlat|legacy static"
```

Matching bound payloads must mark paid and use intent donor data. Missing/mismatched binding must do neither. Legacy payloads must still issue from raw webhook fields.

---

### Task 5: Deployment environment capability

**Files:**
- Create: `src/worker/services/environmentPolicy.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/worker/services/pipeline.ts`
- Modify: `src/worker/services/mhClient.ts`
- Modify: `src/worker/services/credentials.ts`
- Modify: `src/client/types.ts`
- Modify: `src/client/App.tsx`
- Modify: `wrangler.toml`
- Test: `test/worker/environmentPolicy.test.ts`
- Test: `test/worker/workerFetch.test.ts`
- Test: relevant pipeline and MH client tests selected by `rg -l 'IssuancePipeline|MhClient' test/worker`

**Interfaces:**
- Produces: `deploymentEnvironmentPolicy(env): {appEnv; allowedAmbiente; directGenerationAllowed}` and `assertDeploymentAllowsAmbiente(env, ambiente)`.

- [x] **Step 1: Write RED pure-policy matrix**

Assert local/staging allow only `00`, production allows only `01`, and missing/unknown allow no issuance. Assert production disables direct generation.

- [x] **Step 2: Verify RED and implement the pure module**

```bash
rtk npx vitest run test/worker/environmentPolicy.test.ts
```

Implement the four-row matrix without I/O.

- [x] **Step 3: Write RED boundary integrations**

Add tests proving staging rejects environment-setting `01`, production rejects `00`, staging quick CDE cannot produce `01`, incompatible signed Wompi events are stored/audited but not marked paid or queued, and a manually injected incompatible queue message is rejected before MH/signing side effects.

- [x] **Step 4: Enforce GREEN at every issuance boundary**

Call the shared assertion from environment PUT, quick/advanced generation, webhook enqueue, pipeline processing/retry, invalidation, MH endpoint/credential selection, and credential updates. The GET state response adds:

```ts
locked: true,
allowedEnvironments: [policy.allowedAmbiente]
```

The client disables the impossible option based on this response. Credential POST accepts only `test` in local/staging and only `production` in production.

- [x] **Step 5: Narrow Wrangler variables**

Remove `MH_*_URL_PROD` variables from `[env.staging.vars]` and `MH_*_URL_TEST` variables from `[env.production.vars]`. Keep local TEST and PROD URLs only where existing local tests require both, while the policy still prevents local `01` issuance.

- [x] **Step 6: Verify environment suite**

```bash
rtk npx vitest run test/worker/environmentPolicy.test.ts test/worker/workerFetch.test.ts
```

Run the relevant pipeline/MH client test files returned by the plan's `rg -l` command and require all pass.

---

### Task 6: Audience-aware audit projection

**Files:**
- Create: `src/worker/services/auditProjection.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/worker/storage/repository.ts`
- Test: `test/worker/auditProjection.test.ts`
- Test: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Produces: `projectAuditRows(rows: Array<Record<string, unknown>>, role: Role): Array<Record<string, unknown>>`.

- [x] **Step 1: Write RED four-role policy tests**

For ADMIN/OWNER, assert existing rows are preserved except historical alert-email scrubbing. For VIEWER/OPERATOR, assert actor email/IP/context are null. For user-entity rows also assert actor id/name, target entity id, raw summary, and metadata are not returned; action and timestamp remain.

- [x] **Step 2: Verify RED and implement projector**

```bash
rtk npx vitest run test/worker/auditProjection.test.ts
```

Use a fixed action-to-Spanish-summary map for current user actions, with fallback `Actividad de cuenta registrada`. Emit `metadata_json: "{}"` and null protected identity fields for lower roles.

- [x] **Step 3: Route every audit surface through one projector**

Replace `redactAuditForUser` and route general/scoped audit, document detail audit, and contingency audit through the new service. Keep repository historical alert-email scrub as defense in depth and remove no immutable audit data from storage.

- [x] **Step 4: Verify integration surfaces**

```bash
rtk npx vitest run test/worker/auditProjection.test.ts test/worker/workerFetch.test.ts -t "audit|document detail|contingency"
```

Assert no lower-role response contains seeded account emails or user-update metadata.

---

### Task 7: Out-of-tree private artifacts and repository policy

**Files:**
- Create: `scripts/run-worker-dev.mjs`
- Create: `scripts/check-private-boundary.mjs`
- Create: `docs/local-private-artifacts.md`
- Create: `SECURITY.md`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `playwright.config.ts`
- Modify: `e2e/smoke.spec.ts`
- Modify: `test/worker/mhLive.test.ts`
- Modify: `README.md`
- Test: `test/scripts/privateBoundary.test.ts`

**Interfaces:**
- `DIEZMOSSV_ENV_FILE` selects a Wrangler env file.
- Default local env path: `~/Library/Application Support/DiezmosSV/private/env/local-operator.env`.
- `npm run security:check-private-boundary` exits nonzero when forbidden private files are present.

- [x] **Step 1: Write RED boundary-script tests**

Use a temporary directory fixture containing `.dev.vars`, a Wompi root sample, a DTE credential directory, an F960 CSV, and an ignored DTE document. Assert the checker reports paths only, never contents, and exits nonzero. Assert tracked `.dev.vars.ci`, `.dev.vars.example`, and `examples/wompi-webhook.sample.json` are allowed.

- [x] **Step 2: Verify RED and implement scripts**

```bash
rtk npx vitest run test/scripts/privateBoundary.test.ts
```

`run-worker-dev.mjs` resolves `DIEZMOSSV_ENV_FILE` or the default path, requires an existing regular file, and spawns the local Wrangler CLI with `dev --env-file <path>` plus forwarded arguments. It prints only the selected path.

`check-private-boundary.mjs` checks the exact forbidden path patterns from `SECURITY.md` and outputs path names only.

- [x] **Step 3: Update local and CI consumers**

Set `dev:worker` to the Node runner. Set CI `DIEZMOSSV_ENV_FILE=.dev.vars.ci` and remove the copy-to-`.dev.vars` step. Update Playwright/e2e and `mhLive.test.ts` to resolve the same variable/default without creating backups in the checkout.

- [x] **Step 4: Write security and operations policy**

`SECURITY.md` must contain the shipped-runtime, role, intent capability, Wompi binding, environment, audit, local artifact, disclosure, and rotation policies from the design.

`docs/local-private-artifacts.md` must list the out-of-tree layout, `0700`/`0600` modes, copy-verify-remove procedure, backup/snapshot caveat, rotation triggers, and recovery commands without values.

- [x] **Step 5: Classify and relocate actual ignored artifacts without displaying content**

Create the private root and destination directories at mode `0700`. For each approved source mapping, copy with mode `0600`, verify with `cmp -s`, then remove the source. Move the entire `DTE/Credentials/` tree while preserving live/test subdirectories. Delete the disposable Wrangler account cache rather than archiving it. Do not use shell tracing.

Run:

```bash
rtk npm run security:check-private-boundary
```

Expected: exit 0 and no forbidden paths.

- [x] **Step 6: Determine rotation status without values**

Check tracked/reachable Git history by path, CI artifact/log references by filename, repository sync/backup configuration, and destination custody. Record each class as `rotate`, `contain`, or `no rotation indicated` in the final evidence. Provider rotation remains blocked unless a live secret is proven to have crossed an unintended boundary and a safe provider procedure is available.

- [x] **Step 7: Verify local tooling and docs**

Run the script tests, `npm run dev:worker -- --help` with `DIEZMOSSV_ENV_FILE=.dev.vars.ci`, and `git diff --check`. Do not start a long-lived server.

---

### Task 8: Full validation and security re-check

**Files:**
- Review: every file changed relative to `refs/codex/security-hardening-baseline`
- Update only if a verification failure proves a scoped defect.

**Interfaces:**
- Consumes all prior task outputs.
- Produces a final proof bundle and remaining-risk statement.

- [x] **Step 1: Run focused suites one final time**

```bash
rtk npx vitest run test/worker/donationIntentBinding.test.ts test/worker/environmentPolicy.test.ts test/worker/auditProjection.test.ts test/worker/donationIntents.test.ts test/worker/auth.test.ts test/scripts/privateBoundary.test.ts test/client/donarPage.test.ts test/worker/workerFetch.test.ts
```

- [x] **Step 2: Run full repository gates**

```bash
rtk npm test
rtk npm run typecheck
rtk npm run build
rtk npm audit --json
git diff --check
```

All commands must exit 0. The known Fontconfig warning is environment noise only if Vitest reports zero failed tests.

- [x] **Step 3: Re-check every original source/control/sink**

Use `rg` and direct source inspection to prove:

- no unbounded inbound platform body reader remains in `src/worker/index.ts`;
- document lookup follows authorization;
- `/datos` requires and consumes a separate hashed capability atomically;
- paid marker and issuance use the same strict Wompi binding;
- password reset invalidates all sibling tokens transactionally;
- no incompatible ambiente reaches queue, pipeline, retry, invalidation, or MH client;
- all audit-returning routes use the shared projector;
- no forbidden private artifact remains under the checkout.

- [x] **Step 4: Review only the security delta**

```bash
git diff --stat refs/codex/security-hardening-baseline
git diff --check refs/codex/security-hardening-baseline
```

Dispatch an independent reviewer with the design, plan, baseline ref, focused/full test results, and security-only diff. Fix every Critical or Important issue and rerun its focused tests.

- [x] **Step 5: Complete the goal**

Report exact files changed, commands and counts, how each original issue no longer reproduces, artifact relocation/rotation decisions, deployment work intentionally not performed, and remaining external uncertainty. Mark the durable goal complete only after the final reviewer and all gates pass.
