import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { hashPassword } from "../../src/worker/services/auth";
import { Repository } from "../../src/worker/storage/repository";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { seededUserLifecycleDb } from "./support/userFixtures";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

describe("user administration", () => {
  it.each([
    ["blank name", { email: "fresh@example.org", name: "   ", role: "VIEWER" }],
    ["blank email", { email: "   ", name: "Fresh User", role: "VIEWER" }],
    ["malformed email", { email: "not-an-email", name: "Fresh User", role: "VIEWER" }],
    ["unknown role", { email: "fresh@example.org", name: "Fresh User", role: "SUPERADMIN" }]
  ])("rejects a new user with %s before creating credentials or an audit", async (_label, invalidIdentity) => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/users", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ ...invalidIdentity, password: "Fresh#Pass2026" })
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/^invalid_user_/)
    });
    expect(db.users).toHaveLength(0);
    expect(db.audits.some((row) => row.action === "USER_CREATED")).toBe(false);
  });

  it("returns a validation error for a weak initial password without creating a user", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/users", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ email: "fresh@example.org", name: "Fresh User", role: "VIEWER", password: "weak" })
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_user_password" });
    expect(db.users).toHaveLength(0);
    expect(db.audits.some((row) => row.action === "USER_CREATED")).toBe(false);
  });

  it("stores newly created passwords in the versioned format that carries the iteration count", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/users", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ email: "  Fresh@Example.ORG  ", name: "  Fresh User  ", role: "ADMIN", password: "Fresh#Pass2026" })
      }),
      env(db)
    );

    expect(response.status).toBe(201);
    const created = db.users.find((row) => row.email === "fresh@example.org");
    expect(created?.name).toBe("Fresh User");
    expect(String(created?.password_hash)).toMatch(/^pbkdf2-chain-v1\$100000\$[0-9a-f]{64}$/);
  });

  it("verifies a legacy countless hash at the historic count and upgrades the row on login", async () => {
    const db = new InMemoryD1();
    // A pre-versioning row: raw hex derived at the historic 100k count with no marker.
    const legacy = await hashPassword("Legacy#Pass2026", "fixed-salt", { enforcePolicy: false, iterations: 100_000 });
    db.users.push({
      id: "user_legacy",
      email: "legacy@example.org",
      name: "Legacy User",
      role: "ADMIN",
      password_hash: legacy.hash,
      password_salt: legacy.salt,
      disabled_at: ""
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "legacy@example.org", password: "Legacy#Pass2026" })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ user: { email: "legacy@example.org" } });
    // The legacy hash verified, and the successful login rehashed it into the current
    // versioned format carrying the iteration count.
    expect(legacy.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(String(db.users[0].password_hash)).toMatch(/^pbkdf2-chain-v1\$100000\$[0-9a-f]{64}$/);
    expect(db.users[0].password_hash).not.toBe(legacy.hash);
  });

  it("does not create a session when a legacy login rehash loses a password-reset race", async () => {
    const db = new InMemoryD1();
    const legacy = await hashPassword("Legacy#Pass2026", "fixed-salt", { enforcePolicy: false, iterations: 100_000 });
    const reset = await hashPassword("Reset#Pass2026", "reset-salt", { enforcePolicy: false });
    db.users.push({
      id: "user_legacy",
      email: "legacy@example.org",
      name: "Legacy User",
      role: "ADMIN",
      password_hash: legacy.hash,
      password_salt: legacy.salt,
      disabled_at: ""
    });
    db.beforePasswordRehashCas = () => {
      db.users[0].password_hash = reset.hash;
      db.users[0].password_salt = reset.salt;
    };

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "legacy@example.org", password: "Legacy#Pass2026" })
      }),
      env(db)
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ message: "Credenciales inválidas" });
    expect(db.users[0].password_hash).toBe(reset.hash);
    expect(db.sessions).toHaveLength(0);
  });

  it("updates a user's profile, email, role, and disabled state", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_operator", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          name: "Operations Lead",
          email: "ops@example.org",
          role: "ADMIN",
          disabled: true
        })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      user: {
        id: "user_operator",
        name: "Operations Lead",
        email: "ops@example.org",
        role: "ADMIN"
      }
    });
    expect(db.users[0]).toMatchObject({
      name: "Operations Lead",
      email: "ops@example.org",
      role: "ADMIN"
    });
    expect(db.users[0].disabled_at).toBeTruthy();
    expect(db.audits.at(-1)).toMatchObject({
      action: "USER_UPDATED",
      entity_type: "user",
      entity_id: "user_operator"
    });
  });

  it.each([
    ["email", { email: "changed@example.org" }, true],
    ["disable", { disabled: true }, true],
    ["re-enable", { disabled: false }, true],
    ["name", { name: "Changed Name" }, false],
    ["role", { role: "ADMIN" }, false]
  ] as const)(
    "%s updates %s existing sessions and reset tokens",
    async (_label, patch, invalidates) => {
      const db = seededUserLifecycleDb();
      if ("disabled" in patch && patch.disabled === false) {
        db.users.find((row) => row.id === "user_target")!.disabled_at =
          "2026-07-03T12:00:00.000Z";
      }

      const response = await worker.fetch(
        new Request("https://example.org/api/users/user_target", {
          method: "PATCH",
          headers: {
            Authorization: "Bearer test-token",
            "Content-Type": "application/json"
          },
          body: JSON.stringify(patch)
        }),
        env(db)
      );

      expect(response.status).toBe(200);
      expect(
        db.sessions.every((row) => row.revoked_at != null)
      ).toBe(invalidates);
      expect(
        db.resetTokens.every((row) => row.used_at != null)
      ).toBe(invalidates);
    }
  );

  it("stops an ADMIN from creating or promoting a user to OWNER", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });

    const promote = await worker.fetch(
      new Request("https://example.org/api/users/user_operator", {
        method: "PATCH",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ role: "OWNER" })
      }),
      env(db)
    );
    expect(promote.status).toBe(403);
    await expect(promote.json()).resolves.toMatchObject({ error: "owner_role_required" });
    expect(db.users[0].role).toBe("OPERATOR");

    const create = await worker.fetch(
      new Request("https://example.org/api/users", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ email: "new-owner@example.org", name: "New Owner", role: "OWNER", password: "Owner-password1!" })
      }),
      env(db)
    );
    expect(create.status).toBe(403);
    await expect(create.json()).resolves.toMatchObject({ error: "owner_role_required" });
    expect(db.users).toHaveLength(1);
  });

  it("blocks an ADMIN from modifying or resetting the password of an existing OWNER", async () => {
    // The reverse escalation vector: resetting an OWNER's password (or disabling the
    // account) hands the ADMIN that OWNER's session power. Only OWNERs touch OWNERs.
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_owner",
      email: "owner@example.org",
      name: "Owner",
      role: "OWNER",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });

    const reset = await worker.fetch(
      new Request("https://example.org/api/users/user_owner/password", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ password: "Atacante#2026" })
      }),
      env(db)
    );
    expect(reset.status).toBe(403);
    await expect(reset.json()).resolves.toMatchObject({ error: "owner_target_protected" });
    expect(db.users[0].password_hash).toBe("old-hash");

    const patch = await worker.fetch(
      new Request("https://example.org/api/users/user_owner", {
        method: "PATCH",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ disabled: true })
      }),
      env(db)
    );
    expect(patch.status).toBe(403);
    await expect(patch.json()).resolves.toMatchObject({ error: "owner_target_protected" });
    expect(db.users[0].disabled_at).toBe("");
  });

  it("rejects an ADMIN password reset when the target is promoted to OWNER before the write", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_target",
      email: "target@example.org",
      name: "Target",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: null
    });
    db.beforeGuardedUserMutation = () => {
      db.users[0].role = "OWNER";
    };

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_target/password", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ password: "Fresh#Password2026" })
      }),
      env(db)
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "owner_target_protected" });
    expect(db.users[0]).toMatchObject({ role: "OWNER", password_hash: "old-hash", password_salt: "old-salt" });
    expect(db.audits).toHaveLength(0);
  });

  it("rejects an ADMIN patch when the target is promoted to OWNER before the write", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_target",
      email: "target@example.org",
      name: "Target",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: null
    });
    db.beforeGuardedUserMutation = () => {
      db.users[0].role = "OWNER";
    };

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_target", {
        method: "PATCH",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Hijacked Owner" })
      }),
      env(db)
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "owner_target_protected" });
    expect(db.users[0]).toMatchObject({ role: "OWNER", name: "Target" });
    expect(db.audits).toHaveLength(0);
  });

  it("rejects a stale ADMIN patch instead of undoing an overlapping disable", async () => {
    const db = new InMemoryD1();
    const runtime = env(db);
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_target",
      email: "target@example.org",
      name: "Target",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: null,
      auth_generation: 0,
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.beforeGuardedUserMutation = async () => {
      await new Repository(runtime.DB).updateUser("user_target", { disabled: true });
    };

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_target", {
        method: "PATCH",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Stale Rename" })
      }),
      runtime
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "user_update_conflict" });
    expect(db.users[0]).toMatchObject({
      name: "Target",
      email: "target@example.org",
      disabled_at: expect.any(String),
      auth_generation: 1
    });
    expect(db.audits.filter((audit) => audit.action === "USER_UPDATED")).toHaveLength(0);
  });

  it("rejects a stale OWNER rename instead of undoing an overlapping role promotion", async () => {
    const db = new InMemoryD1();
    const runtime = env(db);
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.users.push({
      id: "user_target",
      email: "target@example.org",
      name: "Target",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: null,
      auth_generation: 0,
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.beforeGuardedUserMutation = async () => {
      await new Repository(runtime.DB).updateUser("user_target", { role: "OWNER" }, true);
    };

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_target", {
        method: "PATCH",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Stale Rename" })
      }),
      runtime
    );

    expect(response.status).toBe(409);
    expect(db.users[0]).toMatchObject({ name: "Target", role: "OWNER" });
    expect(db.audits.filter((audit) => audit.action === "USER_UPDATED")).toHaveLength(0);
  });

  it("lets an OWNER create and promote users to OWNER", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });

    const promote = await worker.fetch(
      new Request("https://example.org/api/users/user_operator", {
        method: "PATCH",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ role: "OWNER" })
      }),
      env(db)
    );
    expect(promote.status).toBe(200);
    await expect(promote.json()).resolves.toMatchObject({ user: { id: "user_operator", role: "OWNER" } });
    expect(db.users[0].role).toBe("OWNER");

    const create = await worker.fetch(
      new Request("https://example.org/api/users", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ email: "second-owner@example.org", name: "Second Owner", role: "OWNER", password: "Owner-password1!" })
      }),
      env(db)
    );
    expect(create.status).toBe(201);
    await expect(create.json()).resolves.toMatchObject({ user: { role: "OWNER" } });
    expect(db.users).toHaveLength(2);
  });

  it("resets a user's password and revokes active sessions", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.sessions.push({ id: "session_1", user_id: "user_operator", token_hash: "token-hash", revoked_at: null });
    db.resetTokens.push(
      {
        id: "reset_1",
        user_id: "user_operator",
        token_hash: "first-reset-hash",
        expires_at: "2026-07-04T23:00:00.000Z",
        used_at: null
      },
      {
        id: "reset_2",
        user_id: "user_operator",
        token_hash: "second-reset-hash",
        expires_at: "2026-07-04T23:00:00.000Z",
        used_at: null
      }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_operator/password", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ password: "New-long-password1!" })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(db.users[0].password_hash).not.toBe("old-hash");
    expect(db.users[0].password_salt).not.toBe("old-salt");
    expect(db.sessions[0].revoked_at).toBeTruthy();
    expect(db.resetTokens.every((token) => Boolean(token.used_at))).toBe(true);
    expect(db.passwordResetBatchCount).toBe(1);
    expect(db.audits.at(-1)).toMatchObject({
      action: "USER_PASSWORD_RESET",
      entity_type: "user",
      entity_id: "user_operator"
    });
  });

  it("rolls back an administrator password change, session revocation, and reset-token invalidation together", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.sessions.push({ id: "session_1", user_id: "user_operator", token_hash: "token-hash", revoked_at: null });
    db.resetTokens.push({
      id: "reset_1",
      user_id: "user_operator",
      token_hash: "reset-hash",
      expires_at: "2026-07-04T23:00:00.000Z",
      used_at: null
    });
    db.failPasswordResetBatchAfterStatement = 1;

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_operator/password", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ password: "New-long-password1!" })
      }),
      env(db)
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "internal_error" });
    expect(db.users[0].password_hash).toBe("old-hash");
    expect(db.users[0].password_salt).toBe("old-salt");
    expect(db.sessions[0].revoked_at).toBeNull();
    expect(db.resetTokens[0].used_at).toBeNull();
    expect(db.audits).toHaveLength(0);
  });

  it("rejects weak password resets without changing the user or sessions", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.sessions.push({ id: "session_1", user_id: "user_operator", token_hash: "token-hash", revoked_at: null });

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_operator/password", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ password: "weakpassword" })
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_user_password" });
    expect(db.users[0].password_hash).toBe("old-hash");
    expect(db.users[0].password_salt).toBe("old-salt");
    expect(db.sessions[0].revoked_at).toBeNull();
    expect(db.audits).toHaveLength(0);
  });
});
