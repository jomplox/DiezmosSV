import { describe, expect, it } from "vitest";
import {
  resolveAuthBootstrapStatus,
  shouldShowBootstrapMode
} from "../../src/client/authBootstrap";

describe("auth bootstrap visibility", () => {
  it("shows owner creation only when bootstrap is explicitly available", () => {
    expect(shouldShowBootstrapMode(null)).toBe(false);
    expect(shouldShowBootstrapMode({ bootstrapAvailable: false })).toBe(false);
    expect(shouldShowBootstrapMode({ bootstrapAvailable: true })).toBe(true);
  });

  it("retries one transient bootstrap-status failure before failing closed", async () => {
    let attempts = 0;
    const result = await resolveAuthBootstrapStatus(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("worker still starting");
      return { bootstrapAvailable: true };
    });

    expect(result).toEqual({ bootstrapAvailable: true });
    expect(attempts).toBe(2);
  });

  it("fails closed when bootstrap status fails twice", async () => {
    let attempts = 0;
    const result = await resolveAuthBootstrapStatus(async () => {
      attempts += 1;
      throw new Error("unavailable");
    });

    expect(result).toEqual({ bootstrapAvailable: false });
    expect(attempts).toBe(2);
  });
});
