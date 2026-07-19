import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { AuthService } from "../../src/worker/services/auth";
import { Repository } from "../../src/worker/storage/repository";
import { hexFromBytes, utf8Bytes } from "../../src/worker/utils/encoding";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";
import { fetchAndWaitUntil } from "./support/workerFetchRequests";
import { seededUserLifecycleDb } from "./support/userFixtures";

installWorkerFetchGlobals();

describe("password reset", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function knownUser(): Record<string, unknown> {
    return {
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: ""
    };
  }

  it("emails a reset link and stores only a hashed token for a known user", async () => {
    const db = new InMemoryD1();
    const sentMessages: Array<{ to: string; subject: string; text: string }> = [];
    db.users.push(knownUser());

    const response = await fetchAndWaitUntil(
      new Request("https://example.org/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "operator@example.org" })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message as { to: string; subject: string; text: string });
            return { messageId: "cf-email-reset" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(db.resetTokens).toHaveLength(1);
    expect(sentMessages).toHaveLength(1);
    const link = /https:\/\/example\.org\/#reset=([A-Za-z0-9_-]+)/.exec(sentMessages[0].text);
    expect(link).toBeTruthy();
    expect((sentMessages[0] as { html?: string }).html).toContain(`href="https://example.org/#reset=${link![1]}"`);
    expect(String(db.resetTokens[0].token_hash)).toBe(await sha256Hex(utf8Bytes(link![1])));
    expect(String(db.resetTokens[0].token_hash)).not.toBe(link![1]);
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "PASSWORD_RESET_REQUESTED",
      entity_id: "user_operator",
      rate_limit_claim_id: db.securityRateLimitClaims[0].id
    }));
  });

  it("builds the reset link from APP_ORIGIN even when the request carries a different origin", async () => {
    const db = new InMemoryD1();
    const sentMessages: Array<{ text: string; html?: string }> = [];
    db.users.push(knownUser());

    // Host-header poisoning: the request arrives via an attacker-controlled origin,
    // but the emailed reset link must use the canonical APP_ORIGIN so the token
    // cannot be captured by pointing the link at an attacker host.
    const response = await fetchAndWaitUntil(
      new Request("https://attacker.example/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "operator@example.org" })
      }),
      env(db, {
        APP_ORIGIN: "https://app.example.org",
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message as { text: string; html?: string });
            return { messageId: "cf-email-reset" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].text).toContain("https://app.example.org/#reset=");
    expect(sentMessages[0].text).not.toContain("https://attacker.example/#reset=");
    expect(sentMessages[0].html).toContain('href="https://app.example.org/#reset=');
  });

  it("returns ok without creating tokens or sending email for unknown accounts", async () => {
    const db = new InMemoryD1();
    const sentMessages: unknown[] = [];

    const response = await fetchAndWaitUntil(
      new Request("https://example.org/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nadie@example.org" })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message);
            return { messageId: "cf-email-reset" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(db.resetTokens).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);
  });

  it("atomically admits only three overlapping reset requests for one account", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    const sentMessages: unknown[] = [];
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL: {
        send: async (message: unknown) => {
          sentMessages.push(message);
          return { messageId: `reset-${sentMessages.length}` };
        }
      } as SendEmail
    });
    const request = () =>
      fetchAndWaitUntil(
        new Request("https://example.org/api/auth/password-reset/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "operator@example.org" })
        }),
        runtime
      );

    const responses = await Promise.all(Array.from({ length: 20 }, request));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(sentMessages).toHaveLength(3);
    expect(db.resetTokens).toHaveLength(3);
    expect(db.resetTokens.filter((token) => !token.used_at)).toHaveLength(3);
    expect(db.securityRateLimitClaims.filter((claim) => claim.scope === "password_reset")).toHaveLength(3);
    expect(db.securityRateLimitClaims[0].key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(db.securityRateLimitClaims[0].key_hash).not.toContain("user_operator");
  });

  it("counts a pre-migration account audit against the account-wide reset budget", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    db.audits.push({
      id: "legacy_reset_audit",
      action: "PASSWORD_RESET_REQUESTED",
      entity_id: "user_operator",
      created_at: "2026-07-04T11:55:00.000Z"
    });
    const sentMessages: unknown[] = [];
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL: {
        send: async (message: unknown) => {
          sentMessages.push(message);
          return { messageId: `reset-${sentMessages.length}` };
        }
      } as SendEmail
    });
    const request = () =>
      fetchAndWaitUntil(
        new Request("https://example.org/api/auth/password-reset/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "operator@example.org" })
        }),
        runtime
      );

    const responses = await Promise.all(Array.from({ length: 20 }, request));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(sentMessages).toHaveLength(2);
    expect(db.securityRateLimitClaims.filter((claim) => claim.scope === "password_reset")).toHaveLength(2);
  });

  it("does not let rotating sources multiply one account's reset budget", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    const sentMessages: unknown[] = [];
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL: {
        send: async (message: unknown) => {
          sentMessages.push(message);
          return { messageId: `reset-${sentMessages.length}` };
        }
      } as SendEmail
    });
    const request = (callerIp: string) =>
      fetchAndWaitUntil(
        new Request("https://example.org/api/auth/password-reset/request", {
          method: "POST",
          headers: { "Content-Type": "application/json", "cf-connecting-ip": callerIp },
          body: JSON.stringify({ email: "operator@example.org" })
        }),
        runtime
      );

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_, index) => request(`198.51.100.${index + 1}`))
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(sentMessages).toHaveLength(3);
    expect(db.resetTokens.filter((token) => !token.used_at)).toHaveLength(3);
    const claims = db.securityRateLimitClaims.filter((claim) => claim.scope === "password_reset");
    expect(claims).toHaveLength(3);
    expect(new Set(claims.map((claim) => claim.key_hash)).size).toBe(3);
    expect(new Set(claims.map((claim) => claim.subject_key_hash)).size).toBe(1);
    expect(claims[0].subject_key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(claims[0].subject_key_hash).not.toContain("user_operator");
  });

  it("consumes reset quota and invalidates each exact token when delivery fails", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    const send = vi.fn().mockRejectedValue(new Error("provider unavailable"));
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL: { send } as unknown as SendEmail
    });
    const request = () =>
      fetchAndWaitUntil(
        new Request("https://example.org/api/auth/password-reset/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "operator@example.org" })
        }),
        runtime
      );

    const responses = await Promise.all(Array.from({ length: 20 }, request));

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
    expect(db.securityRateLimitClaims.filter((claim) => claim.scope === "password_reset")).toHaveLength(3);
    expect(db.resetTokens).toHaveLength(3);
    expect(db.resetTokens.every((token) => Boolean(token.used_at))).toBe(true);
  });

  it("keeps earlier unused reset tokens valid until one reset succeeds", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    const runtime = env(db);
    const auth = new AuthService(runtime);

    const first = await auth.createPasswordResetToken("operator@example.org");
    const second = await auth.createPasswordResetToken("operator@example.org");

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(db.resetTokens).toHaveLength(2);
    expect(db.resetTokens[0].used_at).toBeNull();
    expect(db.resetTokens[1].used_at).toBeNull();
  });

  it.each(["email-change", "disable-reenable"] as const)(
    "does not mint a reset token when %s wins after the account lookup",
    async (mutation) => {
      const db = new InMemoryD1();
      const runtime = env(db);
      db.users.push({
        ...knownUser(),
        disabled_at: null,
        auth_generation: 0,
        created_at: "2026-07-04T11:00:00.000Z",
        updated_at: "2026-07-04T11:00:00.000Z"
      });
      db.beforeCredentialGuardedResetTokenInsert = async () => {
        const repository = new Repository(runtime.DB);
        if (mutation === "email-change") {
          await repository.updateUser("user_operator", { email: "changed@example.org" });
        } else {
          await repository.updateUser("user_operator", { disabled: true });
          await repository.updateUser("user_operator", { disabled: false });
        }
      };

      const result = await new AuthService(runtime).createPasswordResetToken("operator@example.org");

      expect(result).toBeNull();
      expect(db.resetTokens).toHaveLength(0);
      expect(db.users[0].auth_generation).toBe(mutation === "email-change" ? 1 : 2);
    }
  );

  it.each(["self-reset", "admin-reset"] as const)(
    "does not mint a reset token when a concurrent %s changes the password",
    async (mutation) => {
      const db = new InMemoryD1();
      const runtime = env(db);
      db.users.push({
        ...knownUser(),
        disabled_at: null,
        auth_generation: 0,
        created_at: "2026-07-04T11:00:00.000Z",
        updated_at: "2026-07-04T11:00:00.000Z"
      });
      const existingTokenHash = await sha256Hex(utf8Bytes("existing-reset-token"));
      db.resetTokens.push({
        id: "reset_existing",
        user_id: "user_operator",
        token_hash: existingTokenHash,
        expires_at: "2099-07-04T23:00:00.000Z",
        used_at: null
      });
      db.beforeCredentialGuardedResetTokenInsert = async () => {
        const repository = new Repository(runtime.DB);
        if (mutation === "self-reset") {
          await repository.resetPasswordWithToken(
            "user_operator",
            existingTokenHash,
            "self-reset-hash",
            "self-reset-salt"
          );
        } else {
          await repository.setUserPassword(
            "user_operator",
            "admin-reset-hash",
            "admin-reset-salt"
          );
        }
      };

      const result = await new AuthService(runtime).createPasswordResetToken("operator@example.org");

      expect(result).toBeNull();
      expect(db.resetTokens).toHaveLength(1);
      expect(db.resetTokens[0].used_at).toEqual(expect.any(String));
      expect(db.users[0]).toMatchObject({
        password_hash: `${mutation}-hash`,
        password_salt: `${mutation}-salt`
      });
    }
  );

  it("resets the password, revokes sessions, and consumes the token", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    db.sessions.push({ id: "session_1", user_id: "user_operator", token_hash: "hash", revoked_at: null });
    db.resetTokens.push({
      id: "reset_1",
      user_id: "user_operator",
      token_hash: await sha256Hex(utf8Bytes("known-token")),
      expires_at: "2026-07-04T23:00:00.000Z",
      used_at: null
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "known-token", password: "Fresh#Pass2026" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(db.users[0].password_hash).not.toBe("old-hash");
    expect(db.sessions[0].revoked_at).toBeTruthy();
    expect(db.resetTokens[0].used_at).toBeTruthy();
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "PASSWORD_RESET_COMPLETED", entity_id: "user_operator" }));
  });

  it("serializes reset redemption with lifecycle invalidation in both orders", async () => {
    const firstDb = seededUserLifecycleDb();
    const firstEnv = env(firstDb);
    const firstRawToken = "lifecycle-reset-first";
    firstDb.resetTokens[0].token_hash = await sha256Hex(utf8Bytes(firstRawToken));
    firstDb.beforePasswordResetBatch = async () => {
      firstDb.beforePasswordResetBatch = null;
      await new Repository(firstEnv.DB).updateUser("user_target", {
        email: "transitioned@example.org"
      });
    };

    await expect(
      new AuthService(firstEnv).confirmPasswordReset(
        firstRawToken,
        "New#Password2026"
      )
    ).rejects.toThrow(/válido|expiró/i);
    expect(firstDb.users[0].email).toBe("transitioned@example.org");
    expect(firstDb.users[0].password_hash).toBe("target-hash");
    expect(firstDb.sessions.every((row) => row.revoked_at != null)).toBe(true);
    expect(firstDb.resetTokens.every((row) => row.used_at != null)).toBe(true);

    const secondDb = seededUserLifecycleDb();
    const secondEnv = env(secondDb);
    const secondRawToken = "reset-wins-first";
    secondDb.resetTokens[0].token_hash = await sha256Hex(utf8Bytes(secondRawToken));
    await new AuthService(secondEnv).confirmPasswordReset(
      secondRawToken,
      "New#Password2026"
    );
    await new Repository(secondEnv.DB).updateUser("user_target", {
      email: "after-reset@example.org"
    });
    expect(secondDb.users[0].email).toBe("after-reset@example.org");
    expect(secondDb.users[0].password_hash).not.toBe("target-hash");
    expect(secondDb.sessions.every((row) => row.revoked_at != null)).toBe(true);
    expect(secondDb.resetTokens.every((row) => row.used_at != null)).toBe(true);
  });

  it("invalidates every sibling password reset token after one succeeds", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    db.sessions.push({ id: "session_1", user_id: "user_operator", token_hash: "session-hash", revoked_at: null });
    db.resetTokens.push(
      {
        id: "reset_1",
        user_id: "user_operator",
        token_hash: await sha256Hex(utf8Bytes("first-token")),
        expires_at: "2026-07-04T23:00:00.000Z",
        used_at: null
      },
      {
        id: "reset_2",
        user_id: "user_operator",
        token_hash: await sha256Hex(utf8Bytes("sibling-token")),
        expires_at: "2026-07-04T23:00:00.000Z",
        used_at: null
      }
    );

    const confirm = (token: string, password: string) =>
      worker.fetch(
        new Request("https://example.org/api/auth/password-reset/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token, password })
        }),
        env(db, { MOCK_EXTERNAL_SERVICES: "false" })
      );

    const first = await confirm("first-token", "First#Pass2026");
    const sibling = await confirm("sibling-token", "Second#Pass2026");

    expect(first.status).toBe(200);
    expect(sibling.status).toBe(400);
    await expect(sibling.json()).resolves.toMatchObject({ error: "invalid_reset_token" });
    expect(db.resetTokens.every((token) => Boolean(token.used_at))).toBe(true);
    expect(db.sessions[0].revoked_at).toBeTruthy();
    expect(db.passwordResetBatchCount).toBe(1);
  });

  it("does not change the password when a reset token loses the atomic race", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    db.sessions.push({ id: "session_1", user_id: "user_operator", token_hash: "session-hash", revoked_at: null });
    db.resetTokens.push({
      id: "reset_1",
      user_id: "user_operator",
      token_hash: await sha256Hex(utf8Bytes("racing-token")),
      expires_at: "2026-07-04T23:00:00.000Z",
      used_at: null
    });
    db.beforePasswordResetBatch = () => {
      db.resetTokens[0].used_at = "2026-07-04T12:00:00.000Z";
    };

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "racing-token", password: "Fresh#Pass2026" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_reset_token" });
    expect(db.users[0].password_hash).toBe("old-hash");
    expect(db.sessions[0].revoked_at).toBeNull();
    expect(db.passwordResetBatchCount).toBe(1);
  });

  it("allows exactly one of two concurrent confirmations to consume a reset token", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    db.sessions.push({ id: "session_1", user_id: "user_operator", token_hash: "session-hash", revoked_at: null });
    db.resetTokens.push({
      id: "reset_1",
      user_id: "user_operator",
      token_hash: await sha256Hex(utf8Bytes("shared-token")),
      expires_at: "2026-07-04T23:00:00.000Z",
      used_at: null
    });

    const confirm = (password: string) =>
      worker.fetch(
        new Request("https://example.org/api/auth/password-reset/confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: "shared-token", password })
        }),
        env(db, { MOCK_EXTERNAL_SERVICES: "false" })
      );

    const responses = await Promise.all([confirm("First#Pass2026"), confirm("Second#Pass2026")]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 400]);
    expect(db.resetTokens[0].used_at).toBeTruthy();
    expect(db.sessions[0].revoked_at).toBeTruthy();
    expect(db.passwordResetBatchCount).toBe(2);
  });

  it("rolls back password, sessions, and tokens when the reset batch fails", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    db.sessions.push({ id: "session_1", user_id: "user_operator", token_hash: "session-hash", revoked_at: null });
    db.resetTokens.push({
      id: "reset_1",
      user_id: "user_operator",
      token_hash: await sha256Hex(utf8Bytes("rollback-token")),
      expires_at: "2026-07-04T23:00:00.000Z",
      used_at: null
    });
    db.failPasswordResetBatchAfterStatement = 1;

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "rollback-token", password: "Fresh#Pass2026" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(500);
    expect(db.users[0].password_hash).toBe("old-hash");
    expect(db.sessions[0].revoked_at).toBeNull();
    expect(db.resetTokens[0].used_at).toBeNull();
  });

  it("rejects expired tokens", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    db.resetTokens.push({
      id: "reset_1",
      user_id: "user_operator",
      token_hash: await sha256Hex(utf8Bytes("stale-token")),
      expires_at: "2026-07-04T00:00:00.000Z",
      used_at: null
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "stale-token", password: "Fresh#Pass2026" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_reset_token" });
    expect(db.users[0].password_hash).toBe("old-hash");
  });

  it("rejects weak passwords without consuming the token", async () => {
    const db = new InMemoryD1();
    db.users.push(knownUser());
    db.resetTokens.push({
      id: "reset_1",
      user_id: "user_operator",
      token_hash: await sha256Hex(utf8Bytes("known-token")),
      expires_at: "2026-07-04T23:00:00.000Z",
      used_at: null
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/password-reset/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "known-token", password: "corta" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(400);
    expect(db.users[0].password_hash).toBe("old-hash");
    expect(db.resetTokens[0].used_at).toBeNull();
  });
});

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hexFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
