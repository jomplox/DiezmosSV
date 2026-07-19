# Simplicity Quick Wins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the confirmed-dead legacy rejected-Wompi cluster, consolidate seven duplicated helpers into shared modules (fixing three user-visible defects in the process), fix the OWNER role option leak, correct the stale README cutover step, and widen typecheck coverage to all test directories.

**Architecture:** Behavior-preserving cleanup except where a task names an explicit fix (DUI formatting in certificates, money-format unification, OWNER option gating). New shared homes: `src/shared/email.ts`, `src/shared/money.ts`, `src/shared/documentFormat.ts`; worker-only helpers go to `src/worker/utils/`.

**Tech Stack:** TypeScript, Cloudflare Workers, React 19, Vitest.

## Global Constraints

- Base: `main` at `3dd2e63b4318324bd19c12a7203bfe3ef7715c84`. Work in your isolated worktree branch. **Never push. Never deploy. Never run wrangler against remote.** The controller integrates.
- TDD for every new helper (superpowers:test-driven-development). Mechanical deletions are verified by the full gates instead.
- Full gates after each task: `MINIFLARE_CACHE_DIR=/private/tmp/diezmos-miniflare-tests npm test`, `npm run typecheck`, `npm run build`, `npm run types:check`, `git diff --check` — check REAL exit codes, never pipe-to-tail-and-trust.
- User-facing copy is Spanish (usted). Code comments follow existing file style.
- NEVER alter the semantics of fiscal claim/lease/idempotency/audit machinery.
- Small logical commits, message style `refactor:`/`fix:`/`docs:`, each ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- A parallel agent is extracting App.tsx clusters and workerFetch.test.ts infrastructure on another branch. Expect merge conflicts to be resolved by the controller — keep your diffs minimal and localized.

---

### Task 1: Delete the dead legacy rejected-Wompi cluster

**Files:**
- Modify: `src/worker/services/pipeline.ts:1126-1238` (delete `rebuildRejectedWompiDocument`)
- Modify: `src/worker/storage/repository.ts:3473-3526` (delete `claimRejectedWompiRetry` and `prepareClaimedRejectedWompiRebuild`)
- Modify: `test/worker/workerFetch.test.ts` (delete the ~7 tests/references that exercise only this path)

- [ ] **Step 1: Re-verify unreachability yourself.** Run `grep -rn "rebuildRejectedWompiDocument\|claimRejectedWompiRetry\|prepareClaimedRejectedWompiRebuild" src/ test/`. Expected: definitions in the two src files, references only in `test/worker/workerFetch.test.ts`. If ANY other src/ caller appears, STOP and report instead of deleting.
- [ ] **Step 2: Delete the pipeline method, the two repository methods, and any imports/types that become unused** (run `npm run typecheck` to find them).
- [ ] **Step 3: Delete the workerFetch tests that exist only to pin the dead path.** Identify them by their use of `rebuildRejectedWompiDocument` or the two repo methods. Do not delete tests that also assert live behavior — split them if needed.
- [ ] **Step 4: Run full gates.** Expected: suite passes with a lower test count, everything else green.
- [ ] **Step 5: Commit** `refactor: delete unreachable legacy rejected-Wompi retry path`.

### Task 2: Shared email validation

**Files:**
- Create: `src/shared/email.ts`
- Test: `test/shared/email.test.ts` (create; mirror test/shared conventions if the dir exists, else `test/worker/sharedEmail.test.ts`)
- Modify: `src/shared/fiscalCorrection.ts:97`, `src/worker/config.ts:66`, `src/worker/index.ts:2205`, `src/worker/services/alerts.ts:9`, `src/worker/services/branding.ts:44`, `src/client/branding.ts:27`, `src/client/App.tsx:5475`

**Interfaces — Produces:**
```ts
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(value: string): boolean;
```

- [ ] **Step 1: Write failing tests** for `isValidEmail`: accepts `legacy-email-101@example.com`, rejects empty, spaces, missing `@`, missing TLD dot.
- [ ] **Step 2: Run to verify failure** (module does not exist).
- [ ] **Step 3: Implement `src/shared/email.ts`** exactly as the interface above.
- [ ] **Step 4: Replace all seven duplicate regex sites** with imports. Keep each site's surrounding behavior identical (some test `.test(x)`, some use the pattern in a constant — adapt minimally).
- [ ] **Step 5: Full gates. Commit** `refactor: single shared email validator`.

### Task 3: Shared money formatter (fixes the separators inconsistency)

**Files:**
- Create: `src/shared/money.ts`
- Test: `test/shared/money.test.ts` (or `test/worker/sharedMoney.test.ts`)
- Modify (named helpers): `src/client/App.tsx:5574` (`formatMoneyCents`), `src/client/analytics.ts:19` (`formatCentsUsd`), `src/client/donation.ts:71`, `src/worker/services/emailTemplates.ts:195`, `src/worker/services/emailHtml.ts:266`, `src/worker/services/f960.ts:234`
- Modify (inline `$${(x/100).toFixed(2)}`): `src/client/App.tsx:1600,1640,4579,4707`, `src/client/preCdeFailures.ts:41`, `src/worker/services/contacts.ts:215`, `src/worker/services/certificate.ts:175`

**Canonical format decision (locked):** `formatCents(123456) === "$1,234.56"` — US-style decimals WITH thousands separators, always two decimals. This changes rendered output for amounts ≥ $1,000 in tables, emails, and PDFs; update any test expectations accordingly (search tests for `$` literals near amounts).

**Interfaces — Produces:**
```ts
export function formatCents(amountCents: number): string; // "$1,234.56"
```

- [ ] **Step 1: Failing tests**: `formatCents(2550) === "$25.50"`, `formatCents(123456) === "$1,234.56"`, `formatCents(0) === "$0.00"`.
- [ ] **Step 2: Verify RED. Step 3: Implement** with `Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })` or manual grouping — must match the three assertions exactly.
- [ ] **Step 4: Replace every listed site.** Delete the now-empty local helpers. `f960.ts:234` accepts `string|number` — keep a thin local adapter there if the CSV contract needs it, importing the shared core.
- [ ] **Step 5: Full gates** (expect and fix a handful of test-expectation updates for ≥$1,000 amounts). **Commit** `refactor: single money formatter with separators everywhere`.

### Task 4: Shared fiscal document formatter (fixes DUI bug in constancias)

**Files:**
- Create: `src/shared/documentFormat.ts` (move the FULL implementation from `src/worker/services/pdf.ts:479`)
- Test: `test/shared/documentFormat.test.ts` (or worker-side equivalent)
- Modify: `src/worker/services/pdf.ts:479` (import shared), `src/worker/services/certificate.ts:346` (replace the NIT-only copy — this is the bug fix)

- [ ] **Step 1: Failing tests**: 14-digit NIT gets NIT dashes; 9-digit DUI formats as `########-#`; values with letters pass through unchanged; empty string passes through.
- [ ] **Step 2: RED. Step 3: Move pdf.ts's implementation** into the shared module (byte-equivalent logic), import in pdf.ts.
- [ ] **Step 4: Switch certificate.ts to the shared formatter.** Check `test/worker/certificate.test.ts` for expectations pinning the old (broken) NIT-only behavior and correct them.
- [ ] **Step 5: Full gates. Commit** `fix: constancia PDFs format DUIs correctly via shared document formatter`.

### Task 5: Consolidate El Salvador timezone/date helpers

**Files:**
- Modify: `src/shared/legalWindows.ts` (export `EL_SALVADOR_TIME_ZONE`; add/absorb a `elSalvadorDateOnly(iso): string` helper implemented with `Intl.DateTimeFormat` + `America/El_Salvador`)
- Modify: `src/worker/utils/dates.ts:3`, `src/worker/services/contacts.ts:5,260`, `src/worker/services/retention.ts:16`, `src/worker/services/certificate.ts:15`, `src/worker/services/emailHtml.ts:270` (import the shared constant/helpers; delete local copies)
- Modify: `src/worker/index.ts:1819` (replace the naive fixed `-6h` date computation with the Intl-based shared helper)

- [ ] **Step 1: Failing test** for the shared `elSalvadorDateOnly` (a UTC instant late on day N renders as day N-1's or N's ES date correctly — pick a 03:00Z boundary case).
- [ ] **Step 2: RED. Step 3: Implement in legalWindows.ts.** Do NOT touch `analytics.ts` bucketing keys — they are deliberately separate.
- [ ] **Step 4: Migrate each listed site**; delete local constants. index.ts:1819 must produce identical output for all-hours inputs (add a test if one doesn't exist).
- [ ] **Step 5: Full gates. Commit** `refactor: one El Salvador timezone source; drop naive offset math`.

### Task 6: Worker micro-utils dedup (isRecord, uuid-v4, onlyDigits, sha256Hex)

**Files:**
- Create: `src/worker/utils/guards.ts` (`isRecord`, `onlyDigits`, `UUID_V4_PATTERN`, `normalizeUuidV4(value: unknown): string | null` — lowercase-normalizing, per index.ts:2604 semantics)
- Modify: `src/worker/index.ts:2167,2213,2607`, `src/worker/domain/wompi.ts:182`, `src/worker/domain/dteBuilder.ts:572`, `src/worker/services/emailTemplates.ts:214`, `src/worker/services/email.ts:576`, `src/worker/services/requestContext.ts:59`, `src/worker/services/stagingSmoke.ts:3`, `src/worker/services/pdf.ts:494`, `src/worker/services/certificate.ts:347`, `src/worker/services/f960.ts:130`, `src/worker/services/fiscalCorrection.ts:164-165`
- Modify: `src/worker/services/auth.ts:277` (delete private `sha256Hex`; import from `src/worker/utils/encoding.ts:35` wrapping input with `utf8Bytes`)

- [ ] **Step 1: Failing tests** for `normalizeUuidV4` (valid lowercase passes, uppercase normalizes, v1 uuid rejected, garbage rejected) and `onlyDigits`.
- [ ] **Step 2: RED. Step 3: Implement guards.ts. Step 4: Migrate all sites**, deleting local copies. `normalizeResendRequestId`/`normalizeCorrectionRequestId` in index.ts become thin calls to `normalizeUuidV4`.
- [ ] **Step 5: Full gates. Commit** `refactor: shared worker guards and digest helper`.

### Task 7: OWNER role option leak + role options dedup

**Files:**
- Modify: `src/client/App.tsx:5300-5305` (UserSettingsModal) and `:5396-5401` (UserCreateForm)

- [ ] **Step 1: Define once near the user components:**
```tsx
const ASSIGNABLE_ROLES: Array<{ value: Role; label: string }> = [
  { value: "VIEWER", label: "Consulta" },
  { value: "OPERATOR", label: "Operador" },
  { value: "ADMIN", label: "Administrador" },
  { value: "OWNER", label: "Propietario" }
];
function roleOptionsFor(actor: { role: Role }): Array<{ value: Role; label: string }> {
  return actor.role === "OWNER" ? ASSIGNABLE_ROLES : ASSIGNABLE_ROLES.filter((r) => r.value !== "OWNER");
}
```
(Adopt the file's existing Spanish labels verbatim — read the current `<option>` labels first and reuse them exactly.)
- [ ] **Step 2: Failing test.** `test/client/` uses source-grep tests (see `backupsUi.test.ts:29` style). Add `test/client/roleOptions.test.ts` that imports `roleOptionsFor` (export it) and asserts: ADMIN actor never receives OWNER; OWNER actor does. RED because the helper doesn't exist.
- [ ] **Step 3: Implement + replace both hardcoded `<option>` lists** with a map over `roleOptionsFor(currentUser)`. Fix the tab-indentation to the file's 2-space style while replacing those exact lines only.
- [ ] **Step 4: Full gates. Commit** `fix: hide OWNER role option from non-owner admins`.

### Task 8: README production step + typecheck widening

**Files:**
- Modify: `README.md:345-351` (production cutover step 1)
- Modify: `tsconfig.json` (include `test/client`, `test/scripts`, `test/migrations` — or add them to the worker project if DOM types conflict; the requirement is that `npm run typecheck` compiles ALL test directories)

- [ ] **Step 1: Rewrite README production step 1** to state the resources (D1 `diezmossv-production-resource-example`, both queues, R2 `diezmossv-production-archive-example`) were provisioned 2026-07-05 and the ids are already in `wrangler.toml`; replace the `create` commands with a verification command (`npx wrangler d1 list`, `npx wrangler queues list`, `npx wrangler r2 bucket list`). Keep the secrets step unchanged.
- [ ] **Step 2: Widen typecheck.** Add the missing test dirs to the appropriate tsconfig `include`s. Run `npm run typecheck`; fix every surfaced type error in test files (expected: a handful; fix them properly, no `any` blankets, no `@ts-ignore`).
- [ ] **Step 3: Full gates. Commit** `docs: correct production provisioning step; chore: typecheck all test directories`.

---

**Final deliverable:** all eight tasks committed on the worktree branch, full gates green at the branch tip, and a summary report: commits made, test-count delta, every behavior change (money format, DUI fix, OWNER gating), and anything discovered that contradicts this plan.
