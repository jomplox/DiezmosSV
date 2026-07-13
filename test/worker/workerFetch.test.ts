import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { hashPassword } from "../../src/worker/services/auth";
import { IssuancePipeline, RejectedWompiRetryConflictError } from "../../src/worker/services/pipeline";
import { EnvironmentNotAllowedError } from "../../src/worker/services/environmentPolicy";
import { previousElSalvadorMonth } from "../../src/worker/services/retention";
import { INTENT_EXPIRY_SWEEP_LIMIT } from "../../src/worker/storage/repository";
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
        expect(response.status).toBe(500);
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

    it("keeps aggregate login buckets independent and resets an expired bucket", async () => {
      const db = new InMemoryD1();
      db.loginRateLimits.set("expired-hash", {
        window_started_at: "2026-07-04T11:00:00.000Z",
        attempt_count: 60,
        expires_at: "2026-07-04T11:15:00.000Z"
      });

      const otherIp = await worker.fetch(
        new Request("https://example.org/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "198.51.100.9"
          },
          body: JSON.stringify({ email: "other@example.org", password: "invalid" })
        }),
        env(db)
      );

      expect(otherIp.status).toBe(500);
      await worker.scheduled(
        { cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent,
        env(db)
      );
      expect(db.loginRateLimits.has("expired-hash")).toBe(false);
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
        expect(response.status).toBe(500);
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

describe("donation intents", () => {
  // A checksum-valid DUI (10000001-9) and a deliberately invalid one that only
  // fails the verifier digit (01234567-0; correct check digit is 8).
  const VALID_DUI = "10000001-9";
  const BAD_CHECKSUM_DUI = "01234567-0";

  function validIntentBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    // Name and email are collected on Wompi's hosted sheet, not on the /donar form,
    // so the intent body carries only documento, teléfono, dirección, and monto.
    return {
      amount: "25.50",
      donorDocumentType: "13",
      donorDocument: VALID_DUI,
      donorPhone: "70001122",
      departamento: "06",
      municipio: "23",
      distrito: "14",
      complemento: "Colonia Escalón, San Salvador",
      ...overrides
    };
  }

  function intentRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
    return new Request("https://example.org/api/donations/intent", {
      method: "POST",
      headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
      body: JSON.stringify(body)
    });
  }

  it("creates a PENDING intent, attaches a mock Wompi link, and returns all three link fields", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody()), env(db));

    expect(response.status).toBe(201);
    const payload = (await response.json()) as { intentId: string; urlEnlace: string; urlEnlaceLargo: string; datosToken?: string };
    expect(payload.intentId).toMatch(/^di_/);
    expect(payload.urlEnlace).toBe(`https://mock.wompi.sv/enlace/${payload.intentId}`);
    expect(payload.urlEnlaceLargo).toBe(`https://mock.wompi.sv/enlace-largo/${payload.intentId}`);
    expect(payload.datosToken).toBeUndefined();

    expect(db.donationIntents).toHaveLength(1);
    const intent = db.donationIntents[0];
    expect(intent.status).toBe("LINK_CREATED");
    expect(intent.amount_cents).toBe(2550);
    expect(intent.donor_document).toBe("10000001-9"); // stored canonically via formatDui
    // Name and email are never collected on the form: they are bound null and later
    // sourced from the webhook.
    expect(intent.donor_name).toBeNull();
    expect(intent.donor_email).toBeNull();
    expect(intent.client_ip).toBe("203.0.113.7");
    expect(intent.wompi_url_enlace).toBe(payload.urlEnlace);

    // Audit records the intent creation with amount + document type, never the number.
    const audit = db.audits.find((row) => row.action === "DONATION_INTENT_CREATED");
    expect(audit).toBeDefined();
    expect(audit?.entity_type).toBe("donation_intent");
    expect(audit?.entity_id).toBe(payload.intentId);
    const metadata = JSON.stringify(audit?.metadata_json ?? "");
    expect(metadata).not.toContain("04182769");
  });

  it("rejects an oversized public intent body with 413 before any persistence", async () => {
    // A body over the 16 KiB cap is refused up front, so oversized spam never
    // reaches validation or D1 (the per-IP throttle counts only persisted rows).
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(validIntentBody({ filler: "x".repeat(17 * 1024) })),
      env(db)
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: "request_body_too_large",
      message: "La solicitud es demasiado grande."
    });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("accepts a numeric amount and a type 37 free-form document without checksum rules", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(validIntentBody({ amount: 100, donorDocumentType: "37", donorDocument: "PASAPORTE-XZ-9" })),
      env(db)
    );

    expect(response.status).toBe(201);
    expect(db.donationIntents[0].amount_cents).toBe(10000);
    expect(db.donationIntents[0].donor_document).toBe("PASAPORTE-XZ-9");
    // Domestic intents never carry a país.
    expect(db.donationIntents[0].donor_pais).toBeNull();
    // Absent giftType stays null (legacy/US paths never send it).
    expect(db.donationIntents[0].gift_type).toBeNull();
  });

  it("persists a chosen gift type (DIEZMO / OFRENDA) on the intent", async () => {
    const diezmoDb = new InMemoryD1();
    const diezmo = await worker.fetch(intentRequest(validIntentBody({ giftType: "DIEZMO" })), env(diezmoDb));
    expect(diezmo.status).toBe(201);
    expect(diezmoDb.donationIntents[0].gift_type).toBe("DIEZMO");

    const ofrendaDb = new InMemoryD1();
    const ofrenda = await worker.fetch(intentRequest(validIntentBody({ giftType: "OFRENDA" })), env(ofrendaDb));
    expect(ofrenda.status).toBe(201);
    expect(ofrendaDb.donationIntents[0].gift_type).toBe("OFRENDA");
  });

  it("rejects an invalid gift type without persisting the intent", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ giftType: "GIFT" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_gift_type",
      message: "Seleccione el tipo de aportación: diezmo u ofrenda."
    });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("still accepts an intent with no gift type at all (legacy / US paths)", async () => {
    const db = new InMemoryD1();
    // validIntentBody carries no giftType key.
    const response = await worker.fetch(intentRequest(validIntentBody()), env(db));

    expect(response.status).toBe(201);
    expect(db.donationIntents[0].gift_type).toBeNull();
  });

  it("creates a NIT (36) intent with canonical document storage and the razón social", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "36", donorDocument: "06142803901121", donorName: "Empresa Ejemplo, S.A. de C.V." })),
      env(db)
    );

    expect(response.status).toBe(201);
    const intent = db.donationIntents[0];
    // Stored canonically as XXXX-XXXXXX-XXX-X regardless of input hyphenation.
    expect(intent.donor_document).toBe("0614-280390-112-1");
    // The razón social rides in donor_name so the correlated CDE names the empresa,
    // not the Wompi cardholder.
    expect(intent.donor_name).toBe("Empresa Ejemplo, S.A. de C.V.");
  });

  it("rejects an empresa NIT without exactly 14 digits", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "36", donorDocument: "0614-280390-112", donorName: "Empresa Ejemplo" })),
      env(db)
    );

    expect(response.status).toBe(400);
    // Donor-facing copy frames the 36 type as the empresa's NIT (the /donar select
    // labels it "Empresa" so legacy personal-NIT holders are not baited into it).
    await expect(response.json()).resolves.toEqual({
      error: "invalid_nit",
      message: "Ingrese el NIT de la empresa (14 dígitos)."
    });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("requires the razón social for NIT intents and caps it at 200 characters", async () => {
    const missing = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "36", donorDocument: "06142803901121" })),
      env(new InMemoryD1())
    );
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ error: "invalid_razon_social" });

    const tooLong = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "36", donorDocument: "06142803901121", donorName: "x".repeat(201) })),
      env(new InMemoryD1())
    );
    expect(tooLong.status).toBe(400);
    await expect(tooLong.json()).resolves.toMatchObject({ error: "invalid_razon_social" });
  });

  it("bounds pasaporte (03) and carnet (02) documents to 5-30 chars and stores them uppercase", async () => {
    const pasaporteDb = new InMemoryD1();
    const pasaporte = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "03", donorDocument: "ab-123456" })),
      env(pasaporteDb)
    );
    expect(pasaporte.status).toBe(201);
    expect(pasaporteDb.donationIntents[0].donor_document).toBe("AB-123456");

    const carnetDb = new InMemoryD1();
    const carnet = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "02", donorDocument: "cr 2026-001" })),
      env(carnetDb)
    );
    expect(carnet.status).toBe(201);
    expect(carnetDb.donationIntents[0].donor_document).toBe("CR 2026-001");

    const tooShort = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "03", donorDocument: "A123" })),
      env(new InMemoryD1())
    );
    expect(tooShort.status).toBe(400);
    await expect(tooShort.json()).resolves.toMatchObject({ error: "invalid_identity_document" });

    const tooLong = await worker.fetch(
      intentRequest(validIntentBody({ donorDocumentType: "02", donorDocument: "X".repeat(31) })),
      env(new InMemoryD1())
    );
    expect(tooLong.status).toBe(400);
    await expect(tooLong.json()).resolves.toMatchObject({ error: "invalid_identity_document" });
  });

  it("rejects document types outside the five CAT-022 receptor codes", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ donorDocumentType: "99" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_document_type" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("stores the 00/00/00 geography plus the CAT-020 país for a foreign-resident intent", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(
        validIntentBody({ departamento: "00", municipio: "00", distrito: "00", pais: "US", complemento: "742 Evergreen Terrace, Springfield" })
      ),
      env(db)
    );

    expect(response.status).toBe(201);
    const intent = db.donationIntents[0];
    expect(intent.direccion_departamento).toBe("00");
    expect(intent.direccion_municipio).toBe("00");
    expect(intent.direccion_distrito).toBe("00");
    expect(intent.donor_pais).toBe("US");
  });

  it("rejects SV as the país on the foreign path", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      intentRequest(validIntentBody({ departamento: "00", municipio: "00", distrito: "00", pais: "SV" })),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_pais_sv" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("rejects a foreign-path intent whose país is missing or outside CAT-020", async () => {
    const missing = await worker.fetch(
      intentRequest(validIntentBody({ departamento: "00", municipio: "00", distrito: "00" })),
      env(new InMemoryD1())
    );
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ error: "invalid_pais" });

    const bogus = await worker.fetch(
      intentRequest(validIntentBody({ departamento: "00", municipio: "00", distrito: "00", pais: "XX" })),
      env(new InMemoryD1())
    );
    expect(bogus.status).toBe(400);
    await expect(bogus.json()).resolves.toMatchObject({ error: "invalid_pais" });
  });

  it("rejects an amount below the one-dollar minimum", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ amount: "0.99" })), env(db));

    expect(response.status).toBe(400);
    const payload = (await response.json()) as { error: string; message: string };
    expect(payload.error).toBe("invalid_amount");
    expect(payload.message).toMatch(/usted|monto/i);
    expect(db.donationIntents).toHaveLength(0);
  });

  it("rejects an amount above the five-thousand-dollar maximum", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ amount: "5000.01" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_amount" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("ignores a donorName/donorEmail on non-NIT intents: they are neither validated nor persisted", async () => {
    const db = new InMemoryD1();
    // Even if a client sends name/email on a non-NIT intent, the endpoint neither
    // requires nor stores them (the razón social is bound only for NIT/36, so the
    // webhook cardholder name still wins for personal donors).
    const response = await worker.fetch(
      intentRequest(validIntentBody({ donorName: "Ignorado", donorEmail: "ignorado@example.org" })),
      env(db)
    );

    expect(response.status).toBe(201);
    expect(db.donationIntents).toHaveLength(1);
    expect(db.donationIntents[0].donor_name).toBeNull();
    expect(db.donationIntents[0].donor_email).toBeNull();
  });

  it("rejects a DUI that fails the check digit for document type 13", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ donorDocument: BAD_CHECKSUM_DUI })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_dui",
      message: "DUI inválido: revise el número y el dígito verificador."
    });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("rejects a municipio that does not belong to the given departamento", async () => {
    const db = new InMemoryD1();
    // 23 is a valid San Salvador (06) municipio but not valid under Ahuachapán (01).
    const response = await worker.fetch(intentRequest(validIntentBody({ departamento: "01", municipio: "23", distrito: "01" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_municipio" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("rejects a distrito that does not belong to the given departamento", async () => {
    const db = new InMemoryD1();
    // 14 is a valid district under San Salvador (06) but not under Ahuachapán (01).
    const response = await worker.fetch(intentRequest(validIntentBody({ departamento: "01", municipio: "13", distrito: "14" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_distrito" });
  });

  it("rejects a missing complemento", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ complemento: "" })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_complemento" });
  });

  it("rejects a complemento longer than the MH schema's 200-char cap", async () => {
    // fe-cd-v2 caps receptor direccion.complemento at 200. Anything longer would
    // pass intent validation, take the donor's payment, and then FAIL the schema
    // at CDE build time — a paid donation stranded without a comprobante.
    const db = new InMemoryD1();
    const response = await worker.fetch(intentRequest(validIntentBody({ complemento: "x".repeat(201) })), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_complemento" });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("blocks the sixth intent from one IP within 15 minutes with a 429", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      const db = new InMemoryD1();
      // Five intents already created by this IP inside the window.
      for (let i = 0; i < 5; i += 1) {
        db.donationIntents.push({
          id: `di_seed_${i}`,
          status: "LINK_CREATED",
          client_ip: "203.0.113.7",
          expires_at: "2026-07-04T13:00:00.000Z",
          created_at: `2026-07-04T11:5${i}:00.000Z`
        });
      }

      const response = await worker.fetch(intentRequest(validIntentBody()), env(db));

      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toEqual({
        error: "too_many_attempts",
        message: "Demasiados intentos. Espere 15 minutos e intente de nuevo."
      });
      // No new intent was created.
      expect(db.donationIntents).toHaveLength(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 502 and leaves the intent PENDING when Wompi link creation fails", async () => {
    const db = new InMemoryD1();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
    try {
      const response = await worker.fetch(
        intentRequest(validIntentBody()),
        env(db, {
          MOCK_EXTERNAL_SERVICES: "false",
          APP_ORIGIN: "https://donar.example.org",
          EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
          WOMPI_CLIENT_ID: "id",
          WOMPI_CLIENT_SECRET: "secret"
        })
      );

      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({ error: "wompi_link_failed" });
      expect(db.donationIntents).toHaveLength(1);
      expect(db.donationIntents[0].status).toBe("PENDING");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns the status and paid flag for a known intent id", async () => {
    const db = new InMemoryD1();
    db.donationIntents.push({ id: "di_known", status: "LINK_CREATED", donor_name: "Secreto", donor_document: "10000001-9", paid_at: null });

    const response = await worker.fetch(new Request("https://example.org/api/donations/intent/di_known/status"), env(db));

    expect(response.status).toBe(200);
    // Backward-compatible: status unchanged, paid added. Unpaid intent → paid:false.
    await expect(response.json()).resolves.toEqual({ status: "LINK_CREATED", paid: false });
  });

  it("reports paid:true once paid_at is stamped (donor thanks keys on payment, not MH acceptance)", async () => {
    const db = new InMemoryD1();
    db.donationIntents.push({
      id: "di_paidflag",
      status: "LINK_CREATED",
      donor_name: "Secreto",
      donor_document: "10000001-9",
      paid_at: "2026-07-04T12:30:00.000Z"
    });

    const response = await worker.fetch(new Request("https://example.org/api/donations/intent/di_paidflag/status"), env(db));

    expect(response.status).toBe(200);
    // Status is still LINK_CREATED (CDE not yet accepted) but the donor already paid.
    await expect(response.json()).resolves.toEqual({ status: "LINK_CREATED", paid: true });
  });

  it("returns 404 for an unknown intent id", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(new Request("https://example.org/api/donations/intent/di_missing/status"), env(db));

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "intent_not_found" });
  });

  it("expires overdue unpaid (PENDING and LINK_CREATED) intents on the 15-minute cron sweep", async () => {
    const db = new InMemoryD1();
    db.donationIntents.push(
      { id: "di_overdue", status: "PENDING", wompi_id_enlace: null, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" },
      { id: "di_link_overdue", status: "LINK_CREATED", wompi_id_enlace: 555, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" },
      { id: "di_fresh", status: "PENDING", wompi_id_enlace: null, amount_cents: 2550, expires_at: "2026-07-04T13:00:00.000Z", created_at: "2026-07-04T12:00:00.000Z" },
      { id: "di_done", status: "COMPLETED", wompi_id_enlace: 999, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" }
    );
    // Mock mode (env's default): deactivatePaymentLink is a no-op, so no fetch happens.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db));
    } finally {
      vi.useRealTimers();
    }

    // An abandoned checkout (link minted, donor never paid) must not sit as
    // LINK_CREATED forever — it expires just like an unlinked PENDING intent.
    expect(db.donationIntents.find((row) => row.id === "di_overdue")?.status).toBe("EXPIRED");
    expect(db.donationIntents.find((row) => row.id === "di_link_overdue")?.status).toBe("EXPIRED");
    expect(db.donationIntents.find((row) => row.id === "di_fresh")?.status).toBe("PENDING");
    expect(db.donationIntents.find((row) => row.id === "di_done")?.status).toBe("COMPLETED");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("deactivates the Wompi link of each expired LINK_CREATED intent in real mode", async () => {
    const db = new InMemoryD1();
    db.donationIntents.push(
      { id: "di_link_overdue", status: "LINK_CREATED", wompi_id_enlace: 555, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" },
      { id: "di_pending_overdue", status: "PENDING", wompi_id_enlace: null, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" }
    );
    // Token, then the PUT that deactivates the one link with a wompi_id_enlace.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "tok", expires_in: 3600, token_type: "Bearer" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ idEnlace: 555, usable: false }), { status: 200 }));

    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        APP_ORIGIN: "https://donar.example.org",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        WOMPI_CLIENT_ID: "id",
        WOMPI_CLIENT_SECRET: "secret"
      }));
    } finally {
      vi.useRealTimers();
    }

    // Both intents expire; only the linked one triggers a token + PUT (2 calls).
    expect(db.donationIntents.find((row) => row.id === "di_link_overdue")?.status).toBe("EXPIRED");
    expect(db.donationIntents.find((row) => row.id === "di_pending_overdue")?.status).toBe("EXPIRED");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [putUrl, putInit] = fetchSpy.mock.calls[1];
    expect(putUrl).toBe("https://api.wompi.sv/EnlacePago/555");
    expect((putInit as RequestInit).method).toBe("PUT");
  });

  it("still expires intents when a Wompi deactivation PUT fails", async () => {
    const db = new InMemoryD1();
    db.donationIntents.push(
      { id: "di_link_overdue", status: "LINK_CREATED", wompi_id_enlace: 555, amount_cents: 2550, expires_at: "2026-07-04T11:00:00.000Z", created_at: "2026-07-04T10:00:00.000Z" }
    );
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "tok", expires_in: 3600, token_type: "Bearer" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("boom", { status: 500 }));

    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      // A deactivation failure must not throw out of the sweep or leave the intent unexpired.
      await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        APP_ORIGIN: "https://donar.example.org",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        WOMPI_CLIENT_ID: "id",
        WOMPI_CLIENT_SECRET: "secret"
      }));
    } finally {
      vi.useRealTimers();
    }

    expect(db.donationIntents.find((row) => row.id === "di_link_overdue")?.status).toBe("EXPIRED");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("caps one sweep at INTENT_EXPIRY_SWEEP_LIMIT and lets the next tick continue", async () => {
    const db = new InMemoryD1();
    // More expirable rows than a single tick can process, so attacker-created intents
    // cannot force one cron invocation to snapshot or deactivate an unbounded set.
    const overflow = 5;
    for (let i = 0; i < INTENT_EXPIRY_SWEEP_LIMIT + overflow; i += 1) {
      const suffix = String(i).padStart(4, "0");
      db.donationIntents.push({
        id: `di_exp_${suffix}`,
        status: "PENDING",
        wompi_id_enlace: null,
        amount_cents: 2550,
        expires_at: "2026-07-04T11:00:00.000Z",
        created_at: "2026-07-04T10:00:00.000Z"
      });
    }
    const expiredCount = () => db.donationIntents.filter((row) => row.status === "EXPIRED").length;

    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:00:00.000Z") });
    try {
      await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db));
      // Exactly the cap expires this tick; the remainder stays PENDING for the next one.
      expect(expiredCount()).toBe(INTENT_EXPIRY_SWEEP_LIMIT);
      expect(db.donationIntents.filter((row) => row.status === "PENDING")).toHaveLength(overflow);

      await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db));
      // The next tick continues from where the first left off.
      expect(expiredCount()).toBe(INTENT_EXPIRY_SWEEP_LIMIT + overflow);
      expect(db.donationIntents.some((row) => row.status === "PENDING")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Premint: draft create (amount + optional giftType only) ────────────────
  //
  // The donor wizard mints the Wompi link in the background when the SV donor
  // ENTERS Paso 2, before the fiscal data exists. That draft body carries only the
  // amount (and, on the SV path, the gift type) — no documento/dirección — yet the
  // link is minted exactly as today (identificadorEnlaceComercio = intent id).
  describe("draft create (no donor fields)", () => {
    function draftRequest(body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
      return new Request("https://example.org/api/donations/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
        body: JSON.stringify(body)
      });
    }

    it("mints the Wompi link for a draft carrying only { amount, giftType } (donor data absent)", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(draftRequest({ amount: "25.50", giftType: "DIEZMO" }), env(db));

      expect(response.status).toBe(201);
      const payload = (await response.json()) as { intentId: string; urlEnlace: string; urlEnlaceLargo: string; datosToken?: string };
      // Response shape is unchanged from the full create, and the link is minted with
      // identificadorEnlaceComercio = intent id (mock echoes the id into the URL).
      expect(payload.intentId).toMatch(/^di_/);
      expect(payload.urlEnlace).toBe(`https://mock.wompi.sv/enlace/${payload.intentId}`);
      expect(payload.urlEnlaceLargo).toBe(`https://mock.wompi.sv/enlace-largo/${payload.intentId}`);
      expect(payload.datosToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

      expect(db.donationIntents).toHaveLength(1);
      const intent = db.donationIntents[0];
      expect(intent.status).toBe("LINK_CREATED");
      expect(intent.amount_cents).toBe(2550);
      expect(intent.gift_type).toBe("DIEZMO");
      // The draft marker: donor document + address stay NULL until the datos call.
      expect(intent.donor_document).toBeNull();
      expect(intent.direccion_departamento).toBeNull();
      expect(intent.direccion_complemento).toBeNull();
      expect(intent.donor_name).toBeNull();
      expect(intent.client_ip).toBe("203.0.113.7");
      expect(String(intent.datos_token_hash)).toMatch(/^[a-f0-9]{64}$/);
      expect(intent.datos_token_hash).not.toBe(payload.datosToken);
    });

    it("mints a draft with no gift type at all (US / legacy background mint)", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(draftRequest({ amount: "10" }), env(db));

      expect(response.status).toBe(201);
      expect(db.donationIntents).toHaveLength(1);
      expect(db.donationIntents[0].gift_type).toBeNull();
      expect(db.donationIntents[0].donor_document).toBeNull();
    });

    it("still validates the amount for a draft (same rule as the full create)", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(draftRequest({ amount: "0.50", giftType: "DIEZMO" }), env(db));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_amount",
        message: "El monto debe estar entre $1.00 y $5,000.00."
      });
      expect(db.donationIntents).toHaveLength(0);
    });

    it("rejects a present-but-invalid gift type on a draft (no persistence)", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(draftRequest({ amount: "25.00", giftType: "GIFT" }), env(db));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_gift_type",
        message: "Seleccione el tipo de aportación: diezmo u ofrenda."
      });
      expect(db.donationIntents).toHaveLength(0);
    });

    it("applies the same per-IP throttle to draft creates", async () => {
      const db = new InMemoryD1();
      for (let i = 0; i < 5; i += 1) {
        db.donationIntents.push({ id: `di_seed_${i}`, client_ip: "203.0.113.7", created_at: "2026-07-04T12:00:00.000Z" });
      }
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:05:00.000Z") });
      try {
        const response = await worker.fetch(draftRequest({ amount: "25.00", giftType: "DIEZMO" }), env(db));
        expect(response.status).toBe(429);
        expect(db.donationIntents).toHaveLength(5);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ── Premint: datos completion (fast D1-only) ───────────────────────────────
  //
  // Attaches the donor's fiscal data to a minted draft with the same validation the
  // full create runs; NO Wompi call, and it must never touch amount or gift type.
  describe("datos completion", () => {
    const DATOS_TOKEN = "datos-capability-test-token";

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:30:00.000Z") });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    async function seedDraft(db: InMemoryD1, overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
      const draft = {
        id: "di_draft_1",
        status: "LINK_CREATED",
        amount_cents: 2550,
        donor_name: null,
        donor_document_type: "13",
        donor_document: null,
        donor_email: null,
        donor_phone: null,
        direccion_departamento: null,
        direccion_municipio: null,
        direccion_distrito: null,
        direccion_complemento: null,
        donor_pais: null,
        gift_type: "DIEZMO",
        wompi_id_enlace: 123456,
        wompi_url_enlace: "https://mock.wompi.sv/enlace/di_draft_1",
        wompi_url_enlace_largo: "https://mock.wompi.sv/enlace-largo/di_draft_1",
        document_id: null,
        client_ip: "203.0.113.7",
        datos_token_hash: await sha256Hex(utf8Bytes(DATOS_TOKEN)),
        paid_at: null,
        created_at: "2026-07-04T12:00:00.000Z",
        updated_at: "2026-07-04T12:00:00.000Z",
        expires_at: "2026-07-04T13:00:00.000Z",
        ...overrides
      };
      db.donationIntents.push(draft);
      return draft;
    }

    function datosRequest(
      id: string,
      body: Record<string, unknown>,
      headers: Record<string, string> = { "X-Donation-Datos-Token": DATOS_TOKEN }
    ): Request {
      return new Request(`https://example.org/api/donations/intent/${id}/datos`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
        body: JSON.stringify(body)
      });
    }

    const validDatos = {
      donorDocumentType: "13",
      donorDocument: "10000001-9",
      donorPhone: "70001122",
      departamento: "06",
      municipio: "23",
      distrito: "14",
      complemento: "Colonia Escalón, San Salvador"
    };

    it("attaches donor data to a minted draft without a Wompi call or an amount/gift change", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      const fetchSpy = vi.spyOn(globalThis, "fetch");

      const response = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
      // No outbound HTTP: datos is D1-only.
      expect(fetchSpy).not.toHaveBeenCalled();

      const intent = db.donationIntents.find((row) => row.id === "di_draft_1")!;
      expect(intent.donor_document).toBe("10000001-9"); // stored canonically
      expect(intent.donor_document_type).toBe("13");
      expect(intent.donor_phone).toBe("70001122");
      expect(intent.direccion_departamento).toBe("06");
      expect(intent.direccion_complemento).toBe("Colonia Escalón, San Salvador");
      // Untouched by datos: money + tipo were locked at draft-mint time.
      expect(intent.amount_cents).toBe(2550);
      expect(intent.gift_type).toBe("DIEZMO");
      // Still LINK_CREATED and pointing at the same minted link.
      expect(intent.status).toBe("LINK_CREATED");
      expect(intent.wompi_id_enlace).toBe(123456);
      expect(intent.datos_token_hash).toBeNull();
    });

    it("rejects an oversized public datos body with 413 before mutating the draft", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      const response = await worker.fetch(
        datosRequest("di_draft_1", { ...validDatos, filler: "x".repeat(17 * 1024) }),
        env(db)
      );

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({
        error: "request_body_too_large",
        message: "La solicitud es demasiado grande."
      });
      // The draft is untouched: donor data was never attached.
      expect(db.donationIntents.find((row) => row.id === "di_draft_1")?.donor_document).toBeNull();
    });

    it("mirrors the full-create validation messages (invalid DUI)", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      const response = await worker.fetch(datosRequest("di_draft_1", { ...validDatos, donorDocument: "01234567-0" }), env(db));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_dui",
        message: "DUI inválido: revise el número y el dígito verificador."
      });
      // Nothing persisted on a rejected datos call.
      expect(db.donationIntents.find((row) => row.id === "di_draft_1")?.donor_document).toBeNull();
    });

    it("requires the razón social for a NIT (36) datos completion", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      const response = await worker.fetch(
        datosRequest("di_draft_1", { ...validDatos, donorDocumentType: "36", donorDocument: "06142803901121" }),
        env(db)
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "invalid_razon_social",
        message: "Ingrese la razón social (máximo 200 caracteres)."
      });
    });

    it("returns 404 for an unknown intent id", async () => {
      const db = new InMemoryD1();
      const response = await worker.fetch(datosRequest("di_missing", validDatos), env(db));

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ error: "intent_not_found" });
    });

    it("returns 409 for a COMPLETED intent", async () => {
      const db = new InMemoryD1();
      await seedDraft(db, { status: "COMPLETED", document_id: "dte_prev" });
      const response = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      // The completed intent is not mutated.
      expect(db.donationIntents.find((row) => row.id === "di_draft_1")?.donor_document).toBeNull();
    });

    it("rejects datos on an EXPIRED intent", async () => {
      const db = new InMemoryD1();
      await seedDraft(db, { status: "EXPIRED" });
      const response = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));

      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      const intent = db.donationIntents.find((row) => row.id === "di_draft_1")!;
      expect(intent.donor_document).toBeNull();
      expect(intent.status).toBe("EXPIRED");
    });

    it("rejects datos after expires_at even before the cron sweep marks the intent EXPIRED", async () => {
      const db = new InMemoryD1();
      await seedDraft(db, { status: "LINK_CREATED", expires_at: "2026-07-04T12:59:59.000Z" });
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T13:00:00.000Z") });
      try {
        const response = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
        expect(db.donationIntents[0].donor_document).toBeNull();
        expect(db.donationIntents[0].datos_token_hash).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects a missing or incorrect datos capability without mutating the draft", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);

      const missing = await worker.fetch(datosRequest("di_draft_1", validDatos, {}), env(db));
      const incorrect = await worker.fetch(
        datosRequest("di_draft_1", validDatos, { "X-Donation-Datos-Token": "wrong-capability" }),
        env(db)
      );

      expect(missing.status).toBe(409);
      expect(incorrect.status).toBe(409);
      await expect(missing.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      await expect(incorrect.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      expect(db.donationIntents[0].donor_document).toBeNull();
    });

    it("rejects replay after the datos capability has been consumed", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);

      const first = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));
      const replay = await worker.fetch(datosRequest("di_draft_1", { ...validDatos, complemento: "Ataque de replay" }), env(db));

      expect(first.status).toBe(200);
      expect(replay.status).toBe(409);
      await expect(replay.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      expect(db.donationIntents[0].direccion_complemento).toBe("Colonia Escalón, San Salvador");
    });

    it("allows exactly one of two concurrent datos capability requests", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);

      const responses = await Promise.all([
        worker.fetch(datosRequest("di_draft_1", validDatos), env(db)),
        worker.fetch(datosRequest("di_draft_1", { ...validDatos, complemento: "Segundo escritor" }), env(db))
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      expect(db.donationIntents[0].datos_token_hash).toBeNull();
      expect(["Colonia Escalón, San Salvador", "Segundo escritor"]).toContain(db.donationIntents[0].direccion_complemento);
    });

    it("rejects datos after payment and on full-create intents without a capability", async () => {
      const paidDb = new InMemoryD1();
      await seedDraft(paidDb, { paid_at: "2026-07-04T12:30:00.000Z" });
      const paid = await worker.fetch(datosRequest("di_draft_1", validDatos), env(paidDb));

      const fullDb = new InMemoryD1();
      await seedDraft(fullDb, {
        donor_document: "10000001-9",
        direccion_complemento: "Colonia Escalón, San Salvador",
        datos_token_hash: null
      });
      const full = await worker.fetch(datosRequest("di_draft_1", { ...validDatos, complemento: "Sobrescritura" }), env(fullDb));

      expect(paid.status).toBe(409);
      expect(full.status).toBe(409);
      await expect(paid.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      await expect(full.json()).resolves.toMatchObject({ error: "intent_datos_unavailable" });
      expect(paidDb.donationIntents[0].donor_document).toBeNull();
      expect(fullDb.donationIntents[0].direccion_complemento).toBe("Colonia Escalón, San Salvador");
    });

    it("applies the per-IP throttle to the public datos endpoint", async () => {
      const db = new InMemoryD1();
      await seedDraft(db);
      for (let i = 0; i < 5; i += 1) {
        db.donationIntents.push({ id: `di_seed_${i}`, client_ip: "203.0.113.7", created_at: "2026-07-04T12:00:00.000Z" });
      }
      vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-04T12:05:00.000Z") });
      try {
        const response = await worker.fetch(datosRequest("di_draft_1", validDatos), env(db));
        expect(response.status).toBe(429);
        // The draft was not modified.
        expect(db.donationIntents.find((row) => row.id === "di_draft_1")?.donor_document).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });
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

  it("builds the reset link from APP_ORIGIN even when the request carries a different origin", async () => {
    const db = new InMemoryD1();
    const sentMessages: Array<{ text: string; html?: string }> = [];
    db.users.push(knownUser());

    // Host-header poisoning: the request arrives via an attacker-controlled origin,
    // but the emailed reset link must use the canonical APP_ORIGIN so the token
    // cannot be captured by pointing the link at an attacker host.
    const response = await worker.fetch(
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
    expect(sentMessages[0].text).toContain("https://app.example.org/?reset=");
    expect(sentMessages[0].text).not.toContain("https://attacker.example/?reset=");
    expect(sentMessages[0].html).toContain('href="https://app.example.org/?reset=');
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

describe("online donation intents listing", () => {
  it("rejects an unauthenticated request with 401", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(new Request("https://example.org/api/donations/intents"), env(db));

    expect(response.status).toBe(401);
  });

  it("returns only allowlisted intent fields, exposing the linked numero de control for COMPLETED", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(
      testDocument({
        id: "doc_paid",
        numero_control: "DTE-15-M001P004-000000000000042",
        // The donante shown in the panel now comes from the emitted CDE's donor_name
        // (which was lifted from the webhook), not from the intent.
        donor_name: "Beto del Webhook"
      })
    );
    db.donationIntents.push(
      {
        id: "di_pending",
        status: "PENDING",
        amount_cents: 1000,
        // Name/email are no longer stored on the intent.
        donor_name: null,
        donor_document_type: "13",
        donor_document: "000000000",
        donor_email: null,
        donor_phone: null,
        direccion_departamento: "06",
        direccion_municipio: "22",
        direccion_distrito: "01",
        direccion_complemento: "San Salvador",
        donor_pais: null,
        gift_type: null,
        wompi_id_enlace: null,
        wompi_url_enlace: null,
        wompi_url_enlace_largo: null,
        document_id: null,
        client_ip: "203.0.113.9",
        created_at: "2026-07-05T10:00:00.000Z",
        updated_at: "2026-07-05T10:00:00.000Z",
        expires_at: "2026-07-05T11:00:00.000Z"
      },
      {
        id: "di_done",
        status: "COMPLETED",
        amount_cents: 2550,
        donor_name: null,
        donor_document_type: "13",
        donor_document: "000000000",
        donor_email: null,
        donor_phone: null,
        direccion_departamento: "06",
        direccion_municipio: "22",
        direccion_distrito: "01",
        direccion_complemento: "San Salvador",
        donor_pais: null,
        gift_type: "DIEZMO",
        wompi_id_enlace: 987654,
        wompi_url_enlace: "https://s.wompi.sv/987654",
        wompi_url_enlace_largo: null,
        document_id: "doc_paid",
        client_ip: "203.0.113.9",
        created_at: "2026-07-05T12:00:00.000Z",
        updated_at: "2026-07-05T12:05:00.000Z",
        expires_at: "2026-07-05T13:00:00.000Z"
      }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/donations/intents", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      intents: Array<Record<string, unknown> & { id: string; status: string; numero_control: string | null; document_donor_name: string | null; gift_type: string | null }>;
    };
    // Newest first: the COMPLETED intent (12:00) precedes the PENDING one (10:00).
    expect(body.intents.map((intent) => intent.id)).toEqual(["di_done", "di_pending"]);
    expect(body.intents[0].numero_control).toBe("DTE-15-M001P004-000000000000042");
    // The COMPLETED intent's donante comes from the joined document; the PENDING one has none.
    expect(body.intents[0].document_donor_name).toBe("Beto del Webhook");
    expect(body.intents[1].numero_control).toBeNull();
    expect(body.intents[1].document_donor_name).toBeNull();
    // The admin listing carries gift_type so the panel can render the Tipo column.
    expect(body.intents[0].gift_type).toBe("DIEZMO");
    expect(body.intents[1].gift_type).toBeNull();
    // Least privilege: the listing must not carry donor PII, the client IP, or the
    // payment-link metadata that donation_intents.* used to leak.
    for (const intent of body.intents) {
      expect(intent).not.toHaveProperty("donor_document");
      expect(intent).not.toHaveProperty("donor_document_type");
      expect(intent).not.toHaveProperty("donor_email");
      expect(intent).not.toHaveProperty("donor_name");
      expect(intent).not.toHaveProperty("donor_phone");
      expect(intent).not.toHaveProperty("direccion_complemento");
      expect(intent).not.toHaveProperty("client_ip");
      expect(intent).not.toHaveProperty("wompi_url_enlace");
      expect(intent).not.toHaveProperty("wompi_url_enlace_largo");
    }
  });
});

describe("document detail donor-data-verified flag", () => {
  it("marks the document as donor-data-verified when a COMPLETED intent references it", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(testDocument({ id: "doc_paid" }));
    db.donationIntents.push({
      id: "di_done",
      status: "COMPLETED",
      amount_cents: 2550,
      donor_name: "Beto Completo",
      donor_document_type: "13",
      donor_document: "000000000",
      donor_email: "beto@example.org",
      donor_phone: null,
      direccion_departamento: "06",
      direccion_municipio: "22",
      direccion_distrito: "01",
      direccion_complemento: "San Salvador",
      wompi_id_enlace: 987654,
      wompi_url_enlace: null,
      wompi_url_enlace_largo: null,
      document_id: "doc_paid",
      client_ip: "203.0.113.9",
      datos_token_hash: null,
      paid_at: null,
      created_at: "2026-07-05T12:00:00.000Z",
      updated_at: "2026-07-05T12:05:00.000Z",
      expires_at: "2026-07-05T13:00:00.000Z"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_paid", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ donorDataVerified: true });
  });

  it("does not set the flag for a document with no completed intent", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(testDocument({ id: "doc_plain" }));

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_plain", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ donorDataVerified: false });
  });
});

describe("user administration", () => {
  it("stores newly created passwords in the versioned format that carries the iteration count", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/users", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ email: "fresh@example.org", name: "Fresh", role: "ADMIN", password: "Fresh#Pass2026" })
      }),
      env(db)
    );

    expect(response.status).toBe(201);
    const created = db.users.find((row) => row.email === "fresh@example.org");
    expect(String(created?.password_hash)).toMatch(/^pbkdf2\$100000\$[0-9a-f]{64}$/);
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
    expect(String(db.users[0].password_hash)).toMatch(/^pbkdf2\$100000\$[0-9a-f]{64}$/);
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

    expect(response.status).toBe(500);
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
      pdf_renderer_version: "cde-pdf:v3",
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

  it("attaches the signed JWS artifact when the document has a signed JWS", async () => {
    const db = new InMemoryD1();
    const sentMessages: unknown[] = [];
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    const signedJws = "eyJhbGciOiJSUzUxMiJ9.eyJyZWNlcHRvciI6e319fQ.signature";
    db.documents.push({
      ...testDocument(),
      signed_jws: signedJws
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
    // The legally meaningful artifact is the signed JWS, not the unsigned plain_json.
    expect(new TextDecoder().decode(jsonAttachment?.content as Uint8Array)).toBe(signedJws);
    // The recorded JSON evidence hash covers the signed artifact actually sent.
    expect(db.emailDeliveries).toContainEqual(
      expect.objectContaining({
        document_id: "doc_1",
        dte_json_sha256: await sha256Hex(new TextEncoder().encode(signedJws))
      })
    );
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

  it("rejects a production DTE retry from staging before queueing or auditing", async () => {
    const db = new InMemoryD1();
    const send = vi.fn();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument({
      status: "FAILED",
      environment: "01",
      signed_jws: null,
      sello_recibido: null,
      accepted_at: null
    }));

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/retry", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { APP_ENV: "staging", ISSUANCE_QUEUE: { send } as unknown as Queue })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "environment_not_allowed" });
    expect(send).not.toHaveBeenCalled();
    expect(db.audits).toHaveLength(0);
  });

  it("rebuilds a rejected Wompi CDE from the original webhook before retransmitting", async () => {
    const certPassword = "correct horse battery staple";
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    // Real payment-link payload shape: no DocumentoIdentidad, no Direccion.
    db.wompiEvents.push({
      id: "wompi_evt_reject",
      transaction_id: "TX-REJECTED-1",
      environment: "00",
      result: "ExitosaAprobada",
      amount_cents: 100,
      donor_email: "legacy-contact-2@example.com",
      donor_name: "Example Person",
      raw_body: JSON.stringify({
        IdTransaccion: "TX-REJECTED-1",
        ResultadoTransaccion: "ExitosaAprobada",
        Monto: "1.00",
        FechaTransaccion: "2026-07-05T10:15:19.089-06:00",
        EsProductiva: false,
        Cliente: { Nombre: "Example Person", EMail: "legacy-contact-2@example.com" }
      }),
      processed_at: "2026-07-05T16:33:40.000Z",
      created_document_id: "doc_1",
      received_at: "2026-07-05T16:33:20.000Z"
    });
    db.documents.push({
      ...testDocument(),
      status: "REJECTED",
      wompi_event_id: "wompi_evt_reject",
      signed_jws: "stale-signed-jws",
      sello_recibido: null,
      accepted_at: null,
      mh_estado: "HTTP_400"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/retry", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, {
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        MH_CERT_XML: await generatedCertificateXml(certPassword),
        MH_CERT_PASSWORD: certPassword
      })
    );

    expect(response.status).toBe(200);
    const document = db.documents[0];
    // A rejection is MH's verdict on the CONTENT: the retry must rebuild the
    // document from the webhook (new codigoGeneracion, re-signed), never
    // retransmit the same signed JWS.
    expect(document.signed_jws).not.toBe("stale-signed-jws");
    expect(document.codigo_generacion).not.toBe("6CAE5F7E-A590-4573-8EF2-FE48B14796C4");
    expect(document.status).toBe("ACCEPTED");
    const receptor = (JSON.parse(String(document.plain_json)) as { receptor: Record<string, unknown> }).receptor;
    expect(receptor.tipoDocumento).toBe("37");
    expect(receptor.direccion).toMatchObject({ complemento: "No proporcionada por el donante" });
  });
});

describe("contingency history (read-only)", () => {
  // La emisión en contingencia del CDE se eliminó: el Anexo de validaciones del
  // evento de contingencia (campo 35) no admite el tipo 15. Los periodos históricos
  // siguen visibles en solo lectura; las rutas de apertura/barrido ya no existen.
  it("no longer exposes the contingency open/sweep routes", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const open = await worker.fetch(
      new Request("https://example.org/api/contingency/open", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ environment: "00", tipoContingencia: 2, reason: "MH TEST no disponible" })
      }),
      env(db)
    );
    expect(open.status).toBe(404);
    expect(db.contingencies).toHaveLength(0);

    const sweep = await worker.fetch(
      new Request("https://example.org/api/contingency/sweep", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(sweep.status).toBe(404);
  });

  it("still serves historical contingency state for the read-only view", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.contingencies.push({
      id: "cont_hist_1",
      environment: "00",
      status: "CLOSED",
      reason: "MH TEST no disponible (histórico)",
      tipo_contingencia: 2,
      started_at: "2026-06-20T01:00:00.000Z",
      ended_at: "2026-06-20T04:00:00.000Z",
      event_id: null,
      event_sello: null,
      transmit_deadline_at: null,
      created_at: "2026-06-20T01:00:00.000Z"
    });
    db.documents.push({
      ...testDocument(),
      id: "doc_contingency",
      status: "CONTINGENCY_PENDING",
      sello_recibido: null,
      mh_estado: "CONTINGENCY_PENDING",
      accepted_at: null,
      contingency_period_id: "cont_hist_1"
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
        active: null,
        pendingDocuments: [
          {
            id: "doc_contingency",
            status: "CONTINGENCY_PENDING"
          }
        ],
        periods: [
          {
            id: "cont_hist_1",
            status: "CLOSED"
          }
        ],
        summary: {
          pending: 1,
          open: 0,
          closed: 1
        }
      }
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

  it("rejects production invalidation from staging before signing or transmission", async () => {
    const db = new InMemoryD1();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    db.documents.push(testDocument({ environment: "01" }));

    const response = await worker.fetch(
      new Request("https://example.org/api/documents/doc_1/invalidate", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ tipoAnulacion: 2, motivoAnulacion: "No debe transmitirse" })
      }),
      env(db, { APP_ENV: "staging", MOCK_EXTERNAL_SERVICES: "false" })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "environment_not_allowed" });
    expect(db.dteEvents).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.audits).toHaveLength(0);
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
      pdf_renderer_version: "cde-pdf:v3",
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

  it("neutralizes spreadsheet formulas in donor-controlled CSV fields", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.documents.push(
      testDocument({
        plain_json: JSON.stringify({
          emisor: { nombre: "ExamplePerson1" },
          receptor: {
            nombre: '=HYPERLINK("https://evil.example",A1)',
            correo: "donor@example.org",
            tipoDocumento: "13",
            numDocumento: "@PAYLOAD"
          },
          resumen: { valorTotal: 100 },
          identificacion: { fecEmi: "2026-06-26", horEmi: "19:50:00" }
        })
      })
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/f960.csv?startDate=2026-06-01&endDate=2026-06-30", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    // The =HYPERLINK name gets a leading apostrophe (then quoted for the embedded "),
    // the @PAYLOAD document gets one too; benign numeric/hex fields stay bare.
    await expect(response.text()).resolves.toBe(
      `1;;"'=HYPERLINK(""https://evil.example"",A1)";9300;4;20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGQE;6CAE5F7EA59045738EF2FE48B14796C4;100.00;'@PAYLOAD;062026\r\n`
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

describe("CRM contacts export", () => {
  function seedWompiDonor(
    db: InMemoryD1,
    document: Partial<DteDocumentRecord>,
    intent?: Record<string, unknown>
  ): void {
    const doc = testDocument({ wompi_event_id: `wompi_${document.id}`, ...document });
    db.documents.push(doc);
    if (intent) {
      db.donationIntents.push({
        id: `intent_${doc.id}`,
        status: "COMPLETED",
        document_id: doc.id,
        created_at: doc.issued_at,
        donor_phone: null,
        direccion_complemento: null,
        direccion_departamento: null,
        donor_pais: null,
        gift_type: null,
        ...intent
      });
    }
  }

  it("returns a BOM-prefixed CSV of unique Wompi-lane donors for the requested ambiente", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedWompiDonor(
      db,
      {
        id: "doc_ana",
        environment: "01",
        donor_email: "ana@example.org",
        donor_name: "Ana",
        amount_cents: 5000,
        issued_at: "2026-02-01T18:00:00.000Z"
      },
      {
        donor_phone: "70000001",
        direccion_complemento: "Calle Nueva",
        direccion_departamento: "06",
        gift_type: "DIEZMO"
      }
    );
    // Excluded: production filter (this doc is ambiente 00).
    seedWompiDonor(db, {
      id: "doc_other_env",
      environment: "00",
      donor_email: "test@example.org",
      donor_name: "Test",
      issued_at: "2026-02-02T18:00:00.000Z"
    });
    // Excluded: not a Wompi-lane document (no wompi_event_id).
    seedWompiDonor(db, {
      id: "doc_manual",
      environment: "01",
      wompi_event_id: null,
      donor_email: "manual@example.org",
      donor_name: "Manual",
      issued_at: "2026-02-03T18:00:00.000Z"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="contactos-donantes-01-1.csv"');
    // Response.text() strips a leading BOM per spec, so assert the BOM on raw bytes.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
    const rows = csv.split("\r\n");
    expect(rows[0]).toBe("nombre,correo,telefono,direccion,departamento,pais,primera_donacion,ultima_donacion,total_donado_usd,numero_donaciones,tipo_preferido");
    expect(rows[1]).toBe("Ana,ana@example.org,70000001,Calle Nueva,San Salvador,El Salvador,2026-02-01,2026-02-01,50.00,1,Diezmo");
    // Only the single ambiente-01 Wompi-lane donor.
    expect(rows.filter((row) => row.length > 0)).toHaveLength(2);
  });

  it("records a CONTACTS_EXPORTED audit with the count and environment but no PII", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedWompiDonor(
      db,
      { id: "doc_ana", environment: "01", donor_email: "ana@example.org", donor_name: "Ana", issued_at: "2026-02-01T18:00:00.000Z" },
      { donor_phone: "70000001", gift_type: "DIEZMO" }
    );

    await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    const audit = db.audits.find((row) => row.action === "CONTACTS_EXPORTED");
    expect(audit).toBeDefined();
    expect(audit!.entity_type).toBe("export");
    expect(JSON.parse(String(audit!.metadata_json))).toEqual({ environment: "01", contacts: 1 });
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("ana@example.org");
    expect(serialized).not.toContain("70000001");
    expect(serialized).not.toContain("Ana");
  });

  it("rejects a missing or invalid environment", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/contacts", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_export_environment" });
  });

  it("requires an admin role (viewer and operator are rejected)", async () => {
    for (const role of ["VIEWER", "OPERATOR"]) {
      const db = new InMemoryD1();
      db.sessionUser = { id: "user_x", email: "x@example.org", name: "X", role };

      const response = await worker.fetch(
        new Request("https://example.org/api/exports/contacts?environment=01", {
          headers: { Authorization: "Bearer test-token" }
        }),
        env(db)
      );

      expect(response.status).toBe(403);
    }
  });

  it("restricts the export to a from/to date window (El Salvador local, inclusive)", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    // Before the window (2024) and inside the window (2025-06).
    seedWompiDonor(
      db,
      { id: "doc_old", environment: "01", donor_email: "ana@example.org", donor_name: "Ana", amount_cents: 1000, issued_at: "2024-06-01T18:00:00.000Z" },
      { gift_type: "DIEZMO" }
    );
    seedWompiDonor(
      db,
      { id: "doc_in", environment: "01", donor_email: "ana@example.org", donor_name: "Ana", amount_cents: 5000, issued_at: "2025-06-01T18:00:00.000Z" },
      { gift_type: "DIEZMO" }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&from=2025-01-01&to=2025-12-31", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const csv = new TextDecoder("utf-8").decode(new Uint8Array(await response.arrayBuffer())).replace(/^﻿/, "");
    const rows = csv.split("\r\n").filter((row) => row.length > 0);
    // Header + one donor; the 2025 donation is the only one counted (total 50.00).
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("50.00");
    expect(rows[1]).not.toContain("60.00");
  });

  it("filters counted donations by giftType and drops donors with none", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedWompiDonor(
      db,
      { id: "doc_diez", environment: "01", donor_email: "ana@example.org", donor_name: "Ana", amount_cents: 3000, issued_at: "2026-02-01T18:00:00.000Z" },
      { gift_type: "DIEZMO" }
    );
    seedWompiDonor(
      db,
      { id: "doc_ofr", environment: "01", donor_email: "beto@example.org", donor_name: "Beto", amount_cents: 4000, issued_at: "2026-02-02T18:00:00.000Z" },
      { gift_type: "OFRENDA" }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&giftType=DIEZMO", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const csv = new TextDecoder("utf-8").decode(new Uint8Array(await response.arrayBuffer())).replace(/^﻿/, "");
    const rows = csv.split("\r\n").filter((row) => row.length > 0);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain("Ana");
    expect(csv).not.toContain("Beto");
  });

  it("emits only the requested columns and rejects an unknown column name with 400 Spanish", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedWompiDonor(
      db,
      { id: "doc_ana", environment: "01", donor_email: "ana@example.org", donor_name: "Ana", amount_cents: 5000, issued_at: "2026-02-01T18:00:00.000Z" },
      { donor_phone: "70000001", gift_type: "DIEZMO" }
    );

    const ok = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&columns=nombre,correo", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(ok.status).toBe(200);
    const csv = new TextDecoder("utf-8").decode(new Uint8Array(await ok.arrayBuffer())).replace(/^﻿/, "");
    expect(csv.split("\r\n")[0]).toBe("nombre,correo");

    const bad = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&columns=nombre,inventada", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(bad.status).toBe(400);
    const body = (await bad.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_export_columns");
    expect(body.message).toContain("inventada");
  });

  it("rejects a malformed or inverted date range with 400", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };

    const inverted = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&from=2025-12-31&to=2025-01-01", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(inverted.status).toBe(400);
    await expect(inverted.json()).resolves.toMatchObject({ error: "invalid_export_range" });

    const malformed = await worker.fetch(
      new Request("https://example.org/api/exports/contacts?environment=01&from=2025-1-1&to=2025-12-31", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(malformed.status).toBe(400);
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
    // Search metadata present even without a query: full-year match set, not truncated.
    expect(body).toMatchObject({ matchCount: 2, truncated: false });
  });

  it("filters the preview donors by q while keeping the full-year summary", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);

    // "ana" (no accent) matches the "Ana" donor via deaccented, case-insensitive compare.
    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual?year=2025&q=ana", { headers: { Authorization: "Bearer test-token" } }),
      env(db, { EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      donorCount: number;
      withEmail: number;
      matchCount: number;
      truncated: boolean;
      donors: Array<{ donorName: string }>;
    };
    // Summary spans the whole year regardless of the filter.
    expect(body.donorCount).toBe(2);
    expect(body.withEmail).toBe(1);
    // Only the matching donor is listed.
    expect(body.matchCount).toBe(1);
    expect(body.truncated).toBe(false);
    expect(body.donors.map((donor) => donor.donorName)).toEqual(["Ana"]);
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

  it("attaches a complete dossier: summary page plus every accepted DTE", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);
    const sent: Array<{ attachments?: Array<{ content: Uint8Array }> }> = [];

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
            sent.push(message as { attachments?: Array<{ content: Uint8Array }> });
            return { messageId: "cf-cert" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    const pdfBytes = sent[0]?.attachments?.[0]?.content;
    expect(pdfBytes).toBeDefined();
    // Ana has 2 accepted donations → 1 summary page + 2 DTE pages.
    const dir = mkdtempSync(join(tmpdir(), "diezmos-dossier-send-"));
    const pdfPath = join(dir, "dossier.pdf");
    writeFileSync(pdfPath, pdfBytes!);
    const info = execFileSync("pdfinfo", [pdfPath], { encoding: "utf8" });
    expect(Number(info.match(/Pages:\s+(\d+)/)?.[1] ?? 0)).toBe(3);
  });

  it("sends only the named donor when the request body identifies one, ignoring the sent-dedupe", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);
    // A prior send would normally dedupe Ana away — an explicit single send must resend.
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
    const sent: Array<{ to: string }> = [];

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ donor: "ana@example.org" })
      }),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "legacy-contact-6@example.com",
        EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
        EMAIL: {
          send: async (message: unknown) => {
            sent.push(message as { to: string });
            return { messageId: "cf-cert" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ year: 2025, sent: 1, skipped: 0, failed: 0 });
    expect(sent.map((message) => message.to)).toEqual(["ana@example.org"]);
    // Audited as a single send.
    expect(db.audits).toContainEqual(
      expect.objectContaining({
        action: "DONOR_CERTIFICATE_SENT",
        entity_id: "2025:ana@example.org",
        metadata_json: expect.stringContaining("\"mode\":\"single\"")
      })
    );
  });

  it("returns 404 with a Spanish message when the named donor is not in the year's aggregation", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ donor: "nadie@example.org" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false", EMAIL_FROM: "legacy-contact-6@example.com", EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { message: string };
    expect(body.message).toMatch(/no (se encontró|tiene)/i);
  });

  it("returns 400 with a Spanish message when the named donor has no email", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    seedYear(db);

    const response = await worker.fetch(
      new Request("https://example.org/api/certificates/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ donor: "Sin Correo" })
      }),
      env(db, { MOCK_EXTERNAL_SERVICES: "false", EMAIL_FROM: "legacy-contact-6@example.com", EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) })
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { message: string };
    expect(body.message).toMatch(/correo/i);
  });
});

describe("advanced CDE generation", () => {
  it.each([
    ["production", "/api/test/dte"],
    ["production", "/api/test/dte/advanced-template"],
    ["production", "/api/test/dte/advanced"],
    ["preview", "/api/test/dte"],
    ["preview", "/api/test/dte/advanced-template"],
    ["preview", "/api/test/dte/advanced"]
  ])("blocks direct generation in %s at %s before creating or queueing a DTE", async (appEnv, path) => {
    const db = new InMemoryD1();
    const send = vi.fn();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };

    const response = await worker.fetch(
      new Request(`https://example.org${path}`, {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: "{}"
      }),
      env(db, { APP_ENV: appEnv, ISSUANCE_QUEUE: { send } as unknown as Queue })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "test_generation_disabled_in_production" });
    expect(db.documents).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(db.audits).toHaveLength(0);
  });

  it("locks emission settings to the deployment's allowed ambiente", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const request = (method: "GET" | "PUT", environment?: "00" | "01") =>
      new Request("https://example.org/api/settings/emission-environment", {
        method,
        headers: { Authorization: "Bearer test-token", ...(environment ? { "Content-Type": "application/json" } : {}) },
        body: environment ? JSON.stringify({ environment }) : undefined
      });

    const state = await worker.fetch(request("GET"), env(db, { APP_ENV: "staging" }));
    const stagingRejected = await worker.fetch(request("PUT", "01"), env(db, { APP_ENV: "staging" }));
    const productionRejected = await worker.fetch(request("PUT", "00"), env(db, { APP_ENV: "production" }));

    expect(state.status).toBe(200);
    await expect(state.json()).resolves.toEqual({
      emissionEnvironment: {
        environment: "00",
        source: "deployment_default",
        appEnv: "staging",
        locked: true,
        allowedEnvironments: ["00"]
      }
    });
    expect(stagingRejected.status).toBe(409);
    expect(productionRejected.status).toBe(409);
    expect(db.settings.find((row) => row.key === "emission_environment")).toBeUndefined();
    expect(db.audits.find((row) => row.action === "EMISSION_ENVIRONMENT_UPDATED")).toBeUndefined();
  });

  it("creates a staging quick DTE in 00 despite a stale incompatible setting", async () => {
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
      env(db, { APP_ENV: "staging" })
    );

    expect(settingsResponse.status).toBe(409);
    db.settings.push({ key: "emission_environment", value: "01", updated_by: "legacy", updated_at: "2026-07-01T00:00:00.000Z" });

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
    expect(generated.identificacion).toMatchObject({ ambiente: "00", tipoDte: "15" });
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

  it("stores but quarantines a signed webhook whose ambiente is incompatible with the deployment", async () => {
    const db = new InMemoryD1();
    // Owner has the app set to PRODUCTION emission, but a TEST-mode payment arrives.
    db.settings.push({ key: "emission_environment", value: "01" });
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_env_tx_mismatch",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, {
        APP_ENV: "production",
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.clone().json()).resolves.toMatchObject({ queued: false });
    expect(db.wompiEvents[0]).toMatchObject({ transaction_id: "wompi_env_tx_mismatch", environment: "00" });
    const mismatch = db.audits.find((row) => row.action === "WOMPI_ENVIRONMENT_MISMATCH");
    expect(mismatch).toMatchObject({ entity_type: "wompi_event", entity_id: db.wompiEvents[0].id });
    const metadata = JSON.parse(String(mismatch!.metadata_json)) as { payloadEnvironment: string; activeEnvironment: string };
    expect(metadata).toMatchObject({ payloadEnvironment: "00", activeEnvironment: "01" });
    expect(queued).toEqual([]);
  });

  it("rejects a manually injected incompatible Wompi queue event before any issuance side effect", async () => {
    const db = new InMemoryD1();
    db.wompiEvents.push({
      id: "wompi_injected_prod",
      transaction_id: "wompi_injected_prod_tx",
      environment: "01",
      result: "ExitosaAprobada",
      amount_cents: 2500,
      donor_email: null,
      donor_name: null,
      raw_body: JSON.stringify({
        IdCuenta: "acct_1",
        FechaTransaccion: "2026-07-09T12:00:00-06:00",
        Monto: "25.00",
        IdTransaccion: "wompi_injected_prod_tx",
        ResultadoTransaccion: "ExitosaAprobada",
        EsProductiva: true
      }),
      headers_json: "{}",
      received_at: "2026-07-09T18:00:00.000Z",
      processed_at: null,
      created_document_id: null
    });

    const error = await new IssuancePipeline(env(db, { APP_ENV: "staging" }))
      .processWompiEvent("wompi_injected_prod")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EnvironmentNotAllowedError);
    expect(db.documents).toHaveLength(0);
    expect(db.nextSequence).toBe(1);
    expect(db.wompiEvents[0].processed_at).toBeNull();
  });

  it("does not audit a mismatch when the signed payload agrees with the active emission setting", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "emission_environment", value: "00" });
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_env_tx_agree",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(response.status).toBe(202);
    expect(db.wompiEvents[0]).toMatchObject({ environment: "00" });
    expect(db.audits.find((row) => row.action === "WOMPI_ENVIRONMENT_MISMATCH")).toBeUndefined();
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

  it("does not mark paid_at from an IdExterno-only app identifier", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_paidmark",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: null
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_paid_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_paidmark"
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(response.status).toBe(202);
    expect(db.donationIntents.find((row) => row.id === "di_paidmark")?.paid_at ?? null).toBeNull();
    expect(db.donationIntents.find((row) => row.id === "di_paidmark")?.status).toBe("LINK_CREATED");
  });

  it("marks paid_at only from an exact canonical commerce id and numeric link id", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_enlacepaid",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      wompi_id_enlace: 987654,
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: null
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_enlace_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      enlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_enlacepaid" }
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(response.status).toBe(202);
    expect(db.donationIntents.find((row) => row.id === "di_enlacepaid")?.paid_at).toBeTruthy();
  });

  it("does not mark paid_at when the canonical commerce id lacks the numeric link id", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_missing_link",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      wompi_id_enlace: 987654,
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: null
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_missing_link_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      enlacePago: { IdentificadorEnlaceComercio: "di_missing_link" }
    });

    await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(db.donationIntents[0].paid_at ?? null).toBeNull();
  });

  it("does not change paid_at on a replayed webhook for an already-paid intent", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_replay",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      wompi_id_enlace: 987654,
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: "2026-07-04T12:30:00.000Z"
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_replay_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_replay",
      EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_replay" }
    });

    await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    // markIntentPaid is idempotent (WHERE paid_at IS NULL): the first stamp stands.
    expect(db.donationIntents.find((row) => row.id === "di_replay")?.paid_at).toBe("2026-07-04T12:30:00.000Z");
  });

  it("leaves non-intent (legacy static-link) webhooks unaffected — no intent, no error", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_legacy_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      enlacePago: { IdentificadorEnlaceComercio: "DONACION-123" }
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, {
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    // Still processed and queued; nothing to mark paid, no crash.
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ inserted: true, queued: true });
    expect(db.donationIntents).toHaveLength(0);
  });

  it("never lets a paid-marker failure (unknown di_ intent) break webhook processing", async () => {
    const db = new InMemoryD1();
    const queued: unknown[] = [];
    const secret = "wompi-secret";
    // A di_ id that has no matching intent row — the marker must no-op, not 500.
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_orphan_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_does_not_exist"
    });

    const response = await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, {
        WOMPI_API_SECRET: secret,
        ISSUANCE_QUEUE: { send: async (message: unknown) => queued.push(message) } as unknown as Queue
      })
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ inserted: true });
    expect(db.wompiEvents).toHaveLength(1);
  });

  it("does not mark paid_at for a declined di_ webhook", async () => {
    const db = new InMemoryD1();
    const secret = "wompi-secret";
    db.donationIntents.push({
      id: "di_declined",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_document: "10000001-9",
      expires_at: "2026-07-04T13:00:00.000Z",
      created_at: "2026-07-04T12:00:00.000Z",
      paid_at: null
    });
    const rawBody = JSON.stringify({
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-27T10:00:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_declined_tx_1",
      ResultadoTransaccion: "Rechazada",
      EsProductiva: false,
      IdExterno: "di_declined"
    });

    await worker.fetch(
      new Request("https://example.org/webhooks/wompi", {
        method: "POST",
        headers: { "Content-Type": "application/json", wompi_hash: await signWompiBody(rawBody, secret) },
        body: rawBody
      }),
      env(db, { WOMPI_API_SECRET: secret })
    );

    expect(db.donationIntents.find((row) => row.id === "di_declined")?.paid_at ?? null).toBeNull();
  });
});

describe("donation intent correlation", () => {
  const INTENT_ADDRESS = {
    departamento: "05",
    municipio: "24",
    distrito: "01",
    complemento: "Calle Donante 123, Antiguo Cuscatlán"
  };

  function seedIntentRow(db: InMemoryD1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const intent = {
      id: "di_corr_1",
      status: "LINK_CREATED",
      amount_cents: 2500,
      // Name/email are no longer captured on the form; the intent stores null and the
      // correlated CDE lifts nombre/correo from the webhook.
      donor_name: null,
      donor_document_type: "13",
      donor_document: "10000002-7",
      donor_email: null,
      donor_phone: "70001111",
      direccion_departamento: INTENT_ADDRESS.departamento,
      direccion_municipio: INTENT_ADDRESS.municipio,
      direccion_distrito: INTENT_ADDRESS.distrito,
      direccion_complemento: INTENT_ADDRESS.complemento,
      donor_pais: null,
      wompi_id_enlace: 987654,
      wompi_url_enlace: "https://s.wompi.sv/987654",
      wompi_url_enlace_largo: "https://pagos.wompi.sv/x",
      document_id: null,
      client_ip: "203.0.113.9",
      datos_token_hash: null,
      paid_at: null,
      created_at: "2026-06-26T01:00:00.000Z",
      updated_at: "2026-06-26T01:00:00.000Z",
      expires_at: "2026-06-26T02:00:00.000Z",
      ...overrides
    };
    db.donationIntents.push(intent);
    return intent;
  }

  function seedWompiEvent(db: InMemoryD1, webhook: Record<string, unknown>, id = "wompi_corr_evt"): string {
    db.wompiEvents.push({
      id,
      transaction_id: String(webhook.IdTransaccion),
      environment: "00",
      result: String(webhook.ResultadoTransaccion),
      amount_cents: 2500,
      donor_email: null,
      donor_name: null,
      raw_body: JSON.stringify(webhook),
      headers_json: "{}",
      received_at: "2026-06-26T01:46:47.015Z",
      processed_at: null,
      created_document_id: null
    });
    return id;
  }

  function correlationWebhook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-26T01:40:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_corr_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_corr_1",
      EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_corr_1" },
      // Fallback donor data that MUST be overridden by the intent when correlated.
      // Non-DUI document so the uncorrelated fallback CDE still validates.
      cliente: {
        DocumentoIdentidad: "P-A123456",
        Nombre: "Fallback",
        Apellidos: "Cliente",
        EMail: "fallback@example.org",
        Celular: "70000003",
        CodigoPais: "SV"
      },
      ...overrides
    };
  }

  async function pipelineEnv(db: InMemoryD1): Promise<Env> {
    return env(db, {
      MOCK_EXTERNAL_SERVICES: "true",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      MH_CERT_XML: await generatedCertificateXml("cert-password"),
      MH_CERT_PASSWORD: "cert-password"
    });
  }

  it("correlates a LINK_CREATED intent: identity + address from the intent, nombre/correo from the webhook", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(record?.status).toBe("ACCEPTED");
    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // Merge: tipoDocumento/numDocumento/direccion from the intent (canonical DUI +
    // catalog-coded address), nombre/correo from the webhook (the donor typed them on
    // Wompi's sheet — the intent no longer carries them), telefono from the intent phone.
    expect(cde.receptor).toMatchObject({
      tipoDocumento: "13",
      numDocumento: "10000002-7",
      nombre: "Fallback Cliente",
      correo: "fallback@example.org",
      telefono: "70001111",
      direccion: INTENT_ADDRESS
    });
    // Natural-person flow unchanged: donor_name/donor_email track the emitted receptor,
    // which for a person is the webhook cardholder name and correo.
    expect(record?.donor_name).toBe("Fallback Cliente");
    expect(record?.donor_email).toBe("fallback@example.org");
    // The intent is closed and points at the CDE that fulfilled it.
    const intent = db.donationIntents.find((row) => row.id === "di_corr_1");
    expect(intent?.status).toBe("COMPLETED");
    expect(intent?.document_id).toBe(record!.id);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DONATION_INTENT_COMPLETED", entity_type: "donation_intent", entity_id: "di_corr_1" })
    );
  });

  it("keeps the payload-derived codPais/codDomiciliado for a domestic intent", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // No donor_pais on the intent → the existing payload-based behavior is untouched.
    expect(cde.receptor).toMatchObject({ codPais: "SV", codDomiciliado: 1 });
  });

  it("threads the intent gift type into the CDE apéndice on normal issuance (descripcion stays DONACIÓN)", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { gift_type: "DIEZMO" });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as {
      apendice: Array<Record<string, unknown>>;
      cuerpoDocumento: Array<Record<string, unknown>>;
    };
    expect(cde.apendice).toContainEqual({ campo: "TipoAportacion", etiqueta: "Tipo", valor: "Diezmo" });
    expect(cde.cuerpoDocumento[0].descripcion).toBe("DONACIÓN");
  });

  it("omits the TipoAportacion apéndice for an intent with no gift type", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db); // gift_type undefined → treated as null
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { apendice: Array<Record<string, unknown>> };
    expect(cde.apendice.find((entry) => entry.campo === "TipoAportacion")).toBeUndefined();
  });

  it("uses the intent razón social as the receptor nombre for a NIT intent", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, {
      donor_document_type: "36",
      donor_document: "0614-280390-112-1",
      donor_name: "Empresa Ejemplo, S.A. de C.V."
    });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(record?.status).toBe("ACCEPTED");
    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // The comprobante must carry the empresa's razón social, not the cardholder
    // name from the Wompi webhook. Correo still comes from the webhook.
    expect(cde.receptor).toMatchObject({
      tipoDocumento: "36",
      numDocumento: "0614-280390-112-1",
      nombre: "Empresa Ejemplo, S.A. de C.V.",
      correo: "fallback@example.org"
    });
    // Persisted metadata must match the signed document: donor_name is the razón social
    // (the emitted receptor nombre), NOT the Wompi cardholder name, and donor_email is
    // the emitted receptor correo.
    expect(record?.donor_name).toBe("Empresa Ejemplo, S.A. de C.V.");
    expect(record?.donor_email).toBe("fallback@example.org");
  });

  it("marks a foreign intent's receptor non-domiciled with the intent país and a null direccion", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, {
      direccion_departamento: "00",
      direccion_municipio: "00",
      direccion_distrito: "00",
      direccion_complemento: "742 Evergreen Terrace, Springfield",
      donor_pais: "US"
    });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(record?.status).toBe("ACCEPTED");
    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // MH rejects ANY direccion object for a non-domiciled receptor (00/00/00 AND a
    // valid SV geography both fail codigoMsg 096, verified live): direccion is null,
    // the país rides in codPais, and the foreign address stays on the intent record.
    expect(cde.receptor).toMatchObject({ codPais: "US", codDomiciliado: 2, direccion: null });
  });

  it("falls back to the webhook Celular when the intent has no phone", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { donor_phone: null });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // telefono = intent.donor_phone ?? webhook Celular; identity/address stay from the intent.
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", telefono: "70000003", direccion: INTENT_ADDRESS });
  });

  it("correlates an EXPIRED intent (donor paid in the link's last minute)", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { status: "EXPIRED" });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // numDocumento/direccion still come from the intent; nombre/correo from the webhook.
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", nombre: "Fallback Cliente", direccion: INTENT_ADDRESS });
    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.status).toBe("COMPLETED");
  });

  it("does not correlate a COMPLETED intent: falls back to the webhook donor data", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { status: "COMPLETED", document_id: "dte_prev" });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // Fallback receptor derived from the webhook, not the intent.
    expect(cde.receptor).toMatchObject({ nombre: "Fallback Cliente", correo: "fallback@example.org" });
    expect(cde.receptor.direccion).not.toEqual(INTENT_ADDRESS);
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DONATION_INTENT_COMPLETED" }));
    // The already-completed intent keeps its original document link.
    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.document_id).toBe("dte_prev");
  });

  it("audits an amount mismatch and uses the webhook amount, still correlating", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { amount_cents: 2500 });
    // Webhook amount ($30) differs from the intent amount ($25): money truth is Wompi.
    const eventId = seedWompiEvent(db, correlationWebhook({ Monto: "30.00" }));

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(record?.amount_cents).toBe(3000);
    const cde = JSON.parse(record!.plain_json) as { resumen: { valorTotal: number }; receptor: Record<string, unknown> };
    expect(cde.resumen.valorTotal).toBe(30);
    // Still correlated to the intent despite the mismatch: numDocumento/direccion prove it.
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", direccion: INTENT_ADDRESS });
    const mismatch = db.audits.find((row) => row.action === "DONATION_INTENT_AMOUNT_MISMATCH");
    expect(mismatch).toBeTruthy();
    expect(mismatch).toMatchObject({ entity_type: "donation_intent", entity_id: "di_corr_1" });
    const metadata = JSON.parse(String(mismatch!.metadata_json)) as { intentAmountCents: number; eventAmountCents: number };
    expect(metadata).toMatchObject({ intentAmountCents: 2500, eventAmountCents: 3000 });
  });

  it("leaves legacy payloads (no intent id) unchanged: fallback receptor, no intent lookup", async () => {
    const db = new InMemoryD1();
    // A static-link payload whose IdentificadorEnlaceComercio is not a "di_" intent id.
    const webhook = correlationWebhook({
      IdExterno: undefined,
      EnlacePago: undefined,
      enlacePago: { Id: 123, IdentificadorEnlaceComercio: "DONACION-legacy" }
    });
    const eventId = seedWompiEvent(db, webhook);

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    expect(cde.receptor).toMatchObject({ nombre: "Fallback Cliente", correo: "fallback@example.org" });
    expect(cde.receptor.direccion).not.toEqual(INTENT_ADDRESS);
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DONATION_INTENT_COMPLETED" }));
  });

  it("refuses to correlate when the webhook link id does not match the intent's minted link", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db); // wompi_id_enlace: 987654
    // A donor-influenced IdExterno points at di_corr_1, but the payment was made on a
    // DIFFERENT Wompi link than the one minted for that intent.
    const eventId = seedWompiEvent(
      db,
      correlationWebhook({ EnlacePago: { Id: 111111, IdentificadorEnlaceComercio: "di_corr_1" } })
    );

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    // No correlation: the CDE falls back to the webhook donor data, and the intent is
    // left uncompleted so no signed CDE/PII binds to an unrelated intent.
    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    expect(cde.receptor).toMatchObject({ nombre: "Fallback Cliente", correo: "fallback@example.org" });
    expect(cde.receptor.direccion).not.toEqual(INTENT_ADDRESS);
    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.status).toBe("LINK_CREATED");
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DONATION_INTENT_COMPLETED" }));
    const mismatch = db.audits.find((row) => row.action === "DONATION_INTENT_BINDING_REJECTED");
    expect(mismatch).toMatchObject({ entity_type: "wompi_event", entity_id: eventId });
    const metadata = JSON.parse(String(mismatch!.metadata_json)) as {
      payloadLinkId: number;
      expectedLinkId: number;
      reason: string;
    };
    expect(metadata).toMatchObject({ payloadLinkId: 111111, expectedLinkId: 987654, reason: "link_id_mismatch" });
  });

  it("correlates when the webhook link id matches the intent's minted link", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(
      db,
      correlationWebhook({ EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_corr_1" } })
    );

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", direccion: INTENT_ADDRESS });
    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.status).toBe("COMPLETED");
    expect(db.audits.find((row) => row.action === "DONATION_INTENT_BINDING_REJECTED")).toBeUndefined();
  });

  it("treats a draft intent whose donor document is missing as NON-correlating (webhook fallback CDE)", async () => {
    const db = new InMemoryD1();
    // A premint draft: link minted, but the donor never attached fiscal data, so the
    // document is still NULL. Correlating it would build a receptor with an empty
    // numDocumento that fails CDE schema validation — so the guard must skip it and
    // let the legacy/static-link webhook fallback build the CDE from webhook data.
    seedIntentRow(db, { donor_document: null, direccion_departamento: null, direccion_municipio: null, direccion_distrito: null, direccion_complemento: null });
    const eventId = seedWompiEvent(db, correlationWebhook());

    const record = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(record?.status).toBe("ACCEPTED");
    const cde = JSON.parse(record!.plain_json) as { receptor: Record<string, unknown> };
    // Receptor comes from the webhook, not the (incomplete) draft.
    expect(cde.receptor).toMatchObject({ nombre: "Fallback Cliente", correo: "fallback@example.org" });
    expect(cde.receptor.direccion).not.toEqual(INTENT_ADDRESS);
    // The draft is NOT completed by this webhook.
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DONATION_INTENT_COMPLETED" }));
    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.status).toBe("LINK_CREATED");
  });

  it("keeps the intent receptor when an operator rebuilds a REJECTED intent-backed CDE", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, correlationWebhook());
    // A REJECTED document already exists for this Wompi event (fallback receptor).
    db.documents.push({
      id: "dte_rejected",
      wompi_event_id: eventId,
      tipo_dte: "15",
      environment: "00",
      codigo_generacion: "11111111-1111-4111-8111-111111111111",
      numero_control: "DTE-15-M001P004-000000000000009",
      status: "REJECTED",
      plain_json: JSON.stringify({ receptor: { nombre: "Fallback Cliente" } }),
      signed_jws: null,
      sello_recibido: null,
      mh_estado: "RECHAZADO",
      mh_observaciones_json: "[]",
      donor_email: "fallback@example.org",
      donor_name: "Fallback Cliente",
      amount_cents: 2500,
      issued_at: "2026-06-26T01:46:47.015Z",
      accepted_at: null,
      contingency_period_id: null,
      transmission_deferred_at: null,
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });

    const record = db.documents.find((row) => row.id === "dte_rejected") as unknown as DteDocumentRecord;
    const result = await new IssuancePipeline(await pipelineEnv(db)).rebuildRejectedWompiDocument(record);

    expect(result.accepted).toBe(true);
    const rebuilt = db.documents.find((row) => row.id === "dte_rejected");
    const cde = JSON.parse(String(rebuilt!.plain_json)) as { receptor: Record<string, unknown> };
    // The rebuild must re-apply the intent's identity + address (not downgrade to the
    // emisor-geography fallback). nombre/correo come from the webhook either way, so
    // numDocumento/direccion are what prove the intent correlation survived the rebuild.
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", direccion: INTENT_ADDRESS });
    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.status).toBe("COMPLETED");
    expect(db.donationIntents.find((row) => row.id === "di_corr_1")?.document_id).toBe("dte_rejected");
  });

  it("threads the gift type into the CDE apéndice when a gift-type intent is rebuilt on the rejected path", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { gift_type: "OFRENDA" });
    const eventId = seedWompiEvent(db, correlationWebhook());
    db.documents.push({
      id: "dte_rejected_gift",
      wompi_event_id: eventId,
      tipo_dte: "15",
      environment: "00",
      codigo_generacion: "70000003-2222-4222-8222-700000032222",
      numero_control: "DTE-15-M001P004-000000000000019",
      status: "REJECTED",
      plain_json: JSON.stringify({ receptor: { nombre: "Fallback Cliente" } }),
      signed_jws: null,
      sello_recibido: null,
      mh_estado: "RECHAZADO",
      mh_observaciones_json: "[]",
      donor_email: "fallback@example.org",
      donor_name: "Fallback Cliente",
      amount_cents: 2500,
      issued_at: "2026-06-26T01:46:47.015Z",
      accepted_at: null,
      contingency_period_id: null,
      transmission_deferred_at: null,
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });

    const record = db.documents.find((row) => row.id === "dte_rejected_gift") as unknown as DteDocumentRecord;
    await new IssuancePipeline(await pipelineEnv(db)).rebuildRejectedWompiDocument(record);

    const rebuilt = db.documents.find((row) => row.id === "dte_rejected_gift");
    const cde = JSON.parse(String(rebuilt!.plain_json)) as {
      apendice: Array<Record<string, unknown>>;
      cuerpoDocumento: Array<Record<string, unknown>>;
    };
    expect(cde.apendice).toContainEqual({ campo: "TipoAportacion", etiqueta: "Tipo", valor: "Ofrenda" });
    expect(cde.cuerpoDocumento[0].descripcion).toBe("DONACIÓN");
  });

  function seedRejectedDoc(db: InMemoryD1, eventId: string, id: string): DteDocumentRecord {
    const doc = {
      id,
      wompi_event_id: eventId,
      tipo_dte: "15",
      environment: "00",
      codigo_generacion: `3333${id}-3333-4333-8333-333333333333`.slice(0, 36),
      numero_control: `DTE-15-M001P004-0000000000000${id.length}9`,
      status: "REJECTED",
      plain_json: JSON.stringify({ receptor: { nombre: "Fallback Cliente" } }),
      signed_jws: null,
      sello_recibido: null,
      mh_estado: "RECHAZADO",
      mh_observaciones_json: "[]",
      donor_email: "fallback@example.org",
      donor_name: "Fallback Cliente",
      amount_cents: 2500,
      issued_at: "2026-06-26T01:46:47.015Z",
      accepted_at: null,
      contingency_period_id: null,
      transmission_deferred_at: null,
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    };
    db.documents.push(doc as unknown as DteDocumentRecord);
    return doc as unknown as DteDocumentRecord;
  }

  it("refuses a concurrent rebuild of an already-claimed REJECTED CDE and transmits only one DTE", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, correlationWebhook());
    seedRejectedDoc(db, eventId, "dte_rejected_cas");
    // Both operator retries capture the same REJECTED snapshot before either claims it.
    const staleSnapshot = { ...db.documents.find((row) => row.id === "dte_rejected_cas") } as unknown as DteDocumentRecord;
    const pipeline = new IssuancePipeline(await pipelineEnv(db));

    const first = await pipeline.rebuildRejectedWompiDocument(staleSnapshot);
    expect(first.accepted).toBe(true);
    expect(db.documents.find((row) => row.id === "dte_rejected_cas")?.status).toBe("ACCEPTED");

    // The second retry runs on the stale REJECTED snapshot: the compare-and-swap finds the
    // row is no longer REJECTED and refuses, so no second legal DTE is written/transmitted.
    await expect(pipeline.rebuildRejectedWompiDocument(staleSnapshot)).rejects.toBeInstanceOf(RejectedWompiRetryConflictError);
    expect(db.audits.filter((row) => row.action === "DTE_ACCEPTED" && row.entity_id === "dte_rejected_cas")).toHaveLength(1);
    expect(db.audits.filter((row) => row.action === "DONATION_INTENT_COMPLETED")).toHaveLength(1);
  });

  it("leaves a REJECTED CDE retryable when the rebuild fails before it can be claimed", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, correlationWebhook());
    const record = seedRejectedDoc(db, eventId, "dte_rejected_signfail");
    // Signing throws (no MH_CERT_XML configured) BEFORE the claim UPDATE runs.
    const brokenEnv = env(db, { MOCK_EXTERNAL_SERVICES: "true", EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()) });

    await expect(new IssuancePipeline(brokenEnv).rebuildRejectedWompiDocument(record)).rejects.toThrow();

    // Not a claim conflict, and the row is untouched: still REJECTED, still carrying its
    // original MH verdict, so the operator can retry once the cause is fixed.
    const doc = db.documents.find((row) => row.id === "dte_rejected_signfail");
    expect(doc?.status).toBe("REJECTED");
    expect(doc?.mh_estado).toBe("RECHAZADO");
  });

  it("treats an invalid donor DUI as terminal: no control sequence, no document, audited", async () => {
    const db = new InMemoryD1();
    // A raw legacy webhook (no intent) whose DocumentoIdentidad looks like a DUI (9
    // digits) but fails the check digit. buildCdeDocument would declare it type 13 and
    // throw AFTER the control sequence is allocated, so a queue retry would burn a
    // control number on every attempt — the guard must reject it BEFORE allocation.
    const webhook = correlationWebhook({
      IdExterno: undefined,
      IdTransaccion: "wompi_bad_dui_tx",
      cliente: { DocumentoIdentidad: "12345678-9", Nombre: "Mal", Apellidos: "DUI", EMail: "mal@example.org", CodigoPais: "SV" }
    });
    const eventId = seedWompiEvent(db, webhook);

    const result = await new IssuancePipeline(await pipelineEnv(db)).processWompiEvent(eventId);

    expect(result).toBeNull();
    expect(db.documents).toHaveLength(0);
    // The sequence counter never advanced — no fiscal gap across queue retries.
    expect(db.nextSequence).toBe(1);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "WOMPI_INVALID_DONOR_DUI", entity_type: "wompi_event", entity_id: eventId })
    );
    expect(db.wompiEvents.find((event) => event.id === eventId)?.processed_at).toEqual(expect.any(String));
  });

  it("does not requeue an invalid-DUI Wompi event after terminal processing", async () => {
    const db = new InMemoryD1();
    const queued: IssuanceMessage[] = [];
    const webhook = correlationWebhook({
      IdExterno: undefined,
      IdTransaccion: "wompi_bad_dui_sweep_tx",
      cliente: { DocumentoIdentidad: "12345678-9", Nombre: "Mal", Apellidos: "DUI", EMail: "mal@example.org", CodigoPais: "SV" }
    });
    const eventId = seedWompiEvent(db, webhook);
    const pipeline = new IssuancePipeline({
      ...(await pipelineEnv(db)),
      ISSUANCE_QUEUE: { send: async (message: IssuanceMessage) => queued.push(message) } as unknown as Queue<IssuanceMessage>
    });

    await pipeline.processWompiEvent(eventId);
    await pipeline.sweepStalledWompiEvents();

    expect(queued).toHaveLength(0);
    expect(db.audits.some((audit) => audit.action === "WOMPI_EVENT_REQUEUED" && audit.entity_id === eventId)).toBe(false);
    expect(db.audits.some((audit) => audit.action === "WOMPI_EVENT_STALLED" && audit.entity_id === eventId)).toBe(false);
  });

});

// Normativa: el Anexo de validaciones del evento de contingencia (campo 35) solo
// admite los tipos de DTE 01, 03, 04, 05, 06, 07, 11, 14 y 18 — el CDE (tipo 15)
// está EXCLUIDO, así que un CDE nunca se emite en contingencia. Cuando MH no está
// disponible, la emisión queda diferida (status SIGNED + transmission_deferred_at —
// D1 no permite reconstruir tablas padre de FK para ampliar el CHECK de status):
// el donante recibe de inmediato
// el comprobante TRANSITORIO y el cron de 15 minutos reintenta la transmisión.
describe("deferred transmission when MH is unavailable", () => {
  const INTENT_ADDRESS = {
    departamento: "05",
    municipio: "24",
    distrito: "01",
    complemento: "Calle Donante 123, Antiguo Cuscatlán"
  };

  function seedIntentRow(db: InMemoryD1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const intent = {
      id: "di_defer_1",
      status: "LINK_CREATED",
      amount_cents: 2500,
      donor_name: null,
      donor_document_type: "13",
      donor_document: "10000002-7",
      donor_email: null,
      donor_phone: "70001111",
      direccion_departamento: INTENT_ADDRESS.departamento,
      direccion_municipio: INTENT_ADDRESS.municipio,
      direccion_distrito: INTENT_ADDRESS.distrito,
      direccion_complemento: INTENT_ADDRESS.complemento,
      donor_pais: null,
      wompi_id_enlace: 987654,
      wompi_url_enlace: "https://s.wompi.sv/987654",
      wompi_url_enlace_largo: "https://pagos.wompi.sv/x",
      document_id: null,
      client_ip: "203.0.113.9",
      created_at: "2026-06-26T01:00:00.000Z",
      updated_at: "2026-06-26T01:00:00.000Z",
      expires_at: "2026-06-26T02:00:00.000Z",
      ...overrides
    };
    db.donationIntents.push(intent);
    return intent;
  }

  function seedWompiEvent(db: InMemoryD1, webhook: Record<string, unknown>, id = "wompi_defer_evt"): string {
    db.wompiEvents.push({
      id,
      transaction_id: String(webhook.IdTransaccion),
      environment: "00",
      result: String(webhook.ResultadoTransaccion),
      amount_cents: 2500,
      donor_email: null,
      donor_name: null,
      raw_body: JSON.stringify(webhook),
      headers_json: "{}",
      received_at: "2026-06-26T01:46:47.015Z",
      processed_at: null,
      created_document_id: null
    });
    return id;
  }

  function deferWebhook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      IdCuenta: "acct_1",
      FechaTransaccion: "2026-06-26T01:40:00-06:00",
      Monto: "25.00",
      IdTransaccion: "wompi_defer_tx_1",
      ResultadoTransaccion: "ExitosaAprobada",
      EsProductiva: false,
      IdExterno: "di_defer_1",
      EnlacePago: { Id: 987654, IdentificadorEnlaceComercio: "di_defer_1" },
      cliente: {
        DocumentoIdentidad: "P-A123456",
        Nombre: "Fallback",
        Apellidos: "Cliente",
        EMail: "fallback@example.org",
        Celular: "70000003",
        CodigoPais: "SV"
      },
      ...overrides
    };
  }

  // URL-routing fetch stub: MH auth always succeeds; recepciondte behaves per test.
  function stubMhFetch(recepcion: () => Response): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/seguridad/auth")) {
        return jsonResponse({ status: "OK", body: { token: "Bearer test-token" }, tokenType: "Bearer" });
      }
      if (url.includes("recepciondte")) {
        return recepcion();
      }
      throw new Error(`Fetch inesperado en prueba de transmisión diferida: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  async function deferredEnv(db: InMemoryD1, sent: Array<{ subject: string; to: string; text: string }>): Promise<Env> {
    return env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMISOR_CONFIG_JSON: JSON.stringify(emisorConfig()),
      MH_CERT_XML: await generatedCertificateXml("cert-password"),
      MH_CERT_PASSWORD: "cert-password",
      MH_USER_TEST: "10000003520015",
      MH_PASSWORD_TEST: "test-password",
      MH_AUTH_URL_TEST: "https://apitest.dtes.mh.gob.sv/seguridad/auth",
      MH_RECEPCION_URL_TEST: "https://apitest.dtes.mh.gob.sv/fesv/recepciondte",
      EMAIL_FROM: "comprobantes@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          sent.push(message as { subject: string; to: string; text: string });
          return { messageId: `email-${sent.length}` };
        }
      } as SendEmail
    });
  }

  it("defers a Wompi CDE: SIGNED + deferred marker, normal shape, transitorio email, intent untouched", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db, { gift_type: "DIEZMO" });
    const eventId = seedWompiEvent(db, deferWebhook());
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    stubMhFetch(() => new Response("MH no disponible", { status: 503 }));

    const record = await new IssuancePipeline(await deferredEnv(db, sent)).processWompiEvent(eventId);

    // Deferred state = SIGNED + transmission_deferred_at (no new status value: D1
    // cannot rebuild dte_documents to widen its CHECK constraint).
    expect(record?.status).toBe("SIGNED");
    expect(record?.transmission_deferred_at).toBeTruthy();
    expect(record?.signed_jws).toBeTruthy();
    // NO contingency: no period row, no attachment — the CDE keeps its NORMAL shape.
    expect(db.contingencies).toHaveLength(0);
    expect(record?.contingency_period_id).toBeNull();
    const cde = JSON.parse(String(record!.plain_json)) as {
      identificacion: Record<string, unknown>;
      receptor: Record<string, unknown>;
      apendice: Array<Record<string, unknown>>;
      cuerpoDocumento: Array<Record<string, unknown>>;
    };
    expect(cde.identificacion.tipoModelo).toBe(1);
    // The intent override and gift type survive the deferral unchanged.
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", direccion: INTENT_ADDRESS });
    expect(cde.apendice).toContainEqual({ campo: "TipoAportacion", etiqueta: "Tipo", valor: "Diezmo" });
    expect(cde.cuerpoDocumento[0].descripcion).toBe("DONACIÓN");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DTE_TRANSMISSION_DEFERRED", entity_type: "dte_document", entity_id: record!.id })
    );
    // Immediate transitorio email with distinguishing evidence type.
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("(en trámite)");
    expect(sent[0].text).toContain("Sello de Recepción");
    // ...but never claims the deferred CDE already carries an MH reception seal.
    expect(sent[0].text).not.toContain("con sello de recepción del Ministerio de Hacienda");
    expect(db.emailDeliveries).toContainEqual(
      expect.objectContaining({
        document_id: record!.id,
        status: "SENT",
        email_type: "dteReceiptTransitorio",
        document_status_at_send: "SIGNED"
      })
    );
    // The intent completes only on REAL MH acceptance — never at deferral.
    expect(db.donationIntents.find((row) => row.id === "di_defer_1")?.status).toBe("LINK_CREATED");
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DONATION_INTENT_COMPLETED" }));
  });

  it("defers a quick/advanced queue CDE instead of marking it FAILED", async () => {
    const db = new InMemoryD1();
    db.documents.push(advancedFailingDocument("doc_quick_defer"));
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    stubMhFetch(() => new Response("MH no disponible", { status: 503 }));

    const record = await new IssuancePipeline(await deferredEnv(db, sent)).processDteDocument("doc_quick_defer");

    expect(record.status).toBe("SIGNED");
    expect(record.transmission_deferred_at).toBeTruthy();
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DTE_TRANSMISSION_DEFERRED", entity_id: "doc_quick_defer" })
    );
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "ADVANCED_CDE_FAILED" }));
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("(en trámite)");
  });

  it("does not resend the transitorio email when a queue redelivery re-defers the same document", async () => {
    const db = new InMemoryD1();
    db.documents.push({ ...advancedFailingDocument("doc_quick_dedupe"), status: "SIGNED", transmission_deferred_at: "2026-06-26T01:49:00.000Z", signed_jws: "already-signed-jws" });
    // The first delivery attempt already sent the transitorio before the crash/redelivery.
    db.emailDeliveries.push({
      id: "email_prev",
      document_id: "doc_quick_dedupe",
      to_email: "legacy-contact-2@example.com",
      status: "SENT",
      provider_response_json: "{}",
      sent_at: "2026-06-26T01:50:00.000Z",
      email_type: "dteReceiptTransitorio",
      document_status_at_send: "SIGNED",
      template_version: null,
      pdf_renderer_version: null,
      pdf_sha256: null,
      dte_json_sha256: null,
      provider_delivery_id: null
    });
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    stubMhFetch(() => new Response("MH no disponible", { status: 503 }));

    await new IssuancePipeline(await deferredEnv(db, sent)).processDteDocument("doc_quick_dedupe");

    expect(sent).toHaveLength(0);
    expect(db.emailDeliveries.filter((row) => row.document_id === "doc_quick_dedupe")).toHaveLength(1);
    expect(db.documents.find((row) => row.id === "doc_quick_dedupe")?.status).toBe("SIGNED");
    expect(db.documents.find((row) => row.id === "doc_quick_dedupe")?.transmission_deferred_at).toBeTruthy();
  });

  it("defers an operator rejected-doc rebuild when MH is unavailable", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, deferWebhook());
    db.documents.push({
      ...testDocument(),
      id: "doc_rejected_defer",
      wompi_event_id: eventId,
      status: "REJECTED",
      signed_jws: null,
      sello_recibido: null,
      mh_estado: "RECHAZADO",
      accepted_at: null
    });
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    stubMhFetch(() => new Response("MH no disponible", { status: 503 }));

    const record = db.documents.find((row) => row.id === "doc_rejected_defer") as unknown as DteDocumentRecord;
    const result = await new IssuancePipeline(await deferredEnv(db, sent)).rebuildRejectedWompiDocument(record);

    expect(result.accepted).toBe(false);
    const rebuilt = db.documents.find((row) => row.id === "doc_rejected_defer");
    expect(rebuilt?.status).toBe("SIGNED");
    expect(rebuilt?.transmission_deferred_at).toBeTruthy();
    const cde = JSON.parse(String(rebuilt!.plain_json)) as { identificacion: Record<string, unknown>; receptor: Record<string, unknown> };
    expect(cde.identificacion.tipoModelo).toBe(1);
    expect(cde.receptor).toMatchObject({ numDocumento: "10000002-7", direccion: INTENT_ADDRESS });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toContain("(en trámite)");
    expect(db.donationIntents.find((row) => row.id === "di_defer_1")?.status).not.toBe("COMPLETED");
  });

  it("retries a deferred CDE on the sweep: acceptance completes the intent and sends the definitive email", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, deferWebhook());
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    const pipelineEnv = await deferredEnv(db, sent);
    stubMhFetch(() => new Response("MH no disponible", { status: 503 }));
    const deferred = await new IssuancePipeline(pipelineEnv).processWompiEvent(eventId);
    expect(deferred?.status).toBe("SIGNED");
    expect(deferred?.transmission_deferred_at).toBeTruthy();
    expect(sent).toHaveLength(1);

    stubMhFetch(() => jsonResponse({ estado: "PROCESADO", selloRecibido: "SELLO-DEFINITIVO", observaciones: [] }));
    const result = await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();

    expect(result).toMatchObject({ transmitted: 1 });
    const doc = db.documents.find((row) => row.id === deferred!.id);
    expect(doc?.status).toBe("ACCEPTED");
    expect(doc?.sello_recibido).toBe("SELLO-DEFINITIVO");
    // The marker stays as historical "was deferred at" evidence; leaving SIGNED is
    // what removes the doc from the retry sweep.
    expect(doc?.transmission_deferred_at).toBeTruthy();
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DTE_ACCEPTED", entity_type: "dte_document", entity_id: deferred!.id })
    );
    // Definitive email: normal receipt copy, PDF now carries the real sello.
    expect(sent).toHaveLength(2);
    expect(sent[1].subject).not.toContain("(en trámite)");
    expect(db.emailDeliveries).toContainEqual(
      expect.objectContaining({
        document_id: deferred!.id,
        status: "SENT",
        email_type: "dteReceipt",
        document_status_at_send: "ACCEPTED"
      })
    );
    // REAL acceptance completes the correlated intent.
    expect(db.donationIntents.find((row) => row.id === "di_defer_1")?.status).toBe("COMPLETED");
    expect(db.donationIntents.find((row) => row.id === "di_defer_1")?.document_id).toBe(deferred!.id);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DONATION_INTENT_COMPLETED", entity_type: "donation_intent", entity_id: "di_defer_1" })
    );
  });

  it("keeps the CDE pending without email or audit spam while MH stays down, alerting once after an hour", async () => {
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, deferWebhook());
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    const pipelineEnv = await deferredEnv(db, sent);
    stubMhFetch(() => new Response("MH no disponible", { status: 503 }));
    const deferred = await new IssuancePipeline(pipelineEnv).processWompiEvent(eventId);
    expect(sent).toHaveLength(1); // transitorio
    // Age the DEFERRAL beyond the one-hour alert threshold (the alert is measured
    // from transmission_deferred_at, not from document creation).
    const doc = db.documents.find((row) => row.id === deferred!.id)!;
    doc.transmission_deferred_at = "2026-06-26T00:00:00.000Z";

    const first = await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();
    expect(first).toMatchObject({ transmitted: 0, pending: 1 });
    expect(db.documents.find((row) => row.id === deferred!.id)?.status).toBe("SIGNED");
    expect(db.documents.find((row) => row.id === deferred!.id)?.transmission_deferred_at).toBeTruthy();
    // One backlog alert (transitorio + alert = 2 sends), deduped on the next tick.
    expect(sent).toHaveLength(2);
    expect(db.audits.filter((row) => row.action === "ALERT_SENT:MH_UNAVAILABLE")).toHaveLength(1);

    await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();
    expect(sent).toHaveLength(2);
    expect(db.audits.filter((row) => row.action === "ALERT_SENT:MH_UNAVAILABLE")).toHaveLength(1);
    // No per-tick audit noise: the deferral audit stays singular, no accepted/rejected audits.
    expect(db.audits.filter((row) => row.action === "DTE_TRANSMISSION_DEFERRED")).toHaveLength(1);
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DTE_ACCEPTED" }));
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "DTE_REJECTED" }));
  });

  it("marks a deferred CDE REJECTED through the normal rejected path when MH rejects it on retry", async () => {
    const db = new InMemoryD1();
    seedIntentRow(db);
    const eventId = seedWompiEvent(db, deferWebhook());
    const sent: Array<{ subject: string; to: string; text: string }> = [];
    const pipelineEnv = await deferredEnv(db, sent);
    stubMhFetch(() => new Response("MH no disponible", { status: 503 }));
    const deferred = await new IssuancePipeline(pipelineEnv).processWompiEvent(eventId);

    stubMhFetch(() => jsonResponse({ estado: "RECHAZADO", observaciones: ["Firma inválida"] }));
    await new IssuancePipeline(pipelineEnv).retryDeferredTransmissions();

    const doc = db.documents.find((row) => row.id === deferred!.id);
    expect(doc?.status).toBe("REJECTED");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "DTE_REJECTED", entity_type: "dte_document", entity_id: deferred!.id })
    );
    // No definitive email on rejection; the intent stays open for the operator rebuild.
    expect(sent).toHaveLength(1);
    expect(db.donationIntents.find((row) => row.id === "di_defer_1")?.status).not.toBe("COMPLETED");
  });

  it("runs the deferred-transmission retry on the 15-minute cron tick", async () => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_sched_defer",
      wompi_event_id: null,
      status: "SIGNED",
      transmission_deferred_at: "2026-06-26T01:49:00.000Z",
      signed_jws: "signed-jws",
      sello_recibido: null,
      mh_estado: "MH_NO_DISPONIBLE",
      accepted_at: null,
      donor_email: null
    });

    // Mock mode: MH accepts without network. The cron must pick the pending doc up.
    await worker.scheduled({ cron: "*/15 * * * *", scheduledTime: Date.now() } as ScheduledEvent, env(db));

    expect(db.documents.find((row) => row.id === "doc_sched_defer")?.status).toBe("ACCEPTED");
  });

  it("lists FAILED and REJECTED under the combined Fallos filter while a deferred SIGNED doc stays out", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(
      {
        ...testDocument(),
        id: "doc_failed_list",
        codigo_generacion: "CCCCCCC3-CCCC-4CCC-8CCC-CCCCCCCCCCC3",
        numero_control: "DTE-15-M001P004-000000000000803",
        status: "FAILED",
        created_at: "2026-06-26T01:50:00.000Z"
      },
      {
        ...testDocument(),
        id: "doc_rejected_list",
        codigo_generacion: "DDDDDDD4-DDDD-4DDD-8DDD-DDDDDDDDDDD4",
        numero_control: "DTE-15-M001P004-000000000000804",
        status: "REJECTED",
        created_at: "2026-06-26T01:51:00.000Z"
      },
      // A deferred SIGNED doc (En trámite) must NOT leak into Fallos — that exclusion
      // is a deliberate product decision (it is awaiting transmission, not failed).
      {
        ...testDocument(),
        id: "doc_deferred_excluded",
        codigo_generacion: "FFFFFFF6-FFFF-4FFF-8FFF-FFFFFFFFFFF6",
        numero_control: "DTE-15-M001P004-000000000000806",
        status: "SIGNED",
        transmission_deferred_at: "2026-06-26T01:52:00.000Z",
        created_at: "2026-06-26T01:52:00.000Z"
      }
    );

    const response = await worker.fetch(
      new Request("https://example.org/api/documents?status=FAILED,REJECTED", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { documents: Array<{ id: string }> };
    expect(body.documents.map((document) => document.id)).toEqual(["doc_rejected_list", "doc_failed_list"]);
  });

  it("surfaces deferred docs as En trámite (virtual filter) while a plain SIGNED doc stays out", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    // Deferred: SIGNED + marker → listed under the virtual TRANSMISSION_PENDING filter.
    db.documents.push({
      ...testDocument(),
      id: "doc_deferred_list",
      codigo_generacion: "AAAAAAA1-AAAA-4AAA-8AAA-AAAAAAAAAAA1",
      numero_control: "DTE-15-M001P004-000000000000801",
      status: "SIGNED",
      transmission_deferred_at: "2026-06-26T01:49:00.000Z",
      signed_jws: "signed-jws",
      sello_recibido: null,
      mh_estado: "MH_NO_DISPONIBLE",
      accepted_at: null
    });
    // Plain SIGNED (mid-pipeline transient, NOT deferred) → excluded from the filter.
    db.documents.push({
      ...testDocument(),
      id: "doc_plain_signed",
      codigo_generacion: "BBBBBBB2-BBBB-4BBB-8BBB-BBBBBBBBBBB2",
      numero_control: "DTE-15-M001P004-000000000000802",
      status: "SIGNED",
      transmission_deferred_at: null,
      signed_jws: "signed-jws",
      sello_recibido: null,
      mh_estado: null,
      accepted_at: null
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/documents?status=TRANSMISSION_PENDING", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { documents: Array<{ id: string }> };
    expect(body.documents.map((document) => document.id)).toEqual(["doc_deferred_list"]);
  });
});

describe("audit pagination", () => {
  it("pages the audit list by keyset cursor with a stable order", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    for (let i = 0; i < 7; i++) {
      db.audits.push({
        id: `audit_${String(i).padStart(3, "0")}`,
        actor_type: "SYSTEM",
        actor_id: null,
        action: "DTE_ACCEPTED",
        entity_type: "dte_document",
        entity_id: `doc_${i}`,
        summary: `fila ${i}`,
        metadata_json: "{}",
        actor_ip: null,
        actor_context: null,
        created_at: `2026-07-0${(i % 7) + 1}T10:00:00.000Z`
      });
    }

    const first = await worker.fetch(
      new Request("https://example.org/api/audit?limit=3", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as { audit: Array<{ id: string; created_at: string }>; nextCursor: string | null };
    expect(page1.audit).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();
    // Newest first.
    expect(page1.audit[0].created_at >= page1.audit[1].created_at).toBe(true);

    const second = await worker.fetch(
      new Request(`https://example.org/api/audit?limit=3&cursor=${encodeURIComponent(page1.nextCursor!)}`, {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    const page2 = (await second.json()) as { audit: Array<{ id: string }>; nextCursor: string | null };
    expect(page2.audit).toHaveLength(3);
    // No overlap between pages.
    const ids1 = new Set(page1.audit.map((row) => row.id));
    expect(page2.audit.every((row) => !ids1.has(row.id))).toBe(true);

    const third = await worker.fetch(
      new Request(`https://example.org/api/audit?limit=3&cursor=${encodeURIComponent(page2.nextCursor!)}`, {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    const page3 = (await third.json()) as { audit: Array<{ id: string }>; nextCursor: string | null };
    expect(page3.audit).toHaveLength(1);
    expect(page3.nextCursor).toBeNull();
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

describe("advanced DTE queue idempotency", () => {
  it("does not re-transmit an already ACCEPTED advanced CDE on queue redelivery", async () => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_accepted",
      wompi_event_id: null,
      status: "ACCEPTED",
      signed_jws: "signed-jws",
      sello_recibido: "SELLO-EXISTING",
      accepted_at: "2026-06-26T01:46:48.000Z"
    });

    const record = await new IssuancePipeline(env(db, { MOCK_EXTERNAL_SERVICES: "true" })).processDteDocument("doc_advanced_accepted");

    // Terminal document returned untouched: no re-sign, no re-transmit, verdict preserved.
    expect(record.status).toBe("ACCEPTED");
    expect(record.sello_recibido).toBe("SELLO-EXISTING");
    expect(db.audits.filter((row) => row.action === "ADVANCED_CDE_ACCEPTED")).toHaveLength(0);
    expect(db.audits.filter((row) => row.action === "EMAIL_SENT")).toHaveLength(0);
  });

  it("does not re-process an INVALIDATED advanced CDE on queue redelivery", async () => {
    const db = new InMemoryD1();
    db.documents.push({
      ...testDocument(),
      id: "doc_advanced_invalidated",
      wompi_event_id: null,
      status: "INVALIDATED",
      signed_jws: "signed-jws"
    });

    const record = await new IssuancePipeline(env(db, { MOCK_EXTERNAL_SERVICES: "true" })).processDteDocument("doc_advanced_invalidated");

    expect(record.status).toBe("INVALIDATED");
    expect(db.audits.filter((row) => row.action === "ADVANCED_CDE_ACCEPTED" || row.action === "ADVANCED_CDE_REJECTED")).toHaveLength(0);
  });

  it("does not flip an accepted advanced CDE to FAILED when post-acceptance bookkeeping throws", async () => {
    const db = new InMemoryD1();
    db.documents.push({ ...advancedFailingDocument("doc_advanced_postfail"), signed_jws: "signed-jws" });
    // Make the ADVANCED_CDE_ACCEPTED audit write throw once, AFTER MH has accepted and
    // the row has already been marked ACCEPTED, forcing the catch path.
    const realPrepare = db.prepare.bind(db);
    let failNextAudit = true;
    db.prepare = (sql: string) => {
      const stmt = realPrepare(sql);
      if (sql.includes("INSERT INTO audit_logs") && failNextAudit) {
        failNextAudit = false;
        stmt.run = async () => {
          throw new Error("audit write failed");
        };
      }
      return stmt;
    };

    const record = await new IssuancePipeline(env(db, { MOCK_EXTERNAL_SERVICES: "true" })).processDteDocument("doc_advanced_postfail");

    // The MH acceptance seal survives: never overwritten with FAILED.
    expect(record.status).toBe("ACCEPTED");
    expect(db.documents.find((row) => row.id === "doc_advanced_postfail")?.status).toBe("ACCEPTED");
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "ADVANCED_CDE_FAILED" }));
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
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    // The countdown now reads the scheduled tick's time (passed to worker.scheduled
    // below), so the fixture is deterministic without pinning the wall clock.
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
    const db = new InMemoryD1();
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const now = new Date("2026-07-01T09:15:00.000Z");
    // The countdown now reads the scheduled tick's time (passed to worker.scheduled
    // below), so the fixture is deterministic without pinning the wall clock.
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
    // The countdown now reads the scheduled tick's time (passed to worker.scheduled
    // below), so the fixture is deterministic without pinning the wall clock.
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
    // The countdown now reads the scheduled tick's time (passed to worker.scheduled
    // below), so the fixture is deterministic without pinning the wall clock.
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
    // The countdown now reads the scheduled tick's time (passed to worker.scheduled
    // below), so the fixture is deterministic without pinning the wall clock.
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

  it.each([
    ["staging", "production"],
    ["production", "test"]
  ] as const)("rejects %s credential writes for the %s-incompatible environment", async (appEnv, environment) => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://example.org/api/credentials", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ environment, mhUser: "replacement-user" })
      }),
      env(db, {
        APP_ENV: appEnv,
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "writer-token",
        CLOUDFLARE_SCRIPT_NAME: `example-worker-${appEnv}`
      })
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "environment_not_allowed" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(db.audits.find((row) => row.action === "CREDENTIALS_UPDATED")).toBeUndefined();
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
    // The audit records THAT the recipient changed, but never the address itself — the
    // audit trail is readable by lower roles, so the OWNER-only value must not ride in.
    const audit = db.audits.find((row) => row.action === "ALERT_EMAIL_UPDATED");
    expect(audit).toMatchObject({
      entity_type: "app_setting",
      entity_id: "alert_email",
      summary: "Correo de alertas configurado",
      metadata_json: JSON.stringify({ enabled: true })
    });

    const getResponse = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(getResponse.status).toBe(200);
    await expect(getResponse.json()).resolves.toMatchObject({ alertEmail: "owner@example.org" });
  });

  it("lets owners configure multiple operational alert recipients separated by commas", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "owner@example.org, admin@example.org" })
      }),
      env(db)
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, alertEmail: "owner@example.org, admin@example.org" });
    expect(db.settings).toContainEqual(expect.objectContaining({ key: "alert_email", value: "owner@example.org, admin@example.org", updated_by: "user_owner" }));
  });

  it("rejects malformed operational alert recipient lists", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/settings/alert-email", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ alertEmail: "owner@example.org, correo-invalido" })
      }),
      env(db)
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_alert_email" });
  });

  it("redacts a legacy alert-email address from the audit trail for lower roles", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    // A row written before the redaction shipped still carries the address in both the
    // summary and metadata; the read path must scrub it for everyone.
    db.audits.push({
      id: "audit_alert_legacy",
      actor_type: "USER",
      actor_id: "user_owner",
      action: "ALERT_EMAIL_UPDATED",
      entity_type: "app_setting",
      entity_id: "alert_email",
      summary: "Correo de alertas configurado a owner@example.org",
      metadata_json: JSON.stringify({ alertEmail: "owner@example.org" }),
      actor_ip: null,
      actor_context: null,
      created_at: "2026-06-26T01:46:47.015Z"
    });

    const scopedResponse = await worker.fetch(
      new Request("https://example.org/api/audit?entityType=app_setting&entityId=alert_email", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(scopedResponse.status).toBe(200);
    const scopedBody = (await scopedResponse.json()) as { audit: Array<{ summary?: string; metadata_json?: string }> };
    expect(JSON.stringify(scopedBody.audit)).not.toContain("owner@example.org");
    expect(scopedBody.audit[0]).toMatchObject({
      summary: "Correo de alertas actualizado",
      metadata_json: "{}"
    });

    // The general (keyset-paginated) audit trail is the primary VIEWER surface and must
    // scrub the legacy address too.
    const generalResponse = await worker.fetch(
      new Request("https://example.org/api/audit", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(generalResponse.status).toBe(200);
    const generalBody = (await generalResponse.json()) as { audit: Array<Record<string, unknown>> };
    expect(JSON.stringify(generalBody.audit)).not.toContain("owner@example.org");
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

describe("admin backups panel", () => {
  function seedManifest(archive: FakeArchiveBucket, month: string, tables: Record<string, { rowCount: number; body: string }>): Promise<void> {
    return (async () => {
      const prefix = `retention/${month.slice(0, 4)}/${month}`;
      const manifestTables: Record<string, { rowCount: number; sha256: string }> = {};
      for (const [table, { rowCount, body }] of Object.entries(tables)) {
        const bytes = utf8Bytes(body);
        await archive.put(`${prefix}/${table}.ndjson`, bytes);
        manifestTables[table] = { rowCount, sha256: await sha256Hex(bytes) };
      }
      const manifest = { month, generatedAt: `${month}-28T09:00:00.000Z`, tables: manifestTables };
      await archive.put(`${prefix}/manifest.json`, utf8Bytes(JSON.stringify(manifest)));
    })();
  }

  it("lists archived, missing, and in-progress months newest-first with parsed manifest data", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    // Earliest document is April 2026, so the expected range spans April..(last closed month).
    db.documents.push(testDocument({ id: "doc_1", created_at: "2026-04-10T12:00:00.000Z" }));
    const archive = new FakeArchiveBucket();
    // April archived, May missing (no manifest).
    await seedManifest(archive, "2026-04", { dte_documents: { rowCount: 3, body: "a\nb\nc\n" } });

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups", { headers: { Authorization: "Bearer test-token" } }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { months: Array<{ month: string; status: string; totalRows?: number; exportedAt?: string }> };
    const byMonth = new Map(payload.months.map((entry) => [entry.month, entry]));

    // Newest first.
    expect(payload.months[0].month > payload.months[payload.months.length - 1].month).toBe(true);
    expect(byMonth.get("2026-04")).toMatchObject({ status: "archivado", totalRows: 3 });
    expect(byMonth.get("2026-04")?.exportedAt).toBe("2026-04-28T09:00:00.000Z");
    expect(byMonth.get("2026-05")).toMatchObject({ status: "faltante" });
    // The current (still-open) El Salvador month appears only as en_curso.
    const currentMonth = previousElSalvadorMonth(new Date(Date.now() + 40 * 24 * 60 * 60 * 1000));
    expect(byMonth.get(currentMonth)?.status).toBe("en_curso");
  });

  it("returns an empty list when there are no documents and no manifests", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups", { headers: { Authorization: "Bearer test-token" } }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ months: [] });
  });

  it("rejects a VIEWER with 403 and an unauthenticated caller with 401", async () => {
    const dbViewer = new InMemoryD1();
    dbViewer.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    const viewerResponse = await worker.fetch(
      new Request("https://example.org/api/admin/backups", { headers: { Authorization: "Bearer test-token" } }),
      env(dbViewer)
    );
    expect(viewerResponse.status).toBe(403);

    const anonResponse = await worker.fetch(new Request("https://example.org/api/admin/backups"), env(new InMemoryD1()));
    expect(anonResponse.status).toBe(401);
  });

  it("verifies a month against its manifest and audits RETENTION_VERIFIED on a full match", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 1, body: "row\n" },
      audit_logs: { rowCount: 0, body: "" }
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/verify", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; files: Array<{ table: string; ok: boolean }> };
    expect(payload.ok).toBe(true);
    expect(payload.files.every((file) => file.ok)).toBe(true);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_VERIFIED", entity_type: "retention_export", entity_id: "2026-04" })
    );
  });

  it("reports a mismatch, audits RETENTION_VERIFY_FAILED, and sends an operational alert when an object is corrupted", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    db.settings.push({ key: "alert_email", value: "owner@example.org" });
    const sent: unknown[] = [];
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", { dte_documents: { rowCount: 1, body: "row\n" } });
    // Corrupt the stored object's bytes so its SHA-256 no longer matches the manifest.
    await archive.put("retention/2026/2026-04/dte_documents.ndjson", utf8Bytes("tampered\n"));

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/verify", {
        method: "POST",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, {
        ARCHIVE: archive as unknown as R2Bucket,
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "alerts@example.org",
        EMAIL: {
          send: async (message: unknown) => {
            sent.push(message);
            return { messageId: "alert-verify" };
          }
        } as unknown as Env["EMAIL"]
      })
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; files: Array<{ table: string; ok: boolean; expected: string; actual: string }> };
    expect(payload.ok).toBe(false);
    const corrupted = payload.files.find((file) => file.table === "dte_documents");
    expect(corrupted?.ok).toBe(false);
    expect(corrupted?.expected).not.toBe(corrupted?.actual);
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_VERIFY_FAILED", entity_type: "retention_export", entity_id: "2026-04" })
    );
    expect(sent).toHaveLength(1);
  });

  it("streams a table object as an attachment and audits RETENTION_DOWNLOADED", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", { dte_documents: { rowCount: 2, body: "line1\nline2\n" } });

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download?table=dte_documents", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("attachment");
    expect(response.headers.get("Content-Disposition")).toContain("2026-04");
    await expect(response.text()).resolves.toBe("line1\nline2\n");
    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_DOWNLOADED", entity_type: "retention_export", entity_id: "2026-04" })
    );
  });

  it("returns 404 when downloading an object that is not in the archive", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download?table=dte_documents", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(404);
  });

  it("rejects a full-month ZIP whose objects exceed the memory budget with a Spanish 413", async () => {
    // The ZIP is buffered in worker memory; enforcement fires DURING collection (before
    // reading each object) so an oversized month can never balloon memory first.
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    // One object claims a size beyond the 32 MiB budget; its body is tiny so the test
    // itself stays cheap — the guard must trust the R2-reported size, not read first.
    await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 2, body: "line1\nline2\n" },
      audit_logs: { rowCount: 1, body: "audit\n" }
    });
    archive.sizeOverrides.set("retention/2026/2026-04/dte_documents.ndjson", 32 * 1024 * 1024 + 1);

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download-all", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "backup_archive_too_large" });
    // No PII-download audit for a refused archive.
    expect(db.audits.filter((row) => row.action === "RETENTION_DOWNLOADED")).toHaveLength(0);
  });

  it("streams a full-month ZIP of every archived object plus the manifest and audits the download", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 2, body: "line1\nline2\n" },
      audit_logs: { rowCount: 1, body: "audit\n" }
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download-all", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toBe('attachment; filename="respaldo-2026-04.zip"');

    // Round-trip the streamed ZIP through the system unzip binary (same pattern as
    // pdf.test.ts shelling out to poppler) to prove listing + exact content.
    const zipBytes = new Uint8Array(await response.arrayBuffer());
    const dir = mkdtempSync(join(tmpdir(), "diezmos-backup-zip-"));
    const zipPath = join(dir, "respaldo.zip");
    writeFileSync(zipPath, zipBytes);
    const listing = execFileSync("unzip", ["-t", zipPath], { encoding: "utf8" });
    expect(listing).toContain("manifest.json");
    expect(listing).toContain("dte_documents.ndjson");
    expect(listing).toContain("audit_logs.ndjson");
    expect(listing).toContain("No errors detected");
    expect(execFileSync("unzip", ["-p", zipPath, "dte_documents.ndjson"], { encoding: "utf8" })).toBe("line1\nline2\n");
    expect(execFileSync("unzip", ["-p", zipPath, "audit_logs.ndjson"], { encoding: "utf8" })).toBe("audit\n");

    expect(db.audits).toContainEqual(
      expect.objectContaining({ action: "RETENTION_DOWNLOADED", entity_type: "retention_export", entity_id: "2026-04" })
    );
    const audit = db.audits.find((row) => row.action === "RETENTION_DOWNLOADED");
    expect(JSON.parse(String(audit!.metadata_json))).toMatchObject({ month: "2026-04", table: "__all__" });
  });

  it("rejects an oversized full-month ZIP before auditing the download", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();
    await seedManifest(archive, "2026-04", {
      dte_documents: { rowCount: 1, body: "x".repeat(33 * 1024 * 1024) }
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download-all", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "backup_archive_too_large" });
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "RETENTION_DOWNLOADED" }));
  });

  it("returns 404 for a full-month download of a month without an archive", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const archive = new FakeArchiveBucket();

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download-all", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    expect(response.status).toBe(404);
  });

  it("rejects a VIEWER full-month download with 403", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };

    const response = await worker.fetch(
      new Request("https://example.org/api/admin/backups/2026-04/download-all", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );

    expect(response.status).toBe(403);
  });
});

describe("audit actor context", () => {
  // Cloudflare only sets request.cf in the Workers runtime, so tests attach it
  // manually; the worker reads it defensively via (request as any).cf.
  function withCf(request: Request, cf: Record<string, unknown>): Request {
    Object.defineProperty(request, "cf", { value: cf, configurable: true });
    return request;
  }

  const SV_CF = {
    country: "SV",
    city: "San Salvador",
    region: "San Salvador",
    timezone: "America/El_Salvador",
    asn: 27773,
    asOrganization: "Claro El Salvador",
    colo: "SJO",
    httpProtocol: "HTTP/2",
    tlsVersion: "TLSv1.3"
  };

  it("records the client IP and cf context on a failed login audit", async () => {
    const db = new InMemoryD1();

    const request = withCf(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "cf-connecting-ip": "190.86.1.2",
          "user-agent": "Mozilla/5.0 Test"
        },
        body: JSON.stringify({ email: "nobody@example.org", password: "whatever" })
      }),
      SV_CF
    );

    const response = await worker.fetch(request, env(db));

    expect(response.status).toBe(500);
    const failure = db.audits.find((audit) => audit.action === "LOGIN_FAILED");
    expect(failure).toBeTruthy();
    expect(failure?.actor_ip).toBe("190.86.1.2");
    expect(JSON.parse(String(failure?.actor_context))).toMatchObject({
      country: "SV",
      city: "San Salvador",
      asOrganization: "Claro El Salvador",
      userAgent: "Mozilla/5.0 Test"
    });
  });

  it("records the client IP and cf context on an admin user update audit", async () => {
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

    const request = withCf(
      new Request("https://example.org/api/users/user_operator", {
        method: "PATCH",
        headers: {
          Authorization: "Bearer test-token",
          "Content-Type": "application/json",
          "cf-connecting-ip": "201.203.9.9",
          "user-agent": "AdminBrowser/1.0"
        },
        body: JSON.stringify({ role: "ADMIN" })
      }),
      SV_CF
    );

    const response = await worker.fetch(request, env(db));

    expect(response.status).toBe(200);
    const audit = db.audits.find((row) => row.action === "USER_UPDATED");
    expect(audit?.actor_ip).toBe("201.203.9.9");
    expect(JSON.parse(String(audit?.actor_context))).toMatchObject({
      asOrganization: "Claro El Salvador",
      userAgent: "AdminBrowser/1.0"
    });
  });

  it("leaves cron/queue (SYSTEM) audits without actor IP or context", async () => {
    const db = new InMemoryD1();
    // A dead-letter batch runs in the queue handler with no incoming Request.
    await worker.queue(
      {
        queue: "issuance-dlq",
        messages: [
          {
            body: { wompiEventId: "wompi_1" } as IssuanceMessage,
            ack: () => undefined,
            retry: () => undefined
          }
        ]
      } as unknown as MessageBatch<IssuanceMessage>,
      env(db)
    );

    const audit = db.audits.find((row) => row.action === "ISSUANCE_DEAD_LETTERED");
    expect(audit).toBeTruthy();
    expect(audit?.actor_ip ?? null).toBeNull();
    expect(audit?.actor_context ?? null).toBeNull();
  });

  it.each(["VIEWER", "OPERATOR"] as const)("projects account audit rows safely for %s users", async (role) => {
    const db = new InMemoryD1();
    db.sessionUser = { id: `user_${role.toLowerCase()}`, email: `${role.toLowerCase()}@example.org`, name: role, role };
    db.users.push({
      id: "user_admin",
      email: "admin@example.org",
      name: "Ada Admin",
      role: "ADMIN",
      password_hash: "h",
      password_salt: "s",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.audits.push({
      id: "audit_user_1",
      actor_type: "USER",
      actor_id: "user_admin",
      action: "USER_UPDATED",
      entity_type: "user",
      entity_id: "user_operator",
      summary: "Usuario actualizado",
      metadata_json: "{}",
      actor_ip: "190.86.1.2",
      actor_context: JSON.stringify({ city: "San Salvador", country: "SV", asOrganization: "Claro El Salvador" }),
      created_at: "2026-06-26T01:46:47.015Z"
    });
    db.audits.push({
      id: "audit_system_1",
      actor_type: "SYSTEM",
      actor_id: null,
      action: "ISSUANCE_DEAD_LETTERED",
      entity_type: "wompi_event",
      entity_id: "wompi_1",
      summary: "seeded",
      metadata_json: "{}",
      actor_ip: null,
      actor_context: null,
      created_at: "2026-06-26T01:46:46.015Z"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/audit", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { audit: Array<Record<string, unknown>> };
    const userRow = body.audit.find((row) => row.id === "audit_user_1");
    const systemRow = body.audit.find((row) => row.id === "audit_system_1");

    // Account rows hide both the actor and target identity from lower audit audiences.
    expect(userRow?.actor_id ?? null).toBeNull();
    expect(userRow?.actor_name ?? null).toBeNull();
    expect(userRow?.actor_email ?? null).toBeNull();
    expect(userRow?.actor_ip ?? null).toBeNull();
    expect(userRow?.actor_context ?? null).toBeNull();
    expect(userRow?.entity_id ?? null).toBeNull();
    expect(userRow?.summary).toBe("Usuario actualizado");
    expect(userRow?.metadata_json).toBe("{}");
    // SYSTEM rows have no resolvable user and no captured context.
    expect(systemRow?.actor_name ?? null).toBeNull();
    expect(systemRow?.actor_ip ?? null).toBeNull();
  });

  it("applies the lower-role audit projection on scoped, document-detail, and contingency responses", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.users.push({
      id: "user_admin",
      email: "admin@example.org",
      name: "Ada Admin",
      role: "ADMIN",
      password_hash: "h",
      password_salt: "s",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.documents.push(testDocument({ id: "doc_projection" }));
    db.contingencies.push({
      id: "cont_projection",
      environment: "00",
      status: "OPEN",
      reason: "MH TEST no disponible",
      tipo_contingencia: 2,
      started_at: "2026-06-26T01:00:00.000Z",
      ended_at: null,
      created_at: "2026-06-26T01:00:00.000Z"
    });
    const sensitiveContext = JSON.stringify({ city: "San Salvador", country: "SV" });
    db.audits.push(
      {
        id: "audit_scoped_user",
        actor_type: "USER",
        actor_id: "user_admin",
        action: "USER_UPDATED",
        entity_type: "user",
        entity_id: "user_operator",
        summary: "operator@example.org ascendido",
        metadata_json: JSON.stringify({ email: "operator@example.org" }),
        actor_ip: "190.86.1.2",
        actor_context: sensitiveContext,
        created_at: "2026-06-26T01:46:49.015Z"
      },
      {
        id: "audit_document_projection",
        actor_type: "USER",
        actor_id: "user_admin",
        action: "DTE_RETRIED",
        entity_type: "dte_document",
        entity_id: "doc_projection",
        summary: "Documento reintentado",
        metadata_json: "{}",
        actor_ip: "190.86.1.2",
        actor_context: sensitiveContext,
        created_at: "2026-06-26T01:46:48.015Z"
      },
      {
        id: "audit_contingency_projection",
        actor_type: "USER",
        actor_id: "user_admin",
        action: "CONTINGENCY_OPENED",
        entity_type: "contingency_period",
        entity_id: "cont_projection",
        summary: "Contingencia abierta",
        metadata_json: "{}",
        actor_ip: "190.86.1.2",
        actor_context: sensitiveContext,
        created_at: "2026-06-26T01:46:47.015Z"
      }
    );

    const headers = { Authorization: "Bearer test-token" };
    const [scopedResponse, documentResponse, contingencyResponse] = await Promise.all([
      worker.fetch(
        new Request("https://example.org/api/audit?entityType=user&entityId=user_operator", { headers }),
        env(db)
      ),
      worker.fetch(new Request("https://example.org/api/documents/doc_projection", { headers }), env(db)),
      worker.fetch(new Request("https://example.org/api/contingency", { headers }), env(db))
    ]);

    expect(scopedResponse.status).toBe(200);
    expect(documentResponse.status).toBe(200);
    expect(contingencyResponse.status).toBe(200);
    const scoped = (await scopedResponse.json()) as { audit: Array<Record<string, unknown>> };
    const document = (await documentResponse.json()) as { audit: Array<Record<string, unknown>> };
    const contingency = (await contingencyResponse.json()) as { contingency: { audit: Array<Record<string, unknown>> } };

    expect(scoped.audit[0]).toMatchObject({
      actor_id: null,
      actor_name: null,
      actor_email: null,
      actor_ip: null,
      actor_context: null,
      entity_id: null,
      summary: "Usuario actualizado",
      metadata_json: "{}"
    });
    for (const row of [document.audit[0], contingency.contingency.audit[0]]) {
      expect(row).toMatchObject({ actor_email: null, actor_ip: null, actor_context: null });
    }
  });

  it("returns sensitive audit actor fields for ADMIN users", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin_session", email: "admin-session@example.org", name: "Admin Session", role: "ADMIN" };
    db.users.push({
      id: "user_admin",
      email: "admin@example.org",
      name: "Ada Admin",
      role: "ADMIN",
      password_hash: "h",
      password_salt: "s",
      disabled_at: "",
      created_at: "2026-06-26T01:46:47.015Z",
      updated_at: "2026-06-26T01:46:47.015Z"
    });
    db.audits.push({
      id: "audit_user_1",
      actor_type: "USER",
      actor_id: "user_admin",
      action: "USER_UPDATED",
      entity_type: "user",
      entity_id: "user_operator",
      summary: "Usuario actualizado",
      metadata_json: "{}",
      actor_ip: "190.86.1.2",
      actor_context: JSON.stringify({ city: "San Salvador", country: "SV", asOrganization: "Claro El Salvador" }),
      created_at: "2026-06-26T01:46:47.015Z"
    });

    const response = await worker.fetch(
      new Request("https://example.org/api/audit", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { audit: Array<Record<string, unknown>> };
    expect(body.audit[0]).toMatchObject({
      actor_name: "Ada Admin",
      actor_email: "admin@example.org",
      actor_ip: "190.86.1.2"
    });
    expect(JSON.parse(String(body.audit[0]?.actor_context))).toMatchObject({ city: "San Salvador" });
  });
});

describe("branding", () => {
  function ownerDb(): InMemoryD1 {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_owner", email: "owner@example.org", name: "Owner", role: "OWNER" };
    return db;
  }

  function authed(role: string): InMemoryD1 {
    const db = new InMemoryD1();
    db.sessionUser = { id: `user_${role.toLowerCase()}`, email: `${role.toLowerCase()}@example.org`, name: role, role };
    return db;
  }

  it("returns the defaults for the public branding endpoint before anything is set", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(new Request("https://example.org/api/branding"), env(db));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      displayName: "ExamplePerson1",
      accentColor: "#0f766e",
      supportEmail: "legacy-contact-1@example.com",
      logoVersion: null,
      donorLogoVersion: null
    });
  });

  it("reflects a saved name and color on the public branding endpoint", async () => {
    const db = ownerDb();
    const put = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "  Iglesia Central  ", accentColor: "#123ABC", supportEmail: "  legacy-email-119@example.com " })
      }),
      env(db)
    );
    expect(put.status).toBe(200);
    await expect(put.json()).resolves.toMatchObject({
      ok: true,
      displayName: "Iglesia Central",
      accentColor: "#123abc",
      supportEmail: "legacy-email-119@example.com"
    });
    expect(db.audits.at(-1)).toMatchObject({ action: "BRANDING_UPDATED", entity_type: "app_setting" });

    const response = await worker.fetch(new Request("https://example.org/api/branding"), env(db));
    await expect(response.json()).resolves.toMatchObject({
      displayName: "Iglesia Central",
      accentColor: "#123abc",
      supportEmail: "legacy-email-119@example.com",
      logoVersion: null,
      donorLogoVersion: null
    });
  });

  it("carries the support email in the branding audit metadata", async () => {
    const db = ownerDb();
    await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia Central", accentColor: "#123abc", supportEmail: "legacy-email-119@example.com" })
      }),
      env(db)
    );
    const audit = db.audits.at(-1) as { action: string; metadata_json?: string };
    expect(audit.action).toBe("BRANDING_UPDATED");
    expect(String(audit.metadata_json)).toContain("legacy-email-119@example.com");
  });

  it("rejects a malformed support email with a Spanish message", async () => {
    const db = ownerDb();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia", accentColor: "#0f766e", supportEmail: "no-arroba" })
      }),
      env(db)
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_branding");
    expect(body.message).toContain("correo");
    expect(db.audits).toHaveLength(0);
  });

  it("rejects a bad hex color with a Spanish message", async () => {
    const db = ownerDb();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia", accentColor: "#zzz" })
      }),
      env(db)
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("invalid_branding");
    expect(body.message).toContain("color");
    expect(db.audits).toHaveLength(0);
  });

  it("rejects an empty name with a Spanish message", async () => {
    const db = ownerDb();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "   ", accentColor: "#0f766e" })
      }),
      env(db)
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_branding" });
  });

  it("rejects an 81-character name", async () => {
    const db = ownerDb();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "a".repeat(81), accentColor: "#0f766e" })
      }),
      env(db)
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_branding" });
  });

  it("forbids a VIEWER from writing branding", async () => {
    const db = authed("VIEWER");
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia", accentColor: "#0f766e" })
      }),
      env(db)
    );
    expect(response.status).toBe(403);
  });

  it("forbids an OPERATOR from writing branding", async () => {
    const db = authed("OPERATOR");
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia", accentColor: "#0f766e" })
      }),
      env(db)
    );
    expect(response.status).toBe(403);
  });

  it("requires a session to write branding", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: "Iglesia", accentColor: "#0f766e" })
      }),
      env(db)
    );
    expect(response.status).toBe(401);
  });

  const logoCases: Array<{ contentType: string; ext: string }> = [
    { contentType: "image/svg+xml", ext: "svg" },
    { contentType: "image/png", ext: "png" },
    { contentType: "image/jpeg", ext: "jpg" }
  ];

  for (const { contentType } of logoCases) {
    it(`stores a ${contentType} logo and serves it with hardening headers`, async () => {
      const db = ownerDb();
      const archive = new FakeArchiveBucket();
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);

      const put = await worker.fetch(
        new Request("https://example.org/api/settings/branding/logo", {
          method: "PUT",
          headers: { Authorization: "Bearer test-token", "Content-Type": contentType },
          body: bytes
        }),
        env(db, { ARCHIVE: archive as unknown as R2Bucket })
      );
      expect(put.status).toBe(200);
      const putBody = (await put.json()) as { ok: boolean; logoVersion: string };
      expect(putBody.ok).toBe(true);
      expect(putBody.logoVersion).toBeTruthy();
      expect(archive.putCalls.at(-1)?.key).toBe("branding/logo");
      expect(db.audits.at(-1)).toMatchObject({ action: "BRANDING_LOGO_UPDATED" });

      const publicBranding = await worker.fetch(
        new Request("https://example.org/api/branding"),
        env(db, { ARCHIVE: archive as unknown as R2Bucket })
      );
      await expect(publicBranding.json()).resolves.toMatchObject({ logoVersion: putBody.logoVersion });

      const logo = await worker.fetch(
        new Request("https://example.org/api/branding/logo"),
        env(db, { ARCHIVE: archive as unknown as R2Bucket })
      );
      expect(logo.status).toBe(200);
      expect(logo.headers.get("Content-Type")).toBe(contentType);
      expect(logo.headers.get("Cache-Control")).toBe("public, max-age=300");
      expect(logo.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(logo.headers.get("Content-Security-Policy")).toBe("script-src 'none'; default-src 'none'; style-src 'unsafe-inline'");
      await expect(logo.arrayBuffer()).resolves.toEqual(bytes.buffer);
    });
  }

  it("stores and serves the donor logo separately from the admin/email logo", async () => {
    const db = ownerDb();
    const archive = new FakeArchiveBucket();
    const adminBytes = new Uint8Array([1, 2, 3]);
    const donorBytes = new Uint8Array([7, 8, 9]);

    const adminPut = await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: adminBytes
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    const adminBody = (await adminPut.json()) as { logoVersion: string };

    const donorPut = await worker.fetch(
      new Request("https://example.org/api/settings/branding/donor-logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: donorBytes
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(donorPut.status).toBe(200);
    const donorBody = (await donorPut.json()) as { ok: boolean; donorLogoVersion: string };
    expect(donorBody.ok).toBe(true);
    expect(donorBody.donorLogoVersion).toBeTruthy();
    expect(archive.putCalls.map((call) => call.key)).toContain("branding/logo");
    expect(archive.putCalls.map((call) => call.key)).toContain("branding/donor-logo");
    expect(db.audits.at(-1)).toMatchObject({ action: "BRANDING_DONOR_LOGO_UPDATED" });

    const publicBranding = await worker.fetch(
      new Request("https://example.org/api/branding"),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    await expect(publicBranding.json()).resolves.toMatchObject({
      logoVersion: adminBody.logoVersion,
      donorLogoVersion: donorBody.donorLogoVersion
    });

    const donorLogo = await worker.fetch(
      new Request("https://example.org/api/branding/donor-logo"),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(donorLogo.status).toBe(200);
    expect(donorLogo.headers.get("Content-Type")).toBe("image/png");
    await expect(donorLogo.arrayBuffer()).resolves.toEqual(donorBytes.buffer);

    const adminLogo = await worker.fetch(
      new Request("https://example.org/api/branding/logo"),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    await expect(adminLogo.arrayBuffer()).resolves.toEqual(adminBytes.buffer);
  });

  it("rejects a logo upload with an unsupported content type", async () => {
    const db = ownerDb();
    const archive = new FakeArchiveBucket();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/gif" },
        body: new Uint8Array([1, 2, 3])
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_branding_logo" });
    expect(archive.putCalls).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });

  it("rejects a logo upload larger than 512 KB", async () => {
    const db = ownerDb();
    const archive = new FakeArchiveBucket();
    const bytes = new Uint8Array(512 * 1024 + 1);
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: bytes
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "request_body_too_large" });
    expect(archive.putCalls).toHaveLength(0);
  });

  it("returns 404 for the logo stream when none is stored", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(new Request("https://example.org/api/branding/logo"), env(db));
    expect(response.status).toBe(404);
  });

  it("removes a stored logo and records an audit", async () => {
    const db = ownerDb();
    const archive = new FakeArchiveBucket();
    await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: new Uint8Array([9, 9, 9])
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );

    const remove = await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "DELETE",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(remove.status).toBe(200);
    await expect(remove.json()).resolves.toMatchObject({ ok: true });
    expect(archive.deleteCalls).toContain("branding/logo");
    expect(db.audits.at(-1)).toMatchObject({ action: "BRANDING_LOGO_REMOVED" });

    const publicBranding = await worker.fetch(
      new Request("https://example.org/api/branding"),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    await expect(publicBranding.json()).resolves.toMatchObject({ logoVersion: null });
  });

  it("removes a stored donor logo without removing the admin/email logo", async () => {
    const db = ownerDb();
    const archive = new FakeArchiveBucket();
    await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: new Uint8Array([1, 1, 1])
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    const donorPut = await worker.fetch(
      new Request("https://example.org/api/settings/branding/donor-logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: new Uint8Array([2, 2, 2])
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    const donorBody = (await donorPut.json()) as { donorLogoVersion: string };

    const remove = await worker.fetch(
      new Request("https://example.org/api/settings/branding/donor-logo", {
        method: "DELETE",
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(remove.status).toBe(200);
    await expect(remove.json()).resolves.toMatchObject({ ok: true, donorLogoVersion: null });
    expect(donorBody.donorLogoVersion).toBeTruthy();
    expect(archive.deleteCalls).toContain("branding/donor-logo");
    expect(archive.deleteCalls).not.toContain("branding/logo");
    expect(db.audits.at(-1)).toMatchObject({ action: "BRANDING_DONOR_LOGO_REMOVED" });

    const publicBranding = await worker.fetch(
      new Request("https://example.org/api/branding"),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    await expect(publicBranding.json()).resolves.toMatchObject({ logoVersion: expect.any(String), donorLogoVersion: null });
  });

  it("forbids a non-owner from uploading a logo", async () => {
    const db = authed("ADMIN");
    const archive = new FakeArchiveBucket();
    const response = await worker.fetch(
      new Request("https://example.org/api/settings/branding/logo", {
        method: "PUT",
        headers: { Authorization: "Bearer test-token", "Content-Type": "image/png" },
        body: new Uint8Array([1, 2, 3])
      }),
      env(db, { ARCHIVE: archive as unknown as R2Bucket })
    );
    expect(response.status).toBe(403);
    expect(archive.putCalls).toHaveLength(0);
  });
});

describe("analytics endpoint (Wompi lane)", () => {
  it("requires a session (401 without a token)", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(new Request("https://example.org/api/analytics"), env(db));
    expect(response.status).toBe(401);
  });

  it("rejects a malformed date range", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    const response = await worker.fetch(
      new Request("https://example.org/api/analytics?from=2026-13-40&to=2026-01-01", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_analytics_range" });
  });

  it("rejects analytics ranges wider than one year", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    const response = await worker.fetch(
      new Request("https://example.org/api/analytics?from=1900-01-01&to=9998-12-31", { headers: { Authorization: "Bearer test-token" } }),
      env(db)
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid_analytics_range" });
  });

  it("aggregates the Wompi lane and excludes manually issued CDEs by design", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    // Wompi-lane accepted doc (environment 00).
    db.documents.push(
      testDocument({
        id: "doc_wompi",
        wompi_event_id: "wompi_lane",
        environment: "00",
        status: "ACCEPTED",
        donor_email: "lane@example.org",
        donor_name: "Lane Donor",
        amount_cents: 5000,
        issued_at: "2026-06-10T18:00:00.000Z",
        accepted_at: "2026-06-10T18:00:20.000Z"
      }),
      // Manually issued CDE (no wompi_event_id) — must NOT appear in any total.
      testDocument({
        id: "doc_manual",
        wompi_event_id: null,
        environment: "00",
        status: "ACCEPTED",
        donor_email: "manual@example.org",
        amount_cents: 999999,
        issued_at: "2026-06-11T18:00:00.000Z"
      })
    );
    db.donationIntents.push({
      id: "di_lane",
      status: "COMPLETED",
      document_id: "doc_wompi",
      donor_document: "DUI-1",
      gift_type: "DIEZMO",
      direccion_departamento: "06",
      donor_pais: null,
      created_at: "2026-06-10T17:50:00.000Z",
      paid_at: "2026-06-10T17:55:00.000Z"
    });
    db.emailDeliveries.push({ id: "em_1", document_id: "doc_wompi", status: "SENT", created_at: "2026-06-10T18:01:00.000Z" });

    const response = await worker.fetch(
      new Request("https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=00", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { analytics: Record<string, any> };
    const analytics = body.analytics;
    expect(analytics.environment).toBe("00");
    expect(analytics.hasData).toBe(true);
    // Only the Wompi-lane doc counts (the 999999 manual CDE is excluded).
    const june = analytics.giving.monthly.find((point: any) => point.key === "2026-06");
    expect(june).toMatchObject({ totalCents: 5000, count: 1 });
    // Gift split routes it to Diezmo via the correlated intent.
    expect(analytics.giving.giftSplit.find((point: any) => point.key === "2026-06")?.diezmoCents).toBe(5000);
    // Geography buckets it under department 06.
    expect(analytics.geography.departments.find((row: any) => row.code === "06")?.count).toBe(1);
    // Funnel + email pick up the lane intent and delivery.
    expect(analytics.funnel).toMatchObject({ created: 1, datos: 1, paid: 1, completed: 1 });
    expect(analytics.email.weekly.reduce((sum: number, point: any) => sum + point.sent, 0)).toBe(1);
    // Top donors never leak numero de control.
    expect(JSON.stringify(analytics.giving.topDonors)).not.toContain("numero_control");
  });

  it("scopes every metric to the requested ambiente", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_viewer", email: "viewer@example.org", name: "Viewer", role: "VIEWER" };
    db.documents.push(
      testDocument({ id: "doc_00", wompi_event_id: "w00", environment: "00", amount_cents: 1000, issued_at: "2026-06-10T18:00:00.000Z" }),
      testDocument({ id: "doc_01", wompi_event_id: "w01", environment: "01", amount_cents: 8000, issued_at: "2026-06-10T18:00:00.000Z" })
    );
    const response = await worker.fetch(
      new Request("https://example.org/api/analytics?from=2026-06-01&to=2026-06-30&environment=01", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db)
    );
    const body = (await response.json()) as { analytics: Record<string, any> };
    const june = body.analytics.giving.monthly.find((point: any) => point.key === "2026-06");
    // Only the 01 doc is counted; the 00 doc is invisible in this ambiente.
    expect(june).toMatchObject({ totalCents: 8000, count: 1 });
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
    APP_ENV: "local",
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
  // Reported-size overrides so tests can simulate oversized R2 objects without
  // allocating them (the backup ZIP guard trusts object.size before reading).
  readonly sizeOverrides = new Map<string, number>();
  readonly contentTypes = new Map<string, string>();
  readonly putCalls: Array<{ key: string; bytes: Uint8Array }> = [];
  readonly headCalls: string[] = [];
  readonly deleteCalls: string[] = [];

  async put(key: string, value: unknown, options?: { httpMetadata?: { contentType?: string } }): Promise<R2Object> {
    const bytes = value instanceof Uint8Array ? value : utf8Bytes(String(value));
    this.objects.set(key, bytes);
    if (options?.httpMetadata?.contentType) {
      this.contentTypes.set(key, options.httpMetadata.contentType);
    }
    this.putCalls.push({ key, bytes });
    return { key } as R2Object;
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    this.objects.delete(key);
    this.contentTypes.delete(key);
  }

  async head(key: string): Promise<R2Object | null> {
    this.headCalls.push(key);
    return this.objects.has(key) ? ({ key } as R2Object) : null;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const bytes = this.objects.get(key);
    if (!bytes) {
      return null;
    }
    // The backups service consumes get() via arrayBuffer(); expose exactly that,
    // plus a body stream so a downloaded response can be streamed like production R2.
    // httpMetadata carries the stored content type back to the branding logo route.
    return {
      key,
      body: new Response(bytes).body,
      size: this.sizeOverrides.get(key) ?? bytes.byteLength,
      httpMetadata: this.contentTypes.has(key) ? { contentType: this.contentTypes.get(key) } : {},
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    } as unknown as R2ObjectBody;
  }

  async list(options?: { prefix?: string }): Promise<R2Objects> {
    const prefix = options?.prefix ?? "";
    const objects = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key }) as R2Object);
    return { objects, truncated: false, delimitedPrefixes: [] } as unknown as R2Objects;
  }
}

interface LoginRateLimitRow {
  window_started_at: string;
  attempt_count: number;
  expires_at: string;
}

class InMemoryD1 {
  readonly users: Array<Record<string, unknown>> = [];
  readonly sessions: Array<Record<string, unknown>> = [];
  readonly audits: Array<Record<string, unknown>> = [];
  readonly loginRateLimits = new Map<string, LoginRateLimitRow>();
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
  readonly donationIntents: Array<Record<string, unknown>> = [];
  documentLookupCount = 0;
  loginCredentialReads = 0;
  nextSequence = 1;
  sessionUser: Record<string, string> | null = null;
  beforePasswordRehashCas: (() => void) | null = null;
  beforePasswordResetBatch: (() => void) | null = null;
  failPasswordResetBatchAfterStatement: number | null = null;
  passwordResetBatchCount = 0;
  private passwordResetBatchTail: Promise<void> = Promise.resolve();

  prepare(sql: string): Statement {
    this.preparedSql.push(sql);
    return new Statement(this, sql);
  }

  async batch(statements: Statement[]): Promise<StatementRunResult[]> {
    const previous = this.passwordResetBatchTail;
    let release!: () => void;
    this.passwordResetBatchTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    const usersBefore = structuredClone(this.users);
    const sessionsBefore = structuredClone(this.sessions);
    const tokensBefore = structuredClone(this.resetTokens);
    try {
      this.passwordResetBatchCount += 1;
      this.beforePasswordResetBatch?.();
      this.beforePasswordResetBatch = null;
      const results: StatementRunResult[] = [];
      for (const [index, statement] of statements.entries()) {
        results.push(await statement.run());
        if (this.failPasswordResetBatchAfterStatement === index + 1) {
          throw new Error("injected password-reset batch failure");
        }
      }
      return results;
    } catch (error) {
      this.users.splice(0, this.users.length, ...usersBefore);
      this.sessions.splice(0, this.sessions.length, ...sessionsBefore);
      this.resetTokens.splice(0, this.resetTokens.length, ...tokensBefore);
      throw error;
    } finally {
      this.failPasswordResetBatchAfterStatement = null;
      release();
    }
  }
}

interface StatementRunResult {
  success: true;
  meta: { changes: number };
  results: never[];
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
    if (this.sql.includes("INSERT INTO login_rate_limits")) {
      const [keyHash, now, expiresAt, cutoff, , , , limitValue] = this.args;
      const key = String(keyHash);
      const current = this.db.loginRateLimits.get(key);
      const limit = Number(limitValue);
      if (!current || current.window_started_at <= String(cutoff)) {
        const next = {
          window_started_at: String(now),
          attempt_count: 1,
          expires_at: String(expiresAt)
        };
        this.db.loginRateLimits.set(key, next);
        return { attempt_count: 1 } as T;
      }
      if (current.attempt_count >= limit) return null;
      current.attempt_count += 1;
      return { attempt_count: current.attempt_count } as T;
    }
    if (
      this.sql.includes("UPDATE users") &&
      this.sql.includes("password_hash = ?") &&
      this.sql.includes("password_salt = ?") &&
      this.sql.includes("RETURNING id")
    ) {
      const [passwordHash, passwordSalt, updatedAt, userId, currentPasswordHash, currentPasswordSalt] = this.args;
      this.db.beforePasswordRehashCas?.();
      this.db.beforePasswordRehashCas = null;
      const user = this.db.users.find(
        (row) => row.id === userId && row.password_hash === currentPasswordHash && row.password_salt === currentPasswordSalt
      );
      if (!user) {
        return null;
      }
      user.password_hash = passwordHash;
      user.password_salt = passwordSalt;
      user.updated_at = updatedAt;
      return { id: user.id } as T;
    }
    if (
      this.sql.includes("UPDATE dte_documents") &&
      this.sql.includes("status = 'REJECTED'") &&
      this.sql.includes("RETURNING id")
    ) {
      // claimRejectedWompiRebuild: conditional CAS that only wins while the row is
      // still REJECTED. Returns the row (RETURNING id) on success, null when lost.
      const [codigoGeneracion, numeroControl, plainJson, signedJws, updatedAt, documentId, wompiEventId] = this.args;
      const document = this.db.documents.find(
        (row) => row.id === documentId && row.wompi_event_id === wompiEventId && row.status === "REJECTED"
      );
      if (!document) {
        return null;
      }
      document.codigo_generacion = String(codigoGeneracion);
      document.numero_control = String(numeroControl);
      document.plain_json = String(plainJson);
      document.signed_jws = signedJws === null ? null : String(signedJws);
      document.status = "SIGNED";
      document.sello_recibido = null;
      document.mh_estado = null;
      document.mh_observaciones_json = "[]";
      document.updated_at = String(updatedAt);
      return { id: document.id } as T;
    }
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
      this.db.loginCredentialReads += 1;
      return (this.db.users.find((user) => String(user.email).toLowerCase() === String(this.args[0]).toLowerCase()) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM audit_logs") && this.sql.includes("actor_ip IS ?")) {
      const [action, entityId, sinceIso, actorIp] = this.args;
      return {
        count: this.db.audits.filter(
          (audit) =>
            audit.action === action &&
            audit.entity_id === entityId &&
            String(audit.created_at) >= String(sinceIso) &&
            (audit.actor_ip ?? null) === (actorIp ?? null)
        ).length
      } as T;
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
    if (this.sql.includes("SELECT MIN(created_at) AS earliest FROM dte_documents")) {
      const earliest = this.db.documents
        .map((document) => String(document.created_at))
        .sort()
        .at(0);
      return { earliest: earliest ?? null } as T;
    }
    if (this.sql.includes("SELECT * FROM dte_documents WHERE id = ?")) {
      this.db.documentLookupCount += 1;
      return (this.db.documents.find((document) => document.id === this.args[0]) ?? null) as T | null;
    }
    if (this.sql.includes("SELECT * FROM donation_intents WHERE id = ?")) {
      return (this.db.donationIntents.find((intent) => intent.id === this.args[0]) ?? null) as T | null;
    }
    if (
      this.sql.includes("UPDATE donation_intents") &&
      this.sql.includes("datos_token_hash = NULL") &&
      this.sql.includes("RETURNING id")
    ) {
      const [
        donorDocumentType,
        donorDocument,
        donorName,
        donorPhone,
        direccionDepartamento,
        direccionMunicipio,
        direccionDistrito,
        direccionComplemento,
        donorPais,
        updatedAt,
        id,
        datosTokenHash,
        expiresAfter
      ] = this.args;
      const intent = this.db.donationIntents.find(
        (row) =>
          row.id === id &&
          row.datos_token_hash === datosTokenHash &&
          row.status === "LINK_CREATED" &&
          row.paid_at == null &&
          row.donor_document == null &&
          String(row.expires_at) > String(expiresAfter)
      );
      if (!intent) return null;
      intent.donor_document_type = String(donorDocumentType);
      intent.donor_document = String(donorDocument);
      intent.donor_name = donorName == null ? null : String(donorName);
      intent.donor_phone = donorPhone == null ? null : String(donorPhone);
      intent.direccion_departamento = String(direccionDepartamento);
      intent.direccion_municipio = String(direccionMunicipio);
      intent.direccion_distrito = String(direccionDistrito);
      intent.direccion_complemento = String(direccionComplemento);
      intent.donor_pais = donorPais == null ? null : String(donorPais);
      intent.datos_token_hash = null;
      intent.updated_at = String(updatedAt);
      return { id: String(id) } as T;
    }
    if (this.sql.includes("FROM donation_intents WHERE document_id = ?") && this.sql.includes("status = 'COMPLETED'")) {
      const documentId = String(this.args[0]);
      return (this.db.donationIntents.find((intent) => intent.document_id === documentId && intent.status === "COMPLETED") ?? null) as T | null;
    }
    if (this.sql.includes("SELECT COUNT(*) AS count FROM donation_intents") && this.sql.includes("client_ip = ?")) {
      const [clientIp, sinceIso] = this.args.map(String);
      return {
        count: this.db.donationIntents.filter(
          (intent) => intent.client_ip === clientIp && String(intent.created_at) >= sinceIso
        ).length
      } as T;
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
    if (this.sql.includes("FROM email_deliveries") && this.sql.includes("email_type = ?")) {
      // hasSentEmail dedupe lookup: SENT delivery of a given evidence type for a document.
      const [documentId, emailType] = this.args.map(String);
      return (this.db.emailDeliveries.find(
        (row) => row.document_id === documentId && row.email_type === emailType && row.status === "SENT"
      ) ?? null) as T | null;
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
    // ----- Analítica (carril Wompi) -----
    // Documentos: dte_documents con wompi_event_id, LEFT JOIN a donation_intents por
    // document_id, filtrado por environment + ventana issued_at, paginado por (issued_at, id).
    if (this.sql.includes("FROM dte_documents d") && this.sql.includes("LEFT JOIN donation_intents i") && this.sql.includes("d.wompi_event_id IS NOT NULL")) {
      const [environment, startIso, endIso] = [String(this.args[0]), String(this.args[1]), String(this.args[2])];
      let documents = this.db.documents.filter(
        (document) =>
          document.wompi_event_id != null &&
          document.environment === environment &&
          String(document.issued_at) >= startIso &&
          String(document.issued_at) < endIso
      );
      if (this.sql.includes("(d.issued_at, d.id) > (?, ?)")) {
        const [afterIssued, afterId] = [String(this.args[3]), String(this.args[4])];
        documents = documents.filter(
          (document) => String(document.issued_at) > afterIssued || (String(document.issued_at) === afterIssued && String(document.id) > afterId)
        );
      }
      documents.sort((left, right) => String(left.issued_at).localeCompare(String(right.issued_at)) || String(left.id).localeCompare(String(right.id)));
      const limit = Number(this.args.at(-1) ?? 500);
      const rows = documents.slice(0, limit).map((document) => {
        const intent = this.db.donationIntents.find((candidate) => candidate.document_id === document.id);
        return {
          id: document.id,
          wompi_event_id: document.wompi_event_id,
          environment: document.environment,
          status: document.status,
          donor_email: document.donor_email ?? null,
          donor_name: document.donor_name ?? null,
          amount_cents: document.amount_cents,
          issued_at: document.issued_at,
          accepted_at: document.accepted_at ?? null,
          transmission_deferred_at: document.transmission_deferred_at ?? null,
          direccion_departamento: intent?.direccion_departamento ?? null,
          donor_pais: intent?.donor_pais ?? null,
          gift_type: intent?.gift_type ?? null
        };
      });
      return { results: rows as T[] };
    }
    // Intents: donation_intents LEFT JOIN dte_documents, filtrado por ventana created_at
    // y (documento en el ambiente O sin documento). Distinguible por la proyección de
    // i.direccion_departamento.
    if (this.sql.includes("FROM donation_intents i") && this.sql.includes("i.direccion_departamento AS direccion_departamento") && this.sql.includes("LEFT JOIN dte_documents d")) {
      const [startIso, endIso, environment] = [String(this.args[0]), String(this.args[1]), String(this.args[2])];
      let intents = this.db.donationIntents.filter((intent) => String(intent.created_at) >= startIso && String(intent.created_at) < endIso);
      intents = intents.filter((intent) => {
        const document = this.db.documents.find((candidate) => candidate.id === intent.document_id);
        return document ? document.environment === environment : true;
      });
      if (this.sql.includes("(i.created_at, i.id) > (?, ?)")) {
        const [afterCreated, afterId] = [String(this.args[3]), String(this.args[4])];
        intents = intents.filter(
          (intent) => String(intent.created_at) > afterCreated || (String(intent.created_at) === afterCreated && String(intent.id) > afterId)
        );
      }
      intents.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)) || String(left.id).localeCompare(String(right.id)));
      const limit = Number(this.args.at(-1) ?? 500);
      const rows = intents.slice(0, limit).map((intent) => ({
        id: intent.id,
        status: intent.status,
        document_id: intent.document_id ?? null,
        donor_document: intent.donor_document ?? null,
        gift_type: intent.gift_type ?? null,
        created_at: intent.created_at,
        paid_at: intent.paid_at ?? null,
        direccion_departamento: intent.direccion_departamento ?? null,
        donor_pais: intent.donor_pais ?? null
      }));
      return { results: rows as T[] };
    }
    // Emails: email_deliveries JOIN dte_documents (carril Wompi + environment), ventana created_at.
    if (this.sql.includes("FROM email_deliveries e") && this.sql.includes("JOIN dte_documents d")) {
      const [startIso, endIso, environment] = [String(this.args[0]), String(this.args[1]), String(this.args[2])];
      let deliveries = this.db.emailDeliveries.filter((delivery) => {
        const document = this.db.documents.find((candidate) => candidate.id === delivery.document_id);
        return (
          document != null &&
          document.wompi_event_id != null &&
          document.environment === environment &&
          String(delivery.created_at) >= startIso &&
          String(delivery.created_at) < endIso
        );
      });
      if (this.sql.includes("(e.created_at, e.id) > (?, ?)")) {
        const [afterCreated, afterId] = [String(this.args[3]), String(this.args[4])];
        deliveries = deliveries.filter(
          (delivery) => String(delivery.created_at) > afterCreated || (String(delivery.created_at) === afterCreated && String(delivery.id) > afterId)
        );
      }
      deliveries.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)) || String(left.id).localeCompare(String(right.id)));
      const limit = Number(this.args.at(-1) ?? 500);
      const rows = deliveries.slice(0, limit).map((delivery) => ({
        id: delivery.id,
        document_id: delivery.document_id,
        status: delivery.status,
        created_at: delivery.created_at
      }));
      return { results: rows as T[] };
    }
    if (this.sql.includes("FROM donation_intents") && this.sql.includes("status IN ('PENDING','LINK_CREATED')") && this.sql.includes("expires_at < ?")) {
      // listIntentsExpiringBefore: same predicate as the EXPIRED update, projecting
      // the fields the deactivation sweep needs, capped oldest-first by the bound limit.
      const nowIso = String(this.args[0]);
      const limit = Number(this.args[1] ?? Number.POSITIVE_INFINITY);
      const rows = this.db.donationIntents
        .filter((intent) => (intent.status === "PENDING" || intent.status === "LINK_CREATED") && String(intent.expires_at) < nowIso)
        .sort((left, right) => String(left.expires_at).localeCompare(String(right.expires_at)) || String(left.id).localeCompare(String(right.id)))
        .slice(0, limit)
        .map((intent) => ({
          id: intent.id,
          wompi_id_enlace: intent.wompi_id_enlace ?? null,
          amount_cents: intent.amount_cents,
          status: intent.status,
          // Projected so the sweep's deactivate PUT resends the create nombreProducto.
          gift_type: intent.gift_type ?? null
        }));
      return { results: rows as T[] };
    }
    if (this.sql.includes("FROM donation_intents") && this.sql.includes("LEFT JOIN dte_documents")) {
      const limit = Number(this.args.at(-1) ?? 50);
      const rows = [...this.db.donationIntents]
        .sort(
          (left, right) =>
            String(right.created_at).localeCompare(String(left.created_at)) || String(right.id).localeCompare(String(left.id))
        )
        .slice(0, limit)
        .map((intent) => {
          const document = this.db.documents.find((candidate) => candidate.id === intent.document_id);
          // Mirror the repository's allowlisted projection: the listing exposes only the
          // fields the admin panel renders, never donor PII or payment-link metadata.
          return {
            id: intent.id,
            status: intent.status,
            amount_cents: intent.amount_cents,
            document_id: intent.document_id ?? null,
            gift_type: intent.gift_type ?? null,
            created_at: intent.created_at,
            numero_control: document?.numero_control ?? null,
            document_donor_name: document?.donor_name ?? null
          };
        });
      return { results: rows as T[] };
    }
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
    if (this.sql.includes("FROM dte_documents") && this.sql.includes("LEFT JOIN donation_intents") && this.sql.includes("ORDER BY dte_documents.issued_at ASC, dte_documents.id ASC")) {
      // CRM contacts export: keyset-paged Wompi-lane ACCEPTED docs for one ambiente,
      // LEFT JOINed to their correlated COMPLETED intent (0 or 1 per document).
      const environment = String(this.args[0]);
      // Binding order mirrors the repository: [environment, startIso, (endIso if
      // windowed), (cursor issued, cursor id if cursor), limit]. Lower bound is always
      // present ("" matches all when unwindowed).
      const startIso = String(this.args[1]);
      let documents = this.db.documents.filter(
        (document) =>
          document.status === "ACCEPTED" &&
          document.wompi_event_id != null &&
          document.environment === environment &&
          document.issued_at >= startIso
      );
      let cursorBase = 2;
      if (this.sql.includes("dte_documents.issued_at < ?")) {
        const endIso = String(this.args[2]);
        documents = documents.filter((document) => document.issued_at < endIso);
        cursorBase = 3;
      }
      if (this.sql.includes("(dte_documents.issued_at, dte_documents.id) > (?, ?)")) {
        const [afterIssued, afterId] = [String(this.args[cursorBase]), String(this.args[cursorBase + 1])];
        documents = documents.filter(
          (document) => document.issued_at > afterIssued || (document.issued_at === afterIssued && document.id > afterId)
        );
      }
      documents.sort((left, right) => left.issued_at.localeCompare(right.issued_at) || left.id.localeCompare(right.id));
      const limit = Number(this.args.at(-1) ?? 500);
      const joined = documents.slice(0, limit).map((document) => {
        const intent = this.db.donationIntents.find(
          (candidate) => candidate.document_id === document.id && candidate.status === "COMPLETED"
        );
        return {
          id: document.id,
          donor_email: document.donor_email,
          donor_name: document.donor_name,
          amount_cents: document.amount_cents,
          issued_at: document.issued_at,
          intent_donor_phone: intent?.donor_phone ?? null,
          intent_direccion_complemento: intent?.direccion_complemento ?? null,
          intent_direccion_departamento: intent?.direccion_departamento ?? null,
          intent_donor_pais: intent?.donor_pais ?? null,
          intent_gift_type: intent?.gift_type ?? null,
          intent_created_at: intent?.created_at ?? null
        };
      });
      return { results: joined as T[] };
    }
    if (this.sql.includes("FROM dte_documents")) {
      let documents = [...this.db.documents];
      if (this.sql.includes("ORDER BY dte_documents.created_at DESC, dte_documents.id DESC")) {
        let argIndex = 0;
        if (this.sql.includes("dte_documents.status = 'SIGNED' AND dte_documents.transmission_deferred_at IS NOT NULL")) {
          // Virtual "TRANSMISSION_PENDING" filter: deferred docs only, not plain SIGNED.
          documents = documents.filter((document) => document.status === "SIGNED" && document.transmission_deferred_at != null);
        } else if (this.sql.includes("status IN")) {
          const statusPlaceholderList = this.sql.match(/status IN \(([^)]*)\)/)?.[1] ?? "";
          const statusCount = (statusPlaceholderList.match(/\?/g) ?? []).length;
          const statuses = this.args.slice(argIndex, argIndex + statusCount).map(String);
          argIndex += statusCount;
          documents = documents.filter((document) => statuses.includes(String(document.status)));
        } else if (this.sql.includes("status = ?")) {
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
      if (this.sql.includes("transmission_deferred_at IS NOT NULL")) {
        documents = documents.filter((document) => document.transmission_deferred_at != null);
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
      let argIndex = 0;
      if (this.sql.includes("a.entity_type = ? AND a.entity_id = ?")) {
        audits = audits.filter((audit) => audit.entity_type === this.args[0] && audit.entity_id === this.args[1]);
        argIndex = 2;
      }
      if (this.sql.includes("(a.created_at, a.id) < (?, ?)")) {
        const cursorCreated = String(this.args[argIndex]);
        const cursorId = String(this.args[argIndex + 1]);
        argIndex += 2;
        audits = audits.filter((audit) => {
          const created = String(audit.created_at);
          return created < cursorCreated || (created === cursorCreated && String(audit.id) < cursorId);
        });
      }
      audits.sort(
        (left, right) =>
          String(right.created_at).localeCompare(String(left.created_at)) || String(right.id).localeCompare(String(left.id))
      );
      if (this.sql.includes("ORDER BY a.created_at DESC, a.id DESC LIMIT ?")) {
        audits = audits.slice(0, Number(this.args[argIndex] ?? 100));
      }
      // Mirror the LEFT JOIN users ON u.id = a.actor_id: USER rows resolve to a name/email,
      // SYSTEM rows (and deleted-actor rows) keep NULLs.
      const joined = audits.map((audit) => {
        const actor = this.db.users.find((user) => user.id === audit.actor_id);
        return {
          ...audit,
          actor_name: actor?.name ?? null,
          actor_email: actor?.email ?? null
        };
      });
      return { results: joined as T[] };
    }
    return { results: [] };
  }

  async run(): Promise<StatementRunResult> {
    let changes = 0;
    if (this.sql.includes("DELETE FROM login_rate_limits")) {
      const [now] = this.args.map(String);
      for (const [key, row] of this.db.loginRateLimits) {
        if (row.expires_at <= now) {
          this.db.loginRateLimits.delete(key);
          changes += 1;
        }
      }
    }
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
    if (this.sql.includes("UPDATE password_reset_tokens") && this.sql.includes("SET used_at = ?")) {
      if (this.sql.includes("WHERE user_id = ?")) {
        const [usedAt, userId, markerUserId, passwordHash, passwordSalt, updatedAt] = this.args.map(String);
        const marker = this.db.users.some(
          (row) =>
            row.id === markerUserId &&
            row.password_hash === passwordHash &&
            row.password_salt === passwordSalt &&
            row.updated_at === updatedAt
        );
        if (marker) {
          for (const token of this.db.resetTokens.filter((row) => row.user_id === userId && !row.used_at)) {
            token.used_at = usedAt;
            changes += 1;
          }
        }
      } else {
        const [usedAt, id] = this.args.map(String);
        const token = this.db.resetTokens.find((row) => row.id === id);
        if (token) {
          token.used_at = usedAt;
          changes += 1;
        }
      }
    }
    if (this.sql.includes("INSERT INTO audit_logs")) {
      const [id, actorType, actorId, action, entityType, entityId, summary, metadataJson, actorIp, actorContext] = this.args;
      this.db.audits.push({
        id,
        actor_type: actorType,
        actor_id: actorId,
        action,
        entity_type: entityType,
        entity_id: entityId,
        summary,
        metadata_json: metadataJson,
        actor_ip: actorIp ?? null,
        actor_context: actorContext ?? null,
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
    if (this.sql.includes("INSERT INTO donation_intents")) {
      const [
        id,
        amountCents,
        donorName,
        donorDocumentType,
        donorDocument,
        donorEmail,
        donorPhone,
        direccionDepartamento,
        direccionMunicipio,
        direccionDistrito,
        direccionComplemento,
        donorPais,
        clientIp,
        expiresAt,
        giftType,
        datosTokenHash
      ] = this.args;
      this.db.donationIntents.push({
        id: String(id),
        status: "PENDING",
        amount_cents: Number(amountCents),
        donor_name: donorName == null ? null : String(donorName),
        donor_document_type: String(donorDocumentType),
        // Document + address are nullable now (0015): a draft binds them null.
        donor_document: donorDocument == null ? null : String(donorDocument),
        donor_email: donorEmail == null ? null : String(donorEmail),
        donor_phone: donorPhone == null ? null : String(donorPhone),
        direccion_departamento: direccionDepartamento == null ? null : String(direccionDepartamento),
        direccion_municipio: direccionMunicipio == null ? null : String(direccionMunicipio),
        direccion_distrito: direccionDistrito == null ? null : String(direccionDistrito),
        direccion_complemento: direccionComplemento == null ? null : String(direccionComplemento),
        donor_pais: donorPais == null ? null : String(donorPais),
        // gift_type is the last bound arg (appended by migration 0012).
        gift_type: giftType == null ? null : String(giftType),
        wompi_id_enlace: null,
        wompi_url_enlace: null,
        wompi_url_enlace_largo: null,
        document_id: null,
        client_ip: clientIp == null ? null : String(clientIp),
        datos_token_hash: datosTokenHash == null ? null : String(datosTokenHash),
        // paid_at (migration 0016): stamped only by the webhook's markIntentPaid,
        // never on create — a fresh intent has not been paid.
        paid_at: null,
        created_at: "2026-06-26T01:46:47.015Z",
        updated_at: "2026-06-26T01:46:47.015Z",
        expires_at: String(expiresAt)
      });
    }
    if (this.sql.includes("UPDATE donation_intents") && this.sql.includes("donor_document_type = ?") && this.sql.includes("direccion_departamento = ?")) {
      // The /datos completion: attaches donor data, leaving amount/gift_type/status/link untouched.
      const [
        donorDocumentType,
        donorDocument,
        donorName,
        donorPhone,
        direccionDepartamento,
        direccionMunicipio,
        direccionDistrito,
        direccionComplemento,
        donorPais,
        updatedAt,
        id
      ] = this.args;
      const intent = this.db.donationIntents.find((row) => row.id === id);
      if (intent) {
        intent.donor_document_type = String(donorDocumentType);
        intent.donor_document = donorDocument == null ? null : String(donorDocument);
        intent.donor_name = donorName == null ? null : String(donorName);
        intent.donor_phone = donorPhone == null ? null : String(donorPhone);
        intent.direccion_departamento = direccionDepartamento == null ? null : String(direccionDepartamento);
        intent.direccion_municipio = direccionMunicipio == null ? null : String(direccionMunicipio);
        intent.direccion_distrito = direccionDistrito == null ? null : String(direccionDistrito);
        intent.direccion_complemento = direccionComplemento == null ? null : String(direccionComplemento);
        intent.donor_pais = donorPais == null ? null : String(donorPais);
        intent.updated_at = String(updatedAt);
      }
    }
    if (this.sql.includes("UPDATE donation_intents") && this.sql.includes("status = 'LINK_CREATED'")) {
      const [idEnlace, urlEnlace, urlEnlaceLargo, updatedAt, id] = this.args;
      const intent = this.db.donationIntents.find((row) => row.id === id);
      if (intent) {
        intent.wompi_id_enlace = Number(idEnlace);
        intent.wompi_url_enlace = String(urlEnlace);
        intent.wompi_url_enlace_largo = String(urlEnlaceLargo);
        intent.status = "LINK_CREATED";
        intent.updated_at = String(updatedAt);
      }
    }
    if (this.sql.includes("UPDATE donation_intents SET status = 'COMPLETED'")) {
      const [documentId, updatedAt, id] = this.args;
      const intent = this.db.donationIntents.find((row) => row.id === id);
      if (intent) {
        intent.status = "COMPLETED";
        intent.document_id = documentId == null ? null : String(documentId);
        intent.updated_at = String(updatedAt);
      }
    }
    if (this.sql.includes("UPDATE donation_intents") && this.sql.includes("SET paid_at = ?")) {
      const [paidAt, updatedAt, id, expectedLinkId] = this.args;
      const intent = this.db.donationIntents.find((row) => row.id === id);
      if (
        intent &&
        intent.wompi_id_enlace === expectedLinkId &&
        (intent.status === "LINK_CREATED" || intent.status === "EXPIRED") &&
        (intent.paid_at == null || intent.paid_at === "")
      ) {
        intent.paid_at = paidAt == null ? null : String(paidAt);
        intent.updated_at = String(updatedAt);
      }
    }
    if (this.sql.includes("UPDATE donation_intents SET status = 'EXPIRED'")) {
      const [updatedAt, secondArg] = this.args.map(String);
      // expireDonationIntentsByIds binds an id list; expireUnpaidIntentsBefore binds
      // the expiry cutoff. Route on the SQL shape so both paths are modeled.
      const ids = this.sql.includes("id IN") ? new Set(this.args.slice(1).map(String)) : null;
      for (const intent of this.db.donationIntents.filter((row) => {
        if (row.status !== "PENDING" && row.status !== "LINK_CREATED") {
          return false;
        }
        if (ids) {
          return ids.has(String(row.id));
        }
        return String(row.expires_at) < secondArg;
      })) {
        intent.status = "EXPIRED";
        intent.updated_at = updatedAt;
      }
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
        transmission_deferred_at: null,
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
    if (this.sql.includes("UPDATE wompi_events SET processed_at = ?")) {
      const [processedAt, wompiEventId] = this.args;
      const event = this.db.wompiEvents.find((row) => row.id === wompiEventId);
      if (event && !event.processed_at) {
        event.processed_at = processedAt;
      }
    }
    if (this.sql.includes("UPDATE wompi_events SET created_document_id")) {
      const [documentId, processedAt, wompiEventId] = this.args;
      const event = this.db.wompiEvents.find((row) => row.id === wompiEventId);
      if (event) {
        event.created_document_id = documentId;
        event.processed_at = processedAt;
      }
    }
    if (this.sql.includes("transmission_deferred_at = ?")) {
      // markDocumentTransmissionDeferred: SIGNED + deferral marker + MH_NO_DISPONIBLE.
      const [deferredAt, mhEstado, observacionesJson, updatedAt, documentId] = this.args;
      const document = this.db.documents.find((row) => row.id === documentId);
      if (document) {
        document.status = "SIGNED";
        document.transmission_deferred_at = String(deferredAt);
        document.sello_recibido = null;
        document.mh_estado = String(mhEstado);
        document.mh_observaciones_json = String(observacionesJson);
        document.updated_at = String(updatedAt);
      }
    }
    if (this.sql.includes("UPDATE dte_documents SET signed_jws = ?")) {
      // updateDocumentSigned: persists the JWS and flips the doc to SIGNED.
      const [signedJws, updatedAt, documentId] = this.args;
      const document = this.db.documents.find((row) => row.id === documentId);
      if (document) {
        document.signed_jws = String(signedJws);
        document.status = "SIGNED";
        document.updated_at = String(updatedAt);
      }
    }
    if (this.sql.includes("UPDATE dte_documents") && this.sql.includes("SET codigo_generacion = ?")) {
      const [codigoGeneracion, numeroControl, plainJson, signedJws, status, updatedAt, documentId] = this.args;
      const document = this.db.documents.find((row) => row.id === documentId);
      if (document) {
        document.codigo_generacion = String(codigoGeneracion);
        document.numero_control = String(numeroControl);
        document.plain_json = String(plainJson);
        document.signed_jws = signedJws === null ? null : String(signedJws);
        document.status = String(status);
        document.updated_at = String(updatedAt);
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
    if (
      this.sql.includes("UPDATE users") &&
      this.sql.includes("SET password_hash = ?, password_salt = ?, updated_at = ?") &&
      !this.sql.includes("RETURNING id")
    ) {
      const [passwordHash, passwordSalt, updatedAt, userId] = this.args;
      const user = this.db.users.find((row) => row.id === userId);
      if (this.sql.includes("FROM password_reset_tokens")) {
        const [, , , , tokenUserId, tokenHash, expiresAfter] = this.args;
        const activeToken = this.db.resetTokens.some(
          (row) =>
            row.user_id === tokenUserId &&
            row.token_hash === tokenHash &&
            !row.used_at &&
            String(row.expires_at) > String(expiresAfter)
        );
        if (user && !user.disabled_at && activeToken) {
          user.password_hash = passwordHash;
          user.password_salt = passwordSalt;
          user.updated_at = updatedAt;
          changes = 1;
        }
      } else if (user) {
        user.password_hash = passwordHash;
        user.password_salt = passwordSalt;
        user.updated_at = updatedAt;
        changes = 1;
      }
    }
    if (
      this.sql.includes("UPDATE sessions") &&
      this.sql.includes("SET revoked_at = ?") &&
      this.sql.includes("WHERE user_id = ?")
    ) {
      const [revokedAt, userId] = this.args;
      const marker = this.sql.includes("SELECT 1")
        ? this.db.users.some(
            (row) =>
              row.id === this.args[2] &&
              row.password_hash === this.args[3] &&
              row.password_salt === this.args[4] &&
              row.updated_at === this.args[5]
          )
        : true;
      if (marker) {
        for (const session of this.db.sessions.filter((row) => row.user_id === userId && !row.revoked_at)) {
          session.revoked_at = revokedAt;
          changes += 1;
        }
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
    return { success: true, meta: { changes }, results: [] };
  }
}

// Maps a retention-export SELECT's table name to its backing in-memory array,
// so the generic "ORDER BY created_at ASC, id ASC LIMIT ?" branch above can
// serve every table the retention service reads without one bespoke branch per table.
function retentionTableFor(db: InMemoryD1, sql: string): Array<Record<string, unknown>> | null {
  if (sql.includes("FROM dte_documents")) return db.documents as unknown as Array<Record<string, unknown>>;
  if (sql.includes("FROM donation_intents")) return db.donationIntents;
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
    transmission_deferred_at: null,
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
