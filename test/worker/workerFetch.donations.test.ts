import type { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import worker from "../../src/worker/index";
import { sha256Hex, utf8Bytes } from "../../src/worker/utils/encoding";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { migratedDatabase } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

async function seedSession(
  database: DatabaseSync,
  input: { id: string; role: "OPERATOR" | "ADMIN"; token: string }
): Promise<void> {
  database.prepare(
    `INSERT INTO users (
       id, email, name, role, password_hash, password_salt
     ) VALUES (?, ?, ?, ?, 'hash', 'salt')`
  ).run(input.id, `${input.id}@example.org`, input.id, input.role);
  database.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, '2030-01-01T00:00:00.000Z')`
  ).run(`session_${input.id}`, input.id, await sha256Hex(utf8Bytes(input.token)));
}

function seedUsGift(database: DatabaseSync, id: string, donorName: string, settledAt: string): void {
  database.prepare(
    `INSERT INTO stripe_checkout_sessions (
       id, request_id, request_fingerprint, frequency, gift_type, amount_cents,
       livemode, status, payment_status
     ) VALUES (?, ?, ?, 'ONCE', 'TITHE', 22500, 1, 'COMPLETE', 'PAID')`
  ).run(`checkout_${id}`, `request_${id}`, `fingerprint_${id}`);
  database.prepare(
    `INSERT INTO stripe_gifts (
       id, source_type, source_id, checkout_id, stripe_payment_intent_id,
       frequency, gift_type, amount_cents, donor_name, donor_email, settled_at, status
     ) VALUES (?, 'PAYMENT_INTENT', ?, ?, ?, 'ONCE', 'TITHE', 22500, ?, 'ana@example.org', ?, 'PAID')`
  ).run(id, `pi_${id}`, `checkout_${id}`, `pi_${id}`, donorName, settledAt);
}

async function workerWithAdmin() {
  const database = migratedDatabase();
  await seedSession(database, { id: "admin", role: "ADMIN", token: "admin-token" });
  await seedSession(database, { id: "limited", role: "OPERATOR", token: "operator-token" });
  const workerEnv = { ...env(new InMemoryD1()), DB: sqliteD1(database) };
  const get = (search: Record<string, string>, token = "admin-token", path = "/api/donations") => {
    const url = new URL(`https://example.org${path}`);
    url.search = new URLSearchParams(search).toString();
    return worker.fetch(new Request(url, { headers: { Authorization: `Bearer ${token}` } }), workerEnv);
  };
  return { database, get };
}

describe("GET /api/donations", () => {
  it("returns the filtered ledger to administrators and denies operators", async () => {
    const { database, get } = await workerWithAdmin();
    seedUsGift(database, "stripe_gift_ana", "Ana C Delgado", "2026-09-28T16:00:44.000Z");
    seedUsGift(database, "stripe_gift_other", "Otra Persona", "2026-09-27T16:00:44.000Z");

    const query = { lane: "US", q: "delgado", from: "2026-09-01", to: "2026-09-30", limit: "25" };
    const adminResponse = await get(query);
    expect(adminResponse.status).toBe(200);
    await expect(adminResponse.json()).resolves.toMatchObject({
      hasMore: false,
      nextCursor: null,
      limit: 25,
      donations: [{ id: "stripe_gift_ana", lane: "US", amountCents: 22_500, donorName: "Ana C Delgado" }]
    });

    expect((await get(query, "operator-token")).status).toBe(403);
  });

  it("rejects malformed filters before querying donor data", async () => {
    const { get } = await workerWithAdmin();
    const invalidQueries: Array<Record<string, string>> = [
      { lane: "MX" },
      { from: "2026-13-01" },
      { to: "28/09/2026" },
      { from: "2026-09-30", to: "2026-09-01" },
      { limit: "0" },
      { limit: "101" },
      { cursor: "not-a-cursor" },
      { q: "x".repeat(201) }
    ];
    for (const query of invalidQueries) {
      const response = await get(query);
      expect(response.status, JSON.stringify(query)).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: "invalid_donation_filters" });
    }
  });

  it("no longer serves the superseded intents-only listing", async () => {
    const { get } = await workerWithAdmin();
    expect((await get({}, "admin-token", "/api/donations/intents")).status).toBe(404);
    expect((await get({})).status).toBe(200);
  });
});
