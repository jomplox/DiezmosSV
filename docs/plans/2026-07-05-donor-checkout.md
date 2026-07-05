# Donor Checkout — own the donor form, Wompi owns the card form

## Context

Real Wompi payment-link webhooks carry at best a free-text `Cliente.Direccion` and an unvalidated
`DocumentoIdentidad`; they can never provide the CAT-012/013/008 catalog codes MH wants on the
receptor, and DUI typos surface only after payment. Today the pipeline compensates with fallbacks
("SIN-DOCUMENTO", "No proporcionada por el donante") that MH accepts but that leave the CDE with
declared-unknown donor data.

This plan inverts the data flow: a public donation page on our worker collects and validates the
donor's data BEFORE payment, stores it as a **donation intent**, then creates a single-use Wompi
payment link via their API (`identificadorEnlaceComercio` = intent id) and sends the donor to
Wompi's hosted card page. Card data never touches our code (PCI stays with Wompi). When the webhook
arrives, `IdExterno` correlates it back to the intent and the CDE is built from our validated data;
webhooks with no matching intent keep today's fallback behavior unchanged.

Confirmed against https://docs.wompi.sv (2026-07-05):
- Auth: OAuth2 client credentials — POST `https://id.wompi.sv/connect/token`, form-encoded
  `grant_type=client_credentials`, `audience=wompi_api`, `client_id`, `client_secret` →
  `{ access_token, expires_in: 3600, token_type: "Bearer" }`; sent as `authorization: Bearer …`.
- Link creation: POST `https://api.wompi.sv/EnlacePago` with `identificadorEnlaceComercio`
  (≤500 chars, echoed in webhook as `IdExterno` / `EnlacePago.IdentificadorEnlaceComercio` —
  verified against real webhook payloads received today), `monto` (min 0.01), `nombreProducto`,
  optional `EnlaceLimitesDeUso.cantidadMaximaPagosExitosos` (single-use = 1),
  `EnlaceVigencia.fechaInicio/fechaFin`, redirect URL (per link) and `EnlaceConfiguracion.urlWebhook`.
  Response: `{ idEnlace, urlEnlace, urlQrCodeEnlace, estaProductivo }`.
- Redirect back: Wompi appends `identificadorEnlaceComercio`, `idTransaccion`, `idEnlace`, `monto`,
  `hash` (HMAC over the parameters) to the configured redirect URL.
- Embedded widget (verified empirically 2026-07-05 in a live browser): including
  `<script src="https://pagos.wompi.sv/js/wompi.pagos.js">` and a
  `<div class="wompi_button_widget" data-url-pago="<link URL>&esWidget=1" data-render="widget">`
  renders a "Pagar con Wompi" button; clicking it opens the payment flow in an IFRAME MODAL with a
  dimmed backdrop ON THE SAME PAGE — no navigation, no popup. The donor never leaves our page.
  Unverified until the finale: whether the `urlEnlace` returned by the EnlacePago API is accepted
  as `data-url-pago` (the panel-generated snippet uses the
  `pagos.wompi.sv/IntentoPago/Redirect?id=…&esWidget=1` form). The full-page redirect flow is the
  guaranteed fallback either way.

## Global Constraints

- Spanish usted-form copy everywhere donor- or operator-facing; "CDE"/"comprobante" terminology.
- TDD with RED/GREEN evidence per task; source-contract tests (reading App.tsx/styles.css source)
  are an accepted repo pattern for UI assertions; worker tests use the InMemoryD1 fake in
  test/worker/workerFetch.test.ts (add SQL branches there as needed).
- NEVER collect, transmit, log, or store card numbers, CVV, or expiry — the donor page hands off to
  Wompi's hosted `urlEnlace` for all card entry. No exceptions.
- No real credentials in the repo. New secrets (`WOMPI_CLIENT_ID`, `WOMPI_CLIENT_SECRET`) are set
  via `wrangler secret put`; `.dev.vars.example` and `.dev.vars.ci` get throwaway demo values only.
- Mock mode (`MOCK_EXTERNAL_SERVICES === "true"`): the Wompi API client returns a deterministic
  fake `urlEnlace` (e.g. `https://mock.wompi.sv/enlace/<intentId>`) without network calls, so local
  dev, vitest, and the Playwright E2E work offline.
- The public endpoints are unauthenticated: every input is re-validated server-side (DUI check
  digit via `isValidDui`, catalog validity via the CAT-012/013/008 helpers, amount bounds) and
  rate-limited using the existing audit-count throttle pattern (`countAuditEntriesSince`), keyed on
  `cf-connecting-ip`, mirroring the login throttle (PP Task 1).
- Reuse `src/shared` modules in the client bundle (`isValidDui`, `formatDui`, catalog lists and
  the department-filtered helpers already in `src/shared/catalogs.ts`) — do not duplicate them.
- Existing fallback behavior for un-correlated webhooks must remain byte-for-byte intact: the
  no-intent path is the compatibility guarantee for the current static payment link.

## Task 1: Donation intents storage + Wompi API client

**Objective:** the worker can persist a validated donation intent and mint a single-use Wompi
payment link for it.

- Migration `migrations/0009_donation_intents.sql`: table `donation_intents`
  (`id` TEXT PK — format `di_<uuid>`, `status` TEXT: PENDING | LINK_CREATED | COMPLETED | EXPIRED,
  `amount_cents` INTEGER, `donor_name`, `donor_document_type` ("13"/"37"), `donor_document`,
  `donor_email`, `donor_phone` nullable, `direccion_departamento`, `direccion_municipio`,
  `direccion_distrito`, `direccion_complemento`, `wompi_id_enlace` INTEGER nullable,
  `wompi_url_enlace` TEXT nullable, `client_ip` TEXT nullable, `created_at`, `updated_at`,
  `expires_at` TEXT). Index on (`status`, `expires_at`) and on `created_at`.
- Repository methods: `createDonationIntent`, `getDonationIntent`, `attachIntentLink`,
  `markIntentCompleted`, `expirePendingIntentsBefore(nowIso)` (bulk UPDATE → EXPIRED),
  `countRecentIntentsByIp` (or reuse audit-count throttle — implementer's choice, but the throttle
  decision must be tested).
- `src/worker/services/wompiApi.ts`: `WompiApiService` with `createPaymentLink(intent)`.
  Token via `id.wompi.sv/connect/token` (no caching in v1 — one token per link creation is fine at
  donation frequency; note this as a comment). Link body: `identificadorEnlaceComercio` = intent id,
  `monto` from integer cents, `nombreProducto` = "Donación <nombreComercial>",
  single-use (`cantidadMaximaPagosExitosos: 1`), `EnlaceVigencia` now → now + 1 hour (El Salvador
  time helpers exist in `src/shared/legalWindows.ts`), redirect URL
  `${APP_ORIGIN}/donar/gracias`, and `urlWebhook` = `${APP_ORIGIN}/webhooks/wompi`.
  Mock mode short-circuits before any fetch. Non-2xx → typed error with response text (never log
  secrets). Tests: fetch-mocked token + link creation (assert exact form fields and Bearer header),
  mock-mode determinism, non-2xx propagation.
- Config: `WOMPI_CLIENT_ID` / `WOMPI_CLIENT_SECRET` via `requireSecret`; add commented entries to
  `.dev.vars.example` and demo values to `.dev.vars.ci`.

**Verification:** vitest RED→GREEN for repository + service; `npx vitest run` green; migration
applies to a fresh local D1.

## Task 2: Public API endpoints

**Objective:** unauthenticated JSON endpoints the donor page uses, safe against abuse.

- `POST /api/donations/intent` (no auth): body {amount, donorName, donorDocumentType,
  donorDocument, donorEmail, donorPhone?, departamento, municipio, distrito, complemento}.
  Server-side validation, each with its own Spanish error: amount integer-cents 100..500000
  ($1.00–$5,000.00); donorName non-empty ≤200; if type "13" → `isValidDui` (reject with
  "DUI inválido: revise el número y el dígito verificador."), stored canonically via `formatDui`;
  if type "37" → free document ≤50 chars; email RFC-trivial + ≤200; departamento/municipio/distrito
  must satisfy the existing catalog validators INCLUDING the department-scoped variants;
  complemento non-empty ≤300. On success: create intent (PENDING), call `WompiApiService`, attach
  link (LINK_CREATED), return `{ intentId, urlEnlace }`. Wompi API failure → 502
  `{ error: "wompi_link_failed" }` with usted-form message; intent stays PENDING (harmless, expires).
- Rate limit: max 5 intent creations per IP per 15 minutes → 429 `too_many_attempts` (mirror the
  login-throttle test shape). Audit `DONATION_INTENT_CREATED` (entityId = intent id, metadata
  without donor document number — log only its type).
- `GET /api/donations/catalogs` (no auth): departamentos + municipios + distritos (code, label,
  departmentCode) so the SPA needn't bundle the full catalog file if the implementer measures it
  as heavy; if bundling via `src/shared` import is lighter, skip this endpoint and document why.
- `GET /api/donations/intent/:id/status` (no auth): returns `{ status }` ONLY — never donor data.
  Intent ids are unguessable (`di_<uuid>`), and the response must stay enumeration-safe: unknown id
  → 404 with the same shape/timing as a known-but-foreign id would get. This powers the donation
  page's post-payment polling (Task 4).
- Expiry: hook `expirePendingIntentsBefore` into the existing 15-minute cron branch (alongside the
  stalled-event sweep) — intents past `expires_at` in PENDING/LINK_CREATED become EXPIRED.
- Worker tests in workerFetch.test.ts: happy path (mock mode), each validation rejection, throttle
  429, Wompi failure 502, cron expiry.

**Verification:** vitest RED→GREEN; full suite green.

## Task 3: Pipeline correlation — build the CDE from the intent

**Objective:** webhooks that match an intent produce a CDE with the donor's validated data;
everything else behaves exactly as today.

- In `processWompiEvent` (src/worker/services/pipeline.ts): resolve the intent by
  `payload.IdExterno ?? payload.EnlacePago?.IdentificadorEnlaceComercio` matching an intent id in
  status LINK_CREATED (also accept EXPIRED — a donor can pay in the last minute of the link's
  vigencia after our cron expired the intent; completed intents must NOT match twice).
- New builder entry `buildCdeDocumentFromIntent(payload, intent, config, options)` OR an options
  extension `buildCdeDocument(payload, config, { …, donorOverride })` (implementer's choice —
  favor whichever keeps `buildCdeDocument`'s existing signature untouched for current callers):
  receptor.tipoDocumento/numDocumento from the intent (canonical DUI already stored),
  nombre/correo/telefono from the intent, and dirección with the INTENT's departamento/municipio/
  distrito/complemento — this is the payoff: real catalog codes, donor-chosen.
  Amount check: if intent.amount_cents ≠ webhook amount_cents, log audit
  `DONATION_INTENT_AMOUNT_MISMATCH` and prefer the WEBHOOK amount (money truth comes from Wompi);
  still correlate.
- On acceptance: `markIntentCompleted(intent.id, documentId)`; audit `DONATION_INTENT_COMPLETED`.
- No intent match → existing behavior with zero diff (assert by keeping every current pipeline test
  green untouched).
- Tests: correlation happy path (receptor equals intent data, catalog codes intact), expired-intent
  still correlates, completed-intent does not correlate twice, amount mismatch audited + webhook
  amount wins, no-intent fallback unchanged.

**Verification:** vitest RED→GREEN; full suite green.

## Task 4: Public donation page + thank-you page

**Objective:** the donor-facing UI, in the existing SPA bundle, no auth required.

- Routes in the SPA: `/donar` (form) and `/donar/gracias` (post-payment landing). App.tsx already
  branches on path for the reset-password flow — follow that pattern; these views render WITHOUT a
  session and must not trigger the auth bootstrap/login redirect.
- `/donar` form: nombre completo; tipo de documento (DUI | Otro); número (on DUI: inline
  check-digit validation on blur via `isValidDui`, auto-format with `formatDui`, error
  "Revise el número de DUI."); correo; teléfono (opcional); departamento → municipio → distrito as
  CASCADING selects driven by the `src/shared/catalogs.ts` helpers (changing departamento resets
  the dependent selects); dirección (complemento) textarea; monto with quick-amount chips
  ($5 / $10 / $25 / $50 / custom input, min $1). Disable the submit button while in flight
  ("Preparando el pago…"). All errors inline, usted-form.
- Payment handoff, widget-first with redirect fallback:
  1. Load `https://pagos.wompi.sv/js/wompi.pagos.js` on the `/donar` view only (dynamic script
     injection when the view mounts; NEVER on the admin views).
  2. On intent success, render the `wompi_button_widget` div with `data-url-pago` =
     `urlEnlace` + `&esWidget=1` and `data-render="widget"` — clicking opens Wompi's iframe modal
     on the same page (verified behavior; card data stays inside Wompi's iframe, never in our DOM).
  3. While the modal is open, poll `GET /api/donations/intent/:id/status` every ~5s; when the
     webhook flips the intent to COMPLETED, swap the view in place to the thank-you state
     ("Su donación fue recibida. Recibirá su comprobante (CDE) por correo cuando el Ministerio de
     Hacienda lo confirme.") — webhook-driven truth, independent of the widget's internals.
  4. Fallback: if the Wompi script fails to load, or the widget doesn't render within a short
     timeout, use `window.location.href = urlEnlace` (the full-page hosted flow). This fallback is
     mandatory and tested — it is also the launch behavior if the finale discovers API-created
     links don't work in the widget.
- `/donar/gracias`: landing for the redirect fallback (and Wompi's per-link redirect). Reads
  `identificadorEnlaceComercio`, `idTransaccion`, `monto` from the query string (display only — NO
  trust decisions from these parameters; the `hash` parameter is not verified in v1 and nothing
  security-relevant may depend on this page). Same thank-you copy; if it detects it is running
  inside an iframe (widget modal), postMessage the parent so `/donar` can close the modal and show
  the thank-you state directly.
- Branding consistent with the admin login screen's existing styles; mobile-first (this page is
  the one donors open on phones).
- Tests: source-contract tests (new file test/client/donarPage.test.ts) asserting labels, the
  cascading-select wiring, DUI validation hook, quick-amount chips, and that `/donar` renders
  without a session; plus a Playwright E2E scenario in e2e/ (mock mode returns the deterministic
  mock urlEnlace — assert the form submits and the app attempts navigation to it, then load
  `/donar/gracias?monto=1.00&idTransaccion=TEST` and assert the thank-you copy).

**Verification:** vitest + `npx playwright test` green locally; build green.

## Task 5: Admin visibility + docs

**Objective:** operators can see intents; documentation matches reality.

- Admin "Donaciones en línea" card (Exportar view or its own small view — implementer judgment,
  consistent with existing panels): last 50 intents with estado, monto, donante, fecha, and for
  COMPLETED the linked CDE numero de control. Spanish table headers; empty state
  "Sin donaciones en línea todavía.".
- Document detail: when a document's intent exists, show "Datos del donante verificados en el
  formulario de donación" badge (source visibility for the operator).
- README + docs/runbook-operador.md: new section — how the donation page works, the two new
  secrets, how to obtain client_id/client_secret from the Wompi panel, the correlation model, what
  EXPIRED/PENDING intents mean, and the go-live note that the static payment link keeps working.
- Tests: source-contract for the new admin card; runbook labels verbatim.

**Verification:** full suite + build green.

## Controller finale

- Personal review of every task diff (same modus operandi as PLAN 3).
- Apply migration 0009 to local + staging D1; set staging secrets `WOMPI_CLIENT_ID` /
  `WOMPI_CLIENT_SECRET` (values provided by José from the Wompi panel — controller must ASK, never
  invent); deploy staging.
- Live verification on staging: open `/donar`, fill real data with a $1.00 amount, complete payment
  in the widget modal (verify the API-created `urlEnlace` renders in the widget; if it does not,
  confirm the redirect fallback engages cleanly and record the finding), verify webhook → intent
  correlation → CDE ACEPTADO with the intent's receptor (catalog codes + canonical DUI), donor
  email, intent COMPLETED with the page flipping to the thank-you state, admin card shows it.
- Verify the legacy path: one payment through the OLD static link still emits with fallbacks.
- Push, CI green, PR to main, merge. Production deploy for parity (secrets remain go-live items).
