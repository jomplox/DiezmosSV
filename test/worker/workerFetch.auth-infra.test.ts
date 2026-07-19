import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { AuthService, hashPassword } from "../../src/worker/services/auth";
import { Repository } from "../../src/worker/storage/repository";
import { hexFromBytes, utf8Bytes } from "../../src/worker/utils/encoding";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { sqliteD1 } from "./support/sqliteD1";
import { makeDocument as testDocument } from "./fixtures";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";
import {
  executionContextCapturing,
  fetchAndWaitUntil
} from "./support/workerFetchRequests";

installWorkerFetchGlobals();

describe("request body limits", () => {
  it("rejects an oversized login body before authentication or throttling", async () => {
    const db = new InMemoryD1();
    const body = JSON.stringify({ email: `${"a".repeat(16 * 1024)}@example.org`, password: "Password#2026" });
    const response = await worker.fetch(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(body.length) },
        body
      }),
      env(db)
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "request_body_too_large" });
    expect(db.audits).toHaveLength(0);
  });

  it("rejects an oversized Wompi body before HMAC verification", async () => {
    const db = new InMemoryD1();
    const body = JSON.stringify({ padding: "x".repeat(64 * 1024) });
    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": String(body.length) },
        body
      }),
      env(db, { WOMPI_API_SECRET: "test-secret" })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "request_body_too_large" });
    expect(db.wompiEvents).toHaveLength(0);
  });

  it("maps malformed JSON on strict public routes to invalid_json_body", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{"
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_json_body" });
    expect(db.audits).toHaveLength(0);
  });

  it("preserves tolerant malformed-JSON behavior on donation intent creation", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      new Request("https://example.org/api/donations/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{"
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_amount" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("rejects an oversized authenticated admin body before changing credentials", async () => {
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
    const body = JSON.stringify({ password: "x".repeat(257 * 1024) });

    const response = await worker.fetch(
      new Request("https://example.org/api/users/user_operator/password", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          "Content-Length": String(body.length)
        },
        body
      }),
      env(db)
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "request_body_too_large" });
    expect(db.users[0]).toMatchObject({ password_hash: "old-hash", password_salt: "old-salt" });
    expect(db.audits).toHaveLength(0);
  });
});

describe("document route authorization order", () => {
  it("returns 401 without looking up either an existing or missing document", async () => {
    const db = new InMemoryD1();
    db.documents.push(testDocument({ id: "doc_existing" }));

    const existing = await worker.fetch(new Request("https://example.org/api/documents/doc_existing"), env(db));
    const missing = await worker.fetch(new Request("https://example.org/api/documents/doc_missing"), env(db));

    expect(existing.status).toBe(401);
    expect(missing.status).toBe(401);
    expect(db.documentLookupCount).toBe(0);
  });

  it("returns 403 to a VIEWER mutation without looking up either document", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(testDocument({ id: "doc_existing" }));
    const init = { method: "POST", headers: { Authorization: "Bearer test-token" } };

    const existing = await worker.fetch(new Request("https://example.org/api/documents/doc_existing/resend", init), env(db));
    const missing = await worker.fetch(new Request("https://example.org/api/documents/doc_missing/resend", init), env(db));

    expect(existing.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(db.documentLookupCount).toBe(0);
  });
});

const VALID_BOOTSTRAP_TOKEN = `bt_${"A".repeat(43)}`;
const OTHER_BOOTSTRAP_TOKEN = `bt_${"B".repeat(43)}`;

describe("owner bootstrap", () => {
  it("reports bootstrap availability before the first user exists", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      new Request("https://example.org/api/auth/bootstrap-status"),
      env(db, { BOOTSTRAP_OWNER_TOKEN: VALID_BOOTSTRAP_TOKEN })
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
      env(db, { BOOTSTRAP_OWNER_TOKEN: VALID_BOOTSTRAP_TOKEN })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "bootstrap_token_required" });
    expect(db.users).toHaveLength(0);
  });

  it("rejects first-owner bootstrap when the setup token is wrong", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      bootstrapRequest({ token: "wrong-token" }),
      env(db, { BOOTSTRAP_OWNER_TOKEN: VALID_BOOTSTRAP_TOKEN })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "bootstrap_token_required" });
    expect(db.users).toHaveLength(0);
  });

  it("fails closed when the configured setup token is not a generated token", async () => {
    const db = new InMemoryD1();
    const status = await worker.fetch(
      new Request("https://example.org/api/auth/bootstrap-status"),
      env(db, { BOOTSTRAP_OWNER_TOKEN: "setup-token" })
    );
    const creation = await worker.fetch(
      bootstrapRequest({ token: "setup-token" }),
      env(db, { BOOTSTRAP_OWNER_TOKEN: "setup-token" })
    );

    await expect(status.json()).resolves.toEqual({ bootstrapAvailable: false });
    expect(creation.status).toBe(503);
    await expect(creation.json()).resolves.toMatchObject({ error: "bootstrap_configuration_invalid" });
    expect(db.users).toHaveLength(0);
  });

  it("limits every bootstrap-token guess from one source before parsing the owner body", async () => {
    const db = new InMemoryD1();
    const runtime = env(db, { BOOTSTRAP_OWNER_TOKEN: VALID_BOOTSTRAP_TOKEN });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await worker.fetch(
        new Request("https://example.org/api/auth/bootstrap-owner", {
          method: "POST",
          headers: {
            "CF-Connecting-IP": "203.0.113.88",
            "X-Bootstrap-Owner-Token": `invalid-${attempt}`
          },
          body: "not-json"
        }),
        runtime
      );
      expect(response.status).toBe(403);
    }

    const denied = await worker.fetch(
      bootstrapRequest({ token: OTHER_BOOTSTRAP_TOKEN }, "203.0.113.88"),
      runtime
    );

    expect(denied.status).toBe(429);
    await expect(denied.json()).resolves.toMatchObject({ error: "too_many_attempts" });
    expect(db.users).toHaveLength(0);
    expect([...db.loginRateLimits.keys()]).toHaveLength(1);
    expect([...db.loginRateLimits.keys()][0]).not.toContain("203.0.113.88");
  });

  it("creates the first owner when the setup token matches", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      bootstrapRequest({ token: VALID_BOOTSTRAP_TOKEN }),
      env(db, { BOOTSTRAP_OWNER_TOKEN: VALID_BOOTSTRAP_TOKEN })
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

  it("returns a closed-bootstrap conflict after the first owner is created", async () => {
    const db = new InMemoryD1();
    const runtime = env(db, { BOOTSTRAP_OWNER_TOKEN: VALID_BOOTSTRAP_TOKEN });

    const first = await worker.fetch(bootstrapRequest({ token: VALID_BOOTSTRAP_TOKEN }), runtime);
    const second = await worker.fetch(bootstrapRequest({ token: VALID_BOOTSTRAP_TOKEN }), runtime);

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({ error: "bootstrap_unavailable" });
    expect(db.users).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "OWNER_BOOTSTRAPPED")).toHaveLength(1);
  });

  it("uses one conditional insert to admit only one initial owner", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(`CREATE TABLE users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        disabled_at TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`);
      const repo = new Repository(sqliteD1(sqlite));
      const results = await Promise.all([
        repo.createInitialOwner({
          email: "owner-one@example.org",
          name: "Owner One",
          passwordHash: "hash-one",
          passwordSalt: "salt-one"
        }),
        repo.createInitialOwner({
          email: "owner-two@example.org",
          name: "Owner Two",
          passwordHash: "hash-two",
          passwordSalt: "salt-two"
        })
      ]);

      expect(results.filter(Boolean)).toHaveLength(1);
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
      expect(sqlite.prepare("SELECT role FROM users").get()).toEqual({ role: "OWNER" });
    } finally {
      sqlite.close();
    }
  });
});

describe("auth rate limiting", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function seedAudit(db: InMemoryD1, action: string, entityId: string, createdAt: string, actorIp: string | null = null): void {
    db.audits.push({
      id: `audit_${action}_${db.audits.length}`,
      actor_type: "SYSTEM",
      actor_id: null,
      action,
      entity_type: "user",
      entity_id: entityId,
      summary: "seeded",
      metadata_json: "{}",
      actor_ip: actorIp,
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

  describe("aggregate login attempts", () => {
    it("blocks the sixty-first login attempt from one IP across distinct account names", async () => {
      const db = new InMemoryD1();
      for (let index = 0; index < 60; index += 1) {
        const response = await worker.fetch(
          new Request("https://example.org/api/auth/login", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "CF-Connecting-IP": "203.0.113.70"
            },
            body: JSON.stringify({ email: `user-${index}@example.org`, password: "invalid" })
          }),
          env(db)
        );
        expect(response.status).toBe(401);
      }

      const auditsBeforeDenial = db.audits.length;
      const readsBeforeDenial = db.loginCredentialReads;
      const denied = await worker.fetch(
        new Request("https://example.org/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "203.0.113.70"
          },
          body: JSON.stringify({ email: "sixty-first@example.org", password: "invalid" })
        }),
        env(db)
      );

      expect(denied.status).toBe(429);
      await expect(denied.json()).resolves.toMatchObject({ error: "too_many_attempts" });
      expect(db.loginCredentialReads).toBe(readsBeforeDenial);
      expect(db.audits).toHaveLength(auditsBeforeDenial);
      expect([...db.loginRateLimits.keys()]).toHaveLength(1);
      expect([...db.loginRateLimits.keys()][0]).toMatch(/^[a-f0-9]{64}$/);
      expect([...db.loginRateLimits.keys()][0]).not.toContain("203.0.113.70");
    });

    it("resets an expired aggregate login bucket before normal credential handling", async () => {
      const db = new InMemoryD1();
      const callerIp = "198.51.100.9";
      const keyHash = await sha256Hex(utf8Bytes(callerIp));
      db.loginRateLimits.set(keyHash, {
        window_started_at: "2026-07-04T11:00:00.000Z",
        attempt_count: 60,
        expires_at: "2026-07-04T11:15:00.000Z"
      });

      const response = await worker.fetch(
        new Request("https://example.org/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": callerIp
          },
          body: JSON.stringify({ email: "other@example.org", password: "invalid" })
        }),
        env(db)
      );

      expect(response.status).toBe(401);
      expect(db.loginCredentialReads).toBe(1);
      expect(db.loginRateLimits.get(keyHash)).toEqual({
        window_started_at: "2026-07-04T12:00:00.000Z",
        attempt_count: 1,
        expires_at: "2026-07-04T12:15:00.000Z"
      });
    });

    it("resets an expired aggregate login bucket with SQLite UPSERT semantics", async () => {
      const sqlite = new DatabaseSync(":memory:");
      try {
        sqlite.exec(`CREATE TABLE login_rate_limits (
          key_hash TEXT PRIMARY KEY,
          window_started_at TEXT NOT NULL,
          attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
          expires_at TEXT NOT NULL
        )`);
        const callerIp = "198.51.100.9";
        const keyHash = await sha256Hex(utf8Bytes(callerIp));
        sqlite
          .prepare(
            `INSERT INTO login_rate_limits (
               key_hash, window_started_at, attempt_count, expires_at
             ) VALUES (?, ?, ?, ?)`
          )
          .run(keyHash, "2026-07-04T11:00:00.000Z", 60, "2026-07-04T11:15:00.000Z");

        const repo = new Repository(sqliteD1(sqlite));
        const accepted = await repo.claimLoginAttempt(
          keyHash,
          "2026-07-04T12:00:00.000Z",
          "2026-07-04T11:45:00.000Z",
          "2026-07-04T12:15:00.000Z",
          60
        );

        expect(accepted).toBe(true);
        expect(
          sqlite
            .prepare(
              `SELECT window_started_at, attempt_count, expires_at
               FROM login_rate_limits
               WHERE key_hash = ?`
            )
            .get(keyHash)
        ).toEqual({
          window_started_at: "2026-07-04T12:00:00.000Z",
          attempt_count: 1,
          expires_at: "2026-07-04T12:15:00.000Z"
        });
      } finally {
        sqlite.close();
      }
    });

    it("combines legacy activity and atomic claims with the production SQLite statement", async () => {
      const sqlite = new DatabaseSync(":memory:");
      try {
        sqlite.exec(`CREATE TABLE security_rate_limit_claims (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('donation_intent', 'password_reset')),
          key_hash TEXT NOT NULL,
          claimed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE donation_intents (
          id TEXT PRIMARY KEY,
          client_ip TEXT NOT NULL,
          rate_limit_claim_id TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO donation_intents (id, client_ip, created_at) VALUES
          ('legacy_1', '203.0.113.7', '2026-07-04T11:50:00.000Z'),
          ('legacy_2', '203.0.113.7', '2026-07-04T11:51:00.000Z');`);
        const repo = new Repository(sqliteD1(sqlite));
        const accepted = await Promise.all(
          Array.from({ length: 20 }, () =>
            repo.claimDonationIntentRateLimit(
              "hashed-client-ip",
              "203.0.113.7",
              "2026-07-04T12:00:00.000Z",
              "2026-07-04T11:45:00.000Z",
              "2026-07-04T12:15:00.000Z",
              5
            )
          )
        );

        expect(accepted.filter(Boolean)).toHaveLength(3);
        expect(
          sqlite
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM security_rate_limit_claims
                WHERE scope = ? AND key_hash = ?`
            )
            .get("donation_intent", "hashed-client-ip")
        ).toEqual({ count: 3 });
      } finally {
        sqlite.close();
      }
    });

    it("counts a late legacy donation row after the first ledger claim", async () => {
      const sqlite = new DatabaseSync(":memory:");
      try {
        sqlite.exec(`CREATE TABLE security_rate_limit_claims (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('donation_intent', 'password_reset')),
          key_hash TEXT NOT NULL,
          claimed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE donation_intents (
          id TEXT PRIMARY KEY,
          client_ip TEXT NOT NULL,
          rate_limit_claim_id TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO security_rate_limit_claims (id, scope, key_hash, claimed_at, expires_at)
          VALUES ('first_new_claim', 'donation_intent', 'hashed-client-ip', '2026-07-04T12:00:00.000Z', '2026-07-04T12:15:00.000Z');
        INSERT INTO donation_intents (id, client_ip, rate_limit_claim_id, created_at)
          VALUES ('late_legacy_intent', '203.0.113.7', NULL, '2026-07-04T12:01:00.000Z');`);
        const repo = new Repository(sqliteD1(sqlite));

        const admitted = await Promise.all(
          Array.from({ length: 20 }, () =>
            repo.claimDonationIntentRateLimit(
              "hashed-client-ip",
              "203.0.113.7",
              "2026-07-04T12:02:00.000Z",
              "2026-07-04T11:47:00.000Z",
              "2026-07-04T12:17:00.000Z",
              5
            )
          )
        );

        expect(admitted.filter(Boolean)).toHaveLength(3);
      } finally {
        sqlite.close();
      }
    });

    it("atomically composes reset pair and account budgets across the legacy cutover", async () => {
      const sqlite = new DatabaseSync(":memory:");
      try {
        sqlite.exec(`CREATE TABLE security_rate_limit_claims (
          id TEXT PRIMARY KEY,
          scope TEXT NOT NULL CHECK (scope IN ('donation_intent', 'password_reset')),
          key_hash TEXT NOT NULL,
          subject_key_hash TEXT,
          claimed_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
        CREATE TABLE audit_logs (
          id TEXT PRIMARY KEY,
          action TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          rate_limit_claim_id TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO security_rate_limit_claims (id, scope, key_hash, claimed_at, expires_at)
          VALUES ('first_new_claim', 'password_reset', 'hashed-source-account', '2026-07-04T12:00:00.000Z', '2026-07-04T12:15:00.000Z');
        INSERT INTO audit_logs (id, action, entity_id, rate_limit_claim_id, created_at)
          VALUES ('late_legacy_audit', 'PASSWORD_RESET_REQUESTED', 'user_operator', NULL, '2026-07-04T12:01:00.000Z');`);
        const repo = new Repository(sqliteD1(sqlite));

        const admitted = await Promise.all(
          Array.from({ length: 20 }, () =>
            repo.claimPasswordResetBudgets(
              "hashed-source-account",
              "hashed-account",
              "user_operator",
              "2026-07-04T12:02:00.000Z",
              "2026-07-04T11:47:00.000Z",
              "2026-07-04T12:17:00.000Z",
              3,
              3
            )
          )
        );

        expect(admitted.filter(Boolean)).toHaveLength(2);
        expect(
          sqlite
            .prepare(
              `SELECT COUNT(*) AS count
                 FROM security_rate_limit_claims
                WHERE scope = 'password_reset'
                  AND subject_key_hash = ?`
            )
            .get("hashed-account")
        ).toEqual({ count: 2 });
      } finally {
        sqlite.close();
      }
    });

    it("keeps aggregate login buckets independent and deletes expired buckets during scheduled cleanup", async () => {
      const db = new InMemoryD1();
      db.loginRateLimits.set("expired-hash", {
        window_started_at: "2026-07-04T11:00:00.000Z",
        attempt_count: 60,
        expires_at: "2026-07-04T11:15:00.000Z"
      });
      db.securityRateLimitClaims.push({
        id: "expired-claim",
        scope: "password_reset",
        key_hash: "expired-hash",
        claimed_at: "2026-07-04T11:00:00.000Z",
        expires_at: "2026-07-04T11:15:00.000Z"
      });

      const otherIp = await worker.fetch(
        new Request("https://example.org/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "192.0.2.18"
          },
          body: JSON.stringify({ email: "independent@example.org", password: "invalid" })
        }),
        env(db)
      );

      expect(otherIp.status).toBe(401);
      await worker.scheduled(
        { cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent,
        env(db)
      );
      expect(db.loginRateLimits.has("expired-hash")).toBe(false);
      expect(db.loginRateLimits.size).toBe(1);
      expect(db.securityRateLimitClaims).toHaveLength(0);
    });

    it("blocks the sixty-first login attempt in the shared unknown IP bucket", async () => {
      const db = new InMemoryD1();
      for (let index = 0; index < 60; index += 1) {
        const response = await worker.fetch(
          new Request("https://example.org/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email: `unknown-${index}@example.org`, password: "invalid" })
          }),
          env(db)
        );
        expect(response.status).toBe(401);
      }

      const denied = await worker.fetch(
        new Request("https://example.org/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "unknown-sixty-first@example.org", password: "invalid" })
        }),
        env(db)
      );

      expect(denied.status).toBe(429);
      await expect(denied.json()).resolves.toMatchObject({ error: "too_many_attempts" });
      expect([...db.loginRateLimits.keys()]).toHaveLength(1);
    });
  });

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
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ message: "Credenciales inválidas" });
    // A fresh LOGIN_FAILED audit is recorded for this attempt.
    const recent = db.audits.filter((audit) => audit.action === "LOGIN_FAILED");
    expect(recent).toHaveLength(6);
    expect(recent.at(-1)).toMatchObject({ action: "LOGIN_FAILED", entity_type: "user", entity_id: "olduser@example.org", summary: "Credenciales inválidas" });
  });

  it("audits a failed login and returns the credential error below the threshold", async () => {
    const db = new InMemoryD1();

    const response = await worker.fetch(loginRequest("nobody@example.org"), env(db));

    expect(response.status).toBe(401);
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

  it("does not let attacker failures from one IP lock out a victim on another IP", async () => {
    const db = new InMemoryD1();
    const hashed = await hashPassword("Valid#Pass2026", "fixed-salt", { enforcePolicy: false });
    db.users.push({
      id: "user_victim",
      email: "victim@example.org",
      name: "Victim User",
      role: "ADMIN",
      password_hash: hashed.hash,
      password_salt: hashed.salt,
      disabled_at: ""
    });
    // An attacker seeds the failure threshold for the victim's email from their own IP.
    for (let i = 0; i < 5; i += 1) {
      seedAudit(db, "LOGIN_FAILED", "victim@example.org", `2026-07-04T11:5${i}:00.000Z`, "203.0.113.7");
    }

    // The victim, arriving from a different IP with the correct password, must not be
    // throttled by the attacker's failures.
    const response = await worker.fetch(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.4" },
        body: JSON.stringify({ email: "victim@example.org", password: "Valid#Pass2026" })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ user: { email: "victim@example.org", role: "ADMIN" } });
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "LOGIN", entity_id: "user_victim" }));
  });

  it("still throttles repeated failures from the same IP", async () => {
    const db = new InMemoryD1();
    // Five recent failures from a single IP for one email — the sixth must be throttled
    // before any credential work runs.
    for (let i = 0; i < 5; i += 1) {
      seedAudit(db, "LOGIN_FAILED", "abuser@example.org", `2026-07-04T11:5${i}:00.000Z`, "203.0.113.7");
    }

    const response = await worker.fetch(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.7" },
        body: JSON.stringify({ email: "abuser@example.org", password: "whatever" })
      }),
      env(db)
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ error: "too_many_attempts" });
    // No credential work ran, so no additional LOGIN_FAILED audit was written.
    expect(db.audits.filter((audit) => audit.action === "LOGIN_FAILED")).toHaveLength(5);
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
    const sourceAccountKey = await sha256Hex(utf8Bytes("password-reset:user_operator:unknown"));
    for (let i = 0; i < 3; i += 1) {
      db.securityRateLimitClaims.push({
        id: `reset_rate_${i}`,
        scope: "password_reset",
        key_hash: sourceAccountKey,
        claimed_at: `2026-07-04T11:5${i}:00.000Z`,
        expires_at: "2026-07-04T12:15:00.000Z"
      });
    }

    const auditCountBefore = db.audits.length;
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "legacy-contact-6@example.com",
      EMAIL: {
        send: async (message: unknown) => {
          sentMessages.push(message);
          return { messageId: "cf-email-reset" };
        }
      } as SendEmail
    });
    const response = await fetchAndWaitUntil(
      new Request("https://example.org/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "operator@example.org" })
      }),
      runtime
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(db.resetTokens).toHaveLength(0);
    expect(sentMessages).toHaveLength(0);
    expect(db.audits).toHaveLength(auditCountBefore);
    expect(db.audits.some((row) => row.action === "PASSWORD_RESET_THROTTLED")).toBe(false);
  });

  it.each([
    ["active", true],
    ["unknown", false]
  ] as const)("schedules the same background reset unit for an %s account", async (_label, active) => {
    const db = new InMemoryD1();
    if (active) {
      db.users.push({
        id: "user_reset",
        email: "candidate@example.org",
        name: "Reset Candidate",
        role: "ADMIN",
        password_hash: "old-hash",
        password_salt: "old-salt",
        disabled_at: ""
      });
    }
    const tasks: Promise<unknown>[] = [];
    const response = await worker.fetch(
      new Request("https://example.org/api/auth/password-reset/request", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.23" },
        body: JSON.stringify({ email: "candidate@example.org" })
      }),
      env(db),
      executionContextCapturing(tasks)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);
    expect(db.resetTokens).toHaveLength(active ? 1 : 0);
  });
});

describe("session logout", () => {
  it("revokes the presented bearer on the server and remains idempotent", async () => {
    const db = new InMemoryD1();
    const rawToken = "copied-session-token";
    db.users.push({
      id: "user_admin",
      email: "admin@example.org",
      name: "Admin",
      role: "ADMIN",
      password_hash: "hash",
      password_salt: "salt",
      disabled_at: null
    });
    db.sessions.push({
      id: "session_logout",
      user_id: "user_admin",
      token_hash: await sha256Hex(utf8Bytes(rawToken)),
      expires_at: "2099-01-01T00:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      revoked_at: null
    });
    const runtime = env(db);
    const authorization = { Authorization: `Bearer ${rawToken}` };

    const before = await worker.fetch(new Request("https://example.org/api/users", { headers: authorization }), runtime);
    const logout = await worker.fetch(
      new Request("https://example.org/api/auth/logout", { method: "POST", headers: authorization }),
      runtime
    );
    const after = await worker.fetch(new Request("https://example.org/api/users", { headers: authorization }), runtime);
    const repeated = await worker.fetch(
      new Request("https://example.org/api/auth/logout", { method: "POST", headers: authorization }),
      runtime
    );
    const missing = await worker.fetch(new Request("https://example.org/api/auth/logout", { method: "POST" }), runtime);

    expect(before.status).toBe(200);
    expect(logout.status).toBe(204);
    expect(db.sessions[0].revoked_at).toBeTruthy();
    expect(after.status).toBe(401);
    expect(repeated.status).toBe(204);
    expect(missing.status).toBe(401);
  });
});

describe("credential-current session issuance", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["self-reset", "admin-reset"] as const)(
    "does not issue a session when %s wins after password verification",
    async (mutation) => {
      const db = new InMemoryD1();
      const runtime = env(db);
      const old = await hashPassword("Old#Password2026", "old-salt", {
        enforcePolicy: false
      });
      db.users.push({
        id: "user_race",
        email: "race@example.org",
        name: "Race",
        role: "OPERATOR",
        password_hash: old.hash,
        password_salt: old.salt,
        disabled_at: null
      });

      if (mutation === "self-reset") {
        const resetToken = "self-reset-token";
        db.resetTokens.push({
          id: "reset_race",
          user_id: "user_race",
          token_hash: await sha256Hex(utf8Bytes(resetToken)),
          expires_at: "2026-07-04T13:00:00.000Z",
          used_at: null
        });
        db.beforeCredentialGuardedSessionBatch = async () => {
          db.beforeCredentialGuardedSessionBatch = null;
          await new AuthService(runtime).confirmPasswordReset(resetToken, "New#Password2026");
        };
      } else {
        db.beforeCredentialGuardedSessionBatch = async () => {
          db.beforeCredentialGuardedSessionBatch = null;
          await new AuthService(runtime).resetUserPassword("user_race", "Admin#Password2026");
        };
      }

      await expect(
        new AuthService(runtime).login("race@example.org", "Old#Password2026")
      ).rejects.toThrow("Credenciales inválidas");
      expect(db.sessions).toHaveLength(0);
    }
  );

  it("does not prune valid sessions when a stale credential guard loses", async () => {
    const db = new InMemoryD1();
    const runtime = env(db);
    const old = await hashPassword("Old#Password2026", "old-salt", {
      enforcePolicy: false
    });
    db.users.push({
      id: "user_stale",
      email: "stale@example.org",
      name: "Stale",
      role: "OPERATOR",
      password_hash: old.hash,
      password_salt: old.salt,
      disabled_at: null
    });
    for (let index = 0; index < 8; index += 1) {
      db.sessions.push({
        id: `session_${index}`,
        user_id: "user_stale",
        token_hash: `existing_${index}`,
        expires_at: "2026-07-05T12:00:00.000Z",
        created_at: `2026-07-04T11:${String(index).padStart(2, "0")}:00.000Z`,
        revoked_at: null
      });
    }
    db.beforeCredentialGuardedSessionBatch = async () => {
      db.beforeCredentialGuardedSessionBatch = null;
      await new AuthService(runtime).resetUserPassword(
        "user_stale",
        "Changed#Password2026"
      );
    };

    await expect(
      new AuthService(runtime).login("stale@example.org", "Old#Password2026")
    ).rejects.toThrow("Credenciales inválidas");
    expect(db.sessions.map((row) => row.id)).toEqual([
      "session_0",
      "session_1",
      "session_2",
      "session_3",
      "session_4",
      "session_5",
      "session_6",
      "session_7"
    ]);
  });

  it("does not issue or prune sessions when user is disabled after password verification", async () => {
    const db = new InMemoryD1();
    const runtime = env(db);
    const stored = await hashPassword("Valid#Password2026", "fixed-salt", {
      enforcePolicy: false
    });
    const passwordHash = `pbkdf2$100000$${stored.hash}`;
    db.users.push({
      id: "user_disabled_race",
      email: "disabled-race@example.org",
      name: "Disabled Race",
      role: "OPERATOR",
      password_hash: passwordHash,
      password_salt: stored.salt,
      disabled_at: null
    });
    for (let index = 0; index < 8; index += 1) {
      db.sessions.push({
        id: `disabled_session_${index}`,
        user_id: "user_disabled_race",
        token_hash: `disabled_existing_${index}`,
        expires_at: "2026-07-05T12:00:00.000Z",
        created_at: `2026-07-04T11:${String(index).padStart(2, "0")}:00.000Z`,
        revoked_at: null
      });
    }
    const sessionsBefore = structuredClone(db.sessions);
    db.beforeCredentialGuardedSessionBatch = async () => {
      db.users[0].disabled_at = "2026-07-04T12:00:00.000Z";
    };

    await expect(
      new AuthService(runtime).login(
        "disabled-race@example.org",
        "Valid#Password2026"
      )
    ).rejects.toThrow("Credenciales inválidas");
    expect(db.users[0]).toMatchObject({
      password_hash: passwordHash,
      password_salt: stored.salt,
      disabled_at: "2026-07-04T12:00:00.000Z"
    });
    expect(db.sessions).toStrictEqual(sessionsBefore);
  });

  it("does not issue a session when an email change wins after password verification", async () => {
    const db = new InMemoryD1();
    const runtime = env(db);
    const stored = await hashPassword("Valid#Password2026", "fixed-salt", {
      enforcePolicy: false
    });
    db.users.push({
      id: "user_email_race",
      email: "before@example.org",
      name: "Email Race",
      role: "OPERATOR",
      password_hash: stored.hash,
      password_salt: stored.salt,
      disabled_at: null,
      auth_generation: 0,
      created_at: "2026-07-04T11:00:00.000Z",
      updated_at: "2026-07-04T11:00:00.000Z"
    });
    db.beforeCredentialGuardedSessionBatch = async () => {
      await new Repository(runtime.DB).updateUser("user_email_race", {
        email: "after@example.org"
      });
    };

    await expect(
      new AuthService(runtime).login("before@example.org", "Valid#Password2026")
    ).rejects.toThrow("Credenciales inválidas");
    expect(db.users[0]).toMatchObject({ email: "after@example.org", auth_generation: 1 });
    expect(db.sessions).toHaveLength(0);
  });

  it("does not issue a session after a disable and re-enable cycle completed post-verification", async () => {
    const db = new InMemoryD1();
    const runtime = env(db);
    const stored = await hashPassword("Valid#Password2026", "fixed-salt", {
      enforcePolicy: false
    });
    db.users.push({
      id: "user_reenabled_race",
      email: "reenabled@example.org",
      name: "Re-enabled Race",
      role: "OPERATOR",
      password_hash: stored.hash,
      password_salt: stored.salt,
      disabled_at: null,
      auth_generation: 0,
      created_at: "2026-07-04T11:00:00.000Z",
      updated_at: "2026-07-04T11:00:00.000Z"
    });
    db.beforeCredentialGuardedSessionBatch = async () => {
      const repository = new Repository(runtime.DB);
      await repository.updateUser("user_reenabled_race", { disabled: true });
      await repository.updateUser("user_reenabled_race", { disabled: false });
    };

    await expect(
      new AuthService(runtime).login("reenabled@example.org", "Valid#Password2026")
    ).rejects.toThrow("Credenciales inválidas");
    expect(db.users[0]).toMatchObject({ disabled_at: null, auth_generation: 2 });
    expect(db.sessions).toHaveLength(0);
  });

  it("keeps at most eight active session rows and evicts the oldest bearer", async () => {
    const db = new InMemoryD1();
    const runtime = env(db);
    const stored = await hashPassword("Valid#Password2026", "fixed-salt", {
      enforcePolicy: false
    });
    db.users.push({
      id: "user_cap",
      email: "cap@example.org",
      name: "Cap",
      role: "VIEWER",
      password_hash: stored.hash,
      password_salt: stored.salt,
      disabled_at: null
    });
    for (let index = 0; index < 8; index += 1) {
      db.sessions.push({
        id: `session_${index}`,
        user_id: "user_cap",
        token_hash: `existing_${index}`,
        expires_at: "2026-07-05T12:00:00.000Z",
        created_at: `2026-07-04T11:${String(index).padStart(2, "0")}:00.000Z`,
        revoked_at: null
      });
    }

    const newest = await new AuthService(runtime).login(
      "cap@example.org",
      "Valid#Password2026"
    );

    expect(db.sessions).toHaveLength(8);
    expect(db.sessions.some((row) => row.id === "session_0")).toBe(false);
    const newestTokenHash = await sha256Hex(utf8Bytes(newest.token));
    expect(
      db.sessions.some((row) => row.token_hash === newestTokenHash)
    ).toBe(true);
  });

  it("keeps concurrent committed session rows at or below eight", async () => {
    const db = new InMemoryD1();
    const runtime = env(db);
    const stored = await hashPassword("Valid#Password2026", "fixed-salt", {
      enforcePolicy: false
    });
    db.users.push({
      id: "user_concurrent_cap",
      email: "concurrent-cap@example.org",
      name: "Concurrent Cap",
      role: "VIEWER",
      password_hash: `pbkdf2$100000$${stored.hash}`,
      password_salt: stored.salt,
      disabled_at: null
    });

    const logins = await Promise.all(
      Array.from({ length: 9 }, () =>
        new AuthService(runtime).login(
          "concurrent-cap@example.org",
          "Valid#Password2026"
        )
      )
    );

    expect(logins).toHaveLength(9);
    expect(db.sessions).toHaveLength(8);
    expect(db.maxCommittedSessionRows).toBe(8);
  });
});

function bootstrapRequest(options: { token?: string } = {}, clientIp?: string): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.token) {
    headers.set("X-Bootstrap-Owner-Token", options.token);
  }
  if (clientIp) {
    headers.set("CF-Connecting-IP", clientIp);
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hexFromBytes(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
