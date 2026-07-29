// Cold-load reveal coordination for the donor page.
//
// index.html hides #root on the donor route and React reveals it by setting
// data-donor-ready. That gate originally waited only on document.fonts.ready, which
// stopped the unstyled-text flash but not the branded one: /api/branding resolves after
// the page is already visible, so the built-in default vector was swapped for the church's
// donor logo (a real network image) and the support line changed — two visible reflows
// on every cold load.
//
// donarPage owns the branding fetch, so it signals here when branding has settled
// (loaded, failed, or given up). main.tsx owns the reveal and waits for both fonts and
// this signal. The signal is a module-level promise rather than React state because the
// reveal happens outside the component tree.

let settle: () => void = () => {};

// Resolves once the donor page's branding-dependent content is in its final form.
export const donorBrandingSettled = new Promise<void>((resolve) => {
  settle = resolve;
});

// Idempotent: whichever of success, failure, or the reveal budget fires first wins.
export function markDonorBrandingSettled(): void {
  settle();
}
