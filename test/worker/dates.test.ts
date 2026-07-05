import { describe, expect, it } from "vitest";
import { cdeInvalidationDeadline, isWithinDeadline } from "../../src/worker/utils/dates";

describe("CDE legal windows", () => {
  it("allows invalidation until the tenth business day of the month after the sello", () => {
    const deadline = cdeInvalidationDeadline("2026-06-15T18:00:00.000Z");

    expect(deadline).toBe("2026-07-15T05:59:59.000Z");
    expect(isWithinDeadline(deadline, new Date("2026-07-15T05:59:59.000Z"))).toBe(true);
    expect(isWithinDeadline(deadline, new Date("2026-07-15T06:00:00.000Z"))).toBe(false);
  });

  it("uses the El Salvador local date of the sello to pick the tax period", () => {
    // 2026-07-01T02:00Z is still 2026-06-30 in El Salvador (UTC-6).
    expect(cdeInvalidationDeadline("2026-07-01T02:00:00.000Z")).toBe("2026-07-15T05:59:59.000Z");
    expect(cdeInvalidationDeadline("2026-07-01T12:00:00.000Z")).toBe("2026-08-15T05:59:59.000Z");
  });

  it("skips weekends when the following month starts on one", () => {
    // August 2026 starts on a Saturday; its tenth business day is Friday the 14th.
    expect(cdeInvalidationDeadline("2026-07-20T18:00:00.000Z")).toBe("2026-08-15T05:59:59.000Z");
  });

  it("rolls the window into January for December sellos", () => {
    // January 2027 starts on a Friday; its tenth business day is Thursday the 14th.
    expect(cdeInvalidationDeadline("2026-12-10T18:00:00.000Z")).toBe("2027-01-15T05:59:59.000Z");
  });
});
