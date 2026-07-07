import { describe, expect, it } from "vitest";
import { hashPassword } from "../../src/worker/services/auth";

describe("auth password hashing", () => {
  it("hashes deterministically with an explicit salt", async () => {
    const first = await hashPassword("Long-enough1!", "fixed-salt");
    const second = await hashPassword("Long-enough1!", "fixed-salt");

    expect(first).toEqual(second);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives at the restored 150k work factor by default and keeps the legacy 100k distinct", async () => {
    const current = await hashPassword("Long-enough1!", "fixed-salt", { iterations: 150_000 });
    const legacy = await hashPassword("Long-enough1!", "fixed-salt", { iterations: 100_000 });
    const byDefault = await hashPassword("Long-enough1!", "fixed-salt");

    expect(byDefault.hash).toBe(current.hash);
    expect(byDefault.hash).not.toBe(legacy.hash);
  });

  it("rejects short passwords", async () => {
    await expect(hashPassword("short")).rejects.toThrow(/al menos 10/);
  });

  it("can derive legacy password hashes without enforcing new-password policy", async () => {
    const legacy = await hashPassword("short", "fixed-salt", { enforcePolicy: false });

    expect(legacy.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects passwords without an uppercase letter", async () => {
    await expect(hashPassword("long-enough1!")).rejects.toThrow(/mayúscula/);
  });

  it("rejects passwords without a lowercase letter", async () => {
    await expect(hashPassword("LONG-ENOUGH1!")).rejects.toThrow(/minúscula/);
  });

  it("rejects passwords without a number", async () => {
    await expect(hashPassword("Long-enough!!")).rejects.toThrow(/número/);
  });

  it("rejects passwords without a symbol", async () => {
    await expect(hashPassword("LongEnough12")).rejects.toThrow(/símbolo/);
  });
});
