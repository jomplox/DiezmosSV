import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");
const stylesSource = readFileSync(resolve(import.meta.dirname, "../../src/client/styles.css"), "utf8");

describe("keyboard accessibility contract", () => {
  it("gives the toast a polite status live region that stays mounted", () => {
    expect(appSource).toContain('<div className="toast-region" role="status" aria-live="polite">');
    expect(appSource).toContain('<button className="toast" onClick={() => setToast("")}>');
  });

  it("wires useDialogDismiss into the four dialogs", () => {
    const callSites = appSource.match(/useDialogDismiss\(dialogRef/g) ?? [];
    expect(callSites.length).toBeGreaterThanOrEqual(4);
    const occurrences = appSource.match(/useDialogDismiss\(/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(5);
  });

  it("gives the fiscal correction dialog modal semantics and keyboard dismissal", () => {
    const fiscalCorrectionSource = readFileSync(
      resolve(import.meta.dirname, "../../src/client/fiscalCorrectionDialog.tsx"),
      "utf8"
    );

    expect(fiscalCorrectionSource).toContain('role="dialog"');
    expect(fiscalCorrectionSource).toContain('aria-modal="true"');
    expect(fiscalCorrectionSource).toContain('aria-labelledby="fiscal-correction-title"');
    expect(fiscalCorrectionSource).toContain('event.key === "Escape"');
    expect(fiscalCorrectionSource).toContain('event.key !== "Tab"');
    expect(fiscalCorrectionSource).toContain("previouslyFocusedRef");
    expect(fiscalCorrectionSource).toContain(
      "document.activeElement instanceof HTMLElement"
    );
    expect(fiscalCorrectionSource).toContain(
      "restoreFiscalCorrectionDialogFocus(previouslyFocusedRef.current)"
    );
    expect(fiscalCorrectionSource).toContain('document.addEventListener("focusin"');
  });

  it("labels the quick-DTE Monto input for screen readers", () => {
    expect(appSource).toContain('aria-label="Monto"');
  });

  it("labels the quick-DTE catalog select in Spanish usted copy", () => {
    expect(appSource).toContain('ariaLabel="Tipo de documento del donante"');
  });

  it("defines a global focus-visible ring after the outline reset", () => {
    const resetIndex = stylesSource.indexOf("outline: 0");
    const focusRingIndex = stylesSource.indexOf(
      "input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible"
    );
    expect(resetIndex).toBeGreaterThan(-1);
    expect(focusRingIndex).toBeGreaterThan(resetIndex);
    // The focus ring now tracks the white-label accent (var(--accent, …)) so it stays
    // legible against any church's brand color; the historical teal is the fallback.
    expect(stylesSource).toContain("outline: 2px solid var(--accent, #0f766e);");
    expect(stylesSource).toContain("outline-offset: 2px;");
  });
});
