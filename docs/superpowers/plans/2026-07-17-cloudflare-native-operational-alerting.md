# Cloudflare-Native Operational Alerting Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development`
> to implement this plan one task at a time, with a fresh implementer and a
> task-scoped reviewer for every task.

**Goal:** Replace the application-managed Slack/Discord operational-alert
transport with privacy-safe Cloudflare Workers Observability events and native
Cloudflare email notifications, while preserving DiezmosSV's existing in-app
failure UI and its configurable operational-alert email.

**Architecture:** DiezmosSV emits one small structured `operational_alert` event
when an operational incident is raised. Workers Logs persists and indexes that
event, a Workers Observability alert detects it, and Cloudflare Notifications
sends the account-level email. The event contains only fixed operational
metadata; incident details remain in D1 and the authenticated admin UI. Existing
app email alerts retain their durable per-incident/per-recipient claim. The old
Slack/Discord fetch path and configuration disappear.

**Tech Stack:** TypeScript, Cloudflare Workers, Workers Logs/Observability,
Cloudflare Notifications, Vitest, Wrangler.

**Base:** `2891804204b4afc7d262218fa49fd8c363ab1748`

## Supersession

This plan supersedes only the Slack/Discord webhook portions of
`2026-07-17-email-delivery-reliability.md` and its design document. Those files
remain historical execution records. The email-delivery claim model, UI
recovery work, app email alerts, and all other decisions in that work remain in
force.

## Global Constraints

- Deploy only the `staging` Worker in this work. Do not deploy production.
- Keep the existing configurable app email alert and its durable delivery
  claim. Cloudflare Notifications is the independent channel.
- Never log donor data, document/control numbers, entity IDs, incident IDs,
  email addresses, URLs, raw provider responses, exception messages, stacks,
  credentials, or secrets.
- Persisted Worker error logs may contain only a stable event name, deployment
  environment, and sanitized error class/code tokens.
- Enable Workers Logs at a 100% head sampling rate so an operational incident
  cannot be sampled away. Configure all Wrangler environments for future
  parity, but deploy staging only.
- Do not add a diagnostic HTTP endpoint merely to manufacture an alert.
- Do not edit or rebuild the applied `0025_email_delivery_recovery.sql`
  migration. Its legacy `webhook` channel value and any historical rows remain
  readable; new runtime code may create only `email` alert deliveries.
- Remove only the operational Slack/Discord webhook. Wompi payment webhooks and
  Cloudflare-owned notification mechanisms are unrelated and must remain.
- Keep the implementation dependency-free and use the existing repository and
  alert-email machinery.
- Every code task must use TDD and must commit its own reviewed result directly
  on the established `main` workflow.
- In this sandbox, run the suite with
  `MINIFLARE_CACHE_DIR=/private/tmp/diezmos-miniflare-tests`; without that
  override two otherwise-green private-file tests cannot create their
  out-of-repository cache.

---

## Task 1: Add privacy-safe Cloudflare observability events

**Files:**

- Create: `src/worker/services/observability.ts`
- Create: `test/worker/observability.test.ts`
- Modify: `src/worker/services/alerts.ts`
- Modify: `src/worker/services/pipeline.ts`
- Modify: `src/worker/services/retention.ts`
- Modify: `src/worker/index.ts`
- Modify: `test/worker/alerts.test.ts`
- Modify: `wrangler.toml`

### Step 1: Write failing observability tests

Add focused tests proving:

1. `logWorkerError(env, event, error)` writes one structured error object with
   the stable event, normalized `app_env`, and sanitized error name/code only.
2. Error messages, stacks, URLs, addresses, document IDs, and arbitrary object
   fields never enter the log object.
3. `sendOperationalAlert` emits an `operational_alert` event even when no app
   alert-email recipient is configured.
4. The operational event includes only `event`, `app_env`, `alert_kind`, and
   `entity_type`; it excludes title, detail, entity ID, and incident ID.
5. Runtime Worker source has no direct `console.error` calls outside the
   observability helper.
6. Root, staging, and production Wrangler configurations enable Workers Logs
   with `head_sampling_rate = 1`.

Run:

```bash
rtk npm test -- test/worker/observability.test.ts test/worker/alerts.test.ts
```

Expected: FAIL because the helper/configuration do not exist and
`sendOperationalAlert` does not yet emit the native event.

### Step 2: Implement the minimal safe logging helper

Create a small helper that:

- calls `console.error` with a JSON object;
- normalizes event/environment/error name/error code to short token characters;
- accepts an unknown error but never serializes its message, stack, enumerable
  properties, or nested values;
- has a dedicated operational-alert function whose shape is fixed and excludes
  incident identity and human-readable alert text.

Do not create a generic arbitrary metadata bag.

### Step 3: Route runtime errors through the helper

Replace every direct `console.error` in `src/worker` with a stable event name and
the safe helper. Preserve existing control flow exactly. Do not change
application errors, HTTP responses, audits, retry behavior, or alert behavior.

Call the operational-alert logger near the start of `sendOperationalAlert`,
after the non-empty incident guard and before any D1 or email operation, so an
email/D1 outage cannot hide the native signal.

### Step 4: Enable Workers Logs

Add explicit root, staging, and production observability blocks to
`wrangler.toml`:

```toml
[observability]
enabled = true
head_sampling_rate = 1
```

Use the equivalent environment-qualified tables for staging and production.
Do not enable traces or external telemetry destinations.

### Step 5: Run focused and full verification

Run:

```bash
rtk npm test -- test/worker/observability.test.ts test/worker/alerts.test.ts
rtk npm run typecheck
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmos-miniflare-tests npm test
```

Expected: all pass, with only the repository's known Fontconfig cache warnings.

### Step 6: Commit

```bash
rtk git add src/worker/services/observability.ts src/worker/services/alerts.ts src/worker/services/pipeline.ts src/worker/services/retention.ts src/worker/index.ts test/worker/observability.test.ts test/worker/alerts.test.ts wrangler.toml
rtk git commit -m "feat: add Cloudflare-native operational alert events"
```

---

## Task 2: Remove the app-managed Slack/Discord transport

**Files:**

- Modify: `src/worker/services/alerts.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `src/worker/types.ts`
- Modify: `test/worker/alerts.test.ts`
- Modify: `.dev.vars.example`
- Modify: `wrangler.toml`
- Modify: `README.md`
- Modify: `docs/runbook-operador.md`

### Step 1: Write the failing removal test

Add a regression test that supplies legacy `ALERT_WEBHOOK_URL` and
`ALERT_WEBHOOK_KIND` properties through an explicit compatibility cast, invokes
`sendOperationalAlert`, and proves no `fetch` is made. This must fail against
the old runtime.

Run:

```bash
rtk npm test -- test/worker/alerts.test.ts
```

Expected: FAIL because the current Slack/Discord path calls `fetch`.

### Step 2: Remove Slack/Discord runtime support

In `alerts.ts`:

- delete the timeout, webhook target construction, payload formatting, URL
  validation, fetch, and webhook result aggregation;
- retain only app email recipients and their existing concurrent dispatch,
  claim, failure classification, audit, and incident deduplication behavior;
- simplify channel types and channel-result aggregation to email-only without
  changing retry safety.

Remove `ALERT_WEBHOOK_URL` and `ALERT_WEBHOOK_KIND` from `Env`. Narrow
`claimOperationalAlertDelivery`'s source type to `"email"`. Do not change the
applied database migration.

Delete webhook-specific tests and helpers after the new no-fetch regression
test is green. Preserve all email claim, deduplication, concurrency,
post-dispatch uncertainty, and redaction tests.

### Step 3: Remove current configuration and operator documentation

- Delete Slack/Discord examples from `.dev.vars.example`.
- Delete the obsolete staging comment from `wrangler.toml`.
- Update README features, configuration tables, delivery semantics, and schema
  descriptions to explain the Cloudflare-native independent channel.
- Update the operator runbook to point operators to Workers Observability and
  Cloudflare Notifications instead of app webhook secrets.
- Leave historical implementation plan/spec files unchanged, but make the new
  superseding plan the current source of truth.

### Step 4: Verify the removal boundary

Run:

```bash
rtk npm test -- test/worker/alerts.test.ts test/worker/observability.test.ts
rtk rg -n "ALERT_WEBHOOK|Slack|Discord" src test .dev.vars.example wrangler.toml README.md docs/runbook-operador.md
```

Expected: tests pass and the search returns no matches. Wompi webhook references
are expected elsewhere and must remain.

### Step 5: Run full verification

Run:

```bash
rtk npm run typecheck
rtk npm run build
rtk npm run types:check
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmos-miniflare-tests npm test
rtk git diff --check
rtk git status --short
```

Expected: every check passes; only the intended Task 2 files are changed before
the commit.

### Step 6: Commit

```bash
rtk git add src/worker/services/alerts.ts src/worker/storage/repository.ts src/worker/types.ts test/worker/alerts.test.ts .dev.vars.example wrangler.toml README.md docs/runbook-operador.md
rtk git commit -m "refactor: remove app-managed Slack and Discord alerts"
```

---

## Integration, Cloudflare Configuration, and Release

After both task reviews and the broad final review approve the code:

1. Run the complete verification bundle again at the exact final SHA.
2. Push `main` and wait for every GitHub Actions check on that SHA.
3. Deploy only `--env staging`.
4. Verify the deployed staging version/tag, `/api/health`, and Worker
   observability settings independently.
5. Save a Workers Observability query matching:
   - `$metadata.service = "diezmossv-staging-example"`
   - `event = "operational_alert"`
6. Create a Workers Observability alert whose condition is count greater than
   zero and whose recovery returns to normal when the window is empty.
7. Create or reuse an account Cloudflare Notification policy for
   `workers_observability_alert`, delivered to the existing account email.
8. Use Cloudflare's policy test action to verify the notification path without
   triggering a customer email or fabricating an application failure.
9. Confirm no Slack/Discord application secret or variable is configured on the
   staging Worker. Do not print mechanism addresses or secret values.
10. Do not deploy production.

## Final Acceptance

- No current runtime/config/operator-doc support remains for app-managed Slack
  or Discord alerts.
- All existing app alert emails and in-app failure/recovery UI continue to work.
- A safe structured `operational_alert` signal is persisted by Workers Logs.
- Raw runtime exceptions are no longer serialized into persistent Worker logs.
- Cloudflare has an enabled Workers Observability alert and email notification
  policy for staging.
- GitHub `main`, local `main`, and the deployed staging SHA match.
- Full tests, typecheck, build, generated-type check, CI, health, and Cloudflare
  configuration checks are green.
