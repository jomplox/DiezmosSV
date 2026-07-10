# DTE PDF Party Uppercase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render every EMISOR and RECEPTOR value in uppercase except emails, and remove the internal issuer `codEstable` from DTE PDFs without altering legal or stored DTE data.

**Architecture:** Keep the rule entirely inside `src/worker/services/pdf.ts`. Uppercase scalar party values at the shared party-box boundary, uppercase address/contact fragments before wrapping, preserve email fragments separately, and omit `codEstable` from the issuer display line.

**Tech Stack:** TypeScript 6, `pdf-lib`, Vitest 4, Poppler (`pdftotext` and `pdftoppm`).

## Global Constraints

- Do not mutate `record.plain_json` or any DTE object parsed from it.
- Do not change MH payload construction, configuration storage, APIs, or database schema.
- Preserve email casing exactly as stored.
- Keep `codEstable` available internally but absent from rendered PDF text.
- Add no dependencies and do not change unrelated PDF layout or typography.
- Follow RED-GREEN-REFACTOR and visually inspect the final rendered first page.

---

### Task 1: Party-value PDF presentation rule

**Files:**
- Modify: `test/worker/pdf.test.ts`
- Modify: `src/worker/services/pdf.ts`

**Interfaces:**
- Consumes: `renderDtePdf(record: DteDocumentRecord): Promise<Uint8Array>` and the existing `safeUpper`, `emisorLines`, `receptorContactLine`, and `renderToText` helpers.
- Produces: PDF text where non-email party values are uppercase and `emisor.codEstable` is not displayed; no public TypeScript interface changes.

- [ ] **Step 1: Write the failing PDF regression**

Add this focused case to `describe("DTE PDF rendering")` in `test/worker/pdf.test.ts`:

```ts
it("uppercases party values except emails and hides the internal establishment code", async () => {
  const record = testDocument();
  const plain = JSON.parse(record.plain_json) as Record<string, any>;
  plain.emisor.nombre = "Misión ExampleOrganization";
  plain.emisor.nombreComercial = "Misión ExampleOrganization";
  plain.emisor.descActividad = "Actividades de organizaciones religiosas";
  plain.emisor.direccion.complemento = "Avenida Ejemplo 100";
  plain.emisor.correo = "legacy-email-107@example.com";
  plain.emisor.codEstable = "0002";
  plain.receptor.nombre = "José Pérez";
  plain.receptor.descActividad = "Servicios profesionales";
  plain.receptor.tipoDocumento = "03";
  plain.receptor.numDocumento = "pa-123x";
  plain.receptor.direccion.complemento = "Colonia Escalón";
  plain.receptor.correo = "Donor.Mixed@Example.Org";
  record.plain_json = JSON.stringify(plain);
  const originalJson = record.plain_json;

  const text = await renderToText(record);

  expect(text).toContain("MISIÓN EXAMPLEORGANIZATION");
  expect(text).toContain("ACTIVIDADES DE ORGANIZACIONES RELIGIOSAS");
  expect(text).toContain("AVENIDA EJEMPLO 100");
  expect(text).toContain("JOSÉ PÉREZ");
  expect(text).toContain("SERVICIOS PROFESIONALES");
  expect(text).toContain("PA-123X");
  expect(text).toContain("COLONIA ESCALÓN");
  expect(text).toContain("SAN SALVADOR");
  expect(text).toContain("legacy-email-107@example.com");
  expect(text).toContain("Donor.Mixed@Example.Org");
  expect(text).not.toContain("Misión ExampleOrganization");
  expect(text).not.toContain("José Pérez");
  expect(text).not.toContain("pa-123x");
  expect(text).not.toContain("LEGACY-EMAIL-107@EXAMPLE.COM");
  expect(text).not.toContain("DONOR.MIXED@EXAMPLE.ORG");
  expect(text).not.toContain("(0002)");
  expect(record.plain_json).toBe(originalJson);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
rtk npx vitest run test/worker/pdf.test.ts -t "uppercases party values"
```

Expected: FAIL because issuer/name/activity/address and receptor activity/address retain mixed case and the issuer line still contains `(0002)`.

- [ ] **Step 3: Implement the minimal PDF-only rule**

In `drawPartyBox`, apply `safeUpper` to the scalar values:

```ts
drawKeyValue(page, options.nameLabel, safeUpper(options.name), ...);
drawKeyValue(page, "Actividad económica:", safeUpper(options.activity), ...);
drawKeyValue(page, "NRC:", safeUpper(options.nrc), ...);
drawKeyValue(page, options.documentLabel, safeUpper(options.documentNumber), ...);
```

Pass the receptor name without pre-normalizing it, because the shared box now owns scalar-value presentation:

```ts
name: receptor.nombre,
```

Build issuer lines without `codEstable`, uppercasing non-email fragments only:

```ts
function emisorLines(emisor: Party): string[] {
  const establishmentName = emisor.nombreComercial ?? emisor.nombre;
  const establishment = establishmentName ? `• ${safeUpper(establishmentName)}` : "";
  const address = [safeUpper(addressText(emisor.direccion)), emisor.telefono ? `/ Tel.: ${safeUpper(emisor.telefono)}` : ""]
    .filter(Boolean)
    .join(" ");
  const correo = emisor.correo ? `Correo: ${clean(emisor.correo)}` : "";
  return [[establishment, correo].filter(Boolean).join(" / "), `• ${address} /`].filter(Boolean);
}
```

Build receptor contact text from independent fragments so the email is untouched:

```ts
function receptorContactLine(receptor: Party, foreignAddress: string | null): string {
  return [
    safeUpper(receptorAddressText(receptor, foreignAddress)),
    receptor.telefono ? `Tel.: ${safeUpper(receptor.telefono)}` : "",
    receptor.correo ? `Correo: ${clean(receptor.correo)}` : ""
  ]
    .filter(Boolean)
    .join(" / ");
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
rtk npx vitest run test/worker/pdf.test.ts -t "uppercases party values"
```

Expected: 1 test passes.

- [ ] **Step 5: Update existing PDF expectations for the presentation rule**

Change existing mixed-case PDF assertions to their uppercase display forms, including `San Salvador`, foreign addresses/countries, and preserved lowercase fixture emails. Do not loosen assertions with case-insensitive matching.

- [ ] **Step 6: Run the complete PDF suite**

Run:

```bash
rtk npx vitest run test/worker/pdf.test.ts
```

Expected: all tests in `test/worker/pdf.test.ts` pass.

---

### Task 2: Visual and repository verification

**Files:**
- Review: generated temporary PDF and PNG under `tmp/pdfs/`
- Review: repository working-tree delta

**Interfaces:**
- Consumes: the updated `renderDtePdf` behavior from Task 1.
- Produces: visual evidence that uppercase wrapping remains inside both party boxes and repository-wide verification evidence.

- [ ] **Step 1: Generate and render a representative PDF**

Run the PDF suite to generate its temporary `cde.pdf`, copy the newest fixture into `tmp/pdfs/`, and render page 1:

```bash
rtk mkdir -p tmp/pdfs
latest_pdf=$(ls -t /tmp/diezmos-pdf-*/cde.pdf | head -1)
rtk cp "$latest_pdf" tmp/pdfs/dte-party-uppercase.pdf
rtk pdftoppm -f 1 -singlefile -png tmp/pdfs/dte-party-uppercase.pdf tmp/pdfs/dte-party-uppercase
```

Inspect `tmp/pdfs/dte-party-uppercase.png` and require: no `(0002)`, no clipping or overlap, readable uppercase address wrapping, and unchanged email presentation.

- [ ] **Step 2: Run full verification**

Run:

```bash
rtk npm test
rtk npm run typecheck
rtk npm run build
rtk git diff --check
```

Expected: every command exits 0; Vitest reports zero failed tests.

- [ ] **Step 3: Review the surgical delta**

Run:

```bash
rtk git diff --stat
rtk git diff -- src/worker/services/pdf.ts test/worker/pdf.test.ts
rtk git status --short --branch
```

Expected: only the plan, PDF renderer, and PDF tests are changed after the already-committed design specification.

- [ ] **Step 4: Commit the implementation**

```bash
rtk git add docs/superpowers/plans/2026-07-10-dte-pdf-party-uppercase.md src/worker/services/pdf.ts test/worker/pdf.test.ts
rtk git commit -m "fix: uppercase DTE PDF party values"
```
