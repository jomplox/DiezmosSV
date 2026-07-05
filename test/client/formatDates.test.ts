import { describe, expect, it } from "vitest";
import { formatElSalvadorDate } from "../../src/shared/legalWindows";

describe("formatElSalvadorDate", () => {
  it("renders the El Salvador local date as dd/mm/yyyy", () => {
    // UTC July 5 02:30 is July 4 in El Salvador (UTC-6).
    expect(formatElSalvadorDate("2026-07-05T02:30:00.000Z")).toBe("04/07/2026");
  });

  it("renders a same-day UTC date unaffected by the offset", () => {
    expect(formatElSalvadorDate("2026-12-25T18:00:00.000Z")).toBe("25/12/2026");
  });
});
