# Local private artifacts

## Approved location

Use this out-of-tree root on macOS:

```text
~/Library/Application Support/DiezmosSV/private/
├── deploy/
│   ├── staging.env
│   └── production.env
├── env/
│   ├── local-operator.env
│   ├── staging-smoke.env
│   └── production-operator.env
├── mh/live/signing/
├── mh/test/signing/
├── wompi/live/captures/
├── tax/live/imports/
├── dte/live/
├── dte/reference/
└── quarantine/
```

Every directory is `0700`; every file is `0600`. Do not use symlinks. `npm run dev:worker` reads `env/local-operator.env` by default, while `npm run smoke:staging` reads `env/staging-smoke.env`. Override either with `DIEZMOSSV_ENV_FILE=/absolute/path/to/file`; a relative override is resolved from the checkout.

## Private release branding contract

The staging and production deploy files default to these owner-only, out-of-repository paths:

```text
~/Library/Application Support/DiezmosSV/private/deploy/staging.env
~/Library/Application Support/DiezmosSV/private/deploy/production.env
```

Each file contains only these required keys:

```dotenv
DIEZMOSSV_DEPLOY_TARGET=staging
VITE_GIVEBUTTER_CAMPAIGN=example-campaign
DIEZMOSSV_APP_ORIGIN=https://staging.example.invalid
DIEZMOSSV_DONOR_LOGO_FILE=/absolute/private/path/logo.png
```

`DIEZMOSSV_DEPLOY_CONFIG=/absolute/private/path/staging.env` may select another deploy file. The override must be absolute, and `DIEZMOSSV_DEPLOY_TARGET` must exactly match the command's `--env` target. The deploy file and donor logo must be regular, owner-owned `0600` files outside the repository, never symlinks. The donor logo must be a PNG (`.png`) or JPEG (`.jpg`/`.jpeg`) whose extension agrees with its byte signature and which `pdf-lib` can embed and save; SVG, corrupt, or truncated rasters block release before any remote request or upload.

## Private release builds

Deployment scripts call the owner-only build wrapper automatically. To build a release artifact without deploying, select the target explicitly:

```sh
npm run build:private -- --env staging
npm run build:private -- --env production
```

The wrapper validates the selected target-bound private deploy file before running `npm run build`. It injects only the public `VITE_GIVEBUTTER_CAMPAIGN` slug used by the donor-selected U.S. alternative; it does not inject the configured origin, donor logo, operator credentials, or Stripe values into the Vite client. Stripe is runtime-only: its restricted key, webhook secret, payment-method configuration, Billing Portal configuration, legal name, and EIN are Cloudflare secrets described in [`docs/stripe-us-giving.md`](stripe-us-giving.md). Plain `npm run build` remains available for public clones and tests, where the neutral campaign placeholder keeps URL helpers deterministic.

Logo migration uses an external operator env file. Staging reuses `env/staging-smoke.env`; production uses the distinct `env/production-operator.env`. Override either with the absolute `DIEZMOSSV_OPERATOR_ENV_FILE`. The file accepts target-prefixed pairs (`STAGING_EMAIL`/`STAGING_PASSWORD` or `PRODUCTION_EMAIL`/`PRODUCTION_PASSWORD`) or the generic `DIEZMOSSV_OPERATOR_EMAIL`/`DIEZMOSSV_OPERATOR_PASSWORD` pair and follows the same external, regular, owner-owned `0600`, no-symlink rules.

Run the read-only preflight before a release:

```sh
npm run cf:branding:check -- --env staging
npm run cf:branding:check -- --env production
```

The preflight validates the private raster locally, requires public `/api/health` to report the selected target, and only then compares `/api/branding` plus the exact remote logo bytes. A target mismatch stops before authentication or any write.

Migration is a separate explicit write and does nothing remotely without `--apply`:

```sh
npm run cf:branding:migrate -- --env staging --apply
npm run cf:branding:migrate -- --env production --apply
```

Without `--apply`, the migration command still runs the local `pdf-lib` embeddability check and exits without sending a remote request.

## Safe relocation

For each artifact:

1. Classify it as live credential, test credential, PII/tax data, private provider capture, public reference, or disposable cache.
2. Refuse a destination collision unless the existing file is byte-identical and intentionally retained.
3. Copy to the approved destination, set the destination file to `0600`, and keep every parent directory at `0700`.
4. Verify source and destination with `cmp -s` without displaying content.
5. Only after a successful comparison, remove the checkout copy.
6. Run `npm run security:check-private-boundary` and inspect path/mode metadata only.

If verification fails, keep both copies, place the new copy under a collision-safe `quarantine/` name, and resolve it manually. Removing a source file on APFS does not prove secure erasure: snapshots, backups, synchronized copies, filesystem history, and task/terminal logs may retain data.

## Rotation and containment

Credential rotation is required after a commit/push, log or task-transcript disclosure, chat/email transfer, unintended synchronization, or custody by an untrusted party. Verify the provider-specific revocation/reissue procedure and rollback path before changing a live credential. Local presence alone, in a protected file that never left approved custody, is not evidence that rotation is needed.

PII and tax exports follow containment instead: restrict access, record where copies may exist, apply the legal retention schedule, remove unauthorized working copies, and review backup/transcript retention. Do not describe PII as rotatable.

### MH signing-certificate rotation

For a lost or potentially exposed DTE signing key, the official May 2026 MH procedure requires an authorized operator in the authenticated [Sitio de Emisores DTE](https://admin.factura.gob.sv/login):

1. Select the production environment and open **Certificado → Cancelar Certificado**. Use the vulnerability-risk reason; cancellation disables the exposed identity.
2. Generate a replacement through **Generar Certificado**, download it through **Descarga de Certificado**, and preserve the new private material only in the approved out-of-tree location.
3. Complete **Carga de Certificado**. MH requires this after each generation so its database uses the replacement.
4. Replace the production signer certificate/keys through the normal secret-management path, verify the new identity, and only then resume issuance. Never paste the material into a shell command, ticket, chat, or task transcript.

This procedure requires the taxpayer's authenticated DGII account and, for a legal entity, an authorized representative recorded in the RUC. It cannot be performed by an unauthenticated repository maintainer. If access is unavailable, use the official [Facturación Electrónica support channel](https://factura.gob.sv/contactenos/). Certificate replacement does not by itself prove that the DTE API password was rotated; handle that as a separate credential if it crossed an unintended boundary.

## Containment review

Run this review after any relocation pass, and record only the outcome — never the artifact contents:

- Confirm every artifact was byte-verified at its destination before the checkout copy was removed.
- Remove disposable Wrangler account caches. Leave ordinary `.wrangler/state` D1/R2 development state alone.
- Search reachable Git history for private-artifact filenames.
- Decide rotation versus containment using the rules above. A protected local file that never left approved custody is not by itself evidence of exposure; an unclear custody trail is.
- Confirm that no artifact value was printed to a shell, log, ticket, chat, or task transcript during the pass.
- Re-check backup and disk-encryption custody whenever a backup destination is added or changed — the private root is not excluded from backups by default.
