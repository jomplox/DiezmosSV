import { expect, test } from "@playwright/test";
import {
  restoreFiscalCorrectionDialogFocus,
  trapFiscalCorrectionDialogFocus
} from "../src/client/fiscalCorrectionDialog";

test("fiscal correction focus wraps from the container and restores its opener", async ({ page }) => {
  const trapSource = trapFiscalCorrectionDialogFocus.toString();
  const restoreSource = restoreFiscalCorrectionDialogFocus.toString();

  await page.setContent(`
    <button id="opener">Open correction</button>
    <section id="dialog" tabindex="-1" role="dialog">
      <button id="first">First</button>
      <input id="middle">
      <button id="last">Last</button>
    </section>
    <button id="outside">Outside</button>
  `);

  const result = await page.evaluate(({ trapSource, restoreSource }) => {
    const trap = new Function(`return (${trapSource})`)() as (
      dialog: HTMLElement,
      event: KeyboardEvent
    ) => void;
    const restore = new Function(`return (${restoreSource})`)() as (
      opener: HTMLElement | null
    ) => void;
    const opener = document.querySelector<HTMLElement>("#opener")!;
    const dialog = document.querySelector<HTMLElement>("#dialog")!;
    const first = document.querySelector<HTMLElement>("#first")!;
    const last = document.querySelector<HTMLElement>("#last")!;
    const outside = document.querySelector<HTMLElement>("#outside")!;

    opener.focus();
    const rememberedOpener = document.activeElement as HTMLElement;
    dialog.focus();

    const initialShiftTab = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true
    });
    trap(dialog, initialShiftTab);
    const afterInitialShiftTab = (document.activeElement as HTMLElement).id;

    const finalTab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true
    });
    trap(dialog, finalTab);
    const afterFinalTab = (document.activeElement as HTMLElement).id;

    outside.focus();
    const escapedTab = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true
    });
    trap(dialog, escapedTab);
    const afterEscapedTab = (document.activeElement as HTMLElement).id;

    restore(rememberedOpener);
    return {
      afterInitialShiftTab,
      afterFinalTab,
      afterEscapedTab,
      afterRestore: (document.activeElement as HTMLElement).id,
      initialPrevented: initialShiftTab.defaultPrevented,
      finalPrevented: finalTab.defaultPrevented,
      escapedPrevented: escapedTab.defaultPrevented,
      firstId: first.id
    };
  }, { trapSource, restoreSource });

  expect(result).toEqual({
    afterInitialShiftTab: "last",
    afterFinalTab: "first",
    afterEscapedTab: "first",
    afterRestore: "opener",
    initialPrevented: true,
    finalPrevented: true,
    escapedPrevented: true,
    firstId: "first"
  });
});
