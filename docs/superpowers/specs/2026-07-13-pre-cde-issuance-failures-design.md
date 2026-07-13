# Pre-CDE Issuance Failures and Stable Identifier Retry Design

**Date:** 2026-07-13

**Status:** Approved in conversation and reviewed; ready for implementation.

## Objective

Make a paid Wompi donation visible to operators when issuance fails before a
`dte_documents` row exists, without pretending that a legal CDE was created. The
**Fallos** view will label this state **CDE no creado**, show the useful failure
evidence, and provide a safe retry action.

At the same time, make issuance retries idempotent at the document-identity boundary:
one approved Wompi event owns one locally reserved `numeroControl` and
`codigoGeneracion`. Queue redelivery, local pipeline retry, or an operator retry must
reuse those identifiers instead of consuming another control sequence.

## Regulatory and incident evidence

The control number is assigned by the issuer; MH does not dispense it. MH returns the
`selloRecibido` only after receiving and accepting a DTE. The current MH functional
manual describes the final 15 digits of `numeroControl` as sequential and requires the
number not to repeat during the calendar year. The MH transmission manual's no-response
procedure first queries the transmitted document and then resends the same reception
request if MH did not receive it. A transport retry is therefore the same DTE, not a new
control number.

Authoritative source supplied for implementation:

- `V2 - DTE (mayo 2026)/Manual Funcional del Sistema de Transmisión V 2.0.pdf`,
  manual pages 28-29;
- `V2 - DTE (mayo 2026)/Manual Técnico para la Integración Tecnológica del
  Sistema de Transmisión v2.pdf`, manual pages 14-15.

The same manuals are published through [MH technical and functional documentation](https://factura.gob.sv/informacion-tecnica-y-funcional/).

The failed staging donation `wompi_226a47e9-39e3-4418-b1f2-2b46e29849e8` never created
a `dte_documents` row and was never signed or sent to MH. Its four queue deliveries
advanced the local test sequence from 31 through 34 because sequence allocation occurs
before schema validation. Those numbers were consumed only by the local counter; MH did
not receive or spend them.

This design distinguishes three cases:

- A failure before a DTE exists reuses the event's reserved identifiers.
- A local or transport retry after a DTE exists reuses its persisted JSON, signature,
  `numeroControl`, and `codigoGeneracion`.
- A document that MH explicitly rejected because of its content is a separate correction
  workflow. Replacing corrected content is not treated as a retransmission of the same
  DTE and is outside this change.

## Considered approaches

### 1. Persist issuance state on `wompi_events` - selected

Add the small amount of pre-CDE lifecycle state to the source event that already has a
one-to-one relationship with online issuance. This keeps one authoritative row per Wompi
event, avoids duplicating donor data, and automatically keeps the new evidence inside the
existing Wompi retention export.

### 2. Create a separate pre-CDE failure table

This provides a strong conceptual boundary but duplicates the event's identity and adds a
new table to backup, restore, retention, and deletion ordering. There is only one issuance
lifecycle per Wompi event, so a second table adds machinery without adding a needed
relationship.

### 3. Derive failures only from audit rows

Audit rows explain that a failure occurred but cannot safely own a control-number
reservation or support atomic retry state. Parsing free-form audit text would also make
the operator API brittle. Audit remains immutable evidence, not the current-state model.

## Persistence contract

Add nullable pre-CDE issuance columns to `wompi_events` in the next migration:

- `issuance_status`: `PROCESSING`, `FAILED`, `DEAD_LETTERED`, `RETRY_QUEUED`,
  `DOCUMENT_CREATED`, or `IGNORED`;
- `control_prefix`, `control_sequence`, `reserved_numero_control`, and
  `reserved_codigo_generacion`;
- `issuance_attempt_count` with a default of zero;
- `issuance_error_code` and `issuance_error_message`;
- `issuance_last_attempt_at`, `issuance_failed_at`, and
  `issuance_dead_lettered_at`.

`created_document_id` remains the authoritative success link. A partial unique index on
`(environment, control_prefix, control_sequence)` and one on
`reserved_codigo_generacion` prevent two events from owning the same identifiers.

Legacy events keep the new columns null. They are not shown as failures merely because
they have no document. An explicit `FAILED` or `DEAD_LETTERED` status makes an item
eligible for **CDE no creado**; after an operator retries it, the same item remains
visible in `RETRY_QUEUED` or `PROCESSING` while it retains prior failure evidence.

The stored error is an operator-safe projection, not a stack trace or raw webhook. The
repository records a stable error code plus a whitespace-normalized message capped at
1,000 characters. Raw payment data, headers, tokens, certificate data, and stack traces
must never enter these fields or the list API.

## Identifier reservation and retry invariant

Introduce one repository operation,
`reserveWompiDocumentIdentifiers(wompiEventId, environment, controlPrefix)`, with this
contract:

1. If the event already has a complete reservation, return it unchanged.
2. Otherwise, atomically claim the current `document_sequences.next_value`, increment
   that counter exactly once, and store one generated `codigoGeneracion` with the
   complete reservation on the event.
3. Concurrent callers for the same event return the winning reservation; they never
   allocate a second sequence.
4. A partial or environment/prefix-mismatched reservation is an integrity error and is
   not silently replaced.

Use one guarded event update plus a migration trigger so allocation is atomic in D1:

1. The repository generates a candidate `codigoGeneracion` and updates
   `control_prefix` plus that code only when the event has no reservation.
2. An `AFTER UPDATE` trigger, restricted to the null-to-reserved transition, creates the
   sequence row if needed, copies its current value into `control_sequence`, formats
   `reserved_numero_control`, and increments `next_value`.
3. The trigger and guarded event update commit as one SQLite statement. The repository
   then reads and returns the complete reservation.
4. A concurrent loser changes zero rows and reads the winner's reservation.

A read followed by an unguarded increment is not acceptable.

Run permanent checks that do not require document identifiers before reservation. Once
reserved, pass both stored identifiers into the CDE builder; the builder must not generate
new identifiers internally for that event. If construction or schema validation then
fails, the reservation stays attached to the event and every retry reuses it.

When a `dte_documents` row already exists for the Wompi event, queue processing must
resume that stored document through `processDteDocument` instead of returning early or
rebuilding it. This preserves the exact JSON and identifiers across signing and MH
transport failures. Existing accepted, rejected, and invalidated terminal guards remain
authoritative.

## Failure recording

For an approved Wompi event, the queue handler records the start of an attempt. If an
exception escapes before `created_document_id` exists, it atomically:

- increments `issuance_attempt_count`;
- sets `issuance_status = 'FAILED'`;
- stores the bounded error code and message;
- updates `issuance_last_attempt_at` and `issuance_failed_at`;
- writes an immutable `WOMPI_ISSUANCE_FAILED` audit row;
- then asks Cloudflare Queues to retry the same `wompiEventId`.

The dead-letter handler sets `issuance_status = 'DEAD_LETTERED'` and
`issuance_dead_lettered_at` before sending the existing operational alert. It retains the
last concrete error instead of replacing it with the generic dead-letter message.

Permanent paid-event failures, including invalid donor data or a quarantined intent
binding, use `FAILED` with a specific operator-safe error code and reason. Non-approved
Wompi events use `IGNORED` and never appear as paid issuance failures.

After successful document creation, the same write that links `created_document_id` sets
`issuance_status = 'DOCUMENT_CREATED'` and clears retry-queue state. The pre-CDE item then
disappears. If the resulting DTE later becomes `FAILED` or `REJECTED`, it appears through
the existing document failure path.

## Operator API and retry

Add authenticated `GET /api/wompi-events/issuance-failures` for unresolved pre-CDE
failures. It returns only:

- Wompi event ID;
- issuance state and attempt count;
- donor display name and email already stored on the event;
- amount and received/failure timestamps;
- safe error code and message;
- reserved `numeroControl`, when allocation reached that point.

It never returns `raw_body`, webhook headers, donor documents, addresses, payment-link
URLs, or internal stack traces.

Add `POST /api/wompi-events/:id/retry` for `OPERATOR`, `ADMIN`, and `OWNER`. The route:

1. permits only `FAILED` or `DEAD_LETTERED` events with no `created_document_id`;
2. uses a compare-and-swap update to `RETRY_QUEUED`, so repeated clicks do not create a
   retry storm;
3. queues the same `wompiEventId`, never a newly constructed payload;
4. writes a `WOMPI_ISSUANCE_RETRY_QUEUED` audit row;
5. returns the current state if another request already won the retry claim.

Queue delivery remains idempotent even if the database update and queue send are separated
by a crash. The scheduled stalled-event sweep must recover a stale `RETRY_QUEUED` item;
the stable reservation and unique document link make a duplicate delivery harmless.

## Fallos presentation

The **Fallos** page keeps legal DTE rows and pre-CDE failures visually distinct. Above
the existing table, show an unresolved online-issuance section when items exist. Each item
uses the honest status badge **CDE NO CREADO** and displays:

- donor name/email, amount, and payment-received time;
- `Intentos: N`;
- the exact safe failure message;
- `Número reservado: ...` when present, otherwise `Número aún no asignado`;
- **Reintentar creación** when the role and state allow it.

While a retry is queued, the button is disabled and reads **Reintento en cola**. A failure
to load this section does not hide or disable the existing DTE failure list; it produces a
separate inline error. The empty state says there are no paid donations awaiting CDE
creation, without claiming that the entire DTE failure list is empty.

The record must never be inserted into `dte_documents` merely to make it visible. It has
no PDF, JSON download, MH seal, invalidation action, or CDE control-number label beyond an
explicitly identified local reservation.

## Retention, recovery, and operations

Because the state lives on `wompi_events`, the existing Wompi NDJSON retention export
includes it without a new archive table. Tests must confirm the export contains the new
columns and that old archives whose rows omit them remain restorable after migrations.
The operator runbook must explain **CDE no creado**, safe retry, escalation, and the
difference between a local reservation and an MH-accepted CDE.

The staging incident is recovered separately after deployment, not by a broad migration:

1. pause new staging Wompi issuance;
2. re-check that 31 through 34 have no `dte_documents` rows, signatures, MH responses, or
   reservations and that the counter is still at the expected value;
3. atomically reserve 31 for the exact failed event and set the next free sequence to 32;
4. retry that event through the normal operator action;
5. prove that the resulting test CDE uses 31, receives an MH test seal, and leaves the
   counter at 32;
6. resume staging issuance.

Abort recovery if any invariant changed. Production counters are never rewound by this
change, and implementation work alone does not authorize a deployment or database
mutation.

## Verification strategy

Add focused failing tests before implementation for:

- one Wompi event receiving one reservation across four queue attempts;
- concurrent reservation calls returning the same sequence and generation code while the
  counter increments once;
- builder retries receiving the stored identifiers;
- an existing pre-MH document resuming from persisted JSON instead of rebuilding;
- a pre-reservation permanent failure appearing with `Número aún no asignado`;
- bounded safe error persistence and dead-letter state retaining the concrete error;
- successful document creation resolving the pre-CDE item;
- API role checks, allowlisted response shape, and absence of raw webhook data;
- compare-and-swap retry behavior and stalled queued-retry recovery;
- separate **CDE NO CREADO** UI rendering and retry-button states;
- retention export and legacy restore compatibility;
- migration uniqueness and atomic-allocation behavior against real SQLite.

Keep the existing `$1.11` schema-validation regression that reproduces this incident.
Then run focused worker/client tests, migration tests, the full test suite, typecheck,
production build, private-boundary validation, and rendered-browser verification.

## Non-goals

- Creating a synthetic legal CDE row for a failed attempt.
- Automatically deploying or mutating staging/production data.
- Rewinding production control sequences.
- Changing the correction workflow for a DTE that MH explicitly rejected.
- Exposing raw Wompi webhooks, payment credentials, donor documents, or stack traces.
- Adding new notification channels or unrelated Fallos redesign work.
