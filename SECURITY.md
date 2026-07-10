# Security policy

## Supported surface and reporting

Security fixes target the current `main` branch. Report suspected vulnerabilities privately through a [GitHub security advisory](https://github.com/jomplox/DiezmosSV/security/advisories/new); do not include credentials, donor records, private keys, or live webhook captures in a public issue.

The shipped runtime is the Cloudflare Worker, React client, D1 migrations, queue/cron handlers, and declared Cloudflare bindings. Ignored Java signer directories under `DTE/` are local conformance/reference tooling, not an authenticated service and not part of the deployed product. Do not expose them to a network without a separate review covering authentication, CORS, request limits, process isolation, and secret handling.

## Trust boundaries and roles

- Public routes include branding reads, authentication/reset entry points, `/donar`, donation intent status, and the signed Wompi webhook. Public identifiers are not authorization capabilities.
- `VIEWER` may read operational records but receives an audience-projected audit trail without transport telemetry or account identities.
- `OPERATOR` may perform document operations but has the same audit disclosure limits as `VIEWER`.
- `ADMIN` may manage users and read full operational audit context.
- `OWNER` additionally manages deployment-compatible credentials and application settings.
- Queue and cron handlers are trusted only to process records already constrained to the deployment's fiscal environment.
- Wompi is trusted only after raw-body HMAC verification. An application donation binds only through `EnlacePago.IdentificadorEnlaceComercio` plus an exact numeric `EnlacePago.Id` match to the stored link.
- MH, email, and Cloudflare APIs are outbound trust boundaries. Their credentials are write-only secrets and must not appear in responses, logs, fixtures, or audits.

## Donation intent capabilities

An intent id is a public read/correlation identifier, never write authority. Draft creation returns a separate 256-bit one-time `/datos` capability. Only its SHA-256 hash is stored. The atomic consume operation requires the hash, `LINK_CREATED`, no payment, and no existing donor document, then clears the hash in the same statement. Missing, invalid, consumed, paid, expired, completed, and already-populated intents all fail closed.

The capability must remain in client memory. Never place it in a URL, local/session storage, analytics, logs, audits, or Wompi fields.

## Fiscal environment invariant

| Deployment | Allowed MH ambiente | Direct CDE generation | Available MH credential lane |
|---|---:|---:|---|
| local | `00` | yes | TEST |
| staging | `00` | yes | TEST |
| production | `01` | no | PROD |
| missing/unknown `APP_ENV` | none | no | none |

This matrix is enforced before mock mode, credential selection, signing, sequence allocation, persistence, queueing, or MH calls. A signed Wompi event for another environment is retained and audited but not marked paid or queued. D1 settings cannot widen the deployment capability.

## Audit audiences

`ADMIN` and `OWNER` can receive actor email, IP, Cloudflare context, and account-row identities. `VIEWER` and `OPERATOR` receive null actor email/IP/context on every row; user-entity rows additionally remove actor id/name, target id, raw summary, and metadata. Historical alert-email values remain storage-redacted for every role.

## Local artifacts

The following must never exist in the checkout:

- `.dev.vars` or `.dev.vars.*`, except tracked `.dev.vars.ci` and `.dev.vars.example`;
- `DTE/Credentials/**`;
- root `WompiWebhookSample.json`;
- local DTE CSV/XLSX/PDF/OCR working artifacts and `examples/DTE-*` outputs;
- Wrangler account caches at `node_modules/.cache/wrangler/wrangler-account.json` and `node_modules/.mf/cf.json`.

Run `npm run security:check-private-boundary` before sharing or publishing a checkout. Approved private storage uses `0700` directories, `0600` regular files, and no symlinks. See [docs/local-private-artifacts.md](docs/local-private-artifacts.md) for layout, migration, retention, containment, and rotation rules.

Rotate a credential when it was committed/pushed, printed to logs or task transcripts, sent through chat/email, placed in shared or untrusted synchronized storage, or otherwise left approved custody. PII is contained and handled under retention/access procedures; it is not "rotated."
