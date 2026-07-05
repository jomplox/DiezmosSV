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
    expect(stylesSource).toContain("outline: 2px solid #007c75;");
    expect(stylesSource).toContain("outline-offset: 2px;");
  });
});
