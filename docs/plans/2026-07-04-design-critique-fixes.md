# Design Critique Fixes — DiezmosSV Admin UI

## Context

A full design critique of the admin panel (all views, dialogs, wizard, mobile) found issues in five areas: date-format inconsistency, test values pre-filled into a legal document form, keyboard accessibility, mobile navigation, and view differentiation/visual consistency. This plan implements every finding. The app is a React SPA in `src/client/` (App.tsx holds all components; plain CSS in `src/client/styles.css`) served by a Cloudflare Worker in `src/worker/`. Tests run with `npx vitest run`; build with `npm run build`.

## Global Constraints

- All UI copy in Spanish, **usted** voice; the product term is "CDE"/"comprobante" (never introduce new English strings).
- Dates shown to users MUST use locale `es-SV` and timeZone `America/El_Salvador` (format dd/mm/yyyy). Never a bare `toLocaleDateString()`/`toLocaleString()`.
- Full suite green: `npx vitest run` (currently 126 passed, 1 skipped) and `npm run build` exit 0 (vite build + worker tsc).
- No new npm dependencies. Follow existing patterns: components live in App.tsx; styling in styles.css with plain CSS; "source-contract" tests that read App.tsx source are an accepted pattern (see test/client/quickDteUi.test.ts).
- TDD: write or update the failing test first where the change is testable; visual-only CSS changes are verified by build + existing suite.
- Focus ring color: `#007c75`, 2px solid, offset 2px (matches `.user-row:focus-visible` already in styles.css).
- One commit per task, message ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Task 1: Unify user-facing dates to es-SV

Two different date formats currently appear on the same screen: the documents table renders `new Date(document.created_at).toLocaleDateString()` (browser locale → "7/4/2026") while the invalidation panel shows "14/08/2026" via `formatElSalvadorDateTime`. The audit table uses bare `toLocaleString()`.

1. In `src/shared/legalWindows.ts`, next to the existing `formatElSalvadorDateTime`, add:
   ```ts
   export function formatElSalvadorDate(iso: string): string
   ```
   returning `dd/mm/yyyy` for the El Salvador local date of `iso` (use `Intl.DateTimeFormat("es-SV", { timeZone: "America/El_Salvador", day: "2-digit", month: "2-digit", year: "numeric" })`).
2. New test file `test/client/formatDates.test.ts` (TDD — write first):
   - `formatElSalvadorDate("2026-07-05T02:30:00.000Z")` → `"04/07/2026"` (UTC July 5 02:30 is July 4 in El Salvador, UTC-6).
   - `formatElSalvadorDate("2026-12-25T18:00:00.000Z")` → `"25/12/2026"`.
3. In `src/client/App.tsx` replace every bare browser-locale call with the shared helpers:
   - DocumentTable FECHA cell: `new Date(document.created_at).toLocaleDateString()` → `formatElSalvadorDate(document.created_at)` (~line 2856).
   - AuditTable FECHA cell: `new Date(row.created_at).toLocaleString()` → `formatElSalvadorDateTime(row.created_at)` (~line 3099).
   - Grep App.tsx for any other `toLocaleDateString(` / `toLocaleString(` occurrences and convert them the same way (there is at least one more in the contingency panel's pending-documents table).
4. `formatElSalvadorDateTime` is already imported in App.tsx via `./invalidationWindow` re-export or direct import — check and import both helpers from `../shared/legalWindows` consistently.

Acceptance: no `toLocaleDateString(` or bare `toLocaleString(` remain in src/client; new tests pass; full suite green.

## Task 2: Remove test-value defaults from the advanced CDE wizard

`defaultAdvancedCdeForm` in App.tsx pre-fills `direccionComplemento: "Dirección de prueba"` (~line 3578) and `descripcion: "Donación de prueba"` (~line 3583), and the build path has a fallback `descripcion: cleanText(form.descripcion) || "Donación de prueba"` (~line 3687). An operator who skips those steps can transmit a signed legal document containing "Donación de prueba".

1. TDD: add a test (new `test/client/advancedForm.test.ts` or extend an existing client test) asserting the App.tsx source no longer contains the strings `"Dirección de prueba"` or `"Donación de prueba"` (source-contract pattern), plus keep/verify that `validateAdvancedCdeForm` rejects an empty `descripcion` and empty `direccionComplemento` (they are already in the required-fields list ~lines 3734-3739 — if `validateAdvancedCdeForm` is not exported, export it for the test).
2. Change both defaults to `""` and delete the `|| "Donación de prueba"` fallback (validation makes it unreachable).
3. Give the two fields helpful `placeholder` text instead: descripcion → `"Ej.: Donación en efectivo"`, complemento → `"Calle, número, colonia…"` (find the inputs in the AdvancedDteModal sections).
4. Investigate `src/worker/domain/dteBuilder.ts` (`buildDirectCdeDocument` and the advanced-template path) and `advancedFormFromDraft` in App.tsx for any other `prueba` strings that could reach a real document; replace with neutral values (e.g. quick-DTE description may legitimately default to `"Donación monetaria"` — but nothing may say "prueba"). Update any worker tests that assert the old strings.

Acceptance: no user-visible "de prueba" default can reach a generated document; suite green.

## Task 3: Keyboard accessibility pass

Only 2 `:focus-visible` rules exist; the global input rule strips `outline: 0` from all form fields and selects; modals ignore Escape and never move focus; the toast has no live region; several forms use placeholder-as-label.

1. **Focus ring** (styles.css): add a global rule
   ```css
   input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible {
     outline: 2px solid #007c75;
     outline-offset: 2px;
   }
   ```
   Place it AFTER the reset rules that set `outline: 0` so it wins the cascade.
2. **Toast**: the toast button in App.tsx (~line 914) gets `role="status"` and `aria-live="polite"`.
3. **Dialogs**: implement one reusable hook in App.tsx:
   ```ts
   function useDialogDismiss(ref: React.RefObject<HTMLElement | null>, onDismiss: () => void, disabled: boolean)
   ```
   Behavior: on mount, focus the dialog container (give it `tabIndex={-1}`); listen for `keydown` — `Escape` calls `onDismiss()` unless `disabled`; `Tab`/`Shift+Tab` wraps focus within the dialog's focusable elements. Wire it into: `InvalidationConfirmDialog` (onCancel, disabled=busy), the emission-environment confirm dialog (~line 2238), `AdvancedDteModal` (onClose), and the user-settings modal (`user-settings-title`).
4. **Labels**: inputs whose only label is a placeholder get `aria-label` equal to their placeholder text: the 6 quick-DTE fields (TestDtePanel), the login/reset fields (AuthScreen), the user-create row (Usuarios), and the document search input. The catalog select in TestDtePanel gets `aria-label="Tipo de documento del donante"`.
5. TDD where testable: source-contract test `test/client/a11y.test.ts` asserting App.tsx contains `role="status"`, `aria-live="polite"`, `useDialogDismiss` wired in the four dialogs (e.g. the string `useDialogDismiss(` appears ≥4 times), and `aria-label` on the quick-DTE Monto input; and styles.css contains the `:focus-visible` outline rule.

Acceptance: tabbing through login and quick-DTE shows a visible ring (manual check by controller); Escape closes each dialog; suite green.

## Task 4: Mobile navigation and header

On a 375px viewport the active nav tab can sit entirely off-screen (no scroll-into-view, no overflow affordance), and the mobile header stacks a full-width contingency chip above an orphaned logout button.

1. In App.tsx, add an effect that runs when `view` changes:
   ```ts
   useEffect(() => {
     document.querySelector("nav button.active")?.scrollIntoView({ block: "nearest", inline: "center" });
   }, [view]);
   ```
   (Guard for jsdom/test environments: `?.scrollIntoView?.(...)` — scrollIntoView may be undefined.)
2. In styles.css, inside the existing mobile media query (the one that turns the sidebar into a horizontal tab bar):
   - Add an overflow affordance to the nav: `mask-image: linear-gradient(to right, black 92%, transparent)` on the scrollable nav container (or a right-edge fade via ::after gradient — either is fine, pick what fits the existing structure).
   - Make the header controls row compact: the contingency chip and the logout icon-button sit on ONE row (chip takes remaining width, logout stays 36px), instead of stacking full-width chip above a lone button.
3. No unit tests possible for scroll behavior; ensure suite + build stay green. The controller verifies visually at 375px after review.

Acceptance: at 375px, activating "Credenciales" leaves the active tab visible; header uses one row for chip + logout; build green.

## Task 5: Differentiate the Fallos view and per-view subtitles

Fallos currently reuses the generic subtitle, renders four stat cards (three definitionally zero), and shows a disabled filter reading "Todos" while actually filtering FAILED.

1. Export `viewSubtitle` from App.tsx and give unique subtitles (TDD: new `test/client/viewText.test.ts` asserting each):
   - failures → `"CDE con errores o rechazos que requieren su atención."`
   - audit → `"Historial de todas las acciones realizadas en el panel."`
   - users → `"Cree cuentas y asigne roles de acceso al panel."`
   - documents/contingency/credentials/exports keep their current strings (assert they are non-empty and distinct).
2. In the documents/failures shared layout (App.tsx ~line 702+), when `view === "failures"`:
   - Do NOT render the status `<select>` at all (currently rendered disabled showing "Todos").
   - Render ONLY the "Fallidos" metric card (skip Aceptados/Contingencia/Invalidados).
   - When the failures list is empty and the search query is blank, the list-footer message reads `"Sin fallos pendientes. Todo en orden."` (keep the current "No hay CDE que coincidan con la búsqueda o el filtro." when a search query is active).
3. Extract the footer-message decision into a pure exported function so it can be unit-tested:
   ```ts
   export function documentListEmptyMessage(view: "documents" | "failures", query: string): string
   ```
   with tests for the three cases.

Acceptance: Fallos shows one metric, no filter select, reassuring empty state; unique subtitles; suite green.

## Task 6: Visual consistency pack

1. **Numeric alignment**: MONTO cells already have `class="numeric"`; add `th` class `numeric` to the MONTO header in DocumentTable, the contingency pending-docs table, and the F960 preview table. In styles.css add `td.numeric, th.numeric { text-align: right; }` (keep the existing `font-variant-numeric: tabular-nums`).
2. **Table headers**: update the `th` rule in styles.css to `font-size: 12px; letter-spacing: 0.04em;` (keep uppercase and color).
3. **Stats cards**: change the four Metric labels from "Aceptados en esta vista" etc. back to single words ("Aceptados", "Fallidos", "Contingencia", "Invalidados") and render ONE muted caption line above the cards row: `<p class="stats-caption">Totales de la vista actual.</p>` (add a small CSS rule: 12px, color #61737a, margin 0 0 6px). This kills the 3-line label wrap.
4. **JSON preview**: in DetailPanel, wrap the `<pre>` (and its "JSON DTE" heading block) in `<details className="json-details">` with `<summary>Ver JSON completo</summary>`, default closed. Style the summary like the existing muted small text, cursor pointer.
5. **Nav rename**: in `navItems`, change label `"Credenciales"` → `"Configuración"` (id stays `"credentials"`). The page `<h1>` derives from the label, so it will read Configuración; keep the existing subtitle text.
6. Update any tests that assert the old strings (grep test/ for "en esta vista", "Credenciales" nav label — note test/client/credentialSettings.test.ts covers section data, not the nav label).

Acceptance: MONTO right-aligned under right-aligned header; single-word stat labels with one caption; JSON collapsed by default; nav reads Configuración; suite + build green.

## Task 7: Advanced wizard flow fixes

Two frictions: (a) "CDE avanzado" refuses to open until the quick form has name + document — but wizard step 1 edits those same fields; (b) the primary CTA "Generar avanzado" is enabled on all five steps, competing with "Siguiente".

1. **Open without pre-validation**: in `openAdvancedDte` (App.tsx ~line 317), remove the `quickDteValidationMessage(testInput, { requireAmount: false })` gate. Then check the worker endpoint `POST /api/test/dte/advanced-template` (src/worker/index.ts ~line 285): if it rejects empty donor name/document, relax THE TEMPLATE ENDPOINT ONLY to accept empty donor fields (producing a draft with empty receptor name/document) — final generation via `POST /api/test/dte/advanced` must keep full schema validation. Add/adjust a worker test: advanced-template with `{ amount: "", donorName: "", donorDocumentType: "13", donorDocument: "", donorEmail: "", donorPhone: "" }` returns 200 with a draft.
2. **CTA on review step only**: in AdvancedDteModal, render the "Generar avanzado" button ONLY when the current step is the last (Revisión) step. "Siguiente" disappears on the last step (already the case — it becomes disabled; keep whichever exists but ensure exactly one primary action is visible on each step).
3. Update the client source-contract test if any asserts the old always-visible button, and run the full suite.

Acceptance: wizard opens from an empty quick form; a draft loads; Generar avanzado appears only on Revisión; final generation still validates fully; suite green.
