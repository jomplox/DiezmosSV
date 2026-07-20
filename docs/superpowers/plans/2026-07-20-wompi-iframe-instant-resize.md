# Wompi Iframe Instant Resize Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the embedded Wompi form from moving beneath the donor's pointer by applying every accepted height update instantly.

**Architecture:** Keep the existing origin-checked Wompi `sizeUpdate` listener, height allowance, clamp, and payment flow unchanged. Replace only the base `.donar-embed` height transition with `transition: none`, pin that presentation contract in the existing donor-page test, and reuse the existing two-height Playwright regression.

**Tech Stack:** React 19, TypeScript 7, CSS, Vitest 4, Playwright 1.61, Cloudflare Workers/Wrangler 4.

## Global Constraints

- Change production code only in `src/client/styles.css`.
- Do not change the Wompi origin check, JSON parsing, 35-pixel allowance, 320-to-2400-pixel clamp, iframe attributes, intent polling, close verification, or payment state.
- Use exactly `transition: none;` in the base `.donar-embed` rule.
- Keep the existing `prefers-reduced-motion: reduce` override unchanged.
- Add no dependencies and do not change unrelated donor-page styling or copy.
- Work directly on `main` because the user explicitly approved it and requires only `main` to remain.
- Push only after exact local verification succeeds.
- Deploy only to Cloudflare staging after exact-SHA GitHub CI succeeds; production remains untouched.
- Do not run the mutating staging smoke test or submit a real payment during rendered QA.

---

### Task 1: Make Wompi iframe height updates instant

**Files:**
- Modify: `test/client/donarPage.test.ts:973-1011`
- Modify: `src/client/styles.css:3900-3907`
- Verify: `e2e/donar.spec.ts:255-270`

**Interfaces:**
- Consumes: the existing `.donar-embed` CSS rule, `stylesSource` source-contract fixture, and origin-checked Wompi `sizeUpdate` handler.
- Produces: immediate application of every accepted iframe height with no CSS interpolation and no runtime interface changes.

- [ ] **Step 1: Write the failing style-contract assertion**

Replace the animated-transition assertions in `test/client/donarPage.test.ts` with:

```ts
const embedRule = stylesSource.match(/\.donar-embed\s*\{[^}]*\}/)?.[0] ?? "";
expect(embedRule).toContain("transition: none;");
expect(embedRule).not.toContain("transition: height 120ms cubic-bezier(0.2, 0, 0, 1);");
```

Keep the separate reduced-motion assertion unchanged.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
rtk npx vitest run test/client/donarPage.test.ts -t "auto-sizes the embedded checkout"
```

Expected: FAIL because the base `.donar-embed` rule still contains the 120-millisecond transition instead of `transition: none;`.

- [ ] **Step 3: Implement the one-line CSS fix**

Change only the transition declaration in `src/client/styles.css`:

```css
.donar-embed {
  width: 100%;
  height: min(78vh, 820px);
  transition: none;
  border: 1px solid #e5e5e5;
  border-radius: 12px;
  background: #ffffff;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
rtk npx vitest run test/client/donarPage.test.ts -t "auto-sizes the embedded checkout"
```

Expected: the focused test passes.

- [ ] **Step 5: Verify the complete donor unit and browser contracts**

Run serially:

```bash
rtk npx vitest run test/client/donarPage.test.ts
rtk npx playwright test e2e/donar.spec.ts
```

Expected: all donor-page unit tests and all donor Playwright tests pass, including the two sequential Wompi heights of 465px and 745px.

- [ ] **Step 6: Verify the complete local quality gate**

Run serially:

```bash
rtk env MINIFLARE_CACHE_DIR=/private/tmp/diezmos-wompi-instant-verify-cache npm test
rtk npm run typecheck
rtk npm run types:check
rtk npm run build
rtk npm run security:check-private-boundary
rtk git diff --check
```

Expected: 0 failures, successful type checks and build, a clean private-artifact boundary, and no whitespace errors.

- [ ] **Step 7: Commit the implementation**

```bash
rtk git add test/client/donarPage.test.ts src/client/styles.css
rtk git commit -m "fix: make Wompi iframe resizing instant"
```

## Release and staging verification

After Task 1 passes independent review:

1. Push `main` and verify GitHub Actions succeeds for the exact pushed SHA.
2. Run `rtk npx wrangler deploy --env staging --keep-vars --dry-run` and confirm every displayed binding is staging-scoped.
3. Deploy with `rtk npx wrangler deploy --env staging --keep-vars --message "git_sha=$(rtk git rev-parse HEAD)"`.
4. Verify Cloudflare staging serves 100% of traffic from the new version and production's deployment/version IDs remain unchanged.
5. Perform read-only desktop and mobile QA on `/donar?ruta=sv`, confirm the loaded `.donar-embed` rule is `transition: none`, and confirm no relevant console errors or warnings.
6. Confirm the live CSS asset byte-matches the verified local build.
7. Remove generated local Wrangler account cache data, rerun `security:check-private-boundary`, and prove `main == origin/main`, only `main` exists locally and remotely, no PR is open, and the worktree is clean.
