import { describe, expect, it } from "vitest";
import { formatCents } from "../../src/shared/money";

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
