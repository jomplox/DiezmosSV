import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { hashPassword } from "../../src/worker/services/auth";
import { IssuancePipeline } from "../../src/worker/services/pipeline";
import { previousElSalvadorMonth } from "../../src/worker/services/retention";
import { bytesToBase64, hexFromBytes, utf8Bytes } from "../../src/worker/utils/encoding";
import type { DteDocumentRecord, Env, IssuanceMessage } from "../../src/worker/types";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Worker fetch error handling", () => {
  it("converts async API auth errors into JSON responses", async () => {
    const response = await worker.fetch(new Request("https://example.org/api/documents"), {
      DB: {} as D1Database,
      ISSUANCE_QUEUE: {} as Queue,
      ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } as unknown as Fetcher
    } as Env);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "auth_error" });
  });
});

describe("owner bootstrap", () => {
  it("reports bootstrap availability before the first user exists", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      new Request("https://example.org/api/auth/bootstrap-status"),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ bootstrapAvailable: true });
  });

  it("reports bootstrap unavailable after an owner exists", async () => {
    const db = new InMemoryD1();
    db.users.push({
      id: "user_owner",
      email: "owner@example.org",
      name: "Owner",
      role: "OWNER",
      password_hash: "hash",
      password_salt: "salt",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    const response = await worker.fetch(
      new Request("https://example.org/api/auth/bootstrap-status"),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ bootstrapAvailable: false });
  });

  it("rejects first-owner bootstrap when the setup token is missing", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      bootstrapRequest(),
      env(db, { BOOTSTRAP_OWNER_TOKEN: "setup-token" })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "bootstrap_token_required" });
    expect(db.users).toHaveLength(0);
  });

  it("rejects first-owner bootstrap when the setup token is wrong", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      bootstrapRequest({ token: "wrong-token" }),
      env(db, { BOOTSTRAP_OWNER_TOKEN: "setup-token" })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "bootstrap_token_required" });
    expect(db.users).toHaveLength(0);
  });

  it("creates the first owner when the setup token matches", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      bootstrapRequest({ token: "setup-token" }),
      env(db, { BOOTSTRAP_OWNER_TOKEN: "setup-token" })
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      user: {
        email: "legacy-contact-3@example.com",
        name: "Example Person",
        role: "OWNER"
      }
    });
    expect(db.users).toHaveLength(1);
    expect(db.users[0].role).toBe("OWNER");
  });
});

describe("auth rate limiting", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function seedAudit(db: InMemoryD1, action: string, entityId: string, createdAt: string): void {
    db.audits.push({
      id: `audit_${action}_${db.audits.length}`,
      actor_type: "SYSTEM",
      actor_id: null,
      action,
      entity_type: "user",
      entity_id: entityId,
      summary: "seeded",
      metadata_json: "{}",
      created_at: createdAt
    });
  }

  function loginRequest(email: string, password = "whatever") {
    return new Request("https://example.org/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
  }

  it("blocks the sixth failed login within 15 minutes without attempting authentication", async () => {
    const db = new InMemoryD1();
    // Five recent failures inside the window, keyed on the normalized (lowercase) email.
    for (let i = 0; i < 5; i += 1) {
      seedAudit(db, "LOGIN_FAILED", "abuser@example.org", `2026-07-04T11:5${i}:00.000Z`);
    }

    const response = await worker.fetch(loginRequest("ABuser@example.org"), env(db));

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: "too_many_attempts",
      message: "Demasiados intentos. Espere 15 minutos e intente de nuevo."
    });
    // No authentication was attempted, so no additional LOGIN_FAILED audit is written.
    expect(db.audits.filter((audit) => audit.action === "LOGIN_FAILED")).toHaveLength(5);
  });

  it("ignores failures older than the 15-minute window", async () => {
    const db = new InMemoryD1();
    // Five failures, but all older than 15 minutes — must not trip the limiter.
    for (let i = 0; i < 5; i += 1) {
      seedAudit(db, "LOGIN_FAILED", "olduser@example.org", `2026-07-04T11:${10 + i}:00.000Z`);
    }

    const response = await worker.fetch(loginRequest("olduser@example.org"), env(db));

    // No such user exists, so the credential error surfaces (not the throttle).
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ message: "Credenciales inválidas" });
    // A fresh LOGIN_FAILED audit is recorded for this attempt.
    const recent = db.audits.filter((audit) => audit.action === "LOGIN_FAILED");
    expect(recent).toHaveLength(6);
    expect(recent.at(-1)).toMatchObject({ action: "LOGIN_FAILED", entity_type: "user", entity_id: "olduser@example.org", summary: "Credenciales inválidas" });
  });

  it("audits a failed login and returns the credential error below the threshold", async () => {
    const db = new InMemoryD1();

    const response = await worker.fetch(loginRequest("nobody@example.org"), env(db));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ message: "Credenciales inválidas" });
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "LOGIN_FAILED", entity_type: "user", entity_id: "nobody@example.org", summary: "Credenciales inválidas" })
    );
  });

  it("lets a valid login succeed despite older failures in the window", async () => {
    const db = new InMemoryD1();
    const hashed = await hashPassword("Valid#Pass2026", "fixed-salt", { enforcePolicy: false });
    db.users.push({
      id: "user_ok",
      email: "good@example.org",
      name: "Good User",
      role: "OPERATOR",
      password_hash: hashed.hash,
      password_salt: hashed.salt,
      disabled_at: ""
    });
    // Four prior failures (below the 5 threshold) inside the window must not block a valid login.
    for (let i = 0; i < 4; i += 1) {
      seedAudit(db, "LOGIN_FAILED", "good@example.org", `2026-07-04T11:5${i}:00.000Z`);
    }

    const response = await worker.fetch(loginRequest("good@example.org", "Valid#Pass2026"), env(db));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ user: { email: "good@example.org", role: "OPERATOR" } });
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "LOGIN", entity_id: "user_ok" }));
  });

  it("throttles password-reset requests but stays enumeration-safe with a 200", async () => {
    const db = new InMemoryD1();
    db.users.push({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operator",
      role: "OPERATOR",
      password_hash: "old-hash",
      password_salt: "old-salt",
      disabled_at: ""
    });
    const sentMessages: unknown[] = [];
    // Three recent reset requests inside the window — the next one must be throttled.
    for (let i = 0; i < 3; i += 1) {
      seedAudit(db, "PASSWORD_RESET_REQUESTED", "user_operator", `2026-07-04T11:5${i}:00.000Z`);
    }

    const response = await worker.fetch(
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
            sentMessages.push(message);
            return { messageId: "cf-email-reset" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(db.resetTokens).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "PASSWORD_RESET_THROTTLED", entity_type: "user", entity_id: "user_operator" })
    );
  });
});

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

    const response = await worker.fetch(
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
    const link = /https:\/\/example\.org\/\?reset=([A-Za-z0-9_-]+)/.exec(sentMessages[0].text);
    expect(link).toBeTruthy();
    expect((sentMessages[0] as { html?: string }).html).toContain(`href="https://example.org/?reset=${link![1]}"`);
    expect(String(db.resetTokens[0].token_hash)).toBe(await sha256Hex(utf8Bytes(link![1])));
    expect(String(db.resetTokens[0].token_hash)).not.toBe(link![1]);
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "PASSWORD_RESET_REQUESTED", entity_id: "user_operator" }));
  });

  it("returns ok without creating tokens or sending email for unknown accounts", async () => {
    const db = new InMemoryD1();
    const sentMessages: unknown[] = [];

    const response = await worker.fetch(
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

describe("document listing", () => {
  it("returns a bounded page with a cursor for older matching documents", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(
      testDocument({
        id: "doc_1",
        codigo_generacion: "11111111-1111-4111-8111-111111111111",
        numero_control: "DTE-15-M001P004-000000000000001",
        donor_name: "Staging Smoke",
        donor_email: "one@example.org",
        created_at: "2026-06-26T03:00:00.000Z"
      }),
      testDocument({
        id: "doc_2",
        codigo_generacion: "70000003-2222-4222-8222-700000032222",
        numero_control: "DTE-15-M001P004-000000000000002",
        donor_name: "Staging Smoke",
        donor_email: "two@example.org",
        created_at: "2026-06-26T02:00:00.000Z"
      }),
      testDocument({
        id: "doc_3",
        codigo_generacion: "33333333-3333-4333-8333-333333333333",
        numero_control: "DTE-15-M001P004-000000000000003",
        donor_name: "Staging Smoke",
        donor_email: "three@example.org",
        created_at: "2026-06-26T01:00:00.000Z"
      })
    );

    const firstResponse = await worker.fetch(
      new Request("https://example.org/api/documents?q=Smoke&limit=2", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(firstResponse.status).toBe(200);
    const firstPage = await firstResponse.json() as { documents: DteDocumentRecord[]; hasMore: boolean; nextCursor: string | null; limit: number };
    expect(firstPage.documents.map((document) => document.id)).toEqual(["doc_1", "doc_2"]);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).toBeTruthy();
    expect(firstPage.limit).toBe(2);

    const secondResponse = await worker.fetch(
      new Request(`https://example.org/api/documents?q=Smoke&limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`, {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(secondResponse.status).toBe(200);
    await expect(secondResponse.json()).resolves.toMatchObject({
      documents: [expect.objectContaining({ id: "doc_3" })],
      hasMore: false,
      nextCursor: null,
      limit: 2
    });
  });

  it("uses indexed token-prefix search instead of scanning document text columns", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(
      testDocument({
        id: "doc_1",
        codigo_generacion: "11111111-1111-4111-8111-111111111111",
        numero_control: "DTE-15-M001P004-000000000000001",
        donor_name: "Staging Smoke",
        donor_email: "smoke@example.org",
        created_at: "2026-06-26T03:00:00.000Z"
      }),
      testDocument({
        id: "doc_2",
        codigo_generacion: "70000003-2222-4222-8222-700000032222",
        numero_control: "DTE-15-M001P004-000000000000002",
        donor_name: "Example Person",
        donor_email: "donor@example.org",
        created_at: "2026-06-26T02:00:00.000Z"
      })
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/documents?q=Stag%20Smok&limit=10", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const page = await response.json() as { documents: DteDocumentRecord[] };
    expect(page.documents.map((document) => document.id)).toEqual(["doc_1"]);
    expect(db.preparedSql.some((sql) => sql.includes("dte_document_search") && sql.includes("MATCH ?"))).toBe(true);
    expect(db.preparedSql.some((sql) => sql.includes("LIKE ? ESCAPE"))).toBe(false);
  });
});

describe("user administration", () => {
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
    expect(db.audits.at(-1)).toMatchObject({
      action: "USER_PASSWORD_RESET",
      entity_type: "user",
      entity_id: "user_operator"
    });
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

describe("document email resend", () => {
  it("sends receipts through the Cloudflare Email Service binding", async () => {
    const db = new InMemoryD1();
    const sentMessages: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message);
            return { messageId: "cf-email-1" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      from: "legacy-contact-6@example.com",
      to: "legacy-contact-2@example.com",
      subject: "Comprobante de su donación",
      text: expect.stringContaining("DTE-15-M001P004-000000000000009"),
      html: expect.stringContaining("DTE-15-M001P004-000000000000009"),
      attachments: [
        expect.objectContaining({
          filename: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4.pdf",
          type: "application/pdf",
          disposition: "attachment"
        }),
        expect.objectContaining({
          filename: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4.json",
          type: "application/json",
          disposition: "attachment"
        })
      ]
    });
    const sentMessage = sentMessages[0] as { attachments: Array<{ content: unknown }> };
    expect(sentMessage.attachments[0].content).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode((sentMessage.attachments[0].content as Uint8Array).slice(0, 4))).toBe("%PDF");
    const pdfSha256 = await sha256Hex(sentMessage.attachments[0].content as Uint8Array);
    expect(sentMessage.attachments[1].content).toBeInstanceOf(Uint8Array);
    const dteJsonBytes = sentMessage.attachments[1].content as Uint8Array;
    expect(JSON.parse(new TextDecoder().decode(sentMessage.attachments[1].content as Uint8Array))).toMatchObject({
      receptor: { correo: "legacy-contact-2@example.com" }
    });
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      to_email: "legacy-contact-2@example.com",
      status: "SENT",
      email_type: "dteReceipt",
      document_status_at_send: "ACCEPTED",
      template_version: expect.stringMatching(/^dteReceipt:sha256:[a-f0-9]{64}$/),
      pdf_renderer_version: expect.stringMatching(/^cde-pdf:/),
      pdf_sha256: pdfSha256,
      dte_json_sha256: await sha256Hex(dteJsonBytes),
      provider_delivery_id: "cf-email-1",
      provider_response_json: JSON.stringify({ provider: "cloudflare-email", messageId: "cf-email-1" })
    }));
  });

  it("uses the configured receipt email template", async () => {
    const db = new InMemoryD1();
    const sentMessages: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());
    db.settings.push({
      key: "email_templates_json",
      value: JSON.stringify({
        dteReceipt: {
          subject: "CDE {{numeroControl}} listo",
          body: "Hola {{donante}}, recibimos {{monto}} y adjuntamos {{codigoGeneracion}}."
        },
        dteInvalidation: {
          subject: "CDE invalidado {{numeroControl}}",
          body: "El CDE {{numeroControl}} fue INVALIDADO."
        }
      }),
      updated_by: "user_owner",
      updated_at: "2026-06-26T01:46:47.015Z"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message);
            return { messageId: "cf-email-template" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({
      subject: "CDE DTE-15-M001P004-000000000000009 listo",
      text: "Hola Example Person, recibimos $100.00 y adjuntamos 6CAE5F7E-A590-4573-8EF2-FE48B14796C4."
    });
  });

  it("attaches valid DTE JSON even when the document has a signed JWS", async () => {
    const db = new InMemoryD1();
    const sentMessages: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push({
      ...testDocument(),
      signed_jws: "eyJhbGciOiJSUzUxMiJ9.eyJyZWNlcHRvciI6e319fQ.signature"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message);
            return { messageId: "cf-email-1" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    const sentMessage = sentMessages[0] as { attachments: Array<{ filename: string; content: unknown }> };
    const jsonAttachment = sentMessage.attachments.find((attachment) => attachment.filename.endsWith(".json"));
    expect(jsonAttachment?.content).toBeInstanceOf(Uint8Array);
    expect(JSON.parse(new TextDecoder().decode(jsonAttachment?.content as Uint8Array))).toMatchObject({
      receptor: { correo: "legacy-contact-2@example.com" }
    });
  });

  it("falls back to an HTTP email provider when Cloudflare requires verified destinations", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());
    const providerFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "email_http_1" }), { status: 202 })
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL_API_URL: "https://mail.example/send",
        EMAIL_API_KEY: "email-api-key",
        EMAIL: {
          send: async () => {
            throw new Error("destination address is not a verified address");
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(providerFetch).toHaveBeenCalledWith("https://mail.example/send", expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        Authorization: "Bearer email-api-key",
        "Content-Type": "application/json"
      })
    }));
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      to_email: "legacy-contact-2@example.com",
      status: "SENT",
      provider_response_json: JSON.stringify({
        provider: "http-email",
        fallbackFrom: "cloudflare-email",
        cloudflareError: "destination address is not a verified address",
        response: { id: "email_http_1" }
      })
    }));
  });

  it("records and returns email failures when the provider is not configured", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false", EMAIL_FROM: "legacy-contact-6@example.com" })
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: "email_send_failed",
      message: expect.stringContaining("Configure el servicio de correo")
    });
    expect(db.emailDeliveries).toHaveLength(1);
    expect(db.emailDeliveries[0]).toMatchObject({
      document_id: "doc_1",
      to_email: "legacy-contact-2@example.com",
      status: "FAILED"
    });
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "EMAIL_RESEND_FAILED", entity_id: "doc_1" }));
  });

  it("records a failed delivery when EMAIL_FROM is missing for a real send", async () => {
    const db = new InMemoryD1();
    const sentMessages: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/resend", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        // EMAIL_FROM intentionally omitted even though a provider binding exists.
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message);
            return { messageId: "cf-email-should-not-send" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      error: "email_send_failed",
      message: expect.stringContaining("EMAIL_FROM es requerido para enviar correos")
    });
    expect(sentMessages).toHaveLength(0);
    expect(db.emailDeliveries).toHaveLength(1);
    expect(db.emailDeliveries[0]).toMatchObject({
      document_id: "doc_1",
      to_email: "legacy-contact-2@example.com",
      status: "FAILED"
    });
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "EMAIL_RESEND_FAILED", entity_id: "doc_1" }));
  });
});

describe("document contact email", () => {
  it("updates the delivery email without mutating the legal DTE JSON", async () => {
    const db = new InMemoryD1();
    const document = testDocument();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(document);

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/email", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email: "nuevo@example.org" })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    expect(db.documents[0].donor_email).toBe("nuevo@example.org");
    expect(JSON.parse(db.documents[0].plain_json)).toMatchObject({
      receptor: { correo: "legacy-contact-2@example.com" }
    });
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "DTE_EMAIL_UPDATED", entity_id: "doc_1" }));
  });
});

describe("document JSON download", () => {
  it("returns valid plain DTE JSON even when a signed JWS exists", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push({
      ...testDocument(),
      signed_jws: "eyJhbGciOiJSUzUxMiJ9.eyJyZWNlcHRvciI6e319fQ.signature"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/json", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/json");
    await expect(response.json()).resolves.toMatchObject({
      receptor: { correo: "legacy-contact-2@example.com" }
    });
  });
});

describe("document retry", () => {
  it("rejects retry for an accepted or invalidated DTE", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push({ ...testDocument(), status: "INVALIDATED" });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/retry", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "document_not_retryable",
      message: expect.stringContaining("no tiene fallos")
    });
  });
});

describe("contingency administration", () => {
  it("sends an operational alert when a contingency period is opened manually", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const sentAlerts: Array<{ to: string; subject: string }> = [];

    const openResponse = await worker.fetch(
      new Request("https://example.org/api/contingency/open", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          environment: "00",
          tipoContingencia: 2,
          reason: "MH TEST no disponible"
        })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "alerts@example.org",
        EMAIL: {
          send: async (message: unknown) => {
            sentAlerts.push(message as { to: string; subject: string });
            return { messageId: "alert-contingency" };
          }
        } as SendEmail
      })
    );

    expect(openResponse.status).toBe(201);
    const opened = (await openResponse.json()) as { contingency: { active: { id: string } } };
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0].to).toBe("owner@example.org");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:CONTINGENCY_OPENED", entity_type: "contingency_period", entity_id: opened.contingency.active.id })
    );
  });

  it("does not send a duplicate alert when reusing an already-open contingency period", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const sentAlerts: unknown[] = [];
    const testEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: { send: async (message: unknown) => { sentAlerts.push(message); return { messageId: "x" }; } } as SendEmail
    });

    await worker.fetch(
      new Request("https://example.org/api/contingency/open", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ environment: "00", tipoContingencia: 2, reason: "MH TEST no disponible" })
      }),
      testEnv
    );
    await worker.fetch(
      new Request("https://example.org/api/contingency/open", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ environment: "00", tipoContingencia: 2, reason: "MH TEST no disponible otra vez" })
      }),
      testEnv
    );

    expect(sentAlerts).toHaveLength(1);
  });

  it("opens a manual contingency period and returns dashboard-ready state", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const openResponse = await worker.fetch(
      new Request("https://example.org/api/contingency/open", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          environment: "00",
          tipoContingencia: 2,
          reason: "MH TEST no disponible"
        })
      }),
      env(db)
    );

    expect(openResponse.status).toBe(201);
    const opened = (await openResponse.json()) as {
      contingency: {
        active: { id: string; status: string; reason: string; tipo_contingencia: number };
        summary: { open: number; pending: number };
      };
    };
    expect(opened.contingency.active).toMatchObject({
      status: "OPEN",
      reason: "MH TEST no disponible",
      tipo_contingencia: 2
    });
    expect(opened.contingency.summary).toMatchObject({ open: 1, pending: 0 });
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "CONTINGENCY_OPENED",
      entity_type: "contingency_period",
      entity_id: opened.contingency.active.id
    }));

    db.documents.push({
      ...testDocument(),
      id: "doc_contingency",
      status: "CONTINGENCY_PENDING",
      sello_recibido: null,
      mh_estado: "CONTINGENCY_PENDING",
      accepted_at: null,
      contingency_period_id: opened.contingency.active.id
    });

    const stateResponse = await worker.fetch(
      new Request("https://example.org/api/contingency", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(stateResponse.status).toBe(200);
    await expect(stateResponse.json()).resolves.toMatchObject({
      contingency: {
        active: {
          id: opened.contingency.active.id,
          status: "OPEN",
          event_deadline_at: null
        },
        pendingDocuments: [
          {
            id: "doc_contingency",
            status: "CONTINGENCY_PENDING"
          }
        ],
        periods: [
          {
            id: opened.contingency.active.id,
            status: "OPEN"
          }
        ],
        summary: {
          pending: 1,
          open: 1,
          eventAccepted: 0,
          closed: 0,
          failed: 0
        }
      }
    });
  });

  it("requires a reason when opening contingency type 5", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const response = await worker.fetch(
      new Request("https://example.org/api/contingency/open", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          environment: "00",
          tipoContingencia: 5,
          reason: ""
        })
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "missing_contingency_reason" });
  });

  it("submits contingency CDEs through a lote after the event is accepted", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.contingencies.push({
      id: "cont_1",
      environment: "00",
      status: "OPEN",
      reason: "MH TEST no disponible",
      tipo_contingencia: 2,
      started_at: "2026-06-26T01:00:00.000Z",
      ended_at: null,
      event_id: null,
      event_sello: null,
      transmit_deadline_at: null,
      created_at: "2026-06-26T01:00:00.000Z"
    });
    db.documents.push({
      ...testDocument(),
      id: "doc_contingency",
      status: "CONTINGENCY_PENDING",
      signed_jws: "signed-cde-jws",
      sello_recibido: null,
      mh_estado: "CONTINGENCY_PENDING",
      accepted_at: null,
      contingency_period_id: "cont_1"
    });
    const certPassword = "correct horse battery staple";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(jsonResponse({ estado: "PROCESADO", selloRecibido: "EVENT-SEAL", observaciones: [] }))
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(jsonResponse({ estado: "PROCESADO", codigoLote: "LOTE-TEST-1", observaciones: [] }))
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(jsonResponse({ procesados: [{ codigoGeneracion: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4", selloRecibido: "DTE-SEAL" }], rechazados: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://example.org/api/contingency/sweep", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        MH_CERT_XML: await generatedCertificateXml(certPassword),
        MH_CERT_PASSWORD: certPassword,
        MH_USER_TEST: "10000003520015",
        MH_PASSWORD_TEST: "test-password",
        MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
        MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte",
        MH_CONTINGENCIA_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/contingencia"
      })
    );

    expect(response.status).toBe(200);
    const requestedUrls = fetchMock.mock.calls.map(([url]) => String(url));
    expect(requestedUrls).toContain("https://apitest.dtes.mh.gob.sv/fesv/recepcionlote");
    expect(requestedUrls).toContain("https://apitest.dtes.mh.gob.sv/fesv/recepcion/consultadtelote/LOTE-TEST-1");
    expect(requestedUrls).not.toContain("https://apitest.dtes.mh.gob.sv/fesv/recepciondte");
    const loteRequest = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/recepcionlote"))?.[1];
    expect(JSON.parse(String(loteRequest?.body))).toMatchObject({
      ambiente: "00",
      version: 2,
      nitEmisor: "10000003520015",
      documentos: ["signed-cde-jws"]
    });
  });

  it("returns contingency lote rows and line counts for the dashboard", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.contingencies.push({
      id: "cont_1",
      environment: "00",
      status: "EVENT_ACCEPTED",
      reason: "MH TEST no disponible",
      tipo_contingencia: 2,
      started_at: "2026-06-26T01:00:00.000Z",
      ended_at: null,
      event_id: "event_1",
      event_sello: "EVENT-SEAL",
      transmit_deadline_at: "2026-06-29T01:00:00.000Z",
      created_at: "2026-06-26T01:00:00.000Z"
    });
    db.contingencyBatches.push({
      id: "batch_1",
      contingency_period_id: "cont_1",
      environment: "00",
      id_envio: "BATCH-SEND-1",
      status: "PROCESSING",
      codigo_lote: "LOTE-TEST-1",
      request_json: "{}",
      response_json: "{}",
      last_error: null,
      line_count: 2,
      accepted_count: 1,
      rejected_count: 0,
      pending_count: 1,
      created_at: "2026-06-26T01:10:00.000Z",
      submitted_at: "2026-06-26T01:11:00.000Z",
      last_polled_at: "2026-06-26T01:12:00.000Z",
      updated_at: "2026-06-26T01:12:00.000Z"
    });
    db.contingencyBatchLines.push(
      {
        id: "line_1",
        batch_id: "batch_1",
        contingency_period_id: "cont_1",
        document_id: "doc_1",
        line_no: 1,
        status: "ACCEPTED",
        codigo_generacion: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4",
        tipo_dte: "15",
        signed_jws: "signed-cde-jws-1",
        sello_recibido: "DTE-SEAL-1",
        mh_estado: "PROCESADO",
        mh_observaciones_json: "[]",
        last_error: null,
        created_at: "2026-06-26T01:10:00.000Z",
        updated_at: "2026-06-26T01:12:00.000Z"
      },
      {
        id: "line_2",
        batch_id: "batch_1",
        contingency_period_id: "cont_1",
        document_id: "doc_2",
        line_no: 2,
        status: "BATCH_SENT",
        codigo_generacion: "8C2A5D5F-1111-4111-8111-1111119E416F",
        tipo_dte: "15",
        signed_jws: "signed-cde-jws-2",
        sello_recibido: null,
        mh_estado: null,
        mh_observaciones_json: "[]",
        last_error: null,
        created_at: "2026-06-26T01:10:00.000Z",
        updated_at: "2026-06-26T01:11:00.000Z"
      }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/contingency", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      contingency: {
        batches: [
          {
            id: "batch_1",
            status: "PROCESSING",
            codigo_lote: "LOTE-TEST-1",
            line_count: 2,
            accepted_count: 1,
            pending_count: 1
          }
        ],
        batchLines: [
          { id: "line_1", batch_id: "batch_1", status: "ACCEPTED", sello_recibido: "DTE-SEAL-1" },
          { id: "line_2", batch_id: "batch_1", status: "BATCH_SENT" }
        ],
        summary: {
          batches: 1,
          batchAccepted: 1,
          batchPending: 1,
          batchRejected: 0
        }
      }
    });
  });
});

describe("document invalidation", () => {
  // Pin the clock inside the legal window of testDocument()'s sello (June 2026 →
  // invalidation allowed until the tenth business day of July, 2026-07-15T05:59:59Z).
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-01T15:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks invalidation after the tenth business day of the following month", async () => {
    vi.setSystemTime(new Date("2026-07-15T06:00:00.000Z"));
    const db = new InMemoryD1();
    const document = testDocument();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(document);

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/invalidate", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ tipoAnulacion: 2, motivoAnulacion: "Fuera de ventana" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "outside_legal_window",
      deadline: "2026-07-15T05:59:59.000Z"
    });
    expect(document.status).toBe("ACCEPTED");
  });

  it("requires a replacement codigo de generación for tipo 1 invalidations", async () => {
    const db = new InMemoryD1();
    const document = testDocument();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(document);

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/invalidate", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ tipoAnulacion: 1, motivoAnulacion: "Error en datos" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "replacement_required_for_tipo_1" });
    expect(document.status).toBe("ACCEPTED");
  });

  it("emails an invalidation notice when MH accepts the invalidation event", async () => {
    const db = new InMemoryD1();
    const document = testDocument();
    const sentMessages: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(document);
    db.settings.push({
      key: "email_templates_json",
      value: JSON.stringify({
        dteReceipt: {
          subject: "CDE {{numeroControl}} listo",
          body: "Adjuntamos {{numeroControl}}."
        },
        dteInvalidation: {
          subject: "Aviso de invalidación {{numeroControl}}",
          body: "Hola {{donante}}, el CDE {{numeroControl}} quedó {{estado}} ante MH."
        }
      }),
      updated_by: "user_owner",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    const certPassword = "correct horse battery staple";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(
        jsonResponse({
          estado: "PROCESADO",
          codigoMsg: "001",
          descripcionMsg: "Invalidación recibida",
          selloRecibido: "2026INVALIDACIONSEAL",
          observaciones: []
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/invalidate", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ tipoAnulacion: 2, motivoAnulacion: "Prueba aceptada" })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message);
            return { messageId: "cf-email-invalidated" };
          }
        } as SendEmail,
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        MH_CERT_XML: await generatedCertificateXml(certPassword),
        MH_CERT_PASSWORD: certPassword,
        MH_USER_TEST: "10000003520015",
        MH_PASSWORD_TEST: "test-password",
        MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
        MH_ANULACION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/anulardte"
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      emailSent: true
    });
    expect(document.status).toBe("INVALIDATED");
    expect(sentMessages).toHaveLength(1);
    const sentMessage = sentMessages[0] as { subject: string; text: string; attachments: Array<{ filename: string; content: unknown }> };
    expect(sentMessage.subject).toBe("Aviso de invalidación DTE-15-M001P004-000000000000009");
    expect(sentMessage.text).toBe("Hola Example Person, el CDE DTE-15-M001P004-000000000000009 quedó Invalidado ante MH.");
    expect(new TextDecoder().decode((sentMessage.attachments[0].content as Uint8Array).slice(0, 4))).toBe("%PDF");
    const invalidationPdfSha256 = await sha256Hex(sentMessage.attachments[0].content as Uint8Array);
    const invalidationJsonBytes = sentMessage.attachments[1].content as Uint8Array;
    expect(JSON.parse(new TextDecoder().decode(sentMessage.attachments[1].content as Uint8Array))).toMatchObject({
      receptor: { correo: "legacy-contact-2@example.com" }
    });
    expect(db.emailDeliveries).toContainEqual(expect.objectContaining({
      document_id: "doc_1",
      to_email: "legacy-contact-2@example.com",
      status: "SENT",
      email_type: "dteInvalidation",
      document_status_at_send: "INVALIDATED",
      template_version: expect.stringMatching(/^dteInvalidation:sha256:[a-f0-9]{64}$/),
      pdf_renderer_version: expect.stringMatching(/^cde-pdf:/),
      pdf_sha256: invalidationPdfSha256,
      dte_json_sha256: await sha256Hex(invalidationJsonBytes),
      provider_delivery_id: "cf-email-invalidated",
      provider_response_json: JSON.stringify({ provider: "cloudflare-email", messageId: "cf-email-invalidated" })
    }));
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "EMAIL_INVALIDATION_SENT", entity_id: "doc_1" }));
  });

  it("returns a conflict when MH rejects the invalidation event", async () => {
    const db = new InMemoryD1();
    const document = testDocument();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(document);
    const certPassword = "correct horse battery staple";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            estado: "RECHAZADO",
            codigoMsg: "027",
            descripcionMsg: "[identificacion.fecEmi] DATO NO COINCIDE CON DTE",
            selloRecibido: null,
            observaciones: []
          },
          { status: 400 }
        )
      );
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/invalidate", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ tipoAnulacion: 2, motivoAnulacion: "Prueba rechazada" })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        MH_CERT_XML: await generatedCertificateXml(certPassword),
        MH_CERT_PASSWORD: certPassword,
        MH_USER_TEST: "10000003520015",
        MH_PASSWORD_TEST: "test-password",
        MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
        MH_ANULACION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/anulardte"
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      accepted: false,
      error: "invalidation_rejected",
      message: expect.stringContaining("DATO NO COINCIDE")
    });
    expect(document.status).toBe("ACCEPTED");
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "DTE_INVALIDATION_REJECTED", entity_id: "doc_1" }));
  });
});

describe("F960 CSV export", () => {
  it("returns accepted CDEs for a date range in the real F960 semicolon format", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(
      testDocument(),
      {
        ...testDocument(),
        id: "doc_may",
        codigo_generacion: "1E9A4B17-C473-4B75-B2C7-E5B06D076D3B",
        numero_control: "DTE-15-M001P004-000000000000008",
        issued_at: "2026-05-31T23:30:00.000Z",
        accepted_at: "2026-05-31T23:31:00.000Z",
        plain_json: JSON.stringify({
          emisor: { nombre: "ExamplePerson1" },
          receptor: { nombre: "Outside Range", correo: "outside@example.org", tipoDocumento: "13", numDocumento: "100000043" },
          resumen: { valorTotal: 50 },
          identificacion: { fecEmi: "2026-05-31", horEmi: "17:30:00", codigoGeneracion: "1E9A4B17-C473-4B75-B2C7-E5B06D076D3B" }
        })
      },
      {
        ...testDocument(),
        id: "doc_failed",
        codigo_generacion: "0E9A4B17-C473-4B75-B2C7-E5B06D076D3B",
        numero_control: "DTE-15-M001P004-000000000000010",
        status: "FAILED",
        sello_recibido: null
      }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960.csv?startDate=2026-06-01&endDate=2026-06-30", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="f960-20260601-20260630.csv"');
    await expect(response.text()).resolves.toBe(
      "1;;Example Person;9300;4;20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGQE;6CAE5F7EA59045738EF2FE48B14796C4;100.00;100000001;062026\r\n"
    );
  });

  it("returns preview rows for the selected date range", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960?startDate=2026-06-01&endDate=2026-06-30", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      rowCount: 1,
      amountTotal: "100.00",
      rows: [
        {
          nit: "",
          nombre: "Example Person",
          codigoActividad: "9300",
          tipoDonacion: "4",
          sello: "20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGQE",
          codigoGeneracion: "6CAE5F7EA59045738EF2FE48B14796C4",
          monto: "100.00",
          dui: "100000001",
          periodo: "062026"
        }
      ]
    });
  });

  it("returns an Excel inspection workbook with headers for the selected rows", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960.xlsx?startDate=2026-06-01&endDate=2026-06-30", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="f960-inspeccion-20260601-20260630.xlsx"');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 2))).toBe("PK");
    const workbookText = new TextDecoder().decode(bytes);
    expect(workbookText).toContain("Nombre donante");
    expect(workbookText).toContain("Example Person");
    expect(workbookText).toContain("Código generación");
    expect(workbookText).toContain("Aceptado");
  });

  it("requires an admin role", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument());

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960.csv", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(403);
  });
});

describe("annual donor certificates", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-05T12:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function seedYear(db: InMemoryD1): void {
    db.documents.push(
      testDocument({
        id: "cert_ana_1",
        donor_email: "ana@example.org",
        donor_name: "Ana",
        amount_cents: 2500,
        issued_at: "2025-02-01T16:00:00.000Z",
        numero_control: "DTE-15-M001P004-000000000000101"
      }),
      testDocument({
        id: "cert_ana_2",
        donor_email: "ana@example.org",
        donor_name: "Ana",
        amount_cents: 7501,
        issued_at: "2025-05-10T16:00:00.000Z",
        numero_control: "DTE-15-M001P004-000000000000102"
      }),
      testDocument({
        id: "cert_noemail",
        donor_email: null,
        donor_name: "Sin Correo",
        amount_cents: 4000,
        issued_at: "2025-06-01T16:00:00.000Z",
        numero_control: "DTE-15-M001P004-000000000000103"
      }),
      // Excluded: invalidated
      testDocument({
        id: "cert_invalid",
        donor_email: "ana@example.org",
        donor_name: "Ana",
        status: "INVALIDATED",
        amount_cents: 9999,
        issued_at: "2025-07-01T16:00:00.000Z",
        numero_control: "DTE-15-M001P004-000000000000104"
      }),
      // Excluded: different year
      testDocument({
        id: "cert_prev_year",
        donor_email: "beto@example.org",
        donor_name: "Beto",
        amount_cents: 1000,
        issued_at: "2024-12-31T16:00:00.000Z",
        numero_control: "DTE-15-M001P004-000000000000105"
      })
    );
  }

  it("previews donors with counts, totals and email presence for a completed year", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual?year=2025", { headers: { Authorization: "Bearer test-token" } }),
      env(db, { EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      donorCount: number;
      withEmail: number;
      withoutEmail: number;
      totalLabel: string;
      donors: Array<{ donorName: string; hasEmail: boolean; count: number; totalLabel: string }>;
    };
    expect(body.donorCount).toBe(2);
    expect(body.withEmail).toBe(1);
    expect(body.withoutEmail).toBe(1);
    expect(body.totalLabel).toBe("$140.01");
    const ana = body.donors.find((donor) => donor.donorName === "Ana");
    expect(ana).toMatchObject({ hasEmail: true, count: 2, totalLabel: "$100.01" });
    const sinCorreo = body.donors.find((donor) => donor.donorName === "Sin Correo");
    expect(sinCorreo).toMatchObject({ hasEmail: false, count: 1 });
  });

  it("rejects future years", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual?year=2027", { headers: { Authorization: "Bearer test-token" } }),
      env(db, { EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_certificate_year" });
  });

  it("forbids preview for non-admin roles", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual?year=2025", { headers: { Authorization: "Bearer test-token" } }),
      env(db, { EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(403);
  });

  it("sends one certificate per donor with email, attaches the PDF, and skips donors without email", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);
    const sent: Array<{ to: string; subject: string; attachments?: Array<{ filename: string; type: string; content: Uint8Array }> }> = [];

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        EMAIL: {
          send: async (message: unknown) => {
            sent.push(message as { to: string; subject: string });
            return { messageId: "cf-cert" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ year: 2025, sent: 1, skipped: 1, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ana@example.org");
    expect(sent[0].subject).toBe("Constancia de donaciones 2025");
    const attachments = sent[0].attachments ?? [];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe("constancia-donaciones-2025.pdf");
    expect(attachments[0].type).toBe("application/pdf");
    expect(new TextDecoder("latin1").decode(attachments[0].content.slice(0, 5))).toBe("%PDF-");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DONOR_CERTIFICATE_SENT", entity_id: "2025:ana@example.org" })
    );
  });

  it("re-run skips donors already sent and only retries the rest", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);
    db.audits.push({
      id: "audit_prior",
      actor_type: "USER",
      actor_id: "user_admin",
      action: "DONOR_CERTIFICATE_SENT",
      entity_type: "donor_certificate",
      entity_id: "2025:ana@example.org",
      summary: "prior send",
      created_at: "2026-07-01T00:00:00.000Z"
    });
    const sent: unknown[] = [];

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        EMAIL: {
          send: async (message: unknown) => {
            sent.push(message);
            return { messageId: "cf-cert" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    // Ana already sent (skipped), Sin Correo has no email (skipped), nothing left to send.
    await expect(response.json()).resolves.toEqual({ year: 2025, sent: 0, skipped: 2, failed: 0 });
    expect(sent).toHaveLength(0);
  });

  it("forbids send for non-admin roles", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(403);
  });
});

describe("advanced CDE generation", () => {
  it("creates quick DTE records directly without a synthetic Wompi event", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const settingsResponse = await worker.fetch(
      new Request("https://example.org/api/settings/emission-environment", {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ environment: "01" })
      }),
      env(db)
    );

    expect(settingsResponse.status).toBe(200);

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: "1.00",
          donorName: "Example Person",
          donorDocument: "100000001",
          donorEmail: "donor@example.org",
          donorPhone: "70000005"
        })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: true });
    expect(db.wompiEvents).toHaveLength(0);
    expect(db.documents).toHaveLength(1);
    const generated = JSON.parse(db.documents[0].plain_json);
    expect(generated.identificacion).toMatchObject({ ambiente: "01", tipoDte: "15" });
    expect(generated.receptor.nombre).toBe("Example Person");
    expect(generated.otrosDocumentos[0]).toMatchObject({
      descDocumento: "Generación directa",
      detalleDocumento: "Donación offline"
    });
    expect(db.documents[0]).toMatchObject({
      wompi_event_id: null,
      donor_email: "donor@example.org",
      donor_name: "Example Person",
      amount_cents: 100,
      status: "PENDING"
    });
    expect(queued).toEqual([{ advancedDocumentId: db.documents[0].id }]);
  });

  it("accepts a quick DTE donor document type outside DUI and NIT", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: "5.00",
          donorName: "Donante Offline",
          donorDocumentType: "37",
          donorDocument: "RECIBO-123",
          donorEmail: "offline@example.org"
        })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    expect(db.wompiEvents).toHaveLength(0);
    expect(db.documents).toHaveLength(1);
    const generated = JSON.parse(db.documents[0].plain_json);
    expect(generated.receptor).toMatchObject({
      tipoDocumento: "37",
      numDocumento: "RECIBO-123",
      nombre: "Donante Offline"
    });
    expect(queued).toEqual([{ advancedDocumentId: db.documents[0].id }]);
  });

  it("rejects malformed donor email on quick DTE creation", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          amount: "5.00",
          donorName: "Donante Offline",
          donorDocumentType: "37",
          donorDocument: "RECIBO-123",
          donorEmail: "correo-invalido"
        })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_donor_email", message: "Ingrese un correo válido" });
    expect(db.documents).toHaveLength(0);
    expect(queued).toEqual([]);
  });

  it("opens the advanced template with a default amount when quick amount is blank", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced-template", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ amount: "", donorName: "Example Person", donorDocumentType: "03", donorDocument: "A1234567" })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { draft: { receptor: { tipoDocumento: string; numDocumento: string }; resumen: { valorTotal: number } } };
    expect(body.draft.receptor).toMatchObject({ tipoDocumento: "03", numDocumento: "A1234567" });
    expect(body.draft.resumen.valorTotal).toBe(1);
  });

  it("opens the advanced template with empty donor fields so the wizard can collect them", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced-template", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ amount: "", donorName: "", donorDocumentType: "13", donorDocument: "", donorEmail: "", donorPhone: "" })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig())
      })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { draft: { receptor: { tipoDocumento: string; numDocumento: string; nombre: string } } };
    expect(body.draft.receptor).toMatchObject({ tipoDocumento: "13", numDocumento: "", nombre: "" });
  });

  it("stores a schema-valid advanced CDE draft and queues it for transmission", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ draft: advancedCdeDraft() })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, queued: true });
    expect(db.wompiEvents).toHaveLength(0);
    expect(db.documents).toHaveLength(1);
    const generated = JSON.parse(db.documents[0].plain_json);
    expect(generated.identificacion).toMatchObject({
      version: 2,
      ambiente: "00",
      tipoDte: "15",
      numeroControl: "DTE-15-M001P004-000000000000001",
      tipoOperacion: 1,
      tipoMoneda: "USD"
    });
    expect(generated.identificacion.codigoGeneracion).toMatch(/^[A-F0-9-]{36}$/);
    expect(generated.receptor.nombre).toBe("Example Person Advanced");
    expect(generated.cuerpoDocumento[0].descripcion).toBe("Diezmo avanzado");
    expect(db.documents[0]).toMatchObject({
      wompi_event_id: null,
      donor_email: "advanced@example.org",
      donor_name: "Example Person Advanced",
      amount_cents: 12345,
      status: "PENDING"
    });
    expect(queued).toEqual([{ advancedDocumentId: db.documents[0].id }]);
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "ADVANCED_CDE_CREATED", entity_type: "dte_document" }));
  });

  it("rejects an advanced CDE draft that does not match the CDE schema", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ draft: { receptor: { nombre: "Sin estructura" } } })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_advanced_cde" });
    expect(db.documents).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it("rejects final generation of a template draft whose receptor was left empty", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    const baseEnv = {
      APP_ENV: "staging",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
    };

    const templateResponse = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced-template", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ amount: "", donorName: "", donorDocumentType: "13", donorDocument: "", donorEmail: "", donorPhone: "" })
      }),
      env(db, baseEnv)
    );
    expect(templateResponse.status).toBe(200);
    const { draft: emptyReceptorDraft } = (await templateResponse.json()) as { draft: Record<string, unknown> };

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ draft: emptyReceptorDraft })
      }),
      env(db, baseEnv)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_advanced_cde" });
    expect(db.documents).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });

  it("rejects an advanced CDE draft with an invalid DUI check digit", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    const draft = advancedCdeDraft();
    (draft.receptor as Record<string, unknown>).tipoDocumento = "13";
    (draft.receptor as Record<string, unknown>).numDocumento = "00000000-9";

    const response = await worker.fetch(
      new Request("https://example.org/api/test/dte/advanced", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ draft })
      }),
      env(db, {
        APP_ENV: "staging",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_advanced_cde",
      message: expect.stringContaining("DUI")
    });
    expect(db.documents).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });
});

describe("Wompi webhook integration", () => {
  it("accepts a signed official Wompi webhook and queues approved payments", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_doc_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      cliente: {
        DocumentoIdentidad: "10000000-1",
        Nombre: "Example",
        Apellidos: "Person",
        EMail: "donor@example.org",
        Celular: "70000005",
        CodigoPais: "SV",
        CodigoRegion: "06"
      },
      enlacePago: {
        IdentificadorEnlaceComercio: "DONACION-123"
      }
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          wompi_hash: await signWompiBody(rawBody, secret)
        },
        body: rawBody
      }),
      env(db, {
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, inserted: true, queued: true });
    expect(db.wompiEvents).toHaveLength(1);
    expect(db.wompiEvents[0]).toMatchObject({
      transaction_id: "wompi_doc_tx_1",
      environment: "00",
      result: "ExitosaAprobada",
      amount_cents: 2500,
      donor_email: "donor@example.org",
      donor_name: "Example Person"
    });
    expect(queued).toEqual([{ wompiEventId: db.wompiEvents[0].id }]);
  });

  it("normalizes the stored raw Wompi body before generating the queued CDE", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_pipeline_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      cliente: {
        DocumentoIdentidad: "10000000-1",
        Nombre: "Example",
        Apellidos: "Person",
        EMail: "donor@example.org",
        Celular: "70000005",
        CodigoPais: "SV",
        CodigoRegion: "06"
      }
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          wompi_hash: await signWompiBody(rawBody, secret)
        },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );
    const body = await response.json() as { wompiEventId: string };
    const certificateXml = await generatedCertificateXml("cert-password");

    const record = await new IssuancePipeline(env(db, {
      EMISOR_CONFIG_JSON: JSON.stringify({ ...emisorConfig(), defaultDonationType: 1 }),
      MH_CERT_XML: certificateXml,
      MH_CERT_PASSWORD: "cert-password"
    })).processWompiEvent(body.wompiEventId);

    expect(record).toMatchObject({
      donor_email: "donor@example.org",
      donor_name: "Example Person",
      amount_cents: 2500,
      status: "ACCEPTED"
    });
    const cde = JSON.parse(record!.plain_json) as { receptor: { nombre: string; correo: string; telefono: string } };
    expect(cde.receptor).toMatchObject({
      nombre: "Example Person",
      correo: "donor@example.org",
      telefono: "70000005"
    });
  });

  it("returns a clear 400 for signed webhook payloads Wompi cannot map to a transaction", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      ResultadoTransaccion: "ExitosaAprobada",
      Monto: "25.00",
      EsProductiva: false
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          wompi_hash: await signWompiBody(rawBody, secret)
        },
        body: rawBody
      }),
      env(db, {
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_wompi_payload",
      message: expect.stringContaining("IdTransaccion")
    });
    expect(db.wompiEvents).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });
});

describe("pipeline failure alerts", () => {
  it("sends an operational alert when a Wompi-triggered DTE fails", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_alert_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      cliente: {
        DocumentoIdentidad: "10000000-1",
        Nombre: "Example",
        Apellidos: "Person",
        EMail: "donor@example.org",
        Celular: "70000005",
        CodigoPais: "SV",
        CodigoRegion: "06"
      }
    });

    const webhookResponse = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );
    const { wompiEventId } = (await webhookResponse.json()) as { wompiEventId: string };

    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      EMAIL_FROM: "alerts@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-dte-failed" };
        }
      } as SendEmail
      // MH_CERT_XML intentionally omitted so signing fails before reaching MH,
      // deterministically driving the DTE into the FAILED path.
    });

    await expect(new IssuancePipeline(pipelineEnv).processWompiEvent(wompiEventId)).rejects.toThrow();

    const failedDocument = db.documents.find((document) => document.wompi_event_id === wompiEventId);
    expect(failedDocument?.status).toBe("FAILED");
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "DTE_FAILED", entity_id: failedDocument!.id }));
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0].to).toBe("owner@example.org");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:DTE_FAILED", entity_type: "dte_document", entity_id: failedDocument!.id })
    );
  });

  it("sends an operational alert when an advanced CDE fails", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.documents.push(advancedFailingDocument("doc_advanced_fail"));

    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-advanced-failed" };
        }
      } as SendEmail
      // MH_CERT_XML intentionally omitted so signing fails deterministically.
    });

    await expect(new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_fail")).rejects.toThrow();

    expect(db.audits).toContainEqual(expect.objectContaining({ action: "ADVANCED_CDE_FAILED", entity_id: "doc_advanced_fail" }));
    expect(sentAlerts).toHaveLength(1);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:ADVANCED_CDE_FAILED", entity_type: "dte_document", entity_id: "doc_advanced_fail" })
    );
  });

  it("does not fail the pipeline when the alert email provider throws", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.documents.push(advancedFailingDocument("doc_advanced_fail_alert_error"));

    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: {
        send: async () => {
          throw new Error("destination address is not a verified address");
        }
      } as SendEmail
    });

    await expect(new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_fail_alert_error")).rejects.toThrow();

    const document = db.documents.find((doc) => doc.id === "doc_advanced_fail_alert_error");
    expect(document?.status).toBe("FAILED");
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "ADVANCED_CDE_FAILED", entity_id: "doc_advanced_fail_alert_error" }));
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_FAILED:ADVANCED_CDE_FAILED", entity_type: "dte_document", entity_id: "doc_advanced_fail_alert_error" })
    );
  });

  it("does not send a duplicate alert for a document that fails twice", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.documents.push(advancedFailingDocument("doc_advanced_fail_twice"));

    const sentAlerts: unknown[] = [];
    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: { send: async (message: unknown) => { sentAlerts.push(message); return { messageId: "x" }; } } as SendEmail
    });

    await expect(new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_fail_twice")).rejects.toThrow();
    await expect(new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_fail_twice")).rejects.toThrow();

    expect(sentAlerts).toHaveLength(1);
  });

  it("does not send an alert when alert_email is unset", async () => {
    const db = new InMemoryD1();
    db.documents.push(advancedFailingDocument("doc_advanced_fail_no_alert_email"));

    const sentAlerts: unknown[] = [];
    const pipelineEnv = env(db, {
      APP_ENV: "staging",
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      EMAIL: { send: async (message: unknown) => { sentAlerts.push(message); return { messageId: "x" }; } } as SendEmail
    });

    await expect(new IssuancePipeline(pipelineEnv).processDteDocument("doc_advanced_fail_no_alert_email")).rejects.toThrow();

    expect(sentAlerts).toHaveLength(0);
  });
});

describe("issuance dead-letter and stalled-event sweep", () => {
  function deadLetterBatch(body: IssuanceMessage, queueName: string) {
    const ack = vi.fn();
    const retry = vi.fn();
    const batch = {
      queue: queueName,
      messages: [{ id: "msg_1", timestamp: new Date(), body, attempts: 3, ack, retry }],
      ackAll: vi.fn(),
      retryAll: vi.fn()
    } as unknown as MessageBatch<IssuanceMessage>;
    return { batch, ack, retry };
  }

  function stalledWompiEvent(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
    return {
      id: "wompi_stalled",
      transaction_id: "TX-STALLED-1",
      environment: "00",
      result: "ExitosaAprobada",
      amount_cents: 2500,
      donor_email: "donante@example.org",
      donor_name: "Donante",
      raw_body: "{}",
      processed_at: null,
      created_document_id: null,
      received_at: "2026-01-01T00:00:00.000Z",
      ...overrides
    };
  }

  it("audits and acks dead-lettered issuance messages", async () => {
    const db = new InMemoryD1();
    const { batch, ack, retry } = deadLetterBatch({ wompiEventId: "wompi_dead" }, "diezmossv-staging-issuance-example-dlq");

    await worker.queue(batch, env(db));

    expect(ack).toHaveBeenCalledTimes(1);
    expect(retry).not.toHaveBeenCalled();
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ISSUANCE_DEAD_LETTERED", entity_type: "wompi_event", entity_id: "wompi_dead" })
    );
  });

  it("sends an operational alert for a dead-lettered issuance message", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const { batch } = deadLetterBatch({ wompiEventId: "wompi_dead_alert" }, "diezmossv-staging-issuance-example-dlq");

    await worker.queue(
      batch,
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "alerts@example.org",
        EMAIL: {
          send: async (message: unknown) => {
            sentAlerts.push(message as { to: string; subject: string });
            return { messageId: "alert-dead-letter" };
          }
        } as SendEmail
      })
    );

    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0].to).toBe("owner@example.org");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:ISSUANCE_DEAD_LETTERED", entity_type: "wompi_event", entity_id: "wompi_dead_alert" })
    );
  });

  it("re-enqueues an approved wompi event stuck without a document for over an hour", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    db.wompiEvents.push(stalledWompiEvent());

    await worker.scheduled({} as ScheduledEvent, env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    }));

    expect(queued).toEqual([{ wompiEventId: "wompi_stalled" }]);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "WOMPI_EVENT_REQUEUED", entity_id: "wompi_stalled" })
    );
  });

  it("does not touch recent or already-processed events", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    db.wompiEvents.push(stalledWompiEvent({ id: "wompi_fresh", received_at: new Date().toISOString() }));
    db.wompiEvents.push(stalledWompiEvent({ id: "wompi_done", created_document_id: "dte_1" }));
    db.wompiEvents.push(stalledWompiEvent({ id: "wompi_declined", result: "Rechazada" }));

    await worker.scheduled({} as ScheduledEvent, env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    }));

    expect(queued).toHaveLength(0);
  });

  it("gives up after three requeues and flags the event exactly once", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    db.wompiEvents.push(stalledWompiEvent());
    for (let i = 0; i < 3; i++) {
      db.audits.push({ id: `audit_rq_${i}`, actor_type: "SYSTEM", actor_id: null, action: "WOMPI_EVENT_REQUEUED", entity_type: "wompi_event", entity_id: "wompi_stalled", summary: "", metadata_json: "{}", created_at: "2026-01-01T00:00:00.000Z" });
    }
    const scheduledEnv = env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    });

    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);

    expect(queued).toHaveLength(0);
    const stalledAudits = db.audits.filter((audit) => audit.action === "WOMPI_EVENT_STALLED" && audit.entity_id === "wompi_stalled");
    expect(stalledAudits).toHaveLength(1);
  });

  it("sends a single operational alert even across repeated 15-minute cron runs", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.wompiEvents.push(stalledWompiEvent());
    for (let i = 0; i < 3; i++) {
      db.audits.push({ id: `audit_rq_${i}`, actor_type: "SYSTEM", actor_id: null, action: "WOMPI_EVENT_REQUEUED", entity_type: "wompi_event", entity_id: "wompi_stalled", summary: "", metadata_json: "{}", created_at: "2026-01-01T00:00:00.000Z" });
    }
    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queuedNoop(message) } as unknown as Queue<IssuanceMessage>,
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-stalled" };
        }
      } as SendEmail
    });

    // Simulate three consecutive 15-minute cron ticks after the event is already flagged stalled.
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);

    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0].to).toBe("owner@example.org");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:WOMPI_EVENT_STALLED", entity_type: "wompi_event", entity_id: "wompi_stalled" })
    );
  });

  it("retries the operational alert on a later tick after the first send attempt fails", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    db.wompiEvents.push(stalledWompiEvent());
    for (let i = 0; i < 3; i++) {
      db.audits.push({ id: `audit_rq_${i}`, actor_type: "SYSTEM", actor_id: null, action: "WOMPI_EVENT_REQUEUED", entity_type: "wompi_event", entity_id: "wompi_stalled", summary: "", metadata_json: "{}", created_at: "2026-01-01T00:00:00.000Z" });
    }
    const sentAlerts: Array<{ to: string; subject: string }> = [];
    let attempt = 0;
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queuedNoop(message) } as unknown as Queue<IssuanceMessage>,
      EMAIL: {
        send: async (message: unknown) => {
          attempt += 1;
          if (attempt === 1) {
            throw new Error("SMTP unavailable");
          }
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-stalled-retry" };
        }
      } as SendEmail
    });

    // Tick 1: email provider throws — WOMPI_EVENT_STALLED audit is written but the alert send fails.
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    expect(sentAlerts).toHaveLength(0);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_FAILED:WOMPI_EVENT_STALLED", entity_type: "wompi_event", entity_id: "wompi_stalled" })
    );
    expect(db.audits.filter((audit) => audit.action === "WOMPI_EVENT_STALLED")).toHaveLength(1);

    // Tick 2: email provider succeeds — the alert must be retried (not permanently
    // suppressed by the WOMPI_EVENT_STALLED audit from tick 1) and now sends.
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    expect(sentAlerts).toHaveLength(1);
    expect(sentAlerts[0].to).toBe("owner@example.org");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:WOMPI_EVENT_STALLED", entity_type: "wompi_event", entity_id: "wompi_stalled" })
    );

    // Tick 3: alert already sent — sendOperationalAlert's own dedupe prevents a resend.
    await worker.scheduled({} as ScheduledEvent, scheduledEnv);
    expect(sentAlerts).toHaveLength(1);
  });
});

function queuedNoop(_message: IssuanceMessage): void {
  // Sweep should not requeue once an event has already been flagged stalled.
}

describe("scheduled cron dispatch", () => {
  it("routes the monthly retention cron to the retention export, not the 15-minute sweeps", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(stalledWompiEventFixture());
    const queued: IssuanceMessage[] = [];
    const archive = new FakeArchiveBucket();
    const scheduledEnv = env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>,
      ARCHIVE: archive as unknown as R2Bucket
    });

    await worker.scheduled({ cron: "0 9 1 * *", scheduledTime: new Date("2026-07-01T09:00:00.000Z").getTime() } as ScheduledEvent, scheduledEnv);

    // Retention export ran (audited), and the 15-minute sweep logic (which
    // would have requeued the stalled Wompi event) did not run.
    expect(db.audits.some((audit) => String(audit.action).startsWith("RETENTION_EXPORT_"))).toBe(true);
    expect(queued).toHaveLength(0);
    expect(db.audits.some((audit) => audit.action === "WOMPI_EVENT_REQUEUED")).toBe(false);
  });

  it("routes the 15-minute cron to the existing sweeps, not the retention export", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push(stalledWompiEventFixture());
    const queued: IssuanceMessage[] = [];
    const archive = new FakeArchiveBucket();
    const scheduledEnv = env(db, {
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>,
      ARCHIVE: archive as unknown as R2Bucket
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: new Date("2026-07-01T09:15:00.000Z").getTime() } as ScheduledEvent, scheduledEnv);

    expect(queued).toEqual([{ wompiEventId: "wompi_stalled" }]);
    expect(archive.putCalls).toHaveLength(0);
    expect(db.audits.some((audit) => String(audit.action).startsWith("RETENTION_EXPORT_"))).toBe(false);
  });

  it("isolates a retention export failure so it never throws out of scheduled()", async () => {
    const db = new InMemoryD1();
    const archive = new FakeArchiveBucket();
    vi.spyOn(archive, "put").mockRejectedValue(new Error("R2 unavailable"));
    const scheduledEnv = env(db, { ARCHIVE: archive as unknown as R2Bucket });

    await expect(
      worker.scheduled({ cron: "0 9 1 * *", scheduledTime: new Date("2026-07-01T09:00:00.000Z").getTime() } as ScheduledEvent, scheduledEnv)
    ).resolves.toBeUndefined();

    expect(db.audits).toContainEqual(expect.objectContaining({ action: "RETENTION_EXPORT_FAILED" }));
  });
});

describe("certificate expiry alerts (15-minute cron)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("formats the expiry date in Spanish and counts days remaining in the alert copy", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-01T09:15:00.000Z") });
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    const expiresAt = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000); // 2026-07-11
    const sentAlerts: Array<{ to: string; subject: string; text: string }> = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      MH_CERT_XML: certXmlWithExpiry(expiresAt),
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string; text: string });
          return { messageId: "alert-cert-expiring-copy" };
        }
      } as SendEmail
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);

    expect(sentAlerts.length).toBeGreaterThan(0);
    for (const alert of sentAlerts) {
      expect(alert.text).toContain("vence el 11/07/2026");
      expect(alert.text).toContain("Quedan 10 día(s)");
      expect(alert.text).not.toContain(expiresAt.toISOString());
    }
  });

  it("words an already-expired certificate as 'venció hace N días' instead of a negative countdown", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-01T09:15:00.000Z") });
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    const expiresAt = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // already expired 5 days ago
    const sentAlerts: Array<{ to: string; subject: string; text: string }> = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      MH_CERT_XML: certXmlWithExpiry(expiresAt),
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string; text: string });
          return { messageId: "alert-cert-expired-copy" };
        }
      } as SendEmail
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);

    expect(sentAlerts.length).toBeGreaterThan(0);
    for (const alert of sentAlerts) {
      expect(alert.text).toContain("venció hace 5 días");
      expect(alert.text).not.toContain("Quedan -5");
    }
  });

  it("sends a CERT_EXPIRING alert once per threshold crossed and never duplicates on repeated ticks", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    const expiresAt = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000); // 10 days out: crosses 30 and 14 thresholds, not 3
    const sentAlerts: Array<{ to: string; subject: string }> = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      MH_CERT_XML: certXmlWithExpiry(expiresAt),
      EMAIL: {
        send: async (message: unknown) => {
          sentAlerts.push(message as { to: string; subject: string });
          return { messageId: "alert-cert-expiring" };
        }
      } as SendEmail
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);
    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);

    expect(sentAlerts).toHaveLength(2);
    expect(sentAlerts.every((alert) => alert.to === "owner@example.org")).toBe(true);
    const expiryIso = expiresAt.toISOString();
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:CERT_EXPIRING", entity_type: "credentials", entity_id: `${expiryIso}:30` })
    );
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "ALERT_SENT:CERT_EXPIRING", entity_type: "credentials", entity_id: `${expiryIso}:14` })
    );
    expect(db.audits.filter((audit) => audit.action === "ALERT_SENT:CERT_EXPIRING")).toHaveLength(2);
  });

  it("does not alert when more than 30 days remain before expiry", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    const expiresAt = new Date(now.getTime() + 45 * 24 * 60 * 60 * 1000);
    const sentAlerts: unknown[] = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      MH_CERT_XML: certXmlWithExpiry(expiresAt),
      EMAIL: { send: async (message: unknown) => (sentAlerts.push(message), { messageId: "unused" }) } as SendEmail
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);

    expect(sentAlerts).toHaveLength(0);
    expect(db.audits.some((audit) => audit.action === "ALERT_SENT:CERT_EXPIRING")).toBe(false);
  });

  it("re-arms alerts for a renewed certificate because the dedupe key includes the expiry date", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    const oldExpiresAt = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000);
    db.audits.push({
      id: "audit_prior_alert",
      actor_type: "SYSTEM",
      actor_id: null,
      action: "ALERT_SENT:CERT_EXPIRING",
      entity_type: "credentials",
      entity_id: `${oldExpiresAt.toISOString()}:14`,
      summary: "",
      metadata_json: "{}",
      created_at: "2026-06-01T00:00:00.000Z"
    });
    const renewedExpiresAt = new Date(now.getTime() + 400 * 24 * 60 * 60 * 1000);
    const sentAlerts: unknown[] = [];
    const scheduledEnv = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "alerts@example.org",
      MH_CERT_XML: certXmlWithExpiry(renewedExpiresAt),
      EMAIL: { send: async (message: unknown) => (sentAlerts.push(message), { messageId: "unused" }) } as SendEmail
    });

    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: now.getTime() } as ScheduledEvent, scheduledEnv);

    // Renewed cert is >30 days out, so no new alert fires — but the important
    // assertion is that the stale dedupe audit for the old expiry date does
    // not suppress a future alert against the new expiry date.
    expect(sentAlerts).toHaveLength(0);
    expect(db.audits.filter((audit) => audit.action === "ALERT_SENT:CERT_EXPIRING")).toHaveLength(1);
  });

  it("never throws when the certificate secret is absent, and sends no alert", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const scheduledEnv = env(db, { MOCK_EXTERNAL_SERVICES: "false", EMAIL_FROM: "alerts@example.org" });

    await expect(
      worker.scheduled({ cron: "*/15 * * * *", scheduledTime: new Date("2026-07-01T09:15:00.000Z").getTime() } as ScheduledEvent, scheduledEnv)
    ).resolves.toBeUndefined();

    expect(db.audits.some((audit) => audit.action === "ALERT_SENT:CERT_EXPIRING")).toBe(false);
  });
});

function certXmlWithExpiry(expiresAt: Date): string {
  const epochSecond = Math.floor(expiresAt.getTime() / 1000);
  return `<CertificadoMH><activo>true</activo><certificado><basicEstructure><validity><notAfter><epochSecond>${epochSecond}</epochSecond></notAfter></validity></basicEstructure></certificado></CertificadoMH>`;
}

function stalledWompiEventFixture(): Record<string, unknown> {
  return {
    id: "wompi_stalled",
    transaction_id: "TX-STALLED-1",
    environment: "00",
    result: "ExitosaAprobada",
    amount_cents: 2500,
    donor_email: "donante@example.org",
    donor_name: "Donante",
    raw_body: "{}",
    processed_at: null,
    created_document_id: null,
    received_at: "2026-01-01T00:00:00.000Z"
  };
}

describe("credential administration", () => {
  it("returns safe credential status to owners", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/credentials", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, {
        APP_ENV: "staging",
        CLOUDFLARE_SCRIPT_NAME: "diezmossv-staging-resource-example",
        MH_USER_TEST: "0614",
        MH_PASSWORD_TEST: "test-password",
        MH_CERT_XML_PART_1: "<CertificadoMH>",
        MH_CERT_XML_PART_2: "</CertificadoMH>",
        MH_CERT_PASSWORD: "cert-password",
        WOMPI_API_SECRET: "wompi-secret"
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json() as Record<string, unknown>;
    expect(data).toMatchObject({
      credentials: {
        target: {
          appEnv: "staging",
          scriptName: "diezmossv-staging-resource-example",
          writerConfigured: false,
          writerMissing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]
        },
        groups: {
          mhTest: { ready: true },
          signer: { ready: true },
          wompi: {
            label: "Webhook entrante de Wompi",
            ready: true,
            items: [
              {
                name: "WOMPI_API_SECRET",
                label: "Firma del webhook entrante",
                configured: true
              }
            ]
          }
        }
      }
    });
    expect(JSON.stringify(data)).not.toContain("test-password");
    expect(JSON.stringify(data)).not.toContain("cert-password");
    expect(JSON.stringify(data)).not.toContain("wompi-secret");
  });

  it("returns a clear error when credential update is not configured", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/credentials", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ environment: "test", mhUser: "0614", mhPassword: "test-password" })
      }),
      env(db, { APP_ENV: "staging" })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "credential_writer_not_configured"
    });
    expect(db.audits).toHaveLength(0);
  });

  it("lets owners bootstrap the Cloudflare writer token without echoing it", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://example.org/api/credentials/writer-token", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ token: "cf-writer-token" })
      }),
      env(db, {
        APP_ENV: "staging",
        CLOUDFLARE_ACCOUNT_ID: "account-id",
        CLOUDFLARE_SCRIPT_NAME: "diezmossv-staging-resource-example",
        CLOUDFLARE_API_BASE_URL: "https://cf.test"
      })
    );

    expect(response.status).toBe(200);
    const data = await response.json() as Record<string, unknown>;
    expect(data).toMatchObject({
      ok: true,
      updated: ["CLOUDFLARE_API_TOKEN"],
      credentials: {
        target: {
          writerConfigured: true,
          writerMissing: []
        }
      }
    });
    expect(JSON.stringify(data)).not.toContain("cf-writer-token");
    expect(JSON.stringify(db.audits)).not.toContain("cf-writer-token");
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "CLOUDFLARE_WRITER_ENABLED",
      entity_id: "diezmossv-staging-resource-example"
    }));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://cf.test/accounts/account-id/workers/scripts/diezmossv-staging-resource-example/secrets-bulk");
    expect(init.headers).toMatchObject({ Authorization: "Bearer cf-writer-token" });
  });
});

describe("email template settings", () => {
  it("lets owners edit subject and body templates for each email type", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/email-templates", {
        method: "PUT",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          templates: {
            dteReceipt: {
              subject: "CDE {{numeroControl}} emitido",
              body: "Estimado {{donante}}, se emitió {{numeroControl}} por {{monto}}."
            },
            dteInvalidation: {
              subject: "CDE {{numeroControl}} invalidado",
              body: "El CDE {{numeroControl}} quedó {{estado}}."
            }
          }
        })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      emailTemplates: {
        definitions: [
          expect.objectContaining({ type: "dteReceipt", label: "Envío de comprobante" }),
          expect.objectContaining({ type: "dteInvalidation", label: "Invalidación de comprobante" })
        ],
        placeholders: expect.arrayContaining(["{{numeroControl}}", "{{donante}}", "{{monto}}"]),
        templates: {
          dteReceipt: {
            subject: "CDE {{numeroControl}} emitido",
            body: "Estimado {{donante}}, se emitió {{numeroControl}} por {{monto}}."
          },
          dteInvalidation: {
            subject: "CDE {{numeroControl}} invalidado",
            body: "El CDE {{numeroControl}} quedó {{estado}}."
          }
        }
      }
    });
    expect(db.settings).toContainEqual(expect.objectContaining({
      key: "email_templates_json",
      updated_by: "user_owner"
    }));
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "EMAIL_TEMPLATES_UPDATED",
      entity_type: "app_setting",
      entity_id: "email_templates_json"
    }));

    const getResponse = await worker.fetch(
      new Request("https://example.org/api/settings/email-templates", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({
      emailTemplates: {
        templates: {
          dteReceipt: { subject: "CDE {{numeroControl}} emitido" },
          dteInvalidation: { subject: "CDE {{numeroControl}} invalidado" }
        }
      }
    });
  });
});

describe("alert email setting", () => {
  it("lets owners configure and read back the operational alert recipient", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const putResponse = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "owner@example.org" })
      }),
      env(db)
    );

    expect(putResponse.status).toBe(200);
    await expect(putResponse.json()).resolves.toMatchObject({ ok: true, alertEmail: "owner@example.org" });
    expect(db.settings).toContainEqual(expect.objectContaining({ key: "alert_email", value: "owner@example.org", updated_by: "user_owner" }));
    expect(db.audits).toContainEqual(expect.objectContaining({
      action: "ALERT_EMAIL_UPDATED",
      entity_type: "app_setting",
      entity_id: "alert_email"
    }));

    const getResponse = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({ alertEmail: "owner@example.org" });
  });

  it("allows clearing the alert email to disable alerting", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.settings.push({ key: "alert_email", value: "owner@example.org", updated_by: "user_owner" });

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "" })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, alertEmail: "" });
  });

  it("rejects a malformed alert email", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "correo-invalido" })
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_alert_email" });
  });

  it("rejects non-owners", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(403);
  });
});

describe("manual retention export endpoint", () => {
  it("lets an owner trigger the retention export for an explicit month and audits the request", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.documents.push(testDocument({ id: "doc_1", created_at: "2026-03-15T00:00:00.000Z" }));
    const archive = new FakeArchiveBucket();

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/retention-export?month=2026-03", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: "completed", month: "2026-03" });
    expect(archive.objects.has("retention/2026/2026-03/manifest.json")).toBe(true);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_EXPORT_REQUESTED", entity_type: "retention_export", entity_id: "2026-03" })
    );
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "RETENTION_EXPORT_COMPLETED" }));
  });

  it("rejects a malformed month parameter", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/retention-export?month=not-a-month", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_retention_month" });
  });

  it("rejects an export request for the current (still-open) month and writes nothing to the archive", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const archive = new FakeArchiveBucket();
    // The month currently open in El Salvador local time — same helper the
    // handler itself will use to compute "the previous closed month" — so
    // this test targets "now"'s own month regardless of when it runs.
    const currentMonth = previousElSalvadorMonth(new Date(Date.now() + 31 * 24 * 60 * 60 * 1000));

    const response = await worker.fetch(
      new Request(`https://example.org/api/admin/retention-export?month=${currentMonth}`, {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_retention_month" });
    expect(archive.putCalls).toHaveLength(0);
  });

  it("returns HTTP 500 when the export itself fails, instead of 200 with ok:false", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    db.documents.push(testDocument({ id: "doc_1", created_at: "2026-03-15T00:00:00.000Z" }));
    const archive = new FakeArchiveBucket();
    vi.spyOn(archive, "put").mockRejectedValue(new Error("R2 unavailable"));

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/retention-export?month=2026-03", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ ok: false, status: "failed", month: "2026-03" });
  });

  it("rejects non-owners", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/retention-export", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(403);
  });
});

function bootstrapRequest(options: { token?: string } = {}): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.token) {
    headers.set("X-Bootstrap-Owner-Token", options.token);
  }
  return new Request("https://example.org/api/auth/bootstrap-owner", {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: "legacy-contact-3@example.com",
      name: "Example Person",
      password: "Long-enough1!"
    })
  });
}

function env(db: InMemoryD1, values: Partial<Env> = {}): Env {
  return {
    DB: db as unknown as D1Database,
    ISSUANCE_QUEUE: { send: async () => undefined } as unknown as Queue,
    ASSETS: { fetch: () => Promise.resolve(new Response("asset")) } as unknown as Fetcher,
    ARCHIVE: new FakeArchiveBucket() as unknown as R2Bucket,
    // Default to mocked external services so tests that never touch email/MH stay
    // offline under the explicit-opt-in rule (isMockMode only mocks when "true").
    // Tests exercising real dispatch override this with "false".
    MOCK_EXTERNAL_SERVICES: "true",
    ...values
  };
}

// Minimal in-memory R2 fake for tests that don't exercise retention export
// directly but still need a well-typed ARCHIVE binding on Env.
class FakeArchiveBucket {
  readonly objects = new Map<string, Uint8Array>();
  readonly putCalls: Array<{ key: string; bytes: Uint8Array }> = [];
  readonly headCalls: string[] = [];

  async put(key: string, value: unknown): Promise<R2Object> {
    const bytes = value instanceof Uint8Array ? value : utf8Bytes(String(value));
    this.objects.set(key, bytes);
    this.putCalls.push({ key, bytes });
    return { key } as R2Object;
  }

  async head(key: string): Promise<R2Object | null> {
    this.headCalls.push(key);
    return this.objects.has(key) ? ({ key } as R2Object) : null;
  }
}

class InMemoryD1 {
  readonly users: Array<Record<string, unknown>> = [];
  readonly sessions: Array<Record<string, unknown>> = [];
  readonly audits: Array<Record<string, unknown>> = [];
  readonly documents: DteDocumentRecord[] = [];
  readonly preparedSql: string[] = [];
  readonly emailDeliveries: Array<Record<string, unknown>> = [];
  readonly wompiEvents: Array<Record<string, unknown>> = [];
  readonly contingencies: Array<Record<string, unknown>> = [];
  readonly contingencyBatches: Array<Record<string, unknown>> = [];
  readonly contingencyBatchLines: Array<Record<string, unknown>> = [];
  readonly dteEvents: Array<Record<string, unknown>> = [];
  readonly settings: Array<Record<string, unknown>> = [];
  readonly resetTokens: Array<Record<string, unknown>> = [];
  nextSequence = 1;
  sessionUser: Record<string, string> | null = null;

  prepare(sql: string): Statement {
    this.preparedSql.push(sql);
    return new Statement(this, sql);
  }
}

class Statement {
  private args: unknown[] = [];

  constructor(
    private readonly db: InMemoryD1,
    private readonly sql: string
  ) {}

  bind(...args: unknown[]): this {
    this.args = args;
    return this;
  }

  async first<T>(): Promise<T | null> {
    if (this.sql.includes("FROM sessions") && this.sql.includes("JOIN users")) {
      return this.db.sessionUser as T | null;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM users")) {
      return { count: this.db.users.length } as T;
    }
    if (this.sql.includes("FROM users WHERE id = ?")) {
      return (this.db.users.find((user) => user.id === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("FROM users WHERE email = ?")) {
      return (this.db.users.find((user) => String(user.email).toLowerCase() === String(this.args[0]).toLowerCase()) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM audit_logs") && this.sql.includes("created_at >= ?")) {
      const [action, entityId, sinceIso] = this.args.map(String);
      return {
        count: this.db.audits.filter(
          (audit) => audit.action === action && audit.entity_id === entityId && String(audit.created_at) >= sinceIso
        ).length
      } as T;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM audit_logs")) {
      const [action, entityId] = this.args.map(String);
      return { count: this.db.audits.filter((audit) => audit.action === action && audit.entity_id === entityId).length } as T;
    }
    if (this.sql.includes("FROM password_reset_tokens") && this.sql.includes("JOIN users")) {
      const [tokenHash, nowIso] = this.args.map(String);
      const token = this.db.resetTokens.find(
        (row) => row.token_hash === tokenHash && !row.used_at && String(row.expires_at) > nowIso
      );
      if (!token) return null;
      const user = this.db.users.find((row) => row.id === token.user_id && !row.disabled_at);
      if (!user) return null;
      return { id: user.id, email: user.email, name: user.name, role: user.role, token_id: token.id, user_id: user.id } as T;
    }
    if (this.sql.includes("SELECT * FROM dte_documents WHERE id = ?")) {
      return (this.db.documents.find((document) => document.id === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT * FROM wompi_events WHERE id = ?")) {
      return (this.db.wompiEvents.find((event) => event.id === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT * FROM wompi_events WHERE transaction_id = ?")) {
      return (this.db.wompiEvents.find((event) => event.transaction_id === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT value FROM app_settings WHERE key = ?")) {
      return (this.db.settings.find((setting) => setting.key === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("FROM contingency_periods WHERE environment = ?")) {
      const environment = String(this.args[0]);
      return (
        this.db.contingencies
          .filter((period) => period.environment === environment && ["OPEN", "EVENT_ACCEPTED"].includes(String(period.status)))
          .sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)))[0] ?? null
      ) as T | null;
    }
    if (this.sql.includes("FROM contingency_periods WHERE status IN")) {
      return (
        this.db.contingencies
          .filter((period) => ["OPEN", "EVENT_ACCEPTED"].includes(String(period.status)))
          .sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)))[0] ?? null
      ) as T | null;
    }
    if (this.sql.includes("UPDATE document_sequences")) {
      return { value: this.db.nextSequence++ } as T;
    }
    return null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    const orderByMatch = this.sql.match(/ORDER BY (created_at|received_at) ASC, id ASC LIMIT \?/);
    if (orderByMatch) {
      const column = orderByMatch[1];
      const table = retentionTableFor(this.db, this.sql);
      if (table) {
        let rows = [...table];
        const windowRe = new RegExp(`${column} >= \\? AND ${column} < \\?`);
        const cursorRe = new RegExp(`\\(${column}, id\\) > \\(\\?, \\?\\)`);
        if (windowRe.test(this.sql)) {
          const hasCursor = cursorRe.test(this.sql);
          const [start, end] = this.args.map(String);
          rows = rows.filter((row) => String(row[column]) >= start && String(row[column]) < end);
          if (hasCursor) {
            const [afterColumn, afterId] = [this.args[2], this.args[3]].map(String);
            rows = rows.filter((row) => {
              const value = String(row[column]);
              const id = String(row.id);
              return value > afterColumn || (value === afterColumn && id > afterId);
            });
          }
        } else if (cursorRe.test(this.sql)) {
          const [afterColumn, afterId] = [this.args[0], this.args[1]].map(String);
          rows = rows.filter((row) => {
            const value = String(row[column]);
            const id = String(row.id);
            return value > afterColumn || (value === afterColumn && id > afterId);
          });
        }
        rows.sort((left, right) => String(left[column]).localeCompare(String(right[column])) || String(left.id).localeCompare(String(right.id)));
        const limit = Number(this.args.at(-1) ?? 500);
        return { results: rows.slice(0, limit) as T[] };
      }
    }
    if (this.sql.includes("FROM wompi_events") && this.sql.includes("created_document_id IS NULL")) {
      // The real wompi_events schema has no created_at column (only received_at) —
      // require the query to reference the column that actually exists, so a
      // regression back to `created_at < ?` fails here instead of silently
      // matching on a column the fake happens to also carry.
      if (!this.sql.includes("received_at < ?") || this.sql.includes("created_at < ?")) {
        throw new Error(`SQLITE_ERROR: no such column: created_at (simulated) for SQL: ${this.sql}`);
      }
      const cutoff = String(this.args[0]);
      const stalled = this.db.wompiEvents.filter(
        (event) =>
          !event.created_document_id &&
          !event.processed_at &&
          event.result === "ExitosaAprobada" &&
          String(event.received_at) < cutoff
      );
      return { results: stalled as T[] };
    }
    if (this.sql.includes("FROM contingency_batches")) {
      let batches = [...this.db.contingencyBatches];
      if (this.sql.includes("WHERE contingency_period_id = ?")) {
        batches = batches.filter((batch) => batch.contingency_period_id === this.args[0]);
      }
      batches.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
      return { results: batches as T[] };
    }
    if (this.sql.includes("FROM contingency_batch_lines")) {
      let lines = [...this.db.contingencyBatchLines];
      if (this.sql.includes("WHERE batch_id = ?")) {
        lines = lines.filter((line) => line.batch_id === this.args[0]);
      }
      if (this.sql.includes("WHERE contingency_period_id = ?")) {
        lines = lines.filter((line) => line.contingency_period_id === this.args[0]);
      }
      lines.sort((left, right) => Number(left.line_no ?? 0) - Number(right.line_no ?? 0));
      return { results: lines as T[] };
    }
    if (this.sql.includes("FROM dte_documents") && this.sql.includes("ORDER BY issued_at ASC, id ASC")) {
      // Annual donor certificate aggregation (Task 4): keyset-paged ACCEPTED-in-year read.
      let documents = this.db.documents.filter((document) => document.status === "ACCEPTED");
      const [startIso, endIso] = [String(this.args[0]), String(this.args[1])];
      documents = documents.filter((document) => document.issued_at >= startIso && document.issued_at < endIso);
      if (this.sql.includes("(issued_at, id) > (?, ?)")) {
        const [afterIssued, afterId] = [String(this.args[2]), String(this.args[3])];
        documents = documents.filter(
          (document) => document.issued_at > afterIssued || (document.issued_at === afterIssued && document.id > afterId)
        );
      }
      documents.sort((left, right) => left.issued_at.localeCompare(right.issued_at) || left.id.localeCompare(right.id));
      const limit = Number(this.args.at(-1) ?? 500);
      return { results: documents.slice(0, limit) as T[] };
    }
    if (this.sql.includes("FROM dte_documents")) {
      let documents = [...this.db.documents];
      if (this.sql.includes("ORDER BY dte_documents.created_at DESC, dte_documents.id DESC")) {
        let argIndex = 0;
        if (this.sql.includes("status = ?")) {
          const status = String(this.args[argIndex]);
          argIndex += 1;
          documents = documents.filter((document) => document.status === status);
        }
        if (this.sql.includes("dte_document_search MATCH ?")) {
          const ftsQuery = String(this.args[argIndex] ?? "");
          argIndex += 1;
          documents = documents.filter((document) => documentMatchesFtsQuery(document, ftsQuery));
        }
        if (this.sql.includes("created_at < ?")) {
          const createdAt = String(this.args[argIndex]);
          const id = String(this.args[argIndex + 2]);
          documents = documents.filter((document) => document.created_at < createdAt || (document.created_at === createdAt && document.id < id));
        }
        const limit = Number(this.args.at(-1) ?? 100);
        documents.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)) || String(right.id).localeCompare(String(left.id)));
        return { results: documents.slice(0, limit) as T[] };
      }
      if (this.sql.includes("status = ?")) {
        const status = String(this.args[0]);
        documents = documents.filter((document) => document.status === status);
      }
      if (this.sql.includes("contingency_period_id = ?")) {
        const periodId = String(this.args[0]);
        documents = documents.filter((document) => document.contingency_period_id === periodId && document.status === "CONTINGENCY_PENDING");
      }
      if (this.sql.includes("status = 'CONTINGENCY_PENDING'")) {
        documents = documents.filter((document) => document.status === "CONTINGENCY_PENDING");
      }
      if (this.sql.includes("status = 'ACCEPTED'")) {
        documents = documents.filter((document) => document.status === "ACCEPTED");
      }
      if (this.sql.includes("sello_recibido IS NOT NULL")) {
        documents = documents.filter((document) => document.sello_recibido !== null);
      }
      if (this.sql.includes("issued_at >= ?") && this.sql.includes("issued_at < ?")) {
        const start = String(this.args[1]);
        const end = String(this.args[2]);
        documents = documents.filter((document) => document.issued_at >= start && document.issued_at < end);
      }
      documents.sort((left, right) => left.issued_at.localeCompare(right.issued_at));
      return { results: documents as T[] };
    }
    if (this.sql.includes("FROM contingency_periods")) {
      const limit = Number(this.args[0] ?? 100);
      const periods = [...this.db.contingencies]
        .sort((left, right) => String(right.started_at).localeCompare(String(left.started_at)))
        .slice(0, limit);
      return { results: periods as T[] };
    }
    if (this.sql.includes("FROM dte_events")) {
      const eventType = String(this.args[0]);
      const limit = Number(this.args[1] ?? 100);
      const events = this.db.dteEvents
        .filter((event) => event.event_type === eventType)
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
        .slice(0, limit);
      return { results: events as T[] };
    }
    if (this.sql.includes("FROM audit_logs")) {
      let audits = [...this.db.audits];
      if (this.sql.includes("WHERE entity_type = ? AND entity_id = ?")) {
        audits = audits.filter((audit) => audit.entity_type === this.args[0] && audit.entity_id === this.args[1]);
      }
      audits.sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
      return { results: audits as T[] };
    }
    return { results: [] };
  }

  async run(): Promise<Record<string, never>> {
    if (this.sql.includes("INSERT INTO users")) {
      const [id, email, name, role, passwordHash, passwordSalt] = this.args.map(String);
      this.db.users.push({
        id,
        email,
        name,
        role,
        password_hash: passwordHash,
        password_salt: passwordSalt,
        disabled_at: ""
      });
    }
    if (this.sql.includes("INSERT INTO password_reset_tokens")) {
      const [id, userId, tokenHash, expiresAt] = this.args.map(String);
      this.db.resetTokens.push({ id, user_id: userId, token_hash: tokenHash, expires_at: expiresAt, used_at: null });
    }
    if (this.sql.includes("UPDATE password_reset_tokens SET used_at")) {
      const [usedAt, id] = this.args.map(String);
      const token = this.db.resetTokens.find((row) => row.id === id);
      if (token) token.used_at = usedAt;
    }
    if (this.sql.includes("INSERT INTO audit_logs")) {
      const [id, actorType, actorId, action, entityType, entityId, summary, metadataJson] = this.args;
      this.db.audits.push({
        id,
        actor_type: actorType,
        actor_id: actorId,
        action,
        entity_type: entityType,
        entity_id: entityId,
        summary,
        metadata_json: metadataJson,
        created_at: "2026-06-26T01:46:47.015Z"
      });
    }
    if (this.sql.includes("INSERT INTO app_settings")) {
      const [key, value, updatedBy, updatedAt] = this.args;
      const setting = this.db.settings.find((row) => row.key === key);
      if (setting) {
        setting.value = value;
        setting.updated_by = updatedBy;
        setting.updated_at = updatedAt;
      } else {
        this.db.settings.push({ key, value, updated_by: updatedBy, updated_at: updatedAt });
      }
    }
    if (this.sql.includes("INSERT INTO email_deliveries")) {
      const [
        id,
        documentId,
        toEmail,
        status,
        providerResponseJson,
        sentAt,
        emailType,
        documentStatusAtSend,
        templateVersion,
        pdfRendererVersion,
        pdfSha256,
        dteJsonSha256,
        providerDeliveryId
      ] = this.args;
      this.db.emailDeliveries.push({
        id,
        document_id: documentId,
        to_email: toEmail,
        status,
        provider_response_json: providerResponseJson,
        sent_at: sentAt,
        email_type: emailType,
        document_status_at_send: documentStatusAtSend,
        template_version: templateVersion,
        pdf_renderer_version: pdfRendererVersion,
        pdf_sha256: pdfSha256,
        dte_json_sha256: dteJsonSha256,
        provider_delivery_id: providerDeliveryId
      });
    }
    if (this.sql.includes("INSERT INTO wompi_events")) {
      const [id, transactionId, environment, result, amountCents, donorEmail, donorName, rawBody, headersJson] = this.args;
      this.db.wompiEvents.push({
        id,
        transaction_id: transactionId,
        environment,
        result,
        amount_cents: amountCents,
        donor_email: donorEmail,
        donor_name: donorName,
        raw_body: rawBody,
        headers_json: headersJson,
        received_at: "2026-06-26T01:46:47.015Z",
        processed_at: null,
        created_document_id: null
      });
    }
    if (this.sql.includes("INSERT INTO dte_documents")) {
      const [id, wompiEventId, environment, codigoGeneracion, numeroControl, status, plainJson, donorEmail, donorName, amountCents, issuedAt, contingencyPeriodId] = this.args;
      this.db.documents.push({
        id: String(id),
        wompi_event_id: wompiEventId == null ? null : String(wompiEventId),
        tipo_dte: "15",
        environment: environment === "01" ? "01" : "00",
        codigo_generacion: String(codigoGeneracion),
        numero_control: String(numeroControl),
        status: String(status),
        plain_json: String(plainJson),
        signed_jws: null,
        sello_recibido: null,
        mh_estado: null,
        mh_observaciones_json: "[]",
        donor_email: donorEmail === null ? null : String(donorEmail),
        donor_name: donorName === null ? null : String(donorName),
        amount_cents: Number(amountCents),
        issued_at: String(issuedAt),
        accepted_at: null,
        contingency_period_id: contingencyPeriodId === null ? null : String(contingencyPeriodId),
        created_at: String(issuedAt),
        updated_at: String(issuedAt)
      });
    }
    if (this.sql.includes("INSERT INTO dte_events")) {
      const [id, documentId, eventType, environment, codigoGeneracion, status, plainJson, signedJws, legalDeadlineAt, createdBy] = this.args;
      this.db.dteEvents.push({
        id,
        document_id: documentId,
        event_type: eventType,
        environment,
        codigo_generacion: codigoGeneracion,
        status,
        plain_json: plainJson,
        signed_jws: signedJws,
        sello_recibido: null,
        mh_estado: null,
        mh_observaciones_json: "[]",
        legal_deadline_at: legalDeadlineAt,
        created_by: createdBy,
        created_at: "2026-06-26T01:46:47.015Z",
        accepted_at: null
      });
    }
    if (this.sql.includes("INSERT INTO contingency_periods")) {
      const [id, environment, reason, tipoContingencia, startedAt] = this.args;
      this.db.contingencies.push({
        id,
        environment,
        status: "OPEN",
        reason,
        tipo_contingencia: Number(tipoContingencia),
        started_at: startedAt,
        ended_at: null,
        event_id: null,
        event_sello: null,
        transmit_deadline_at: null,
        created_at: startedAt
      });
    }
    if (this.sql.includes("INSERT INTO contingency_batches")) {
      const [id, periodId, environment, idEnvio, lineCount, pendingCount] = this.args;
      this.db.contingencyBatches.push({
        id,
        contingency_period_id: periodId,
        environment,
        id_envio: idEnvio,
        status: "DRAFT",
        codigo_lote: null,
        request_json: "{}",
        response_json: "{}",
        last_error: null,
        line_count: Number(lineCount),
        accepted_count: 0,
        rejected_count: 0,
        pending_count: Number(pendingCount),
        created_at: "2026-06-26T01:46:47.015Z",
        submitted_at: null,
        last_polled_at: null,
        updated_at: "2026-06-26T01:46:47.015Z"
      });
    }
    if (this.sql.includes("INSERT INTO contingency_batch_lines")) {
      const [id, batchId, periodId, documentId, lineNo, codigoGeneracion, tipoDte, signedJws] = this.args;
      this.db.contingencyBatchLines.push({
        id,
        batch_id: batchId,
        contingency_period_id: periodId,
        document_id: documentId,
        line_no: Number(lineNo),
        status: "LOCAL_ISSUED",
        codigo_generacion: codigoGeneracion,
        tipo_dte: tipoDte,
        signed_jws: signedJws,
        sello_recibido: null,
        mh_estado: null,
        mh_observaciones_json: "[]",
        last_error: null,
        created_at: "2026-06-26T01:46:47.015Z",
        updated_at: "2026-06-26T01:46:47.015Z"
      });
    }
    if (this.sql.includes("UPDATE wompi_events SET created_document_id")) {
      const [documentId, processedAt, wompiEventId] = this.args;
      const event = this.db.wompiEvents.find((row) => row.id === wompiEventId);
      if (event) {
        event.created_document_id = documentId;
        event.processed_at = processedAt;
      }
    }
    if (this.sql.includes("UPDATE dte_documents SET donor_email")) {
      const [email, updatedAt, documentId] = this.args;
      const document = this.db.documents.find((row) => row.id === documentId);
      if (document) {
        document.donor_email = String(email);
        document.updated_at = String(updatedAt);
      }
    }
    if (this.sql.includes("UPDATE users SET name = ?, role = ?, disabled_at = ?, updated_at = ? WHERE id = ?")) {
      const [name, role, disabledAt, updatedAt, userId] = this.args;
      const user = this.db.users.find((row) => row.id === userId);
      if (user) {
        user.name = name;
        user.role = role;
        user.disabled_at = disabledAt;
        user.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE users SET name = ?, email = ?, role = ?, disabled_at = ?, updated_at = ? WHERE id = ?")) {
      const [name, email, role, disabledAt, updatedAt, userId] = this.args;
      const user = this.db.users.find((row) => row.id === userId);
      if (user) {
        user.name = name;
        user.email = email;
        user.role = role;
        user.disabled_at = disabledAt;
        user.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?")) {
      const [passwordHash, passwordSalt, updatedAt, userId] = this.args;
      const user = this.db.users.find((row) => row.id === userId);
      if (user) {
        user.password_hash = passwordHash;
        user.password_salt = passwordSalt;
        user.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE sessions SET revoked_at = ? WHERE user_id = ?")) {
      const [revokedAt, userId] = this.args;
      for (const session of this.db.sessions.filter((row) => row.user_id === userId && !row.revoked_at)) {
        session.revoked_at = revokedAt;
      }
    }
    if (this.sql.includes("UPDATE dte_events")) {
      const [status, sello, mhEstado, observacionesJson, acceptedAt, eventId] = this.args;
      const event = this.db.dteEvents.find((row) => row.id === eventId);
      if (event) {
        event.status = status;
        event.sello_recibido = sello;
        event.mh_estado = mhEstado;
        event.mh_observaciones_json = observacionesJson;
        event.accepted_at = acceptedAt;
      }
    }
    if (this.sql.includes("UPDATE dte_documents") && this.sql.includes("SET status = ?")) {
      const [status, sello, mhEstado, observacionesJson, acceptedAt, updatedAt, documentId] = this.args;
      const document = this.db.documents.find((row) => row.id === documentId);
      if (document) {
        document.status = String(status);
        document.sello_recibido = sello === null ? null : String(sello);
        document.mh_estado = String(mhEstado);
        document.mh_observaciones_json = String(observacionesJson);
        document.accepted_at = acceptedAt === null ? document.accepted_at : String(acceptedAt);
        document.updated_at = String(updatedAt);
      }
    }
    if (this.sql.includes("UPDATE contingency_batches") && this.sql.includes("SET status = 'SUBMITTED'")) {
      const [codigoLote, requestJson, responseJson, submittedAt, updatedAt, batchId] = this.args;
      const batch = this.db.contingencyBatches.find((row) => row.id === batchId);
      if (batch) {
        batch.status = "SUBMITTED";
        batch.codigo_lote = codigoLote;
        batch.request_json = requestJson;
        batch.response_json = responseJson;
        batch.last_error = null;
        batch.submitted_at = batch.submitted_at ?? submittedAt;
        batch.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE contingency_batch_lines SET status = 'BATCH_SENT'")) {
      const [updatedAt, batchId] = this.args;
      for (const line of this.db.contingencyBatchLines.filter((row) => row.batch_id === batchId && row.status === "LOCAL_ISSUED")) {
        line.status = "BATCH_SENT";
        line.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE contingency_batches") && this.sql.includes("SET status = 'PROCESSING'")) {
      const [responseJson, polledAt, updatedAt, batchId] = this.args;
      const batch = this.db.contingencyBatches.find((row) => row.id === batchId);
      if (batch) {
        batch.status = "PROCESSING";
        batch.response_json = responseJson;
        batch.last_polled_at = polledAt;
        batch.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE contingency_batches") && this.sql.includes("SET status = 'FAILED'")) {
      const [responseJson, message, updatedAt, batchId] = this.args;
      const batch = this.db.contingencyBatches.find((row) => row.id === batchId);
      if (batch) {
        batch.status = "FAILED";
        batch.response_json = responseJson;
        batch.last_error = message;
        batch.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE contingency_batch_lines") && this.sql.includes("SET status = 'ACCEPTED'")) {
      const [sello, mhEstado, observacionesJson, updatedAt, lineId] = this.args;
      const line = this.db.contingencyBatchLines.find((row) => row.id === lineId);
      if (line) {
        line.status = "ACCEPTED";
        line.sello_recibido = sello;
        line.mh_estado = mhEstado;
        line.mh_observaciones_json = observacionesJson;
        line.last_error = null;
        line.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE contingency_batch_lines") && this.sql.includes("SET status = 'REJECTED'")) {
      const [mhEstado, observacionesJson, message, updatedAt, lineId] = this.args;
      const line = this.db.contingencyBatchLines.find((row) => row.id === lineId);
      if (line) {
        line.status = "REJECTED";
        line.mh_estado = mhEstado;
        line.mh_observaciones_json = observacionesJson;
        line.last_error = message;
        line.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE contingency_batches") && this.sql.includes("SET status = ?, line_count = ?")) {
      const [status, lineCount, acceptedCount, rejectedCount, pendingCount, updatedAt, batchId] = this.args;
      const batch = this.db.contingencyBatches.find((row) => row.id === batchId);
      if (batch) {
        batch.status = status;
        batch.line_count = lineCount;
        batch.accepted_count = acceptedCount;
        batch.rejected_count = rejectedCount;
        batch.pending_count = pendingCount;
        batch.updated_at = updatedAt;
      }
    }
    if (this.sql.includes("UPDATE contingency_periods") && this.sql.includes("SET status = 'EVENT_ACCEPTED'")) {
      const [eventId, sello, deadlineAt, periodId] = this.args;
      const period = this.db.contingencies.find((row) => row.id === periodId);
      if (period) {
        period.status = "EVENT_ACCEPTED";
        period.event_id = eventId;
        period.event_sello = sello;
        period.transmit_deadline_at = deadlineAt;
      }
    }
    if (this.sql.includes("UPDATE contingency_periods") && this.sql.includes("SET status = 'CLOSED'")) {
      const [endedAt, periodId] = this.args;
      const period = this.db.contingencies.find((row) => row.id === periodId);
      if (period) {
        period.status = "CLOSED";
        period.ended_at = period.ended_at ?? endedAt;
      }
    }
    if (this.sql.includes("UPDATE dte_documents SET status = 'CONTINGENCY_PENDING'")) {
      const [periodId, updatedAt, documentId] = this.args;
      const document = this.db.documents.find((row) => row.id === documentId);
      if (document) {
        document.status = "CONTINGENCY_PENDING";
        document.contingency_period_id = String(periodId);
        document.updated_at = String(updatedAt);
      }
    }
    if (this.sql.includes("UPDATE dte_documents SET status = 'INVALIDATED'")) {
      const [updatedAt, documentId] = this.args;
      const document = this.db.documents.find((row) => row.id === documentId);
      if (document) {
        document.status = "INVALIDATED";
        document.updated_at = String(updatedAt);
      }
    }
    return {};
  }
}

// Maps a retention-export SELECT's table name to its backing in-memory array,
// so the generic "ORDER BY created_at ASC, id ASC LIMIT ?" branch above can
// serve every table the retention service reads without one bespoke branch per table.
function retentionTableFor(db: InMemoryD1, sql: string): Array<Record<string, unknown>> | null {
  if (sql.includes("FROM dte_documents")) return db.documents as unknown as Array<Record<string, unknown>>;
  if (sql.includes("FROM dte_events")) return db.dteEvents;
  if (sql.includes("FROM email_deliveries")) return db.emailDeliveries;
  if (sql.includes("FROM wompi_events")) return db.wompiEvents;
  if (sql.includes("FROM audit_logs")) return db.audits;
  if (sql.includes("FROM contingency_periods")) return db.contingencies;
  if (sql.includes("FROM contingency_batch_lines")) return db.contingencyBatchLines;
  if (sql.includes("FROM contingency_batches")) return db.contingencyBatches;
  return null;
}

function documentMatchesFtsQuery(document: DteDocumentRecord, query: string): boolean {
  const prefixes = query
    .split(/\s+AND\s+/i)
    .map((part) => part.replace(/\*$/, "").toLowerCase())
    .filter(Boolean);
  if (prefixes.length === 0) {
    return true;
  }
  const controlTail = document.numero_control.split("-").at(-1) ?? "";
  const corpus = [
    document.codigo_generacion,
    document.codigo_generacion.replace(/[^a-z0-9]+/gi, ""),
    document.numero_control,
    document.numero_control.replace(/[^a-z0-9]+/gi, ""),
    controlTail.replace(/^0+/, "") || controlTail,
    document.donor_email,
    document.donor_name
  ];
  const tokens = corpus.flatMap((value) => String(value ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? []);
  return prefixes.every((prefix) => tokens.some((token) => token.startsWith(prefix)));
}

function advancedFailingDocument(id: string): DteDocumentRecord {
  return {
    ...testDocument(),
    id,
    wompi_event_id: null,
    status: "PENDING",
    signed_jws: null,
    plain_json: JSON.stringify({
      emisor: { nombre: "ExamplePerson1" },
      receptor: { nombre: "Example Person", correo: "legacy-contact-2@example.com", telefono: "70000001", tipoDocumento: "13", numDocumento: "100000001" },
      resumen: { valorTotal: 100 },
      identificacion: {
        fecEmi: "2026-06-26",
        horEmi: "19:50:00",
        ambiente: "00",
        codigoGeneracion: "11111111-1111-4111-8111-111111111111",
        numeroControl: "DTE-15-M001P004-000000000000999"
      }
    })
  };
}

function testDocument(overrides: Partial<DteDocumentRecord> = {}): DteDocumentRecord {
  return {
    id: "doc_1",
    wompi_event_id: "wompi_1",
    tipo_dte: "15",
    environment: "00",
    codigo_generacion: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4",
    numero_control: "DTE-15-M001P004-000000000000009",
    status: "ACCEPTED",
    plain_json: JSON.stringify({
      emisor: { nombre: "ExamplePerson1" },
      receptor: { nombre: "Example Person", correo: "legacy-contact-2@example.com", telefono: "70000001", tipoDocumento: "13", numDocumento: "100000001" },
      resumen: { valorTotal: 100 },
      identificacion: { fecEmi: "2026-06-26", horEmi: "19:50:00" }
    }),
    signed_jws: null,
    sello_recibido: "20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGQE",
    mh_estado: "PROCESADO",
    mh_observaciones_json: "[]",
    donor_email: "legacy-contact-2@example.com",
    donor_name: "Example Person",
    amount_cents: 10000,
    issued_at: "2026-06-26T01:46:47.015Z",
    accepted_at: "2026-06-26T01:46:48.000Z",
    contingency_period_id: null,
    created_at: "2026-06-26T01:46:47.015Z",
    updated_at: "2026-06-26T01:46:48.000Z",
    ...overrides
  };
}

function advancedCdeDraft(): Record<string, unknown> {
  return {
    identificacion: {
      version: 2,
      ambiente: "00",
      tipoDte: "15",
      numeroControl: "DTE-15-M001P004-000000000000999",
      codigoGeneracion: "11111111-1111-4111-8111-111111111111",
      tipoModelo: 1,
      tipoOperacion: 1,
      fecEmi: "2026-06-26",
      horEmi: "09:00:00",
      tipoMoneda: "USD"
    },
    emisor: {
      tipoDocumento: "36",
      numDocumento: "10000003520015",
      nrc: "2400001",
      nombre: "MISION EXAMPLEORGANIZATION",
      codActividad: "94910",
      descActividad: "ACTIVIDADES DE ORGANIZACIONES RELIGIOSAS",
      nombreComercial: "MISION EXAMPLEORGANIZATION",
      direccion: {
        departamento: "06",
        municipio: "22",
        distrito: "01",
        complemento: "AVENIDA EJEMPLO 100, COLONIA EJEMPLO, SAN SALVADOR."
      },
      telefono: "70000002",
      correo: "legacy-contact-4@example.com",
      codEstable: "0002",
      codPuntoVenta: "0002"
    },
    receptor: {
      tipoDocumento: "13",
      numDocumento: "100000001",
      nrc: null,
      nombre: "Example Person Advanced",
      codActividad: null,
      descActividad: null,
      direccion: {
        departamento: "06",
        municipio: "22",
        distrito: "01",
        complemento: "SAN SALVADOR"
      },
      telefono: "70000001",
      correo: "advanced@example.org",
      codDomiciliado: 1,
      codPais: "SV"
    },
    otrosDocumentos: [
      {
        codDocAsociado: 1,
        descDocumento: "Referencia avanzada",
        detalleDocumento: "ADVANCED-TEST"
      }
    ],
    cuerpoDocumento: [
      {
        numItem: 1,
        tipoDonacion: 1,
        cantidad: 1,
        codigo: "DIEZMO",
        uniMedida: 99,
        descripcion: "Diezmo avanzado",
        tipoDepreciacion: 0,
        valorUni: 123.45,
        valor: 123.45
      }
    ],
    resumen: {
      valorTotal: 123.45,
      totalLetras: null,
      pagos: [
        {
          codigo: "01",
          montoPago: 123.45,
          referencia: "ADVANCED"
        }
      ]
    },
    apendice: [
      { campo: "Origen", etiqueta: "Origen", valor: "DTE avanzado" }
    ]
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) }
  });
}

async function signWompiBody(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", utf8Bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Bytes(body)));
  return hexFromBytes(digest);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hexFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function generatedCertificateXml(password: string): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-512"
    },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
  const passwordHash = hexFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-512", utf8Bytes(password))));
  return `<CertificadoMH><nit>12345678901234</nit><publicKey><encodied>${bytesToBase64(spki)}</encodied></publicKey><privateKey><encodied>${bytesToBase64(pkcs8)}</encodied><clave>${passwordHash}</clave></privateKey><activo>true</activo></CertificadoMH>`;
}

function emisorConfig() {
  return {
    tipoDocumento: "36",
    numDocumento: "10000003520015",
    nrc: "2400001",
    nombre: "MISION EXAMPLEORGANIZATION",
    codActividad: "94910",
    descActividad: "ACTIVIDADES DE ORGANIZACIONES RELIGIOSAS",
    nombreComercial: "MISION EXAMPLEORGANIZATION",
    direccion: {
      departamento: "06",
      municipio: "22",
      distrito: "01",
      complemento: "AVENIDA EJEMPLO 100, COLONIA EJEMPLO, SAN SALVADOR."
    },
    telefono: "70000002",
    correo: "legacy-contact-4@example.com",
    codEstable: "0002",
    codEstableMH: "M001",
    codPuntoVenta: "0002",
    codPuntoVentaMH: "P004",
    controlPrefix: "M001P004",
    defaultReceptorTipoDocumento: "13",
    defaultCodPais: "SV",
    defaultDonationType: 1,
    defaultUnidadMedida: 99,
    paymentMethodCode: "01",
    responsable: {
      nombre: "Example Person",
      tipoDocumento: "13",
      numeroDocumento: "100000001",
      tipoEstablecimiento: "02"
    }
  };
}
