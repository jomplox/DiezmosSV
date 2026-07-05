# Operational Survival Kit — Retention, Alerting, Certificate Expiry

## Context

DiezmosSV is approaching production (MH authorization filed; staging UAT complete; CI and queue dead-lettering in place as of `a85a702`). Three operational gaps remain that only hurt after go-live, when fixing them is hardest:

1. **Legal retention**: D1 Time Travel restores at most 30 days back, but Salvadoran tax documents (Código Tributario art. 147) must be preserved for years. Today a Cloudflare account mishap could destroy every legal record.
2. **Alerting is pull-based**: failures land in the Fallos tab and audit log, which someone must remember to open. A failed emission, an opened contingency, a dead-lettered message, or a stalled Wompi event should reach the admin's inbox unprompted.
3. **Certificate expiry is invisible**: MH signing certificates expire (typically annually). Nothing parses or surfaces the expiry date; the first symptom would be every emission failing with a signing error on renewal day.

All three build on infrastructure that already exists: the cron `scheduled()` handler, the `EmailService` (with HTML rendering via `emailHtml.ts`), the audit log, the credentials status panel, and the settings storage (`app_settings`).

## Global Constraints

- Spanish (usted) for all user-facing copy; the existing HTML email frame (`emailHtml.ts`) wraps any new email.
- No new npm dependencies. R2 via native binding; certificate parsing via WebCrypto/manual X.509 field extraction (see Task 3 notes) — no ASN.1 library.
- All tests green (`npx vitest run`, currently 159 passed + 1 skipped) and `npm run build` exit 0. TDD with RED evidence for every behavioral change; source-contract tests acceptable for wrangler.toml/UI wiring (existing pattern).
- New cron work must not break the existing 15-minute cadence; long-running exports must respect Workers CPU limits (streaming/chunked reads, no full-table in-memory JSON).
- Every new scheduled job follows the sweep pattern: independent try/catch so one failing job never blocks the others; every action leaves an audit entry; repeated runs are idempotent (audit-dedupe or state checks, as in `sweepStalledWompiEvents`).
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## Task 1: Monthly legal-retention export to R2

**Goal**: every month, write an immutable snapshot of all legal records to an R2 bucket, so documents survive D1 loss, account compromise of the DB alone, or bad migrations — for the multi-year horizon tax law requires.

1. **Infrastructure** (wrangler.toml + one-time CLI):
   - Add an R2 bucket binding `ARCHIVE` per environment: local `diezmossv-local-archive-example` (miniflare simulates), staging `diezmossv-staging-archive-example`, production `diezmossv-production-archive-example`. Create the staging bucket via `npx wrangler r2 bucket create diezmossv-staging-archive-example` at deploy time (production bucket created during prod provisioning).
   - Add a second cron expression `"0 9 1 * *"` (1st of each month, 09:00 UTC = 03:00 El Salvador) to `[triggers]` in all three env blocks. The `scheduled()` handler receives `event.cron` and dispatches: `"*/15 * * * *"` → existing sweeps; `"0 9 1 * *"` → `runRetentionExport()`.
   - Env type: `ARCHIVE: R2Bucket` (required in `Env`; tests fake it with an in-memory `put` recorder).
2. **Export service** (`src/worker/services/retention.ts`):
   - `runRetentionExport(env, now)` exports the **previous calendar month** (El Salvador time) for tables: `dte_documents`, `dte_events`, `email_deliveries`, `wompi_events`, `audit_logs`, filtered by `created_at` in the month window; plus a **full snapshot** of `contingency_periods`/`contingency_batches`/`contingency_batch_lines` (small tables, simpler than windowing).
   - Format: NDJSON (one JSON row per line), one object per table, keys `retention/<YYYY>/<YYYY-MM>/<table>.ndjson`. Read in pages of 500 rows (`LIMIT/OFFSET` or keyset on `created_at,id`) and accumulate into the object body to stay within memory limits; row counts per table recorded.
   - Write a manifest last: `retention/<YYYY>/<YYYY-MM>/manifest.json` with per-table row counts and SHA-256 of each object body (compute with the existing `sha256Hex` util while accumulating). The manifest existing = export complete (idempotency marker: if the manifest already exists via `ARCHIVE.head()`, skip and audit `RETENTION_EXPORT_SKIPPED` — makes cron retries and manual re-runs safe).
   - Audit entries: `RETENTION_EXPORT_COMPLETED` (summary: month + total rows) or `RETENTION_EXPORT_FAILED` (summary: error message). Failure must NOT throw out of `scheduled()` (same try/catch isolation as the sweeps).
3. **Manual trigger for verification**: `POST /api/admin/retention-export` (OWNER only) running the same function for a `?month=YYYY-MM` param — this is how staging gets verified without waiting for the 1st. Audit `RETENTION_EXPORT_REQUESTED` with the actor.
4. **Restore documentation**: add a short `docs/retention-restore.md`: how to list objects (`wrangler r2 object get`), verify manifest hashes, and re-import NDJSON into D1 if ever needed.
5. **Tests** (TDD): fake R2 (`put/head` recorder) + InMemoryD1 extensions; assert correct keys, NDJSON line counts, manifest hashes match bodies, month windowing (an event on the 1st of the current month is excluded), idempotent skip when manifest exists, audit entries for completed/skipped/failed, and cron dispatch by `event.cron`. Source-contract test on wrangler.toml for the ARCHIVE bindings + second cron in all env blocks.
6. **Display**: add the three audit action labels to `displayText.ts` (+ test).

## Task 2: Push alerting for the failure modes that matter

**Goal**: the admin learns about problems from their inbox, not from remembering to check a tab.

1. **Recipient configuration**: new app setting `alert_email` managed in the Configuración → Correo section (input + save, OWNER only, stored via the existing settings PUT pattern; empty = alerting disabled). Show a hint: "Recibirá avisos de fallos de emisión, contingencias y eventos estancados."
2. **Notification service** (`src/worker/services/alerts.ts`):
   - `sendOperationalAlert(env, repo, alert: { kind, title, detail, entityType, entityId })` — loads `alert_email`; if unset, no-op. Sends via `EmailService.dispatch`-style plain payload with an HTML body through a new `operationalAlertHtml()` in `emailHtml.ts` (red/amber banner by kind, detail paragraphs, deep link `https://<origin>/` note). Records `ALERT_SENT` / `ALERT_FAILED` audit entries. An alert failure must never break the flow that triggered it (try/catch inside the service).
   - **Dedupe/throttle**: before sending, skip if an `ALERT_SENT` audit entry exists for the same `entityId` + kind (reuse `countAuditEntries` with a compound action string like `ALERT_SENT:DTE_FAILED`) — one alert per entity per failure kind, no storms from the 15-minute cron.
3. **Wire the four triggers** (each is 2–4 lines at an existing site):
   - `DTE_FAILED` / `ADVANCED_CDE_FAILED` in `pipeline.ts` (after the FAILED status write).
   - Contingency period opened (both auto `moveToContingency` and manual open in `index.ts`).
   - `ISSUANCE_DEAD_LETTERED` in `handleDeadLetterBatch`.
   - `WOMPI_EVENT_STALLED` in `sweepStalledWompiEvents`.
4. **Tests** (TDD): alert sent with correct recipient/subject for each trigger (captured via the EMAIL mock, as in existing email tests); no-op when `alert_email` unset; dedupe suppresses the second alert for the same entity; alert failure doesn't fail the pipeline (EMAIL mock throws → document still FAILED, audit `ALERT_FAILED` present). displayText labels for the new audit actions.

## Task 3: Certificate expiry surfacing

**Goal**: the owner sees "el certificado vence en N días" long before emissions start failing.

1. **Parsing** (`src/worker/domain/signer.ts` or a sibling `certInfo.ts`): the MH certificate file is XML (already parsed by the signer for the private key). Investigate the actual XML structure first — MH cert files carry the public certificate with validity fields; extract the expiry (`notAfter`-equivalent). Two paths, in order of preference:
   a. If the XML exposes a validity/expiry element directly (common in MH's `.crt` XML), read it with the same string extraction approach the signer already uses.
   b. Otherwise decode the base64 X.509 DER and extract the second `UTCTime/GeneralizedTime` in the TBS validity sequence — a focused ~30-line parser, NOT a general ASN.1 library. Add fixture-based tests with the same generated-certificate helper the signer tests use (`generatedCertificateXml`), asserting the extracted date equals the generated cert's expiry.
   - Expose `certificateExpiry(env): { expiresAt: string | null }` — null (with an audit-safe "no legible" state) if parsing fails; never throw.
2. **Credentials panel**: `GET /api/credentials` response gains `certificateExpiresAt`. The Firmador section shows a status line: green "Vence el dd/mm/yyyy" (>60 days), amber "Vence en N días" (≤60), red "VENCIDO / vence en N días" (≤14 or past). Reuse `formatElSalvadorDate`.
3. **Cron reminder**: in the 15-minute cron... no — add to the monthly + a **daily check is overkill; piggyback on the existing 15-min cron with audit-dedupe**: when ≤30 days remain, send one `sendOperationalAlert` (kind `CERT_EXPIRING`) per threshold crossing (30/14/3 days) using the Task 2 dedupe keyed on `CERT_EXPIRING:<threshold>:<expiryDate>`. Depends on Task 2's alert service.
4. **Tests** (TDD): expiry extraction from the generated fixture cert; API field present; threshold-crossing alerts fire once each (fake timers around the cron); unreadable cert yields null + no crash; client source-contract test for the Firmador status line wiring.

## Task order and dependencies

Task 2 (alerts) first — smallest, and Task 3 depends on it. Then Task 1 (retention) — independent. Then Task 3. Each task is one commit + staging deploy; staging verification steps: trigger the manual retention export and check R2 objects + manifest; force a DTE failure in mock-off staging (bogus cert password on a quick DTE) and confirm the alert email arrives; confirm the Firmador panel shows the real cert's expiry.

## Verification (whole plan)

- `npx vitest run` green with all new tests; `npm run build` exit 0.
- Staging: monthly export objects exist and manifest hashes verify; alert email received for a forced failure; cert expiry visible in Configuración.
- No cron overrun: `wrangler tail` during a manual export run on staging shows completion without CPU-limit errors.
