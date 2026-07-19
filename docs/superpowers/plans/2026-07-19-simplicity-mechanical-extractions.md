# Simplicity Mechanical Extractions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pure-relocation refactors: extract the InMemoryD1 SQL emulator and shared test infrastructure out of workerFetch.test.ts, consolidate duplicated test shims and fixture builders, and move App.tsx's three self-contained UI clusters into their own files — zero behavior change anywhere.

**Architecture:** Every task is a move-and-import refactor. The only allowed source edits are import/export statements and relocation; runtime behavior, test coverage, and rendered output must be byte-identical. The client's source-grep tests (19 files read App.tsx via `readFileSync`) must be re-pointed at the new file locations as code moves.

**Tech Stack:** TypeScript, React 19, Vitest.

## Global Constraints

- Base: `main` at `3dd2e63b4318324bd19c12a7203bfe3ef7715c84`. Work in your isolated worktree branch. **Never push. Never deploy. Never run wrangler against remote.** The controller integrates.
- ZERO behavior change. If a task tempts you to "improve" logic while moving it, don't — note it in your report instead.
- Full gates after each task: `MINIFLARE_CACHE_DIR=/private/tmp/diezmos-miniflare-tests npm test`, `npm run typecheck`, `npm run build`, `npm run types:check`, `git diff --check` — check REAL exit codes. Test count must be IDENTICAL before and after every task (1450 passed / 1 skipped at base).
- Small logical commits (`refactor:`), each ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- A parallel agent is doing helper-dedup and small fixes on another branch, also touching App.tsx and workerFetch.test.ts. The controller resolves conflicts — keep moves clean and atomic (one cluster per commit) to make that tractable.

---

### Task 1: Extract InMemoryD1 + Statement + test env into `test/worker/support/`

**Files:**
- Create: `test/worker/support/inMemoryD1.ts`
- Modify: `test/worker/workerFetch.test.ts` (lines ~18421–22717 hold the inline infra: helpers, `env`, `class InMemoryD1` at `:18617`, `class Statement` at `:18816`, `sqliteD1` at `:18595`, builders `testDocument` at `:22524`, `emisorConfig` at `:22683`)

**Interfaces — Produces (exact re-exports the monofile will import):**
```ts
export class InMemoryD1 { /* moved verbatim */ }
export function makeEnv(overrides?: Partial<Env>): Env; // whatever the current inline env builder is named — preserve its name
export function authedDb(role: "VIEWER" | "OPERATOR" | "ADMIN" | "OWNER", db: InMemoryD1): InMemoryD1; // new thin helper: sets db.sessionUser = { id: `user_${role}`, email: `${role}@example.org`, name: role, role }
```

- [ ] **Step 1: Read lines 18421–22717 and inventory every top-level declaration** (classes, functions, consts) and which are referenced above line 18421.
- [ ] **Step 2: Move the inventory verbatim** into `test/worker/support/inMemoryD1.ts` with `export` added; `import` them in workerFetch.test.ts. Keep `testDocument`/`emisorConfig` in the monofile for now (Task 3 handles builders) UNLESS they're pure — if pure, move them too and re-export.
- [ ] **Step 3: Add `authedDb`** (exact shape above) and replace the three templated copies (`correctionDb` at `:888`, `authed` at `:17372` and `:17586`) with it. Leave the 156 inline `db.sessionUser = {...}` literals alone.
- [ ] **Step 4: Full gates. Test count identical. Commit** `refactor: extract InMemoryD1 test harness to test/worker/support`.

### Task 2: One SQLite→D1 shim

**Files:**
- Create: `test/worker/support/sqliteD1.ts` (adopt the most complete implementation — `class SqliteD1` from `test/worker/repositoryFiscalSql.test.ts:4411`, which supports `first/run/all/raw`)
- Modify: `test/worker/repositoryFiscalSql.test.ts:4411`, `test/worker/wompiIssuanceSchema.test.ts:700`, and the copy moved in Task 1 (delete `sqliteD1` from `support/inMemoryD1.ts` in favor of this module)

- [ ] **Step 1: Diff the three implementations** to confirm the fullest superset; note any per-file quirks (e.g., first()-only usage).
- [ ] **Step 2: Move the superset to the support module; import everywhere; delete the two remaining local copies.**
- [ ] **Step 3: Full gates. Test count identical. Commit** `refactor: single sqlite-to-D1 test shim`.

### Task 3: Shared migration loader + fixture builders

**Files:**
- Create: `test/worker/support/migratedDatabase.ts` (the `readdirSync(migrations).filter(/^\d{4}_/).sort()` + exec loop from `test/worker/repositoryFiscalSql.test.ts:4474`)
- Modify: `test/worker/repositoryFiscalSql.test.ts:4474`, `test/migrations/fiscalOperationsMigration.test.ts:341`, plus the ad-hoc loops in `test/worker/retention.test.ts` and `test/worker/wompiIssuanceSchema.test.ts`
- Modify: `test/worker/fixtures.ts` (grow it: `makeDocument(overrides?: Partial<DteDocumentRecord>): DteDocumentRecord`, `makeIntent(overrides?: Partial<DonationIntentRecord>): DonationIntentRecord`; keep the existing `emisorConfig` export as the single copy)
- Modify (adopt builders): `test/worker/workerFetch.test.ts:22524` (`testDocument`), `test/worker/pdf.test.ts:357`, `test/worker/certificate.test.ts:315` (`dteRecord`), `test/worker/emailTemplates.test.ts:13` (`fakeRecord`), `test/worker/invalidationWindow.test.ts:44`, `test/worker/donationIntentBinding.test.ts:88`, `test/worker/donationIntents.test.ts:286`, `test/worker/fiscalCorrection.test.ts:94`; delete workerFetch's private `emisorConfig` (`:22683`) in favor of the shared one.

- [ ] **Step 1: Write `makeDocument`/`makeIntent`** with defaults chosen so every adopting file expresses its current fixture as `makeDocument({ ...only its diffs })`. Derive defaults from the most common field values across the eight existing builders.
- [ ] **Step 2: Migrate one file at a time, running that file's tests after each** (`npm test -- test/worker/<file>`). Assertions must not change.
- [ ] **Step 3: Extract `migratedDatabase()` and adopt in the four files.**
- [ ] **Step 4: Full gates. Test count identical. Commit** `refactor: shared test fixtures and migration loader`.

### Task 4: Extract App.tsx credentials cluster

**Files:**
- Create: `src/client/credentialsPanel.tsx`
- Modify: `src/client/App.tsx:2637-4033` (move `CredentialsPanel`, `BrandingEditor`, `EmailTemplateEditor`, `IssuerConfigEditor`, `EmissionEnvironmentConfirmDialog`, `CredentialFieldLabel`, `CredentialActiveValue`)
- Modify: every `test/client/*.test.ts` whose `readFileSync` grep targets code that moved (find with `grep -l "App.tsx" test/client/`)

- [ ] **Step 1: Identify the cluster's imports** (icons, helpers, types) and its exports consumed by `App()` (just `<CredentialsPanel …/>` most likely). Move lines 2637–4033 verbatim; add imports/exports.
- [ ] **Step 2: Re-point source-grep tests.** For each client test that greps App.tsx for strings now living in credentialsPanel.tsx, update the `readFileSync` path. Do not weaken any assertion.
- [ ] **Step 3: Full gates + `npm test -- test/client`. Test count identical. Commit** `refactor: extract credentials panel from App.tsx`.

### Task 5: Extract App.tsx exports/backups cluster

**Files:**
- Create: `src/client/exportsPanel.tsx`
- Modify: `src/client/App.tsx:1980-2636` (move `ExportPanel`, `DatePickerCalendar`, `F960PreviewTable`, `AnnualCertificatePanel`, `ContactsExportPanel`, `OnlineDonationsPanel`, `BackupsPanel`)
- Modify: affected source-grep tests (same procedure as Task 4 — `backupsUi.test.ts` is a known one)

- [ ] **Step 1–3: Same procedure as Task 4.** Commit `refactor: extract exports panel from App.tsx`.

### Task 6: Extract App.tsx documents-view cluster

**Files:**
- Create: `src/client/documentsView.tsx`
- Modify: `src/client/App.tsx:4532-5138` (move `PreCdeFailuresPanel`, `Stats`, `Metric`, `DocumentTable`, `DocumentListFooter`, `StackedCell`, `DetailPanel`, `InvalidationConfirmDialog`)
- Modify: affected source-grep tests

- [ ] **Step 1–3: Same procedure as Task 4.** Note: `DetailPanel` has ~19 props — move it AS-IS; do not regroup props (that's future work, not this plan). Commit `refactor: extract documents view from App.tsx`.

---

**Final deliverable:** all six tasks committed on the worktree branch, gates green at tip with the test count identical to base (1450/1), App.tsx reduced by roughly 2,700 lines, and a summary report: commits, final App.tsx/workerFetch.test.ts line counts, every source-grep test re-pointed, and any tempting-but-skipped improvements noted for future plans.
