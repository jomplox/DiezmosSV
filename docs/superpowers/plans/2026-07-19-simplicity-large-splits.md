# Simplicity Large Splits — Roadmap Spec (post-production-launch)

> **Owner-driven.** This spec is for José. Deliberately deferred until after production go-live: each item is churn-heavy, none blocks launch, and mid-launch is the wrong time for tree-wide moves. Prerequisite: the Mechanical Extractions plan (2026-07-19) must be merged first — its InMemoryD1/support extraction unblocks item 3.

**Goal:** Break the three remaining monoliths — the index.ts regex router, the 147-method Repository, and the 22.7k-line workerFetch test monofile — along their natural seams, preserving behavior and coverage exactly.

## Why deferred, in one line each

- Router table: readability win only — role guards are already DRY (`requireRole` + central `AuthError` catch at `index.ts:290`).
- Repository split: touches everything; mechanical but enormous blast radius.
- Test monofile split: safe but 19-file churn; wants the support/ extraction settled first.

## Item 1 — index.ts declarative route table (Effort L, Risk med)

Current shape: `handleApi` (`index.ts:841–1771`) is ~53 sequential branches of `pathname === "…"` / `url.pathname.match(/…/)` + method checks. Guards are fine; dispatch is the problem.

Approach:
1. Define `interface Route { method: "GET"|"POST"|"PATCH"|"PUT"|"DELETE"; pattern: RegExp | string; role?: Role; handler: (ctx) => Promise<Response> }` with `ctx = { request, env, repo, user, params }`.
2. Convert branches mechanically, one commit per route *group* (auth, documents, corrections, settings, wompi, users, exports). Move each branch's `requireRole` into the table's `role` field — the central catch at `:290` already converts `AuthError`.
3. Keep handler bodies byte-identical during conversion; extract them to named functions only where they're inline lambdas today.
4. Verification: the full workerFetch suite is effectively a router conformance suite — run it after every group. Also assert 405/404 semantics unchanged (several tests pin them).

Trap to respect: route ORDER matters today (e.g., `/api/documents/:id/correction-data` matches before the generic `/api/documents/:id/:action` at `:1522`). The table must preserve declaration order evaluation, not "most specific wins".

## Item 2 — Repository split along its 12 seams (Effort L, Risk med)

Current shape: one class, `storage/repository.ts`, 5,831 lines, ~147 methods. Measured seams (line ranges at base `3dd2e63`):

| Seam | Lines |
|---|---|
| settings | 313–328 |
| fiscal corrections | 368–1946 |
| Wompi issuance claims | 1946–2434 |
| donation intents | 2434–2717 |
| DTE documents | 2741–3998 |
| audit | 4043–4241 |
| email deliveries | 4299–4780 |
| users + sessions | 4781–5234, 5538–5760 |
| rate limits | 4834–5017 |
| analytics reads | 3319–3435 |

Approach options, in preference order:
1. **Mixin/facade**: split into `repository/corrections.ts`, `repository/documents.ts`, … each exporting a class fragment or plain functions taking `(db: D1Database)`; keep a thin `Repository` facade with the same public surface so ZERO call sites change. This is the low-risk path — do this one.
2. Full decomposition with per-domain repos injected separately — only if the facade later proves annoying; not now.

Verification: `repositoryFiscalSql.test.ts` (real SQL) + full suite; no call-site diffs outside the storage directory in the facade approach. One seam per commit.

Trap: several "seams" share private helpers (`newId`, `nowIso`, JSON guards) — extract those to `storage/shared.ts` first, one commit, before moving any seam.

## Item 3 — workerFetch.test.ts split into domain files (Effort L, Risk med)

Prerequisite: support/ extraction merged (InMemoryD1, sqliteD1, fixtures, authedDb).

Current shape: 46 top-level describes. Measured domain map (line ranges at base):

- infra/errors/static security: 88–267
- Wompi reservation + issuance-failure recovery: 267–885
- guarded fiscal correction API: 885–5145  ← biggest; consider 2–3 files (reservation / receptor correction / production guards)
- request/auth/session infra: 5145–6355
- donation intents: 6355–7503
- password reset: 7503–8110
- document listing/detail: 8110–8476
- user administration: 8476–9080
- email/resend/contact/download/retry: 9080–10084
- contingency + invalidation: 10084–10763
- exports (F960, contacts): 10763–11168
- annual certificates: 11168–11525
- advanced CDE + Wompi webhook: 11525–12459
- intent correlation + deferred transmission: 12459–14724 (keep the twin
  `seedIntentRow`/`seedWompiEvent` pairs separate: their row shapes and default
  IDs differ)
- audit/alerts/queue/transmission claim: 14724–15468
- dead-letter sweep + cron + cert expiry: 15468–16395
- admin settings: 16395–17185
- audit context/branding/analytics: 17185–18420

Approach: one domain file per commit, moving describes verbatim; keep the original file as a shrinking shell until the last move deletes it. Test COUNT must be identical after every commit (1450/1 at today's base; recount at start).

Also flagged during the survey, optional within this item: `pipeline.ts` (2,048 lines of core issuance) has no dedicated unit-test file — only monofile integration coverage. If you want one focused suite, seed it while splitting the Wompi/deferred domains, reusing their fixtures.

## Standing constraints (all items)

- Direct-main or short-lived branch per item — your call; full gates (`MINIFLARE_CACHE_DIR=… npm test`, typecheck, build, types:check) between commits; exact-SHA CI before any staging deploy.
- Behavior and coverage byte-preserved; any "while I'm here" improvement goes to a note, not the diff.
- The fiscal claim/lease/audit machinery keeps its exact semantics — these splits move code, never reshape it.
