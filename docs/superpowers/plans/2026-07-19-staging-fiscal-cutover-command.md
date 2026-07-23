# Explicit Staging Fiscal Cutover Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve PR #94's fiscal-cutover acknowledgment for production while moving it off routine staging commands and onto one explicit `cf:cutover:staging` workflow.

**Architecture:** Keep the assertion CLI and its tests from PR #94. Restore only the staging generic remote commands to their pre-PR behavior, add one staging wrapper that runs the guard before migration and deployment, keep production migration and deployment guarded until the approved production cutover is complete, and align the historical cutover document with the staging development state.

**Tech Stack:** Node.js 22+, npm scripts, TypeScript 7, Vitest 4, Wrangler 4.

## Global Constraints

- The project remains in development and staging.
- Do not push, deploy, or perform production/go-live work.
- Do not modify Worker, client, database, routing, repository, or WorkerFetch behavior.
- `FISCAL_CUTOVER_QUIESCED` must be exactly `1` for the explicit cutover command.
- Routine staging `cf:migrate:staging` and `cf:deploy:staging` commands must not require the cutover acknowledgment; production `cf:migrate:prod` and `cf:deploy:prod` must remain guarded until production completes the approved cutover.
- The D1 preflight must remain before every remote migration.
- Preserve the original PR #94 commit in branch history.

---

### Task 1: Scope the fiscal cutover guard to one explicit staging command

**Files:**
- Modify: `test/scripts/deployScripts.test.ts:13-36`
- Modify: `package.json:11-18`
- Modify: `docs/fiscal-claim-cutover.md:1-22`
- Preserve: `scripts/assert-fiscal-cutover.mjs`
- Preserve: `test/scripts/fiscalCutover.test.ts`

**Interfaces:**
- Consumes: `scripts/assert-fiscal-cutover.mjs`, whose CLI exits nonzero unless `process.env.FISCAL_CUTOVER_QUIESCED === "1"`.
- Produces: npm script `cf:cutover:staging`, which runs the guard, `cf:migrate:staging`, and `cf:deploy:staging` in that order.

- [ ] **Step 1: Replace the deploy-script expectations with the approved policy**

In `test/scripts/deployScripts.test.ts`, replace the first two tests inside `describe("remote deploy and migration scripts", ...)` with:

```ts
  it("keeps routine staging scripts free of the one-time cutover guard", () => {
    for (const script of ["cf:migrate:staging", "cf:deploy:staging"] as const) {
      expect(packageJson.scripts[script], `script ${script}`).not.toContain(
        "assert-fiscal-cutover"
      );
      expect(packageJson.scripts[script], `script ${script}`).not.toContain(
        "FISCAL_CUTOVER_QUIESCED"
      );
    }
  });

  it("keeps production migration and deployment guarded", () => {
    for (const script of ["cf:migrate:prod", "cf:deploy:prod"] as const) {
      expect(packageJson.scripts[script], `script ${script}`).toMatch(
        /^node scripts\/assert-fiscal-cutover\.mjs && /
      );
    }
  });

  it("guards the explicit staging cutover before migration and deployment", () => {
    expect(packageJson.scripts["cf:cutover:staging"]).toBe(
      "node scripts/assert-fiscal-cutover.mjs && npm run cf:migrate:staging && npm run cf:deploy:staging"
    );
    expect(
      existsSync(resolve(import.meta.dirname, "../../scripts/assert-fiscal-cutover.mjs"))
    ).toBe(true);
  });

  it("still runs the D1 preflight before every remote migration", () => {
    for (const script of ["cf:migrate:staging", "cf:migrate:prod"] as const) {
      expect(packageJson.scripts[script]).toMatch(
        /^node scripts\/d1-migration-preflight\.mjs .* && wrangler d1 migrations apply /
      );
    }
  });
```

Keep the existing lifecycle-migration backfill test unchanged.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmossv-pr94-red npm test -- test/scripts/deployScripts.test.ts test/scripts/fiscalCutover.test.ts
```

Expected: FAIL because the four routine commands still contain `assert-fiscal-cutover` and `cf:cutover:staging` is undefined. The two assertion-CLI tests must continue passing.

- [ ] **Step 3: Implement the minimal npm-script policy**

In `package.json`, make the remote command block exactly:

```json
    "cf:migrate:staging": "node scripts/d1-migration-preflight.mjs --database diezmossv-staging-resource-example --env staging && wrangler d1 migrations apply diezmossv-staging-resource-example --env staging --remote",
    "cf:deploy:staging": "npm run build && wrangler deploy --env staging --keep-vars",
    "cf:cutover:staging": "node scripts/assert-fiscal-cutover.mjs && npm run cf:migrate:staging && npm run cf:deploy:staging",
    "cf:tail:staging": "wrangler tail --env staging",
    "cf:migrate:prod": "node scripts/assert-fiscal-cutover.mjs && node scripts/d1-migration-preflight.mjs --database diezmossv-production-resource-example --env production && wrangler d1 migrations apply diezmossv-production-resource-example --env production --remote",
    "cf:deploy:prod": "node scripts/assert-fiscal-cutover.mjs && npm run build && wrangler deploy --env production --keep-vars",
    "cf:tail:prod": "wrangler tail --env production",
```

Do not change dependencies or any other script.

- [ ] **Step 4: Align the cutover document with staging development**

Replace the opening record and operator-introduction paragraphs in `docs/fiscal-claim-cutover.md` with:

```md
# Fiscal claim migration cutover

> **Staging record — cutover completed.** Staging already includes migrations
> `0020`/`0021` and the claim-aware Worker. Routine `cf:migrate:staging` and
> `cf:deploy:staging` runs do not require a quiesce acknowledgment.
>
> Use `cf:cutover:staging` only when rebuilding or upgrading a staging environment
> that still must cross `0020` and `0021`.

Migrations `0020_fiscal_operation_claims.sql` and `0021_security_lifecycle_guards.sql`, together with their claim/finalization-aware Worker, must be introduced in one quiesced maintenance window. An old Worker isolate does not understand the new ownership state and can otherwise submit a second fiscal operation or bypass lifecycle-generation guards.

The acknowledgment command does not prove quiescence. Before running `cf:cutover:staging` or the guarded production migration/deployment commands, the deployment operator must complete these steps in order:
```

In step 5, replace the separate migration/deployment instruction with:

```md
5. In the same shell, acknowledge the drained state with `export FISCAL_CUTOVER_QUIESCED=1`, then run `npm run cf:cutover:staging` for staging or the environment's guarded `cf:migrate:prod` command and immediately its guarded `cf:deploy:prod` command for production.
```

Keep the remaining drain, backup, schema-verification, and re-enable steps unchanged.

- [ ] **Step 5: Verify the documentation has no contradictory routine-gate language**

Run:

```bash
rtk rg -n "gate remains active on standard remote|claim-aware Worker has been live|staging and, after approval, production" docs/fiscal-claim-cutover.md
```

Expected: no matches.

Run:

```bash
rtk rg -n 'cf:cutover:staging|Routine `cf:migrate:staging`' docs/fiscal-claim-cutover.md
```

Expected: matches in the opening staging record, the operator introduction, and step 5.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run:

```bash
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmossv-pr94-green npm test -- test/scripts/deployScripts.test.ts test/scripts/fiscalCutover.test.ts
```

Expected: 2 files pass, 6 tests pass.

- [ ] **Step 7: Run all regression and staging-safe gates**

Run:

```bash
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmossv-pr94-final npm test
rtk npm run typecheck
rtk npm run build
rtk env WRANGLER_LOG_PATH=/private/tmp/diezmossv-pr94-final-wrangler.log npm run types:check
rtk npm run security:check-private-boundary
rtk git diff --check
rtk git status --short --branch
```

Expected:

- 101 test files pass with 1,484 passing tests and two environment-conditional skips in the isolated worktree;
- typecheck, build, binding freshness, private-boundary, and diff checks exit 0;
- only the three intended implementation files are changed after the plan commit;
- the existing Vite chunk-size warning may remain.

- [ ] **Step 8: Review the exact implementation diff**

Run:

```bash
rtk git diff -- docs/fiscal-claim-cutover.md package.json test/scripts/deployScripts.test.ts
rtk git diff --name-only
```

Expected: the diff implements the approved explicit-command policy and no unrelated file appears.

- [ ] **Step 9: Commit the focused reconciliation**

Run:

```bash
rtk git add docs/fiscal-claim-cutover.md package.json test/scripts/deployScripts.test.ts
rtk git commit -m "fix: scope fiscal cutover gate to explicit staging command"
```

Expected: one commit containing exactly the three intended files.

- [ ] **Step 10: Request independent review before advancing `main`**

Ask the reviewer to compare the implementation commit against this plan and the approved design, verify that PR #94's assertion CLI remains intact, and confirm that Worker/client/router/repository/WorkerFetch blobs are unchanged from `main`.
