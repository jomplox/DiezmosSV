import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { AuthService, hashForStorage, hashPassword } from "../../src/worker/services/auth";
import { Repository } from "../../src/worker/storage/repository";
import { utf8Bytes } from "../../src/worker/utils/encoding";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { migratedDatabase, migratedDatabaseThrough } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";
import { makeDocument as testDocument } from "./fixtures";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";
import { sha256Hex } from "./support/workerFetchHelpers";
import {
  executionContextCapturing,
  fetchAndWaitUntil
} from "./support/workerFetchRequests";

installWorkerFetchGlobals();

describe("public deployment identity", () => {
  it("returns both the environment and exact Worker script name", async () => {
    const response = await worker.fetch(
      new Request("https://example.org/api/health"),
      env(new InMemoryD1(), {
        APP_ENV: "staging",
        CLOUDFLARE_SCRIPT_NAME: "diezmos-sv-staging"
      })
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      appEnv: "staging",
      workerName: "diezmos-sv-staging"
    });
  });
});

describe("login step-up migration", () => {
  it("stores only bounded challenge hashes and exposes an expiry cleanup index", () => {
    const database = migratedDatabase();
    try {
      const table = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'login_step_up_challenges'")
        .get() as { sql: string } | undefined;
      expect(table, "migration 0045 must create the challenge table").toBeDefined();
      if (!table) return;

      const indexes = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'login_step_up_challenges'")
        .all()
        .map((row) => String((row as { name: string }).name));
      expect(indexes).toContain("idx_login_step_up_challenges_expires");

      const validHash = "a".repeat(64);
      database.prepare(
        `INSERT INTO login_step_up_challenges (
           id, user_id, continuation_token_hash, code_hash,
           expected_email, expected_auth_generation,
           expected_password_hash, expected_password_salt, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "challenge_valid",
        "user_operator",
        validHash,
        "b".repeat(64),
        "operator@example.org",
        0,
        "hash",
        "salt",
        "2026-07-04T12:10:00.000Z"
      );
      expect(
        database.prepare(
          "SELECT continuation_token_hash, code_hash, failed_attempts, consumed_at, invalidated_at FROM login_step_up_challenges"
        ).get()
      ).toEqual({
        continuation_token_hash: validHash,
        code_hash: "b".repeat(64),
        failed_attempts: 0,
        consumed_at: null,
        invalidated_at: null
      });
      expect(() => database.prepare(
        `INSERT INTO login_step_up_challenges (
           id, user_id, continuation_token_hash, code_hash,
           expected_email, expected_auth_generation,
           expected_password_hash, expected_password_salt, expires_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "challenge_plaintext",
        "user_operator",
        "continuation-token",
        "123456",
        "operator@example.org",
        0,
        "hash",
        "salt",
        "2026-07-04T12:10:00.000Z"
      )).toThrow(/CHECK constraint failed/);
    } finally {
      database.close();
    }
  });

  it("atomically consumes a valid SQLite challenge once and exhausts five wrong attempts", async () => {
    const database = migratedDatabase();
    try {
      const repo = new Repository(sqliteD1(database));
      const snapshot = {
        userId: "user_operator",
        expectedEmail: "operator@example.org",
        expectedAuthGeneration: 0,
        expectedPasswordHash: "hash",
        expectedPasswordSalt: "salt"
      };
      const firstId = await repo.createLoginStepUpChallenge({
        ...snapshot,
        continuationTokenHash: "a".repeat(64),
        codeHash: "b".repeat(64),
        expiresAt: "2026-07-04T12:10:00.000Z"
      });
      expect(firstId).toMatch(/^login_mfa_/);

      const consumed = await repo.consumeLoginStepUpChallenge({
        challengeId: firstId!,
        continuationTokenHash: "a".repeat(64),
        codeHash: "b".repeat(64),
        now: "2026-07-04T12:00:00.000Z",
        maxWrongAttempts: 5
      });
      expect(consumed).toMatchObject(snapshot);
      await expect(repo.consumeLoginStepUpChallenge({
        challengeId: firstId!,
        continuationTokenHash: "a".repeat(64),
        codeHash: "b".repeat(64),
        now: "2026-07-04T12:00:00.000Z",
        maxWrongAttempts: 5
      })).resolves.toBeNull();

      const exhaustedId = await repo.createLoginStepUpChallenge({
        ...snapshot,
        continuationTokenHash: "c".repeat(64),
        codeHash: "d".repeat(64),
        expiresAt: "2026-07-04T12:10:00.000Z"
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(repo.incrementLoginStepUpFailure({
          challengeId: exhaustedId!,
          continuationTokenHash: "c".repeat(64),
          submittedCodeHash: "e".repeat(64),
          now: "2026-07-04T12:00:00.000Z",
          maxWrongAttempts: 5
        })).resolves.toBe(true);
      }
      await expect(repo.incrementLoginStepUpFailure({
        challengeId: exhaustedId!,
        continuationTokenHash: "c".repeat(64),
        submittedCodeHash: "e".repeat(64),
        now: "2026-07-04T12:00:00.000Z",
        maxWrongAttempts: 5
      })).resolves.toBe(false);
      await expect(repo.consumeLoginStepUpChallenge({
        challengeId: exhaustedId!,
        continuationTokenHash: "c".repeat(64),
        codeHash: "d".repeat(64),
        now: "2026-07-04T12:00:00.000Z",
        maxWrongAttempts: 5
      })).resolves.toBeNull();
    } finally {
      database.close();
    }
  });

  it("atomically caps cumulative SQLite guesses across active reissued challenges", async () => {
    const database = migratedDatabase();
    try {
      const repo = new Repository(sqliteD1(database));
      const snapshot = {
        userId: "user_operator",
        expectedEmail: "operator@example.org",
        expectedAuthGeneration: 0,
        expectedPasswordHash: "hash",
        expectedPasswordSalt: "salt"
      };
      const firstId = await repo.createLoginStepUpChallenge({
        ...snapshot,
        continuationTokenHash: "1".repeat(64),
        codeHash: "2".repeat(64),
        expiresAt: "2026-07-04T12:10:00.000Z"
      });
      const secondId = await repo.createLoginStepUpChallenge({
        ...snapshot,
        continuationTokenHash: "3".repeat(64),
        codeHash: "4".repeat(64),
        expiresAt: "2026-07-04T12:10:00.000Z"
      });

      const attempts = await Promise.all(
        Array.from({ length: 6 }, (_, index) => repo.incrementLoginStepUpFailure({
          challengeId: index % 2 === 0 ? firstId! : secondId!,
          continuationTokenHash: (index % 2 === 0 ? "1" : "3").repeat(64),
          submittedCodeHash: "5".repeat(64),
          now: "2026-07-04T12:00:00.000Z",
          maxWrongAttempts: 5
        }))
      );

      expect(attempts.filter(Boolean)).toHaveLength(5);
      expect(database.prepare(
        "SELECT SUM(failed_attempts) AS attempts FROM login_step_up_challenges WHERE consumed_at IS NULL AND invalidated_at IS NULL"
      ).get()).toEqual({ attempts: 5 });
      await expect(repo.consumeLoginStepUpChallenge({
        challengeId: secondId!,
        continuationTokenHash: "3".repeat(64),
        codeHash: "4".repeat(64),
        now: "2026-07-04T12:00:00.000Z",
        maxWrongAttempts: 5
      })).resolves.toBeNull();

      const afterExpiryId = await repo.createLoginStepUpChallenge({
        ...snapshot,
        continuationTokenHash: "6".repeat(64),
        codeHash: "7".repeat(64),
        expiresAt: "2026-07-04T12:20:00.000Z"
      });
      await expect(repo.consumeLoginStepUpChallenge({
        challengeId: afterExpiryId!,
        continuationTokenHash: "6".repeat(64),
        codeHash: "7".repeat(64),
        now: "2026-07-04T12:10:00.001Z",
        maxWrongAttempts: 5
      })).resolves.toMatchObject(snapshot);
    } finally {
      database.close();
    }
  });
});

describe("provider creation budget migration", () => {
  const migrationPath = resolve(
    import.meta.dirname,
    "../../migrations/0046_provider_creation_budgets.sql"
  );

  it("installs the checked provider ledger, count indexes, and parent evidence columns", () => {
    const database = migratedDatabase();
    try {
      const table = database.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'provider_creation_claims'"
      ).get() as { sql: string } | undefined;
      expect(table, "migration 0046 must create the provider claim ledger").toBeDefined();
      if (!table) return;

      const indexes = database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'provider_creation_claims'"
      ).all().map((row) => String((row as { name: string }).name));
      expect(indexes).toEqual(expect.arrayContaining([
        "idx_provider_creation_claims_client_claimed",
        "idx_provider_creation_claims_provider_claimed",
        "idx_provider_creation_claims_global_claimed",
        "idx_provider_creation_claims_expires",
        "idx_provider_creation_claims_stripe_request"
      ]));

      expect(database.prepare("PRAGMA table_info(donation_intents)").all())
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "provider_creation_claim_id" })]));
      expect(database.prepare("PRAGMA table_info(stripe_checkout_sessions)").all())
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "provider_creation_claim_id" })]));
      expect(database.prepare("PRAGMA foreign_key_list(donation_intents)").all())
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ from: "provider_creation_claim_id" })]));
      expect(database.prepare("PRAGMA foreign_key_list(stripe_checkout_sessions)").all())
        .not.toEqual(expect.arrayContaining([expect.objectContaining({ from: "provider_creation_claim_id" })]));

      expect(() => database.prepare(
        `INSERT INTO provider_creation_claims (
           id, provider, client_key_hash, stripe_request_id, claimed_at, expires_at
         ) VALUES ('bad_provider', 'PAYPAL', 'client', NULL, '2026-07-04T12:00:00.000Z', '2026-07-04T12:15:00.000Z')`
      ).run()).toThrow(/CHECK constraint failed/);

      expect(() => database.prepare(
        `INSERT INTO provider_creation_claims (
           id, provider, client_key_hash, stripe_request_id, claimed_at, expires_at
         ) VALUES ('bad_wompi_request', 'WOMPI', 'client', 'request-one', '2026-07-04T12:00:00.000Z', '2026-07-04T12:15:00.000Z')`
      ).run()).toThrow(/CHECK constraint failed/);

      expect(() => database.prepare(
        `INSERT INTO provider_creation_claims (
           id, provider, client_key_hash, stripe_request_id, claimed_at, expires_at
         ) VALUES ('bad_stripe_request', 'STRIPE', 'client', NULL, '2026-07-04T12:00:00.000Z', '2026-07-04T12:15:00.000Z')`
      ).run()).toThrow(/CHECK constraint failed/);

      database.prepare(
        `INSERT INTO provider_creation_claims (
           id, provider, client_key_hash, stripe_request_id, claimed_at, expires_at
         ) VALUES (?, 'STRIPE', ?, ?, ?, ?)`
      ).run(
        "stripe_claim_one",
        "client-one",
        "request-one",
        "2026-07-04T12:00:00.000Z",
        "2026-07-04T12:15:00.000Z"
      );
      expect(() => database.prepare(
        `INSERT INTO provider_creation_claims (
           id, provider, client_key_hash, stripe_request_id, claimed_at, expires_at
         ) VALUES (?, 'STRIPE', ?, ?, ?, ?)`
      ).run(
        "stripe_claim_two",
        "client-two",
        "request-one",
        "2026-07-04T12:00:00.000Z",
        "2026-07-04T12:15:00.000Z"
      )).toThrow(/UNIQUE constraint failed/);
    } finally {
      database.close();
    }
  });

  it("upgrades an exact 0045 database through additive 0046", () => {
    expect(existsSync(migrationPath), "migration 0046 exists").toBe(true);
    if (!existsSync(migrationPath)) return;
    const database = migratedDatabaseThrough("0045");
    try {
      expect(database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_creation_claims'"
      ).get()).toBeUndefined();

      database.exec(readFileSync(migrationPath, "utf8"));

      expect(database.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'provider_creation_claims'"
      ).get()).toEqual({ name: "provider_creation_claims" });
      expect(database.prepare("PRAGMA table_info(donation_intents)").all())
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "provider_creation_claim_id" })]));
      expect(database.prepare("PRAGMA table_info(stripe_checkout_sessions)").all())
        .toEqual(expect.arrayContaining([expect.objectContaining({ name: "provider_creation_claim_id" })]));
    } finally {
      database.close();
    }
  });
});

describe("provider creation budget repository", () => {
  const now = "2026-07-04T12:00:00.000Z";
  const cutoff = "2026-07-04T11:45:00.000Z";
  const expiresAt = "2026-07-04T12:15:00.000Z";

  it("atomically caps concurrent SQLite claims at injected client, provider, and global ceilings", async () => {
    const clientDatabase = migratedDatabase();
    const providerDatabase = migratedDatabase();
    const globalDatabase = migratedDatabase();
    try {
      const clientRepo = new Repository(sqliteD1(clientDatabase));
      const clientClaims = await Promise.all(Array.from({ length: 20 }, () =>
        claimProviderCreationBudgetForTest(clientRepo, {
          provider: "WOMPI",
          clientKeyHash: "same-client",
          stripeRequestId: null,
          now,
          cutoff,
          expiresAt,
          clientLimit: 2,
          providerLimit: 20,
          globalLimit: 20
        })
      ));
      expect(clientClaims.filter((claim) => claim.kind === "CLAIMED")).toHaveLength(2);

      const providerRepo = new Repository(sqliteD1(providerDatabase));
      const providerClaims = await Promise.all(Array.from({ length: 20 }, (_, index) =>
        claimProviderCreationBudgetForTest(providerRepo, {
          provider: "STRIPE",
          clientKeyHash: `provider-client-${index}`,
          stripeRequestId: `provider-request-${index}`,
          now,
          cutoff,
          expiresAt,
          clientLimit: 20,
          providerLimit: 3,
          globalLimit: 20
        })
      ));
      expect(providerClaims.filter((claim) => claim.kind === "CLAIMED")).toHaveLength(3);

      const globalRepo = new Repository(sqliteD1(globalDatabase));
      const globalClaims = await Promise.all(Array.from({ length: 20 }, (_, index) =>
        claimProviderCreationBudgetForTest(globalRepo, {
          provider: index % 2 === 0 ? "WOMPI" : "STRIPE",
          clientKeyHash: `global-client-${index}`,
          stripeRequestId: index % 2 === 0 ? null : `global-request-${index}`,
          now,
          cutoff,
          expiresAt,
          clientLimit: 20,
          providerLimit: 20,
          globalLimit: 4
        })
      ));
      expect(globalClaims.filter((claim) => claim.kind === "CLAIMED")).toHaveLength(4);
    } finally {
      clientDatabase.close();
      providerDatabase.close();
      globalDatabase.close();
    }
  });

  it("matches the atomic low-ceiling behavior in the in-memory D1 emulator", async () => {
    const db = new InMemoryD1();
    const repo = new Repository(db as unknown as D1Database);
    const claims = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      claimProviderCreationBudgetForTest(repo, {
        provider: index % 2 === 0 ? "WOMPI" : "STRIPE",
        clientKeyHash: `memory-client-${index}`,
        stripeRequestId: index % 2 === 0 ? null : `memory-request-${index}`,
        now,
        cutoff,
        expiresAt,
        clientLimit: 20,
        providerLimit: 20,
        globalLimit: 4
      })
    ));

    expect(claims.filter((claim) => claim.kind === "CLAIMED")).toHaveLength(4);
    expect(providerClaimsFrom(db)).toHaveLength(4);
  });

  it("releases only unused claims and preserves attached Wompi and Stripe evidence", async () => {
    const database = migratedDatabase();
    try {
      const repo = new Repository(sqliteD1(database));
      const unused = await claimProviderCreationBudgetForTest(repo, {
        provider: "WOMPI",
        clientKeyHash: "unused-client",
        stripeRequestId: null,
        now,
        cutoff,
        expiresAt,
        clientLimit: 20,
        providerLimit: 20,
        globalLimit: 20
      });
      expect(unused.kind).toBe("CLAIMED");
      if (unused.kind !== "CLAIMED") return;
      await releaseProviderCreationClaimForTest(repo, unused.id);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM provider_creation_claims WHERE id = ?"
      ).get(unused.id)).toEqual({ count: 0 });

      const wompi = await claimProviderCreationBudgetForTest(repo, {
        provider: "WOMPI",
        clientKeyHash: "wompi-attached-client",
        stripeRequestId: null,
        now,
        cutoff,
        expiresAt,
        clientLimit: 20,
        providerLimit: 20,
        globalLimit: 20
      });
      const stripe = await claimProviderCreationBudgetForTest(repo, {
        provider: "STRIPE",
        clientKeyHash: "stripe-attached-client",
        stripeRequestId: "stripe-attached-request",
        now,
        cutoff,
        expiresAt,
        clientLimit: 20,
        providerLimit: 20,
        globalLimit: 20
      });
      expect(wompi.kind).toBe("CLAIMED");
      expect(stripe.kind).toBe("CLAIMED");
      if (wompi.kind !== "CLAIMED" || stripe.kind !== "CLAIMED") return;

      database.prepare(
        `INSERT INTO donation_intents (
           id, status, amount_cents, donor_document_type, client_ip, expires_at,
           provider_creation_claim_id, created_at, updated_at
         ) VALUES (?, 'PENDING', 1000, '13', '203.0.113.1', ?, ?, ?, ?)`
      ).run("attached_wompi", expiresAt, wompi.id, now, now);
      database.prepare(
        `INSERT INTO stripe_checkout_sessions (
           id, request_id, request_fingerprint, frequency, gift_type, amount_cents,
           currency, livemode, status, payment_status, provider_creation_claim_id,
           created_at, updated_at
         ) VALUES (?, ?, 'v2:test', 'ONCE', 'TITHE', 1000,
                   'usd', 0, 'CREATING', 'UNPAID', ?, ?, ?)`
      ).run("attached_stripe", "attached-stripe-request", stripe.id, now, now);

      await releaseProviderCreationClaimForTest(repo, wompi.id);
      await releaseProviderCreationClaimForTest(repo, stripe.id);
      expect(database.prepare(
        "SELECT COUNT(*) AS count FROM provider_creation_claims WHERE id IN (?, ?)"
      ).get(wompi.id, stripe.id)).toEqual({ count: 2 });
    } finally {
      database.close();
    }
  });

  it("counts unattributed legacy parents globally without double-counting attached parents", async () => {
    const legacyDatabase = migratedDatabase();
    const attachedDatabase = migratedDatabase();
    try {
      legacyDatabase.prepare(
        `INSERT INTO donation_intents (
           id, status, amount_cents, donor_document_type, client_ip, expires_at,
           created_at, updated_at
         ) VALUES ('legacy_wompi', 'PENDING', 1000, '13', '198.51.100.1', ?, ?, ?)`
      ).run(expiresAt, now, now);
      legacyDatabase.prepare(
        `INSERT INTO stripe_checkout_sessions (
           id, request_id, request_fingerprint, frequency, gift_type, amount_cents,
           currency, livemode, status, payment_status, created_at, updated_at
         ) VALUES ('legacy_stripe', 'legacy-stripe-request', 'v2:legacy', 'ONCE', 'TITHE',
                   1000, 'usd', 0, 'CREATING', 'UNPAID', ?, ?)`
      ).run(now, now);
      const legacyRepo = new Repository(sqliteD1(legacyDatabase));
      const legacyStripeProviderClaim = await claimProviderCreationBudgetForTest(legacyRepo, {
        provider: "STRIPE",
        clientKeyHash: "legacy-stripe-provider-client",
        stripeRequestId: "fresh-stripe-request",
        now,
        cutoff,
        expiresAt,
        clientLimit: 20,
        providerLimit: 1,
        globalLimit: 20
      });
      expect(legacyStripeProviderClaim).toEqual({ kind: "LIMITED" });

      const legacyClaim = await claimProviderCreationBudgetForTest(legacyRepo, {
          provider: "WOMPI",
          clientKeyHash: "legacy-global-client",
          stripeRequestId: null,
          now,
          cutoff,
          expiresAt,
          clientLimit: 20,
          providerLimit: 20,
          globalLimit: 2
      });
      expect(legacyClaim).toEqual({ kind: "LIMITED" });

      const attachedRepo = new Repository(sqliteD1(attachedDatabase));
      const first = await claimProviderCreationBudgetForTest(attachedRepo, {
        provider: "WOMPI",
        clientKeyHash: "attached-global-one",
        stripeRequestId: null,
        now,
        cutoff,
        expiresAt,
        clientLimit: 20,
        providerLimit: 20,
        globalLimit: 2
      });
      expect(first.kind).toBe("CLAIMED");
      if (first.kind !== "CLAIMED") return;
      attachedDatabase.prepare(
        `INSERT INTO donation_intents (
           id, status, amount_cents, donor_document_type, client_ip, expires_at,
           provider_creation_claim_id, created_at, updated_at
         ) VALUES ('attached_global_wompi', 'PENDING', 1000, '13', '198.51.100.2', ?, ?, ?, ?)`
      ).run(expiresAt, first.id, now, now);
      const second = await claimProviderCreationBudgetForTest(attachedRepo, {
        provider: "STRIPE",
        clientKeyHash: "attached-global-two",
        stripeRequestId: "attached-global-request",
        now,
        cutoff,
        expiresAt,
        clientLimit: 20,
        providerLimit: 20,
        globalLimit: 2
      });
      expect(second.kind).toBe("CLAIMED");
    } finally {
      legacyDatabase.close();
      attachedDatabase.close();
    }
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

describe("public auth mutation admission", () => {
  it.each([
    ["login", "https://example.org/api/auth/login", undefined],
    ["bootstrap", "https://example.org/api/auth/bootstrap-owner", `bt_${"A".repeat(43)}`]
  ] as const)("rejects cross-site simple %s requests before spending an IP budget", async (_name, url, bootstrapToken) => {
    const db = new InMemoryD1();
    const headers = new Headers({
      "Content-Type": "text/plain;charset=UTF-8",
      Origin: "https://attacker.example",
      "Sec-Fetch-Site": "cross-site",
      "CF-Connecting-IP": "203.0.113.80"
    });
    if (bootstrapToken) headers.set("X-Bootstrap-Owner-Token", bootstrapToken);

    const response = await worker.fetch(
      new Request(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          email: "attacker@example.org",
          name: "Attacker",
          password: "Long-enough1!"
        })
      }),
      env(db, { BOOTSTRAP_OWNER_TOKEN: VALID_BOOTSTRAP_TOKEN })
    );

    expect(response.status).toBe(415);
    expect(db.loginRateLimits.size).toBe(0);
    expect(db.users).toHaveLength(0);
    expect(db.audits).toHaveLength(0);
  });

  it("rejects a mismatched login origin before spending an IP budget", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      new Request("https://example.org/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://attacker.example",
          "CF-Connecting-IP": "203.0.113.81"
        },
        body: JSON.stringify({ email: "attacker@example.org", password: "Long-enough1!" })
      }),
      env(db)
    );

    expect(response.status).toBe(403);
    expect(db.loginRateLimits.size).toBe(0);
    expect(db.loginCredentialReads).toBe(0);
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
    expect(db.loginRateLimits.size).toBe(0);
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
    expect(db.loginRateLimits.size).toBe(1);
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
            "Content-Type": "application/json",
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

  function loginRequestFrom(email: string, password: string, ip: string) {
    return new Request("https://example.org/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
      body: JSON.stringify({ email, password })
    });
  }

  function loginMfaRequest(input: { challengeId: string; continuationToken: string; code: string }) {
    return new Request("https://example.org/api/auth/login/mfa", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
  }

  function seedDistributedFailures(db: InMemoryD1, email: string, count = 5): void {
    for (let index = 0; index < count; index += 1) {
      seedAudit(
        db,
        "LOGIN_FAILED",
        email,
        `2026-07-04T11:${50 + index}:00.000Z`,
        `203.0.113.${index + 10}`
      );
    }
  }

  async function seedStepUpAccount(
    db: InMemoryD1,
    email = "operator@example.org",
    password = "Valid#Pass2026"
  ): Promise<void> {
    const hashed = await hashPassword(password, "fixed-salt", { enforcePolicy: false });
    db.users.push({
      id: "user_operator",
      email,
      name: "Operator",
      role: "OPERATOR",
      password_hash: hashed.hash,
      password_salt: hashed.salt,
      auth_generation: 0,
      disabled_at: ""
    });
    seedDistributedFailures(db, email);
  }

  function stepUpEmailRuntime(
    db: InMemoryD1,
    sentMessages: unknown[],
    send?: (message: unknown) => Promise<{ messageId: string }>
  ) {
    return env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "security@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          sentMessages.push(message);
          return send ? send(message) : { messageId: "login-step-up-code" };
        }
      } as SendEmail
    });
  }

  function codeFromMessage(message: unknown): string {
    return String((message as { text?: string }).text).match(/\b(\d{6})\b/)?.[1] ?? "";
  }

  function differentCode(code: string): string {
    return code === "000000" ? "000001" : "000000";
  }

  async function seededStepUp(input: {
    db: InMemoryD1;
    email?: string;
    password?: string;
    send?: (message: unknown) => Promise<{ messageId: string }>;
  }) {
    const email = input.email ?? "operator@example.org";
    const password = input.password ?? "Valid#Pass2026";
    await seedStepUpAccount(input.db, email, password);
    const sentMessages: unknown[] = [];
    const response = await worker.fetch(
      loginRequestFrom(email, password, "198.51.100.90"),
      stepUpEmailRuntime(input.db, sentMessages, input.send)
    );
    return { response, sentMessages };
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
    }, 30_000);

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
      const providerClaims = providerClaimsFrom(db);
      providerClaims.push({
        id: "expired-provider-claim",
        provider: "WOMPI",
        client_key_hash: "expired-provider-hash",
        stripe_request_id: null,
        claimed_at: "2026-07-04T11:00:00.000Z",
        expires_at: "2026-07-04T11:15:00.000Z"
      });
      db.loginStepUpChallenges.push({
        id: "login_mfa_expired",
        user_id: "user_expired",
        continuation_token_hash: "a".repeat(64),
        code_hash: "b".repeat(64),
        expected_email: "expired@example.org",
        expected_auth_generation: 0,
        expected_password_hash: "hash",
        expected_password_salt: "salt",
        expires_at: "2026-07-04T11:15:00.000Z",
        failed_attempts: 0,
        consumed_at: null,
        invalidated_at: null,
        created_at: "2026-07-04T11:00:00.000Z"
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
      expect(providerClaims).toHaveLength(0);
      expect(db.loginStepUpChallenges).toHaveLength(0);
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
    }, 30_000);
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

  it("requires a non-locking email step-up after distributed account failures", async () => {
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
    db.auditCreatedAt = "2026-07-04T11:59:00.000Z";
    for (let index = 0; index < 5; index += 1) {
      const failed = await worker.fetch(
        loginRequestFrom(
          "victim@example.org",
          "Wrong#Pass2026",
          `203.0.113.${index + 10}`
        ),
        env(db)
      );
      expect(failed.status).toBe(401);
    }
    const sentMessages: unknown[] = [];

    // Correct credentials from a fresh IP are not locked out, but they also must not
    // mint a session until the emailed one-time code is completed.
    const response = await worker.fetch(
      loginRequestFrom("victim@example.org", "Valid#Pass2026", "198.51.100.4"),
      env(db, {
        MOCK_EXTERNAL_SERVICES: "false",
        EMAIL_FROM: "security@example.org",
        EMAIL: {
          send: async (message: unknown) => {
            sentMessages.push(message);
            return { messageId: "login-step-up-code" };
          }
        } as SendEmail
      })
    );

    expect(response.status).toBe(202);
    const challenge = await response.json() as Record<string, unknown>;
    expect(challenge).toMatchObject({
      mfaRequired: true,
      challengeId: expect.any(String),
      continuationToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: "2026-07-04T12:10:00.000Z"
    });
    expect(challenge).not.toHaveProperty("token");
    expect(challenge).not.toHaveProperty("user");
    expect(db.sessions).toHaveLength(0);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({ to: "victim@example.org" });
    expect(String((sentMessages[0] as { text?: string }).text)).toMatch(/\b\d{6}\b/);
    expect(db.audits).not.toContainEqual(expect.objectContaining({ action: "LOGIN", entity_id: "user_victim" }));
  });

  it("atomically caps concurrent challenge issuance across rotating IPs without creating a session", async () => {
    const db = new InMemoryD1();
    await seedStepUpAccount(db);
    const currentStoredPassword = await hashForStorage("Valid#Pass2026", { enforcePolicy: false });
    db.users[0].password_hash = currentStoredPassword.hash;
    db.users[0].password_salt = currentStoredPassword.salt;
    const sentMessages: unknown[] = [];
    const runtime = stepUpEmailRuntime(db, sentMessages);

    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) => worker.fetch(
        loginRequestFrom("operator@example.org", "Valid#Pass2026", `198.51.100.${100 + index}`),
        runtime
      ))
    );

    expect(responses.map((response) => response.status).sort()).toEqual([202, 202, 202, 202, 202, 503]);
    const limited = responses.find((response) => response.status === 503);
    await expect(limited?.json()).resolves.toEqual({
      error: "login_mfa_unavailable",
      message: "No se pudo enviar el código de verificación. Intente de nuevo en unos minutos."
    });
    expect(db.loginStepUpChallenges).toHaveLength(5);
    expect(sentMessages).toHaveLength(5);
    expect(db.sessions).toHaveLength(0);
    expect(db.audits.filter((audit) => audit.action === "LOGIN_FAILED")).toHaveLength(5);
    expect([...db.loginRateLimits.values()].filter((row) => row.attempt_count === 5)).toHaveLength(1);

    const auditJson = JSON.stringify(db.audits);
    for (const response of responses.filter((candidate) => candidate.status === 202)) {
      const challenge = await response.json() as { continuationToken: string };
      expect(auditJson).not.toContain(challenge.continuationToken);
    }
    for (const message of sentMessages) {
      expect(auditJson).not.toContain(codeFromMessage(message));
    }

    db.users[0].auth_generation = 1;
    const afterGenerationChange = await worker.fetch(
      loginRequestFrom("operator@example.org", "Valid#Pass2026", "198.51.100.106"),
      runtime
    );
    expect(afterGenerationChange.status).toBe(202);
    expect(sentMessages).toHaveLength(6);
    expect(db.loginStepUpChallenges).toHaveLength(6);
    expect(db.sessions).toHaveLength(0);
  });

  it("shares one five-guess budget across concurrent submissions to multiple active challenges", async () => {
    const db = new InMemoryD1();
    await seedStepUpAccount(db);
    const sentMessages: unknown[] = [];
    const runtime = stepUpEmailRuntime(db, sentMessages);
    const issuedResponses = [
      await worker.fetch(loginRequestFrom("operator@example.org", "Valid#Pass2026", "198.51.100.110"), runtime),
      await worker.fetch(loginRequestFrom("operator@example.org", "Valid#Pass2026", "198.51.100.111"), runtime)
    ];
    const challenges = await Promise.all(issuedResponses.map((response) => response.json())) as Array<{
      challengeId: string;
      continuationToken: string;
    }>;
    const codes = sentMessages.map(codeFromMessage);

    const wrongResponses = await Promise.all(
      Array.from({ length: 6 }, (_, index) => {
        const challengeIndex = index % 2;
        return worker.fetch(loginMfaRequest({
          ...challenges[challengeIndex],
          code: differentCode(codes[challengeIndex])
        }), env(db));
      })
    );

    expect(wrongResponses.every((response) => response.status === 400)).toBe(true);
    expect(db.loginStepUpChallenges.reduce((sum, challenge) => sum + challenge.failed_attempts, 0)).toBe(5);
    const correctAfterExhaustion = await worker.fetch(
      loginMfaRequest({ ...challenges[1], code: codes[1] }),
      env(db)
    );
    expect(correctAfterExhaustion.status).toBe(400);
    expect(db.sessions).toHaveLength(0);
  });

  it("does not regain code guesses by exhausting one challenge and reissuing another", async () => {
    const db = new InMemoryD1();
    await seedStepUpAccount(db);
    const sentMessages: unknown[] = [];
    const runtime = stepUpEmailRuntime(db, sentMessages);
    const firstResponse = await worker.fetch(
      loginRequestFrom("operator@example.org", "Valid#Pass2026", "198.51.100.120"),
      runtime
    );
    const first = await firstResponse.json() as { challengeId: string; continuationToken: string };
    const firstCode = codeFromMessage(sentMessages[0]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await worker.fetch(
        loginMfaRequest({ ...first, code: differentCode(firstCode) }),
        env(db)
      );
      expect(wrong.status).toBe(400);
    }

    const secondResponse = await worker.fetch(
      loginRequestFrom("operator@example.org", "Valid#Pass2026", "198.51.100.121"),
      runtime
    );
    expect(secondResponse.status).toBe(202);
    const second = await secondResponse.json() as { challengeId: string; continuationToken: string };
    const secondCode = codeFromMessage(sentMessages[1]);
    const bypass = await worker.fetch(loginMfaRequest({ ...second, code: secondCode }), env(db));

    expect(bypass.status).toBe(400);
    expect(db.sessions).toHaveLength(0);
  });

  it("resets the aggregate guess budget only after expiry or a new auth generation", async () => {
    const expiredDb = new InMemoryD1();
    const expiredIssued = await seededStepUp({ db: expiredDb });
    const expiredChallenge = await expiredIssued.response.json() as { challengeId: string; continuationToken: string };
    const expiredCode = codeFromMessage(expiredIssued.sentMessages[0]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await worker.fetch(loginMfaRequest({ ...expiredChallenge, code: differentCode(expiredCode) }), env(expiredDb));
    }
    vi.setSystemTime(new Date("2026-07-04T12:10:00.001Z"));
    for (let index = 0; index < 5; index += 1) {
      seedAudit(
        expiredDb,
        "LOGIN_FAILED",
        "operator@example.org",
        `2026-07-04T12:0${5 + index}:00.000Z`,
        `203.0.113.${30 + index}`
      );
    }
    const freshMessages: unknown[] = [];
    const freshRuntime = stepUpEmailRuntime(expiredDb, freshMessages);
    const freshResponse = await worker.fetch(
      loginRequestFrom("operator@example.org", "Valid#Pass2026", "198.51.100.130"),
      freshRuntime
    );
    expect(freshResponse.status).toBe(202);
    const freshChallenge = await freshResponse.json() as { challengeId: string; continuationToken: string };
    const afterExpiry = await worker.fetch(
      loginMfaRequest({ ...freshChallenge, code: codeFromMessage(freshMessages[0]) }),
      env(expiredDb)
    );
    expect(afterExpiry.status).toBe(200);

    vi.setSystemTime(new Date("2026-07-04T12:00:00.000Z"));
    const generationDb = new InMemoryD1();
    const generationIssued = await seededStepUp({ db: generationDb });
    const generationChallenge = await generationIssued.response.json() as { challengeId: string; continuationToken: string };
    const generationCode = codeFromMessage(generationIssued.sentMessages[0]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await worker.fetch(loginMfaRequest({ ...generationChallenge, code: differentCode(generationCode) }), env(generationDb));
    }
    generationDb.users[0].auth_generation = 1;
    const nextGenerationMessages: unknown[] = [];
    const nextGenerationRuntime = stepUpEmailRuntime(generationDb, nextGenerationMessages);
    const nextGenerationResponse = await worker.fetch(
      loginRequestFrom("operator@example.org", "Valid#Pass2026", "198.51.100.131"),
      nextGenerationRuntime
    );
    expect(nextGenerationResponse.status).toBe(202);
    const nextGenerationChallenge = await nextGenerationResponse.json() as { challengeId: string; continuationToken: string };
    const afterGenerationChange = await worker.fetch(
      loginMfaRequest({ ...nextGenerationChallenge, code: codeFromMessage(nextGenerationMessages[0]) }),
      env(generationDb)
    );
    expect(afterGenerationChange.status).toBe(200);
  });

  it("completes the emailed challenge once and rejects a replay generically", async () => {
    const db = new InMemoryD1();
    const { response, sentMessages } = await seededStepUp({ db });
    expect(response.status).toBe(202);
    const challenge = await response.json() as {
      challengeId: string;
      continuationToken: string;
    };
    const code = String((sentMessages[0] as { text?: string }).text).match(/\b(\d{6})\b/)?.[1];
    expect(code).toMatch(/^\d{6}$/);

    const completed = await worker.fetch(loginMfaRequest({ ...challenge, code: code! }), env(db));
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toMatchObject({
      user: { id: "user_operator", email: "operator@example.org", role: "OPERATOR" },
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      expiresAt: "2026-07-05T12:00:00.000Z"
    });
    expect(db.sessions).toHaveLength(1);
    expect(db.audits).toContainEqual(expect.objectContaining({ action: "LOGIN", entity_id: "user_operator" }));

    const replay = await worker.fetch(loginMfaRequest({ ...challenge, code: code! }), env(db));
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toEqual({
      error: "invalid_login_mfa_challenge",
      message: "El código no es válido o ya expiró. Inicie sesión nuevamente."
    });
    expect(db.sessions).toHaveLength(1);
  });

  it("bounds wrong codes at five attempts and then rejects the correct code generically", async () => {
    const db = new InMemoryD1();
    const { response, sentMessages } = await seededStepUp({ db });
    const challenge = await response.json() as { challengeId: string; continuationToken: string };
    const code = String((sentMessages[0] as { text?: string }).text).match(/\b(\d{6})\b/)?.[1] ?? "";
    const wrongCode = code === "000000" ? "000001" : "000000";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await worker.fetch(loginMfaRequest({ ...challenge, code: wrongCode }), env(db));
      expect(wrong.status).toBe(400);
      await expect(wrong.json()).resolves.toMatchObject({ error: "invalid_login_mfa_challenge" });
    }
    const exhausted = await worker.fetch(loginMfaRequest({ ...challenge, code }), env(db));
    expect(exhausted.status).toBe(400);
    await expect(exhausted.json()).resolves.toMatchObject({ error: "invalid_login_mfa_challenge" });
    expect(db.sessions).toHaveLength(0);
  });

  it("allows only one concurrent completion to create a session", async () => {
    const db = new InMemoryD1();
    const { response, sentMessages } = await seededStepUp({ db });
    const challenge = await response.json() as { challengeId: string; continuationToken: string };
    const code = String((sentMessages[0] as { text?: string }).text).match(/\b(\d{6})\b/)?.[1] ?? "";

    const completions = await Promise.all([
      worker.fetch(loginMfaRequest({ ...challenge, code }), env(db)),
      worker.fetch(loginMfaRequest({ ...challenge, code }), env(db))
    ]);

    expect(completions.map((result) => result.status).sort()).toEqual([200, 400]);
    expect(db.sessions).toHaveLength(1);
  });

  it("rejects expired and credential-stale challenges without creating a session", async () => {
    const expiredDb = new InMemoryD1();
    const expiredIssued = await seededStepUp({ db: expiredDb });
    const expiredChallenge = await expiredIssued.response.json() as { challengeId: string; continuationToken: string };
    const expiredCode = String((expiredIssued.sentMessages[0] as { text?: string }).text).match(/\b(\d{6})\b/)?.[1] ?? "";
    vi.setSystemTime(new Date("2026-07-04T12:10:00.001Z"));
    const expired = await worker.fetch(loginMfaRequest({ ...expiredChallenge, code: expiredCode }), env(expiredDb));
    expect(expired.status).toBe(400);
    expect(expiredDb.sessions).toHaveLength(0);

    vi.setSystemTime(new Date("2026-07-04T12:00:00.000Z"));
    const changedDb = new InMemoryD1();
    const changedIssued = await seededStepUp({ db: changedDb });
    const changedChallenge = await changedIssued.response.json() as { challengeId: string; continuationToken: string };
    const changedCode = String((changedIssued.sentMessages[0] as { text?: string }).text).match(/\b(\d{6})\b/)?.[1] ?? "";
    changedDb.users[0].auth_generation = 1;
    const changed = await worker.fetch(loginMfaRequest({ ...changedChallenge, code: changedCode }), env(changedDb));
    expect(changed.status).toBe(400);
    expect(changedDb.sessions).toHaveLength(0);
  });

  it.each([
    ["email", (user: Record<string, unknown>) => { user.email = "changed@example.org"; }],
    ["password hash", (user: Record<string, unknown>) => { user.password_hash = "changed-hash"; }],
    ["password salt", (user: Record<string, unknown>) => { user.password_salt = "changed-salt"; }],
    ["disabled state", (user: Record<string, unknown>) => { user.disabled_at = "2026-07-04T12:00:00.000Z"; }]
  ] as const)("rejects a post-issuance challenge after the user %s changes", async (_field, mutateUser) => {
    const db = new InMemoryD1();
    const issued = await seededStepUp({ db });
    const challenge = await issued.response.json() as { challengeId: string; continuationToken: string };
    const code = codeFromMessage(issued.sentMessages[0]);
    mutateUser(db.users[0]);

    const response = await worker.fetch(loginMfaRequest({ ...challenge, code }), env(db));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "invalid_login_mfa_challenge",
      message: "El código no es válido o ya expiró. Inicie sesión nuevamente."
    });
    expect(db.sessions).toHaveLength(0);
  });

  it("invalidates the challenge and returns a generic 503 when email delivery fails", async () => {
    const db = new InMemoryD1();
    const { response } = await seededStepUp({
      db,
      send: async () => {
        throw new Error("provider secret detail");
      }
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "login_mfa_unavailable",
      message: "No se pudo enviar el código de verificación. Intente de nuevo en unos minutos."
    });
    expect(db.sessions).toHaveLength(0);
    expect(db.loginStepUpChallenges).toHaveLength(1);
    expect(db.loginStepUpChallenges[0].invalidated_at).not.toBeNull();
  });

  it("counts failed deliveries toward the aggregate issuance cap without reopening a flood path", async () => {
    const db = new InMemoryD1();
    await seedStepUpAccount(db);
    const sentMessages: unknown[] = [];
    const runtime = stepUpEmailRuntime(db, sentMessages, async () => {
      throw new Error("provider detail must stay private");
    });

    const responses = [];
    for (let index = 0; index < 6; index += 1) {
      responses.push(await worker.fetch(
        loginRequestFrom("operator@example.org", "Valid#Pass2026", `198.51.100.${140 + index}`),
        runtime
      ));
    }

    expect(responses.every((response) => response.status === 503)).toBe(true);
    for (const response of responses) {
      await expect(response.json()).resolves.toEqual({
        error: "login_mfa_unavailable",
        message: "No se pudo enviar el código de verificación. Intente de nuevo en unos minutos."
      });
    }
    expect(sentMessages).toHaveLength(5);
    expect(db.loginStepUpChallenges).toHaveLength(5);
    expect(db.loginStepUpChallenges.every((challenge) => challenge.invalidated_at !== null)).toBe(true);
    expect(db.sessions).toHaveLength(0);
    expect(JSON.stringify(db.audits)).not.toContain("provider detail must stay private");
  });

  it("keeps wrong credentials generic and audited after the account threshold", async () => {
    const db = new InMemoryD1();
    const hashed = await hashPassword("Valid#Pass2026", "fixed-salt", { enforcePolicy: false });
    db.users.push({
      id: "user_wrong",
      email: "wrong@example.org",
      name: "Wrong Test",
      role: "VIEWER",
      password_hash: hashed.hash,
      password_salt: hashed.salt,
      disabled_at: ""
    });
    seedDistributedFailures(db, "wrong@example.org");

    const response = await worker.fetch(
      loginRequestFrom("wrong@example.org", "Wrong#Pass2026", "198.51.100.91"),
      env(db)
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "auth_error", message: "Credenciales inválidas" });
    expect(db.audits.filter((audit) => audit.action === "LOGIN_FAILED")).toHaveLength(6);
    expect(db.sessions).toHaveLength(0);
    expect(db.loginStepUpChallenges).toHaveLength(0);
  });

  it("never sends a code or issues a challenge for disabled and unknown accounts", async () => {
    const db = new InMemoryD1();
    const hashed = await hashPassword("Valid#Pass2026", "fixed-salt", { enforcePolicy: false });
    db.users.push({
      id: "user_disabled",
      email: "disabled@example.org",
      name: "Disabled",
      role: "VIEWER",
      password_hash: hashed.hash,
      password_salt: hashed.salt,
      disabled_at: "2026-07-01T00:00:00.000Z"
    });
    seedDistributedFailures(db, "disabled@example.org");
    seedDistributedFailures(db, "unknown@example.org");
    const sentMessages: unknown[] = [];
    const runtime = env(db, {
      MOCK_EXTERNAL_SERVICES: "false",
      EMAIL_FROM: "security@example.org",
      EMAIL: {
        send: async (message: unknown) => {
          sentMessages.push(message);
          return { messageId: "must-not-send" };
        }
      } as SendEmail
    });

    const disabled = await worker.fetch(
      loginRequestFrom("disabled@example.org", "Valid#Pass2026", "198.51.100.92"),
      runtime
    );
    const unknown = await worker.fetch(
      loginRequestFrom("unknown@example.org", "Valid#Pass2026", "198.51.100.93"),
      runtime
    );

    expect(disabled.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(sentMessages).toHaveLength(0);
    expect(db.loginStepUpChallenges).toHaveLength(0);
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

describe("malformed stored password values", () => {
  it("normalizes a real SQLite BLOB hash to canonical dummy work and the generic failed-login contract", async () => {
    const database = migratedDatabase();
    const nativeCrypto = crypto;
    const iterationCounts: number[] = [];
    const salts: string[] = [];
    try {
      database.exec("UPDATE users SET password_hash = 42 WHERE id = 'user_operator'");
      expect(
        database
          .prepare("SELECT typeof(password_hash) AS storage_class, password_hash FROM users WHERE id = 'user_operator'")
          .get()
      ).toEqual({ storage_class: "text", password_hash: "42" });
      database.exec("UPDATE users SET password_hash = 1.25 WHERE id = 'user_operator'");
      expect(
        database
          .prepare("SELECT typeof(password_hash) AS storage_class, password_hash FROM users WHERE id = 'user_operator'")
          .get()
      ).toEqual({ storage_class: "text", password_hash: "1.25" });
      expect(() => {
        database.exec("UPDATE users SET password_hash = NULL WHERE id = 'user_operator'");
      }).toThrow(/NOT NULL constraint failed: users\.password_hash/);

      database.exec(
        `UPDATE users
            SET password_hash = X'010203', password_salt = 'blob-salt'
          WHERE id = 'user_operator'`
      );
      const rowBefore = database
        .prepare(
          `SELECT typeof(password_hash) AS storage_class,
                  hex(password_hash) AS password_hash_hex,
                  password_salt
             FROM users
            WHERE id = 'user_operator'`
        )
        .get();
      expect(rowBefore).toEqual({
        storage_class: "blob",
        password_hash_hex: "010203",
        password_salt: "blob-salt"
      });

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

      const runtime = { ...env(new InMemoryD1()), DB: sqliteD1(database) };
      const response = await worker.fetch(
        new Request("https://example.org/api/auth/login", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "CF-Connecting-IP": "198.51.100.42"
          },
          body: JSON.stringify({
            email: "operator@example.org",
            password: "Wrong#Password2026"
          })
        }),
        runtime
      );

      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: "auth_error",
        message: "Credenciales inválidas"
      });
      expect(iterationCounts).toEqual([100_000, 100_000]);
      expect(salts).toEqual([
        "diezmossv-login-dummy-v1",
        "diezmossv-login-dummy-v1:diezmossv-pbkdf2-chain-v1"
      ]);
      expect(database.prepare("SELECT COUNT(*) AS count FROM sessions").get()).toEqual({ count: 0 });
      expect(
        database
          .prepare(
            `SELECT action, entity_id, summary
               FROM audit_logs
              WHERE action = 'LOGIN_FAILED'`
          )
          .all()
      ).toEqual([
        {
          action: "LOGIN_FAILED",
          entity_id: "operator@example.org",
          summary: "Credenciales inválidas"
        }
      ]);
      expect(
        database
          .prepare(
            `SELECT typeof(password_hash) AS storage_class,
                    hex(password_hash) AS password_hash_hex,
                    password_salt
               FROM users
              WHERE id = 'user_operator'`
          )
          .get()
      ).toEqual(rowBefore);
    } finally {
      vi.unstubAllGlobals();
      database.close();
    }
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
    const stored = await hashForStorage("Valid#Password2026", { enforcePolicy: false });
    const passwordHash = stored.hash;
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
    const stored = await hashForStorage("Valid#Password2026", { enforcePolicy: false });
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
    const stored = await hashForStorage("Valid#Password2026", { enforcePolicy: false });
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
    const stored = await hashForStorage("Valid#Password2026", { enforcePolicy: false });
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
    const stored = await hashForStorage("Valid#Password2026", { enforcePolicy: false });
    db.users.push({
      id: "user_concurrent_cap",
      email: "concurrent-cap@example.org",
      name: "Concurrent Cap",
      role: "VIEWER",
      password_hash: stored.hash,
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

  // A policy violation is the donor-facing operator's most likely mistake at bootstrap.
  // It must say WHICH rule failed; re-throwing turns it into an opaque 500 and the
  // operator has no way to know the password was the problem.
  it("rejects a weak bootstrap password with 400 and the policy reason", async () => {
    const db = new InMemoryD1();
    const response = await worker.fetch(
      bootstrapRequest({ token: VALID_BOOTSTRAP_TOKEN, password: "short" }),
      env(db, { BOOTSTRAP_OWNER_TOKEN: VALID_BOOTSTRAP_TOKEN })
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("weak_password");
    expect(body.message).toContain("10 caracteres");
    // The failed attempt must not leave a half-created owner behind.
    expect(db.users).toHaveLength(0);
  });
});

function bootstrapRequest(options: { token?: string; password?: string } = {}, clientIp?: string): Request {
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
      password: options.password ?? "Long-enough1!"
    })
  });
}

type ProviderBudgetTestInput = {
  provider: "WOMPI" | "STRIPE";
  clientKeyHash: string;
  stripeRequestId: string | null;
  now: string;
  cutoff: string;
  expiresAt: string;
  clientLimit: number;
  providerLimit: number;
  globalLimit: number;
};

type ProviderBudgetTestResult =
  | { kind: "CLAIMED"; id: string }
  | { kind: "DUPLICATE" }
  | { kind: "LIMITED" };

async function claimProviderCreationBudgetForTest(
  repo: Repository,
  input: ProviderBudgetTestInput
): Promise<ProviderBudgetTestResult> {
  const method = (repo as unknown as {
    claimProviderCreationBudget?: (value: ProviderBudgetTestInput) => Promise<ProviderBudgetTestResult>;
  }).claimProviderCreationBudget;
  expect(method, "repository exposes the provider creation claim boundary").toBeTypeOf("function");
  if (!method) return { kind: "LIMITED" };
  return method.call(repo, input);
}

async function releaseProviderCreationClaimForTest(
  repo: Repository,
  id: string
): Promise<void> {
  const method = (repo as unknown as {
    releaseUnusedProviderCreationClaim?: (claimId: string) => Promise<void>;
  }).releaseUnusedProviderCreationClaim;
  expect(method, "repository exposes safe provider claim release").toBeTypeOf("function");
  if (!method) return;
  await method.call(repo, id);
}

function providerClaimsFrom(db: InMemoryD1): Array<Record<string, unknown>> {
  const claims = (db as unknown as { providerCreationClaims?: Array<Record<string, unknown>> })
    .providerCreationClaims;
  expect(claims, "the in-memory D1 mirrors provider creation claims").toBeInstanceOf(Array);
  return claims ?? [];
}
