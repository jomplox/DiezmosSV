# Rejected CDE Detail Design

**Date:** 2026-07-11

**Status:** Approved in conversation; pending review of this written specification.

## Objective

Show operators why a CDE was rejected and when the current rejection was recorded. The detail appears only for documents whose current status is `REJECTED` and is placed at the bottom of the document detail panel, immediately above **Ver JSON completo**.

The UI must display:

- a readable rejection reason derived from the stored MH response;
- the latest relevant rejection-event timestamp formatted in El Salvador time;
- explicit unavailable text instead of inventing a reason or timestamp when legacy evidence is incomplete.

## Existing evidence

No migration or new API route is required:

- `dte_documents.mh_observaciones_json` stores the observations associated with the current MH result;
- `dte_documents.mh_estado` stores the current MH state;
- `GET /api/documents/:id` already returns the document's ordered audit trail along with the document;
- audit rows are immutable evidence and include `created_at` for initial rejections, advanced-CDE rejections, and operator retries.

For non-2xx MH responses, `mh_observaciones_json` can contain a stringified JSON response rather than a simple observation string. The client therefore needs bounded, defensive parsing before displaying it.

## Considered approaches

### 1. Use the existing MH observations and audit trail - selected

Parse the current document's MH observations into human-readable reason lines and use the newest relevant audit row as the rejection timestamp. This preserves the existing persistence model, uses immutable event evidence for time, and requires no backend or schema change.

### 2. Display `dte_documents.updated_at`

This is smaller, but `updated_at` also changes when operators edit an email address, retry processing, or perform other document updates. Presenting it as the rejection time could therefore be false.

### 3. Add a `rejected_at` column

An explicit column would provide a direct projection but requires a migration, backfill rules for existing rows, and updates across every issuance/retry path. The audit trail already contains the needed immutable event, so this is unnecessary for the current requirement.

## Rejection-detail contract

Introduce a small pure client helper that accepts a `DteDocument` and its `AuditRow[]` and returns either `null` or:

```ts
interface RejectionDetail {
  reasons: string[];
  rejectedAt: string | null;
}
```

The helper returns `null` unless `document.status === "REJECTED"`.

### Reason parsing

1. Parse the outer `mh_observaciones_json` array without throwing.
2. Preserve ordinary non-empty observation strings.
3. When an observation is itself JSON, inspect only its top-level object and optional `body` object for:
   - `codigoMsg`;
   - `descripcionMsg`;
   - `observaciones` string entries.
4. Present a code and description together when both exist, append distinct observations, and remove duplicates.
5. If no readable observation exists, use a non-empty `mh_estado` as the fallback reason.
6. If neither source exists, return `Motivo no disponible`.

Raw JSON and unrelated response fields are never rendered in this block.

### Timestamp selection

Because the detail endpoint orders audit rows newest first, select the first row whose action is one of:

- `DTE_REJECTED`;
- `ADVANCED_CDE_REJECTED`;
- `DTE_RETRIED`.

`DTE_RETRIED` is eligible only because the helper already requires the document's current status to be `REJECTED`; in that state, the latest completed retry produced the current rejection. Format its `created_at` with the existing `formatElSalvadorDateTime` helper and label it as El Salvador time.

If no matching audit row has a valid timestamp, display `Fecha no disponible`. Do not substitute `updated_at`.

## Client data flow

Extend the existing selected-document detail fetch in `App.tsx` to retain the returned `audit` array in addition to `donorDataVerified`. The existing cancellation guard continues to prevent a slower response for a previously selected document from overwriting the current selection.

On selection removal or detail-fetch failure, clear both the donor-verification state and selected-document audit state. Pass the audit rows into `DetailPanel`, where the pure helper derives the optional display model.

The list endpoint, detail endpoint, repository, database schema, and MH pipeline remain unchanged.

## Presentation

Add a compact `rejection-detail` section between the action buttons and **Ver JSON completo**:

- danger-tinted border and background consistent with existing rejection styling;
- heading **Detalle del rechazo** with the warning icon;
- a **Motivo** label followed by one or more readable reason lines;
- a **Fecha y hora** label followed by `DD/MM/YYYY, HH:mm hora El Salvador`, or the explicit unavailable text;
- wrapping for long MH messages without horizontal overflow.

The block is informational and contains no new controls.

## Error handling

- Malformed outer or nested JSON must not crash the document panel.
- Empty, non-array, or unexpected MH values fall through to `mh_estado` or the unavailable message.
- Invalid audit timestamps display `Fecha no disponible`.
- A failed detail request still shows the reason already present on the document record, while the timestamp falls back to `Fecha no disponible`; the rest of the document panel remains usable.

## Verification strategy

Add focused tests before implementation:

- direct observation strings produce readable reasons;
- an HTTP error's stringified MH JSON yields its code, description, and observations without showing raw JSON;
- duplicate messages are removed;
- the newest relevant audit event supplies the timestamp;
- unrelated audit actions and `updated_at` are not used;
- malformed or missing evidence produces the explicit fallback text;
- non-rejected documents produce no rejection detail.

Add a client source/style regression confirming the block appears above **Ver JSON completo** and uses a wrapping, danger-tinted presentation. Then run typecheck, the full test suite, the production build, private-boundary validation, and rendered-browser verification with a rejected document carrying representative MH evidence.

## Non-goals

- Changing MH transmission, retry, or rejection persistence.
- Adding a database migration or new API endpoint.
- Displaying rejection details for `FAILED`, deferred, accepted, or invalidated documents.
- Rendering the complete raw MH response in the always-visible panel.
- Changing the audit log UI.
