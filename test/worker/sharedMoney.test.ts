import { describe, expect, it } from "vitest";
import { formatCents, formatCount, formatUsdAmount } from "../../src/shared/money";

describe("formatCents", () => {
  it("formats cents below a dollar boundary with two decimals", () => {
    expect(formatCents(2550)).toBe("$25.50");
  });

  it("adds thousands separators at and above $1,000", () => {
    expect(formatCents(123456)).toBe("$1,234.56");
  });

  it("formats zero as $0.00", () => {
    expect(formatCents(0)).toBe("$0.00");
  });
});

describe("formatUsdAmount", () => {
  // Decimal-dollar strings ("152410.00") come from F960 rows and form inputs; the CSV
  // keeps them plain, the screen shows them in the canonical "$1,234.56" format.
  it("formats a decimal-dollar string with thousands separators", () => {
    expect(formatUsdAmount("152410.00")).toBe("$152,410.00");
    expect(formatUsdAmount("1234567.8")).toBe("$1,234,567.80");
    expect(formatUsdAmount("0.29")).toBe("$0.29");
  });

  it("formats a decimal-dollar number the same way", () => {
    expect(formatUsdAmount(1500)).toBe("$1,500.00");
  });

  it("formats an empty amount as $0.00", () => {
    expect(formatUsdAmount("")).toBe("$0.00");
  });

  it("shows text that is not a number as typed rather than inventing a value", () => {
    expect(formatUsdAmount("abc")).toBe("$abc");
  });
});

describe("formatCount", () => {
  it("adds thousands separators to whole counts", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(360)).toBe("360");
    expect(formatCount(12345)).toBe("12,345");
  });
});
