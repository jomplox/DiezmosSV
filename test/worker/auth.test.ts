import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { AuthService, hashForStorage, hashPassword } from "../../src/worker/services/auth";
import { env, InMemoryD1 } from "./support/inMemoryD1";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("auth password hashing", () => {
  it("locks the two-stage current storage format to a fixed-salt golden vector", async () => {
    const nativeCrypto = crypto;
    const iterationCounts: number[] = [];
    vi.stubGlobal("crypto", {
      getRandomValues: <T extends ArrayBufferView | null>(array: T): T => {
        if (array instanceof Uint8Array) array.fill(0);
        return array;
      },
      randomUUID: nativeCrypto.randomUUID.bind(nativeCrypto),
      subtle: {
        digest: nativeCrypto.subtle.digest.bind(nativeCrypto.subtle),
        importKey: nativeCrypto.subtle.importKey.bind(nativeCrypto.subtle),
        deriveBits: async (...args: Parameters<SubtleCrypto["deriveBits"]>) => {
          iterationCounts.push((args[0] as unknown as { iterations: number }).iterations);
          return nativeCrypto.subtle.deriveBits(...args);
        }
      }
    });

    const stored = await hashForStorage("Long-enough1!");

    expect(stored).toEqual({
      salt: "AAAAAAAAAAAAAAAAAAAAAA",
      hash: "pbkdf2-chain-v1$100000$6757f6fd50b6376e7d4774ae52b756bffd4ab3758a74861a113a308a8031f98c"
    });
    expect(iterationCounts).toEqual([100_000, 100_000]);
  });

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

  it("rejects a helper call above the Workers PBKDF2 ceiling before deriving", async () => {
    const nativeCrypto = crypto;
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

    await expect(
      hashPassword("Long-enough1!", "fixed-salt", { iterations: 100_001 })
    ).rejects.toThrow("PBKDF2 iteration count is outside the Workers-compatible range");
    expect(deriveBitsCalls).toBe(0);
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
  const knownFirst = "2a48b73a4b58947ff6b4a5a9535702d5cc2a43e524c7d71b6bb89353147fc467";
  const knownSecond = "e2943461247a19a80553d387e3bdd3430becc228e3375d09b651c3e0bf59dd31";
  const chainSaltSuffix = ":diezmossv-pbkdf2-chain-v1";

  it.each([
    ["missing", null, null, true],
    ["disabled", `pbkdf2-chain-v1$100000$${knownSecond}`, "2026-07-14T00:00:00.000Z", true],
    ["current wrong password", `pbkdf2-chain-v1$100000$${knownSecond}`, null, false],
    ["versioned legacy wrong password", `pbkdf2$100000$${knownFirst}`, null, false],
    ["countless legacy wrong password", knownFirst, null, false],
    ["transitional chain wrong password", `pbkdf2-chain$100000$${knownSecond}`, null, false],
    ["unknown marker", `argon2id$100000$${knownSecond}`, null, true],
    ["malformed current hex", "pbkdf2-chain-v1$100000$not-hex", null, true],
    ["uppercase current hex", `pbkdf2-chain-v1$100000$${knownSecond.toUpperCase()}`, null, true],
    ["leading-zero current count", `pbkdf2-chain-v1$0100000$${knownSecond}`, null, true],
    ["extra current field", `pbkdf2-chain-v1$100000$${knownSecond}$extra`, null, true],
    ["unsupported current count", `pbkdf2-chain-v1$100001$${knownSecond}`, null, true],
    ["unsupported legacy count", `pbkdf2$99999$${knownFirst}`, null, true]
  ] as const)("performs exactly two fixed PBKDF2 derivations for %s", async (_label, storedHash, disabledAt, usesDummyWork) => {
    const nativeCrypto = crypto;
    const iterationCounts: number[] = [];
    const salts: string[] = [];
    vi.stubGlobal("crypto", {
      getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto),
      randomUUID: nativeCrypto.randomUUID.bind(nativeCrypto),
      subtle: {
        digest: nativeCrypto.subtle.digest.bind(nativeCrypto.subtle),
        importKey: nativeCrypto.subtle.importKey.bind(nativeCrypto.subtle),
        deriveBits: async (...args: Parameters<SubtleCrypto["deriveBits"]>) => {
          const algorithm = args[0] as unknown as { iterations: number; salt: BufferSource };
          iterationCounts.push(algorithm.iterations);
          salts.push(new TextDecoder().decode(algorithm.salt));
          return nativeCrypto.subtle.deriveBits(...args);
        }
      }
    });

    const db = new InMemoryD1();
    if (storedHash !== null) {
      db.users.push({
        id: "user_candidate",
        email: "candidate@example.org",
        name: "Candidate",
        role: "ADMIN",
        password_hash: storedHash,
        password_salt: "known-salt",
        disabled_at: disabledAt,
        auth_generation: 0
      });
    }

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.42" },
        body: JSON.stringify({ email: "candidate@example.org", password: "Wrong#Password2026" })
      }),
      env(db)
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "auth_error", message: "Credenciales inválidas" });
    expect(iterationCounts).toEqual([100_000, 100_000]);
    expect(Math.max(...iterationCounts)).toBe(100_000);
    const firstSalt = usesDummyWork ? "diezmossv-login-dummy-v1" : "known-salt";
    expect(salts).toEqual([firstSalt, `${firstSalt}${chainSaltSuffix}`]);
    expect(db.sessions).toHaveLength(0);
    if (storedHash !== null) expect(db.users[0].password_hash).toBe(storedHash);
  });

  it.each([
    ["current", `pbkdf2-chain-v1$100000$${knownSecond}`, 2, false],
    ["versioned legacy", `pbkdf2$100000$${knownFirst}`, 4, true],
    ["countless legacy", knownFirst, 4, true],
    ["transitional chain", `pbkdf2-chain$100000$${knownSecond}`, 4, true]
  ] as const)("verifies a correct %s password with the expected work and upgrade", async (_label, storedHash, expectedCalls, upgrades) => {
    const nativeCrypto = crypto;
    const iterationCounts: number[] = [];
    vi.stubGlobal("crypto", {
      getRandomValues: nativeCrypto.getRandomValues.bind(nativeCrypto),
      randomUUID: nativeCrypto.randomUUID.bind(nativeCrypto),
      subtle: {
        digest: nativeCrypto.subtle.digest.bind(nativeCrypto.subtle),
        importKey: nativeCrypto.subtle.importKey.bind(nativeCrypto.subtle),
        deriveBits: async (...args: Parameters<SubtleCrypto["deriveBits"]>) => {
          iterationCounts.push((args[0] as unknown as { iterations: number }).iterations);
          return nativeCrypto.subtle.deriveBits(...args);
        }
      }
    });

    const db = new InMemoryD1();
    db.users.push({
      id: "user_candidate",
      email: "candidate@example.org",
      name: "Candidate",
      role: "ADMIN",
      password_hash: storedHash,
      password_salt: "known-salt",
      disabled_at: null,
      auth_generation: 0
    });

    const result = await new AuthService(env(db)).login("candidate@example.org", "Known#Password2026");

    expect(result.user.email).toBe("candidate@example.org");
    expect(iterationCounts).toEqual(Array.from({ length: expectedCalls }, () => 100_000));
    expect(db.sessions).toHaveLength(1);
    if (upgrades) {
      expect(db.users[0].password_hash).toMatch(/^pbkdf2-chain-v1\$100000\$[0-9a-f]{64}$/);
      expect(db.users[0].password_hash).not.toBe(storedHash);
    } else {
      expect(db.users[0].password_hash).toBe(storedHash);
      expect(db.users[0].password_salt).toBe("known-salt");
    }
  });
});
