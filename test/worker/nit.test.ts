import { describe, expect, it } from "vitest";
import { cleanNit, formatNit, isValidNitFormat } from "../../src/shared/nit";

describe("NIT helpers", () => {
  it("strips every non-digit when cleaning", () => {
    expect(cleanNit("0614-280390-112-1")).toBe("06142803901121");
    expect(cleanNit(" 0614 280390 112 1 ")).toBe("06142803901121");
    expect(cleanNit(null)).toBe("");
    expect(cleanNit(undefined)).toBe("");
  });

  it("accepts exactly 14 digits after stripping separators (format-only, no check digit)", () => {
    expect(isValidNitFormat("06142803901121")).toBe(true);
    expect(isValidNitFormat("0614-280390-112-1")).toBe(true);
    // Deliberately format-only: a NIT whose (hypothetical) verifier digit is wrong
    // must still pass, because MH validates NITs server-side and a homebrew
    // checksum would reject valid NITs.
    expect(isValidNitFormat("06142803901129")).toBe(true);
  });

  it("rejects lengths other than 14 digits", () => {
    expect(isValidNitFormat("0614280390112")).toBe(false); // 13
    expect(isValidNitFormat("061428039011211")).toBe(false); // 15
    expect(isValidNitFormat("10000001-9")).toBe(false); // a DUI is not a NIT here
    expect(isValidNitFormat("")).toBe(false);
    expect(isValidNitFormat(null)).toBe(false);
    expect(isValidNitFormat(undefined)).toBe(false);
  });

  it("formats canonically as XXXX-XXXXXX-XXX-X (matching the PDF document formatter)", () => {
    expect(formatNit("06142803901121")).toBe("0614-280390-112-1");
    // Already-hyphenated input round-trips unchanged.
    expect(formatNit("0614-280390-112-1")).toBe("0614-280390-112-1");
  });
});
