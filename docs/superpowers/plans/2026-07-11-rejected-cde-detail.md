# Rejected CDE Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display a readable MH rejection reason and the authoritative rejection-event timestamp at the bottom of every rejected CDE detail panel.

**Architecture:** A pure client helper converts the current document's stored MH observations plus its already-returned audit rows into a small `RejectionDetail` view model. `App.tsx` retains the selected document's audit array from the existing detail request and `DetailPanel` renders an informational, danger-tinted block above the collapsed JSON preview. No Worker route, repository, schema, or MH pipeline changes.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Cloudflare Workers/D1, existing El Salvador date formatter.

## Global Constraints

- Render the block only when `document.status === "REJECTED"`.
- Use `mh_observaciones_json` and `mh_estado` for the current rejection reason.
- Use the newest relevant immutable audit event for time; never substitute `updated_at`.
- Format valid timestamps as `DD/MM/YYYY, HH:mm hora El Salvador`.
- Parse malformed or nested MH JSON defensively and never render raw JSON in the block.
- Place the block immediately above **Ver JSON completo**.
- Add no dependency, migration, API route, or new control.
- Leave production and staging unchanged unless a later user request explicitly authorizes deployment.

---

### Task 1: Pure rejection-detail projection

**Files:**
- Create: `src/client/rejectionDetail.ts`
- Create: `test/client/rejectionDetail.test.ts`

**Interfaces:**
- Consumes: `DteDocument.status`, `DteDocument.mh_observaciones_json`, `DteDocument.mh_estado`, and ordered audit rows containing `action` and `created_at`.
- Produces: `rejectionDetailForDocument(document, audit): RejectionDetail | null`, where `RejectionDetail` is `{ reasons: string[]; rejectedAt: string | null }`.

- [ ] **Step 1: Write the failing helper tests**

Create `test/client/rejectionDetail.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rejectionDetailForDocument } from "../../src/client/rejectionDetail";

const rejected = (overrides: Partial<{ status: string; mh_observaciones_json: string; mh_estado: string | null }> = {}) => ({
  status: "REJECTED",
  mh_observaciones_json: JSON.stringify(["El número de control no coincide"]),
  mh_estado: "RECHAZADO",
  ...overrides
});

describe("rejectionDetailForDocument", () => {
  it("keeps direct observations and removes duplicates", () => {
    const detail = rejectionDetailForDocument(
      rejected({ mh_observaciones_json: JSON.stringify(["Documento inválido", "Documento inválido", "Receptor incompleto"]) }),
      []
    );
    expect(detail?.reasons).toEqual(["Documento inválido", "Receptor incompleto"]);
  });

  it("extracts code, description, and observations from a stringified MH error", () => {
    const raw = {
      codigoMsg: "020",
      descripcionMsg: "DOCUMENTO INVALIDO",
      observaciones: ["DOCUMENTO INVALIDO", "[identificacion.numeroControl] valor inválido"]
    };
    const detail = rejectionDetailForDocument(rejected({ mh_observaciones_json: JSON.stringify([JSON.stringify(raw)]) }), []);
    expect(detail?.reasons).toEqual(["020: DOCUMENTO INVALIDO", "[identificacion.numeroControl] valor inválido"]);
    expect(detail?.reasons.join(" ")).not.toContain("codigoMsg");
  });

  it("uses the newest relevant audit row with a valid timestamp", () => {
    const detail = rejectionDetailForDocument(rejected(), [
      { action: "DOCUMENT_EMAIL_UPDATED", created_at: "2026-07-11T22:00:00.000Z" },
      { action: "DTE_RETRIED", created_at: "2026-07-11T22:11:00.000Z" },
      { action: "DTE_REJECTED", created_at: "2026-07-05T18:00:00.000Z" }
    ]);
    expect(detail?.rejectedAt).toBe("2026-07-11T22:11:00.000Z");
  });

  it("skips invalid relevant timestamps and never uses updated_at", () => {
    const documentWithLaterUpdate = { ...rejected(), updated_at: "2026-07-11T23:00:00.000Z" };
    const detail = rejectionDetailForDocument(
      documentWithLaterUpdate,
      [{ action: "DTE_REJECTED", created_at: "not-a-date" }]
    );
    expect(detail?.rejectedAt).toBeNull();
  });

  it("falls back safely for malformed or missing evidence", () => {
    expect(rejectionDetailForDocument(rejected({ mh_observaciones_json: "not-json", mh_estado: "HTTP_400" }), [])?.reasons).toEqual(["HTTP_400"]);
    expect(rejectionDetailForDocument(rejected({ mh_observaciones_json: "[]", mh_estado: null }), [])?.reasons).toEqual(["Motivo no disponible"]);
  });

  it("returns null for a document that is not rejected", () => {
    expect(rejectionDetailForDocument(rejected({ status: "FAILED" }), [])).toBeNull();
  });
});
```

- [ ] **Step 2: Run the helper test to verify RED**

Run:

```bash
rtk npx vitest run test/client/rejectionDetail.test.ts
```

Expected: FAIL because `src/client/rejectionDetail.ts` does not exist.

- [ ] **Step 3: Implement the minimal pure projection**

Create `src/client/rejectionDetail.ts`:

```ts
import type { AuditRow, DteDocument } from "./types";

export interface RejectionDetail {
  reasons: string[];
  rejectedAt: string | null;
}

type RejectionDocument = Pick<DteDocument, "status" | "mh_observaciones_json" | "mh_estado">;
type RejectionAuditRow = Pick<AuditRow, "action" | "created_at">;

const REJECTION_AUDIT_ACTIONS = new Set(["DTE_REJECTED", "ADVANCED_CDE_REJECTED", "DTE_RETRIED"]);

export function rejectionDetailForDocument(document: RejectionDocument, audit: RejectionAuditRow[]): RejectionDetail | null {
  if (document.status !== "REJECTED") return null;

  const reasons = rejectionReasons(document.mh_observaciones_json);
  if (reasons.length === 0) {
    reasons.push(document.mh_estado?.trim() || "Motivo no disponible");
  }

  const rejectionEvent = audit.find(
    (row) => REJECTION_AUDIT_ACTIONS.has(row.action) && validTimestamp(row.created_at)
  );
  return { reasons, rejectedAt: rejectionEvent?.created_at ?? null };
}

function rejectionReasons(value: string): string[] {
  const reasons: string[] = [];
  const seen = new Set<string>();
  let observations: unknown;
  try {
    observations = JSON.parse(value);
  } catch {
    return reasons;
  }
  if (!Array.isArray(observations)) return reasons;
  for (const observation of observations) collectObservation(observation, reasons, seen);
  return reasons;
}

function collectObservation(value: unknown, reasons: string[], seen: Set<string>): void {
  if (typeof value !== "string") return;
  const text = value.trim();
  if (!text) return;
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed)) {
      collectMhRecord(parsed, reasons, seen);
      return;
    }
  } catch {
    // Ordinary MH observation, not nested JSON.
  }
  addReason(text, reasons, seen);
}

function collectMhRecord(value: Record<string, unknown>, reasons: string[], seen: Set<string>): void {
  const candidates = [value, isRecord(value.body) ? value.body : null].filter(isRecord);
  for (const candidate of candidates) {
    const code = textValue(candidate.codigoMsg);
    const description = textValue(candidate.descripcionMsg);
    if (code || description) addReason([code, description].filter(Boolean).join(": "), reasons, seen);
    if (!Array.isArray(candidate.observaciones)) continue;
    for (const observation of candidate.observaciones) {
      const observationText = textValue(observation);
      if (observationText && observationText !== description) addReason(observationText, reasons, seen);
    }
  }
}

function addReason(value: string, reasons: string[], seen: Set<string>): void {
  const normalized = value.trim();
  if (!normalized || seen.has(normalized)) return;
  seen.add(normalized);
  reasons.push(normalized);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validTimestamp(value: string): boolean {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}
```

- [ ] **Step 4: Run the helper test to verify GREEN**

Run:

```bash
rtk npx vitest run test/client/rejectionDetail.test.ts
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit the pure projection**

```bash
rtk git add src/client/rejectionDetail.ts test/client/rejectionDetail.test.ts
rtk git commit -m "feat(documents): derive rejection detail evidence"
```

---

### Task 2: Detail-panel state, rendering, and styling

**Files:**
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`
- Modify: `test/client/visualConsistency.test.ts`

**Interfaces:**
- Consumes: `rejectionDetailForDocument(document, audit)` from Task 1 and `formatElSalvadorDateTime(iso)` from `src/shared/legalWindows.ts`.
- Produces: a selected-document `AuditRow[]` state and a `rejection-detail` section immediately before `json-details`.

- [ ] **Step 1: Add the failing placement/style regression**

Append this test inside `test/client/visualConsistency.test.ts`:

```ts
it("places readable rejection evidence immediately above the JSON disclosure", () => {
  expect(appSource).toContain('import { rejectionDetailForDocument } from "./rejectionDetail";');
  expect(appSource).toContain('className="rejection-detail"');
  expect(appSource).toContain("Detalle del rechazo");
  expect(appSource).toContain("Motivo");
  expect(appSource).toContain("Fecha y hora");
  expect(appSource.indexOf('className="rejection-detail"')).toBeLessThan(appSource.indexOf('<details className="json-details">'));
  expect(stylesSource).toMatch(/\.rejection-detail \{[\s\S]*?overflow-wrap: anywhere;[\s\S]*?\}/);
  expect(stylesSource).toContain("background: var(--danger-tint);");
  expect(stylesSource).toContain("border: 1px solid var(--danger-border);");
});
```

- [ ] **Step 2: Run the client regression to verify RED**

Run:

```bash
rtk npx vitest run test/client/visualConsistency.test.ts -t "places readable rejection evidence"
```

Expected: FAIL because `App.tsx` has no rejection block.

- [ ] **Step 3: Retain audit rows from the existing detail request**

In `src/client/App.tsx`:

```ts
import { rejectionDetailForDocument } from "./rejectionDetail";
```

Add selected-document audit state beside `donorVerifiedDocId`:

```ts
const [selectedDocumentAudit, setSelectedDocumentAudit] = useState<AuditRow[]>([]);
```

Replace the selected-document detail effect's request type and state handling with:

```ts
useEffect(() => {
  const documentId = selected?.id;
  if (!token || !documentId) {
    setDonorVerifiedDocId(null);
    setSelectedDocumentAudit([]);
    return;
  }
  setDonorVerifiedDocId(null);
  setSelectedDocumentAudit([]);
  let cancelled = false;
  void api<{ donorDataVerified?: boolean; audit?: AuditRow[] }>(`/api/documents/${documentId}`, token)
    .then((detail) => {
      if (!cancelled) {
        setDonorVerifiedDocId(detail.donorDataVerified ? documentId : null);
        setSelectedDocumentAudit(Array.isArray(detail.audit) ? detail.audit : []);
      }
    })
    .catch(() => {
      if (!cancelled) {
        setDonorVerifiedDocId(null);
        setSelectedDocumentAudit([]);
      }
    });
  return () => {
    cancelled = true;
  };
}, [token, selected?.id]);
```

Pass the state into `DetailPanel`:

```tsx
<DetailPanel
  selected={selected}
  audit={selectedDocumentAudit}
  donorDataVerified={selected?.id === donorVerifiedDocId}
  busy={busy}
  now={now}
  onAction={documentAction}
  onInvalidateRequest={(id) => {
    setInvalidationForm(defaultInvalidationForm());
    setPendingInvalidationId(id);
  }}
  onDownload={downloadDocument}
  emailEditingId={emailEditingId}
  emailDraft={emailDraft}
  onStartEmailEdit={(document) => {
    setEmailEditingId(document.id);
    setEmailDraft(document.donor_email ?? "");
  }}
  onEmailDraftChange={setEmailDraft}
  onCancelEmailEdit={() => {
    setEmailEditingId(null);
    setEmailDraft("");
  }}
  onSaveEmail={saveDocumentEmail}
/>
```

- [ ] **Step 4: Render the approved rejection block**

Add `audit: AuditRow[]` to the `DetailPanel` props and calculate:

```ts
const rejectionDetail = rejectionDetailForDocument(selected, audit);
```

Insert this block after `.actions` and immediately before `.json-details`:

```tsx
{rejectionDetail && (
  <section className="rejection-detail" aria-label="Detalle del rechazo">
    <div className="rejection-detail-head">
      <AlertTriangle size={16} />
      <strong>Detalle del rechazo</strong>
    </div>
    <dl>
      <dt>Motivo</dt>
      <dd>
        <ul>
          {rejectionDetail.reasons.map((reason) => <li key={reason}>{reason}</li>)}
        </ul>
      </dd>
      <dt>Fecha y hora</dt>
      <dd>
        {rejectionDetail.rejectedAt ? (
          <time dateTime={rejectionDetail.rejectedAt}>
            {formatElSalvadorDateTime(rejectionDetail.rejectedAt)} hora El Salvador
          </time>
        ) : "Fecha no disponible"}
      </dd>
    </dl>
  </section>
)}
```

- [ ] **Step 5: Add compact, wrapping danger styling**

Add to `src/client/styles.css` beside `.actions` and `.json-details`:

```css
.rejection-detail {
  display: grid;
  gap: 10px;
  margin: 0 0 14px;
  padding: 12px;
  color: var(--danger);
  background: var(--danger-tint);
  border: 1px solid var(--danger-border);
  border-radius: 10px;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.rejection-detail-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.rejection-detail-head svg {
  flex: 0 0 auto;
}

.rejection-detail dl {
  grid-template-columns: 78px minmax(0, 1fr);
  gap: 6px 10px;
  margin: 0;
}

.rejection-detail dt {
  color: var(--danger);
}

.rejection-detail dd {
  min-width: 0;
  color: var(--ink);
}

.rejection-detail ul {
  display: grid;
  gap: 4px;
  margin: 0;
  padding-left: 16px;
}
```

- [ ] **Step 6: Run focused client tests to verify GREEN**

Run:

```bash
rtk npx vitest run test/client/rejectionDetail.test.ts test/client/visualConsistency.test.ts
```

Expected: both files pass.

- [ ] **Step 7: Commit the UI integration**

```bash
rtk git add src/client/App.tsx src/client/styles.css test/client/visualConsistency.test.ts
rtk git commit -m "feat(documents): show MH rejection details"
```

---

### Task 3: Full verification and rendered QA

**Files:**
- Verify only; no production files should change.

**Interfaces:**
- Consumes: the completed helper and detail-panel integration.
- Produces: automated and rendered evidence that reason, timestamp, conditional visibility, placement, and wrapping satisfy the approved design.

- [ ] **Step 1: Run all automated gates**

Run these independently:

```bash
rtk npm run typecheck
rtk npm test
rtk npm run build
rtk npm run security:check-private-boundary
rtk git diff --check
```

Expected: typecheck and build exit 0; all test files pass; private boundary is clean; diff check produces no output.

- [ ] **Step 2: Seed representative local rejection evidence**

Use `/tmp/diezmossv-rejection-detail-state-20260711` as an isolated Wrangler state directory. Apply all local D1 migrations:

```bash
rtk proxy ./node_modules/.bin/wrangler d1 migrations apply diezmossv-local-db-example --local --persist-to /tmp/diezmossv-rejection-detail-state-20260711
```

Create `/tmp/diezmossv-rejection-detail-seed.sql` with this exact content:

```sql
INSERT INTO dte_documents (
  id, wompi_event_id, tipo_dte, environment, codigo_generacion, numero_control,
  status, plain_json, signed_jws, sello_recibido, mh_estado,
  mh_observaciones_json, donor_email, donor_name, amount_cents, issued_at,
  accepted_at, contingency_period_id, created_at, updated_at
) VALUES (
  'qa-rejected-detail', NULL, '15', '00',
  '33333333-3333-4333-8333-333333333333',
  'DTE-15-M001P004-000000000000903', 'REJECTED', '{}', NULL, NULL,
  'HTTP_400',
  '["{\"codigoMsg\":\"020\",\"descripcionMsg\":\"DOCUMENTO INVALIDO\",\"observaciones\":[\"[identificacion.numeroControl] valor inválido\"]}"]',
  NULL, 'QA Rechazo Detallado', 100, '2026-07-11T22:10:00.000Z',
  NULL, NULL, '2026-07-11T22:10:00.000Z', '2026-07-11T22:11:00.000Z'
);

INSERT INTO audit_logs (
  id, actor_type, actor_id, action, entity_type, entity_id, summary,
  metadata_json, created_at
) VALUES (
  'audit-qa-rejected-detail', 'SYSTEM', NULL, 'DTE_RETRIED',
  'dte_document', 'qa-rejected-detail', 'HTTP_400', '{}',
  '2026-07-11T22:11:00.000Z'
);
```

Load the seed:

```bash
rtk proxy ./node_modules/.bin/wrangler d1 execute diezmossv-local-db-example --local --persist-to /tmp/diezmossv-rejection-detail-state-20260711 --file /tmp/diezmossv-rejection-detail-seed.sql
```

Do not use staging or production data for this test.

The seed must represent:

```json
{
  "codigoMsg": "020",
  "descripcionMsg": "DOCUMENTO INVALIDO",
  "observaciones": ["[identificacion.numeroControl] valor inválido"]
}
```

and audit time `2026-07-11T22:11:00.000Z`, which should render as `11/07/2026, 16:11 hora El Salvador`.

- [ ] **Step 3: Verify the rendered interaction locally**

Start the Worker with the isolated state and `.dev.vars.ci`, create the local CI owner, and verify in the in-app browser:

```bash
DIEZMOSSV_ENV_FILE=.dev.vars.ci rtk npm run dev:worker -- --port 8791 --ip 127.0.0.1 --persist-to /tmp/diezmossv-rejection-detail-state-20260711
```

- the selected rejected CDE shows **Detalle del rechazo** above **Ver JSON completo**;
- the reason displays `020: DOCUMENTO INVALIDO` and the specific observation, not raw JSON;
- the timestamp displays `11/07/2026, 16:11 hora El Salvador`;
- long text wraps inside the detail panel;
- selecting a non-rejected document hides the block;
- browser console warnings/errors are empty.

Capture one desktop screenshot of the rejected detail panel, restore the user's staging tab unchanged, stop the local server, and remove only the temporary seed/state artifacts created by this task.

- [ ] **Step 4: Confirm repository state**

Run:

```bash
rtk git status --short --branch
rtk git log -3 --oneline
```

Expected: no uncommitted changes; the latest branch history includes the design, implementation plan, projection, and UI commits. Do not push or deploy without a separate explicit user request.
