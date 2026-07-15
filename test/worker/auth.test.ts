import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthService, hashPassword } from "../../src/worker/services/auth";

describe("auth password hashing", () => {
  it("hashes deterministically with an explicit salt", async () => {
    const first = await hashPassword("Long-enough1!", "fixed-salt");
    const second = await hashPassword("Long-enough1!", "fixed-salt");

    expect(first).toEqual(second);
    expect(first.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives at the Workers-compatible 100k work factor by default", async () => {
    const current = await hashPassword("Long-enough1!", "fixed-salt", { iterations: 100_000 });
    const byDefault = await hashPassword("Long-enough1!", "fixed-salt");

    expect(byDefault.hash).toBe(current.hash);
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

describe("login failure work equivalence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["missing", null],
    ["disabled", { disabled_at: "2026-07-14T00:00:00.000Z" }]
  ] as const)("performs one PBKDF2 derivation for a %s account", async (_label, accountPatch) => {
    const nativeCrypto = crypto;
    const stored = await hashPassword("Known#Password2026", "known-salt", {
      enforcePolicy: false,
      iterations: 100_000
    });
    const row = accountPatch === null ? null : {
      id: "user_disabled",
      email: "disabled@example.org",
      name: "Disabled",
      role: "ADMIN",
      password_hash: `pbkdf2$100000$${stored.hash}`,
      password_salt: "known-salt",
      auth_generation: "0",
      ...accountPatch
    };
    let deriveBitsCalls = 0;
    vi.stubGlobal("crypto", {
      getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto),
      randomUUID: nativeCrypto.randomUUID.bind(nativeCrypto),
      subtle: {
        digest: nativeCrypto.subtle.digest.bind(nativeCrypto.subtle),
        importKey: nativeCrypto.subtle.importKey.bind(nativeCrypto.subtle),
        deriveBits: async (...args: Parameters<SubtleCrypto["deriveBits"]>) => {
          deriveBitsCalls += 1;
          return nativeCrypto.subtle.deriveBits(...args);
        }
      }
    });

    const service = new AuthService({
      DB: {
        prepare: () => ({
          bind: () => ({ first: async () => row })
        })
      } as unknown as D1Database
    } as never);

    await expect(service.login("candidate@example.org", "Wrong#Password2026")).rejects.toThrow("Credenciales inválidas");
    expect(deriveBitsCalls).toBe(1);
  });
});
