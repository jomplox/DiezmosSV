# Ray read-only monitoring

`GET /api/monitoring/ray` is a small HTTP integration for Ray, the owner's dot
assistant. It returns operational aggregates and bounded recent state changes.
It does not expose donor records, raw payloads, provider error text, provider
links, credentials, fiscal documents, or administration actions. It performs
SELECT queries only. It never invokes provider recovery, issues a document,
creates a gift/link, sends email, or enqueues work.

The route is disabled until the separate setup below is approved and completed.
This implementation creates no Access application, credentials, security rules,
production deployment, or recurring monitor. The machine contract is
[OpenAPI 3.1](ray-monitoring.openapi.json); `version: 1` changes require deliberate
client compatibility review.

## Authentication and revocation

Use a dedicated Cloudflare Access **Service Auth** application protecting exactly
the deployment host and `/api/monitoring/ray`. Select only Ray's specific service
token, not “Any Service Token”; do not add a human Allow policy or Bypass policy.
Give the service token a finite lifetime and choose a short application session
lifetime. Ray sends both `CF-Access-Client-Id` and `CF-Access-Client-Secret` through
its secure HTTP executor. Access supplies `Cf-Access-Jwt-Assertion` to the Worker.
The Worker independently verifies RS256 against the configured team's public
certificates, issuer, the single monitoring audience, expiry, issuance time,
optional not-before time, and service identity (`common_name`, empty `sub`, no
`email`). User sessions/admin cookies and unsigned or substituted headers grant
no monitoring access. The certificate fetch is pinned to the configured issuer,
has a five-second timeout, refuses redirects, and reads at most 64 KiB. Keys are
cached for 60 seconds; failed fetches are cached for five seconds. A newly rotated
key can therefore briefly require a retry.

Runtime configuration (private deployment configuration only):

| Name | Meaning |
| --- | --- |
| `RAY_MONITOR_ACCESS_TEAM_DOMAIN` | Exact Access team hostname, `<team>.cloudflareaccess.com`; no scheme/path |
| `RAY_MONITOR_ACCESS_AUD` | Dedicated monitoring application's audience |
| `RAY_MONITOR_ACCESS_CLIENT_ID` | Ray's exact service token Client ID |
| `RAY_MONITOR_NOT_AFTER` | Hard local expiry, canonical UTC with milliseconds, e.g. `2030-01-01T00:00:00.000Z` |
| `RAY_MONITOR_RATE_LIMITER` | Required Workers Rate Limiting binding; dedicated namespace |
| `APP_ENV` | Must be exactly `staging` or `production` |

Set the hard expiry no later than the service token expiry. Missing, invalid,
expired configuration or an absent limiter disables the endpoint with 503.
No service-token secret is stored in the Worker. `authorization.expiresAt` is the
lesser of the current Access JWT expiry and the hard local cutoff; it is not a
credential renewal mechanism.

For immediate application-side revocation, remove/change the configured Client
ID or remove an enabling setting. Revoke/delete the Access service token too.
Access revocation prevents new authentication, but an already issued JWT can
remain valid until its own expiry unless the Worker identity/cutoff is changed.
Roll out configuration changes with normal deployment propagation checks.
Prevent public alternate origins from bypassing Access at setup; the Worker
still requires a valid JWT on every origin. Never reuse an admin credential.

Access authentication does not by itself grant an exception to bot/WAF rules.
Test the exact route using Ray's real HTTP executor after approval. If a challenge
still blocks it, investigate the applicable rule and separately approve the
smallest supported exception for this authenticated route. Do not exempt the
root donation page, other API routes, or a shared cloud IP. This API does not
prove that Ray can browse the donor UI.

Official references: [service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/),
[application JWTs](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/),
[JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/),
[Workers rate limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

## Reading a snapshot correctly

All monetary amounts are integer USD cents. `freshness.monetaryWindowFrom` and
`monetaryWindowUntil` bound the rolling 24-hour gift cohort. Backlog counts describe
current stored state across its history, not only that window. Historical last
success timestamps (`lastConfirmedAt`, `lastAcceptedAt`, `lastSentAt`,
`lastSettledAt`) are all-time stored observations, even when nested under a 24-hour
summary. A quiet period with no gifts does not establish an outage.

| Summary | Semantics |
| --- | --- |
| Wompi `confirmed24h` | Exact `ExitosaAprobada` webhook records received during the window; gross is the provider-confirmed amount, not the requested intent amount. Unapproved records are excluded from confirmed totals; `unapproved24h` counts all other provider results without inferring a decline reason. |
| Wompi issuance | Approved records still unprocessed/processing/retry-queued vs failed/dead-lettered; `oldestPendingAt` supports client-selected age thresholds. |
| Intents | `paid_at` counts confirmed giving separately from `COMPLETED`; pending means an unexpired, unpaid PENDING/LINK_CREATED intent. No monetary totals use intent amounts. The table has no environment field: these counts and intent changes are explicitly `database_unscoped`. Use a deployment-isolated database; never describe these counts as production-only if mixed data exist. |
| Fiscal | All documents in the selected ambiente, including operator-created documents. Acceptance timestamps count accepted documents; pending includes contingency/transmission states; failed includes REJECTED/FAILED. `finalizationPending` is ACCEPTED with no post-accept finalization marker. Acceptance is distinct from giving and email dispatch. |
| Email | Latest attempt per document and email type; superseded failures do not count. `uncertain` means a non-SENT attempt with UNKNOWN provider outcome. SENT means provider dispatch recorded, not inbox delivery. |
| Stripe `gifts24h` | Settled gift rows, not checkout sessions. Monthly invoices count once as gifts; subscription creation is not another gift. `grossCents - refundedCents = netCents`; refunds are cumulative for gifts settled in this cohort, not refunds that occurred during the window. Old-cohort refunds still appear in recent state changes. |
| Stripe mode | Gift mode comes from the linked checkout or invoice settlement; missing/conflicting attribution is excluded from money totals and flagged by `unattributedGiftCount`. Invoice backlog mode uses invoice/payment evidence and excludes conflicts. |
| Stripe processing/email | Checkout creation/open vs failed, webhook processing vs failed, invoice convergence pending/review, latest acknowledgment revision per gift and latest annual-statement revision per donor/year/mode. FAILED/REVIEW require attention; pending may be normal. |

Production uses Wompi/MH ambiente `01` and Stripe livemode `1`; staging uses `00`
and `0`. Stripe receipts remain separate from Salvadoran fiscal issuance.
The current-state queries may observe changes between reads; this is not an
atomic accounting export or a reconciliation ledger. Fixed aggregate queries can
scan historical rows; time ranges/page sizes/output are bounded, but runtime
cost is not constant as the database grows. Benchmark representative D1 data
before enabling high-frequency polling.

`health.app = ok` means this handler ran; `database = ok` means its reads succeeded.
`providers = not_probed` is intentional: configuration, historical successes,
and this API's availability do not prove live Wompi, Stripe, Hacienda, email,
cron, queue, browser, or end-to-end donation availability. There is no cron
heartbeat evidence in this contract. `databaseReadAt` is observation freshness,
not the last successful business operation. `intakeEnabled` reports the local
emergency intake switch only, not provider/configuration readiness.

`severity = attention` means intake is disabled or recorded failures, uncertain
email outcomes, review states, or unattributed Stripe gifts exist. `ok` means
those selected indicators were absent; it is not an all-systems health verdict.
Pending age/count thresholds, repeated-failure thresholds, quiet hours,
notification cadence, and recipients belong to the owner's client configuration.
The API installs no alerts. A 503 is unavailable; never convert it to an empty
healthy result. Persist the time of the last successful observation separately.

## Changes, cursors, and polling

- `since` is canonical UTC with milliseconds, within the last 24 hours. Omit it
  for the initial window. `limit` defaults to 20 and allows 1–50.
- The feed has a two-second settling delay. It sorts by normalized change
  timestamp, source, and internal identifier; pagination handles timestamp ties.
- Follow `nextCursor` until null, keeping the same page limit. A cursor pins its
  original window and expires after 15 minutes. Do not combine it with `since`.
  Unknown/duplicate query parameters are rejected. Malformed/stale queries get 400.
- Only after all pages succeed, save `resumeSince` for the next poll. It overlaps
  the prior endpoint by ten seconds. Deduplicate using `items[].key` (a SHA-256
  of source, internal identifier, timestamp, and state). Store keys at least
  through the 24-hour recovery window. Cursors are opaque pagination data, not
  credentials; they include only necessary internal tie-break identifiers.
- `actionableCode` is a fixed `<source>_needs_review` label for failed/rejected/
  dead-lettered/review/unknown states. It is never raw provider error text.
- This is a bounded **current-state feed**, not an append-only event log. Retention,
  updates during pagination, clock skew/delayed timestamp writes beyond the
  overlap, and multiple transitions between polls can hide intermediate states.
  Use the aggregate snapshot as the current backlog signal. After downtime over
  24 hours, restart the bounded window and report the observation gap.

Illustrative client flow (not an installed monitor):

```python
# secure_get is the approved HTTP executor. It substitutes host-scoped secrets
# into the two Access headers without exposing their values to the model/logs.
# It pins the approved HTTPS host/path, refuses redirects, and checks JSON.
params = {"limit": 20}
if checkpoint:
    params["since"] = checkpoint
while True:
    response = secure_get("https://monitor.example.org/api/monitoring/ray", params)
    # On non-200: retain old checkpoint and last-good timestamp; handle below.
    snapshot = require_version_1_json(response)
    record_observation(snapshot["summary"], snapshot["health"], snapshot["freshness"])
    for change in snapshot["changes"]["items"]:
        consume_once(change["key"], change)  # durable client dedup, no donor data
    cursor = snapshot["changes"]["nextCursor"]
    if not cursor:
        checkpoint = snapshot["changes"]["resumeSince"]
        save_checkpoint(checkpoint)
        break
    params = {"limit": 20, "cursor": cursor}
```

Configure a dedicated limiter namespace with a proposed ceiling of 60 requests
per 60 seconds per authenticated Ray identity. The actual binding and poll cadence
require approval. Workers rate limits are per Cloudflare location and approximate,
not a globally strict quota. The handler uses no IP-based limiter or D1 writes.
A denied limiter call returns 429 with `Retry-After: 60`; a broken limiter returns
503. These settings do not permit sixty complete, potentially paginated scans
per minute—choose a modest polling cadence after measuring the database.

Honor Retry-After and use jittered exponential backoff on 429/503 (for example,
60 seconds up to 15 minutes). On 401 stop retrying and ask for credential renewal;
on `monitor_disabled` request configuration review; on 400 reset an expired cursor to a fresh bounded window and record the gap.
HTML challenges, redirects, TLS/network errors, or non-JSON responses are failed
observations. Do not follow a redirect while carrying credentials. Notify only
when a meaningful condition changes or the owner's configured threshold is reached;
keep unchanged routine observations quiet.

## Separate setup approval and acceptance

Before connecting, verify that Ray's real HTTP executor supports both headers,
exact-host secure secret substitution, no redirect forwarding, and secure storage
that never inserts credentials into prompts, chat, source, logs, or command
arguments. Browser header injection, mTLS support, native Cloudflare MCP access,
and a dedicated/static egress IP are not assumed. If the executor cannot satisfy
this, leave the endpoint disabled and report the concrete capability gap.

Request setup approval for these exact actions after the code is reviewed:

1. Merge/deploy the reviewed commit through the normal staged release process.
2. Create the exact-path Access application, Ray-only expiring service token, and
   dedicated rate-limiter binding; set issuer/audience/identity/local cutoff privately.
3. Enter the token directly into the executor's secure, host-scoped credential UI
   or secret store. Never request that the owner paste it into chat. Do not publish
   deployment hostnames, audiences, token IDs/secrets, or Cloudflare resource IDs.
4. Verify using the real Ray HTTP executor: 200 JSON, expiry/identity fields and
   staging/production scopes; bad/missing credentials denied; other routes stay
   protected; response contains no donor data; database/provider side effects absent.
   Resolve an observed bot/WAF challenge only with a separately reviewed narrow rule.
5. After those checks, separately approve/install the recurring monitor and the owner's
   cadence, thresholds, notification policy, and renewal process.

A draft PR and local mocked tests are not a connected monitor. No real donation,
provider-created link, fiscal issuance, or email dispatch is needed for API setup.
Reconcile pending donation-flow fixes before any future release.
