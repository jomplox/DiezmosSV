# Wompi Iframe Resize Motion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both observed Wompi iframe height changes feel quick and crisp without changing authoritative sizing, payment state, or close verification.

**Architecture:** Keep the integration logic unchanged: trusted Wompi `sizeUpdate` messages still drive the exact clamped iframe height. Change only the CSS timing curve, pin that presentation contract in Vitest, and extend the existing offline-safe donor Playwright flow to prove two sequential messages still reach their exact final heights.

**Tech Stack:** React 19, TypeScript 7, CSS, Vitest 4, Playwright 1.61, Cloudflare Workers/Wrangler 4.

## Global Constraints

- Use exactly `transition: height 120ms cubic-bezier(0.2, 0, 0, 1);`.
- Do not change the Wompi origin check, JSON parsing, 35-pixel allowance, 320-to-2400-pixel clamp, iframe attributes, intent polling, close verification, or payment state.
- Keep `prefers-reduced-motion: reduce` disabling the height transition entirely.
- Add no dependencies and do not change unrelated donor-page styling or copy.
- Test final heights rather than wall-clock animation timing.
- Deploy only to Cloudflare staging after exact-SHA CI succeeds; production remains untouched.
- Do not run the mutating staging smoke test or submit a real payment during rendered QA.

---

### Task 1: Pin and implement the quick CSS transition

**Files:**
- Modify: `test/client/donarPage.test.ts:973-1010`
- Modify: `src/client/styles.css:3900-3907`

**Interfaces:**
- Consumes: the existing `.donar-embed` CSS rule and `stylesSource` source-contract fixture.
- Produces: a 120-millisecond height transition using `cubic-bezier(0.2, 0, 0, 1)`; no TypeScript or runtime interface changes.

- [ ] **Step 1: Write the failing style-contract assertion**

Extend `it("auto-sizes the embedded checkout from Wompi's sizeUpdate messages")` immediately after the `clampEmbedHeight` assertion:

```ts
const embedRule = stylesSource.match(/\.donar-embed\s*\{[^}]*\}/)?.[0] ?? "";
expect(embedRule).toContain("transition: height 120ms cubic-bezier(0.2, 0, 0, 1);");
expect(embedRule).not.toContain("transition: height 200ms ease;");
```

Strengthen the existing reduced-motion check at the bottom of the test:

```ts
const reducedMotion = stylesSource.indexOf("prefers-reduced-motion");
expect(reducedMotion).toBeGreaterThan(-1);
expect(stylesSource.slice(reducedMotion)).toMatch(
  /\.donar-embed\s*\{\s*transition:\s*none;/
);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
rtk npx vitest run test/client/donarPage.test.ts -t "auto-sizes the embedded checkout"
```

Expected: FAIL because `.donar-embed` still contains `transition: height 200ms ease;`.

- [ ] **Step 3: Implement the CSS-only timing change**

Replace only the transition declaration in `src/client/styles.css`:

```css
.donar-embed {
  width: 100%;
  height: min(78vh, 820px);
  transition: height 120ms cubic-bezier(0.2, 0, 0, 1);
  border: 1px solid #e5e5e5;
  border-radius: 12px;
  background: #ffffff;
}
```

Do not edit the `prefers-reduced-motion` override:

```css
.donar-embed {
  transition: none;
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
rtk npx vitest run test/client/donarPage.test.ts -t "auto-sizes the embedded checkout"
```

Expected: the focused test passes.

- [ ] **Step 5: Run the complete donor-page unit file**

Run:

```bash
rtk npx vitest run test/client/donarPage.test.ts
```

Expected: every test in `test/client/donarPage.test.ts` passes.

- [ ] **Step 6: Commit the CSS behavior and unit contract**

```bash
rtk git add src/client/styles.css test/client/donarPage.test.ts
rtk git commit -m "fix: sharpen Wompi iframe resizing"
```

---

### Task 2: Prove consecutive Wompi heights remain authoritative

**Files:**
- Modify: `e2e/donar.spec.ts:188-260`

**Interfaces:**
- Consumes: the existing offline-safe `"the SV wizard walks monto → datos → Wompi handoff"` test and the origin-checked `sizeUpdate` listener.
- Produces: deterministic browser coverage proving two sequential Wompi height reports render as `reported height + 35px`.

- [ ] **Step 1: Add exact-height interaction coverage to the existing SV flow**

After the existing iframe `src` assertion, dispatch two trusted messages and require each final height:

```ts
for (const { reportedHeight, renderedHeight } of [
  { reportedHeight: 430, renderedHeight: 465 },
  { reportedHeight: 710, renderedHeight: 745 }
]) {
  await page.evaluate((height) => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://pagos.wompi.sv",
        data: JSON.stringify({ message: "sizeUpdate", height })
      })
    );
  }, reportedHeight);
  await expect(embed).toHaveCSS("height", `${renderedHeight}px`);
}
```

Keep the existing fallback-button and `/donar` URL assertions after this block.

- [ ] **Step 2: Run the targeted offline-safe browser test**

Run:

```bash
PW_PERSIST_TO="$(rtk mktemp -d /private/tmp/diezmos-wompi-resize-targeted.XXXXXX)" rtk npx playwright test e2e/donar.spec.ts -g "the SV wizard walks monto"
```

Expected: one Chromium test passes, both height assertions settle at `465px` and `745px`, and no real Wompi request leaves the test sandbox.

- [ ] **Step 3: Run the complete donor browser suite**

Run:

```bash
PW_PERSIST_TO="$(rtk mktemp -d /private/tmp/diezmos-wompi-resize-donor.XXXXXX)" rtk npx playwright test e2e/donar.spec.ts
```

Expected: every test in `e2e/donar.spec.ts` passes.

- [ ] **Step 4: Commit the integration regression**

```bash
rtk git add e2e/donar.spec.ts
rtk git commit -m "test: preserve Wompi iframe height updates"
```

---

### Task 3: Verify, push, and deploy the exact SHA to staging

**Files:**
- Review: `docs/superpowers/specs/2026-07-20-wompi-iframe-resize-motion-design.md`
- Review: `docs/superpowers/plans/2026-07-20-wompi-iframe-resize-motion.md`
- Review: `src/client/styles.css`
- Review: `test/client/donarPage.test.ts`
- Review: `e2e/donar.spec.ts`

**Interfaces:**
- Consumes: the committed implementation and GitHub `CI` workflow.
- Produces: `origin/main` at the exact implementation SHA, successful `test-and-build` and `e2e` jobs, and a staging Worker version annotated with that SHA.

- [ ] **Step 1: Run the complete local verification bundle**

Run serially:

```bash
rtk npm test
rtk npm run typecheck
rtk npm run types:check
rtk npm run build
rtk npm run security:check-private-boundary
rtk git diff --check
```

Expected: every command exits 0, Vitest reports zero failures, generated Worker types are current, the production build succeeds, and the private artifact boundary is clean.

- [ ] **Step 2: Review the surgical delta and commit graph**

Run:

```bash
rtk git status --short --branch
rtk git log -5 --oneline --decorate
rtk git diff origin/main..HEAD --stat
rtk git diff origin/main..HEAD -- src/client/styles.css test/client/donarPage.test.ts e2e/donar.spec.ts
```

Expected: only the approved design, implementation plan, CSS declaration, focused unit assertions, and two-height E2E assertions differ from `origin/main`.

- [ ] **Step 3: Push `main`**

Run:

```bash
rtk git push origin main
```

Expected: `origin/main` advances to the local `main` SHA.

- [ ] **Step 4: Wait for exact-SHA GitHub CI**

Run:

```bash
TASK_SHA="$(rtk git rev-parse HEAD)"
TASK_RUN_ID="$(rtk gh run list --workflow CI --commit "$TASK_SHA" --event push --json databaseId --jq '.[0].databaseId')"
rtk gh run watch "$TASK_RUN_ID" --exit-status
rtk gh run view "$TASK_RUN_ID" --json headSha,status,conclusion,jobs
```

Expected: the run's `headSha` equals `TASK_SHA`, its conclusion is `success`, and both `test-and-build` and `e2e` conclude successfully.

- [ ] **Step 5: Perform a staging-only Wrangler preflight**

Run:

```bash
TASK_SHA="$(rtk git rev-parse HEAD)"
rtk npx wrangler whoami
rtk npm run build
rtk npx wrangler deploy --env staging --keep-vars --dry-run --message "git_sha=$TASK_SHA"
```

Expected: authentication succeeds, the build succeeds, the dry run names `diezmossv-staging-resource-example`, and no production environment is selected.

- [ ] **Step 6: Deploy the exact SHA to Cloudflare staging**

Run:

```bash
TASK_SHA="$(rtk git rev-parse HEAD)"
rtk npx wrangler deploy --env staging --keep-vars --message "git_sha=$TASK_SHA"
```

Expected: deployment succeeds at `https://worker.example.invalid` and returns a new staging version ID.

- [ ] **Step 7: Verify the live staging deployment without writes**

Confirm through Cloudflare's deployment record that 100% of staging traffic points to the new version and its `workers/message` annotation equals `git_sha=$TASK_SHA`.

Run:

```bash
TASK_SHA="$(rtk git rev-parse HEAD)"
rtk curl -fsS https://worker.example.invalid/api/health
rtk curl -fsS "https://worker.example.invalid/donar?ruta=sv&deploy=$TASK_SHA"
```

Expected: health returns `ok: true` with `appEnv: "staging"`, and the donor HTML references the newly built asset.

Using the Browser plugin, perform read-only desktop and mobile checks:

1. Open `/donar?ruta=sv&deploy=$TASK_SHA`.
2. Confirm the page title, meaningful Paso 1 content, and absence of a framework error overlay.
3. Confirm no relevant console errors or warnings.
4. Confirm the loaded stylesheet contains the 120-millisecond `.donar-embed` transition and the reduced-motion override.
5. Do not submit the form, create an intent, run `smoke:staging`, or make a real payment.

- [ ] **Step 8: Clean deployment artifacts and prove the final repository state**

Remove only Wrangler's generated account cache if present, then run:

```bash
rtk rm -f node_modules/.cache/wrangler/wrangler-account.json
rtk npm run security:check-private-boundary
rtk git status --short --branch
rtk git rev-parse HEAD origin/main
```

Expected: the private boundary is clean, the worktree is clean, and `main`, `origin/main`, the successful CI SHA, and the staging deployment annotation all match.
