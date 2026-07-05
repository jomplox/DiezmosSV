export function openNativeDatePicker(input: HTMLInputElement | null): boolean {
  if (typeof input?.showPicker !== "function") {
    return false;
  }

  try {
    input.showPicker();
    return true;
  } catch {
    // Some browsers reject showPicker outside a trusted click; normal input behavior still works.
    return false;
  }
}
