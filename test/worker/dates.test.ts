import { describe, expect, it } from "vitest";
import { cdeInvalidationDeadline, isWithinDeadline } from "../../src/worker/utils/dates";

describe("CDE legal windows", () => {
  it("computes four local calendar days after the CDE sello", () => {
    const deadline = cdeInvalidationDeadline("2026-06-15T18:00:00.000Z");

    expect(deadline).toBe("2026-06-20T05:59:59.000Z");
    expect(isWithinDeadline(deadline, new Date("2026-06-20T05:59:59.000Z"))).toBe(true);
    expect(isWithinDeadline(deadline, new Date("2026-06-20T06:00:00.000Z"))).toBe(false);
  });
});
