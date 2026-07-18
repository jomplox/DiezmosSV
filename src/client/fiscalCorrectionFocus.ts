export function trapFiscalCorrectionDialogFocus(
  dialog: HTMLElement,
  event: KeyboardEvent
): void {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter(
    (element) =>
      !element.hidden && element.getAttribute("aria-hidden") !== "true"
  );
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = dialog.ownerDocument.activeElement;
  const activeIndex = focusable.indexOf(active as HTMLElement);
  if (
    event.shiftKey
      ? active === dialog || activeIndex <= 0 || !dialog.contains(active)
      : active === dialog
        || activeIndex === -1
        || activeIndex === focusable.length - 1
        || !dialog.contains(active)
  ) {
    event.preventDefault();
    (event.shiftKey ? last : first).focus();
  }
}

export function restoreFiscalCorrectionDialogFocus(
  opener: HTMLElement | null
): void {
  if (opener?.isConnected) opener.focus();
}
