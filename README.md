# DiezmosSV

Open-source Cloudflare Workers app for churches in El Salvador that want to issue **Comprobantes de Donacion Electronicos** (CDE, DTE tipo `15`) from approved Wompi donations with low infrastructure cost.

The goal is simple: help churches emit CDE DTEs correctly, securely, and affordably using Cloudflare Workers, D1, Queues, and a lightweight admin panel.

> This project is not legal or tax advice. Before production use, validate your configuration, MH credentials, document mappings, and operating procedures with your accountant, legal representative, and Ministerio de Hacienda onboarding process.

> DiezmosSV is an independent open-source project. It is not affiliated with, endorsed by, sponsored by, or officially supported by Wompi or Cloudflare. Wompi and Cloudflare are referenced only because this app integrates with their public services.

## What This Does

- Receives Wompi payment webhooks at `POST /webhooks/wompi`.
- Verifies the raw-body `wompi_hash` HMAC before accepting a webhook.
- Deduplicates Wompi retries by `IdTransaccion`.
- Maps approved donations into MH CDE JSON (`tipoDte=15`).
- Validates generated CDE JSON against the bundled MH JSON schema.
- Signs DTE JSON natively in Workers with WebCrypto as compact `RS512` JWS.
- Authenticates with MH and caches the token in D1.
- Transmits CDEs to MH Recepcion and records the Sello de Recepcion.
- Generates a PDF representacion grafica with QR code and attaches the signed JSON.
- Sends donor email through a configurable transactional email provider.
- Handles contingency state for MH outages and cron-based retransmission.
- Supports invalidation events with the CDE legal-window check.
- Provides an admin panel for documents, failures, contingency, audit, users, resend, retry, and invalidation.
- Uses PBKDF2 password hashing, bearer sessions, and RBAC roles.

## Cloudflare Architecture

- **Worker:** API, webhook ingress, issuance pipeline, MH client, signer, PDF/email orchestration.
- **D1:** Wompi events, DTE documents, signed events, tokens, users, sessions, audit log, contingency periods.
- **Queues:** Async issuance from approved Wompi webhooks.
- **Cron Triggers:** Contingency sweeps and retransmission attempts.
- **Static assets:** React admin panel served from the Worker assets binding.

## Current Status

This is an early implementation intended to be useful, auditable, and inexpensive. It includes the core pieces needed for a production integration, but every church must still provide its own:

- MH test and production API credentials.
- MH certificate XML and private-key password.
- Wompi webhook secret.
- Email provider credentials.
- Emisor configuration.
- Responsible-person data for invalidation and contingency events.
- Legal/finance decision for donors with incomplete identification.

## Repository Safety

Do not commit real credentials.

Ignored by default:

- `.dev.vars`
- `DTE/Credentials/`
- MH PDFs and local onboarding artifacts
- real Wompi webhook samples
- build output and local Wrangler state

Use `examples/wompi-webhook.sample.json` for public testing and documentation. Keep real Wompi payloads private.

## Requirements

- Node.js 22 or newer.
- npm.
- Cloudflare account.
- Wrangler CLI, installed through this project.
- Wompi account with webhook access.
- MH DTE API credentials for the environment you want to use.

## Local Setup

Install dependencies:

```bash
npm install
```

Create a local env file:

```bash
cp .dev.vars.example .dev.vars
```

Fill `.dev.vars` with real values. Use separate MH credentials for test and production:

```bash
WOMPI_API_SECRET="..."
MH_CERT_PASSWORD="..."
MH_CERT_XML="<CertificadoMH>...</CertificadoMH>"

MH_USER_TEST="..."
MH_PASSWORD_TEST="..."
MH_USER_PROD="..."
MH_PASSWORD_PROD="..."

EMAIL_API_URL="..."
EMAIL_API_KEY="..."
EMAIL_FROM="dte@example.org"
```

Apply local D1 migrations:

```bash
npx wrangler d1 migrations apply diezmossv-local-db-example --local
```

Run the Worker and the admin UI:

```bash
npm run dev:worker
npm run dev
```

Open the Vite URL and use `Crear owner` the first time.

## Validation

Run the local checks:

```bash
npm test
npm run typecheck
npm run build
```

The tests cover:

- Wompi HMAC verification.
- CDE schema generation.
- Contingency event schema generation.
- Native RS512 signing and verification.
- CDE invalidation legal-window calculation.

## Cloudflare Setup

Create a D1 database:

```bash
npx wrangler d1 create example-worker
```

Update `wrangler.toml` with the returned database id.

Create a Queue:

```bash
npx wrangler queues create diezmossv-local-issuance-example
```

Set production secrets:

```bash
npx wrangler secret put WOMPI_API_SECRET
npx wrangler secret put MH_CERT_PASSWORD
npx wrangler secret put MH_CERT_XML
npx wrangler secret put MH_USER_TEST
npx wrangler secret put MH_PASSWORD_TEST
npx wrangler secret put MH_USER_PROD
npx wrangler secret put MH_PASSWORD_PROD
npx wrangler secret put EMAIL_API_KEY
```

Apply remote migrations:

```bash
npx wrangler d1 migrations apply example-worker
```

Deploy:

```bash
npm run build
npx wrangler deploy
```

## Wompi Webhook

Configure Wompi to send approved payment events to:

```text
https://YOUR_WORKER_DOMAIN/webhooks/wompi
```

The Worker only processes:

```text
ResultadoTransaccion = ExitosaAprobada
```

Environment routing:

- `EsProductiva=false` maps to MH `ambiente=00`.
- `EsProductiva=true` maps to MH `ambiente=01`.

Use matching MH credentials for each environment.

## MH Credentials

The signer certificate and the MH API login are different concerns.

- `MH_CERT_XML`: the XML certificate content.
- `MH_CERT_PASSWORD`: the private-key password used for signing.
- `MH_USER_TEST` / `MH_PASSWORD_TEST`: API login for MH test.
- `MH_USER_PROD` / `MH_PASSWORD_PROD`: API login for MH production.

Do not use production credentials for test donations. If a church only has production credentials, test Wompi payments routed to MH `ambiente=00` will fail authentication.

## Admin Roles

- `VIEWER`: read documents and audit log.
- `OPERATOR`: resend email, retry failures, initiate invalidation.
- `ADMIN`: manage users and roles.
- `OWNER`: top-level operator for church ownership and credential stewardship.

## Compliance Notes

- CDE is transmitted normally before delivery to the donor, except during contingency.
- Contingency documents are sent as transitory and queued for later MH transmission.
- Invalidation is a signed event, not a database flag.
- CDE invalidation is blocked outside the first ten business days of the month after the sello tax period.
- Keep signed JSON, MH responses, and audit records immutable for retention.

## Development Notes

The app intentionally avoids a JVM signer. The MH certificate XML contains ordinary RSA key material, and Workers WebCrypto can produce the required `RS512` compact JWS.

The official MH signer is still useful as a conformance oracle during onboarding. For production, compare signatures and accepted documents in the MH test environment before switching on real donations.

## License

Apache License 2.0. See [LICENSE](./LICENSE).
