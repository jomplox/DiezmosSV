# DiezmosSV Security Hardening Design

**Date:** 2026-07-09

**Status:** Approved for implementation by the user's instruction to execute the complete remediation list from the security triage.

## Objective

Close the confirmed security paths and their shared structural causes without changing the public donation journey, removing the legacy static-Wompi fallback, adding dependencies, deploying production, or overwriting unrelated dirty-worktree changes.

Completion requires focused RED-to-GREEN regressions, a static re-check of each original source/control/sink path, a green full test/typecheck/build/audit suite, an explicit local-private-artifact boundary, and repository security policy documentation.

## Context and constraints

- The checkout started dirty on `main` at `5b3c454cbcfeab1451b2c4799f72c50df69d09e5`; the existing UI, branding, alert-recipient, and test changes belong to the user.
- Work proceeds on `codex/security-hardening` in the same checkout because the vulnerable donation flow and its tests are partly uncommitted. A clean worktree from HEAD would omit required current behavior.
- No secret, private key, certificate body, donor record, token, or credential value may be printed, committed, or copied into documentation.
- No new runtime or development dependency is needed.
- The public `/donar` flow, public status polling, and legacy static Wompi link behavior remain supported.
- No production deployment, live data mutation, or external provider credential rotation occurs without concrete exposure evidence and a safe provider-specific procedure.

## Considered approaches

### 1. Surgical shared-boundary hardening — selected

Add focused request-body, environment, audit-projection, intent-capability, and Wompi-binding primitives. Enforce state changes atomically in the repository. Keep existing routes and response shapes except for an additive draft-only `datosToken` and explicit security error responses.

This closes the findings at the narrowest durable boundaries and minimizes overlap with existing uncommitted work.

### 2. Full router and service decomposition

Split the 2,000-line Worker dispatcher into per-domain routers with declarative policies. This would create a cleaner long-term structure, but it is too broad for the current remediation, would touch most routes, and would conflict heavily with the dirty UI/branding work.

### 3. Cloudflare-only compensating controls

Use platform request limits, WAF rules, separate dashboards, and operator policy without changing application invariants. This cannot fix donation-intent write authority, reset-token races, object-existence disclosure, audit audience leakage, or Wompi correlation integrity, so it is insufficient.

## Architecture

### 1. Donation-intent write capability

Draft intent creation generates a random 32-byte token. Only its SHA-256 hash is stored in the new nullable `donation_intents.datos_token_hash` column; the raw token is returned once as additive response field `datosToken` and retained only in React component memory.

`POST /api/donations/intent/:id/datos` keeps its current path but requires the raw token in `X-Donation-Datos-Token`. The token is never placed in a URL, audit row, database plaintext field, or log.

The repository replaces the current read-then-write sequence with one conditional update. The write succeeds only when all of these are true:

- `id` matches;
- `datos_token_hash` matches the presented token hash;
- `status = 'LINK_CREATED'`;
- `paid_at IS NULL`;
- `donor_document IS NULL`.

The same statement writes donor data and sets `datos_token_hash = NULL`. This makes the capability single-use and makes donor data immutable after payment or completion without a race window.

An absent intent returns the existing 404. A missing, invalid, consumed, paid, expired, completed, or otherwise non-writable capability returns one generic 409 so the response does not disclose which security condition failed.

Full-create requests already contain donor data before link creation and do not receive a write capability. Public status polling remains `{status, paid}` and continues to use the high-entropy intent id as a read-only capability.

Migration `0017_donation_intents_datos_capability.sql` is additive:

```sql
ALTER TABLE donation_intents ADD COLUMN datos_token_hash TEXT;
```

Existing draft rows have no capability and cannot be modified through `/datos`; they safely fall back to raw-webhook donor data if paid. No parent table is rebuilt.

### 2. Strict Wompi intent binding

One shared service resolves whether a Wompi payload is:

- `legacy`: no app-minted `di_` commerce identifier, so the existing raw-webhook path applies;
- `bound`: the payload commerce identifier resolves to an eligible intent and the numeric Wompi link id exactly matches the stored link id;
- `unbound`: an app-looking identifier is missing required binding fields, disagrees with another supplied identifier, references an ineligible intent, or has a missing/mismatched numeric link id.

The resolver uses `EnlacePago.IdentificadorEnlaceComercio` as the canonical app-minted identifier. Wompi documents this field as required when creating a payment link and returns it in the webhook shape. `IdExterno` is never sufficient to select an intent; if both string identifiers are present and disagree, the result is unbound.

Only a `bound` result may set `paid_at` or supply intent fiscal data to CDE generation. `legacy` and `unbound` payloads still follow the existing raw-webhook issuance path, so the static-link compatibility guarantee remains intact. An unbound app-looking payload is audited once by issuance.

Official contract references:

- <https://docs.wompi.sv/metodos-api/enlace-de-pago>
- <https://docs.wompi.sv/webhook/definicion-webhook>

### 3. Bounded request parsing

`src/worker/utils/http.ts` becomes the single inbound-body primitive and exports:

```ts
class RequestBodyTooLargeError extends Error {}
class InvalidJsonBodyError extends Error {}
readBodyBytes(request: Request, limitBytes: number): Promise<Uint8Array>
readBodyText(request: Request, limitBytes: number): Promise<string>
readJsonObject(request: Request, options: {
  limitBytes: number;
  malformed: "throw" | "empty-object";
}): Promise<Record<string, unknown>>
```

The byte reader rejects a declared oversized `Content-Length` before reading and also counts streamed chunks so missing or false lengths cannot bypass the limit.

Limits are centralized in the Worker entrypoint:

- public/auth/donation JSON: 16 KiB;
- authenticated administrative JSON and advanced DTE drafts: 256 KiB;
- raw Wompi webhook: 64 KiB;
- branding images: the existing 512 KiB.

Every inbound `request.json()`, `request.text()`, and `request.arrayBuffer()` in the Worker route dispatcher moves to one of these helpers. Routes that previously tolerated malformed JSON retain `empty-object`; strict routes return a JSON 400. Oversized bodies return JSON 413. The Wompi HMAC continues to operate on the exact bounded raw text.

### 4. Authorization before object lookup

`handleDocumentRoute` derives the minimum role from method/action before loading a document:

- detail, PDF, JSON: VIEWER;
- email edit, resend, retry, invalidation: OPERATOR;
- unsupported actions: authenticated VIEWER before a method/action response.

Anonymous requests therefore receive the same 401 for existing and missing ids without a D1 lookup. Insufficient roles receive the same 403 before a lookup.

### 5. Atomic password-reset completion

The active-token read remains before PBKDF2 so invalid public requests do not trigger expensive hashing. The authoritative mutation moves into one repository method using a D1 transactional batch:

1. conditionally update the user's password only while the presented token is active and belongs to that user;
2. revoke all active sessions for that user;
3. mark every unused reset token for that user used.

Success is determined from the conditional password update result. If another reset wins first, the second batch changes no password and the service returns the normal invalid-token response. Sibling links become unusable as part of the successful reset transaction.

### 6. Deployment environment capability

`environmentPolicy.ts` defines a fail-closed matrix:

| `APP_ENV` | Allowed CDE ambiente | Direct quick CDE |
|---|---|---|
| `local` | `00` | allowed |
| `staging` | `00` | allowed |
| `production` | `01` | disabled |
| missing/unknown | none | disabled |

The policy is enforced at every issuance boundary, not only in the UI:

- active-environment setting reads and writes;
- quick and advanced direct-generation routes;
- Wompi event enqueue;
- queue/pipeline processing and deferred retries;
- invalidation transmission;
- OWNER credential updates.

An incompatible signed Wompi event is stored and audited but is not marked paid or queued. The settings endpoint keeps its existing response and adds lock/allowed-environment metadata so the client can disable impossible choices. Staging may update only test MH credentials; production may update only production credentials.

`wrangler.toml` retains only TEST MH endpoint variables in staging and only PROD variables in production. The shared policy remains the decisive control even if an operator later adds extra variables.

### 7. Audit audiences

The explicit policy is:

- ADMIN and OWNER receive the existing full audit representation.
- VIEWER and OPERATOR receive operational action, timestamp, and non-user entity context, but never actor email/IP/context or account-management target identity.
- For `entity_type = 'user'`, VIEWER/OPERATOR receive a generic localized summary, empty metadata, and null actor/target identifiers.
- Historical `alert_email` values remain scrubbed for every role.

`auditProjection.ts` is the only role-aware projector. General audit, entity-scoped audit, document detail, and contingency responses all call it. Repository-level historical alert-email scrubbing remains defense in depth, but no route maintains a separate field list.

### 8. Local private-artifact boundary

Private operational material moves out of the repository to:

`~/Library/Application Support/DiezmosSV/private/`

with directories mode `0700` and files mode `0600`. The layout is:

```text
env/local-operator.env
env/staging-smoke.env
mh/live/signing/
mh/test/signing/
wompi/live/captures/
tax/live/imports/
dte/live/
quarantine/
```

No symlink points back into the checkout. A Node runner passes the selected out-of-tree file to Wrangler through `--env-file`; CI uses the committed synthetic `.dev.vars.ci` directly and no longer copies it to `.dev.vars`. Live tests resolve the same environment-file variable.

The relocation procedure creates restricted destinations, copies with mode `0600`, verifies byte equality without displaying content, and only then removes the repo-local original. APFS secure deletion is not claimed. Wrangler account cache metadata is deleted and regenerated rather than archived.

Rotation is required only when custody is lost or a live secret/key was committed, pushed, logged, placed in a shared artifact or transcript, synced to an untrusted destination, or otherwise crossed an unintended boundary. PII is contained and handled through retention/incident procedures rather than “rotated.” The repository contains no name-matched history of the currently identified ignored artifacts, so existence alone does not trigger provider rotation.

### 9. Repository policy

`SECURITY.md` defines:

- supported versions and disclosure channel;
- the Cloudflare Worker as the shipped runtime;
- the ignored Java signer as an unsupported local conformance tool unless separately deployed;
- public, VIEWER, OPERATOR, ADMIN, OWNER, queue, and third-party trust boundaries;
- donation intent ids as public read identifiers, never write authority;
- mandatory Wompi link binding;
- deployment environment invariants;
- audit audiences;
- local artifact, secret, PII, retention, and rotation policy.

`docs/local-private-artifacts.md` contains the operational relocation and recovery procedure without values.

## Error handling

- Oversized request: 413 `request_body_too_large`.
- Malformed strict JSON: 400 `invalid_json_body`.
- Missing/invalid/consumed `/datos` capability or non-writable intent: generic 409.
- Unknown intent id for `/datos`: existing 404.
- Incompatible deployment/ambiente request: 409 `environment_not_allowed` for administrative APIs; signed webhook events are stored/audited but not queued.
- Strict Wompi binding failure: no intent mutation, raw-webhook fallback issuance, one mismatch audit.
- Reset race loser: existing invalid-reset-token response; no partial password/session/token mutation.

## Verification strategy

Every behavior change follows RED-GREEN-REFACTOR. Focused tests must demonstrate the original unsafe behavior first.

Required focused coverage:

- draft token plaintext is never stored; missing, wrong, replayed, paid, expired, and completed writes fail; valid one-time write succeeds;
- matching, missing, mismatched, and disagreeing Wompi identifiers behave identically for paid marking and issuance; legacy fallback remains unchanged;
- declared oversized, streamed oversized, exact-limit, malformed strict/tolerant, webhook, authenticated JSON, and logo bodies;
- document authorization occurs before lookup for anonymous and insufficient-role callers;
- sibling reset tokens and concurrent confirmations permit exactly one password change and revoke all sessions/tokens atomically;
- all four environment-policy rows plus quick routes, webhooks, queue processing, retries, invalidation, and credential updates;
- all four audit roles across every audit-returning API surface;
- local boundary check fails when forbidden private-artifact paths exist and passes after relocation.

Final gates:

```text
rtk npm test
rtk npm run typecheck
rtk npm run build
rtk npm audit --json
git diff --check
```

No live production probe is part of this implementation. A sanitized staging webhook shape check is permitted after local verification and must not display donor/payment values.

## Rollout and rollback

1. Apply migration 0017 before deploying code that creates draft capabilities.
2. Deploy to staging with TEST-only secrets and verify a sanitized/mocked intent checkout plus strict webhook shape.
3. Confirm incompatible ambiente `01` events cannot queue in staging.
4. Deploy production only through the existing production workflow after review.
5. Rollback code remains safe with nullable `datos_token_hash`; the additive column need not be removed. Old code would ignore it, so rollback should be short-lived and accompanied by disabling public draft creation until the fixed version returns.

## Out of scope

- Rewriting the entire Worker router.
- Adding a framework, ORM, secret manager dependency, or WAF dependency.
- Deploying or hardening the ignored Java signer.
- Changing donation amounts, fiscal validation rules, email templates, visual design, analytics, or branding behavior.
- Production deployment or provider-side key/certificate reissuance without separate live-environment proof.
