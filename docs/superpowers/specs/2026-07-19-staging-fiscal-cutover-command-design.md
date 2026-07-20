# Staging Fiscal Cutover Command Design

## Context

PR #94 restores `FISCAL_CUTOVER_QUIESCED=1` as an acknowledgment before every remote migration and deployment. That preserves the original cutover safety check, but it also blocks routine staging work even though staging has already crossed migrations `0020` and `0021`.

The project remains in development and staging. This change must preserve the safety mechanism without introducing production or go-live work.

## Goal

Keep ordinary staging migrations and deployments unchanged while providing one explicit, guarded command for the exceptional case where a staging environment must cross migrations `0020` and `0021` together with the claim-aware Worker.

## Non-goals

- Detect remote migration state automatically.
- Change Worker, client, database, routing, repository, or WorkerFetch behavior.
- Deploy, push, or perform production/go-live work.
- Replace the documented requirement to drain mutating traffic before a real cutover.

## Command design

Retain `scripts/assert-fiscal-cutover.mjs` from PR #94. It must fail unless `FISCAL_CUTOVER_QUIESCED` is exactly `1`.

Restore the four routine remote commands to their pre-PR behavior:

- `cf:migrate:staging` runs the D1 preflight before applying staging migrations.
- `cf:deploy:staging` builds and deploys staging.
- `cf:migrate:prod` and `cf:deploy:prod` remain unchanged and outside this staging task.

Add one explicit staging command:

```text
cf:cutover:staging =
  node scripts/assert-fiscal-cutover.mjs
  && npm run cf:migrate:staging
  && npm run cf:deploy:staging
```

The guard therefore runs before any migration, build, or deployment in the exceptional cutover workflow. Routine staging commands do not require a ceremonial acknowledgment.

## Documentation

`docs/fiscal-claim-cutover.md` will state:

- staging has already completed the one-time cutover;
- routine staging migration and deployment commands are not gated;
- `cf:cutover:staging` is only for rebuilding or upgrading an environment that still must cross `0020` and `0021`;
- setting the flag is an acknowledgment, not proof of quiescence, so the drain procedure remains mandatory.

The revised wording will stay focused on staging and will not claim production readiness or go-live.

## Tests

Test-first changes in `test/scripts/deployScripts.test.ts` will require:

1. routine remote migration and deployment commands to remain free of the cutover guard;
2. `cf:cutover:staging` to run the guard, staging migration, and staging deployment in that order;
3. staging migration to retain D1 preflight ordering;
4. the cutover assertion script to remain present.

The existing `test/scripts/fiscalCutover.test.ts` cases will continue proving that the guard blocks without the acknowledgment and succeeds with it.

## Integration and verification

The original PR commit remains in history for attribution. A focused follow-up commit will reconcile its operational behavior with the staging development policy.

Verification must include:

- a RED run of the revised deploy-script tests before implementation;
- focused deploy/cutover tests after implementation;
- the complete test suite;
- TypeScript checks;
- build;
- Wrangler binding freshness;
- private-boundary check;
- clean Git diff and independent review.
