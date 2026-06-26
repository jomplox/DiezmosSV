import { describe, expect, it, vi } from "vitest";
import { openNativeDatePicker } from "../../src/client/datePicker";

describe("openNativeDatePicker", () => {
  it("opens the native picker when the date input supports it", () => {
    const showPicker = vi.fn();
    const input = { showPicker } as unknown as HTMLInputElement;

    const opened = openNativeDatePicker(input);

    expect(opened).toBe(true);
    expect(showPicker).toHaveBeenCalledOnce();
  });

  it("returns false when the browser does not expose showPicker", () => {
    const input = {} as HTMLInputElement;

    expect(openNativeDatePicker(input)).toBe(false);
  });

  it("returns false when the browser rejects native picker opening", () => {
    const input = {
      showPicker: () => {
        throw new Error("not activated");
      }
    } as unknown as HTMLInputElement;

    expect(openNativeDatePicker(input)).toBe(false);
  });
});
