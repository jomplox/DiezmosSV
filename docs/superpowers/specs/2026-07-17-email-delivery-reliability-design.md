# Email Delivery Reliability Design

**Date:** 2026-07-17

**Status:** Approved for implementation

## Objective

Recover the three confirmed non-smoke staging receipts that Cloudflare rejected
before acceptance, then make receipt delivery failures visible, safely retryable
when their outcome is known, manually reviewable when their outcome is ambiguous,
and independently alertable without changing fiscal CDE behavior.

## Scope

This work covers:

- the existing `email_deliveries` receipt claim lifecycle;
- the authenticated manual-resend endpoint and its admin UI;
- the Fallos list and receipt-failure warning;
- durable staging-smoke provenance;
- operational-alert incident identity and an optional independent webhook channel;
- migrations, tests, operator documentation, GitHub CI, and Cloudflare staging.

It does not redesign password-reset, certificate, or invalidation email storage.
Those senders remain a later generalization because `email_deliveries` is
document-scoped and requires a `dte_documents.id`.

## Guardrails

- Never deploy or migrate production.
- Never issue, retry, invalidate, delete, or alter a production fiscal document.
- Do not delete staging CDEs or rewrite fiscal content, seals, identifiers, or
  document sequences.
- Send recovery email only for the three non-smoke records whose stored provider
  response proves the legacy disallowed header was rejected before acceptance.
- Synthetic tests may send only to explicitly configured smoke addresses.
- Treat `X-Idempotency-Key` as correlation metadata, not provider deduplication.
- Never automatically retry a post-dispatch or otherwise ambiguous outcome.
- Do not expose donor addresses, webhook URLs, credentials, or provider secrets in
  logs, tests, commits, or status messages.
- Add no dependency unless the existing platform and repository utilities cannot
  express the required behavior.

## Existing Behavior

The normal receipt path already claims a deterministic `email_deliveries` row
before contacting a provider. It updates that row to `SENT` or `FAILED` afterward.
A current `PENDING` row and a `SENT` row block a competing send, while `FAILED` and
lease-expired `PENDING` rows can be reclaimed.

Three gaps remain:

1. Every provider exception becomes the same reclaimable `FAILED` result, even
   when the provider may have accepted the message.
2. A provisional receipt can leave a lease-expired `PENDING` row after crossing
   the provider boundary, and the generic claim can reclaim it.
3. Manual resend bypasses the claim entirely, sends without a correlation key,
   and appends evidence only after the provider call.

The admin detail pane already derives a receipt warning from audit rows, but the
Fallos list only requests fiscal `FAILED` and `REJECTED` statuses. An accepted CDE
with failed receipt delivery therefore remains hidden until an operator finds and
opens it by another route.

## Delivery Outcome Model

Keep the existing `PENDING`, `SENT`, and `FAILED` status values. Add evidence that
answers two separate questions:

- Did execution cross the provider-dispatch boundary?
- Is another automatic attempt safe?

Each claimed row gains:

- `provider_dispatch_started_at`: set immediately before invoking the provider;
- `outcome_class`: nullable, then one of `NOT_SENT`, `NOT_DELIVERED`, or `UNKNOWN`;
- `failure_code`: the stable provider or local classification code when available;
- `retry_safe`: `1` only when another attempt cannot duplicate a provider-accepted
  message;
- `resend_request_id`: present only for a deliberate manual-resend action;
- `attempt_no`: human-readable per-document receipt attempt sequence.

The claim SQL may reclaim:

- a `FAILED` row only when `retry_safe = 1`; or
- a stale `PENDING` row only when `provider_dispatch_started_at IS NULL`.

It must not reclaim:

- any `SENT` row;
- any `FAILED` row with `retry_safe = 0`;
- any stale `PENDING` row whose provider dispatch began;
- legacy `PENDING` rows without enough evidence to prove safety.

Migration `0025` preserves every legacy delivery row. It ranks the complete
receipt history for each document and email type, keeps claim ownership only when
the claimed unresolved row is also the latest receipt, and clears only superseded
claim tokens before creating the partial unique index. This covers both duplicate
claimed failures and an older claimed ambiguity followed by a newer append-only
terminal resend. No delivery evidence is deleted.

### Outcome classification

`EmailService` exposes a typed `EmailDispatchError` containing:

- `code`;
- `outcomeClass`;
- `retrySafe`;
- a sanitized provider response suitable for D1 evidence.

For the native Cloudflare binding:

- documented payload, sender, recipient, limit, and header validation codes are
  `NOT_SENT`; they are safe from duplication, although correction may be required
  before another attempt can succeed;
- `E_DELIVERY_FAILED` is `NOT_DELIVERED` and requires an operator decision rather
  than an automatic loop;
- `E_INTERNAL_SERVER_ERROR`, an unrecognized code, a runtime abort, or any
  transport-level uncertainty is `UNKNOWN` and is never auto-reclaimed.

For the optional HTTP provider:

- only HTTP `200` or `202` with JSON
  `{"status":"accepted","id":"<provider-id>"}` (or `messageId`) is `SENT`;
- the accepted provider ID must be a non-empty string; its raw, provider-defined
  format is never persisted and is replaced immediately with a fixed-length
  `sha256:` digest;
- only an HTTP `4xx` JSON response
  `{"status":"rejected","accepted":false,"code":"<STABLE_CODE>"}` proves
  `NOT_SENT`;
- network failures, timeouts, server errors, and unrecognized responses are
  `UNKNOWN`;
- empty, malformed, oversized, non-JSON, generic `4xx`, or unrecognized `2xx`
  responses are also `UNKNOWN`.

Persisted failure evidence contains only the normalized machine code. Provider
exception text is never stored because it may echo recipient addresses, private
URLs, headers, or credentials.

Successful provider evidence likewise stores only the provider label and the
fixed-length digest of its delivery ID. The raw provider ID remains process-local
and is discarded before the result reaches repository or audit code.

Any local failure before `provider_dispatch_started_at` is set is `NOT_SENT`.
Ownership fencing errors remain ownership errors and are not converted into
provider outcomes.

## Initial Receipt Flow

1. Claim the existing deterministic receipt identity.
2. Render and validate the message.
3. Run the existing accepted-document ownership callback, when present.
4. Atomically fence the email claim and set `provider_dispatch_started_at`.
5. Invoke exactly one configured provider.
6. Finalize the same row as `SENT` or classified `FAILED`.
7. Audit the result and emit an operational alert whose incident ID is the claim
   token for that specific attempt.

If execution ends after step 4 without a final result, the row remains
post-dispatch `PENDING` and requires manual reconciliation. It is never reclaimed
by lease age alone.

## Deliberate Manual Resend

A manual resend is a new delivery attempt, not a retry of the original successful
identity. It therefore needs two identities:

- `resendRequestId`: generated once by the client for one deliberate user action;
- `attempt_no`: allocated by D1 for operator-readable chronology.

The provider correlation key is derived from the document and
`resendRequestId`. Repeating the same HTTP request, retrying after a dropped client
connection, or double-clicking uses the same request ID and cannot create another
provider call. A later deliberate resend after a successful attempt receives a new
request ID and a new row.

If a request ID is reused with a different document or recipient, the server
returns a conflict. If its row is already `SENT`, the endpoint returns success with
`duplicateSuppressed: true`. If it is ambiguous, the endpoint returns a
manual-review conflict instead of sending.

The latest ambiguous receipt outcome is a document/type fence even for a legacy
row that predates claim tokens. A new request UUID cannot bypass that fence; it
requires an explicit reconciliation or audited override workflow.

The client retains an in-flight request ID after a failed HTTP call and reuses it
when the outcome is `NOT_SENT` or `UNKNOWN`. A confirmed `NOT_DELIVERED` result
clears the ID so a later deliberate user action creates a new attempt; retaining
the old ID would only return the terminal result. Success also clears the ID.
The staging smoke runner supplies its own UUID for the same reason.

A retry-safe row may be reclaimed only while it is still the latest receipt
attempt. Replaying an older safe request ID after any newer attempt cannot promote
the older row or cross the provider boundary; a newer ambiguous attempt continues
to return manual review.

## Fallos and Detail UI

The documents endpoint gains a server-side attention filter. Its result is the
union of:

- fiscal `FAILED` documents;
- fiscal `REJECTED` documents;
- `ACCEPTED` documents whose latest receipt attempt is `FAILED`; and
- `ACCEPTED` documents whose latest receipt is still `PENDING` after provider
  dispatch began.

The latest receipt is selected by attempt chronology, with a supporting
`email_deliveries` index. The list response includes a small derived receipt
attention state; it does not expose raw provider responses.

In the Fallos list:

- an accepted fiscal document keeps its `ACEPTADO` status;
- a separate `Correo fallido` or `Correo por revisar` marker explains why it is
  in the view;
- the failure total includes each document once.

In the detail pane:

- a known `NOT_SENT` result says the provider rejected the attempt before sending;
- `NOT_DELIVERED` says delivery failed;
- `UNKNOWN` says the provider outcome cannot be confirmed;
- post-dispatch `PENDING` says the result is still unconfirmed and disables
  resend until an operator reconciles it;
- a legacy unclassified failure uses neutral wording;
- `Reenviar ahora` appears inside the warning;
- the duplicate resend action is omitted from the normal action row while the
  warning is present;
- the fiscal action is labeled `Reintentar DTE`.

## Durable Smoke Provenance

Do not delete accepted staging records and do not add a staging-specific boolean
to the fiscal document table. Use an immutable `STAGING_SMOKE_RUN` audit marker
with:

- `runId`;
- `path`: `webhook` or `admin`;
- `source`: `staging-smoke`.

The smoke runner creates one UUID per run. The admin test route stores the marker
when it creates its document. The signed staging webhook carries the run ID in its
existing smoke transaction identity, and the pipeline stores the marker when it
creates the correlated document. Both paths are accepted only when
`APP_ENV = staging`.

The eight known historical smoke artifacts receive deterministic backfill audit
rows after a read-only identity check. No CDE row is deleted or modified.

## Operational Alerts

Alert deduplication becomes per
`(kind, entity, incidentId, channel, target)` instead of per `(kind, entity)`
forever. The durable claim table stores only hashes for entity and recipient
identity. Audit rows remain secondary operator history and are not used as the
duplicate-send fence.

For webhooks, target identity includes the normalized webhook URL before hashing.
Rotating the secret URL therefore creates a distinct target for the same incident
without storing the URL itself. A multi-recipient channel is marked sent only
when every configured target is confirmed sent; an unresolved target keeps the
channel failed/manual-reviewable even if a sibling target succeeds.

Every caller supplies a stable incident ID for the triggering attempt or episode:

- receipt claim token for email delivery;
- issuance attempt ID for queue failures;
- failure or deferred epoch for document/backlog incidents;
- certificate expiry plus threshold for certificate alerts;
- verification/export attempt identity for retention alerts.

Email recipients and the webhook execute independently. A slow or failed target
cannot prevent another target from starting. Each target is fenced before provider
dispatch; a confirmed pre-acceptance rejection may be reclaimed, while timeout,
internal failure, or any post-dispatch uncertainty remains manual-review-only.
Each channel writes `ALERT_SENT:<kind>` or `ALERT_FAILED:<kind>` audit evidence
with `incidentId` and `channel` metadata when that secondary audit write succeeds.

The webhook is optional. Its credential-bearing URL is a deployment secret and
its non-secret provider format is a deployment variable:

- `ALERT_WEBHOOK_URL` secret;
- `ALERT_WEBHOOK_KIND` variable, either `slack` or `discord`.

Payloads contain redacted alert title/detail, kind, redacted entity display, and
admin origin, but no credentials, donor address, raw provider text, or full
provider response. Slack receives `text`; Discord receives `content`. Non-HTTPS
URLs, credential-bearing URLs, unsupported kinds, non-2xx responses, timeouts,
and malformed configuration record a webhook failure without blocking the email
channel or the triggering business flow.

## Recovery Procedure

Before each of the three authorized staging resends:

1. Query the document and its latest failed delivery.
2. Confirm it is not marked as a smoke artifact.
3. Confirm `provider_response_json` contains the exact legacy disallowed
   `Idempotency-Key` rejection and no timeout or unknown outcome.
4. Confirm there is no later `SENT` delivery for that document and recipient.
5. Invoke the resend endpoint exactly once with a unique request ID.
6. Query D1 again and confirm one new `SENT` attempt and no duplicate provider ID.

Stop immediately if any precondition differs.

## Testing

Tests must be written and observed failing before production changes.

Required focused coverage:

- Cloudflare error-code classification and conservative unknown fallback;
- HTTP provider classification;
- dispatch-boundary persistence;
- safe failed-claim reclaim and ambiguous claim blocking;
- provisional receipt crash protection;
- manual resend request deduplication, conflict handling, and deliberate later
  resend;
- Fallos server query and list marker/count behavior;
- outcome-specific warning copy and warning-box action;
- smoke-run provenance on both paths;
- historical smoke backfill query safety;
- incident-scoped alert deduplication;
- independent email/webhook success and failure combinations;
- migration columns, checks, and indexes against real SQLite.

Completion also requires the full Vitest suite, TypeScript checks, Wrangler type
check, production build, migration preflight, and `git diff --check`.

## Publication and Staging Proof

After local verification:

1. Commit only the intended spec, plan, source, migration, tests, scripts, and
   operator documentation.
2. Push `main`.
3. Wait for every required GitHub check on the exact pushed SHA.
4. Apply migrations only to `diezmossv-staging-example`.
5. Deploy only the exact green SHA to the staging Worker.
6. Verify the deployed version metadata matches the SHA.
7. Run authenticated live checks for the Fallos result, resend deduplication,
   smoke audit markers, and alert-channel evidence.
8. Confirm local `main`, `origin/main`, and staging deployment match and the
   worktree is clean.

Production remains untouched.
