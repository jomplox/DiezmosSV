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
   npx wrangler secret put BOOTSTRAP_OWNER_TOKEN --env staging
   npx wrangler secret put CLOUDFLARE_ACCOUNT_ID --env staging
   npx wrangler secret put CLOUDFLARE_API_TOKEN --env staging
   npx wrangler secret put MH_CERT_PASSWORD --env staging
   npx wrangler secret put MH_CERT_XML_PART_1 --env staging
   npx wrangler secret put MH_CERT_XML_PART_2 --env staging
   npx wrangler secret put MH_USER_TEST --env staging
   npx wrangler secret put MH_PASSWORD_TEST --env staging
   npx wrangler secret put EMAIL_FROM --env staging
   npx wrangler secret put EMAIL_PROVIDER_URL --env staging   # optional deployment-owned fallback
   npx wrangler secret put EMAIL_API_KEY --env staging   # optional fallback
   npx wrangler secret put EMISOR_CONFIG_JSON --env staging
   ```

   Local dev may keep the certificate in one `MH_CERT_XML` value. Cloudflare Workers limit each
   variable/secret to 5 KB, so staging and production should split larger MH certificate XML values
   across `MH_CERT_XML_PART_1` and `MH_CERT_XML_PART_2`.

   `CLOUDFLARE_API_TOKEN` is only needed when owners should be able to update secrets from the
   deployed **Credenciales** screen. Scope it narrowly to this Worker script's secret-edit API.

   Receipt email uses the Cloudflare Email Service `EMAIL` binding declared in `wrangler.toml`.
   Before expecting donor delivery, onboard the sender domain under Cloudflare Email Sending and set
   `EMAIL_FROM` to an address on that domain. If Cloudflare returns `destination address is not a
   verified address`, the Worker is reaching Email Service but the account/domain is still limited to
   verified destination addresses rather than arbitrary donor recipients. Configure
   `EMAIL_PROVIDER_URL` / `EMAIL_API_KEY` for a transactional fallback provider if donor delivery must work
   before Cloudflare Email Sending is enabled for arbitrary recipients.

   `EMAIL_PROVIDER_URL` is deployment-owned. It must be an absolute HTTPS URL without embedded
   credentials. Set it with Wrangler or the Cloudflare deployment configuration, not from the
   application credentials panel. After the release is deployed and the new binding is verified,
   delete the superseded email-endpoint secret left by earlier releases from the deployment. This
   repository change does not modify staging or production configuration.

6. Apply the schema and deploy:

   ```bash
   npm run cf:migrate:staging
   npm run cf:deploy:staging
   ```

## Edge Smoke Test

Capture the Worker URL from Wrangler after deploy.

The quickest repeatable smoke pass is:

```bash
DIEZMOSSV_ENV_FILE="$HOME/Library/Application Support/DiezmosSV/private/env/staging-smoke.env" npm run smoke:staging
```

Store the Worker URL, login, Wompi secret, bootstrap token, and donor test identity in that `0600`
regular non-symlink file. The path above is the runner's default, so `npm run smoke:staging` is
normally sufficient. Never place those values inline in the shell command or task transcript.

Useful flags:

```bash
# Check configuration and signed-webhook shape without network calls.
npm run smoke:staging -- --dry-run
```

Set `STAGING_BOOTSTRAP`, `SMOKE_CREATE_USER`, `SMOKE_INVALIDATE`, or
`SMOKE_RETRY_DOCUMENT_ID` inside the selected env file when those optional paths are needed.

By default, the script verifies the deployed admin shell, `/api/health`, login, signed Wompi webhook
ingress, Queue-driven CDE issuance to MH `ambiente=00`, admin-generated TEST DTE issuance, PDF/JSON
downloads, email resend, contingency sweep, and audit-log visibility. It fails on email resend unless
`SMOKE_ALLOW_EMAIL_FAILURE=1` is set.

1. Open the Worker URL and confirm the admin UI loads from ASSETS.
2. Bootstrap the owner account with the `BOOTSTRAP_OWNER_TOKEN` if the staging D1 database is empty, then log in.
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
8. Open **Credenciales** as an OWNER and verify that:
   - The staging Worker name and app environment are visible.
   - Only the MH TEST lane is available; signer, issuer, Wompi, and email statuses show configured or pending.
   - Correo shows the Cloudflare `EMAIL` binding and `EMAIL_FROM` as configured.
   - If Cloudflare Email Service is still destination-limited, Correo shows the fallback email
     provider as configured.
   - Blank fields are understood as "leave unchanged".
   - If the Cloudflare writer token is not configured, the save action fails visibly instead of
     storing secrets in D1.
9. Watch logs during the smoke pass:

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

Before the first production deploy, create the production R2 archive bucket referenced by
`[env.production.r2_buckets]` in `wrangler.toml` (the monthly retention export writes legal archives there):

```
npx wrangler r2 bucket create diezmossv-production-archive-example
```

Protect the public Worker before production with Cloudflare Access or equivalent WAF/rate-limiting
rules around `/api/auth/*`, plus monitoring for Queue retries, MH rejects, email failures, and D1
backup/export.
