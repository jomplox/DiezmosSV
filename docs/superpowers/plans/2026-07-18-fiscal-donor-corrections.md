# Guarded Fiscal Donor Corrections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authorized operators correct structured receptor data and safely retry both paid pre-CDE Wompi failures and CDEs explicitly rejected by MH without losing evidence or duplicating fiscal operations.

**Architecture:** A shared normalized receptor contract feeds a new immutable `fiscal_corrections` lifecycle. Both guarded APIs claim before queueing one correction ID; the queue applies the exact correction through existing builders, keeps pre-CDE reservations, creates fresh identifiers after explicit MH rejection, and locks uncertain dispatch outcomes for reconciliation.

**Tech Stack:** TypeScript 7, React 19, Cloudflare Workers, D1/SQLite, Cloudflare Queues, Vitest, Playwright, Wrangler.

## Global Constraints

- Only `OPERATOR`, `ADMIN`, and `OWNER` may read correction data or submit a correction.
- Editable fields are limited to the structured receptor contract; amount, gift type, Wompi payment identity, issuer data, environment, timestamps, fiscal identifiers, seals, payment method, and payment reference are immutable.
- A pre-CDE correction reuses any existing `numeroControl` and `codigoGeneracion` reservation.
- A correction after an explicit MH rejection allocates new fiscal identifiers only after durable snapshot and claim.
- The same `correctionRequestId` and payload are idempotent; reuse with a different target or payload returns `409`.
- Every MH side effect is claim-before-dispatch. Unknown transport outcomes remain `REVIEW_REQUIRED` and are never automatically retried.
- Audit metadata contains correction IDs and changed field names, never before/after PII.
- Existing failures are not corrected or retried by migration or deployment.
- Production deployment and production data mutation remain out of scope.
- Every shell command begins with `rtk`.

---

## File structure

**Create**

- `migrations/0027_fiscal_corrections.sql` — correction history, idempotency, status, dispatch evidence, and indexes.
- `src/shared/fiscalCorrection.ts` — normalized receptor types, validation, canonicalization, comparison, and protected-key rejection.
- `src/worker/services/fiscalCorrection.ts` — effective-receptor extraction, candidate building, source snapshotting, and safe outcome helpers.
- `src/client/fiscalCorrectionDialog.tsx` — focused correction dialog and form fields.
- `test/worker/fiscalCorrection.test.ts` — shared and worker correction-domain tests.
- `test/client/fiscalCorrection.test.ts` — client validation, copy, protected fields, and modal wiring tests.

**Modify**

- `src/worker/types.ts` — correction record/status types and `fiscalCorrectionId` queue message.
- `src/worker/storage/repository.ts` — correction claims, state transitions, recovery reads, retention table registration.
- `src/worker/services/pipeline.ts` — exact-correction pre-CDE and rejected-document processing.
- `src/worker/index.ts` — correction APIs, queue dispatch, dead-letter behavior, and scheduled recovery.
- `src/worker/services/retention.ts` — export/restore ordering for correction history.
- `src/client/types.ts` — allowlisted correction API types.
- `src/client/App.tsx` — load/open/submit state and Fallos integration.
- `src/client/styles.css` — responsive correction dialog and status styling.
- `src/client/displayText.ts` — Spanish correction audit labels.
- `test/worker/repositoryFiscalSql.test.ts` — real SQLite migration and claim fencing.
- `test/worker/workerFetch.test.ts` — role, API, queue, pipeline, and idempotency behavior.
- `test/worker/retention.test.ts` — correction export/restore coverage.
- `test/client/visualConsistency.test.ts` — Fallos action placement and removal of blind rejected-content retry.
- `docs/runbook-operador.md` — operator correction and reconciliation procedure.

---

### Task 1: Shared normalized receptor contract

**Files:**

- Create: `src/shared/fiscalCorrection.ts`
- Create: `test/worker/fiscalCorrection.test.ts`

**Interfaces:**

- Produces:

```ts
export interface FiscalReceptorCorrection {
  tipoDocumento: string;
  numDocumento: string;
  nrc: string | null;
  nombre: string;
  codActividad: string | null;
  descActividad: string | null;
  correo: string | null;
  telefono: string | null;
  codDomiciliado: 1 | 2;
  codPais: string;
  departamento: string;
  municipio: string;
  distrito: string;
  complemento: string;
}

export type FiscalCorrectionStatus =
  | "QUEUED"
  | "PROCESSING"
  | "ACCEPTED"
  | "REJECTED"
  | "FAILED"
  | "REVIEW_REQUIRED";

export class FiscalCorrectionValidationError extends Error {
  constructor(readonly code: string, message: string);
}

export function validateFiscalReceptorCorrection(
  input: Record<string, unknown>
): FiscalReceptorCorrection;

export function fiscalCorrectionChangedFields(
  before: FiscalReceptorCorrection,
  after: FiscalReceptorCorrection
): Array<keyof FiscalReceptorCorrection>;

export function fiscalCorrectionPayload(
  value: FiscalReceptorCorrection
): string;
```

- Consumes existing catalog predicates from `src/shared/catalogs.ts`, DUI helpers from
  `src/shared/dui.ts`, and NIT helpers from `src/shared/nit.ts`.

- [ ] **Step 1: Write the failing canonicalization and validation tests**

```ts
import { describe, expect, it } from "vitest";
import {
  FiscalCorrectionValidationError,
  fiscalCorrectionChangedFields,
  fiscalCorrectionPayload,
  validateFiscalReceptorCorrection
} from "../../src/shared/fiscalCorrection";

const valid = () => ({
  tipoDocumento: "13",
  numDocumento: "100000027",
  nrc: "",
  nombre: " Ana Donante ",
  codActividad: "",
  descActividad: "",
  correo: " ANA@Example.org ",
  telefono: " 70001111 ",
  codDomiciliado: 1,
  codPais: "sv",
  departamento: "06",
  municipio: "22",
  distrito: "01",
  complemento: " Colonia Centro "
});

describe("fiscal receptor correction", () => {
  it("canonicalizes a valid domestic correction", () => {
    expect(validateFiscalReceptorCorrection(valid())).toEqual({
      tipoDocumento: "13",
      numDocumento: "10000002-7",
      nrc: null,
      nombre: "Ana Donante",
      codActividad: null,
      descActividad: null,
      correo: "ana@example.org",
      telefono: "70001111",
      codDomiciliado: 1,
      codPais: "SV",
      departamento: "06",
      municipio: "22",
      distrito: "01",
      complemento: "Colonia Centro"
    });
  });

  it("rejects an invalid DUI before any fiscal work", () => {
    expect(() => validateFiscalReceptorCorrection({
      ...valid(),
      numDocumento: "12345678-9"
    })).toThrowError(FiscalCorrectionValidationError);
  });

  it("accepts a foreign receptor without pretending 00 is an SV district", () => {
    expect(validateFiscalReceptorCorrection({
      ...valid(),
      tipoDocumento: "03",
      numDocumento: "P-A123456",
      codDomiciliado: 2,
      codPais: "GT",
      departamento: "00",
      municipio: "00",
      distrito: "00",
      complemento: "Zona 10, Ciudad de Guatemala"
    })).toMatchObject({
      codDomiciliado: 2,
      codPais: "GT",
      departamento: "00",
      municipio: "00",
      distrito: "00"
    });
  });

  it("returns sorted changed fields and a stable payload", () => {
    const before = validateFiscalReceptorCorrection(valid());
    const after = { ...before, correo: "new@example.org", nombre: "Nueva Donante" };
    expect(fiscalCorrectionChangedFields(before, after)).toEqual(["correo", "nombre"]);
    expect(fiscalCorrectionPayload(after)).toBe(fiscalCorrectionPayload({ ...after }));
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
rtk npm test -- test/worker/fiscalCorrection.test.ts
```

Expected: FAIL because `src/shared/fiscalCorrection.ts` does not exist.

- [ ] **Step 3: Implement the shared contract**

Create `src/shared/fiscalCorrection.ts` with this structure:

```ts
import {
  isCat008DistrictCode,
  isCat012DepartmentCode,
  isCat013MunicipalityCode,
  isCat019ActivityCode,
  isCat020CountryCode,
  isCat022DocumentTypeCode,
  isCat032DomicileCode,
  normalizeCat020CountryCode
} from "./catalogs";
import { formatDui, isDuiDocumentType, isValidDui } from "./dui";
import { formatNit, isValidNitFormat } from "./nit";

export interface FiscalReceptorCorrection {
  tipoDocumento: string;
  numDocumento: string;
  nrc: string | null;
  nombre: string;
  codActividad: string | null;
  descActividad: string | null;
  correo: string | null;
  telefono: string | null;
  codDomiciliado: 1 | 2;
  codPais: string;
  departamento: string;
  municipio: string;
  distrito: string;
  complemento: string;
}

export class FiscalCorrectionValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FiscalCorrectionValidationError";
  }
}

const KEYS = [
  "tipoDocumento", "numDocumento", "nrc", "nombre", "codActividad",
  "descActividad", "correo", "telefono", "codDomiciliado", "codPais",
  "departamento", "municipio", "distrito", "complemento"
] as const;

export function validateFiscalReceptorCorrection(
  input: Record<string, unknown>
): FiscalReceptorCorrection {
  for (const key of Object.keys(input)) {
    if (!(KEYS as readonly string[]).includes(key)) {
      throw new FiscalCorrectionValidationError(
        "protected_field",
        `El campo ${key} no se puede corregir desde esta pantalla.`
      );
    }
  }
  // Normalize strings, validate CAT-022, DUI/NIT, optional NRC/activity,
  // email/phone lengths, CAT-032/CAT-020, domestic catalog relationships,
  // and the foreign 00/00/00 rule. Return only the exact interface above.
  return normalizeAndValidate(input);
}

export function fiscalCorrectionChangedFields(
  before: FiscalReceptorCorrection,
  after: FiscalReceptorCorrection
): Array<keyof FiscalReceptorCorrection> {
  return KEYS.filter((key) => before[key] !== after[key]).sort();
}

export function fiscalCorrectionPayload(value: FiscalReceptorCorrection): string {
  return JSON.stringify(Object.fromEntries(KEYS.map((key) => [key, value[key]])));
}
```

Implement `normalizeAndValidate` in the same file as a private function. It must:

- format valid DUI and NIT values canonically;
- uppercase non-DUI identity documents and country codes;
- lowercase email;
- require `nombre` and `complemento`;
- require `descActividad` when `codActividad` is present;
- require `codDomiciliado = 1`, `codPais = SV`, and valid domestic geography together;
- require `codDomiciliado = 2`, non-`SV` country, and `00/00/00` together for foreign donors;
- reject every unrecognized input key before normalization.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
rtk npm test -- test/worker/fiscalCorrection.test.ts
```

Expected: PASS with all correction-contract tests green.

- [ ] **Step 5: Commit the shared contract**

```bash
rtk git add src/shared/fiscalCorrection.ts test/worker/fiscalCorrection.test.ts
rtk git commit -m "feat: validate fiscal receptor corrections"
```

---

### Task 2: Durable correction history and real-SQL claim fences

**Files:**

- Create: `migrations/0027_fiscal_corrections.sql`
- Modify: `src/worker/types.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `test/worker/repositoryFiscalSql.test.ts`
- Modify: `test/worker/wompiIssuanceSchema.test.ts`

**Interfaces:**

- Produces `FiscalCorrectionRecord`, `FiscalCorrectionStatus`,
  `FiscalCorrectionClaimResult`, and repository methods:

```ts
claimWompiFiscalCorrection(input: WompiFiscalCorrectionClaimInput):
  Promise<FiscalCorrectionClaimResult>;
claimDocumentFiscalCorrection(input: DocumentFiscalCorrectionClaimInput):
  Promise<FiscalCorrectionClaimResult>;
getFiscalCorrection(id: string): Promise<FiscalCorrectionRecord | null>;
getFiscalCorrectionByRequestId(requestId: string):
  Promise<FiscalCorrectionRecord | null>;
claimFiscalCorrectionProcessing(input: {
  id: string;
  processingClaimId: string;
  issuanceAttemptId?: string;
  fiscalClaimId?: string;
}): Promise<"claimed" | "busy" | "terminal">;
markFiscalCorrectionMhDispatchStarted(id: string, claimId: string):
  Promise<boolean>;
finalizeFiscalCorrection(
  id: string,
  claimId: string,
  outcome: FiscalCorrectionOutcome
): Promise<boolean>;
listRecoverableFiscalCorrections(staleBefore: string, limit?: number):
  Promise<FiscalCorrectionRecord[]>;
```

- [ ] **Step 1: Write failing SQLite migration and concurrency tests**

Add tests that run every migration and assert:

```ts
it("stores one correction for concurrent reuse of the same request id", async () => {
  const database = migratedDatabase();
  const repository = new Repository(new SqliteD1(database).database);
  seedFailedWompiEvent(database, "wompi_bad_dui");

  const input = wompiCorrectionClaimInput({
    requestId: "11111111-1111-4111-8111-111111111111"
  });
  const [first, second] = await Promise.all([
    repository.claimWompiFiscalCorrection(input),
    repository.claimWompiFiscalCorrection(input)
  ]);

  expect([first.kind, second.kind].sort()).toEqual(["claimed", "duplicate"]);
  expect(database.prepare(
    "SELECT COUNT(*) AS count FROM fiscal_corrections"
  ).get()).toEqual({ count: 1 });
  expect(database.prepare(
    "SELECT issuance_status, processed_at FROM wompi_events WHERE id = ?"
  ).get("wompi_bad_dui")).toEqual({
    issuance_status: "RETRY_QUEUED",
    processed_at: null
  });
});

it("snapshots a rejected document before claiming it", async () => {
  const database = migratedDatabase();
  seedRejectedDocument(database, "doc_rejected");
  const repository = new Repository(new SqliteD1(database).database);

  const result = await repository.claimDocumentFiscalCorrection(
    documentCorrectionClaimInput()
  );

  expect(result).toMatchObject({ kind: "claimed" });
  const stored = database.prepare(
    "SELECT source_document_snapshot_json FROM fiscal_corrections"
  ).get() as { source_document_snapshot_json: string };
  expect(JSON.parse(stored.source_document_snapshot_json)).toMatchObject({
    id: "doc_rejected",
    status: "REJECTED",
    signed_jws: "rejected-jws",
    mh_estado: "RECHAZADO"
  });
  expect(database.prepare(
    "SELECT fiscal_operation_claim_id FROM dte_documents WHERE id = ?"
  ).get("doc_rejected")).toMatchObject({
    fiscal_operation_claim_id: expect.any(String)
  });
});
```

Also assert `request_id` uniqueness, per-target `attempt_number` uniqueness, JSON
validity constraints, target-kind/snapshot constraints, processing-token fencing, and
`mh_dispatch_started_at` being distinct from `processing_started_at`.

- [ ] **Step 2: Run real-SQL tests and verify RED**

Run:

```bash
rtk npm test -- test/worker/repositoryFiscalSql.test.ts test/worker/wompiIssuanceSchema.test.ts
```

Expected: FAIL because migration 0027 and repository correction methods are absent.

- [ ] **Step 3: Create migration 0027**

Create `migrations/0027_fiscal_corrections.sql`:

```sql
CREATE TABLE fiscal_corrections (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  request_payload_sha256 TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('WOMPI_EVENT', 'DTE_DOCUMENT')),
  wompi_event_id TEXT REFERENCES wompi_events(id),
  document_id TEXT REFERENCES dte_documents(id),
  environment TEXT NOT NULL CHECK (environment IN ('00', '01')),
  status TEXT NOT NULL CHECK (status IN (
    'QUEUED', 'PROCESSING', 'ACCEPTED', 'REJECTED', 'FAILED', 'REVIEW_REQUIRED'
  )),
  before_receptor_json TEXT NOT NULL CHECK (json_valid(before_receptor_json)),
  corrected_receptor_json TEXT NOT NULL CHECK (json_valid(corrected_receptor_json)),
  changed_fields_json TEXT NOT NULL CHECK (json_valid(changed_fields_json)),
  source_document_snapshot_json TEXT
    CHECK (source_document_snapshot_json IS NULL OR json_valid(source_document_snapshot_json)),
  issuance_attempt_id TEXT,
  fiscal_claim_id TEXT,
  processing_claim_id TEXT NOT NULL,
  mh_dispatch_started_at TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  processing_started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (
    (target_kind = 'WOMPI_EVENT' AND wompi_event_id IS NOT NULL AND document_id IS NULL)
    OR
    (
      target_kind = 'DTE_DOCUMENT'
      AND document_id IS NOT NULL
      AND source_document_snapshot_json IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX uq_fiscal_corrections_wompi_attempt
  ON fiscal_corrections(wompi_event_id, attempt_number)
  WHERE target_kind = 'WOMPI_EVENT';
CREATE UNIQUE INDEX uq_fiscal_corrections_document_attempt
  ON fiscal_corrections(document_id, attempt_number)
  WHERE target_kind = 'DTE_DOCUMENT';
CREATE INDEX idx_fiscal_corrections_wompi
  ON fiscal_corrections(wompi_event_id, created_at);
CREATE INDEX idx_fiscal_corrections_document
  ON fiscal_corrections(document_id, created_at);
CREATE INDEX idx_fiscal_corrections_recovery
  ON fiscal_corrections(status, processing_started_at, created_at);
```

- [ ] **Step 4: Add worker correction types**

Add to `src/worker/types.ts`:

```ts
import type {
  FiscalCorrectionStatus,
  FiscalReceptorCorrection
} from "../shared/fiscalCorrection";

export interface FiscalCorrectionRecord {
  id: string;
  request_id: string;
  request_payload_sha256: string;
  attempt_number: number;
  target_kind: "WOMPI_EVENT" | "DTE_DOCUMENT";
  wompi_event_id: string | null;
  document_id: string | null;
  environment: Ambiente;
  status: FiscalCorrectionStatus;
  before_receptor_json: string;
  corrected_receptor_json: string;
  changed_fields_json: string;
  source_document_snapshot_json: string | null;
  issuance_attempt_id: string | null;
  fiscal_claim_id: string | null;
  processing_claim_id: string;
  mh_dispatch_started_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  created_by: string;
  created_at: string;
  processing_started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export interface FiscalCorrectionData {
  receptor: FiscalReceptorCorrection;
  targetStatus: string;
  failureReason: string;
  correctable: boolean;
  guidance: string | null;
  activeCorrection: Pick<FiscalCorrectionRecord, "id" | "status"> | null;
}

export interface IssuanceMessage {
  wompiEventId?: string;
  issuanceAttemptId?: string;
  advancedDocumentId?: string;
  fiscalCorrectionId?: string;
  fiscalCorrectionProcessingClaimId?: string;
  fiscalClaimId?: string;
}
```

- [ ] **Step 5: Implement transactional repository claims**

Use `INSERT OR IGNORE` plus target updates guarded by the newly generated correction ID.
Allocate `attempt_number` atomically with `INSERT ... SELECT COALESCE(MAX(...), 0) + 1`
under the target-specific unique index, and retry only a uniqueness collision caused by
a concurrent different request.
The Wompi batch must set `processed_at = NULL`, `issuance_status = 'RETRY_QUEUED'`,
and one new `issuance_attempt_id` only for `FAILED`/`DEAD_LETTERED` rows without a
document or active attempt.

The rejected-document batch must snapshot the row and set the existing
`fiscal_operation_claim_id`, `fiscal_operation_claimed_at`, and
`fiscal_operation_kind = 'TRANSMISSION'` only while status remains `REJECTED`.

After every batch, read by `request_id` and return:

```ts
type FiscalCorrectionClaimResult =
  | { kind: "claimed"; correction: FiscalCorrectionRecord }
  | { kind: "duplicate"; correction: FiscalCorrectionRecord }
  | { kind: "conflict"; correction: FiscalCorrectionRecord }
  | { kind: "ineligible" };
```

Compare `request_payload_sha256`, target kind, and target ID before returning
`duplicate`; any mismatch returns `conflict`.

- [ ] **Step 6: Implement owner-qualified state transitions**

`claimFiscalCorrectionProcessing` changes only a token-matching `QUEUED` row to
`PROCESSING` after also matching its issuance or fiscal ownership token. A stale safe
recovery rotates `processing_claim_id` before returning the row to `QUEUED`; the old
queue delivery then returns `busy` and cannot build, sign, or transmit.
`markFiscalCorrectionMhDispatchStarted` requires the stored claim token.
`finalizeFiscalCorrection` clears a document fiscal claim only for proven
pre-dispatch `FAILED`, retains it for `REVIEW_REQUIRED`, and records terminal MH
results for `ACCEPTED`/`REJECTED`.

- [ ] **Step 7: Run real-SQL tests and verify GREEN**

Run:

```bash
rtk npm test -- test/worker/repositoryFiscalSql.test.ts test/worker/wompiIssuanceSchema.test.ts
```

Expected: PASS, including the concurrent idempotency and snapshot tests.

- [ ] **Step 8: Commit persistence**

```bash
rtk git add migrations/0027_fiscal_corrections.sql src/worker/types.ts src/worker/storage/repository.ts test/worker/repositoryFiscalSql.test.ts test/worker/wompiIssuanceSchema.test.ts
rtk git commit -m "feat: persist guarded fiscal corrections"
```

---

### Task 3: Candidate construction and allowlisted correction APIs

**Files:**

- Create: `src/worker/services/fiscalCorrection.ts`
- Modify: `src/worker/index.ts`
- Modify: `test/worker/fiscalCorrection.test.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Interfaces:**

- Produces:

```ts
effectiveWompiCorrectionData(
  repo: Repository,
  eventId: string
): Promise<FiscalCorrectionData | null>;

effectiveDocumentCorrectionData(
  document: DteDocumentRecord
): FiscalCorrectionData;

buildCorrectedWompiCandidate(input: {
  payload: WompiWebhook;
  intent: DonationIntentRecord | null;
  correction: FiscalReceptorCorrection;
  config: EmisorConfig;
  environment: Ambiente;
  sequence: number;
  codigoGeneracion?: string;
}): Record<string, unknown>;

buildCorrectedDirectCandidate(input: {
  sourceDocument: DteDocumentRecord;
  correction: FiscalReceptorCorrection;
  config: EmisorConfig;
  sequence: number;
}): Record<string, unknown>;
```

- [ ] **Step 1: Write failing candidate-integrity tests**

```ts
it("changes only receptor and system-generated identification in a direct correction", () => {
  const source = rejectedDirectDocument();
  const corrected = buildCorrectedDirectCandidate({
    sourceDocument: source,
    correction: validCorrection({ numDocumento: "10000002-7" }),
    config: emisorConfig(),
    sequence: 42
  });
  const original = JSON.parse(source.plain_json);
  expect(corrected.receptor.numDocumento).toBe("10000002-7");
  expect(corrected.emisor).toEqual(original.emisor);
  expect(corrected.cuerpoDocumento).toEqual(original.cuerpoDocumento);
  expect(corrected.resumen).toEqual(original.resumen);
  expect(corrected.otrosDocumentos).toEqual(original.otrosDocumentos);
  expect(corrected.identificacion.codigoGeneracion)
    .not.toBe(original.identificacion.codigoGeneracion);
});
```

Add a Wompi candidate test proving amount, gift type, transaction reference, and
authorization remain sourced from the original payment/intent while the receptor comes
from the correction. Add a foreign-receptor test proving the legal `direccion` is
`null`, `codDomiciliado` is `2`, and the country/address survive in the established
appendix representation.

- [ ] **Step 2: Run candidate tests and verify RED**

Run:

```bash
rtk npm test -- test/worker/fiscalCorrection.test.ts
```

Expected: FAIL because the worker correction service does not exist.

- [ ] **Step 3: Implement candidate and extraction helpers**

In `src/worker/services/fiscalCorrection.ts`:

- parse the effective Wompi receptor from the correlated intent plus raw payment;
- parse rejected document receptor data from `plain_json`;
- map a normalized correction to `IntentDonorOverride`;
- preserve `giftType` from the intent but never accept it from the request;
- call existing builders for full DUI, catalog, issuer, and schema validation;
- classify safe failure reasons as `correctable` only when they concern receptor data;
- return Configuración guidance for issuer/payment/system failures;
- create a bounded rejected-document snapshot object that includes original identifiers,
  JSON, JWS, MH result, and timestamps.
- preflight rejected candidates with non-reserving validation identifiers, discard those
  identifiers, and allocate the real fresh sequence only after the durable claim.

- [ ] **Step 4: Add failing API role and allowlist tests**

Add tests for both correction-data endpoints and both guarded mutation endpoints:

```ts
it("returns only editable correction data to an OPERATOR", async () => {
  const response = await worker.fetch(
    authenticatedRequest(
      "/api/wompi-events/wompi_bad_dui/correction-data",
      "GET",
      "OPERATOR"
    ),
    correctionEnv()
  );
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({
    receptor: expect.objectContaining({
      tipoDocumento: "13",
      numDocumento: "12345678-9"
    }),
    targetStatus: "FAILED",
    correctable: true
  });
  for (const forbidden of [
    "raw_body", "signed_jws", "amount_cents", "emisor",
    "codigo_generacion", "numero_control", "sello_recibido"
  ]) {
    expect(text).not.toContain(forbidden);
  }
});
```

Assert unauthenticated `401`, VIEWER `403`, missing `404`, unapproved payment `409`,
accepted/invalidated/pending-reconciliation `409`, protected request key `400`,
unchanged correction `400`, and conflicting request ID `409`.

- [ ] **Step 5: Run API tests and verify RED**

Run:

```bash
rtk npm test -- test/worker/workerFetch.test.ts
```

Expected: FAIL because correction routes are absent.

- [ ] **Step 6: Implement correction routes**

Add route matches before the existing generic document action handler:

```ts
const wompiCorrectionDataMatch =
  url.pathname.match(/^\/api\/wompi-events\/([^/]+)\/correction-data$/);
const wompiCorrectRetryMatch =
  url.pathname.match(/^\/api\/wompi-events\/([^/]+)\/correct-and-retry$/);
const documentCorrectionDataMatch =
  url.pathname.match(/^\/api\/documents\/([^/]+)\/correction-data$/);
const documentCorrectRetryMatch =
  url.pathname.match(/^\/api\/documents\/([^/]+)\/correct-and-retry$/);
```

For POST:

1. require `OPERATOR`;
2. parse only `{ correctionRequestId, receptor }`;
3. validate the UUID and exact receptor keys;
4. build and validate a complete candidate before the claim;
5. SHA-256 the stable normalized payload;
6. call the appropriate repository claim;
7. return duplicate status without another queue send;
8. for `claimed`, send the correction ID, processing token, and matching issuance or
   fiscal ownership token;
9. return `202 { ok: true, queued: true, correctionId, status: "QUEUED" }`.

Simulate `ISSUANCE_QUEUE.send()` failing after the durable claim and prove the endpoint
returns an error while scheduled recovery later rotates the processing token and queues
the same correction once.

- [ ] **Step 7: Run candidate and API tests and verify GREEN**

Run:

```bash
rtk npm test -- test/worker/fiscalCorrection.test.ts test/worker/workerFetch.test.ts
```

Expected: PASS for validation, allowlisting, roles, idempotent API responses, and
candidate integrity.

- [ ] **Step 8: Commit APIs**

```bash
rtk git add src/worker/services/fiscalCorrection.ts src/worker/index.ts test/worker/fiscalCorrection.test.ts test/worker/workerFetch.test.ts
rtk git commit -m "feat: expose guarded fiscal correction APIs"
```

---

### Task 4: Pre-CDE corrected issuance

**Files:**

- Modify: `src/worker/index.ts`
- Modify: `src/worker/services/pipeline.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `test/worker/workerFetch.test.ts`

**Interfaces:**

- Consumes `FiscalCorrectionRecord`, `buildCorrectedWompiCandidate`, and
  `claimFiscalCorrectionProcessing`.
- Produces:

```ts
interface FiscalCorrectionQueueOwnership {
  processingClaimId: string;
  issuanceAttemptId?: string;
  fiscalClaimId?: string;
}

IssuancePipeline.processFiscalCorrection(
  correctionId: string,
  ownership: FiscalCorrectionQueueOwnership
):
  Promise<FiscalCorrectionRecord>;
```

- [ ] **Step 1: Write the failing invalid-DUI recovery regression**

Seed a paid Wompi event with:

- `processed_at` set;
- `issuance_status = FAILED`;
- `issuance_error_code = WOMPI_INVALID_DONOR_DUI`;
- no document;
- an existing identifier reservation.

Submit a valid correction, consume the queued correction message, and assert:

```ts
expect(queued).toEqual([expect.objectContaining({
  fiscalCorrectionId: expect.any(String),
  fiscalCorrectionProcessingClaimId: expect.any(String),
  issuanceAttemptId: expect.any(String)
})]);
expect(created.numero_control).toBe(reservedNumeroControl);
expect(created.codigo_generacion).toBe(reservedCodigoGeneracion);
expect(JSON.parse(created.plain_json).receptor.numDocumento).toBe("10000002-7");
expect(db.nextSequence).toBe(sequenceBefore);
expect(correction.status).toBe("ACCEPTED");
```

Also assert the original `raw_body` and donation intent are byte-for-byte unchanged.

- [ ] **Step 2: Run the regression and verify RED**

Run:

```bash
rtk npm test -- test/worker/workerFetch.test.ts
```

Expected: FAIL because queue handling does not recognize `fiscalCorrectionId`.

- [ ] **Step 3: Route correction queue messages first**

In `handleQueueBatch`, before `advancedDocumentId` and Wompi branches:

```ts
if (message.body.fiscalCorrectionId) {
  await pipeline.processFiscalCorrection(message.body.fiscalCorrectionId);
  message.ack();
  continue;
}
```

Reject messages missing a required processing/operational token. On error, query the
correction. Retry only token-owned `QUEUED` or safe pre-dispatch `PROCESSING` work.
Ack terminal `ACCEPTED`, `REJECTED`, `FAILED`, and `REVIEW_REQUIRED` outcomes.

- [ ] **Step 4: Implement pre-CDE correction processing**

`processFiscalCorrection` must:

1. load the correction and compare every queue ownership token;
2. no-op terminal correction states;
3. claim `QUEUED -> PROCESSING`;
4. load and compare the Wompi event's exact issuance attempt ID;
5. build with `corrected_receptor_json`;
6. reuse existing reservation or reserve once;
7. create the document under the event claim;
8. pass the correction ID through signing/transmission;
9. finalize `ACCEPTED`, `REJECTED`, `FAILED`, or `REVIEW_REQUIRED`.

Add an optional correction context to `processDteDocument`:

```ts
interface FiscalCorrectionContext {
  correctionId: string;
  processingClaimId: string;
  claimId: string;
}
```

Immediately before `MhClient.transmitDte`, persist
`mh_dispatch_started_at`. If `MhPreDispatchError` is thrown, clear the claim and mark
`FAILED`; any other transport exception after that marker becomes `REVIEW_REQUIRED`.

- [ ] **Step 5: Add no-reservation and duplicate-delivery tests**

Prove a corrected event without a reservation allocates exactly one sequence only after
validation, and two deliveries of the same correction ID create/transmit one CDE.

- [ ] **Step 6: Run worker tests and verify GREEN**

Run:

```bash
rtk npm test -- test/worker/fiscalCorrection.test.ts test/worker/workerFetch.test.ts test/worker/repositoryFiscalSql.test.ts
```

Expected: PASS with one document, one transmission, stable reserved identifiers, and
terminal correction state.

- [ ] **Step 7: Commit pre-CDE processing**

```bash
rtk git add src/worker/index.ts src/worker/services/pipeline.ts src/worker/storage/repository.ts test/worker/workerFetch.test.ts
rtk git commit -m "feat: correct paid pre-CDE failures"
```

---

### Task 5: Rejected Wompi and direct-CDE correction processing

**Files:**

- Modify: `src/worker/services/pipeline.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `src/worker/index.ts`
- Modify: `test/worker/workerFetch.test.ts`
- Modify: `test/worker/repositoryFiscalSql.test.ts`

**Interfaces:**

- Extends `processFiscalCorrection` for `target_kind = DTE_DOCUMENT`.
- Replaces blind rejected-content retry with guarded correction only.

- [ ] **Step 1: Write failing Wompi rejected-correction tests**

Assert:

- source snapshot exists before the document changes;
- corrected receptor is used;
- original Wompi amount, gift type, authorization, and transaction remain;
- one fresh control number and generation code are allocated;
- the existing document row ID and Wompi link remain;
- acceptance runs intent completion and receipt finalization.

```ts
expect(updated.id).toBe("dte_rejected");
expect(updated.wompi_event_id).toBe(eventId);
expect(updated.numero_control).not.toBe(original.numero_control);
expect(updated.codigo_generacion).not.toBe(original.codigo_generacion);
expect(snapshot.numero_control).toBe(original.numero_control);
expect(snapshot.signed_jws).toBe(original.signed_jws);
expect(db.documents).toHaveLength(1);
```

- [ ] **Step 2: Write failing direct-CDE correction tests**

For a rejected document with `wompi_event_id = null`, assert receptor changes and all
protected sections remain equal to the archived source snapshot. Assert the old signed
JWS is never passed to `MhClient.transmitDte`.

- [ ] **Step 3: Run rejected-correction tests and verify RED**

Run:

```bash
rtk npm test -- test/worker/workerFetch.test.ts test/worker/repositoryFiscalSql.test.ts
```

Expected: FAIL because document correction processing is absent.

- [ ] **Step 4: Implement document correction processing**

For `DTE_DOCUMENT`:

1. verify `fiscal_claim_id` still owns the rejected row;
2. parse `source_document_snapshot_json`;
3. build Wompi or direct candidate using only the corrected receptor;
4. allocate one new sequence after ownership is proven;
5. sign the new candidate;
6. owner-qualify the row replacement;
7. mark MH dispatch started;
8. transmit and complete under the same claim;
9. run normal accepted finalization or preserve the new rejection.

Add a repository operation:

```ts
prepareClaimedFiscalCorrectionDocument(input: {
  correctionId: string;
  documentId: string;
  claimId: string;
  codigoGeneracion: string;
  numeroControl: string;
  plainJson: Record<string, unknown>;
  signedJws: string;
  donorName: string | null;
  donorEmail: string | null;
}): Promise<boolean>;
```

The SQL requires the document to remain `REJECTED`, its claim to match, and the
correction to remain `PROCESSING`.

If signing fails before the replacement, the rejected row remains untouched. If a
proven pre-dispatch failure happens after the corrected signed candidate is durable,
release only the fiscal claim; the corrected `SIGNED` row remains eligible for the
ordinary safe DTE retry and the archived rejected version remains immutable. An
ambiguous outcome never releases or restores the claim.

- [ ] **Step 5: Remove blind unchanged-JWS rejected retry**

Change `isRetryableDocument` and `/api/documents/:id/retry` so an explicit `REJECTED`
content verdict returns:

```json
{
  "error": "document_correction_required",
  "message": "Corrija los datos rechazados antes de crear un nuevo intento fiscal."
}
```

The client-facing action for `REJECTED` will be supplied in Task 7.

- [ ] **Step 6: Add concurrency and ambiguous-outcome tests**

Run two correction requests with different request IDs against one rejected snapshot.
Assert one claim wins and one sequence is allocated. Throw a post-dispatch transport
error and assert:

```ts
expect(correction.status).toBe("REVIEW_REQUIRED");
expect(document.fiscal_operation_claim_id).toBe(correction.fiscal_claim_id);
expect(await repository.listRecoverableFiscalCorrections(staleBefore))
  .not.toContainEqual(expect.objectContaining({ id: correction.id }));
```

Then return an explicit second MH rejection, submit a new correction request against
that newly rejected row, and prove it receives the next attempt number, another fresh
identifier pair, and a second immutable source snapshot.

- [ ] **Step 7: Run rejected-correction tests and verify GREEN**

Run:

```bash
rtk npm test -- test/worker/fiscalCorrection.test.ts test/worker/workerFetch.test.ts test/worker/repositoryFiscalSql.test.ts
```

Expected: PASS for Wompi/direct rebuilding, evidence preservation, concurrency, and
ambiguous-outcome locking.

- [ ] **Step 8: Commit rejected-document processing**

```bash
rtk git add src/worker/services/pipeline.ts src/worker/storage/repository.ts src/worker/index.ts test/worker/workerFetch.test.ts test/worker/repositoryFiscalSql.test.ts
rtk git commit -m "feat: correct MH-rejected CDE content"
```

---

### Task 6: Recovery, retention, audit labels, and operator runbook

**Files:**

- Modify: `src/worker/index.ts`
- Modify: `src/worker/storage/repository.ts`
- Modify: `src/worker/services/retention.ts`
- Modify: `src/client/displayText.ts`
- Modify: `test/worker/workerFetch.test.ts`
- Modify: `test/worker/retention.test.ts`
- Modify: `test/client/displayText.test.ts`
- Modify: `docs/runbook-operador.md`

**Interfaces:**

- Produces `IssuancePipeline.recoverStalledFiscalCorrections(limit?: number)`.

- [ ] **Step 1: Write failing recovery tests**

Seed:

- a stale `QUEUED` correction;
- a stale `PROCESSING` correction with no MH dispatch marker;
- a stale `PROCESSING` correction with `mh_dispatch_started_at`;
- `REVIEW_REQUIRED`, `ACCEPTED`, and `REJECTED` corrections.

Assert only the first two correction IDs are queued once.

- [ ] **Step 2: Write failing retention tests**

Assert monthly export includes `fiscal_corrections.ndjson`, manifest count/hash, and
restore order. Assert before/after JSON remains intact and audit metadata excludes it.

- [ ] **Step 3: Run recovery and retention tests and verify RED**

Run:

```bash
rtk npm test -- test/worker/workerFetch.test.ts test/worker/retention.test.ts test/client/displayText.test.ts
```

Expected: FAIL because recovery, retention registration, and labels are absent.

- [ ] **Step 4: Implement scheduled recovery**

After `sweepStalledWompiEvents` in `handleScheduled`, call:

```ts
try {
  await pipeline.recoverStalledFiscalCorrections();
} catch (error) {
  logWorkerError(env, "fiscal_correction_recovery_failed", error);
}
```

`recoverStalledFiscalCorrections` rotates `processing_claim_id` only for stale work
proven pre-dispatch and queues the correction ID, new processing token, and matching
operational token. It never sends an MH request inside the cron invocation.

- [ ] **Step 5: Register retention and audit labels**

Add `fiscal_corrections` to the windowed retention tables and dependency-aware deletion
order before its referenced Wompi/document rows. Ensure every lifecycle transition
writes an immutable audit row with correction ID, target, request-ID hash, attempt
number, changed-field names, and safe outcome code—never receptor JSON. Add Spanish
labels:

```ts
FISCAL_CORRECTION_QUEUED: "Corrección fiscal en cola",
FISCAL_CORRECTION_STARTED: "Corrección fiscal iniciada",
FISCAL_CORRECTION_ACCEPTED: "Corrección fiscal aceptada",
FISCAL_CORRECTION_REJECTED: "Corrección fiscal rechazada",
FISCAL_CORRECTION_FAILED: "Corrección fiscal fallida",
FISCAL_CORRECTION_REVIEW_REQUIRED: "Corrección fiscal requiere revisión"
```

- [ ] **Step 6: Update the operator runbook**

Document:

- difference between pre-CDE and rejected correction;
- exact editable/protected fields;
- **Guardar y reintentar** behavior;
- `REVIEW_REQUIRED` escalation;
- prohibition on repeated retry after uncertain MH outcome;
- existing records requiring manual review after deployment.

- [ ] **Step 7: Run recovery, retention, and label tests and verify GREEN**

Run:

```bash
rtk npm test -- test/worker/workerFetch.test.ts test/worker/retention.test.ts test/client/displayText.test.ts
```

Expected: PASS with only safe stale work requeued and correction history exported.

- [ ] **Step 8: Commit operations support**

```bash
rtk git add src/worker/index.ts src/worker/storage/repository.ts src/worker/services/retention.ts src/client/displayText.ts test/worker/workerFetch.test.ts test/worker/retention.test.ts test/client/displayText.test.ts docs/runbook-operador.md
rtk git commit -m "feat: recover and retain fiscal corrections"
```

---

### Task 7: Structured correction dialog and Fallos integration

**Files:**

- Create: `src/client/fiscalCorrectionDialog.tsx`
- Create: `test/client/fiscalCorrection.test.ts`
- Modify: `src/client/types.ts`
- Modify: `src/client/App.tsx`
- Modify: `src/client/styles.css`
- Modify: `test/client/visualConsistency.test.ts`
- Modify: `test/client/emailDeliveryFailure.test.ts`

**Interfaces:**

- Produces:

```ts
export interface FiscalCorrectionData {
  receptor: FiscalReceptorCorrection;
  targetStatus: string;
  failureReason: string;
  correctable: boolean;
  guidance: string | null;
  activeCorrection: {
    id: string;
    status: FiscalCorrectionStatus;
  } | null;
}

export function FiscalCorrectionDialog(props: {
  open: boolean;
  data: FiscalCorrectionData | null;
  protectedContext: {
    amountLabel: string;
    environmentLabel: string;
    issuerLabel: string;
  };
  busy: boolean;
  error: string;
  onCancel: () => void;
  onSubmit: (value: FiscalReceptorCorrection) => Promise<void>;
}): JSX.Element | null;
```

- [ ] **Step 1: Write failing client validation and wiring tests**

Test that:

- the modal imports and uses the shared structured contract;
- amount, issuer, and environment appear only as read-only context;
- payment identity, identifiers, raw JSON, and every protected edit control are absent;
- domestic and foreign controls are conditional;
- submit is disabled until the normalized data changes and validates;
- the button text is exactly **Guardar y reintentar**;
- deterministic pre-CDE errors render **Corregir y reintentar**;
- `REJECTED` document content renders **Corregir y reintentar**, not blind
  **Reintentar DTE**;
- transient `FAILED` work retains **Reintentar DTE**;
- one stable `crypto.randomUUID()` remains associated with the action through retryable
  network failures.
- queued/processing/review-required statuses display their Spanish state and disable
  another correction action.

- [ ] **Step 2: Run client tests and verify RED**

Run:

```bash
rtk npm test -- test/client/fiscalCorrection.test.ts test/client/visualConsistency.test.ts test/client/emailDeliveryFailure.test.ts
```

Expected: FAIL because the correction dialog and actions are absent.

- [ ] **Step 3: Add client correction types**

Mirror the allowlisted server response in `src/client/types.ts` and import
`FiscalReceptorCorrection` from `src/shared/fiscalCorrection.ts`.

- [ ] **Step 4: Implement the focused dialog**

Build `FiscalCorrectionDialog` with:

- rejection reason at the top;
- identity fields;
- conditional NRC/economic activity;
- email/telephone;
- domicile and country;
- domestic catalog selects or foreign address fields;
- read-only warning that payment, amount, issuer, and fiscal identifiers cannot change;
- safe amount, environment, and issuer facts from the already-loaded list/detail record
  as read-only context, never as correction API/request fields;
- inline server/shared validation error;
- Cancel and **Guardar y reintentar** footer.

Use existing catalog arrays and helpers. Do not duplicate catalog literals.

- [ ] **Step 5: Integrate App state and stable request IDs**

Add:

```ts
type FiscalCorrectionTarget =
  | { kind: "WOMPI_EVENT"; id: string }
  | { kind: "DTE_DOCUMENT"; id: string };

const [fiscalCorrectionTarget, setFiscalCorrectionTarget] =
  useState<FiscalCorrectionTarget | null>(null);
const [fiscalCorrectionData, setFiscalCorrectionData] =
  useState<FiscalCorrectionData | null>(null);
const fiscalCorrectionRequestIds = useRef(new Map<string, string>());
```

`openFiscalCorrection` loads the appropriate correction-data endpoint and builds the
read-only context from the selected list/detail record already in memory.
`submitFiscalCorrection` reuses one request ID for the target, POSTs the normalized
receptor, closes on `202`/idempotent success, shows **Corrección en cola**, and refreshes
Fallos. Clear the ID after any definitive response (success, validation error, or
conflict); preserve it through unknown network failures.

- [ ] **Step 6: Replace unsafe actions**

Pre-CDE deterministic donor/schema failures open the dialog. Rejected content opens the
dialog. Existing retry remains only for transient non-content failures. Disable actions
while correction status is queued/processing/review-required.

- [ ] **Step 7: Add responsive styles**

Add `.fiscal-correction-dialog`, `.fiscal-correction-grid`,
`.fiscal-correction-protected`, `.fiscal-correction-reason`, and mobile rules. Reuse
existing modal, form, catalog select, danger tint, focus, and button tokens.

- [ ] **Step 8: Run client tests and verify GREEN**

Run:

```bash
rtk npm test -- test/client/fiscalCorrection.test.ts test/client/visualConsistency.test.ts test/client/emailDeliveryFailure.test.ts test/client/a11y.test.ts
```

Expected: PASS with structured fields, protected-field absence, stable request IDs, and
correct Fallos actions.

- [ ] **Step 9: Commit the operator UI**

```bash
rtk git add src/client/fiscalCorrectionDialog.tsx src/client/types.ts src/client/App.tsx src/client/styles.css test/client/fiscalCorrection.test.ts test/client/visualConsistency.test.ts test/client/emailDeliveryFailure.test.ts
rtk git commit -m "feat: add fiscal correction dialog"
```

---

### Task 8: Complete verification, publish, and stage

**Files:**

- Verify all files changed by Tasks 1-7.
- Modify only a failing test or directly responsible source if a verification gate
  exposes a concrete defect.

- [ ] **Step 1: Run focused correction tests**

```bash
rtk npm test -- test/worker/fiscalCorrection.test.ts test/worker/repositoryFiscalSql.test.ts test/worker/workerFetch.test.ts test/worker/retention.test.ts test/client/fiscalCorrection.test.ts test/client/visualConsistency.test.ts
```

Expected: all focused suites PASS.

- [ ] **Step 2: Run the complete unit/integration suite**

```bash
rtk npm test
```

Expected: zero failures. If the sandbox blocks private test directories, rerun the same
command with approved escalation; do not change tests to bypass the boundary.

- [ ] **Step 3: Run static and build gates**

```bash
rtk npm run typecheck
rtk npm run build
rtk env WRANGLER_LOG_PATH=/private/tmp/diezmos-wrangler-types.log npm run types:check
rtk npm run security:check-private-boundary
rtk git diff --check
```

Expected: all commands exit 0; generated Worker types remain unchanged unless migration
work genuinely changed bindings.

- [ ] **Step 4: Review the final diff against the specification**

```bash
rtk git status --short --branch
rtk git diff --stat origin/main...HEAD
rtk git diff origin/main...HEAD -- migrations/0027_fiscal_corrections.sql src/shared/fiscalCorrection.ts src/worker/services/fiscalCorrection.ts src/worker/storage/repository.ts src/worker/services/pipeline.ts src/worker/index.ts src/client/fiscalCorrectionDialog.tsx src/client/App.tsx
```

Expected: only approved correction, tests, retention, and runbook changes.

- [ ] **Step 5: Commit any verification-only correction**

If Step 1-4 exposes a concrete defect, return to the responsible task, add only its
named test and source files, rerun that task's focused check, and use that task's exact
commit command. If no defect exists, skip this step.

- [ ] **Step 6: Push `main` and capture the exact SHA**

```bash
rtk git push origin main
rtk git rev-parse HEAD
rtk git rev-parse origin/main
```

Expected: local and remote SHAs match.

- [ ] **Step 7: Wait for exact-commit GitHub CI**

```bash
rtk gh run list --branch main --limit 10 --json databaseId,headSha,status,conclusion,workflowName,url
```

Select only rows whose `headSha` equals the SHA captured in Step 6, then run
`rtk gh run watch` with each row's displayed numeric `databaseId` and
`--exit-status`. Expected: the exact SHA passes both `test-and-build` and `e2e`. Do not
deploy from a different SHA or while a required job is queued, in progress, canceled,
or failed.

- [ ] **Step 8: Apply migration 0027 to staging**

```bash
rtk env FISCAL_CUTOVER_QUIESCED=1 WRANGLER_LOG_PATH=/private/tmp/diezmos-wrangler-migrate-fiscal-corrections.log npm run cf:migrate:staging
```

Expected: preflight succeeds and migration `0027_fiscal_corrections.sql` is applied only
to `diezmossv-staging-resource-example`.

- [ ] **Step 9: Deploy the exact commit to Cloudflare staging**

```bash
rtk env FISCAL_CUTOVER_QUIESCED=1 WRANGLER_LOG_PATH=/private/tmp/diezmos-wrangler-deploy-fiscal-corrections.log npm run cf:deploy:staging
```

Expected: deployment succeeds for `diezmossv-staging-resource-example`; production is untouched.

- [ ] **Step 10: Verify staging health**

```bash
rtk curl -sS --fail https://worker.example.invalid/api/health
```

Expected:

```json
{"ok":true,"appEnv":"staging"}
```

The response may include an additional current timestamp.

- [ ] **Step 11: Perform rendered browser QA**

Using the Browser plugin against staging:

1. sign in and open **Fallos**;
2. open an existing **CDE NO CREADO** deterministic donor error;
3. verify **Corregir y reintentar** opens the prefilled structured dialog;
4. verify invalid DUI blocks submission;
5. verify protected payment/issuer/identifier fields are absent;
6. open a **RECHAZADO** CDE and verify the same guarded action;
7. verify mobile layout at a narrow viewport;
8. inspect browser console errors.

Do not press **Guardar y reintentar** on any existing record during QA. A real correction
and email/fiscal retry requires a separately reviewed operator action.

- [ ] **Step 12: Prove final synchronization**

```bash
rtk git status --short --branch
rtk git rev-parse HEAD
rtk git rev-parse origin/main
```

Expected: clean `main`, no ahead/behind state, and identical SHAs.
