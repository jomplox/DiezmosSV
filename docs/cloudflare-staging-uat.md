# Cloudflare TEST/Staging UAT

This runbook is for the deployed edge app, not local dev. Staging must use the real Worker, D1,
Queue, Cron, ASSETS binding, `MOCK_EXTERNAL_SERVICES=false`, and MH `ambiente=00` credentials.

## Preflight

1. Run local gates before touching Cloudflare:

   ```bash
   npm test
   npm run typecheck
   npm run build
   ```

2. Confirm Wrangler is authenticated:

   ```bash
   npm run cf:whoami
   ```

3. Create or verify the remote resources:

   ```bash
   npx wrangler d1 create diezmossv-staging-resource-example
   npx wrangler queues create diezmossv-staging-issuance-example
   ```

4. Put the returned D1 id in `wrangler.toml` under `[[env.staging.d1_databases]]`.

5. Set staging secrets. Do not commit these values:

   ```bash
   npx wrangler secret put WOMPI_API_SECRET --env staging
   npx wrangler secret put MH_CERT_PASSWORD --env staging
   npx wrangler secret put MH_CERT_XML_PART_1 --env staging
   npx wrangler secret put MH_CERT_XML_PART_2 --env staging
   npx wrangler secret put MH_USER_TEST --env staging
   npx wrangler secret put MH_PASSWORD_TEST --env staging
   npx wrangler secret put EMAIL_API_KEY --env staging
   npx wrangler secret put EMAIL_API_URL --env staging
   npx wrangler secret put EMAIL_FROM --env staging
   npx wrangler secret put EMISOR_CONFIG_JSON --env staging
   ```

   Local dev may keep the certificate in one `MH_CERT_XML` value. Cloudflare Workers limit each
   variable/secret to 5 KB, so staging and production should split larger MH certificate XML values
   across `MH_CERT_XML_PART_1` and `MH_CERT_XML_PART_2`.

6. Apply the schema and deploy:

   ```bash
   npm run cf:migrate:staging
   npm run cf:deploy:staging
   ```

## Edge Smoke Test

Capture the Worker URL from Wrangler after deploy.

The quickest repeatable smoke pass is:

```bash
STAGING_URL="https://YOUR_STAGING_WORKER_URL" \
STAGING_EMAIL="owner@example.org" \
STAGING_PASSWORD="..." \
WOMPI_API_SECRET="..." \
SMOKE_DONOR_DOCUMENT="..." \
SMOKE_DONOR_EMAIL="smoke@example.org" \
npm run smoke:staging
```

Useful flags:

```bash
# Bootstrap the first owner if the staging D1 database is empty.
STAGING_BOOTSTRAP=1 npm run smoke:staging

# Also create a disposable VIEWER user.
SMOKE_CREATE_USER=1 npm run smoke:staging

# Consume the accepted TEST DTE by sending an invalidation event.
SMOKE_INVALIDATE=1 npm run smoke:staging

# Exercise retry against a known failed/rejected staging document.
SMOKE_RETRY_DOCUMENT_ID="dte_..." npm run smoke:staging

# Check configuration and signed-webhook shape without network calls.
npm run smoke:staging -- --dry-run
```

By default, the script verifies the deployed admin shell, `/api/health`, login, signed Wompi webhook
ingress, Queue-driven CDE issuance to MH `ambiente=00`, admin-generated TEST DTE issuance, PDF/JSON
downloads, email resend, contingency sweep, and audit-log visibility. It fails on email resend unless
`SMOKE_ALLOW_EMAIL_FAILURE=1` is set.

1. Open the Worker URL and confirm the admin UI loads from ASSETS.
2. Bootstrap the owner account if the staging D1 database is empty, then log in.
3. Create at least one additional operator/admin user from the UI.
4. Click **Generar prueba** with a known test donor document. Expected result:
   - The request is accepted by `/api/test/dte`.
   - `wompi_events` receives an ambiente `00` test event.
   - The Queue processes the event.
   - A CDE appears in the documents list.
   - MH returns an accepted TEST response and a `selloRecibido`.
5. Open the document detail and test:
   - PDF download.
   - JSON download.
   - Email resend.
   - Retry on a non-accepted or failed document.
   - Invalidation/anulacion on an accepted TEST DTE inside the legal window.
6. Open the audit tab and verify entries exist for login, test generation, issuance, resend, retry,
   invalidation, and user creation where applicable.
7. Run a contingency sweep from the UI and verify the button returns visibly instead of hanging.
8. Watch logs during the smoke pass:

   ```bash
   npm run cf:tail:staging
   ```

## User UAT Approval

The user approves the Web UI only after the edge smoke test passes. Approval should cover:

1. Login and logout.
2. Documents list and document detail.
3. TEST DTE generation from the admin panel.
4. Accepted TEST DTE display, including `ambiente=00` and `selloRecibido`.
5. PDF receipt download.
6. JSON/signed payload download.
7. Email resend.
8. Retry for failed or rejected DTEs.
9. Audit log.
10. User and role management.
11. Contingency view and sweep button.
12. Invalidation/anulacion button on an accepted TEST DTE.

## Production Gate

Do not set production secrets or deploy `--env production` until staging UAT is approved. Production
cutover then uses production MH credentials, production Wompi secret, production email sender, and one
controlled low-value issuance while tailing logs.

Protect the public Worker before production with Cloudflare Access or equivalent WAF/rate-limiting
rules around `/api/auth/*`, plus monitoring for Queue retries, MH rejects, email failures, and D1
backup/export.
