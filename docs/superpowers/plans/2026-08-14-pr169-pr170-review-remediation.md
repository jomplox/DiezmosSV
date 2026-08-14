# PR 169 and PR 170 Review Remediation and Staging Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve every validated review finding in the combined PR #169 + PR #170 head, prove the fixes with regression tests, and deploy the exact verified commit to the Cloudflare staging Worker for owner testing.

**Architecture:** Keep the existing Wompi/El Salvador and Givebutter/United States lane boundary. Replace stale full-snapshot browser writes with dirty-field and response-generation reconciliation, make email-template writes database-atomic, make template rendering single-pass and definition-scoped, append a mixed-version migration fence, and narrow the private build environment to an explicit public allowlist. Deployment remains a separate, gated phase with an exact rollback anchor, D1 preflight, staging policy proof, and post-deploy identity checks.

**Tech Stack:** React 19, TypeScript, Vite, Cloudflare Workers, D1/SQLite migrations, Vitest, Playwright, Wrangler.

## Global Constraints

- Work only in the isolated review worktree on `codex/fix-pr169-pr170-review-findings`; preserve the user's dirty primary checkout.
- Begin from combined reviewed head `4bb0423c7e8479c83ef424aad12b3f69e68143f1`. Do not push or rewrite PR #169 or PR #170 branches.
- Use test-driven development for every behavior change: add the narrow failing regression, observe the expected failure, implement the minimum fix, and rerun the focused test.
- Never edit an applied D1 migration. Add migration `0043` after `0042` and verify fresh install plus upgrade and mixed-version states.
- Donor-facing Spanish must use `usted`, preserve the ceremonial title, describe a voluntary gift, and avoid every forbidden transactional term in `AGENTS.md`.
- Keep private deployment identifiers, campaign/fund identifiers, Cloudflare account/resource IDs, credentials, and hostnames out of source, logs, commits, and the final response.
- A Givebutter handoff may claim only behavior the public provider contract and the configured campaign actually support. It must preserve the donor's selected gift type through explicit fund mapping; an absent pair hides the alternative, while an incomplete or ambiguous pair stops with an actionable configuration error. It must not invent a legal entity.
- README changes, if needed, must be mirrored in `README.md` and `README.es.md`.
- Each implementation task ends with focused tests and `git diff --check`; integrated verification must use the final exact commit.
- Do not mutate Cloudflare until all code/test/security reviews pass. Before staging mutation, capture the active version as rollback anchor, prove `emission_environment=00`, inspect pending migrations and annual-delivery claims, and confirm the intended Worker target.
- Staging deployment may apply only the repository's pending append-only migrations and the exact verified commit. Postflight must confirm code identity, migration state, health, canonical-browser behavior, and unchanged fiscal policy.

---

## Task 1: Make Stripe owner settings patch-based and refresh-order safe

**Files:**

- Modify: `src/client/App.tsx`
- Modify: `src/client/credentialSettings.ts`
- Modify: `test/client/credentialSettings.test.ts`
- Modify: `test/client/stripeSettingsUi.test.ts`
- Modify: `e2e/adminUiCoverage.spec.ts` only if browser coverage is required for the stale-response sequence

**Contract:**

- Send only organization fields that differ from the last authoritative server baseline; key-only or unrelated saves never resend legal configuration.
- Mark pending fields only when the server reports that exact field updated, and expire pending values without allowing stale form state to be submitted later.
- Sequence owner-setting refreshes so an older response can never overwrite a newer response or clear a newer pending guard.
- Preserve an edit made while a request is in flight while still accepting fresh server values for untouched fields.

**Steps:**

- [ ] Add failing pure-helper tests for dirty patches, `result.updated` intersection, pending expiry, and edit-during-flight reconciliation.
- [ ] Add a failing response-order test in which refresh B resolves before refresh A and A is ignored.
- [ ] Implement the smallest authoritative-baseline, dirty-patch, expiry-refetch, and request-generation changes.
- [ ] Run focused client tests, typecheck, and `git diff --check`.

---

## Task 2: Make scoped email-template saves concurrent, atomic, and corruption-safe

**Files:**

- Modify: `src/worker/storage/repository.ts`
- Modify: `src/worker/storage/repository/settings.ts` or add the narrow repository module that matches local structure
- Modify: `src/worker/index.ts`
- Modify: `src/worker/services/emailTemplates.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/credentialSettings.ts`
- Modify: `test/worker/workerFetch.admin-settings.test.ts`
- Modify: `test/worker/emailTemplates.test.ts`
- Modify: `test/client/credentialSettings.test.ts`

**Contract:**

- Require an explicit `SV_CDE` or `US_STRIPE` scope; legacy unscoped full replacement returns a reload-required conflict and performs no write.
- Apply only the submitted scope with a single SQL JSON patch, and place the settings mutation plus actor/scope audit insert in one D1 `batch()` transaction.
- Concurrent SV and US saves both survive regardless of interleaving. An audit failure rolls back the settings change.
- Malformed stored JSON or invalid untouched templates return a conflict without writing defaults over valid customizations; a valid save may repair corruption inside its own scope.
- After a successful save, reconcile every returned field with a three-way merge: update untouched opposite-scope fields, preserve locally dirty fields, and adopt server normalization for the submitted scope.

**Steps:**

- [ ] Add failing barrier-controlled concurrency and injected-audit-failure route tests.
- [ ] Add failing tests for missing scope, malformed stored JSON, invalid untouched scope, and same-scope repair.
- [ ] Add failing client tests for opposite-scope refresh and edit-during-flight preservation.
- [ ] Implement the atomic repository operation, strict error mapping, and client reconciliation.
- [ ] Run focused Worker/client tests, typecheck, and `git diff --check`.

---

## Task 3: Make editable templates honest, single-pass, and accessible

**Files:**

- Modify: `src/worker/services/emailTemplates.ts`
- Modify: `src/client/credentialsPanel.tsx`
- Modify: `test/worker/emailTemplates.test.ts`
- Modify: `test/worker/emailHtml.test.ts`
- Modify: `test/client/credentialSettings.test.ts`
- Modify: `e2e/adminUiCoverage.spec.ts`

**Contract:**

- Validate every subject/body placeholder against that template definition's allowlist; unsupported or misspelled placeholders cannot be saved and previously stored invalid templates cannot be mailed literally.
- Substitute placeholders once against the original template. Placeholder-looking donor text remains donor text and is never reinterpreted.
- Bold, italic, and underline operations wrap each nonempty selected line independently so the line-oriented renderer produces formatting rather than literal markers.
- Each of the five editor cards, subjects, bodies, toolbars, and formatting buttons has a unique accessible name tied to its template label.

**Steps:**

- [ ] Add failing placeholder-allowlist, stored-invalid-template, and donor-text single-pass tests.
- [ ] Add failing multiline selection/caret tests and renderer contract coverage.
- [ ] Add failing Playwright assertions for all unique accessible names and multiline formatting.
- [ ] Implement definition-scoped validation, callback-based one-pass substitution, pure selection formatting, and contextual labels.
- [ ] Run focused unit/browser tests, typecheck, and `git diff --check`.

---

## Task 4: Close the private Vite environment boundary

**Files:**

- Modify: `scripts/run-private-build.mjs`
- Modify: `test/scripts/privateBuild.test.ts` or the existing private-build test file
- Modify: `.dev.vars.example` and private deployment loader tests only if the public allowlist contract needs documentation

**Contract:**

- The child Vite process receives inherited non-`VITE_` process variables plus only the explicitly approved public `VITE_` variables loaded through the private deployment configuration.
- Arbitrary inherited `VITE_*` names and values never reach the public bundle.
- The configured public Givebutter campaign and explicit public gift-type mapping remain available to the build without logging their values.

**Steps:**

- [ ] Add a failing sentinel build proving an inherited arbitrary `VITE_*` value reaches the current bundle.
- [ ] Add a control proving approved public configuration still reaches the child build.
- [ ] Implement the narrow allowlist and rerun the exact sentinel test plus private-boundary guard.
- [ ] Run focused script tests, build, and `git diff --check`.

---

## Task 5: Fence annual-email evidence across mixed Worker versions

**Files:**

- Create: `migrations/0043_stripe_annual_email_evidence_dispatch_guard.sql`
- Modify: `test/worker/stripeAnnualStatementMigration.test.ts`
- Modify: `test/worker/stripeAnnualStatementRepository.test.ts` only if state-transition coverage belongs there
- Modify: migration snapshot/manifest only through the repository's supported generator, if required

**Contract:**

- A row with null `email_content_json` cannot newly enter provider dispatch and cannot newly finalize `SENT`, including writes from a pre-PR mixed-version Worker.
- A legacy post-dispatch row already missing evidence can still transition to `REVIEW` for operator handling.
- Existing valid rows and evidence immutability remain unchanged; fresh install and upgrade from every supported migration boundary succeed.

**Steps:**

- [ ] Add a failing mixed-version regression that reproduces `SENT` with null evidence after applying through `0042`.
- [ ] Add passing-target tests for dispatch/finalization rejection, valid evidence, and legacy transition to `REVIEW`.
- [ ] Append migration `0043` with the minimum transition triggers.
- [ ] Run focused migration/repository tests, migration immutability/preflight, and `git diff --check`.

---

## Task 6: Preserve the U.S. gift intent and correct donor presentation

**Files:**

- Modify: `src/client/donation.ts`
- Modify: `src/client/donarPage.tsx`
- Modify: `src/client/styles.css`
- Modify: `scripts/private-deploy-config.mjs` and its tests only if explicit fund mapping is a deployment input
- Modify: `test/client/stripeDonation.test.ts`
- Modify: `test/client/donarPage.test.ts`
- Modify: `test/scripts/privateDeployConfig.test.ts` if applicable
- Modify: `e2e/donar.spec.ts`

**Contract:**

- Givebutter receives an explicit configured fund identifier for `tithe` versus `offering`, so the donor's selected gift type survives the handoff. Missing or ambiguous mapping fails closed before redirect.
- Amount and frequency are passed only as provider-supported prefills and donor copy clearly asks the donor to confirm all details on Givebutter; tests do not claim stronger guarantees than the configured campaign supports.
- Donor-facing legal copy uses a configured legal identity when available or neutral truthful 501(c)(3) wording; it never infers `Friends of ${brandingName}`.
- Provider-switch animation and hover transform are disabled under `prefers-reduced-motion: reduce`.
- The donor flow continues to reuse the same request/session when returning without changing provider inputs.

**Steps:**

- [ ] Add failing unit/source tests for gift-type mapping, unsupported/missing mapping, neutral legal copy, and reduced motion.
- [ ] Add a failing browser flow proving selected type is encoded in the external handoff without exposing deployment values in test output.
- [ ] Implement the smallest explicit mapping, truthful confirmation copy, legal wording, and motion override.
- [ ] Run donor copy guard, focused client/browser tests, typecheck, and `git diff --check`.

---

## Task 7: Integrated review, exact commit, and Cloudflare staging release

**Files:**

- Modify only release documentation if a newly required private variable must be documented, mirrored English/Spanish.
- Do not add generated Wrangler state, local D1 databases, test artifacts, or private configuration to Git.

**Steps:**

- [ ] Run focused suites for all six remediation tasks, then `npm test`, `npm run build`, migration immutability, D1 preflight, changed Playwright coverage with a fresh `PW_PERSIST_TO`, strict private-boundary guard, and `git diff --check`.
- [ ] Perform whole-branch correctness and security reviews against `4bb0423c7e8479c83ef424aad12b3f69e68143f1`; resolve every blocking finding and rerun affected checks.
- [ ] Confirm the final Git diff contains only intended source/tests/migration/docs, commit it, and record the exact commit SHA.
- [ ] Read-only preflight staging: verify authenticated target, active-version rollback anchor, `emission_environment=00`, pending migrations, annual-delivery claim state, and no incompatible queue or fiscal activity.
- [ ] Apply the repository migration preflight/migrate command so only pending `0042` and `0043` are applied, then verify the remote schema and policy before code deployment.
- [ ] Deploy the exact verified commit with the private wrapper and Wrangler strict mode while preserving configured variables.
- [ ] Confirm the active Worker version and release message map to the exact commit; verify health and canonical custom-domain browser behavior, template/admin regressions, donor handoff construction, migration state, and `emission_environment=00`.
- [ ] Remove generated local Wrangler account metadata, rerun the strict private-boundary guard, and report the rollback anchor as captured without disclosing its private identifier.
