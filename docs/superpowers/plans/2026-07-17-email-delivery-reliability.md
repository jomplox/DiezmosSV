# Email Delivery Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:executing-plans` to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover the three evidence-proven staging receipt failures and make
receipt delivery visibility, retry safety, smoke provenance, and operational
alerting durable without changing fiscal CDE behavior.

**Architecture:** Extend the existing document-scoped `email_deliveries` claim
instead of introducing a second receipt outbox. Record the provider-dispatch
boundary and a conservative typed outcome, use a client-generated request ID for
each deliberate resend, derive Fallos attention from the latest delivery row, mark
smoke runs with immutable audits, and execute email/webhook alert channels
independently per incident.

**Tech Stack:** TypeScript 7, React 19, Cloudflare Workers Email binding, D1/SQLite,
Vitest 4, Wrangler 4, Vite 8.

## Global Constraints

- Deploy and migrate staging only; never touch Cloudflare production.
- Never mutate or delete fiscal document content, seals, identifiers, or sequences.
- Send email only to the three preflight-confirmed recipients and configured
  synthetic smoke recipients.
- Treat `X-Idempotency-Key` as correlation only.
- Never auto-retry an ambiguous or post-dispatch delivery outcome.
- Never print donor PII in command output or execution transcripts; use document
  IDs, redacted identifier suffixes, and boolean precondition checks.
- Use no new dependency.
- Write and observe each focused test failing before changing production code.
- Preserve unrelated user work and keep edits limited to this design.

---

### Task 1: Preflight and Recover the Three Authorized Staging Receipts

**Files:**
- Read: `wrangler.toml`
- Read: `src/worker/index.ts`
- Read: `src/worker/storage/repository.ts`
- No source changes

**Interfaces:**
- Consumes: staging D1 `dte_documents`, `email_deliveries`, and `audit_logs`
- Produces: exactly three new successful manual-resend delivery records

- [ ] **Step 1: Confirm the local and deployed baselines**

Run:

```bash
rtk git status --short --branch
rtk git rev-parse HEAD
rtk npx wrangler deployments list --env staging
```

Expected: clean `main`; any commits ahead of `origin/main` are documentation-only;
the active staging deployment reports code from the pre-remediation baseline
`43d074daa682d4b79d111380137b21d81cdf2070`.

- [ ] **Step 2: Query only unresolved legacy-header failures**

Run:

```bash
rtk npx wrangler d1 execute diezmossv-staging-example --env staging --remote --command "
WITH latest AS (
  SELECT e.*,
         ROW_NUMBER() OVER (
           PARTITION BY e.document_id
           ORDER BY COALESCE(e.claim_attempted_at, e.created_at) DESC,
                    e.created_at DESC, e.id DESC
         ) AS row_num
    FROM email_deliveries e
   WHERE e.email_type IN ('dteReceipt', 'dteReceiptTransitorio')
)
SELECT d.id,
       '...' || substr(d.codigo_generacion, -6) AS codigo_suffix,
       '...' || substr(d.numero_control, -6) AS control_suffix,
       l.id AS delivery_id,
       l.status,
       COALESCE(l.provider_response_json LIKE
         '%custom header ''Idempotency-Key'' is not allowed%',
       0) AS has_expected_rejection,
       COALESCE(lower(l.provider_response_json) LIKE '%timeout%'
         OR lower(l.provider_response_json) LIKE '%abort%'
         OR lower(l.provider_response_json) LIKE '%internal error%'
         OR lower(l.provider_response_json) LIKE '%unknown outcome%',
       0) AS has_ambiguous_outcome,
       EXISTS (
         SELECT 1
           FROM audit_logs a
          WHERE a.entity_type = 'dte_document'
            AND a.entity_id = d.id
            AND a.action = 'STAGING_SMOKE_RUN'
       ) AS is_smoke,
       EXISTS (
         SELECT 1
           FROM email_deliveries sent
          WHERE sent.document_id = d.id
            AND sent.status = 'SENT'
            AND sent.created_at > l.created_at
       ) AS later_sent
  FROM latest l
  JOIN dte_documents d ON d.id = l.document_id
 WHERE l.row_num = 1
   AND l.status = 'FAILED'
   AND l.provider_response_json LIKE '%custom header ''Idempotency-Key'' is not allowed%'
 ORDER BY d.created_at DESC;
"
```

Expected: the three non-smoke operator/customer records and five smoke records are
separable; each authorized row has `later_sent = 0`.

- [ ] **Step 3: Stop unless every recovery precondition holds**

For each proposed non-smoke row, verify all of:

```text
status = FAILED
is_smoke = 0
later_sent = 0
has_expected_rejection = 1
has_ambiguous_outcome = 0
```

Expected: exactly three rows qualify. Any different count or evidence stops the
recovery task without sending.

- [ ] **Step 4: Resend once per qualifying document**

Use the authenticated staging admin detail pane. Open each qualifying CDE by its
document ID, confirm its displayed recipient against the separately authorized
recovery list without copying the recipient into command output or notes, and click
`Reenviar correo` exactly once. Do not click fiscal `Reintentar`.

Expected: one success toast per document and no repeated click.

- [ ] **Step 5: Prove each recovery and absence of duplicates**

Run the PII-safe query from Step 2 again, plus:

```bash
rtk npx wrangler d1 execute diezmossv-staging-example --env staging --remote --command "
SELECT document_id,
       SUM(CASE WHEN status = 'SENT' THEN 1 ELSE 0 END) AS sent_rows,
       COUNT(DISTINCT provider_delivery_id) AS provider_ids,
       MAX(sent_at) AS last_sent_at
  FROM email_deliveries
 WHERE document_id IN (
   SELECT entity_id
     FROM audit_logs
    WHERE action = 'EMAIL_RESENT'
      AND created_at >= datetime('now', '-1 hour')
 )
 GROUP BY document_id
 ORDER BY document_id;
"
```

Expected: each authorized document has one newly recorded resend success and no
duplicate provider delivery ID. Record only redacted document suffixes in status
notes.

---

### Task 2: Add Delivery Outcome and Dispatch-Boundary Evidence

**Files:**
- Create: `migrations/0025_email_delivery_recovery.sql`
- Modify: `src/worker/storage/repository.ts`
- Test: `test/worker/wompiIssuanceSchema.test.ts`
- Test: `test/worker/repositoryFiscalSql.test.ts`

**Interfaces:**
- Produces:
  - `EmailDeliveryOutcomeClass = "NOT_SENT" | "NOT_DELIVERED" | "UNKNOWN"`
  - `Repository.markEmailDeliveryDispatchStarted(id, claimToken): Promise<boolean>`
  - extended `finalizeEmailDeliveryClaim(...)`
  - safe-only reclaim behavior in `claimEmailDelivery(...)`

- [ ] **Step 1: Write the failing migration/schema test**

Add assertions to `test/worker/wompiIssuanceSchema.test.ts`:

```ts
const columns = database
  .prepare("PRAGMA table_info(email_deliveries)")
  .all()
  .map((row) => String((row as { name: unknown }).name));

expect(columns).toEqual(expect.arrayContaining([
  "provider_dispatch_started_at",
  "outcome_class",
  "failure_code",
  "retry_safe",
  "resend_request_id",
  "attempt_no"
]));

const indexes = database
  .prepare("PRAGMA index_list(email_deliveries)")
  .all()
  .map((row) => String((row as { name: unknown }).name));

expect(indexes).toEqual(expect.arrayContaining([
  "idx_email_deliveries_resend_request_id",
  "idx_email_deliveries_latest_receipt"
]));
```

- [ ] **Step 2: Run the schema test and observe RED**

Run:

```bash
rtk npx vitest run test/worker/wompiIssuanceSchema.test.ts
```

Expected: FAIL because the six columns and two indexes do not exist.

- [ ] **Step 3: Add migration 0025**

Create `migrations/0025_email_delivery_recovery.sql`:

```sql
ALTER TABLE email_deliveries ADD COLUMN provider_dispatch_started_at TEXT;
ALTER TABLE email_deliveries ADD COLUMN outcome_class TEXT
  CHECK (outcome_class IS NULL OR outcome_class IN ('NOT_SENT', 'NOT_DELIVERED', 'UNKNOWN'));
ALTER TABLE email_deliveries ADD COLUMN failure_code TEXT;
ALTER TABLE email_deliveries ADD COLUMN retry_safe INTEGER NOT NULL DEFAULT 0
  CHECK (retry_safe IN (0, 1));
ALTER TABLE email_deliveries ADD COLUMN resend_request_id TEXT;
ALTER TABLE email_deliveries ADD COLUMN attempt_no INTEGER NOT NULL DEFAULT 1
  CHECK (attempt_no >= 1);

CREATE UNIQUE INDEX idx_email_deliveries_resend_request_id
  ON email_deliveries(resend_request_id)
  WHERE resend_request_id IS NOT NULL;

CREATE INDEX idx_email_deliveries_latest_receipt
  ON email_deliveries(document_id, email_type, attempt_no DESC, created_at DESC, id DESC);
```

- [ ] **Step 4: Run the schema test and observe GREEN**

Run:

```bash
rtk npx vitest run test/worker/wompiIssuanceSchema.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing repository behavior tests**

Add real-SQLite cases proving:

```ts
expect(await repo.markEmailDeliveryDispatchStarted(claim.id, claim.claimToken)).toBe(true);
expect(await repo.markEmailDeliveryDispatchStarted(claim.id, "wrong-token")).toBe(false);

await repo.finalizeEmailDeliveryClaim(claim.id, claim.claimToken, {
  status: "FAILED",
  providerResponse: { code: "E_HEADER_NOT_ALLOWED" },
  emailType: input.emailType,
  documentStatusAtSend: input.documentStatusAtSend,
  outcomeClass: "NOT_SENT",
  failureCode: "E_HEADER_NOT_ALLOWED",
  retrySafe: true
});
expect(await repo.claimEmailDelivery(input)).toMatchObject({ id: claim.id });
```

Add separate rows proving:

```ts
// UNKNOWN FAILED is never reclaimed.
expect(await repo.claimEmailDelivery(inputForUnknown)).toBeNull();

// A stale PENDING row is reclaimed only before provider dispatch.
expect(await repo.claimEmailDelivery(inputForStalePreDispatch)).not.toBeNull();
expect(await repo.claimEmailDelivery(inputForStalePostDispatch)).toBeNull();
```

- [ ] **Step 6: Run repository tests and observe RED**

Run:

```bash
rtk npx vitest run test/worker/repositoryFiscalSql.test.ts test/worker/wompiIssuanceSchema.test.ts
```

Expected: FAIL because repository inputs and SQL do not support the new evidence.

- [ ] **Step 7: Implement the minimal repository changes**

In `src/worker/storage/repository.ts`, export:

```ts
export type EmailDeliveryOutcomeClass = "NOT_SENT" | "NOT_DELIVERED" | "UNKNOWN";
```

Add:

```ts
async markEmailDeliveryDispatchStarted(id: string, claimToken: string): Promise<boolean> {
  const row = await this.db
    .prepare(
      `UPDATE email_deliveries
          SET provider_dispatch_started_at = ?
        WHERE id = ? AND status = 'PENDING' AND claim_token = ?
          AND provider_dispatch_started_at IS NULL
        RETURNING id`
    )
    .bind(nowIso(), id, claimToken)
    .first<{ id: string }>();
  return Boolean(row);
}
```

Extend `finalizeEmailDeliveryClaim` with:

```ts
outcomeClass?: EmailDeliveryOutcomeClass | null;
failureCode?: string | null;
retrySafe?: boolean;
```

and persist:

```sql
outcome_class = ?, failure_code = ?, retry_safe = ?
```

Change claim reclaim predicates to:

```sql
WHERE (
  email_deliveries.status = 'FAILED'
  AND email_deliveries.retry_safe = 1
)
OR (
  email_deliveries.status = 'PENDING'
  AND email_deliveries.provider_dispatch_started_at IS NULL
  AND email_deliveries.claim_attempted_at IS NOT NULL
  AND email_deliveries.claim_attempted_at < ?
)
```

- [ ] **Step 8: Run the focused repository tests and observe GREEN**

Run:

```bash
rtk npx vitest run test/worker/repositoryFiscalSql.test.ts test/worker/wompiIssuanceSchema.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit the migration and repository checkpoint**

Run:

```bash
rtk git add migrations/0025_email_delivery_recovery.sql src/worker/storage/repository.ts test/worker/repositoryFiscalSql.test.ts test/worker/wompiIssuanceSchema.test.ts
rtk git commit -m "fix: record safe receipt delivery outcomes"
```

Expected: one focused commit.

---

### Task 3: Classify Provider Errors and Fence Initial Receipt Dispatch

**Files:**
- Modify: `src/worker/services/email.ts`
- Modify: `src/worker/services/pipeline.ts`
- Test: `test/worker/emailTemplates.test.ts`
- Test: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Produces:
  - `EmailDispatchError`
  - `classifyEmailDispatchError(error, providerDispatchStarted)`
  - structured failure evidence consumed by the pipeline

- [ ] **Step 1: Write failing Cloudflare classification tests**

Add tests that construct errors with a `code` property and assert:

```ts
expect(classifyEmailDispatchError(
  Object.assign(new Error("header rejected"), { code: "E_HEADER_NOT_ALLOWED" }),
  true
)).toMatchObject({
  code: "E_HEADER_NOT_ALLOWED",
  outcomeClass: "NOT_SENT",
  retrySafe: true
});

expect(classifyEmailDispatchError(
  Object.assign(new Error("delivery failed"), { code: "E_DELIVERY_FAILED" }),
  true
)).toMatchObject({
  outcomeClass: "NOT_DELIVERED",
  retrySafe: false
});

expect(classifyEmailDispatchError(
  Object.assign(new Error("internal"), { code: "E_INTERNAL_SERVER_ERROR" }),
  true
)).toMatchObject({
  outcomeClass: "UNKNOWN",
  retrySafe: false
});

expect(classifyEmailDispatchError(new Error("render failed"), false)).toMatchObject({
  outcomeClass: "NOT_SENT",
  retrySafe: true
});
```

- [ ] **Step 2: Run and observe RED**

Run:

```bash
rtk npx vitest run test/worker/emailTemplates.test.ts
```

Expected: FAIL because the classifier is not exported.

- [ ] **Step 3: Implement typed classification**

In `src/worker/services/email.ts`, add:

```ts
export interface ClassifiedEmailDispatchFailure {
  code: string;
  message: string;
  outcomeClass: "NOT_SENT" | "NOT_DELIVERED" | "UNKNOWN";
  retrySafe: boolean;
  providerResponse: Record<string, unknown>;
}

const CLOUDFLARE_NOT_SENT_CODES = new Set([
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_SENDER_NOT_VERIFIED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_RECIPIENT_SUPPRESSED",
  "E_SENDER_DOMAIN_NOT_AVAILABLE",
  "E_CONTENT_TOO_LARGE",
  "E_RATE_LIMIT_EXCEEDED",
  "E_DAILY_LIMIT_EXCEEDED",
  "E_HEADER_NOT_ALLOWED",
  "E_HEADER_USE_API_FIELD",
  "E_HEADER_VALUE_INVALID",
  "E_HEADER_VALUE_TOO_LONG",
  "E_HEADER_NAME_INVALID",
  "E_HEADERS_TOO_LARGE",
  "E_HEADERS_TOO_MANY"
]);
```

Implement `classifyEmailDispatchError` so a pre-dispatch error is `NOT_SENT`, the
allowlist is `NOT_SENT`, `E_DELIVERY_FAILED` is `NOT_DELIVERED`, and every other
post-dispatch error is `UNKNOWN`. Persist only code and message, never the thrown
object or secrets.

- [ ] **Step 4: Run classifier tests and observe GREEN**

Run:

```bash
rtk npx vitest run test/worker/emailTemplates.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing pipeline dispatch tests**

Add cases to `test/worker/workerFetch.test.ts` proving:

```text
1. markEmailDeliveryDispatchStarted occurs before EMAIL.send.
2. E_HEADER_NOT_ALLOWED finalizes FAILED + NOT_SENT + retry_safe=1.
3. E_INTERNAL_SERVER_ERROR finalizes FAILED + UNKNOWN + retry_safe=0.
4. A transitory receipt left PENDING after dispatch cannot be reclaimed.
5. EMAIL_FAILED alert incidentId equals the receipt claim token.
```

- [ ] **Step 6: Run the pipeline cases and observe RED**

Run:

```bash
rtk npx vitest run test/worker/workerFetch.test.ts -t "receipt delivery"
```

Expected: FAIL because the pipeline does not store dispatch/outcome evidence.

- [ ] **Step 7: Integrate dispatch fencing in `pipeline.ts`**

Wrap the provider callback:

```ts
let providerDispatchStarted = false;
const markProviderDispatch = async () => {
  await beforeProviderDispatch?.();
  if (!(await this.repo.markEmailDeliveryDispatchStarted(
    deliveryClaim.id,
    deliveryClaim.claimToken
  ))) {
    throw new Error(`La reserva de correo ${deliveryClaim.id} perdió su propiedad antes del envío`);
  }
  providerDispatchStarted = true;
};
```

Pass `markProviderDispatch` to `sendReceipt`. In the catch block, preserve
`PostAcceptFinalizationOwnershipError`; otherwise classify and finalize:

```ts
const failure = classifyEmailDispatchError(error, providerDispatchStarted);
await this.repo.finalizeEmailDeliveryClaim(deliveryClaim.id, deliveryClaim.claimToken, {
  status: "FAILED",
  providerResponse: failure.providerResponse,
  emailType,
  documentStatusAtSend: record.status,
  outcomeClass: failure.outcomeClass,
  failureCode: failure.code,
  retrySafe: failure.retrySafe
});
```

Use `deliveryClaim.claimToken` as the `EMAIL_FAILED` alert incident ID.

- [ ] **Step 8: Run focused delivery tests and observe GREEN**

Run:

```bash
rtk npx vitest run test/worker/emailTemplates.test.ts test/worker/workerFetch.test.ts -t "receipt|email"
```

Expected: PASS.

- [ ] **Step 9: Commit the provider-classification checkpoint**

Run:

```bash
rtk git add src/worker/services/email.ts src/worker/services/pipeline.ts test/worker/emailTemplates.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "fix: classify receipt provider outcomes"
```

Expected: one focused commit.

---

### Task 4: Make Manual Resend Server-Idempotent

**Files:**
- Modify: `src/worker/storage/repository.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/client/App.tsx`
- Modify: `scripts/staging-smoke.mjs`
- Test: `test/worker/repositoryFiscalSql.test.ts`
- Test: `test/worker/workerFetch.test.ts`
- Test: `test/client/emailDeliveryFailure.test.ts`
- Test: `test/scripts/stagingSmoke.test.ts`

**Interfaces:**
- Consumes: `resendRequestId: string`
- Produces:
  - `Repository.claimManualEmailDelivery(...)`
  - `{ ok: true, duplicateSuppressed: boolean }`

- [ ] **Step 1: Write failing repository manual-claim tests**

Use one UUID across repeated calls and assert:

```ts
const first = await repo.claimManualEmailDelivery(input);
expect(first.kind).toBe("claimed");

const duplicatePending = await repo.claimManualEmailDelivery(input);
expect(duplicatePending).toMatchObject({ kind: "pending", id: first.id });

await repo.finalizeEmailDeliveryClaim(first.id, first.claimToken, sentOutcome);
expect(await repo.claimManualEmailDelivery(input)).toMatchObject({
  kind: "sent",
  id: first.id
});

expect(await repo.claimManualEmailDelivery({
  ...input,
  toEmail: "other@example.org"
})).toMatchObject({ kind: "conflict" });

expect(await repo.claimManualEmailDelivery({
  ...input,
  resendRequestId: crypto.randomUUID()
})).toMatchObject({ kind: "claimed", attemptNo: 2 });
```

- [ ] **Step 2: Run and observe RED**

Run:

```bash
rtk npx vitest run test/worker/repositoryFiscalSql.test.ts -t "manual email"
```

Expected: FAIL because `claimManualEmailDelivery` does not exist.

- [ ] **Step 3: Implement the manual claim**

Add:

```ts
export type ManualEmailDeliveryClaim =
  | { kind: "claimed"; id: string; idempotencyKey: string; claimToken: string; attemptNo: number }
  | { kind: "sent" | "pending" | "manual-review" | "conflict"; id: string; attemptNo: number };
```

`claimManualEmailDelivery` must:

1. derive `dsv-receipt-resend-v1-<sha256(documentId:resendRequestId)>`;
2. insert one `PENDING` row with the next `attempt_no`;
3. return the existing row on `resend_request_id` conflict;
4. reclaim only `FAILED AND retry_safe = 1`;
5. reject a recipient/document mismatch for an existing request ID.

- [ ] **Step 4: Run repository manual-claim tests and observe GREEN**

Run:

```bash
rtk npx vitest run test/worker/repositoryFiscalSql.test.ts -t "manual email"
```

Expected: PASS.

- [ ] **Step 5: Write failing route tests**

Add API cases proving:

```text
missing/invalid resendRequestId -> 400 invalid_resend_request_id
first request -> one provider call and one SENT claim
same request ID after SENT -> 200 duplicateSuppressed=true and no provider call
same request ID while PENDING -> 409 resend_in_progress
same request ID with another recipient -> 409 resend_request_conflict
UNKNOWN prior attempt -> 409 resend_requires_review
new request ID after SENT -> one deliberate new send
```

- [ ] **Step 6: Run route tests and observe RED**

Run:

```bash
rtk npx vitest run test/worker/workerFetch.test.ts -t "manual resend"
```

Expected: FAIL because resend still sends before recording.

- [ ] **Step 7: Route resend through the claim**

Require:

```ts
const body = await readJsonObject(...) as {
  email?: string;
  resendRequestId?: string;
};
```

Validate the request ID as a UUID string. Claim before constructing or sending the
email. Mark provider dispatch using the claim token, pass the claim correlation key
to `sendReceipt`, classify failures with the same helper as the initial path, and
finalize the claim. Return existing `SENT` requests without sending.

- [ ] **Step 8: Add client request-ID retention and smoke UUID**

In `App.tsx`, keep pending IDs:

```ts
const resendRequestIds = useRef(new Map<string, string>());
```

For a resend:

```ts
const resendRequestId =
  resendRequestIds.current.get(target.id) ?? crypto.randomUUID();
resendRequestIds.current.set(target.id, resendRequestId);
const body = { resendRequestId };
```

Delete the map entry only after confirmed success. In
`scripts/staging-smoke.mjs`, send:

```js
body: { resendRequestId: randomUUID() }
```

- [ ] **Step 9: Run route, client, and script tests and observe GREEN**

Run:

```bash
rtk npx vitest run test/worker/repositoryFiscalSql.test.ts test/worker/workerFetch.test.ts test/client/emailDeliveryFailure.test.ts test/scripts/stagingSmoke.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit the manual-resend checkpoint**

Run:

```bash
rtk git add src/worker/storage/repository.ts src/worker/index.ts src/client/App.tsx scripts/staging-smoke.mjs test/worker/repositoryFiscalSql.test.ts test/worker/workerFetch.test.ts test/client/emailDeliveryFailure.test.ts test/scripts/stagingSmoke.test.ts
rtk git commit -m "fix: make manual receipt resend idempotent"
```

Expected: one focused commit.

---

### Task 5: Surface Receipt Failures in Fallos and Move the Recovery Action

**Files:**
- Modify: `src/worker/types.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `src/worker/index.ts`
- Modify: `src/client/types.ts`
- Modify: `src/client/App.tsx`
- Test: `test/worker/workerFetch.test.ts`
- Test: `test/client/emailDeliveryFailure.test.ts`
- Test: `test/client/viewText.test.ts`

**Interfaces:**
- Produces:
  - `attention=failures` documents filter
  - list fields `receipt_email_status`, `receipt_email_outcome_class`,
    `receipt_email_failure_code`
  - detail field `receiptEmailDelivery`

- [ ] **Step 1: Write failing server attention-filter tests**

Seed:

```text
one fiscal FAILED document
one fiscal REJECTED document
one ACCEPTED document whose latest receipt is FAILED
one ACCEPTED document with FAILED then later SENT
one deferred SIGNED document
```

Call:

```ts
new Request("https://example.org/api/documents?attention=failures")
```

Assert only the first three are returned and the accepted email failure includes:

```ts
expect.objectContaining({
  status: "ACCEPTED",
  receipt_email_status: "FAILED"
})
```

- [ ] **Step 2: Run and observe RED**

Run:

```bash
rtk npx vitest run test/worker/workerFetch.test.ts -t "attention failures"
```

Expected: FAIL because the endpoint ignores `attention`.

- [ ] **Step 3: Implement latest-receipt joins and filters**

Extend `listDteDocuments` with `attention?: "failures" | null`. Left join the
latest receipt row by `attempt_no DESC, created_at DESC, id DESC`. Apply:

```sql
(
  dte_documents.status IN ('FAILED', 'REJECTED')
  OR (
    dte_documents.status = 'ACCEPTED'
    AND latest_receipt.status = 'FAILED'
  )
)
```

Select only sanitized derived fields. Add
`getLatestReceiptEmailDelivery(documentId)` for the detail response.

- [ ] **Step 4: Run server tests and observe GREEN**

Run:

```bash
rtk npx vitest run test/worker/workerFetch.test.ts -t "attention failures"
```

Expected: PASS.

- [ ] **Step 5: Write failing client behavior tests**

Assert:

```text
Fallos fetch uses attention=failures, not only status=FAILED,REJECTED
accepted email failure renders Correo fallido
failure metric counts it once
warning copy differs for NOT_SENT, NOT_DELIVERED, UNKNOWN, and legacy null
warning contains Reenviar ahora
normal action row omits duplicate resend while warning exists
fiscal action reads Reintentar DTE
```

- [ ] **Step 6: Run and observe RED**

Run:

```bash
rtk npx vitest run test/client/emailDeliveryFailure.test.ts test/client/viewText.test.ts
```

Expected: FAIL on the new list request, marker, copy, and action labels.

- [ ] **Step 7: Implement the minimal UI**

When `view === "failures"`, set `attention=failures` on the documents request and
do not send the legacy combined status. Render a secondary `Correo fallido` marker
when `receipt_email_status === "FAILED"`. Add accepted email failures to the metric
without double-counting fiscal failures.

Use outcome-specific copy:

```ts
NOT_SENT: "El proveedor rechazó el intento antes de enviar el correo."
NOT_DELIVERED: "El proveedor informó que el correo no pudo entregarse."
UNKNOWN: "No se puede confirmar si el proveedor aceptó el correo."
legacy/null: "El intento de envío falló."
```

Render `Reenviar ahora` inside the warning. Hide the normal resend button while
that warning is active. Rename `Reintentar` to `Reintentar DTE`.

- [ ] **Step 8: Run client and combined focused tests and observe GREEN**

Run:

```bash
rtk npx vitest run test/client/emailDeliveryFailure.test.ts test/client/viewText.test.ts test/worker/workerFetch.test.ts -t "failure|Fallos|attention"
```

Expected: PASS.

- [ ] **Step 9: Commit the Fallos/UI checkpoint**

Run:

```bash
rtk git add src/worker/types.ts src/worker/storage/repository.ts src/worker/index.ts src/client/types.ts src/client/App.tsx test/worker/workerFetch.test.ts test/client/emailDeliveryFailure.test.ts test/client/viewText.test.ts
rtk git commit -m "fix: surface receipt failures in Fallos"
```

Expected: one focused commit.

---

### Task 6: Persist Staging Smoke Provenance

**Files:**
- Modify: `scripts/staging-smoke.mjs`
- Modify: `src/worker/index.ts`
- Modify: `src/worker/services/pipeline.ts`
- Test: `test/scripts/stagingSmoke.test.ts`
- Test: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Consumes: one UUID `smokeRunId`
- Produces: one `STAGING_SMOKE_RUN` audit per smoke-created document

- [ ] **Step 1: Write failing smoke provenance tests**

Assert the script creates one run UUID and sends it through both paths. Add Worker
tests proving:

```text
staging /api/test/dte + valid smokeRunId -> STAGING_SMOKE_RUN path=admin
staging signed Wompi transaction SMOKE-WEBHOOK-<uuid> -> path=webhook
production or local deployment -> no smoke marker
invalid run ID -> no smoke marker
replayed queue/webhook -> one marker only
```

- [ ] **Step 2: Run and observe RED**

Run:

```bash
rtk npx vitest run test/scripts/stagingSmoke.test.ts test/worker/workerFetch.test.ts -t "smoke provenance"
```

Expected: FAIL because no run ID is persisted.

- [ ] **Step 3: Add one run ID to the smoke script**

At startup:

```js
const smokeRunId = randomUUID();
```

Send `smokeRunId` in `/api/test/dte`, and build the webhook transaction identity
as:

```js
`SMOKE-WEBHOOK-${smokeRunId}`
```

Do not log the donor address or private environment values.

- [ ] **Step 4: Record immutable audit markers**

For the admin path, when `env.APP_ENV === "staging"` and `smokeRunId` is a valid
UUID, create:

```ts
await repo.createAuditIfAbsent({
  action: "STAGING_SMOKE_RUN",
  entityType: "dte_document",
  entityId: dte.id,
  summary: "CDE creado por la prueba integral de staging",
  metadata: { runId: smokeRunId, path: "admin", source: "staging-smoke" }
});
```

Parse the admin request locally as
`DirectCdeInput & { smokeRunId?: unknown }`; do not add smoke-only provenance to
the fiscal `DirectCdeInput` domain contract.

For the Wompi path, extract the UUID only from the signed staging transaction
identity and create the same audit with `path: "webhook"` after the document exists.

- [ ] **Step 5: Run smoke provenance tests and observe GREEN**

Run:

```bash
rtk npx vitest run test/scripts/stagingSmoke.test.ts test/worker/workerFetch.test.ts -t "smoke provenance"
```

Expected: PASS.

- [ ] **Step 6: Backfill the eight verified historical smoke artifacts**

First query candidate IDs and prove each has the established smoke name/email or
transaction identity. Then insert deterministic audits:

```sql
INSERT INTO audit_logs (
  id, actor_type, actor_id, action, entity_type, entity_id,
  summary, metadata_json
)
SELECT 'audit_smoke_backfill_' || d.id,
       'SYSTEM',
       NULL,
       'STAGING_SMOKE_RUN',
       'dte_document',
       d.id,
       'Artefacto histórico de prueba integral de staging',
       json_object(
         'runId', 'legacy-2026-07-17-email-incident',
         'path', CASE WHEN d.wompi_event_id IS NULL THEN 'admin' ELSE 'webhook' END,
         'source', 'staging-smoke-backfill'
       )
  FROM dte_documents d
 WHERE d.id IN (
   'dte_5cafb5e8-4413-4e1f-a3ce-5aa73a14b171',
   'dte_3004a6c3-7eb1-499b-ad7a-96801296abf9',
   'dte_9734c9c8-04f5-44a5-b930-0dac78a9bad8',
   'dte_8397ada1-bfc7-403b-8968-35108e39b640',
   'dte_ea51bdca-e323-49bd-a9a1-e6f862d5a1c8',
   'dte_cf14cbd8-86d9-457c-8959-c542d06b3126',
   'dte_e0e3ae30-d2eb-4385-973d-1df87bc91f8d',
   'dte_56217a51-e5cb-4122-8db0-544a5de08276'
 )
   AND NOT EXISTS (
     SELECT 1 FROM audit_logs a
      WHERE a.action = 'STAGING_SMOKE_RUN'
        AND a.entity_type = 'dte_document'
        AND a.entity_id = d.id
   );
```

The eight IDs above are the exact rows returned and reviewed in the read-only
preflight. Re-run the candidate proof immediately before applying this staging-only
backfill. Verify eight markers and zero document mutations.

- [ ] **Step 7: Commit the smoke-provenance checkpoint**

Run:

```bash
rtk git add scripts/staging-smoke.mjs src/worker/index.ts src/worker/services/pipeline.ts test/scripts/stagingSmoke.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "test: persist staging smoke provenance"
```

Expected: one focused commit.

---

### Task 7: Add Incident-Scoped Independent Webhook Alerts

**Files:**
- Modify: `src/worker/types.ts`
- Modify: `src/worker/services/alerts.ts`
- Modify: all `sendOperationalAlert` call sites
- Modify: `wrangler.toml`
- Test: `test/worker/alerts.test.ts`
- Test: affected pipeline/worker service tests

**Interfaces:**
- `OperationalAlert.incidentId: string`
- `ALERT_WEBHOOK_URL?: string`
- `ALERT_WEBHOOK_KIND?: "slack" | "discord"`
- per-channel audit metadata `{ incidentId, channel }`

- [ ] **Step 1: Write failing alert tests**

Add cases proving:

```text
same kind/entity/incident/channel sends once
same kind/entity with a new incident sends again
email failure does not prevent webhook success
webhook failure does not prevent email success
no email recipients still allows a configured webhook
Slack payload uses text
Discord payload uses content
invalid/non-HTTPS webhook is recorded as ALERT_FAILED
audit metadata contains incidentId and channel
```

- [ ] **Step 2: Run and observe RED**

Run:

```bash
rtk npx vitest run test/worker/alerts.test.ts
```

Expected: FAIL because deduplication is entity-global and webhook support is absent.

- [ ] **Step 3: Add incident-aware repository lookup**

Add:

```ts
async hasOperationalAlertChannelResult(input: {
  action: string;
  entityType: string;
  entityId: string;
  incidentId: string;
  channel: "email" | "webhook";
}): Promise<boolean>
```

Use:

```sql
SELECT 1
  FROM audit_logs
 WHERE action = ?
   AND entity_type = ?
   AND entity_id = ?
   AND json_extract(metadata_json, '$.incidentId') = ?
   AND json_extract(metadata_json, '$.channel') = ?
 LIMIT 1
```

- [ ] **Step 4: Implement independent alert channels**

Make `incidentId` required. Execute email and webhook in separate guarded
functions. Each function:

1. checks only its own successful audit;
2. attempts its channel;
3. records `ALERT_SENT:<kind>` or `ALERT_FAILED:<kind>` with channel metadata;
4. never throws into the triggering business flow.

Webhook validation:

```ts
const url = new URL(env.ALERT_WEBHOOK_URL ?? "");
if (url.protocol !== "https:" || url.username || url.password) {
  throw new Error("ALERT_WEBHOOK_URL debe ser HTTPS y no incluir credenciales de URL");
}
```

Send `{ text }` for Slack or `{ content }` for Discord and reject a non-2xx
response. Include only sanitized alert fields and `APP_ORIGIN`.

- [ ] **Step 5: Give every call site a stable incident ID**

Use:

```text
EMAIL_FAILED -> delivery claim token
WOMPI_EVENT_STALLED -> issuance epoch or event ID
DTE/ADVANCED_CDE_FAILED -> document failure epoch
MH_UNAVAILABLE -> oldest deferred document ID + transmission_deferred_at
ISSUANCE_DEAD_LETTERED -> issuance attempt ID or queue message ID
CERT_EXPIRING -> existing expiresAt:threshold entity ID
RETENTION_EXPORT_FAILED -> month + export attempt timestamp
RETENTION_VERIFY_FAILED -> verification audit/attempt identity
```

- [ ] **Step 6: Configure only the non-secret kind**

Add no webhook URL to `wrangler.toml`. Add only a staging variable after the chosen
kind is known:

```toml
ALERT_WEBHOOK_KIND = "slack"
```

Set `ALERT_WEBHOOK_URL` with Wrangler secret input; never print or commit it.

- [ ] **Step 7: Run alert and caller tests and observe GREEN**

Run:

```bash
rtk npx vitest run test/worker/alerts.test.ts test/worker/workerFetch.test.ts test/worker/retention.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the alert checkpoint**

Run:

```bash
rtk git add src/worker/types.ts src/worker/services/alerts.ts src/worker/services/pipeline.ts src/worker/services/backups.ts src/worker/services/retention.ts src/worker/index.ts wrangler.toml test/worker
rtk git commit -m "fix: alert independently per incident"
```

Expected: one focused commit containing only alert-related changes.

---

### Task 8: Complete Local Verification and Review

**Files:**
- Modify only files required by failures caused by Tasks 2-7

**Interfaces:**
- Produces: a clean, locally proven candidate SHA

- [ ] **Step 1: Run focused reliability tests**

Run:

```bash
rtk npx vitest run test/worker/emailTemplates.test.ts test/worker/alerts.test.ts test/worker/repositoryFiscalSql.test.ts test/worker/wompiIssuanceSchema.test.ts test/worker/workerFetch.test.ts test/client/emailDeliveryFailure.test.ts test/client/viewText.test.ts test/scripts/stagingSmoke.test.ts
```

Expected: all pass with no warnings.

- [ ] **Step 2: Run every repository gate**

Run:

```bash
rtk npm run test
rtk npm run typecheck
rtk npm run types:check
rtk npm run build
rtk npm run security:check-private-boundary
rtk git diff --check
```

Expected: every command exits zero.

- [ ] **Step 3: Run migration preflight without applying production**

Run:

```bash
rtk node scripts/d1-migration-preflight.mjs --database diezmossv-staging-example --env staging
```

Expected: migration 0025 is valid and pending only where expected. Do not run any
production command.

- [ ] **Step 4: Review the complete diff against the design**

Run:

```bash
rtk git status --short
rtk git diff --stat 43d074daa682d4b79d111380137b21d81cdf2070..HEAD
rtk git diff 43d074daa682d4b79d111380137b21d81cdf2070..HEAD -- src migrations scripts test wrangler.toml docs
```

Check:

```text
no production config or production command changed
no fiscal CDE content/sequence mutation added
no secret or recipient address committed
unknown outcomes cannot auto-reclaim
manual resend claims before provider dispatch
Fallos latest-success supersedes old failure
webhook and email channels cannot suppress each other
```

- [ ] **Step 5: Commit any test-only correction**

If a gate exposed a defect, first add/retain its failing regression test, make the
minimal fix, rerun the focused and full gates, then commit only that correction.

Expected: clean worktree after all intended changes are committed.

---

### Task 9: Publish Exact SHA and Prove Cloudflare Staging

**Files:**
- No new source changes unless a staging-only regression is first reproduced by a
  test

**Interfaces:**
- Produces: green GitHub exact SHA and matching Cloudflare staging deployment

- [ ] **Step 1: Push `main`**

Run:

```bash
rtk git push origin main
```

Expected: `origin/main` advances to the locally verified SHA.

- [ ] **Step 2: Wait for exact-SHA GitHub CI**

Run:

```bash
rtk gh run list --branch main --commit "$(rtk git rev-parse HEAD)" --limit 20
rtk gh run watch "$(rtk gh run list --branch main --commit "$(rtk git rev-parse HEAD)" --json databaseId --jq '.[0].databaseId')" --exit-status
```

Expected: every required workflow for the exact SHA concludes `success`.

- [ ] **Step 3: Apply staging migration only**

Run:

```bash
rtk npm run cf:migrate:staging
```

Expected: migration 0025 applies to `diezmossv-staging-example`; production remains
untouched.

- [ ] **Step 4: Deploy the exact green SHA to staging**

Run:

```bash
rtk npm run cf:deploy:staging
```

Expected: deployment succeeds and reports the staging Worker URL.

- [ ] **Step 5: Prove deployment identity and health**

Run:

```bash
rtk npx wrangler deployments list --env staging
rtk curl -fsS https://worker.example.invalid/api/health
```

Expected: active staging deployment metadata contains the exact Git SHA and health
returns `ok: true`.

- [ ] **Step 6: Run live authenticated staging checks**

Verify:

```text
Fallos includes an accepted document only when its latest receipt attempt failed
the row shows Correo fallido
the warning contains Reenviar ahora
the neighboring fiscal button reads Reintentar DTE
repeating one resendRequestId performs no second provider call
a new deliberate resendRequestId can create a later attempt
a new smoke run creates STAGING_SMOKE_RUN audits for admin and webhook paths
an alert test records independent email/webhook channel evidence
```

Use only synthetic recipients for new test messages.

- [ ] **Step 7: Reconcile final state**

Run:

```bash
rtk git fetch --prune origin
rtk git status --short --branch
rtk git rev-parse HEAD
rtk git rev-parse origin/main
rtk git branch --format="%(refname:short)"
rtk git ls-remote --heads origin
rtk npx wrangler deployments list --env staging
```

Expected:

```text
worktree clean
local main = origin/main
only intended main branch remains
active staging deployment = exact green SHA
no production deployment or migration occurred
```

- [ ] **Step 8: Record the proof and complete the durable goal**

Report:

```text
recovery count and duplicate check
focused/full command results
commit SHA
GitHub workflow URLs/conclusions
staging migration result
staging deployment/version ID
live UI/API verification
remaining intentionally deferred generalization
```

Mark the goal complete only after every proof item is present.
