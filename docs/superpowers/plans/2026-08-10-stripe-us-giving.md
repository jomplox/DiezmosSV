# Stripe U.S. Giving Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Givebutter only on the EE. UU. 501(c)(3) donation door with the connected U.S. nonprofit Stripe account, supporting one-time and monthly USD gifts in Spanish through every eligible donor-safe dynamic payment method while excluding BNPL, without changing El Salvador's Wompi/DTE lane.

**Architecture:** The donor app creates an idempotent server-side Stripe Checkout Session and redirects to Stripe's hosted, Spanish-localized page. Stripe decides which eligible methods to show through a dedicated payment-method configuration; application code never hard-codes a method list. Signed webhooks are the source of truth for settled gifts, monthly renewals, failures, expirations, refunds, and subscription cancellation. Append-only D1 tables retain sanitized checkout, event, gift, and acknowledgment-delivery state. A Spanish result page reads server-projected state, and recurring donors can enter a Spanish Stripe Customer Portal. Existing Wompi/DTE code remains isolated and unchanged.

**Tech Stack:** React 19, TypeScript 7, Cloudflare Workers, D1, Stripe Node SDK 22.5.0 / API `2026-07-29.dahlia`, Vitest, Playwright, existing email provider.

## Locked Constraints

- Stripe is only the EE. UU. 501(c)(3) lane. El Salvador remains Wompi and its fiscal/DTE behavior must not change.
- Use the connected U.S. nonprofit account. Do not provision a second Stripe account or use Connect.
- Support exactly one-time and monthly gifts in USD.
- Use hosted Checkout Sessions with dynamic payment methods. Do not send `payment_method_types`.
- A dedicated Stripe payment-method configuration is the sole live-account control for excluding financing methods. Application code does not maintain a positive allowlist.
- Do not enable Affirm, Afterpay/Clearpay, Klarna, or another BNPL/financing method.
- Preserve all donor-facing doctrinal language: `entrega`, `donación`, `diezmo`, `ofrenda`, and usted form. Never introduce forbidden transactional vocabulary in app-owned copy.
- Keep the ceremonial `Diezmos y Ofrendas` heading on every donor step.
- Never expose Stripe secrets, webhook bodies, donor PII, Checkout capability URLs, customer IDs, or financial identifiers in logs.
- Use a restricted Stripe key in deployments, with separate test and live values. Verify Stripe event livemode against the deployment environment.
- Do not deploy Cloudflare, change live Stripe settings, create live Portal/payment-method configurations, or accept a live gift during implementation. Those are owner handoffs after sandbox gates pass.
- Add only append-only migration `0032`; never alter historical migrations.
- Mirror documentation changes between `README.md` and `README.es.md`.
- Use `rtk` for every shell command and `apply_patch` for repository edits.
- Write each behavioral test first and record the expected failure before production code.
- Before any public push or PR, run migration immutability, the private-boundary guard, and the available OpenAI Privacy Filter on the exact payload. Never use `gpt-oss:20b`.

## Observable Completion Contract

1. Selecting EE. UU., an amount, and one-time or monthly creates one idempotent Checkout Session and redirects to a Spanish Stripe-hosted URL.
2. Checkout requests include the configured payment-method configuration and omit `payment_method_types`; wallets and eligible present/future donor-safe methods can appear without a code release, while BNPL remains an account-configuration exclusion.
3. A forged, malformed, wrong-environment, duplicate, or out-of-order webhook cannot create a gift or duplicate an acknowledgment.
4. A settled one-time gift and every settled monthly invoice create exactly one durable gift record and one Spanish 501(c)(3) acknowledgment delivery attempt.
5. The Spanish result page distinguishes pending, completed, failed, expired, and canceled states without trusting query-string state; monthly donors can open the configured Spanish Customer Portal.
6. Donation intake shutdown blocks creation of new Stripe Checkout Sessions but leaves webhooks, status reads, acknowledgments, and Portal access operational.
7. No Givebutter runtime code, configuration, or deployment requirement remains. Historical migrations and legitimate historical plan documents remain immutable.
8. Existing Wompi tests and targeted Wompi source hashes show the El Salvador lane was not behaviorally edited.

---

### Task 1: Append-only Stripe persistence

**Files:**
- Create: `migrations/0032_stripe_us_donations.sql`
- Create: `test/worker/stripeMigration.test.ts`
- Create: `src/worker/storage/repository/stripeDonations.ts`
- Modify: `src/worker/storage/repository.ts`

**Interfaces:**
- Checkout records keyed by a client UUID and Stripe Checkout Session ID.
- Webhook-event ledger keyed by Stripe event ID, with processing outcome and no raw payload.
- Gift records uniquely keyed by settled Stripe source (`payment_intent` for one-time or `invoice` for recurring).
- Acknowledgment deliveries with claim/retry outcome semantics compatible with the existing scheduled maintenance loop.

- [ ] Write a migration test against both a fresh database and the latest pre-0032 upgrade state. Assert columns, foreign keys, uniqueness, indexes, and legal state checks.
- [ ] Run it before adding the migration and record RED because `0032` and its tables are absent.
- [ ] Add the migration and focused repository operations for reserve/finalize/fail Checkout creation, session lookup, event claim/finalization, gift upsert, subscription status, refund state, and acknowledgment claims.
- [ ] Run the migration/repository tests GREEN and run the migration immutability guard.

### Task 2: Stripe request contracts and environment safety

**Files:**
- Create: `src/worker/services/stripeClient.ts`
- Create: `src/worker/services/stripeDonations.ts`
- Create: `test/worker/stripeDonations.test.ts`
- Modify: `src/worker/types.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- `createStripeCheckout(input, requestContext)` validates amount/frequency and produces a hosted Session.
- `retrieveStripeCheckout(sessionId)` projects only donor-safe status.
- `createStripePortal(sessionId)` returns a short-lived hosted Portal URL only for an associated monthly donor/customer.
- `verifyStripeWebhook(rawBody, signature)` verifies against the exact raw bytes.

- [ ] Write pure contract tests first. Assert USD cents, one-time/payment versus monthly/subscription mode, Spanish locale, `submit_type: donate`, runtime organization branding, required name/address, metadata without PII, deterministic integration identifier, request idempotency key, payment-method configuration inclusion, and absence of `payment_method_types` and BNPL lists.
- [ ] Cover restricted/test/live key validation, missing legal acknowledgment configuration, missing Portal/configuration IDs, wrong Stripe livemode, malformed identifiers, amount bounds, and mock-mode determinism.
- [ ] Run RED because the Stripe services and SDK are absent.
- [ ] Add exact `stripe@22.5.0`, implement the smallest client/service boundary, and rerun GREEN.
- [ ] Mutation-check the dynamic-method guard by temporarily adding `payment_method_types`, prove the test fails, then restore it.

### Task 3: Public APIs, signed webhook processing, and shutdown behavior

**Files:**
- Create: `test/worker/stripeRoutes.test.ts`
- Create: `test/worker/stripeWebhook.test.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/worker/services/scheduledMaintenance.ts`

**Routes:**
- `POST /api/donations/stripe/checkout`
- `GET /api/donations/stripe/session/:sessionId`
- `POST /api/donations/stripe/portal`
- `POST /webhooks/stripe`

- [ ] Write route tests first using SQLite D1 and the deterministic Stripe mock boundary. Cover JSON/same-origin controls, body limits, rate limiting, retry of the same client UUID, conflicting replay, sanitized errors, canonical origins, and intake shutdown.
- [ ] Write webhook tests first for signature rejection, body limit, environment mismatch, duplicate event IDs, retry after failed processing, and out-of-order events.
- [ ] Cover `checkout.session.completed`, async success/failure, expiration, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, and `charge.refunded`.
- [ ] Prove one-time Checkout completion and each recurring invoice create one gift only; prove duplicate/reordered delivery never duplicates gifts.
- [ ] Run RED because routes and webhook dispatch do not exist.
- [ ] Implement routes before the generic document handler, preserve raw webhook bytes, schedule durable follow-up with `waitUntil`, and extend maintenance only for pending acknowledgment work.
- [ ] Run focused route/webhook tests GREEN plus existing Wompi worker tests.

### Task 4: Spanish 501(c)(3) acknowledgment

**Files:**
- Create: `src/worker/services/stripeAcknowledgment.ts`
- Create: `test/worker/stripeAcknowledgment.test.ts`
- Modify: `src/worker/services/email.ts`
- Modify: `src/worker/services/emailHtml.ts`

**Content contract:**
- Spanish donor language and usted form.
- Legal organization name, EIN, settled date, USD amount, gift frequency/reference, and statement that no goods or services were provided in exchange.
- No Stripe secret/customer/payment identifiers in the subject or visible content.

- [ ] Write rendering and delivery-state tests first, including HTML escaping, missing donor email, provider success, known-safe retry, unknown provider outcome, and idempotency header behavior.
- [ ] Run RED because the acknowledgment renderer/delivery method is absent.
- [ ] Implement a first-party Spanish acknowledgment using the existing email provider and durable claim/outcome protocol.
- [ ] Integrate webhook settlement and scheduled retry, then run focused email/webhook tests GREEN.
- [ ] Mutation-check the acknowledgment's no-goods-or-services assertion and donor-vocabulary guard.

### Task 5: Replace the Givebutter donor flow with Stripe

**Files:**
- Modify: `src/client/donation.ts`
- Modify: `src/client/donarPage.tsx`
- Create: `src/client/stripeResultPage.tsx`
- Modify: `src/client/App.tsx`
- Modify: `src/client/main.tsx`
- Modify: `src/client/styles.css`
- Modify: `test/client/donation.test.ts`
- Modify: `test/client/donarPage.test.ts`
- Create: `test/client/stripeResultPage.test.tsx`

**Flow:**
- EE. UU. step 1 retains frequency and custom amount selection.
- Step 2 presents a Spanish summary and explicit `Continuar con Stripe` action.
- The client supplies a stable UUID for retries and then navigates to the returned hosted URL.
- `/donar/stripe/resultado?session_id=...` reads server state, polls pending states with a bound, and offers Portal access for monthly donors.

- [ ] Replace Givebutter-focused unit expectations with Stripe flow expectations and run RED before client implementation.
- [ ] Add status/result-page tests for pending, completed, failed, expired, invalid/missing session ID, network retry, and Portal navigation.
- [ ] Extend the forbidden donor-vocabulary guard to every new Stripe donor-facing source.
- [ ] Remove iframe/hosted-fallback logic and implement the minimal redirect/result UI while preserving the h1, back navigation, runtime branding, and U.S. safety-net routing.
- [ ] Remove obsolete Givebutter styles and run all client tests GREEN.
- [ ] Mutation-check the new donor copy guard by temporarily inserting a forbidden term, prove RED, then restore.

### Task 6: Browser regression coverage

**Files:**
- Modify: `e2e/donar.spec.ts`
- Modify if needed: existing Playwright mock helpers only.

- [ ] Add a failing EE. UU. browser scenario for one-time and monthly choices, request payload, loading state, redirect, Spanish return states, retry, and Portal action.
- [ ] Assert no Givebutter iframe/request appears and no Wompi intent is created from the explicit EE. UU. door.
- [ ] Preserve existing SV/Wompi scenarios unchanged and run RED before adjusting the implementation/test mock boundary.
- [ ] Run focused Playwright GREEN using a fresh `PW_PERSIST_TO` directory and no stale preview on port 8787.

### Task 7: Configuration, operations, and Givebutter removal

**Files:**
- Modify: `.dev.vars.example`
- Modify: `wrangler.toml`
- Modify: `README.md`
- Modify: `README.es.md`
- Modify: relevant deployment/config validation scripts and tests
- Remove: runtime/deployment references to `VITE_GIVEBUTTER_CAMPAIGN`

- [ ] Write documentation/config tests first that require both language mirrors, safe placeholders only, restricted key guidance, webhook endpoint/events, API version, test/live separation, dynamic-method configuration, BNPL exclusion validation, Portal setup, legal name/EIN, key rotation, rollback, sandbox smoke checks, and owner handoff.
- [ ] Run RED while Givebutter remains.
- [ ] Replace deployment configuration with Stripe server secrets/configuration IDs. Keep actual account IDs, key values, webhook secrets, live URLs, and configuration IDs private.
- [ ] Document that Cash App and other methods appear only when Stripe marks the account/session/customer/device eligible; dynamic methods are not a guarantee that every method appears for every donor.
- [ ] Document live handoff: create/verify a payment-method configuration with financing disabled, create a Spanish-compatible Portal configuration, register webhook endpoint/events, apply secrets, disable duplicate generic Stripe receipt email if appropriate, and execute a controlled test/live cutover.
- [ ] Remove Givebutter code/config/docs and rerun docs/config tests GREEN.

### Task 8: Full verification and handoff

- [ ] Run focused Stripe tests and migration upgrade tests.
- [ ] Run `rtk npm test`.
- [ ] Run `rtk npm run build`.
- [ ] Run focused `rtk npx playwright test` with a fresh D1.
- [ ] Run migration immutability and private-boundary guards.
- [ ] Search the exact diff for Givebutter runtime references, `payment_method_types`, hard-coded organization/account identifiers, secrets, financial identifiers, forbidden donor vocabulary, and edits to Wompi/DTE source.
- [ ] Run the available OpenAI Privacy Filter on the exact public payload if a push/PR is requested; otherwise record it as a publication gate not yet triggered.
- [ ] Confirm no Cloudflare deploy or Stripe live mutation occurred.
- [ ] Produce an owner handoff that separates verified local behavior from live-account actions and a rollback plan that restores the previous deployment without rolling back D1.

## Owner-only live handoff (not authorized in this implementation)

1. In Stripe test mode, create a payment-method configuration for the connected U.S. account with dynamic eligible methods enabled and all financing/BNPL methods disabled; capture its private configuration ID.
2. Create and localize a Customer Portal configuration that permits safe subscription cancellation and donor-visible history without unsupported plan switching; capture its private configuration ID.
3. Register the Worker webhook endpoint and the exact implemented event set; store the signing secret and restricted API key through the private deployment wrapper.
4. Apply legal name/EIN acknowledgment values privately, run card/wallet/ACH and asynchronous-method sandbox tests, webhook replay tests, monthly renewal simulation, Portal cancellation, and email acknowledgment review.
5. Repeat configuration in live mode, perform a controlled low-value real gift only with explicit authorization, verify the webhook/D1/email/browser postflight, then remove Givebutter deployment configuration.
