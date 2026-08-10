# Private Release Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve the deployment-private donor logo and Givebutter campaign across staging and production releases, block a release when either would regress, and clear the six currently reported dependency advisories without broad upgrades.

**Architecture:** Keep organization-specific values and artwork outside the public repository in owner-only files. A generic deployment-config loader supplies the Vite campaign only to the build child process; generic runtime-logo tooling migrates an approved private PNG/JPEG through the existing OWNER API and verifies the exact remote bytes before either staging or production deploys. The public neutral logo remains a reusable fallback, while dependency remediation is constrained to the vulnerable lockfile paths.

**Tech Stack:** Node.js 22 ESM, Vite, Vitest, Cloudflare Worker/D1/R2, the existing bearer-token admin API, npm lockfiles.

## Global Constraints

- Production is untouched unless the user separately authorizes a production cutover.
- The legacy organization SVG, its path data, its digest, the campaign value, live origins, credentials, and Cloudflare identifiers must never be committed or printed.
- The approved logo input must be an owner-only regular PNG or JPEG outside the repository; SVG must fail before migration because `pdf-lib` cannot embed it.
- A logo migration writes only the existing donor slot: R2 key `branding/donor-logo` and D1 setting `branding_donor_logo`, through `PUT /api/settings/branding/donor-logo`.
- Logo migration is explicit and idempotent: it requires `--apply`, skips the write when the remote bytes already match, and verifies exact remote bytes after a write.
- Both staging and production deploys must fail before build/deploy when the remote donor logo is absent, non-raster, or differs from the approved private raster.
- Both staging and production release builds must receive `VITE_GIVEBUTTER_CAMPAIGN` from owner-only out-of-repository configuration and must reject a blank value or `example-campaign`.
- Generic `npm run build` must remain available for public clones and tests; only deployment scripts require private configuration.
- Do not edit applied SQL migrations. This logo is an R2/runtime-data migration, not a D1 schema migration.
- Preserve donor-facing `usted` language and the existing two-slot branding contract. No donor-facing copy changes are needed.
- Use `rtk` for every shell command. Use `apply_patch` for repository edits.
- Write each behavioral test first, run it against the pre-implementation state, and record the expected failure before adding production code.
- Keep dependency changes to `fast-uri`, `nanoid`, `postcss`, `wrangler`, `miniflare`, `undici`, `workerd`, and lockfile metadata required by npm unless evidence proves another package is necessary.
- Before any public push or PR, run the private-boundary guard and the available OpenAI Privacy Filter against the exact payload; do not use `gpt-oss:20b`.

---

### Task 1: Private Runtime Logo Migration and Release Blocker

**Files:**
- Create: `scripts/private-deploy-config.mjs`
- Create if TypeScript resolution requires it: `scripts/private-deploy-config.d.mts`
- Create: `scripts/runtime-branding-logo.mjs`
- Create if TypeScript resolution requires it: `scripts/runtime-branding-logo.d.mts`
- Create: `scripts/assert-runtime-branding-logo.mjs`
- Create: `scripts/migrate-runtime-branding-logo.mjs`
- Create: `test/scripts/privateDeployConfig.test.ts`
- Create: `test/scripts/runtimeBrandingLogo.test.ts`
- Modify: `test/scripts/deployScripts.test.ts`
- Modify: `src/worker/services/pdf.ts`
- Modify: `src/worker/services/observability.ts`
- Modify: `test/worker/pdf.test.ts`
- Modify: `package.json`
- Modify: `docs/local-private-artifacts.md`

**Interfaces:**
- Produces: `loadPrivateDeployConfig({ target, env, repositoryRoot })`, returning `{ target, campaign, origin, donorLogo: { path, bytes, contentType, sha256 } }` for `target: "staging" | "production"`.
- Produces: `loadOperatorCredentials({ target, env, repositoryRoot })`, returning `{ email, password }` from an owner-only external operator env file. It accepts target-prefixed keys such as `STAGING_EMAIL`/`STAGING_PASSWORD` and generic `DIEZMOSSV_OPERATOR_EMAIL`/`DIEZMOSSV_OPERATOR_PASSWORD`.
- Produces: `verifyRuntimeBrandingLogo(config, { fetchImpl })`, which returns `{ matched: true }` only when `/api/branding` advertises a donor logo and `/api/branding/donor-logo?v=...` is a byte-for-byte matching PNG/JPEG.
- Produces: `migrateRuntimeBrandingLogo(config, credentials, { fetchImpl })`, which returns `{ changed: false }` for an already matching logo or logs in, uploads the private raster, verifies it, and returns `{ changed: true }`.
- Produces: one allowlisted `branding_logo_fallback` operational event with entity type `credentials` whenever production PDF rendering cannot load a usable donor raster; receipt generation still uses the neutral fallback.
- Consumes: existing `assertDonationLaneConfigured` only for the campaign field validation; Task 2 consumes the same deployment config.

- [ ] **Step 1: Write failing private-config tests**

  Add literal behavior cases that create temporary repository/private roots and assert:

  ```ts
  expect(loadPrivateDeployConfig({ target: "staging", env, repositoryRoot })).toMatchObject({
    target: "staging",
    campaign: "campaign-fixture",
    origin: "https://staging.example.invalid",
    donorLogo: { contentType: "image/png" }
  });
  ```

  Reject relative config overrides, files inside the repository, symlinks, non-`0600` files, wrong-owner files where the platform can simulate one, missing keys, `example-campaign`, non-HTTPS non-loopback origins, repository-contained logo paths, SVG bytes, extensions/content that disagree, and malformed PNG/JPEG signatures. Assert no error contains fixture bytes, campaign text, password text, a digest, or the private logo path.

- [ ] **Step 2: Run the private-config tests and record RED**

  Run: `rtk npm test -- test/scripts/privateDeployConfig.test.ts`

  Expected: FAIL because `scripts/private-deploy-config.mjs` does not exist.

- [ ] **Step 3: Implement the minimal deployment-config loader**

  Use Node's `parseEnv`, `lstatSync`, `realpathSync`, and `statSync`. Default config paths are:

  ```text
  ~/Library/Application Support/DiezmosSV/private/deploy/staging.env
  ~/Library/Application Support/DiezmosSV/private/deploy/production.env
  ```

  The optional `DIEZMOSSV_DEPLOY_CONFIG` override must be absolute. Parse only:

  ```text
  VITE_GIVEBUTTER_CAMPAIGN
  DIEZMOSSV_APP_ORIGIN
  DIEZMOSSV_DONOR_LOGO_FILE
  ```

  Read logo bytes without logging them, sniff the PNG/JPEG signature rather than trusting the extension, and calculate SHA-256 only in memory for exact comparison.

- [ ] **Step 4: Run the private-config tests GREEN**

  Run: `rtk npm test -- test/scripts/privateDeployConfig.test.ts`

  Expected: PASS.

- [ ] **Step 5: Write failing runtime verification and migration tests**

  Use a local `node:http` server, not a mock of the code under test. Cover:

  ```ts
  // exact remote raster: verify succeeds and migration performs no login or PUT
  expect(await verifyRuntimeBrandingLogo(config, { fetchImpl: fetch })).toEqual({ matched: true });
  expect(requests).toEqual(["GET /api/branding", "GET /api/branding/donor-logo?v=fixture-version"]);

  // legacy SVG or different raster: verify rejects before a deployment can build
  await expect(verifyRuntimeBrandingLogo(svgRemoteConfig, { fetchImpl: fetch }))
    .rejects.toThrow(/PDF-embeddable donor logo/i);

  // explicit migration: login, exact donor-slot PUT, then post-write verification
  expect(await migrateRuntimeBrandingLogo(config, credentials, { fetchImpl: fetch }))
    .toEqual({ changed: true });
  expect(upload).toMatchObject({ method: "PUT", path: "/api/settings/branding/donor-logo", contentType: "image/png" });
  expect(upload.body).toEqual(localRasterBytes);
  ```

  Also spawn each CLI against fixtures: migration without `--apply` must not send a write; successful output and all failures must omit campaign, credentials, private paths, digests, and bytes.

- [ ] **Step 6: Run runtime tests and record RED**

  Run: `rtk npm test -- test/scripts/runtimeBrandingLogo.test.ts`

  Expected: FAIL because runtime logo verification/migration modules do not exist.

- [ ] **Step 7: Implement runtime verification and explicit migration**

  `verifyRuntimeBrandingLogo` must:

  1. GET `/api/branding` and require a non-empty `donorLogoVersion`.
  2. GET `/api/branding/donor-logo?v=<encoded version>`.
  3. Require HTTP 200, `image/png` or `image/jpeg`, a matching byte signature, and exact SHA-256 equality with the private file.
  4. Throw sanitized errors without returning or logging private values.

  `migrateRuntimeBrandingLogo` must first call verification. Only a mismatch may lead to POST `/api/auth/login`, then PUT `/api/settings/branding/donor-logo` with the bearer token and exact raster bytes/content type, then a mandatory verification call. Treat an authentication/upload/postflight failure as failure; never delete the current object.

  The migration CLI requires `--env staging|production --apply`; without `--apply` it validates locally and exits without remote mutation.

- [ ] **Step 8: Run runtime tests GREEN**

  Run: `rtk npm test -- test/scripts/privateDeployConfig.test.ts test/scripts/runtimeBrandingLogo.test.ts`

  Expected: PASS.

- [ ] **Step 9: Write the failing production fallback observability test and record RED**

  First extend `test/worker/pdf.test.ts` with a production-only observability case:

  ```ts
  await expect(loadPdfBrandingLogo({ APP_ENV: "production" })).resolves.toBeNull();
  expect(consoleError).toHaveBeenCalledWith({
    event: "operational_alert",
    app_env: "production",
    alert_kind: "branding_logo_fallback",
    entity_type: "credentials"
  });
  ```

  Prove staging/local fallback stays quiet and a valid raster emits no fallback event. Temporarily remove the logging call after implementation and confirm this test fails.

  Run: `rtk npm test -- test/worker/pdf.test.ts`

  Expected: FAIL because the fallback event is not allowlisted or emitted.

- [ ] **Step 10: Add sanitized production fallback observability**

  Extend `BrandingLogoArchiveEnv` with optional `APP_ENV`, allowlist `branding_logo_fallback`, and emit only the structured allowlisted event when `APP_ENV === "production"` and the loader returns `null`. Do not log an exception, object key, content type, path, bytes, or digest. Preserve the runtime fallback so a completed entrega is never stranded by a branding failure.

- [ ] **Step 11: Add deploy-script regression expectations and record RED**

  Change `test/scripts/deployScripts.test.ts` to require this order:

  ```text
  staging: assert-runtime-branding-logo --env staging, existing npm run build, private Wrangler deploy
  production: assert-fiscal-cutover first, assert-runtime-branding-logo --env production, existing donation-lane assertion, existing npm run build, private Wrangler deploy
  ```

  Run: `rtk npm test -- test/scripts/deployScripts.test.ts`

  Expected: FAIL because package scripts do not yet include the logo assertion or private build wrapper.

- [ ] **Step 12: Wire logo checks without changing generic build behavior**

  Add `cf:branding:check` and `cf:branding:migrate` generic scripts. Put the logo assertion into both deploy targets before the existing build/deploy. Leave `npm run build` and the existing production donation-lane assertion unchanged; Task 2 later replaces the deployment-time build path.

- [ ] **Step 13: Document only the private contract**

  In `docs/local-private-artifacts.md`, document the two default deploy-env paths, required key names, `0600`/outside-repository rules, raster-only donor-logo requirement, explicit migration command, and read-only preflight command. Include only placeholders such as `https://staging.example.invalid` and `/absolute/private/path/logo.png`.

- [ ] **Step 14: Run focused tests and commit**

  Run: `rtk npm test -- test/scripts/privateDeployConfig.test.ts test/scripts/runtimeBrandingLogo.test.ts test/scripts/deployScripts.test.ts test/worker/pdf.test.ts test/worker/certificate.test.ts`

  Expected: all focused suites pass, including the existing deployment-time build path plus the new logo preflight ordering.

  Commit:

  ```bash
  git add scripts/private-deploy-config.mjs scripts/private-deploy-config.d.mts scripts/runtime-branding-logo.mjs scripts/runtime-branding-logo.d.mts scripts/assert-runtime-branding-logo.mjs scripts/migrate-runtime-branding-logo.mjs test/scripts/privateDeployConfig.test.ts test/scripts/runtimeBrandingLogo.test.ts test/scripts/deployScripts.test.ts src/worker/services/pdf.ts src/worker/services/observability.ts test/worker/pdf.test.ts package.json docs/local-private-artifacts.md
  git commit -m "fix: guard private donor logo continuity"
  ```

---

### Task 2: Owner-Only Givebutter Release Builds

**Files:**
- Create: `scripts/run-private-build.mjs`
- Create if TypeScript resolution requires it: `scripts/run-private-build.d.mts`
- Create: `test/scripts/privateBuildConfig.test.ts`
- Modify: `test/scripts/deployScripts.test.ts`
- Modify: `package.json`
- Modify: `docs/local-private-artifacts.md`

**Interfaces:**
- Consumes: `loadPrivateDeployConfig({ target, env, repositoryRoot })` from Task 1.
- Consumes: `assertDonationLaneConfigured({ environment })` from `scripts/assert-donation-lane-config.mjs`.
- Produces: `runPrivateBuild({ target, env, repositoryRoot, spawnImpl })`, which executes `npm run build` with `VITE_GIVEBUTTER_CAMPAIGN` injected only into the child environment and returns the child exit status.

- [ ] **Step 1: Write the failing private-build tests**

  Test `staging` and `production` separately. Use a sentinel campaign and a spawn adapter at the process boundary to assert:

  ```ts
  expect(call.command).toBe(process.platform === "win32" ? "npm.cmd" : "npm");
  expect(call.args).toEqual(["run", "build"]);
  expect(call.options.env.VITE_GIVEBUTTER_CAMPAIGN).toBe("campaign-fixture");
  expect(capturedOutput).not.toContain("campaign-fixture");
  ```

  Also prove a non-zero build exit is propagated and no private logo/origin/operator values are added to the child environment by the loader.

- [ ] **Step 2: Run the private-build tests and record RED**

  Run: `rtk npm test -- test/scripts/privateBuildConfig.test.ts`

  Expected: FAIL because `scripts/run-private-build.mjs` does not exist.

- [ ] **Step 3: Implement the minimal private build wrapper**

  Parse only `--env staging|production`. Load the target config, validate the campaign with the existing assertion, and spawn `npm run build` with inherited environment plus only the validated campaign override. Do not print the campaign or config contents. Propagate signals and exit status.

- [ ] **Step 4: Wire both deployment targets to the wrapper**

  Add:

  ```json
  "build:private": "node scripts/run-private-build.mjs"
  ```

  Replace deployment-time `npm run build` with `npm run build:private -- --env staging` and `npm run build:private -- --env production`. Remove the now-redundant ambient `assert-donation-lane-config.mjs` process from `cf:deploy:prod`; validation occurs inside the wrapper before Vite starts.

- [ ] **Step 5: Run private-build and deployment contract tests GREEN**

  Run: `rtk npm test -- test/scripts/privateBuildConfig.test.ts test/scripts/deployScripts.test.ts`

  Expected: PASS, including fiscal-cutover-first ordering for production and logo-check-before-build ordering for both targets.

- [ ] **Step 6: Run a real build with a synthetic owner-only config**

  Create a temporary external `0600` deploy env and a synthetic PNG fixture, then run:

  `rtk npm run build:private -- --env staging`

  Expected: PASS; built output contains the synthetic campaign only where Vite ordinarily embeds it, while command output does not print it.

- [ ] **Step 7: Commit**

  ```bash
  git add scripts/run-private-build.mjs scripts/run-private-build.d.mts test/scripts/privateBuildConfig.test.ts test/scripts/deployScripts.test.ts package.json docs/local-private-artifacts.md
  git commit -m "fix: persist private release build configuration"
  ```

---

### Task 3: Narrow Dependency Advisory Remediation

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: the current npm audit advisory database and Node.js `>=22.16.0` engine policy.
- Produces: a lock graph with no currently known advisories and a direct Wrangler floor of `^4.120.0`.

- [ ] **Step 1: Record the failing audit**

  Run: `rtk npm audit --package-lock-only --json`

  Expected: non-zero with exactly 3 high and 3 moderate advisories on the pre-change lockfile.

- [ ] **Step 2: Dry-run npm's remediation and inspect scope**

  Run: `rtk npm audit fix --package-lock-only --dry-run --json`

  Expected: proposed changes are confined to the vulnerable paths headed by `fast-uri`, `nanoid`, `postcss`, and `wrangler` plus `miniflare`, `undici`, `workerd`, and npm-required lock metadata. Stop and report if a major unrelated direct dependency changes.

- [ ] **Step 3: Raise the direct Wrangler security floor using npm**

  Run: `rtk npm install --package-lock-only --save-dev 'wrangler@^4.120.0'`

  Do not hand-edit integrity or resolved fields.

- [ ] **Step 4: Apply the remaining lockfile-only fixes**

  Run: `rtk npm audit fix --package-lock-only`

  Inspect `git diff -- package.json package-lock.json`; revert and use targeted `rtk npm update --package-lock-only <package...>` only if npm moves unrelated direct dependencies.

- [ ] **Step 5: Prove the audit is GREEN and graph is coherent**

  Run:

  ```bash
  rtk npm audit --package-lock-only --json
  rtk npm ls fast-uri nanoid postcss wrangler miniflare undici workerd
  rtk npx wrangler --version
  rtk npm run types:check
  ```

  Expected: zero known vulnerabilities, no invalid/duplicate unexpected nodes, Wrangler `4.120.0` or newer within the declared range, and generated Cloudflare types remain current.

- [ ] **Step 6: Run all tests and build**

  Run:

  ```bash
  rtk env MINIFLARE_CACHE_DIR=/tmp/diezmossv-private-release-continuity npm test
  rtk npm run build
  ```

  Expected: all tests pass and both Vite and worker typechecks succeed. If Miniflare 5 changes runtime behavior, diagnose that compatibility issue rather than suppressing the tests.

- [ ] **Step 7: Commit**

  ```bash
  git add package.json package-lock.json
  git commit -m "chore: remediate dependency advisories"
  ```

---

## Post-Implementation Operational Verification

These steps run only after all three task reviews and the final whole-branch review are clean.

1. Recover the exact pre-sanitization SVG from the verified pre-rewrite commit into the owner-only DiezmosSV private directory without printing it.
2. Convert it at its `704x228` view box to a lossless PNG with transparency outside the repository; record source and raster sizes/digests only in the private release evidence.
3. Create `0600` staging and production deploy-env files from already verified private values without printing them. Do not create or guess production operator credentials.
4. Run the staging logo migration with `--apply`. This is the only remote mutation before staging verification.
5. Run the read-only staging logo preflight and confirm the remote bytes exactly match the private PNG.
6. Download a fresh staging CDE PDF for the supplied accepted test document and verify the header contains the migrated raster rather than `ORG_LOGO_PATHS`; also check the donor page and `/api/branding` in a fresh browser context.
7. Re-inventory staging Worker version/traffic, D1 branding metadata, and in-flight work. Do not deploy a new Worker unless the reviewed code itself must be exercised remotely and the current user test has completed.
8. Run `rtk npm run migrations:check-immutability`, the complete suite/build, the private-boundary guard on the exact branch diff/payload, and the available OpenAI Privacy Filter without `gpt-oss:20b` before any public push or PR.
9. Leave production unchanged. The next production cutover must first migrate the same approved private PNG, pass the production logo preflight, then follow the controlled quiescence and exact-SHA release playbook.
