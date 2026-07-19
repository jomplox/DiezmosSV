import { describe, expect, it } from "vitest";
import { elSalvadorDateOnly } from "../../src/shared/legalWindows";

describe("elSalvadorDateOnly", () => {
  it("maps an early-UTC instant to the previous El Salvador date", () => {
    // 03:00Z is 21:00 of the previous day in El Salvador (UTC-6, no DST).
    expect(elSalvadorDateOnly("2026-07-19T03:00:00.000Z")).toBe("2026-07-18");
  });

  it("keeps a mid-day UTC instant on the same El Salvador date", () => {
    expect(elSalvadorDateOnly("2026-07-19T18:00:00.000Z")).toBe("2026-07-19");
  });

  it("crosses the year boundary correctly", () => {
    expect(elSalvadorDateOnly("2027-01-01T05:59:59.000Z")).toBe("2026-12-31");
    expect(elSalvadorDateOnly("2027-01-01T06:00:00.000Z")).toBe("2027-01-01");
  });
});
