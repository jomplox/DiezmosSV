# Stripe Gift Type, U.S. Reporting, and Admin Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give U.S. donors the same explicit Diezmo/Ofrenda choice as the Wompi lane, keep one-time/monthly Stripe giving in a two-step Spanish flow, issue U.S.-specific acknowledgments and annual statements, and expose every implemented Stripe setting and webhook-health control safely in `/admin`.

**Architecture:** Preserve the hard lane boundary: Wompi remains the El Salvador fiscal/CDE source of truth and Stripe remains the U.S. 501(c)(3) source of truth. Add gift type to Stripe's durable checkout and gift records, propagate it through Stripe metadata and verified webhooks, and build a separate U.S. annual-statement service over settled Stripe gifts. Reuse the existing bounded-preview/bulk-send admin interaction but do not reuse the Salvadoran CDE dossier or call a U.S. statement a CDE. Extend the existing owner-only credential writer for write-only Stripe rotations and add a read-only webhook-health endpoint; no secret value is ever returned to the browser.

**Tech Stack:** React 19, TypeScript, Vite, Cloudflare Workers, D1/SQLite migrations, Stripe Embedded Checkout and webhooks, `pdf-lib`, Vitest, Playwright.

## Global Constraints

- Work only in `/Users/josevega/Documents/CCRTV/DiezmosSV/.worktrees/stripe-replace-givebutter` on branch `codex/stripe-replace-givebutter`.
- Use test-driven development for every behavior change: write the narrow failing test first, run it and record the expected failure, implement the minimum change, then rerun the focused test.
- Never edit an applied migration. Add migrations after `0032_stripe_us_donations.sql`.
- Keep Wompi, DTE/CDE issuance, Ministerio de Hacienda records, and El Salvador annual dossiers unchanged. Stripe data must never enter the Salvadoran fiscal pipeline.
- Donor-facing copy must be Spanish, use `usted`, describe a voluntary gift, and avoid every forbidden transactional term in `AGENTS.md`.
- Keep the ceremonial `<h1>` “Diezmos y Ofrendas” on every donor step. Do not add `donar-compact-head`.
- Do not hard-code Stripe payment-method types. Continue using the account's Payment Method Configuration so eligible donor-safe methods appear dynamically and BNPL remains excluded by account configuration.
- Never expose active secret values in any API response, HTML, log, audit metadata, test snapshot, or commit. Owner-entered replacement secrets are write-only and blank after submission.
- Do not change any live Stripe account or deploy. All provider verification in this plan is local/test mode only.
- Historical Stripe rows created before gift type existed must migrate to `UNSPECIFIED`; do not rewrite them as a tithe or offering without donor evidence.
- U.S. statements use Stripe's settled gift date and net amount after refunds. They identify the U.S. legal entity and EIN and state whether goods or services were provided. They are never represented as Salvadoran fiscal documents.
- The IRS allows one annual acknowledgment to substantiate several gifts and requires the organization name, cash amount, and goods/services statement for qualifying acknowledgments. The donor must obtain a contemporaneous acknowledgment by the earlier of the return filing date or filing due date (including extensions). Sources: <https://www.irs.gov/pub/irs-pdf/p1771.pdf> and <https://www.irs.gov/charities-non-profits/charitable-organizations/charitable-organizations-substantiation-and-disclosure-requirements>.
- El Salvador remains based on accepted CDEs and the existing donor dossier. The CDE fields remain governed by Salvadoran law and MH vocabulary. Source: <https://transparencia.mh.gob.sv/downloads/pdf/DC5810.pdf>.
- Mirror every README change between `README.md` and `README.es.md` in the same task.
- Each task ends with focused tests, `git diff --check`, a task report, and one scoped commit. Do not amend prior task commits.

---

## Task 1: Persist U.S. gift type and expose the complete donor choice

**Files:**

- Create: `migrations/0033_stripe_gift_type.sql`
- Modify: `src/client/donation.ts`
- Modify: `src/client/donarPage.tsx`
- Modify: `src/client/stripeResultPage.tsx` only if the durable result summary displays gift type
- Modify: `src/client/styles.css`
- Modify: `src/worker/services/stripeDonations.ts`
- Modify: `src/worker/services/stripeWebhook.ts`
- Modify: `src/worker/storage/repository/stripeDonations.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `src/worker/index.ts`
- Modify: `test/worker/stripeMigration.test.ts`
- Modify: `test/worker/stripeDonations.test.ts`
- Modify: `test/worker/stripeRepository.test.ts`
- Modify: `test/worker/stripeWebhook.test.ts`
- Modify: `test/worker/stripeRoutes.test.ts`
- Modify: `test/client/stripeDonation.test.ts`
- Modify: `test/client/donarPage.test.ts`
- Modify: `e2e/donar.spec.ts`
- Modify: `test/worker/support/inMemoryD1.ts` only where the in-memory contract must model the new column

**Contract:**

- Define one shared durable vocabulary: `TITHE | OFFERING | UNSPECIFIED`. Public checkout input accepts only `tithe | offering`; `UNSPECIFIED` exists only for historical migration compatibility.
- Add `gift_type` to `stripe_checkout_sessions` and `stripe_gifts` with a check constraint and a migration default of `UNSPECIFIED`. After upgrading existing rows, create insert guards (SQLite triggers or an equivalent database-enforced rule) that reject `UNSPECIFIED` or omitted gift type on every new checkout/gift row; application validation alone is insufficient.
- Include gift type in the idempotency fingerprint. Reusing a request ID with a different amount, frequency, or gift type must return the existing conflict response.
- Include `gift_type` in Checkout Session metadata, one-time PaymentIntent metadata, and monthly Subscription metadata. Use lowercase Stripe metadata values `tithe | offering`. Stripe does not copy Subscription metadata onto every renewal PaymentIntent, so renewal processing must not require that unsupported invariant.
- Verify gift type with the same identity checks as lane, checkout ID, frequency, mode, currency, and amount. Monthly invoice/subscription processing verifies `invoice.parent.subscription_details.metadata` and resolves the durable gift type from the matched checkout; it rejects conflicting Subscription metadata without expecting renewal PaymentIntent metadata.
- Persist gift type on every new `stripe_gifts` row and include it in the acknowledgment delivery claim.
- The anonymous session-status response may return the normalized gift type needed by the result page, but must return no donor identity or Stripe secret/configuration value.
- U.S. Step 1 shows two stacked segmented controls above the amount:
  - `Tipo de entrega`: `Diezmo | Ofrenda`
  - `Frecuencia`: `Única | Mensual`
- Defaults are `Diezmo` and `Única` on first entry and after changing doors. The selection is explicit in state and request data; no server fallback silently invents it.
- Selecting `Mensual` shows exactly: `Su entrega se realizará cada mes hasta que usted la cancele.`
- Step 2 summary reads `Diezmo · Mensual · $50.00` (or the actual selected values) and the Editar action returns to Step 1 without losing selections.
- The Step 1 CTA reads `Continuar con su diezmo` or `Continuar con su ofrenda` dynamically.
- Changing gift type, frequency, or amount invalidates the prior Stripe attempt and creates a new request ID/session attempt. Returning without changes reuses the current attempt according to the existing idempotency rules.
- The Stripe-owned form remains Embedded Checkout, in Spanish, with dynamic account-eligible methods and no hard-coded method list.

**Steps:**

- [ ] Add failing migration tests that seed the `0032` schema, upgrade through `0033`, prove historical rows become `UNSPECIFIED`, and prove new rows with omitted, `UNSPECIFIED`, or invalid gift type are rejected by D1.
- [ ] Add failing validation/parameter tests for required `giftType`, metadata propagation, and an invalid or missing value.
- [ ] Add failing repository tests for reservation idempotency and gift record/claim propagation.
- [ ] Add failing webhook tests for one-time and monthly propagation plus metadata mismatch rejection.
- [ ] Add failing route tests for the new request fingerprint and safe session-status response.
- [ ] Add failing unit/source-contract tests for labels, defaults, checkout body, fingerprint fields, helper copy, dynamic CTA, and three-part summary.
- [ ] Add a failing Playwright flow that chooses EE. UU., selects Ofrenda + Mensual, verifies helper/summary/CTA, edits back, and confirms the choices persist.
- [ ] Run the focused tests and record the expected RED failures in the task report.
- [ ] Implement the migration and smallest type/validation/repository/webhook/client changes needed for GREEN. Reuse existing segmented-control styles before adding new selectors.
- [ ] Extend the donor-copy regression guard so the new U.S. copy cannot introduce forbidden vocabulary.
- [ ] Run `npx vitest run test/worker/stripeMigration.test.ts test/worker/stripeDonations.test.ts test/worker/stripeRepository.test.ts test/worker/stripeWebhook.test.ts test/worker/stripeRoutes.test.ts test/client/stripeDonation.test.ts test/client/donarPage.test.ts`.
- [ ] Run the focused Playwright case with `DIEZMOSSV_ENV_FILE=.dev.vars.ci` and a fresh `PW_PERSIST_TO` directory.
- [ ] Run `npm run typecheck` and `git diff --check`.
- [ ] Commit with message `feat: add US gift type choice`.

---

## Task 2: Create U.S.-specific acknowledgments and annual statements

**Files:**

- Create: `migrations/0034_stripe_annual_statements.sql`
- Create: `src/worker/services/stripeAnnualStatement.ts`
- Create: `src/worker/storage/repository/stripeAnnualStatements.ts`
- Create: `test/worker/stripeAnnualStatement.test.ts`
- Create: `test/worker/stripeAnnualStatementRepository.test.ts`
- Create: `test/worker/stripeAnnualStatementMigration.test.ts`
- Modify: `src/worker/services/stripeAcknowledgment.ts`
- Modify: `src/worker/services/stripeWebhook.ts` only where refund-to-statement consistency requires an explicit invariant
- Modify: `src/worker/services/emailHtml.ts`
- Modify: `src/worker/services/email.ts`
- Modify: `src/worker/storage/repository/stripeDonations.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `src/worker/types.ts`
- Modify: `.dev.vars.ci`
- Modify: `.dev.vars.example`
- Modify: `wrangler.toml` for the non-secret local/mock timezone default only
- Modify: `test/worker/stripeAcknowledgment.test.ts`
- Modify: `test/worker/stripeWebhook.test.ts`
- Modify: `test/worker/emailHtml.test.ts`
- Modify: `test/worker/support/inMemoryD1.ts` only for required repository behavior

**Immediate acknowledgment contract:**

- Keep the existing U.S. acknowledgment completely separate from SV CDE email templates and attachments.
- Add the selected `Diezmo`, `Ofrenda`, or historical `No especificado` label.
- Include U.S. legal name, EIN, contribution date, amount, frequency, and the existing no-goods-or-services statement.
- Use distinct U.S. subject/body/HTML and Spanish `usted` language. Do not attach or mention a CDE.

**Annual statement contract:**

- Query only settled `stripe_gifts` for the requested calendar year and requested Stripe livemode. Never query `dte_documents` or Wompi rows.
- Define the calendar year in the U.S. organization's configured IANA timezone `STRIPE_US_TIME_ZONE`. Annual preview/send fails closed when it is missing or invalid outside deterministic mock mode; mock mode uses `America/New_York`. Use the same timezone to choose the year window and format contribution dates.
- Group by normalized donor email. A gift without email uses the stable opaque key `gift:<stripe_gifts.id>` so unrelated people with the same name are never merged; these rows remain visible in preview but cannot be sent.
- Each immutable statement snapshot includes donor name/email, each gift date, gift type, frequency, gross amount, refunded amount, net amount, count, and net annual total.
- A fully refunded gift may appear as a clearly refunded line with net `$0.00`; totals must never count refunded dollars. Reject impossible negative net values.
- Render a branded U.S. PDF headed `Constancia anual de donaciones — EE. UU.` with the exact U.S. legal entity, EIN, calendar year, itemized gifts, net total, and `No se proporcionaron bienes ni servicios a cambio de estas donaciones.`
- Include a neutral records disclaimer, not tax advice. Do not claim guaranteed deductibility.
- Deliver a U.S.-specific Spanish email with the PDF. Its body must differ materially from the SV annual-dossier email and must not mention MH, CDE, or Salvadoran fiscal validity.
- Use a bounded preview page (50), bounded bulk send (10), stable cursor, per-donor single send, snapshot recheck before dispatch, and durable/audited send deduplication. Both bulk and single sends skip an already-sent identical snapshot; a changed snapshot (for example, after a refund) gets a new hash and may be sent as a clearly labeled corrected statement.
- Add a dedicated delivery/snapshot table in migration `0034`; do not use the immediate acknowledgment table. Its unique identity is `(year, livemode, donor_key, snapshot_hash)` and it stores immutable `revision`, nullable `supersedes_delivery_id`, `PENDING | PROCESSING | SENT | FAILED | REVIEW`, attempt count, processing claim, dispatch-start time, provider-ID hash, failure code, retry-safe flag, sent time, and timestamps. Also enforce uniqueness of `(year, livemode, donor_key, revision)`.
- The snapshot hash covers the normalized donor identity and ordered itemized rows, including source ID, settled date, gift type, frequency, gross amount, refunded amount, net amount, and annual totals. Recompute and compare immediately before dispatch.
- Claim one snapshot atomically. Mark provider dispatch started before the network call. A confirmed provider ID finalizes `SENT`; a definitely rejected pre-dispatch call may become retry-safe `FAILED`; any unknown post-dispatch outcome becomes non-retryable `REVIEW`. Never infer delivery success from absence of an error or auto-retry a `REVIEW` row.
- Reserve revisions atomically. Concurrent reservations of the same hash converge on one row. When an earlier different snapshot for the same donor/year/livemode was `SENT`, the next row uses the next revision, points `supersedes_delivery_id` at that sent row, and renders/audits as a corrected statement. A refund webhook's durable `refunded_amount_cents` and `status` values are the only refund source; do not call Stripe during report generation.

**Steps:**

- [ ] Add failing migration/repository tests for the exact delivery state machine, IANA year edges, no-email opaque identities, bounded queries, livemode isolation, normalized grouping, refunds/net totals, cursor stability, snapshot hashes, concurrent reservation convergence, correction revision lineage, and duplicate/unknown-outcome fencing.
- [ ] Add failing service/PDF/text/HTML tests covering IRS-required fields, separate SV/US wording, gift type, and zero-net fully refunded gifts.
- [ ] Add failing immediate-acknowledgment tests for gift type and separation from CDE language.
- [ ] Run the focused tests and record RED evidence.
- [ ] Implement the migration, repository, renderer, send service, and immediate-email changes with no generic abstraction across the two legal lanes.
- [ ] Run `npx vitest run test/worker/stripeAcknowledgment.test.ts test/worker/emailHtml.test.ts test/worker/stripeWebhook.test.ts test/worker/stripeAnnualStatementMigration.test.ts test/worker/stripeAnnualStatement.test.ts test/worker/stripeAnnualStatementRepository.test.ts`.
- [ ] Run `npm run typecheck`, `npm run migrations:check-immutability`, and `git diff --check`.
- [ ] Commit with message `feat: add US annual gift statements`.

---

## Task 3: Add separate U.S. annual reporting to the admin exports UI

**Files:**

- Modify: `src/worker/index.ts`
- Modify: `src/client/types.ts`
- Modify: `src/client/exportsPanel.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css` only if existing export-panel styles are insufficient
- Create: `test/client/stripeAnnualStatementUi.test.ts`
- Create: `test/worker/stripeAnnualStatementRoutes.test.ts`
- Modify: `test/client/accountStateBoundary.test.ts`
- Modify: `test/worker/support/inMemoryD1.ts` only as required by route tests

**API and UI contract:**

- Add authenticated ADMIN routes:
  - `GET /api/statements/stripe/annual?year=YYYY&q=...&after=...`
  - `POST /api/statements/stripe/annual/send?year=YYYY` with either `{ donor }`, `{ after }`, or `{}` using the same strict input shape as the SV route.
- The server derives Stripe livemode from the validated deployment configuration. The browser cannot select or override test/live mode.
- Exports displays a clear country/lane selector or two labeled panels: `El Salvador — CDE` and `EE. UU. — Stripe`. The existing SV behavior remains unchanged.
- U.S. preview rows show donor, gift count, net total, email availability, and send action. Explain that the U.S. statement is a 501(c)(3) acknowledgment and not a Salvadoran CDE dossier.
- Keep separate state, cursors, operation claims, busy keys, search debounce generations, bulk traversal, and stale-response guards for SV and U.S.; one lane must not overwrite or cancel the other lane's state incorrectly.
- Single-donor sends use the same durable snapshot fence as bulk sends: an identical `SENT` or `REVIEW` snapshot is not dispatched again, while a changed/refund-adjusted snapshot may be sent as a corrected statement.

**Steps:**

- [ ] Add failing route tests for OWNER/ADMIN access, invalid year/body/cursor, preview, single send, bulk send, and safe error mapping.
- [ ] Add failing UI/source-contract tests for lane labels, independent API paths/state/cursors/claims, and U.S.-specific explanatory copy.
- [ ] Run focused tests and record RED evidence.
- [ ] Wire the new service to routes, types, exports panel, and App state/actions. Reuse pure helper functions where behavior is identical, but keep lane state and legal copy explicit.
- [ ] Run `npx vitest run test/worker/stripeAnnualStatementRoutes.test.ts test/client/stripeAnnualStatementUi.test.ts test/client/annualCertificateUi.test.ts test/client/accountStateBoundary.test.ts`.
- [ ] Run `npm run typecheck` and `git diff --check`.
- [ ] Commit with message `feat: expose US annual statements in admin`.

---

## Task 4: Wire Stripe configuration and webhook health into `/admin` settings

**Files:**

- Modify: `src/worker/services/credentials.ts`
- Modify: `src/worker/services/stripeDonations.ts`
- Modify: `src/worker/services/stripeClient.ts`
- Modify: `src/worker/storage/repository/stripeDonations.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/worker/types.ts`
- Modify: `src/client/types.ts`
- Modify: `src/client/credentialSettings.ts`
- Modify: `src/client/credentialsPanel.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css` only for the minimal Stripe status layout
- Modify: `test/worker/credentials.test.ts`
- Modify: `test/worker/stripeClient.test.ts`
- Modify: `test/worker/stripeDonations.test.ts`
- Modify: `test/worker/workerFetch.admin-settings.test.ts`
- Modify: `test/client/credentialSettings.test.ts`
- Create: `test/client/stripeSettingsUi.test.ts`

**Safe controls:**

- Add a `Stripe EE. UU.` owner-only settings section and readiness group.
- Report configured/unconfigured status for every runtime value already consumed by the integration:
  - `STRIPE_RESTRICTED_KEY` (protected, write-only replacement)
  - `STRIPE_PUBLISHABLE_KEY` (write-only replacement; status only)
  - `STRIPE_WEBHOOK_SECRET` (protected active secret; status only, never replaced in one unsafe step)
  - `STRIPE_WEBHOOK_SECRET_NEXT` (protected staged secret; write-only stage/cancel/promote workflow)
  - `STRIPE_PAYMENT_METHOD_CONFIGURATION_ID` (write-only replacement; status only)
  - `STRIPE_BILLING_PORTAL_CONFIGURATION_ID` (write-only replacement; status only)
  - `STRIPE_US_LEGAL_NAME` (write-only replacement; status only)
  - `STRIPE_US_EIN` (write-only replacement; status only)
  - `STRIPE_US_TIME_ZONE` (non-secret IANA timezone; current value visible and editable)
- Show `APP_ENV`, Stripe mode (`Simulado`, `Pruebas`, or `Producción`), and local proxy state as read-only operational status. `STRIPE_MOCK_MODE` and `STRIPE_API_PROXY_URL` are deployment/local controls and are not editable from the browser.
- Add the read-only webhook URL derived from the current origin (`/webhooks/stripe`) with a copy button.
- Add safe webhook health from D1: last received timestamp, event type, processing status, livemode match, and a clear `Sin eventos recibidos` state. Return no event payload, donor information, Stripe object IDs, signature, or failure internals.
- Label credential presence as `Configurado`, not provider-verified readiness. Label webhook operation as `Verificado por último evento procesado` only after a successfully processed event matching deployment mode. Payment Method Configuration, Billing Portal Configuration, and connected-account ownership remain `No verificado por la aplicación` until a future explicit provider-check capability exists; do not imply that an ID prefix proves provider/account ownership.
- Owner-entered replacements use the existing Cloudflare bulk-secret writer. Inputs are password/text controls as appropriate, are never prefilled, are cleared after success, and audits contain only changed variable names.
- Webhook-secret rotation is staged: writing `STRIPE_WEBHOOK_SECRET_NEXT` makes signature verification accept either active or staged secret; the UI then offers explicit promote and cancel actions. Promotion atomically writes the staged value to `STRIPE_WEBHOOK_SECRET` and deletes `STRIPE_WEBHOOK_SECRET_NEXT` without returning either value. Cancellation deletes only the staged value. Direct one-step replacement of the active secret is not exposed.
- Add owner-only promotion/cancellation endpoints and tests. A missing staged secret, missing Cloudflare writer, or lost promotion fails without deleting the active secret. Audit metadata records variable names and action only.
- Validate each submitted field before any Cloudflare call. `rk_test_/rk_live_` and `pk_test_/pk_live_` must agree with each other and `APP_ENV`; `whsec_`, `pmc_`, and `bpc_` receive syntactic prefix checks only because those IDs do not encode test/live mode. Validate EIN and nonblank legal name. Partial provisioning is allowed, but a replacement must be checked against any corresponding existing value available in `env`.
- Signature verification tries active and staged webhook secrets and accepts the event once; it must preserve the existing event-id replay fence and never log which secret matched.
- The settings UI must explain that eligible methods and BNPL exclusion are managed by the configured Stripe Payment Method Configuration; do not add browser toggles that pretend to change Stripe Dashboard state.

**Steps:**

- [ ] Add failing credential tests proving all Stripe fields are status-only, secret values never serialize, patches map only nonblank replacements, and invalid or key-mode-mismatched values are rejected before Cloudflare is called.
- [ ] Add failing Stripe gateway tests proving active/staged signature overlap and that logs/responses never identify the matching secret.
- [ ] Add failing route tests for owner-only status, stage/promote/cancel rotation, atomic promotion failure behavior, and safe webhook-health output.
- [ ] Add failing UI tests for the section/nav configured state, replacement fields, visible/editable timezone, staged-secret controls, endpoint copy control, configured-versus-observed labels, mode/health, and post-save clearing.
- [ ] Run focused tests and record RED evidence.
- [ ] Implement the credential status/patch validation, safe health query/API, App state/actions, and settings panel.
- [ ] Run `npx vitest run test/worker/credentials.test.ts test/worker/stripeClient.test.ts test/worker/stripeDonations.test.ts test/worker/workerFetch.admin-settings.test.ts test/client/credentialSettings.test.ts test/client/stripeSettingsUi.test.ts`.
- [ ] Run `npm run typecheck`, `npm run security:check-private-boundary`, and `git diff --check`.
- [ ] Commit with message `feat: add Stripe admin controls`.

---

## Task 5: Document, integrate, and verify the complete feature

**Files:**

- Modify: `README.md`
- Modify: `README.es.md`
- Modify: `docs/stripe-us-giving.md`
- Modify: `docs/runbook-operador.md`
- Modify: `.dev.vars.example`
- Modify: `test/scripts/stripeProvisioningDocs.test.ts`
- Modify: `test/scripts/productionProvisioningDocs.test.ts`
- Modify: `e2e/donar.spec.ts` only for missing cross-task coverage
- Modify other files only when a full-suite regression directly requires it; document why in the task report

**Documentation and verification contract:**

- Document the two donor choices, one-time/monthly behavior, Embedded Checkout session creation, verified webhooks, custom immediate acknowledgments, U.S. annual statements, and separate SV CDE dossiers.
- Document each Stripe admin field, least-privilege key expectations, staged dual-secret webhook rotation, webhook URL/events, and the external Stripe Dashboard handoff for Payment Method Configuration and BNPL exclusion.
- Document local/test setup only with placeholders. Never commit real keys, webhook secrets, account IDs, donor data, or local private artifact paths.
- Explicitly state that code and local deterministic tests do not change the live Stripe account, and that live Payment Method Configuration/webhook registration remains an owner cutover step.

**Steps:**

- [ ] Add/update failing docs contract tests before editing documentation.
- [ ] Update English and Spanish docs as mirrors and update the operator runbook.
- [ ] Run focused docs tests.
- [ ] Run `npm test`.
- [ ] Run `npm run build`.
- [ ] Run `npm run types:check`.
- [ ] Run `npm run security:check-private-boundary` and `npm run migrations:check-immutability`.
- [ ] Stop any stale preview on port 8787, then run full Playwright with `DIEZMOSSV_ENV_FILE=.dev.vars.ci` and a fresh temporary `PW_PERSIST_TO` directory.
- [ ] Run `git diff --check`, inspect `git status --short`, and scan the exact branch diff for secret-like Stripe values and forbidden donor-facing vocabulary.
- [ ] Record every command and outcome in the task report, including any test that could not run and why.
- [ ] Commit with message `docs: complete Stripe giving operations`.

---

## Final Whole-Branch Acceptance

- U.S. donors can visibly choose Diezmo/Ofrenda and Única/Mensual on Step 1; Step 2 shows all three selected values and Stripe's Spanish Embedded Checkout.
- The server refuses missing/tampered gift types and persists the verified selection through session, webhook, gift, acknowledgment, and annual statement.
- SV donors still use Wompi/CDE and receive the existing Salvadoran email/dossier; U.S. donors receive U.S.-entity acknowledgments/statements with no CDE claim.
- Admin exports separates `El Salvador — CDE` from `EE. UU. — Stripe` reporting.
- Admin settings covers every Stripe runtime input, write-only rotations, safe mode/config status, webhook URL, and webhook health without returning secrets.
- Full unit/integration, build, private-boundary, migration, and Playwright checks pass from the isolated worktree.
- No live Stripe account mutation or deployment occurred.
