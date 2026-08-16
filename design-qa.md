# Mobile provider-step design QA

## Evidence

- Source visual truth:
  - `/tmp/codex-remote-attachments/01a00071-d89d-7822-bf14-11486cadac5e/F2C45913-D5F5-4864-B81A-4C4DBF22C01C/1-Photo-1.jpg`
  - `/tmp/codex-remote-attachments/01a00071-d89d-7822-bf14-11486cadac5e/F2C45913-D5F5-4864-B81A-4C4DBF22C01C/2-Photo-2.jpg`
- Browser-rendered implementation:
  - `/tmp/diezmos-compact-givebutter-mobile.png`
  - `/tmp/diezmos-compact-stripe-mobile-latest.png`
- Side-by-side comparisons:
  - `/tmp/diezmos-compare-givebutter.png`
  - `/tmp/diezmos-compare-stripe-latest.png`
- Viewport: `393 x 852` CSS px, light theme, U.S. provider step, fixed provider switcher visible.
- Source pixels: `588 x 1280` (approximately 1.5x density). The source was normalized to `393 x 852` before comparison.
- Implementation pixels: `393 x 852`, device scale factor 1.
- State note: the source uses mobile Safari with the live provider forms; the implementation uses Chromium with the repository's provider fixtures. Provider-owned content is intentionally different, so the comparison is limited to the app-owned header, summary, disclosure, provider boundary, and fixed switcher.

## Full-view comparison

The source Stripe state spends roughly the first half of the visible app area on the ceremonial header, summary, and disclosure before the hosted form begins. The source Givebutter state must be scrolled past that chrome before a useful part of the provider form is visible. In the implementation, the full `Diezmos y Ofrendas` H1 remains present while the shield, title, step label, summary, and disclosure use a compact provider-only rhythm. Both provider boundaries begin substantially higher, and the fixed switcher remains below the form without obscuring the measured visible slice.

## Required fidelity surfaces

- Fonts and typography: existing Gotham family and weight hierarchy are unchanged. The provider-step H1 is reduced from 24px to 20px only below 520px; it remains the primary H1 and stays on one line at the target viewport.
- Spacing and layout rhythm: provider-only mobile padding and gaps are reduced. The provider viewport is 720px at the target viewport, compared with 528px before the change. Browser assertions require at least 640px of independent provider height and at least 360px visible above the fixed switcher for both Stripe and Givebutter.
- Colors and visual tokens: white, black, gray borders, and provider-brand accents are unchanged.
- Image quality and asset fidelity: the existing shield and flag assets are reused at smaller provider-step dimensions; no replacement or generated asset was introduced.
- Copy and content: donor-facing copy, legal disclosure, support contact, provider labels, and the `Diezmos y Ofrendas` title are unchanged.

## Comparison history

### Pass 1 — blocked

- P1: provider form receives too little mobile space.
- Evidence: the regression test measured a 528px provider viewport and only 296px visible above the fixed switcher at `393 x 852`.
- Fix: apply compact geometry only to the U.S. provider step and increase its mobile provider viewport with small-viewport units.

### Pass 2 — passed

- The ceremonial H1 remains intact and visually primary.
- Both provider states meet the 640px provider-height and 360px initially-visible minimums.
- The switcher remains fixed, readable, and non-overlapping.
- No actionable P0, P1, or P2 mismatch remains within the app-owned surface.

## Focused-region comparison

No additional crop was needed: the 393px full-view captures render the title, disclosure, provider start, and dock at readable size, and those are the complete affected region.

## Follow-up polish

- P3: verify the final metrics once in mobile Safari against the live cross-origin providers before a production release, because the local fixtures cannot reproduce provider-owned typography or browser chrome.

final result: passed
