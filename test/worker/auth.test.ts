import { describe, expect, it } from "vitest";
import { hashPassword } from "../../src/worker/services/auth";

describe("auth password hashing", () => {
  it("hashes deterministically with an explicit salt", async () => {
    const first = await hashPassword("long-enough-password", "fixed-salt");
    const second = await hashPassword("long-enough-password", "fixed-salt");

    expect(first).toEqual(second);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects short passwords", async () => {
    await expect(hashPassword("short")).rejects.toThrow(/at least 10/);
  });
});
