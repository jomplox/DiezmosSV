# DTE PDF Party Uppercase Design

**Date:** 2026-07-10

**Status:** Approved in conversation; pending review of this written specification.

## Objective

Apply a presentation-only consistency rule to regenerated DTE PDFs:

- display every EMISOR and RECEPTOR value in uppercase;
- preserve each email address exactly as stored;
- stop displaying the issuer's internal `codEstable` value;
- leave stored DTE JSON, MH payloads, database rows, and user-entered values unchanged.

The rule applies to both newly issued and historical DTEs whenever `renderDtePdf` regenerates their PDF.

## Current source of the circled value

The circled `0002` is `emisor.codEstable`. DTE construction copies it from `EMISOR_CONFIG_JSON.codEstable`, which operators edit under **Credenciales -> Emisor -> Código establecimiento interno**. The PDF currently appends it to the establishment name in `emisorLines`.

It is not the MH establishment code (`codEstableMH`), the MH point-of-sale code (`codPuntoVentaMH`), or the `M001P004` control-number prefix. `codEstable` remains an internal configuration and legal-data field but will no longer be visible in the PDF.

## Considered approaches

### 1. Normalize values only at PDF rendering boundaries - selected

Use the existing `safeUpper` helper at the exact points where party values enter the PDF. Construct contact lines from separately normalized address/contact fragments so emails bypass uppercase conversion. Remove `codEstable` only from the issuer display line.

This is the smallest change, preserves source data, and automatically covers historical PDFs when regenerated.

### 2. Build a separate normalized PDF party view model

Convert each `Party` into a second presentation model before drawing. This centralizes formatting but adds an abstraction for one renderer without improving the required behavior.

### 3. Normalize input or DTE JSON

Uppercase values when users enter them or when the DTE is built. This was rejected because it changes stored and MH-transmitted data rather than merely controlling PDF presentation.

## Rendering contract

Static labels retain their current typography. Values follow this matrix:

| PDF value | Rendering rule |
|---|---|
| Legal/commercial names | Uppercase |
| Economic activity | Uppercase |
| Address complement | Uppercase |
| District, municipality, department, and country labels | Uppercase |
| Foreign address from `apendice` | Uppercase |
| Email address | Preserve exactly as stored |
| Telephone and fiscal identifiers | Preserve formatting; alphabetic characters, if any, render uppercase |
| `emisor.codEstable` | Do not render |

The issuer contact line remains conceptually:

```text
• <UPPERCASE ESTABLISHMENT NAME> / Correo: <unchanged email>
```

The receptor contact line remains conceptually:

```text
<UPPERCASE ADDRESS> / Tel.: <value> / Correo: <unchanged email>
```

Uppercase conversion occurs before text wrapping, because uppercase glyph widths can change line breaks. Existing clamping and PDF-safe Unicode replacement remain unchanged.

## Implementation boundary

Only `src/worker/services/pdf.ts` changes in production code:

- `drawPartyBox` uppercases its non-email scalar values: name, activity, NRC, and document number;
- `emisorLines` omits the `codEstable` suffix and uppercases the establishment/address fragments independently from email;
- `receptorContactLine` uppercases the address fragment independently from email;
- foreign and catalog-derived geographic values pass through the same display rule.

No configuration UI, DTE builder, repository, migration, or API response changes.

## Verification strategy

`test/worker/pdf.test.ts` will first receive a failing regression using deliberately mixed-case issuer and receptor data. Extracted PDF text must prove:

- all non-email values in both party boxes are uppercase;
- the original-case email addresses remain present;
- lowercase variants of those non-email values are absent;
- `(0002)` is absent;
- `record.plain_json` remains byte-for-byte unchanged after rendering.

After the focused test turns green, run the full PDF test file, typecheck, and full repository tests. Generate a representative PDF under `tmp/pdfs/`, render its first page to PNG with Poppler, and visually inspect both boxes for clipping, overlap, or undesirable wrapping introduced by uppercase text.

## Non-goals

- Changing how values are stored or transmitted to MH.
- Removing `codEstable` from internal configuration or legal JSON.
- Uppercasing email addresses.
- Changing labels, typography, box dimensions, or unrelated PDF sections.
