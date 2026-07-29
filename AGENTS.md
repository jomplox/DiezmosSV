# AGENTS.md

Conventions for anyone — human or agent — working in this repository.

## Donor-facing language

**A diezmo or ofrenda is a voluntary gift, given expecting nothing in return.** It is not a
purchase, and the donor is not a customer. Donor-facing copy must never frame it as a
transaction.

This is a doctrinal requirement, not a style preference. Treat it as non-negotiable.

### Never, in donor-facing copy

`pagar` · `pago` · `su pago` · `comprar` · `compra` · `cliente` · `precio` · `costo` ·
`checkout` · `carrito` · `orden`

### Use instead

| Concept | Correct term |
|---|---|
| The act of giving | **entrega** — "Complete su entrega", "Preparando su entrega…" |
| The gift itself | **diezmo**, **ofrenda**, **aportación**, **donación** |
| The person giving | **donante** |
| The step where Wompi is reached | **Su entrega** (`DONAR_STEP_TITLE_ENTREGA`) |
| Confirming it went through | "Verificando su entrega…" |

Established phrasings already in the product — match these rather than inventing new ones:

- "Complete su entrega de forma segura con Wompi."
- "Entrega segura con Wompi"
- "Continuar con su diezmo" / "Continuar con su ofrenda"
- "Su nombre, correo, teléfono y dirección se ingresan al completar su entrega con Wompi."

Address the donor in **usted** form throughout.

### Scope: what this rule does and does not cover

**Covered — the rule applies:** the `/donar` wizard, the thank-you page, the CDE email, the
receipt PDF, validation and error messages the donor can see, and any new donor-facing surface.

**Exempt — external vocabulary that must stay verbatim:**

- **MH catalog labels and DTE schema fields.** CAT-017 is literally "forma de pago";
  CAT-018 includes "Cuentas por pagar del receptor"; `resumen.pagos[].montoPago` is a
  schema field name. These are legally defined by Hacienda. Never "correct" them —
  changing them breaks fiscal validation.
- **Wompi API identifiers.** `EnlacePago`, `formaPago`, `urlEnlace`, `idEnlace`,
  `TransaccionCompra`, `permitirTarjetaCreditoDebido`. These mirror Wompi's schema exactly
  and must not be renamed.
- **The admin panel.** Operators work in MH's vocabulary and need terms that match the
  catalogs and the DTE JSON they are editing.

The distinction is audience: **a donor never sees MH's or Wompi's vocabulary.** When those
terms must surface near donor-facing copy, wrap them rather than adopting their framing.

### Enforcement

A regression guard lives in `test/client/donarPage.test.ts` → *"keeps transactional
vocabulary out of the donor wizard copy"*. It fails the build if a forbidden term reaches
the donor wizard source. Extend the forbidden list there when you add a new term; add a new
guard when you add a new donor-facing surface.

Prefer a guard over a review comment — this rule has been violated before and the test is
what makes it stick.

## Brand presentation on /donar

The `<h1>` stays the ceremonial brand title ("Diezmos y Ofrendas") on **every** step. Step
context belongs in the small label beneath it, never in place of the title. A brand-demoting
compact header was tried and rolled back as a visual regression; `donar-compact-head` is
asserted absent.

## Fiscal safety

- **`emission_environment`** (`app_settings`, `00` pruebas / `01` producción) governs whether
  issuance is real. Verify it before any UAT — it has been left at `01` by accident before.
- **The deployment decides what it may issue.** `deploymentEnvironmentPolicy` pins staging to
  ambiente `00` and production to `01`, and the webhook derives its ambiente from Wompi's
  `EsProductiva`. A production-Wompi payment against staging is quarantined, not issued.
  Do not weaken this guard to make a test easier.
- **`receptor.direccion` may not be null for a domiciled receptor.** MH rejects it with
  codigoMsg 096 even though `fe-cd-v2` permits null. Donors without an address get the emisor
  geography plus `RECEPTOR_ADDRESS_FALLBACK`. Non-domiciled receptors are the opposite case:
  MH rejects *any* direccion object, so it travels null and the address rides the
  `DireccionExtranjera` apéndice.
- **Never let a schema-invalid value reach CDE build.** Validate at intake instead: an
  oversize value passes validation, takes the donor's gift, and only then fails — stranding a
  completed entrega without a comprobante.

## Testing

- `npm test` — unit and integration (vitest).
- `npm run build` — includes both typechecks (client and worker).
- `npx playwright test` — e2e. Stop any preview on port 8787 first, and set
  `PW_PERSIST_TO=<dir>` for a fresh D1; stale rate-limit rows fail the donar spec.

Write the failing test first and watch it fail. For a guard protecting against a regression
that is not currently present, temporarily reintroduce the fault to confirm the guard catches
it — a guard that has never failed has not been shown to work.
