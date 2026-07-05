import { describe, expect, it } from "vitest";
import { shouldShowBootstrapMode } from "../../src/client/authBootstrap";

describe("auth bootstrap visibility", () => {
  it("shows owner creation only when bootstrap is explicitly available", () => {
    expect(shouldShowBootstrapMode(null)).toBe(false);
    expect(shouldShowBootstrapMode({ bootstrapAvailable: false })).toBe(false);
    expect(shouldShowBootstrapMode({ bootstrapAvailable: true })).toBe(true);
  });
});
