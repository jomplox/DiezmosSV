# Payment Provider UX and Receipt Refinement Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the regressions observed during the first production donation tests,
prove each fix with behavior-level regression coverage, and publish only the final
reviewed commit to the Cloudflare staging Worker for owner testing.

**Architecture:** Keep the existing El Salvador/Wompi and United States/Stripe or
Givebutter boundaries. Treat branding as a tri-state load instead of assuming the
stock mark while public branding is unresolved; repair only absent legacy email
template keys while retaining corruption fences; keep one stable loading surface
for each external provider; normalize the configured FMCE legal name only at display
boundaries; and retain Stripe webhook-driven Elim acknowledgments as the sole
application email path. Stripe's own successful-payment email is controlled by an
account-level Dashboard setting, so code and documentation can prove the application
does not force a Stripe receipt, but the live Dashboard toggle remains a separate
production operation after the user's freeze is lifted.

**Tech Stack:** React 19, TypeScript, Vite, Cloudflare Workers, D1/SQLite,
Stripe Embedded Checkout, Vitest, Playwright, pdf-lib, Wrangler.

## Global Constraints

- Work only in the isolated worktree
  `/Users/josevega/Documents/CCRTV/DiezmosSV/.worktrees/payment-ux-refinement`
  on `codex/refine-donor-payment-ux`; preserve the user's primary checkout and its
  untracked `output/` directory.
- Begin from reviewed production base
  `be1446082daa2cc26eec977735a3a0310f490f1f`.
- Use test-driven development for every behavior change: write the narrow failing
  regression, observe the expected RED, implement the smallest fix, rerun GREEN,
  and mutation-check regression guards that protect behavior not reliably failing
  at the current base.
- Prefer observable DOM, API, database, generated-PDF, or request-payload assertions.
  Do not add source-string tests for user-visible behavior. Replace touched
  source-contract assertions with behavior coverage where practical.
- Donor-facing Spanish must use `usted`, preserve the ceremonial
  “Diezmos y Ofrendas” title, describe a voluntary gift/entrega, and contain none of
  the transactional vocabulary forbidden by `AGENTS.md`.
- Do not change the payment identity, idempotency, fiscal environment, webhook,
  checkout ownership, or provider-origin security boundaries while improving UX.
- The stock logo may render only after branding has definitively resolved to no
  usable donor logo or failed. While branding is unresolved, reserve stable logo
  space without rendering the stock SVG; a configured logo must be decoded before it
  is shown.
- Preserve explicit provider choice and the current gift type, frequency, amount,
  Stripe request ID/session reuse, Givebutter fund mapping, and Wompi intent while
  refining loading presentation.
- The exact FMCE display spelling is `Friends of Misión Cristiana Elim`. Preserve the
  stored secret as canonical deployment data; normalize the known all-caps/unaccented
  FMCE value at shared read/display boundaries without applying generic title casing
  to other organizations.
- Keep the exact IRS identity, EIN, donor facts, receipt evidence, and one-page PDF
  contract intact. A PDF layout change must bump its renderer version and retain
  compatibility with frozen older evidence.
- The application must not set `receipt_email` or otherwise force a Stripe receipt.
  Stripe documents “Successful payments” as an account-level Customer emails setting;
  disabling that live toggle is deliberately out of scope while production is frozen.
- README changes must be mirrored in `README.md` and `README.es.md` in the same commit.
- Never edit an applied D1 migration. This plan is expected to require no migration.
- Each implementation task ends with focused tests and `git diff --check`; the final
  integrated gate uses the exact final commit.
- Do not mutate production: no production Worker deploy, D1 write/migration, secret
  change, Stripe Dashboard change, email setting change, or live-donor probe.
- Do not mutate staging until every task review and the final whole-branch review are
  clean. Staging must remain `emission_environment=00`, and deployment must use the
  repository's private wrappers without exposing private identifiers.

---

## Task 1: Prevent the stock-logo flash on donor routes

**Files:**

- Modify: `src/client/branding.ts` or add one narrowly scoped donor-branding helper
- Modify: `src/client/donarPage.tsx`
- Modify: `src/client/stripeResultPage.tsx`
- Modify: `src/client/donorReady.ts` and `src/client/main.tsx` only if the reveal
  contract needs a small interface change
- Modify: `src/client/styles.css`
- Modify: `test/client/donarPage.test.ts` and/or a new focused client behavior test
- Modify: `e2e/donar.spec.ts`

**Contract:**

- Branding has three explicit states: unresolved, resolved with a decoded configured
  donor logo, or resolved without a usable configured logo.
- Neither `/donar` nor `/donar/stripe/resultado` renders the built-in stock SVG while
  branding is unresolved. If the 1.5 second global reveal budget expires first, the
  page may become visible with stable reserved logo space, but not with the stock logo.
- A configured donor logo is fetched/decoded before committing it to the visible tree,
  and the stock SVG is never visible before or after it on that load.
- When branding definitively has no configured donor logo, or the branding request
  itself fails, the existing stock logo and neutral fallback remain available. If the
  API reports a configured logo but that image cannot decode, retain stable empty logo
  space rather than substituting the stock identity. No failure may strand the page.
- The real logo's accessible name, configured organization name, and support email
  still settle correctly on both donor routes.

**Steps:**

- [ ] Add a delayed-branding Playwright regression that holds `/api/branding` past the
  reveal budget, records rendered logo nodes, then releases a valid donor logo and
  proves no stock SVG was ever rendered while the configured image becomes visible.
- [ ] Cover both `/donar` and `/donar/stripe/resultado`; add no-logo/request-failure
  controls proving the stock fallback appears only after resolution, plus a configured
  image-decode failure proving the stock identity remains absent.
- [ ] Implement the smallest shared tri-state/decode boundary and stable placeholder.
- [ ] Temporarily restore the unresolved-as-stock behavior and prove the regression
  fails, then restore the fix.
- [ ] Run focused client and Playwright tests, `npm run typecheck`, and
  `git diff --check`.

---

## Task 2: Let a legacy two-template row save El Salvador first

**Files:**

- Modify: `src/worker/services/emailTemplates.ts`
- Modify: `test/worker/emailTemplates.test.ts`
- Modify: `test/worker/workerFetch.admin-settings.test.ts`
- Modify: `e2e/adminUiCoverage.spec.ts` only for a mounted first-save regression

**Contract:**

- A legacy stored row that contains only the two valid `SV_CDE` definitions can save
  `SV_CDE` immediately; it does not require a `US_STRIPE` save to repair the row first.
- Missing definitions in the untouched scope are filled from the current defaults in
  the same atomic scoped save. Existing valid customizations in either scope survive.
- Explicitly present but malformed/invalid untouched-scope values remain a 409
  `email_templates_reload_required` conflict with no setting write and no audit.
- Malformed JSON, non-object state, bounded CAS retries, concurrent opposite-scope
  saves, and settings-plus-audit atomicity retain their current protections.
- The successful response contains all five normalized templates, and a fresh GET
  proves the first Salvadoran edit persisted.

**Steps:**

- [ ] Add a real route/database regression seeded with the observed two-key legacy
  JSON; submit the Salvadoran scope first and observe the current 409 RED.
- [ ] Add controls for preserving a valid U.S. customization and rejecting an
  explicitly invalid U.S. template.
- [ ] Implement missing-key default completion before scoped validation without
  weakening corruption or CAS fences.
- [ ] Mutation-check by restoring the strict missing-key behavior and observing the
  first-SV-save regression fail.
- [ ] Run focused email-template service/route tests, mounted coverage if changed,
  `npm run typecheck`, and `git diff --check`.

---

## Task 3: Make external-provider loading and confirmation transitions stable

**Files:**

- Modify: `src/client/donation.ts`
- Modify: `src/client/donarPage.tsx`
- Modify: `src/client/stripeDonationForm.tsx`
- Modify: `src/client/stripeResultPage.tsx`
- Modify: `src/client/styles.css`
- Modify: `test/client/donarPage.test.ts`
- Modify: `test/client/stripeDonation.test.ts`
- Modify: `e2e/donar.spec.ts`

**Contract:**

- Wompi never flashes the large primary “Continuar en Wompi” fallback. It presents one
  quiet, single-line underlined escape hatch—`¿Problemas con el formulario? Continúe
  aquí`—and keeps the embedded intent alive while a stable loader covers initial delay.
- Wompi's iframe, close/3DS semantics, intent polling, no-auto-redirect rule, and
  same-intent duplicate-payment fence remain unchanged.
- Stripe shows `Preparando su formulario seguro con Stripe…` continuously from the
  Checkout Session request through Stripe Embedded Checkout iframe insertion/readiness;
  it does not replace the loader with an unexplained blank box after the session API
  resolves. The existing early Checkout Session creation remains the primary speedup.
- Givebutter shows the same stable visual loading language (spinner or skeleton plus
  truthful provider-specific text) until its frame loads or the current bounded timeout
  exposes the existing escape hatch. It retains the selected fund, amount, and frequency.
- The U.S. door may add provider preconnects only after the donor selects that lane;
  the chooser must not contact Stripe or Givebutter early. Do not pre-create additional
  provider objects or sessions as a speed optimization.
- The Stripe result page does not replace or restart its visible checking spinner for
  repeated `OPEN`/`PENDING` polls. It updates visible result state only for a meaningful
  terminal transition or timeout.
- All loaders have one persistent `role=status` announcement, smooth continuous motion,
  and a non-animated but still understandable `prefers-reduced-motion` presentation.

**Steps:**

- [ ] Add Playwright delay controls for Wompi, Stripe Session plus Stripe iframe mount,
  Givebutter, and repeated Stripe result `PENDING` polls. Assert DOM-node continuity,
  one status announcement, provider-specific copy, and absence of the large Wompi CTA.
- [ ] Add a Stripe result transition helper/test if needed so repeated pending snapshots
  are a no-op but `PAID`, `FAILED`, `EXPIRED`, and timeout still render.
- [ ] Implement only the loader lifecycle, quiet Wompi fallback, lane-scoped preconnect,
  and meaningful-result-state changes; retain all payment/idempotency boundaries.
- [ ] Mutation-check the Wompi CTA absence and at least one delayed-provider loader
  assertion.
- [ ] Run focused donor/Stripe client tests, the provider Playwright cases with a fresh
  `PW_PERSIST_TO`, `npm run typecheck`, and `git diff --check`.

---

## Task 4: Correct the FMCE legal-name display and U.S. receipt spacing

**Files:**

- Modify: `src/shared/stripeUsConfiguration.ts`
- Modify: `src/worker/services/stripeDonations.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/worker/services/stripeAcknowledgment.ts`
- Modify: `src/worker/services/stripeAnnualStatement.ts` only if renderer-version
  compatibility or a direct display call requires it
- Modify: `test/worker/stripeDonations.test.ts`
- Modify: `test/worker/workerFetch.admin-settings.test.ts`
- Modify: `test/worker/stripeAcknowledgment.test.ts`
- Modify: `test/scripts/stripePdfPreviews.test.ts`

**Contract:**

- The known configured variants `FRIENDS OF MISION CRISTIANA ELIM` and
  `FRIENDS OF MISIÓN CRISTIANA ELIM` display exactly as
  `Friends of Misión Cristiana Elim` in owner-visible configuration, immediate email,
  immediate/refund PDF, and any annual evidence/output that displays the legal name.
- Do not apply generic title casing: unrelated legal names, punctuation, suffixes, and
  accents pass through unchanged. Do not silently rewrite the stored Cloudflare secret.
- The immediate/refund PDF contact line and mailing-address line move visibly farther
  down from both legal-information columns. The closest rendered glyph bounds retain a
  minimum 12-point vertical gap, the lines remain centered and above the gray scripture
  footer, and the document stays one U.S. Letter page.
- Receipt text, amount, payment method, donor identity, EIN, signer, no-goods/services
  statement, Spanish legal paragraph, and immutable evidence behavior remain unchanged.
- Bump the immediate receipt renderer version for the layout change and accept/finalize
  frozen v6 evidence through the existing legacy-version path.

**Steps:**

- [ ] Add pure normalization tests for both FMCE variants and non-FMCE controls; add an
  owner-settings response test using the all-caps live-shaped value.
- [ ] Add PDF draw-coordinate/glyph-bound assertions proving at least 12 points between
  legal copy and contact copy, plus centered/single-page/footer controls; render a preview
  for visual inspection.
- [ ] Implement the exact-match display normalizer at shared configuration read
  boundaries and adjust only the contact layout/renderer compatibility needed.
- [ ] Mutation-check the all-caps mapping and the geometric gap guard.
- [ ] Run focused Stripe configuration, route, PDF, preview, annual compatibility,
  `npm run typecheck`, and `git diff --check`.

---

## Task 5: Make the Stripe receipt-email boundary explicit and release-safe

**Files:**

- Modify: `test/worker/stripeDonations.test.ts`
- Modify: `docs/stripe-us-giving.md`
- Modify: `README.md`
- Modify: `README.es.md`
- Modify: `test/scripts/stripeProvisioningDocs.test.ts`

**Contract:**

- One-time and monthly Checkout Session payload tests explicitly prove the application
  never sends `receipt_email`, including nested PaymentIntent, subscription, invoice,
  and customer fields that could force a provider receipt.
- Documentation states that collecting `customer_details.email` for Elim's webhook
  acknowledgment is separate from Stripe's automatic email setting.
- Documentation records the official production action: Dashboard → Settings →
  Business → Customer emails → Payments → disable `Successful payments`; verify with
  one controlled donation that exactly one Elim-branded acknowledgment arrives.
- The runbook warns that this is an account-level live behavior change, cannot be
  accomplished per Checkout Session by omitting `receipt_email`, and must not be made
  during this production freeze. It also preserves required subscription service emails
  that are distinct from successful-payment receipts unless separately approved.
- English and Spanish README instructions remain true mirrors. No secret or live account
  identifier enters source, tests, logs, or commits.

**Steps:**

- [ ] Add failing documentation/shape guards for the complete no-forced-receipt contract
  and the mirrored operator instruction.
- [ ] Strengthen the existing Checkout payload assertions and mutation-check by adding a
  synthetic `receipt_email` to prove the guard fails without printing an address.
- [ ] Add the official account-level suppression and verification procedure to the
  Stripe runbook and both READMEs.
- [ ] Run focused Stripe payload and provisioning-document tests, `npm run typecheck`,
  and `git diff --check`.

---

## Integrated verification before release

**Files:**

- Modify no production code unless a focused failure exposes a regression; any fix
  discovered here must be committed separately and included in review.

**Contract:**

- All five task suites, the full Vitest suite, build/typechecks, private-boundary guard,
  migration immutability, and changed Playwright cases pass on one exact clean commit.
- Fresh browser runs cover the donor chooser, Wompi delay, Stripe delay/result, Givebutter
  delay, branding delay, and the mounted template first-save path without stale D1 state.
- Generated PDF preview is visually inspected for contact spacing and exact legal-name
  display. No private identifier or donor data is retained in artifacts or output.

**Steps:**

- [ ] Run all focused task suites and changed Playwright tests with a fresh
  `PW_PERSIST_TO`, then `npm test`, `npm run build`, migration immutability,
  `npm run security:check-private-boundary`, and `git diff --check`.
- [ ] Review the exact branch diff for unintended files, secrets, source-string-only
  behavior guards, and donor-language violations.
- [ ] Record the final exact SHA and keep the worktree clean.

## Post-review staging release (controller only)

After every task review and the final whole-branch review are clean:

- Capture the current staging version as a rollback anchor without printing its private
  identifier in chat.
- Verify the authenticated staging target, `emission_environment=00`, pending migrations,
  annual-delivery claim state, and Worker health. Stop on any mismatch.
- Apply only repository-supported pending append-only migrations if any; this plan expects
  none.
- Deploy the exact reviewed SHA with `npm run cf:deploy:staging`; never use a production
  command or change the Stripe live Customer emails setting.
- Postflight the canonical staging URL for branding, template first-save, Wompi/Stripe/
  Givebutter loaders, legal-name presentation, health, version identity, and unchanged
  test fiscal policy.
- Report the still-pending production-only Stripe Dashboard toggle and require a separate
  owner-approved production window before changing it.
