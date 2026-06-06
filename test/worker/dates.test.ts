import { describe, expect, it } from "vitest";
import { cdeInvalidationDeadline, isWithinDeadline } from "../../src/worker/utils/dates";

describe("CDE legal windows", () => {
  it("computes the tenth business day of the month after the sello", () => {
    const deadline = cdeInvalidationDeadline("2026-06-15T18:00:00.000Z");

    expect(deadline.startsWith("2026-07-14")).toBe(true);
    expect(isWithinDeadline(deadline, new Date("2026-07-14T12:00:00.000Z"))).toBe(true);
    expect(isWithinDeadline(deadline, new Date("2026-07-15T00:00:00.000Z"))).toBe(false);
  });
});
