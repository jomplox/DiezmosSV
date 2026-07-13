# Pre-CDE Issuance Failures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show paid Wompi donations that failed before document creation as honest **CDE NO CREADO** records and guarantee that every retry of one logical donation reuses one reserved control number and generation code.

**Architecture:** Extend the existing one-to-one `wompi_events` lifecycle with nullable issuance state and an atomic SQLite-trigger-backed identifier reservation. The queue persists bounded failure evidence, resumes an existing `dte_documents` row when one exists, and exposes a least-privilege list/retry API. The React Fallos view renders these pre-CDE records separately from legal DTE rows.

**Tech Stack:** Cloudflare Workers and Queues, D1/SQLite migrations, TypeScript, React 19, Ajv 8, Vitest 4, Vite 8.

## Global Constraints

- The authoritative protocol sources are the supplied May 2026 `Manual Funcional del Sistema de Transmisión V 2.0.pdf` pages 28-29 and `Manual Técnico para la Integración Tecnológica del Sistema de Transmisión v2.pdf` pages 14-15.
- One approved Wompi event owns one `numeroControl` and one `codigoGeneracion`; queue, local-pipeline, and operator retries reuse them.
- Never create a synthetic `dte_documents` row merely to make a failed attempt visible.
- Never return `raw_body`, webhook headers, donor documents, addresses, payment-link URLs, credentials, certificate data, or stack traces from the failure API.
- Store only a stable error code and a whitespace-normalized message of at most 1,000 characters.
- Do not add dependencies.
- Do not deploy, push, or mutate remote staging/production data in this plan.
- Preserve unrelated untracked files whose names end in ` 2` and all unrelated branch work.

---

### Task 1: Preserve the exact monetary regression fix

**Files:**
- Modify: `test/worker/dteBuilder.test.ts`
- Modify: `src/worker/domain/schema.ts`

**Interfaces:**
- Consumes: `buildCdeDocument(payload, config, options)` and the MH CDE JSON schema.
- Produces: Ajv validation that accepts ordinary two-decimal monetary values despite IEEE-754 representation noise.

- [ ] **Step 1: Keep the failing `$1.11` regression test**

```ts
it("builds a schema-valid CDE for cent amounts that are not binary-exact", () => {
  const document = buildCdeDocument(
    { ...wompiSample, Monto: "1.11" } as WompiWebhook,
    emisorConfig,
    { sequence: 1, issuedAt: new Date("2026-07-13T16:06:23.4101468-06:00") }
  ) as Record<string, any>;

  expect(document.cuerpoDocumento[0].valorUni).toBe(1.11);
  expect(document.cuerpoDocumento[0].valor).toBe(1.11);
  expect(document.resumen.valorTotal).toBe(1.11);
  expect(document.resumen.pagos[0].montoPago).toBe(1.11);
});
```

- [ ] **Step 2: Reconfirm the test fails without the fix**

Run: `rtk npm test -- test/worker/dteBuilder.test.ts`

Expected before the Ajv option: FAIL with `must be multiple of 0.01` for `valorTotal` and `montoPago`.

- [ ] **Step 3: Keep the minimal Ajv precision option**

```ts
const ajv = new Ajv({ allErrors: true, strict: false, multipleOfPrecision: 12 });
```

- [ ] **Step 4: Verify the focused test is green**

Run: `rtk npm test -- test/worker/dteBuilder.test.ts`

Expected: 26 tests passed, 0 failed.

- [ ] **Step 5: Commit the isolated regression fix**

```bash
rtk git add src/worker/domain/schema.ts test/worker/dteBuilder.test.ts
rtk git commit -m "fix: accept cent amounts in CDE validation"
```

### Task 2: Add an atomic Wompi document-identifier reservation

**Files:**
- Create: `migrations/0019_wompi_issuance_lifecycle.sql`
- Create: `test/worker/wompiIssuanceSchema.test.ts`
- Modify: `src/worker/types.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `src/worker/domain/dteBuilder.ts`
- Modify: `test/worker/dteBuilder.test.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Produces: `WompiIssuanceStatus`, `WompiDocumentIdentifiers`, extended `WompiEventRecord`, and `Repository.reserveWompiDocumentIdentifiers(wompiEventId, environment, controlPrefix)`.
- Produces: optional `codigoGeneracion` in `CdeBuildOptions`; callers that omit it retain current generated-code behavior.

- [ ] **Step 1: Write real-SQLite failing migration tests**

Create tests that apply `0001_init.sql` and the new migration to `DatabaseSync(":memory:")`, insert two approved Wompi events, and assert:

```ts
expect(reservation("wompi_a")).toEqual({
  control_sequence: 1,
  reserved_numero_control: "DTE-15-M001P004-000000000000001",
  reserved_codigo_generacion: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
});
expect(nextValue()).toBe(2);

reserve("wompi_a", "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB");
expect(reservation("wompi_a")?.control_sequence).toBe(1);
expect(nextValue()).toBe(2);

reserve("wompi_b", "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC");
expect(reservation("wompi_b")?.control_sequence).toBe(2);
expect(nextValue()).toBe(3);
```

Also assert that duplicate reserved generation codes and duplicate `(environment, control_prefix, control_sequence)` values violate the unique indexes.

- [ ] **Step 2: Run the schema test and watch it fail**

Run: `rtk npm test -- test/worker/wompiIssuanceSchema.test.ts`

Expected: FAIL because migration `0019_wompi_issuance_lifecycle.sql` and its columns do not exist.

- [ ] **Step 3: Add the migration and one-shot trigger**

Use these columns and constraints:

```sql
ALTER TABLE wompi_events ADD COLUMN issuance_status TEXT
  CHECK (issuance_status IN ('PROCESSING', 'FAILED', 'DEAD_LETTERED', 'RETRY_QUEUED', 'DOCUMENT_CREATED', 'IGNORED'));
ALTER TABLE wompi_events ADD COLUMN control_prefix TEXT;
ALTER TABLE wompi_events ADD COLUMN control_sequence INTEGER;
ALTER TABLE wompi_events ADD COLUMN reserved_numero_control TEXT;
ALTER TABLE wompi_events ADD COLUMN reserved_codigo_generacion TEXT;
ALTER TABLE wompi_events ADD COLUMN issuance_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (issuance_attempt_count >= 0);
ALTER TABLE wompi_events ADD COLUMN issuance_error_code TEXT;
ALTER TABLE wompi_events ADD COLUMN issuance_error_message TEXT;
ALTER TABLE wompi_events ADD COLUMN issuance_last_attempt_at TEXT;
ALTER TABLE wompi_events ADD COLUMN issuance_failed_at TEXT;
ALTER TABLE wompi_events ADD COLUMN issuance_dead_lettered_at TEXT;

CREATE UNIQUE INDEX idx_wompi_reserved_control
  ON wompi_events(environment, control_prefix, control_sequence)
  WHERE control_sequence IS NOT NULL;
CREATE UNIQUE INDEX idx_wompi_reserved_generation
  ON wompi_events(reserved_codigo_generacion)
  WHERE reserved_codigo_generacion IS NOT NULL;
CREATE UNIQUE INDEX idx_dte_documents_wompi_unique
  ON dte_documents(wompi_event_id)
  WHERE wompi_event_id IS NOT NULL;
```

The `AFTER UPDATE OF control_prefix, reserved_codigo_generacion` trigger must run only when the old reservation is null and the new prefix/code are non-null. In the same trigger statement it inserts the `document_sequences` row if absent, copies the current value into the event, formats `DTE-15-<prefix>-<15 digits>` with `printf('%015d', value)`, and advances `next_value` only when it still equals the event's claimed value.

- [ ] **Step 4: Extend the shared worker types**

```ts
export type WompiIssuanceStatus =
  | "PROCESSING"
  | "FAILED"
  | "DEAD_LETTERED"
  | "RETRY_QUEUED"
  | "DOCUMENT_CREATED"
  | "IGNORED";

export interface WompiDocumentIdentifiers {
  sequence: number;
  numeroControl: string;
  codigoGeneracion: string;
}
```

Add every migration column to `WompiEventRecord` with the matching nullable snake-case field type.

- [ ] **Step 5: Write failing repository and builder tests**

Add focused assertions that two calls return identical identifiers and that an injected code reaches the built document:

```ts
const identifiers = await repo.reserveWompiDocumentIdentifiers("wompi_1", "00", "M001P004");
const repeated = await repo.reserveWompiDocumentIdentifiers("wompi_1", "00", "M001P004");
expect(repeated).toEqual(identifiers);
expect(db.nextSequence).toBe(2);

const document = buildCdeDocument(wompiSample, emisorConfig, {
  sequence: 31,
  codigoGeneracion: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
});
expect((document.identificacion as Record<string, unknown>).codigoGeneracion)
  .toBe("AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA");
```

- [ ] **Step 6: Run the focused tests and watch them fail**

Run: `rtk npm test -- test/worker/wompiIssuanceSchema.test.ts test/worker/dteBuilder.test.ts test/worker/workerFetch.test.ts`

Expected: FAIL because the repository reservation and builder injection are absent.

- [ ] **Step 7: Implement the reservation contract**

Add this repository signature:

```ts
async reserveWompiDocumentIdentifiers(
  wompiEventId: string,
  environment: Ambiente,
  controlPrefix: string
): Promise<WompiDocumentIdentifiers>
```

Normalize the prefix to uppercase alphanumerics, reject anything other than eight characters, verify the event environment, return an existing complete reservation unchanged, reject a partial reservation, otherwise issue one guarded update with `generationCode()` and re-read the trigger-populated event. Validate the returned `reserved_numero_control` with `numeroControl(prefix, sequence)` before returning it.

Change only the Wompi builder option:

```ts
interface CdeBuildOptions {
  sequence: number;
  codigoGeneracion?: string;
  environment?: Ambiente;
  issuedAt?: Date;
  donorOverride?: IntentDonorOverride;
}
```

and assign `codigoGeneracion: options.codigoGeneracion ?? generationCode()`.

- [ ] **Step 8: Make the focused tests green**

Run: `rtk npm test -- test/worker/wompiIssuanceSchema.test.ts test/worker/dteBuilder.test.ts test/worker/workerFetch.test.ts`

Expected: all selected tests pass.

- [ ] **Step 9: Commit atomic reservation support**

```bash
rtk git add migrations/0019_wompi_issuance_lifecycle.sql src/worker/types.ts src/worker/storage/repository.ts src/worker/domain/dteBuilder.ts test/worker/wompiIssuanceSchema.test.ts test/worker/dteBuilder.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "feat: reserve Wompi CDE identifiers once"
```

### Task 3: Persist pre-CDE failures and resume the same document

**Files:**
- Create: `src/worker/services/issuanceFailure.ts`
- Create: `test/worker/issuanceFailure.test.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `src/worker/services/pipeline.ts`
- Modify: `src/worker/index.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Produces: `issuanceFailureEvidence(error): { code: string; message: string }`.
- Produces repository methods `markWompiIssuanceProcessing`, `recordWompiIssuanceFailure`, `markWompiIssuanceDeadLettered`, `markWompiIssuanceIgnored`, and `markWompiDocumentCreated`.
- Consumes: `reserveWompiDocumentIdentifiers` from Task 2.

- [ ] **Step 1: Write failing bounded-error tests**

```ts
expect(issuanceFailureEvidence(Object.assign(new Error("  schema\n failed  "), { code: "CDE_SCHEMA" })))
  .toEqual({ code: "CDE_SCHEMA", message: "schema failed" });
expect(issuanceFailureEvidence(new Error("x".repeat(1200))).message).toHaveLength(1000);
expect(issuanceFailureEvidence({ token: "secret" })).toEqual({
  code: "ISSUANCE_ERROR",
  message: "Fallo de emisión sin detalle"
});
```

- [ ] **Step 2: Run the helper test and watch it fail**

Run: `rtk npm test -- test/worker/issuanceFailure.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the minimal pure helper**

Accept an error code only when it matches `^[A-Z0-9_:-]{1,64}$`; otherwise use `ISSUANCE_ERROR`. Read only `Error.message`, normalize whitespace, cap it at 1,000 characters, and use `Fallo de emisión sin detalle` when empty or unavailable.

- [ ] **Step 4: Write failing lifecycle tests**

Cover these observable cases in `workerFetch.test.ts`:

```ts
expect(event).toMatchObject({
  issuance_status: "DEAD_LETTERED",
  issuance_attempt_count: 4,
  issuance_error_code: "ISSUANCE_ERROR",
  issuance_error_message: expect.stringContaining("CAT-020 País")
});
expect(event.control_sequence).toBe(31);
expect(db.nextSequence).toBe(32);
```

Drive these four attempts with an otherwise approved fixture whose `Cliente.CodigoPais`
is `ZZ`; it passes the pre-reservation checks and fails deterministically in the CDE
catalog validation after reservation. Also prove that a redelivered event with an
existing nonterminal document calls the stored-document path, preserves
`numero_control`, `codigo_generacion`, and `plain_json`, and does not advance
`nextSequence`.

- [ ] **Step 5: Run the lifecycle tests and watch them fail**

Run: `rtk npm test -- test/worker/issuanceFailure.test.ts test/worker/workerFetch.test.ts`

Expected: FAIL because queue failures are only logged/retried and dead letters only create an audit.

- [ ] **Step 6: Implement repository lifecycle writes**

`recordWompiIssuanceFailure` must use one D1 batch: a guarded event update increments the attempt count and stores status/error/timestamps only while `created_document_id IS NULL`; an `INSERT ... SELECT` writes `WOMPI_ISSUANCE_FAILED` only when that exact failed timestamp exists. `markWompiIssuanceDeadLettered` preserves the concrete last error while setting the dead-letter status/time.

`markWompiDocumentCreated(wompiEventId, documentId)` sets `created_document_id`, `processed_at`, and `issuance_status = 'DOCUMENT_CREATED'`. Update `createDteDocument` so document insertion and this event link occur in one D1 batch for Wompi-backed documents; direct/advanced documents retain a single insert.

- [ ] **Step 7: Make pipeline processing identifier-stable**

In `processWompiEvent`:

```ts
const existing = await this.repo.getDteDocumentByWompiEvent(wompiEventId);
if (existing) {
  await this.repo.markWompiDocumentCreated(wompiEventId, existing.id);
  return this.processDteDocument(existing.id);
}
```

After permanent prechecks, reserve once and pass both values:

```ts
const identifiers = await this.repo.reserveWompiDocumentIdentifiers(
  wompiEventId,
  environment,
  config.controlPrefix
);
const document = buildCdeDocument(payload, config, {
  sequence: identifiers.sequence,
  codigoGeneracion: identifiers.codigoGeneracion,
  environment,
  donorOverride
});
```

Route newly created Wompi records through `processDteDocument(record.id)` so later deliveries resume persisted JSON/signature. In `processDteDocument`, select `DTE_*` versus `ADVANCED_CDE_*` audit/error names from `record.wompi_event_id`, and on accepted Wompi records call the existing `correlateIntentForDocument` plus `completeIntent` before the deduplicated receipt email.

- [ ] **Step 8: Record queue and dead-letter state**

Before a Wompi queue attempt, mark it processing. In the catch block call `issuanceFailureEvidence` and `recordWompiIssuanceFailure` before `message.retry()`. In `handleDeadLetterBatch`, call `markWompiIssuanceDeadLettered` before the existing audit/alert and ack.

Map invalid donor data and quarantined paid intent bindings to `FAILED` with their specific safe code/message; map non-approved events to `IGNORED`.

- [ ] **Step 9: Make all focused lifecycle tests green**

Run: `rtk npm test -- test/worker/issuanceFailure.test.ts test/worker/wompiIssuanceSchema.test.ts test/worker/dteBuilder.test.ts test/worker/workerFetch.test.ts`

Expected: all selected tests pass, including same-identifier retries and dead-letter persistence.

- [ ] **Step 10: Commit failure persistence and pipeline resumption**

```bash
rtk git add src/worker/services/issuanceFailure.ts src/worker/storage/repository.ts src/worker/services/pipeline.ts src/worker/index.ts test/worker/issuanceFailure.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "feat: persist pre-CDE issuance failures"
```

### Task 4: Add least-privilege failure list and retry APIs

**Files:**
- Modify: `src/worker/types.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `src/worker/index.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Produces: `WompiIssuanceFailureItem` and `Repository.listWompiIssuanceFailures(limit)`.
- Produces: `Repository.claimWompiIssuanceRetry(wompiEventId): Promise<boolean>` and
  `Repository.getWompiIssuanceFailureById(wompiEventId)` with the same allowlisted shape.
- Produces: `GET /api/wompi-events/issuance-failures` and `POST /api/wompi-events/:id/retry`.

- [ ] **Step 1: Write failing API authorization and shape tests**

Test that unauthenticated requests return 401, VIEWER can list, VIEWER retry returns 403 without event lookup, OPERATOR can retry, and the list item is exactly:

```ts
expect(item).toEqual({
  id: "wompi_failed",
  environment: "00",
  amount_cents: 111,
  donor_name: "Example Person",
  donor_email: "donor@example.org",
  received_at: "2026-07-13T22:06:32.756Z",
  issuance_status: "DEAD_LETTERED",
  issuance_attempt_count: 4,
  issuance_error_code: "CDE_SCHEMA",
  issuance_error_message: "La validación del esquema CDE falló",
  issuance_last_attempt_at: "2026-07-13T22:06:49.000Z",
  issuance_failed_at: "2026-07-13T22:06:49.000Z",
  issuance_dead_lettered_at: "2026-07-13T22:06:52.000Z",
  reserved_numero_control: "DTE-15-M001P004-000000000000031"
});
expect(JSON.stringify(item)).not.toContain("raw_body");
expect(JSON.stringify(item)).not.toContain("headers_json");
```

- [ ] **Step 2: Run the API tests and watch them fail**

Run: `rtk npm test -- test/worker/workerFetch.test.ts`

Expected: FAIL with missing routes and repository methods.

- [ ] **Step 3: Implement the allowlisted list query**

Select only the fields above where `created_document_id IS NULL`, `issuance_error_message IS NOT NULL`, and status is one of `FAILED`, `DEAD_LETTERED`, `RETRY_QUEUED`, or `PROCESSING`; order newest failure first and cap the limit at 100.

- [ ] **Step 4: Implement compare-and-swap retry**

`claimWompiIssuanceRetry` uses:

```sql
UPDATE wompi_events
   SET issuance_status = 'RETRY_QUEUED'
 WHERE id = ?
   AND created_document_id IS NULL
   AND issuance_status IN ('FAILED', 'DEAD_LETTERED')
RETURNING id
```

The POST route requires `OPERATOR`, claims before queueing, sends the same `{ wompiEventId: id }`, writes `WOMPI_ISSUANCE_RETRY_QUEUED`, and returns 202. A lost claim returns the current safe state without queueing again; a created or unknown event returns 409/404 without leaking raw data.

- [ ] **Step 5: Extend stalled recovery**

Ensure `listStalledApprovedWompiEvents` can recover a stale `RETRY_QUEUED` or `PROCESSING` item with no document, using `COALESCE(issuance_last_attempt_at, received_at)` for the cutoff. The stable reservation makes any duplicate queue delivery harmless.

- [ ] **Step 6: Make API tests green**

Run: `rtk npm test -- test/worker/workerFetch.test.ts`

Expected: all worker fetch tests pass with role, shape, CAS, and stalled-retry assertions green.

- [ ] **Step 7: Commit the API**

```bash
rtk git add src/worker/types.ts src/worker/storage/repository.ts src/worker/index.ts test/worker/workerFetch.test.ts
rtk git commit -m "feat: expose pre-CDE failure recovery API"
```

### Task 5: Render honest CDE-not-created records in Fallos

**Files:**
- Create: `src/client/preCdeFailures.ts`
- Create: `test/client/preCdeFailures.test.ts`
- Modify: `src/client/types.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`
- Modify: `test/client/viewText.test.ts`
- Modify: `test/client/visualConsistency.test.ts`

**Interfaces:**
- Produces: client `WompiIssuanceFailureItem` and `filterPreCdeFailures(items, query)`.
- Produces: `PreCdeFailuresPanel` inside `App.tsx` with `items`, `error`, `busy`, `canRetry`, and `onRetry` props.

- [ ] **Step 1: Write failing pure client tests**

```ts
expect(filterPreCdeFailures(items, "jose")).toEqual([items[0]]);
expect(filterPreCdeFailures(items, "000031")).toEqual([items[0]]);
expect(filterPreCdeFailures(items, "schema")).toEqual([items[0]]);
expect(filterPreCdeFailures(items, "")).toEqual(items);
```

Also update the Fallos subtitle expectation to `CDE con errores, rechazos o pagos sin comprobante que requieren su atención.`

- [ ] **Step 2: Run client tests and watch them fail**

Run: `rtk npm test -- test/client/preCdeFailures.test.ts test/client/viewText.test.ts test/client/visualConsistency.test.ts`

Expected: FAIL because the helper, type, copy, and panel do not exist.

- [ ] **Step 3: Add the allowlisted client type and filter**

Mirror only the API fields from Task 4. `filterPreCdeFailures` lowercases and trims the query, then searches donor name/email, reserved number, error code/message, and amount rendered with two decimals.

- [ ] **Step 4: Load failures independently**

Add state for items and a separate inline load error. When `view === "failures"`, fetch `/api/wompi-events/issuance-failures` in addition to the existing DTE page; catch this request separately so a failure never hides the DTE list. Clear the pre-CDE state outside Fallos and on logout.

Add an operator action:

```ts
async function retryPreCdeFailure(id: string) {
  await runAction(`pre-cde-retry:${id}`, async () => {
    await api(`/api/wompi-events/${id}/retry`, token, { method: "POST", body: {} });
    setToast("Reintento de creación en cola");
    await refresh();
  });
}
```

- [ ] **Step 5: Render a separate pre-CDE section**

Place the panel above the legal DTE stats/table only in Fallos. Each card must render:

```tsx
<span className="status pre-cde">CDE NO CREADO</span>
<strong>{item.donor_name ?? "Donante sin nombre"}</strong>
<span>${(item.amount_cents / 100).toFixed(2)}</span>
<span>Intentos: {item.issuance_attempt_count}</span>
<p>{item.issuance_error_message}</p>
<span>{item.reserved_numero_control
  ? `Número reservado: ${item.reserved_numero_control}`
  : "Número aún no asignado"}</span>
```

For `RETRY_QUEUED` or `PROCESSING`, disable the button and label it **Reintento en cola**. Otherwise show **Reintentar creación** only to `OPERATOR` and above. Do not render PDF, JSON, seal, invalidation, or document-detail actions.

Pass the visible pre-CDE count into `Stats` so **Fallos y rechazos** counts both collections. If both collections are empty, keep an honest unified empty state.
When pre-CDE cards exist but the legal DTE table is empty, its footer must say
**Sin CDE emitidos fallidos o rechazados** instead of **Sin fallos pendientes**.

- [ ] **Step 6: Add focused styles and source assertions**

Use existing danger tokens, a two-column responsive card grid, `overflow-wrap: anywhere`, and a distinct dashed boundary to signal that these are not legal DTE rows. Assert source order, exact copy, safe button states, and absence of document actions inside the panel.

- [ ] **Step 7: Make client tests green**

Run: `rtk npm test -- test/client/preCdeFailures.test.ts test/client/viewText.test.ts test/client/visualConsistency.test.ts`

Expected: all selected client tests pass.

- [ ] **Step 8: Commit the Fallos UI**

```bash
rtk git add src/client/preCdeFailures.ts src/client/types.ts src/client/App.tsx src/client/styles.css test/client/preCdeFailures.test.ts test/client/viewText.test.ts test/client/visualConsistency.test.ts
rtk git commit -m "feat: show CDE creation failures in Fallos"
```

### Task 6: Complete audit, retention, and operator documentation

**Files:**
- Modify: `src/client/displayText.ts`
- Modify: `test/client/displayText.test.ts`
- Modify: `test/worker/retention.test.ts`
- Modify: `docs/runbook-operador.md`
- Modify: `docs/retention-restore.md`

**Interfaces:**
- Consumes: lifecycle audit actions and new `wompi_events` columns.
- Produces: Spanish audit labels and operator/recovery guidance.

- [ ] **Step 1: Write failing audit-label and retention tests**

```ts
expect(auditActionLabel("WOMPI_ISSUANCE_FAILED")).toBe("CDE no creado");
expect(auditActionLabel("WOMPI_ISSUANCE_RETRY_QUEUED")).toBe("Reintento de creación en cola");
```

Seed a Wompi retention row with `issuance_status`, reserved identifiers, attempt count, and safe error evidence; assert the exported `wompi_events.ndjson` retains those fields while the manifest row count and digest remain valid.

- [ ] **Step 2: Run the documentation-adjacent tests and watch them fail**

Run: `rtk npm test -- test/client/displayText.test.ts test/worker/retention.test.ts`

Expected: FAIL on missing labels or missing fake-row evidence.

- [ ] **Step 3: Add labels and document operations**

Update runbook section 6 to distinguish **CDE NO CREADO** from `FAILED`/`REJECTED`, explain the reserved-number wording, direct the operator to **Reintentar creación**, and say that repeated deterministic validation errors require support rather than repeated clicking.

Update the alert table entry for `Mensaje de emisión agotó reintentos` to direct the operator to the new Fallos card and its exact stored error. Update retention restore notes to state that the lifecycle fields travel inside existing `wompi_events.ndjson`; old rows may omit them and remain valid as nullable legacy data.

- [ ] **Step 4: Make the tests green**

Run: `rtk npm test -- test/client/displayText.test.ts test/worker/retention.test.ts`

Expected: all selected tests pass.

- [ ] **Step 5: Commit audit and documentation coverage**

```bash
rtk git add src/client/displayText.ts test/client/displayText.test.ts test/worker/retention.test.ts docs/runbook-operador.md docs/retention-restore.md
rtk git commit -m "docs: explain pre-CDE failure recovery"
```

### Task 7: Run the complete verification gate and prepare recovery evidence

**Files:**
- Create: `docs/staging-pre-cde-recovery.md`
- Modify other files only if a verification failure exposes a defect covered by a new failing regression test.

**Interfaces:**
- Consumes every task above.
- Produces local proof only; no remote mutation or deployment.

- [ ] **Step 1: Run all focused feature tests together**

Run:

```bash
rtk npm test -- test/worker/dteBuilder.test.ts test/worker/wompiIssuanceSchema.test.ts test/worker/issuanceFailure.test.ts test/worker/workerFetch.test.ts test/worker/retention.test.ts test/client/preCdeFailures.test.ts test/client/viewText.test.ts test/client/visualConsistency.test.ts test/client/displayText.test.ts
```

Expected: 0 failed tests.

- [ ] **Step 2: Run static and packaging gates**

```bash
rtk npm run typecheck
rtk npm run build
rtk npm run security:check-private-boundary
rtk git diff --check
```

Expected: every command exits 0 with no TypeScript, build, private-boundary, or whitespace errors.

- [ ] **Step 3: Run the full test suite**

Run: `rtk npm test`

Expected: all test files and tests pass with 0 failures.

- [ ] **Step 4: Review the complete diff against the approved spec**

Run:

```bash
rtk git status --short --branch
rtk git diff --stat caa3d19..HEAD
rtk git diff --check caa3d19..HEAD
```

Confirm each spec section maps to code/tests and that none of the unrelated ` 2` files or `tmp/` artifacts entered a commit.

- [ ] **Step 5: Remove PDF-render intermediates**

Run: `rtk rm -rf tmp/pdfs/authoritative`

Expected: only task-specific temporary renders are removed; pre-existing unrelated `tmp/` content remains untouched.

- [ ] **Step 6: Prepare, but do not execute, the staging recovery check**

Create `docs/staging-pre-cde-recovery.md` with the exact read-only Wrangler D1 queries
for the failed Wompi event, `dte_documents`, `wompi_events` reservations, and
`document_sequences`. State that a future recovery must pause staging issuance, abort if
31-34 or the counter differ from the recorded invariants, perform the reservation and
counter change atomically, verify an MH test seal, and requires separate deployment and
database-mutation authorization.
