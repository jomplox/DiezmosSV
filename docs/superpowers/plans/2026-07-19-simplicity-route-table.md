# Simplicity Route Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `handleApi`'s ordered chain of path/method branches with an ordered declarative route table while preserving every response, guard, side effect, and precedence rule.

**Architecture:** Add a small generic ordered dispatcher in `src/worker/routes/router.ts`. Keep the route-specific handler bodies in `src/worker/index.ts` during this refactor so the change is control-flow-only; each converted branch becomes a named handler plus one route record. A route may use a fixed `role`, a role callback that returns `Role | null`, or no role. `null` means the matched path/method combination is intentionally unguarded, which preserves existing wrong-method 405 ordering in delegated settings handlers. Static method mismatches continue scanning and ultimately return the existing 404; path-first delegates retain their existing 405 behavior.

**Tech Stack:** TypeScript, Cloudflare Workers, Vitest.

## Global Constraints

- Base: `codex/simplicity-large-splits` at integration commit `7e002e0f7c290bda6a7b2d20503326b81a936dc6`.
- Staging-only development scope. Never deploy or mutate production. Do not push or deploy during these tasks.
- Preserve route declaration order. Never sort by specificity.
- Preserve once-per-request `Repository`, `AuthService`, and `auth.authenticate(request)` construction before dispatch.
- Preserve the outer `AuthError`, body-size, invalid-JSON, deployment-policy, and unexpected-error translation in `fetch`.
- Preserve current method semantics:
  - method-constrained route + wrong method falls through to final `{ error: "not_found" }` 404;
  - path-first delegated credentials/settings/document routes retain their existing guarded `{ error: "method_not_allowed" }` 405;
  - `/api/health` remains method-agnostic.
- Preserve role-check ordering. The table supports `role?: Role | ((ctx) => Role | null)` because a fixed `role?: Role` cannot represent emission-environment, wrong-method settings behavior, and generic-document authorization without behavior changes.
- Handler business logic remains mechanically equivalent. Do not change validation, SQL calls, queue sends, audit fields, copy, status codes, or headers.
- The integrated baseline is 81 test files, 1,474 passed / 2 skipped. `test/worker/workerFetch.test.ts` has 513 passing tests.
- Task 1 adds exactly 6 dispatcher tests; after Task 1 the expected full count is 1,480 passed / 2 skipped and must remain identical through Task 9.
- Full gates after every task:

```bash
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmos-route-table-full npm test
rtk npm run typecheck
rtk npm run build
rtk env WRANGLER_LOG_PATH=/private/tmp/diezmos-route-table-wrangler.log npm run types:check
rtk git diff --check
rtk git status --short --branch
```

- The pre-existing Vite `>500 kB` chunk warning is non-blocking; new warnings are not.

---

### Task 1: Ordered dispatcher primitive

**Files:**
- Create: `src/worker/routes/router.ts`
- Create: `test/worker/router.test.ts`

**Interfaces:**
- Produces:

```ts
import type { AuthUser, Role } from "../services/auth";

export type RouteMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RoutableContext {
  request: Request;
  pathname: string;
  user: AuthUser | null;
  actor: AuthUser | null;
  params: readonly string[];
}

export interface Route<TContext extends RoutableContext> {
  method?: RouteMethod;
  pattern: RegExp | string;
  role?: Role | ((ctx: TContext) => Role | null);
  handler: (ctx: TContext) => Promise<Response>;
}

export type AuthorizeRoute = (user: AuthUser | null, role: Role) => AuthUser;

export async function dispatchRoutes<TContext extends RoutableContext>(
  routes: readonly Route<TContext>[],
  context: TContext,
  authorize: AuthorizeRoute
): Promise<Response | null>;
```

- `dispatchRoutes` returns `null` when nothing dispatches. It never manufactures a 404 or 405.
- A string pattern matches exact pathname equality.
- A `RegExp` pattern matches once and writes capture groups, excluding the full match, to `params`.
- A method mismatch continues without authorization.
- Authorization happens after path+method match and before the handler. Its returned `AuthUser` is written to `ctx.actor`; a `null` callback result leaves `ctx.actor` null.
- Declaration order wins.

- [ ] **Step 1: Write six failing dispatcher tests**

Create tests for: exact string match, regex capture groups, declaration order, method mismatch fallthrough, method-agnostic path-first dispatch, and fixed/callback/null roles authorizing before the handler and exposing the returned actor.

```ts
it("continues after a method mismatch instead of manufacturing 405", async () => {
  const response = await dispatchRoutes(
    [{
      method: "POST",
      pattern: "/api/example",
      handler: async () => new Response("unexpected")
    }],
    context({ method: "GET", pathname: "/api/example" }),
    vi.fn()
  );
  expect(response).toBeNull();
});
```

- [ ] **Step 2: Verify RED**

```bash
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmos-route-table-task-1-red npm test -- test/worker/router.test.ts
```

Expected: fail because `src/worker/routes/router.ts` does not exist.

- [ ] **Step 3: Implement the minimal dispatcher**

Use a one-shot clone for regex patterns and never reuse a regex's mutable `lastIndex`.

```ts
function matchParams(pattern: RegExp | string, pathname: string): readonly string[] | null {
  if (typeof pattern === "string") return pathname === pattern ? [] : null;
  const match = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, "")).exec(pathname);
  return match ? match.slice(1) : null;
}
```

- [ ] **Step 4: Verify GREEN and full gates**

```bash
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmos-route-table-task-1-green npm test -- test/worker/router.test.ts
```

Expected: 6/6 passing. Then run the full gates; expected full count: 1,480 passed / 2 skipped.

- [ ] **Step 5: Commit**

```bash
rtk git add src/worker/routes/router.ts test/worker/router.test.ts
rtk git commit -m "refactor: add ordered API route dispatcher"
```

### Task 2: Infrastructure and public-checkout routes

**Files:**
- Modify: `src/worker/index.ts:835-978`
- Test: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Consumes: `Route`, `RoutableContext`, and `dispatchRoutes`.
- Produces named handlers and ordered rows 1-8:
  1. any `/api/health`
  2. GET `/api/auth/bootstrap-status`
  3. GET `/api/branding`
  4. GET `/api/branding/logo`
  5. GET `/api/branding/donor-logo`
  6. POST `/api/donations/intent`
  7. POST `/api/donations/intent/:id/datos`
  8. GET `/api/donations/intent/:id/status`

- [ ] **Step 1: Add the API context and exact ordered public route records**

```ts
interface ApiRouteContext extends RoutableContext {
  env: Env;
  repo: Repository;
  auth: AuthService;
  url: URL;
  executionContext?: ExecutionContext;
}

const publicRoutes: Array<Route<ApiRouteContext>> = [
  { pattern: "/api/health", handler: handleHealth },
  { method: "GET", pattern: "/api/auth/bootstrap-status", handler: handleBootstrapStatus },
  { method: "GET", pattern: "/api/branding", handler: handlePublicBranding },
  { method: "GET", pattern: "/api/branding/logo", handler: handleAdminBrandingLogo },
  { method: "GET", pattern: "/api/branding/donor-logo", handler: handleDonorBrandingLogo },
  { method: "POST", pattern: "/api/donations/intent", handler: handleCreateDonationIntent },
  { method: "POST", pattern: /^\/api\/donations\/intent\/([^/]+)\/datos$/, handler: handleDonationIntentDatos },
  { method: "GET", pattern: /^\/api\/donations\/intent\/([^/]+)\/status$/, handler: handleDonationIntentStatus }
];
```

Move each existing branch body into its named handler with only `ctx.*` and `ctx.params[0]` plumbing changes. Keep rate-limit-before-parse ordering, deployment policy, status codes, logo slots, and health's method-agnostic behavior exact.

- [ ] **Step 2: Replace only the eight original branches with one dispatcher call at the same location**

Return the response when non-null, then continue into the untouched auth branches.

- [ ] **Step 3: Verify focused conformance and full gates**

```bash
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmos-route-table-task-2 npm test -- test/worker/workerFetch.test.ts
```

Expected: 513/513 passing. Run full gates; expected: 1,480 passed / 2 skipped.

- [ ] **Step 4: Commit**

```bash
rtk git add src/worker/index.ts
rtk git commit -m "refactor: table-drive public API routes"
```

### Task 3: Authentication routes

**Files:**
- Modify: `src/worker/index.ts:979-1087`
- Test: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Produces ordered rows 9-13:
  - POST `/api/auth/bootstrap-owner`
  - POST `/api/auth/login`
  - POST `/api/auth/logout`
  - POST `/api/auth/password-reset/request`
  - POST `/api/auth/password-reset/confirm`

- [ ] **Step 1: Convert the five branches mechanically**

```ts
const authRoutes: Array<Route<ApiRouteContext>> = [
  { method: "POST", pattern: "/api/auth/bootstrap-owner", handler: handleBootstrapOwner },
  { method: "POST", pattern: "/api/auth/login", handler: handleLogin },
  { method: "POST", pattern: "/api/auth/logout", handler: handleLogout },
  { method: "POST", pattern: "/api/auth/password-reset/request", handler: handlePasswordResetRequest },
  { method: "POST", pattern: "/api/auth/password-reset/confirm", handler: handlePasswordResetConfirm }
];
```

Keep public JSON limits, login/bootstrap rate-limit ordering, audit context, generic reset-request response, `executionContext.waitUntil`, and mapped reset errors exact.

- [ ] **Step 2: Verify**

Run `workerFetch.test.ts` (513/513) and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add src/worker/index.ts
rtk git commit -m "refactor: table-drive authentication routes"
```

### Task 4: Credentials and settings path-first delegates

**Files:**
- Modify: `src/worker/index.ts:1180-1211`
- Test: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Produces ordered path-first rows 18-25:
  - `/api/credentials`
  - `/api/credentials/writer-token`
  - `/api/settings/emission-environment`
  - `/api/settings/email-templates`
  - `/api/settings/branding`
  - `/api/settings/branding/logo`
  - `/api/settings/branding/donor-logo`
  - `/api/settings/alert-email`

- [ ] **Step 1: Convert paths without adding `method` constraints**

```ts
const settingsRoutes: Array<Route<ApiRouteContext>> = [
  { pattern: "/api/credentials", role: "OWNER", handler: handleCredentials },
  { pattern: "/api/credentials/writer-token", role: "OWNER", handler: handleCredentialWriterToken },
  {
    pattern: "/api/settings/emission-environment",
    role: ({ request }) => request.method === "GET" ? "VIEWER" : request.method === "PUT" ? "OWNER" : null,
    handler: handleEmissionEnvironment
  },
  {
    pattern: "/api/settings/email-templates",
    role: ({ request }) => request.method === "GET" || request.method === "PUT" ? "OWNER" : null,
    handler: handleEmailTemplates
  },
  {
    pattern: "/api/settings/branding",
    role: ({ request }) => request.method === "PUT" ? "OWNER" : null,
    handler: handleBrandingSettings
  },
  {
    pattern: "/api/settings/branding/logo",
    role: ({ request }) => request.method === "PUT" || request.method === "DELETE" ? "OWNER" : null,
    handler: handleAdminBrandingLogoSettings
  },
  {
    pattern: "/api/settings/branding/donor-logo",
    role: ({ request }) => request.method === "PUT" || request.method === "DELETE" ? "OWNER" : null,
    handler: handleDonorBrandingLogoSettings
  },
  {
    pattern: "/api/settings/alert-email",
    role: ({ request }) => request.method === "GET" || request.method === "PUT" ? "OWNER" : null,
    handler: handleAlertEmailSetting
  }
];
```

Remove the now-table-owned `requireRole` calls from the delegated helpers and use `ctx.actor` on supported methods. Retain each helper's internal method switch and 405 response. Unsupported methods intentionally return 405 without a role check for emission-environment, email templates, branding, logo, and alert-email, matching the current source; credentials and writer-token remain OWNER-guarded before their method checks.

- [ ] **Step 2: Verify**

Run `workerFetch.test.ts` (513/513) and full gates (1,480/2). Check wrong-method settings remain guarded 405, not final 404.

- [ ] **Step 3: Commit**

```bash
rtk git add src/worker/index.ts
rtk git commit -m "refactor: table-drive credential and settings routes"
```

### Task 5: Wompi issuance and fiscal-correction precedence

**Files:**
- Modify: `src/worker/index.ts:1104-1179,1428-1521`
- Test: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Produces rows 16-17 and 36-39:
  - GET `/api/wompi-events/issuance-failures`
  - POST `/api/wompi-events/:id/retry`
  - GET `/api/wompi-events/:id/correction-data`
  - POST `/api/wompi-events/:id/correct-and-retry`
  - GET `/api/documents/:id/correction-data`
  - POST `/api/documents/:id/correct-and-retry`

- [ ] **Step 1: Convert issuance and correction routes**

```ts
const wompiIssuanceRoutes: Array<Route<ApiRouteContext>> = [
  { method: "GET", pattern: "/api/wompi-events/issuance-failures", role: "VIEWER", handler: handleWompiIssuanceFailures },
  { method: "POST", pattern: /^\/api\/wompi-events\/([^/]+)\/retry$/, role: "OPERATOR", handler: handleWompiIssuanceRetry }
];

const correctionRoutes: Array<Route<ApiRouteContext>> = [
  { method: "GET", pattern: /^\/api\/wompi-events\/([^/]+)\/correction-data$/, role: "OPERATOR", handler: handleWompiCorrectionData },
  { method: "POST", pattern: /^\/api\/wompi-events\/([^/]+)\/correct-and-retry$/, role: "OPERATOR", handler: handleWompiCorrectionRetry },
  { method: "GET", pattern: /^\/api\/documents\/([^/]+)\/correction-data$/, role: "OPERATOR", handler: handleDocumentCorrectionData },
  { method: "POST", pattern: /^\/api\/documents\/([^/]+)\/correct-and-retry$/, role: "OPERATOR", handler: handleDocumentCorrectionRetry }
];
```

Keep the four correction-specific rows ahead of the generic document route. Do not change claim/idempotency/queue/audit logic or logged Wompi error shapes.

- [ ] **Step 2: Verify**

Run `workerFetch.test.ts` (513/513) and full gates (1,480/2). Pay particular attention to guarded correction and document authorization-order cases.

- [ ] **Step 3: Commit**

```bash
rtk git add src/worker/index.ts
rtk git commit -m "refactor: table-drive Wompi and correction routes"
```

### Task 6: Document list, donation admin, and generic document delegate

**Files:**
- Modify: `src/worker/index.ts:1088-1103,1522-1537`
- Test: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Produces rows 14-15 and 40:
  - GET `/api/documents`
  - GET `/api/donations/intents`
  - path-first `/api/documents/:id` with optional `/:action`

- [ ] **Step 1: Convert the two list routes**

```ts
const documentListRoutes: Array<Route<ApiRouteContext>> = [
  { method: "GET", pattern: "/api/documents", role: "VIEWER", handler: handleDocumentList },
  { method: "GET", pattern: "/api/donations/intents", role: "VIEWER", handler: handleDonationIntentList }
];
```

- [ ] **Step 2: Convert the generic route as one path-first delegate**

```ts
const genericDocumentRoute: Route<ApiRouteContext> = {
  pattern: /^\/api\/documents\/([^/]+)(?:\/([^/]+))?$/,
  role: documentRouteRole,
  handler: handleGenericDocument
};
```

`documentRouteRole` returns OPERATOR only for the existing email/resend/retry/invalidate mutation combinations and VIEWER otherwise. Keep lookup after authorization and retain `handleDocumentRoute`'s internal 405.
Pass `ctx.actor` into `handleDocumentRoute` and remove only its now-table-owned `requireRole` call.

- [ ] **Step 3: Verify**

Run `workerFetch.test.ts` (513/513) and full gates (1,480/2). Verify correction routes still win before the generic matcher.

- [ ] **Step 4: Commit**

```bash
rtk git add src/worker/index.ts
rtk git commit -m "refactor: table-drive document routes"
```

### Task 7: Retention, backups, exports, and annual certificates

**Files:**
- Modify: `src/worker/index.ts:1212-1427`
- Test: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Produces ordered rows 26-35 for retention export, backup list/verify/download/download-all, F960 JSON/CSV/XLSX, contacts CSV, and annual certificate preview/send.

- [ ] **Step 1: Convert the eleven admin route rows in existing order**

Use method-constrained rows and fixed ADMIN/OWNER roles. Preserve the exact month regex `YYYY-MM`, table allowlist, attachment headers, PII-safe audit timing, archive-size limit, export filter validation, and certificate year/send branching.

```ts
const exportRoutes: Array<Route<ApiRouteContext>> = [
  { method: "POST", pattern: "/api/admin/retention-export", role: "OWNER", handler: handleRetentionExport },
  { method: "GET", pattern: "/api/admin/backups", role: "ADMIN", handler: handleBackupList },
  { method: "POST", pattern: /^\/api\/admin\/backups\/(\d{4}-\d{2})\/verify$/, role: "ADMIN", handler: handleBackupVerify },
  { method: "GET", pattern: /^\/api\/admin\/backups\/(\d{4}-\d{2})\/download$/, role: "ADMIN", handler: handleBackupDownload },
  { method: "GET", pattern: /^\/api\/admin\/backups\/(\d{4}-\d{2})\/download-all$/, role: "ADMIN", handler: handleBackupDownloadAll },
  { method: "GET", pattern: "/api/exports/f960", role: "ADMIN", handler: handleF960Selection },
  { method: "GET", pattern: "/api/exports/f960.csv", role: "ADMIN", handler: handleF960Csv },
  { method: "GET", pattern: "/api/exports/f960.xlsx", role: "ADMIN", handler: handleF960Xlsx },
  { method: "GET", pattern: "/api/exports/contacts", role: "ADMIN", handler: handleContactsExport },
  { method: "GET", pattern: "/api/certificates/annual", role: "ADMIN", handler: handleAnnualCertificatePreview },
  { method: "POST", pattern: "/api/certificates/annual/send", role: "ADMIN", handler: handleAnnualCertificateSend }
];
```

Keep preview and send as separate method-constrained rows; wrong methods and near-miss paths must continue to final 404.

- [ ] **Step 2: Verify**

Run `workerFetch.test.ts` (513/513) and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add src/worker/index.ts
rtk git commit -m "refactor: table-drive export and backup routes"
```

### Task 8: Audit, analytics, contingency, and test-DTE routes

**Files:**
- Modify: `src/worker/index.ts:1538-1648`
- Test: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Produces rows 41-46:
  - GET `/api/audit`
  - GET `/api/analytics`
  - GET `/api/contingency`
  - POST `/api/test/dte`
  - POST `/api/test/dte/advanced-template`
  - POST `/api/test/dte/advanced`

- [ ] **Step 1: Convert the six routes mechanically**

```ts
const operationsRoutes: Array<Route<ApiRouteContext>> = [
  { method: "GET", pattern: "/api/audit", role: "VIEWER", handler: handleAudit },
  { method: "GET", pattern: "/api/analytics", role: "VIEWER", handler: handleAnalytics },
  { method: "GET", pattern: "/api/contingency", role: "VIEWER", handler: handleContingency },
  { method: "POST", pattern: "/api/test/dte", role: "OPERATOR", handler: handleTestDte },
  { method: "POST", pattern: "/api/test/dte/advanced-template", role: "OPERATOR", handler: handleAdvancedTemplate },
  { method: "POST", pattern: "/api/test/dte/advanced", role: "OPERATOR", handler: handleAdvancedDte }
];
```

Preserve audit projection by actor role, analytics validation/capacity status, read-only contingency behavior, non-production direct-generation guard, sequence allocation, preview no-write behavior, audits, and queue sends.

- [ ] **Step 2: Verify**

Run `workerFetch.test.ts` (513/513) and full gates (1,480/2).

- [ ] **Step 3: Commit**

```bash
rtk git add src/worker/index.ts
rtk git commit -m "refactor: table-drive operational routes"
```

### Task 9: User routes and final single-table dispatch

**Files:**
- Modify: `src/worker/index.ts:1649-1766`
- Test: `test/worker/workerFetch.test.ts`

**Interfaces:**
- Produces rows 47-50:
  - GET `/api/users`
  - POST `/api/users`
  - POST `/api/users/:id/password`
  - PATCH `/api/users/:id`

- [ ] **Step 1: Convert the user routes**

```ts
const userRoutes: Array<Route<ApiRouteContext>> = [
  { method: "GET", pattern: "/api/users", role: "ADMIN", handler: handleUserList },
  { method: "POST", pattern: "/api/users", role: "ADMIN", handler: handleUserCreate },
  { method: "POST", pattern: /^\/api\/users\/([^/]+)\/password$/, role: "ADMIN", handler: handleUserPassword },
  { method: "PATCH", pattern: /^\/api\/users\/([^/]+)$/, role: "ADMIN", handler: handleUserUpdate }
];
```

Keep OWNER-target/promotion checks and mapped owner/conflict errors inside handlers.

- [ ] **Step 2: Consolidate the incremental group dispatches into one ordered table**

```ts
const routes: Array<Route<ApiRouteContext>> = [
  ...publicRoutes,
  ...authRoutes,
  ...documentListRoutes,
  ...wompiIssuanceRoutes,
  ...settingsRoutes,
  ...exportRoutes,
  ...correctionRoutes,
  genericDocumentRoute,
  ...operationsRoutes,
  ...userRoutes
];

return (await dispatchRoutes(routes, routeContext, requireRole)) ?? notFound();
```

Use separate Wompi issuance and correction arrays if necessary to place settings/exports between them exactly as in the source. The final flattened order must match rows 1-50 from the research map; do not concatenate groups in a way that reorders rows 16-17, 18-35, 36-39, or 40.

- [ ] **Step 3: Verify final conformance**

Run `router.test.ts` (6/6), `workerFetch.test.ts` (513/513), and full gates (1,480 passed / 2 skipped). Confirm `src/worker/index.ts` has no sequential `url.pathname` API dispatch branches left inside `handleApi`.

- [ ] **Step 4: Commit**

```bash
rtk git add src/worker/index.ts
rtk git commit -m "refactor: complete declarative API route table"
```

---

**Final deliverable:** nine reviewed commits, one ordered table covering the 50 live `handleApi` branches (51 route rows because annual preview/send are separate), unchanged 404/405/auth precedence, 513/513 worker conformance tests, 1,480/2 full-suite count, and no production or deployment action.
