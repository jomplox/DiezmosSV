# Security Review Remediation Design

**Date:** 2026-08-23

**Authority:** The eleven inline review comments supplied by the user in the Codex task.

## Goal

Close every reported production security gap without deploying, changing live Cloudflare state, editing historical D1 migrations, or weakening the fiscal environment boundary. The observable result is a reviewed branch whose focused regression tests, full unit/integration suite, build, migration immutability check, and private-boundary check pass.

## Cross-cutting invariants

- A real Wompi link must not be created until the active deployment can construct and sign a CDE and authenticate to the matching MH lane.
- Production must never run the shared external-service mock path.
- Donor-facing copy keeps the repository's voluntary-gift terminology and usted form.
- Existing migrations 0001 through 0044 remain byte-for-byte unchanged; new schema is appended.
- Security limits use atomic D1 admission, not read-then-write decisions in a Worker isolate.
- A conflicting provider event never inherits trust decisions from the incoming collision and never mutates the canonical event's intent or issuance state.
- Provider-controlled strings and bodies are sanitized at the integration boundary before any durable or logging sink can receive them.
- A positive backup-verification audit requires an exact current manifest and an independent D1 export anchor.
- Lower roles cannot use hidden identifiers as pre-projection filters for account audit history.
- HSTS is emitted on every production Worker response. The initial policy deliberately omits includeSubDomains and preload, so no unverified subdomain promise is made.
- No production deployment, WAF change, secret rotation, cleanup of user artifacts, push, or pull request is authorized by this implementation task.

## Acceptance criteria by review comment

### 1. Fiscal readiness before Wompi link creation

For a non-mock create request, a shared readiness function must validate, before the first network call:

- deployment APP_ENV maps to a permitted MH ambiente;
- EMISOR_CONFIG_JSON is valid;
- the matching MH auth, reception, and invalidation URLs are present and HTTPS;
- the matching MH user and password are present;
- MH_CERT_XML (or both parts) is parseable and active;
- MH_CERT_PASSWORD matches the certificate and the private key can be imported for RS512 signing.

Invalid readiness leaves fetch uncalled and no real Wompi link is returned.

### 2. Production mock mode fails closed

- isMockMode (or an equivalent runtime gate used by every shared mock caller) throws for APP_ENV=production with MOCK_EXTERNAL_SERVICES=true.
- The checked-in example production block remains explicitly false.
- Private Wrangler target-manifest validation rejects a production manifest whose shared mock variable is anything except the literal string false.
- Tests prove the runtime and manifest rejection.

Stripe's separately scoped STRIPE_MOCK_MODE remains governed by its existing policy; this finding concerns MOCK_EXTERNAL_SERVICES.

### 3. Private-boundary coverage for PDF render artifacts

- scripts/check-private-boundary.mjs inspects tmp/pdfs recursively, including ignored files and symlinks/non-directory replacements.
- A synthetic fixture containing tmp/pdfs/<artifact> fails without printing file contents.
- Git-ignore coverage for the local render tree stays aligned.
- The task does not delete any existing artifact.

### 4. Account-targeted login protection under IP rotation

- Account-wide recent login failures are counted independently of source IP.
- Crossing the account-wide threshold does not permanently or blindly lock the account.
- A correct password in the challenged state cannot create or return a session until a short-lived email verification code is completed.
- The code/challenge is one-time, expiry-bound, attempt-limited, stored only as hashes, and bound to the current user auth generation.
- Wrong credentials remain enumeration-safe. A disabled or unknown account does not receive a challenge.
- The client supports the verification-code step with actionable Spanish operator copy.
- Delivery failure creates no usable session.
- Existing per-IP and email-IP limits remain.

This is a progressive step-up MFA control: ordinary logins below the aggregate-failure threshold retain their current one-step behavior.

### 5. Conflicting Wompi event collisions

- Event insertion returns an explicit inserted, equivalent replay, or conflict result.
- Comparison covers environment, result, amount, payment link, commerce intent identifier, and a canonicalized normalized payload/body.
- A legitimate equivalent payment-link replay may use Wompi's alternate transaction identifier only when every other security-relevant field is equivalent.
- Replay side effects use the canonical stored payload and environment, never the incoming collision.
- A conflict is audited with bounded non-sensitive metadata, returns a conflict response for the webhook, and does not mark an intent paid or queue issuance.
- Tests cover result, environment, amount, intent, and body conflicts plus the legitimate alternate-transaction replay.

### 6. MH provider response sanitization

- Non-2xx authentication errors and token-missing errors use bounded constant text and do not include the provider body or descripcionMsg.
- Before any MhResponse is returned, exact configured MH username, password, and bearer token values are replaced recursively in estado, observaciones, raw, and any text fallback.
- The redaction works when a secret is embedded inside a longer string.
- Tests prove none of the exact secrets can reach thrown error text or returned/persistable response fields.

### 7. Backup completeness and authenticity

- Version 2 manifests are parsed from unknown input with an exact schema.
- The table keys equal the canonical export set exactly; missing, extra, empty, malformed, wrong-month, wrong-run, wrong-key, invalid row-count, and invalid digest entries fail closed.
- Verification looks up the live D1 RETENTION_EXPORT_COMPLETED audit for the month and requires its canonical table map to match the R2 manifest before hashing objects.
- No anchor, malformed anchor, or mismatched anchor yields RETENTION_VERIFY_FAILED and never RETENTION_VERIFIED.
- Listing and download helpers do not label an invalid manifest as archived or use it to resolve an object.
- Newly produced completion evidence includes runId, generatedAt, and a canonical manifest digest while existing valid completion evidence can be matched by its exact table map.
- Tests include the formerly vacuous empty/partial cases and a forged manifest/body pair.

### 8. Aggregate public provider-creation budgets and IPv6 normalization

- A new append-only migration creates a provider-creation claim ledger with expiry and indexes.
- One atomic INSERT ... SELECT enforces a normalized-client budget, a Wompi-or-Stripe provider budget, and a global budget.
- IPv4 identities remain individual; valid IPv6 addresses are canonicalized and grouped by /64; malformed/missing values share an unknown bucket.
- Wompi and fresh Stripe checkout creation claim the correct provider budget before durable/provider work; Stripe idempotent replay does not consume a new claim.
- Existing releases' unattributed rows remain counted during the transition where needed.
- Expired and unused claims are cleaned/released safely.
- Tests show literal IPv6 rotation within one /64 cannot multiply the budget and different IPs/providers still meet the global/provider ceilings atomically.

Cloudflare account-level WAF/Bot Management is outside this repository and is not mutated by this branch; the repository-owned global D1 ceiling is therefore the hard aggregate bound. The final handoff must not claim a live edge rule was verified.

### 9. Account audit audience boundary

- VIEWER and OPERATOR receive 403 for entityType=user scoped audit queries, regardless of entity ID.
- ADMIN and OWNER retain the scoped account-audit behavior.
- Contingency events omit created_by for VIEWER and OPERATOR.
- A chained regression test proves the lower role cannot obtain and reuse a stable account ID.

### 10. HSTS

- public/_headers includes Strict-Transport-Security: max-age=31536000.
- The Worker wraps every APP_ENV=production fetch response, including JSON, webhook, redirect, asset, 204, and error responses, with the same header.
- Non-production responses are not used as evidence for the production contract.
- includeSubDomains and preload are intentionally absent pending separate HTTPS inventory.

### 11. Wompi checkout URL validation

- Successful link JSON is parsed from unknown, not cast.
- idEnlace is a positive safe integer.
- urlEnlace and urlEnlaceLargo are absolute HTTPS URLs with no userinfo or fragment.
- The short URL uses only s.wompi.sv and its approved single-segment link path.
- The long URL uses only pagos.wompi.sv and an explicitly allowlisted hosted-payment path with the required identifier query.
- A host suffix, alternate port, encoded path confusion, credentials, HTTP, javascript/data URL, missing fields, and wrong types fail closed with WompiApiError.
- Invalid responses are never returned to or embedded for the donor.

The current Wompi OpenAPI schema confirms the response fields but does not guarantee their host/path shapes; the allowlist is therefore based on the integration's known hosted-link shapes and is intentionally fail closed.

## Verification standard

Each implementation task starts with a failing behavior-level test and records the red/green commands. Guard tests must be mutation-proven. Final verification runs:

```sh
MINIFLARE_CACHE_DIR=<external-temp> npm test
npm run build
npm run security:check-private-boundary
npm run migrations:check-immutability
```

Any test that needs localhost/Miniflare is run outside the filesystem/network sandbox after approval, as established by the clean baseline.
