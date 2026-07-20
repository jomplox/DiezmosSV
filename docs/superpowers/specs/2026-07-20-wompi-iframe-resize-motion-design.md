# Wompi Iframe Instant Resize Design

**Date:** 2026-07-20

**Status:** Approved in conversation; pending review of this written specification.

## Objective

Make the embedded Wompi form's two step-to-step height changes feel quick and
crisp without leaving fields or buttons moving beneath the donor's pointer,
while preserving the existing automatic sizing and payment reliability.

## Current behavior and cause

Wompi sends a trusted `sizeUpdate` message whenever its embedded checkout
content changes height. The SV donor page validates the message origin, adds
Wompi's 35-pixel allowance, clamps the result, and applies the exact height to
the iframe.

Across the embedded form flow, Wompi reports height changes at the two observed
step transitions. The first refinement shortened the iframe transition from
`200ms ease` to `120ms cubic-bezier(0.2, 0, 0, 1)`. Live staging use showed that
even this shorter interpolation leaves the form moving beneath the donor's
pointer, making the donor chase the next field or button. The message handling
and final heights are correct; the remaining delay comes entirely from the CSS
height transition.

## Considered approaches

### 1. Instant CSS-only height updates — selected

Change only the iframe's height transition to:

```css
transition: none;
```

Every Wompi update remains authoritative and reaches its exact target height.
The iframe jumps directly to that height instead of interpolating toward it, so
the next field or button does not continue moving after Wompi changes steps.
The trade-off is a visible but immediate layout jump.

### 2. Fixed iframe height

Keep the iframe at the largest observed height so its outer dimensions never
change. This removes movement but creates unnecessary blank space and can
reintroduce awkward inner scrolling or clipping on smaller viewports.

### 3. Ultra-short transition

Reduce the transition to roughly `40–60ms`. This would be faster than the
current rule, but the form would still move beneath the donor's pointer and
would not fully address the observed usability problem.

## Reliability and accessibility contract

The change is presentation-only. It must not alter:

- the strict `https://pagos.wompi.sv` origin check;
- JSON parsing and message filtering;
- the 35-pixel Wompi allowance;
- the 320-to-2400-pixel height clamp;
- iframe loading, close verification, intent polling, or payment state;
- the final height reported by each accepted `sizeUpdate`.

The existing `prefers-reduced-motion: reduce` rule remains unchanged and
continues declaring `transition: none`.

## Implementation boundary

Production code changes only in `src/client/styles.css`. No React state,
message handler, iframe attributes, Worker route, API, database, or payment
logic changes.

`test/client/donarPage.test.ts` will pin `transition: none` as the donor-page
style contract and reject the superseded animated rule. The existing origin,
clamp, reduced-motion, and Wompi-close regression coverage remains in force.

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

- Animating, hiding, or combining Wompi's two internal form transitions.
- Replacing Wompi's height messages with guessed fixed sizes.
- Changing the iframe border, card layout, copy, loading states, or fallback
  link.
- Modifying payment confirmation or the recently repaired close-verification
  behavior.
