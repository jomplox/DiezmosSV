# Wompi Iframe Resize Motion Design

**Date:** 2026-07-20

**Status:** Approved in conversation; pending review of this written specification.

## Objective

Make the embedded Wompi form's two step-to-step height changes feel quick and
crisp while preserving the existing automatic sizing and payment reliability.

## Current behavior and cause

Wompi sends a trusted `sizeUpdate` message whenever its embedded checkout
content changes height. The SV donor page validates the message origin, adds
Wompi's 35-pixel allowance, clamps the result, and applies the exact height to
the iframe.

Across the embedded form flow, Wompi reports height changes at the two observed
step transitions. The iframe currently applies a generic `200ms ease`
transition to every accepted update, so both movements have a slow tail and the
repeated resize motion feels awkward. The message handling itself is behaving
correctly.

## Considered approaches

### 1. Short CSS-only transition — selected

Change only the iframe's height transition to:

```css
transition: height 120ms cubic-bezier(0.2, 0, 0, 1);
```

Every Wompi update remains authoritative and reaches its exact target height.
The shorter duration and fast-starting ease-out curve make each movement settle
promptly without adding timing logic to the integration.

### 2. Adaptive duration in JavaScript

Choose a duration from the height difference and pass it to CSS. This could
fine-tune large and small changes independently, but it adds state and branching
for a transition that has only two observed changes.

### 3. Coalesce consecutive height messages

Buffer or debounce Wompi's updates so the page animates fewer movements. This
was rejected because it would delay or discard authoritative third-party sizing
messages and could leave the iframe temporarily at a stale height.

## Reliability and accessibility contract

The change is presentation-only. It must not alter:

- the strict `https://pagos.wompi.sv` origin check;
- JSON parsing and message filtering;
- the 35-pixel Wompi allowance;
- the 320-to-2400-pixel height clamp;
- iframe loading, close verification, intent polling, or payment state;
- the final height reported by each accepted `sizeUpdate`.

The existing `prefers-reduced-motion: reduce` rule continues disabling the
height transition entirely.

## Implementation boundary

Production code changes only in `src/client/styles.css`. No React state,
message handler, iframe attributes, Worker route, API, database, or payment
logic changes.

`test/client/donarPage.test.ts` will pin the selected duration and easing curve
as part of the donor-page style contract. The existing origin, clamp,
reduced-motion, and Wompi-close regression coverage remains in force.

The donor Playwright suite will exercise two sequential trusted `sizeUpdate`
messages and verify that the iframe reaches each exact final height. The test
will assert outcomes rather than animation timing to avoid a flaky wall-clock
test.

## Verification and release

Verification will include:

- a RED focused test before the CSS change;
- the focused donor-page unit test after implementation;
- the SV donor Playwright flow, including both sequential height updates;
- TypeScript checks, build, and the complete relevant test suite;
- rendered desktop and mobile QA with no relevant console errors;
- staging-only deployment after exact-SHA CI succeeds.

Production remains untouched. Rendered staging QA will not submit a real
payment or create avoidable donor records.

## Non-goals

- Hiding or combining Wompi's two internal form transitions.
- Replacing Wompi's height messages with guessed fixed sizes.
- Changing the iframe border, card layout, copy, loading states, or fallback
  link.
- Modifying payment confirmation or the recently repaired close-verification
  behavior.
