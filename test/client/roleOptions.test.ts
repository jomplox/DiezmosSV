import { describe, expect, it } from "vitest";
import { roleOptionsFor } from "../../src/client/App";

describe("roleOptionsFor", () => {
  it("never offers OWNER to an ADMIN actor", () => {
    expect(roleOptionsFor({ role: "ADMIN" }).map((option) => option.value)).toEqual([
      "VIEWER",
      "OPERATOR",
      "ADMIN"
    ]);
  });

  it("offers the full list, including OWNER, to an OWNER actor", () => {
    expect(roleOptionsFor({ role: "OWNER" }).map((option) => option.value)).toEqual([
      "VIEWER",
      "OPERATOR",
      "ADMIN",
      "OWNER"
    ]);
  });

  it("hides OWNER when there is no actor", () => {
    expect(roleOptionsFor(null).map((option) => option.value)).not.toContain("OWNER");
  });
});
