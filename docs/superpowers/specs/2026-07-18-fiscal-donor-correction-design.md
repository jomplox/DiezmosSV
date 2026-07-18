# Guarded Fiscal Donor Correction Design

**Date:** 2026-07-18

**Status:** Approved in conversation; ready for implementation planning.

## Objective

Let an authorized operator correct structured donor/receptor data and safely retry:

1. a paid Wompi event that failed before a CDE was created; and
2. a CDE whose content the Ministerio de Hacienda (MH) explicitly rejected.

The workflow must preserve the original evidence, prevent duplicate fiscal operations,
keep protected payment and issuer data immutable, and expose one guarded
**Guardar y reintentar** action.

## Existing behavior and root causes

The **Fallos** view currently combines two distinct failure stages:

- **CDE NO CREADO** represents a paid Wompi event whose issuance failed before a
  `dte_documents` row existed.
- **RECHAZADO** represents a CDE that was built, signed, transmitted, and explicitly
  rejected by MH.

Neither path currently lets an operator correct donor data:

- `POST /api/wompi-events/:id/retry` only claims and queues the same event. It accepts no
  corrected data.
- Permanent pre-CDE validation failures mark `processed_at`, while the normal
  `processWompiEvent` entry guard stops processed events. The current manual retry does
  not reopen that lifecycle state.
- A rejected Wompi CDE is rebuilt from the original Wompi payload and correlated
  donation intent, so unchanged donor data produces the same content error.
- A rejected non-Wompi CDE retains its existing signed JWS; retransmitting that same
  rejected content cannot correct an MH content verdict.

The current email-only edit is unrelated. Changing `donor_email` for receipt delivery
does not change the legal `receptor` inside the CDE.

## Design principles

- A payment that has not produced a CDE keeps its existing local identifier reservation.
- A document explicitly rejected by MH is corrected as a new fiscal attempt with new
  `numeroControl` and `codigoGeneracion`.
- The existing `dte_documents` row remains the one authoritative document link for its
  Wompi event. Rejected versions are preserved in immutable correction history before
  that row is replaced with corrected content.
- Only structured receptor fields are editable. Amount, gift type, payment reference,
  issuer identity, emission environment, and system-controlled identifiers remain
  immutable.
- Every external side effect is claim-before-dispatch and idempotent by one
  client-generated correction request ID.
- Unknown MH transport outcomes remain locked for reconciliation and are never
  automatically resent.

## Considered approaches

### 1. Structured source correction with immutable history — selected

Store one normalized correction record, preserve rejected evidence, and apply the
correction through the existing builders and issuance claims. This keeps one Wompi
event-to-document relationship while making every correction auditable.

### 2. Create a separate replacement `dte_documents` row

This naturally preserves the rejected row but complicates the existing one-payment,
one-document relationship, intent completion, email delivery, analytics, retention, and
operator navigation. It adds more lifecycle machinery than this correction workflow
needs.

### 3. Allow raw JSON editing

This is flexible but would expose issuer identity, totals, payment references, fiscal
catalog values, and identifiers to accidental mutation. It is rejected.

## Editable receptor contract

The client and server share one normalized correction shape:

- document type (`CAT-022`);
- document number, including DUI check-digit and NIT format validation;
- donor name or legal name;
- NRC, when applicable;
- economic activity code (`CAT-019`) and description, when applicable;
- email and telephone;
- fiscal domicile (`CAT-032`);
- country (`CAT-020`);
- department (`CAT-012`);
- municipality (`CAT-013`);
- district (`CAT-008`);
- complete address.

Domestic geography requires a valid department/municipality/district relationship.
Foreign donors use the existing foreign-receptor rules: the legal CDE carries
`direccion: null`, the selected country, non-domiciled status, and the written foreign
address in the established appendix representation.

Server validation is authoritative and reuses existing DUI, NIT, catalog, geography,
length, email, and CDE schema validation. The server builds and validates a complete
candidate CDE before claiming a retry or allocating a new sequence.

The following fields are never accepted from a correction request:

- amount or donation line values;
- gift type;
- Wompi transaction, authorization, or payment-link identity;
- issuer fields;
- environment;
- emission timestamps;
- `numeroControl`, `codigoGeneracion`, or MH seal;
- payment method or payment reference;
- arbitrary CDE JSON.

An MH rejection concerning protected issuer, payment, or system fields directs the
operator to **Configuración** or technical support instead of exposing those fields.

## Persistence

Add a `fiscal_corrections` table with:

- `id`: internal correction ID;
- `request_id`: globally unique client-generated idempotency key;
- `target_kind`: `WOMPI_EVENT` or `DTE_DOCUMENT`;
- `wompi_event_id`: nullable source event;
- `document_id`: nullable source document;
- `environment`;
- `status`: `QUEUED`, `PROCESSING`, `ACCEPTED`, `REJECTED`, `FAILED`, or
  `REVIEW_REQUIRED`;
- `before_receptor_json`: normalized effective receptor before the edit;
- `corrected_receptor_json`: validated normalized receptor;
- `changed_fields_json`: sorted allowlisted field names;
- `source_document_snapshot_json`: nullable immutable snapshot of the rejected
  document's identifiers, `plain_json`, `signed_jws`, MH state, observations, and
  timestamps;
- `request_payload_sha256`: stable digest used to reject reuse of one request ID with
  different corrected data;
- `attempt_number`: immutable per-target sequence used for operator history;
- `issuance_attempt_id`: pre-CDE queue ownership token when applicable;
- `fiscal_claim_id`: rejected-document fiscal ownership token when applicable;
- `processing_claim_id`: rotating ownership token for one correction queue delivery;
- `processing_started_at` and `mh_dispatch_started_at`, kept separate so recovery can
  distinguish safe pre-dispatch work from an uncertain external outcome;
- bounded operator-safe failure code and message;
- `created_by`, `created_at`, `completed_at`, and `updated_at`.

Constraints require the target columns appropriate to `target_kind`. `request_id` is
unique. A request ID reused for a different target or corrected payload is a conflict;
the same request repeated for the same target and payload returns the existing
correction.

The table contains fiscal PII under the same authenticated application boundary as
`dte_documents` and `donation_intents`. It is included in retention export, restore,
deletion ordering, and integrity checks. General audit metadata stores only the
correction ID and changed field names, not before/after PII.

## Read APIs

Add role-protected correction-detail endpoints for `OPERATOR`, `ADMIN`, and `OWNER`:

- `GET /api/wompi-events/:id/correction-data`;
- `GET /api/documents/:id/correction-data`.

Each endpoint returns only the normalized editable receptor, target status, safe MH or
local failure reason, and a classification indicating whether the failure is
correctable here or belongs in **Configuración**. It never returns raw Wompi bodies,
signatures, secrets, uneditable CDE sections, or internal stack traces.

## Guarded mutation APIs

Add:

- `POST /api/wompi-events/:id/correct-and-retry`;
- `POST /api/documents/:id/correct-and-retry`.

The request body contains only:

- `correctionRequestId`;
- the normalized receptor correction.

Both endpoints require `OPERATOR` or higher. They validate the full candidate before any
state mutation.

### Pre-CDE flow

The target must:

- have no `created_document_id`;
- be in `FAILED` or `DEAD_LETTERED`;
- represent an approved payment;
- have no active issuance attempt.

One transactional repository operation:

1. inserts the idempotent correction;
2. compare-and-swaps the event to `RETRY_QUEUED`;
3. records one new issuance attempt ID;
4. reopens the permanent-failure lifecycle by clearing `processed_at`;
5. retains any existing identifier reservation unchanged;
6. writes the correction audit reference.

The route then queues the exact Wompi event, issuance attempt ID, and correction ID.
Queue processing loads that exact correction and maps it to the builder's receptor
override. It never mutates the raw Wompi webhook or the original donation intent.

If no identifiers were reserved, normal issuance reserves them once after the corrected
candidate passes deterministic validation. If they already exist, they are reused.

### Rejected-CDE flow

The target must:

- currently be `REJECTED`;
- have no active fiscal claim;
- not be accepted, invalidated, or pending reconciliation.

One transactional repository operation:

1. validates the candidate using the target's immutable payment and issuer inputs;
2. inserts the correction and complete rejected-document snapshot;
3. claims the document for this correction before sequence allocation;
4. records the correction audit reference.

The correction queue then:

- rebuilds a Wompi document from its payment payload plus the exact corrected receptor;
- or rebuilds a non-Wompi document from its stored protected sections plus the exact
  corrected receptor;
- allocates one new `numeroControl` and `codigoGeneracion`;
- signs and transmits under the existing fiscal claim;
- replaces the current `dte_documents` content only after the rejected snapshot is
  durable.

This preserves the existing one-to-one Wompi document link while retaining every
rejected version in `fiscal_corrections`.

## Queue, claims, and recovery

Both mutation APIs return `202` after durable storage and queue submission. The UI
refreshes the target status rather than holding an MH request open.

The queue message carries the correction ID, its rotating processing token, and the
appropriate issuance or fiscal claim token. Processing compares all ownership tokens
before building, signing, or transmitting. Safe stale-work recovery rotates the
processing token before requeueing, which fences out an older delivery.

- A failure proven to occur before MH dispatch releases the operational claim and marks
  the correction `FAILED`, allowing an explicit new guarded attempt.
- An explicit MH rejection marks the correction `REJECTED`, preserves its result, and
  leaves the document eligible for another correction.
- MH acceptance marks the correction `ACCEPTED` and runs normal post-accept
  finalization and receipt delivery.
- A timeout, abort, internal transport failure, or otherwise uncertain outcome retains
  the fiscal claim and marks the correction `REVIEW_REQUIRED`.

The scheduled recovery sweep requeues stale `QUEUED` corrections and safe
pre-dispatch `PROCESSING` corrections. It never requeues `REVIEW_REQUIRED` or any
correction whose MH dispatch outcome is uncertain.

A database commit followed by queue-send failure remains recoverable because the
correction row and ownership token are durable before `send()`.

## Operator experience

### Pre-CDE cards

For deterministic donor/receptor errors, replace blind **Reintentar creación** with
**Corregir y reintentar**. Transient non-data failures may retain the ordinary retry
action.

### Rejected document detail

For explicit MH content rejection, show **Corregir y reintentar** next to the rejection
reason. Ordinary retry remains for safe local or pre-dispatch failures that do not need
new content. A rejected document is never retransmitted with its unchanged signed JWS.

### Correction dialog

The dialog:

- displays the current safe rejection reason;
- prefills the effective receptor;
- groups identity, optional business data, contact, and residence;
- uses catalog selects and conditional domestic/foreign fields;
- shows protected payment and issuer facts as read-only context;
- validates inline;
- disables **Guardar y reintentar** until at least one field changed and all fields are
  valid;
- submits one stable `correctionRequestId` for the user action;
- keeps the same request ID through network retries until the server returns a
  definitive result.

The list and detail panel show `Corrección en cola`, `Procesando corrección`,
`Revisión necesaria`, or the latest explicit MH rejection as appropriate.

## Auditing and observability

Write immutable audit actions:

- `FISCAL_CORRECTION_QUEUED`;
- `FISCAL_CORRECTION_STARTED`;
- `FISCAL_CORRECTION_ACCEPTED`;
- `FISCAL_CORRECTION_REJECTED`;
- `FISCAL_CORRECTION_FAILED`;
- `FISCAL_CORRECTION_REVIEW_REQUIRED`.

Audit metadata includes the correction ID, target, request ID hash, changed field names,
attempt number, and safe outcome code. It excludes document values and raw provider
payloads.

Operational errors use the existing Cloudflare-native logging and alert event path.
Safe error messages remain visible in **Fallos**; stack traces and secrets remain only
in protected Cloudflare logs.

## Verification strategy

Implementation follows red-green TDD. Required coverage includes:

- complete correction-field server validation;
- protected-field rejection and absence from API responses;
- role checks;
- pre-CDE permanent-failure reopening;
- reuse of existing pre-CDE identifiers;
- no sequence allocation when corrected data is invalid;
- rejected-document snapshot durability before replacement;
- new identifiers for every explicit rejected-content correction;
- Wompi and non-Wompi rejected-document rebuilding;
- idempotent repeated HTTP requests and double-clicks;
- concurrent correction claim losers;
- queue-send crash recovery;
- pre-dispatch release versus ambiguous-dispatch lock;
- repeated explicit MH rejection followed by another correction;
- acceptance finalization and receipt delivery;
- audit PII exclusion;
- retention export/restore and migration integrity;
- correction dialog rendering, conditional fields, validation, and busy states;
- regression proving unchanged rejected JWS is never retransmitted as a correction.

Run focused repository, worker, pipeline, and client tests after each red-green cycle.
Before completion run the full test suite, typecheck, production build, generated Worker
type check, migration checks, `git diff --check`, and rendered browser QA with a clean
console.

## Deployment and existing records

After local verification, push the implementation and wait for exact-commit GitHub CI.
Deploy only to Cloudflare staging after CI succeeds.

The migration does not automatically correct or retry existing records. An operator
must open each existing failure, review the prefilled data, change at least one field,
and press **Guardar y reintentar**. Production deployment or data mutation requires
separate authorization.

## Non-goals

- Editing accepted or invalidated CDEs.
- Automatically guessing corrected donor values.
- Mutating Wompi payment truth or raw webhook evidence.
- Editing amount, gift type, issuer data, payment data, environment, or identifiers.
- Allowing arbitrary JSON changes.
- Automatically retrying historical failures during deployment.
- Treating an uncertain MH transport outcome as safe to resend.
- Deploying to Cloudflare production.
