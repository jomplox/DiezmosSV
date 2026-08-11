import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/worker/index";
import { env, InMemoryD1 } from "./support/inMemoryD1";
import { installWorkerFetchGlobals } from "./support/workerFetchGlobals";

installWorkerFetchGlobals();

describe("Stripe annual statement routes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-07-05T12:00:00.000Z") });
  });

  afterEach(() => vi.useRealTimers());

  it("allows ADMIN and OWNER preview access while refusing lower roles", async () => {
    for (const role of ["ADMIN", "OWNER"] as const) {
      const db = new InMemoryD1();
      db.sessionUser = { id: `user_${role}`, email: `${role}@example.org`, name: role, role };
      const response = await worker.fetch(
        new Request("https://example.org/api/statements/stripe/annual?year=2025", {
          headers: { Authorization: "Bearer test-token" }
        }),
        env(db, { STRIPE_MOCK_MODE: "1" })
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        year: 2025,
        livemode: false,
        donors: [],
        hasMore: false,
        nextCursor: null
      });
    }

    const db = new InMemoryD1();
    db.sessionUser = { id: "user_operator", email: "operator@example.org", name: "Operator", role: "OPERATOR" };
    const response = await worker.fetch(
      new Request("https://example.org/api/statements/stripe/annual?year=2025", {
        headers: { Authorization: "Bearer test-token" }
      }),
      env(db, { STRIPE_MOCK_MODE: "1" })
    );
    expect(response.status).toBe(403);
  });

  it("rejects invalid years, cursors, and strict send bodies before dispatch", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const workerEnv = env(db, { STRIPE_MOCK_MODE: "1" });

    const invalidYear = await worker.fetch(
      new Request("https://example.org/api/statements/stripe/annual?year=2027", { headers: { Authorization: "Bearer test-token" } }),
      workerEnv
    );
    expect(invalidYear.status).toBe(400);

    const invalidCursor = await worker.fetch(
      new Request(`https://example.org/api/statements/stripe/annual?year=2025&after=${"x".repeat(321)}`, {
        headers: { Authorization: "Bearer test-token" }
      }),
      workerEnv
    );
    expect(invalidCursor.status).toBe(400);

    const invalidBody = await worker.fetch(
      new Request("https://example.org/api/statements/stripe/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ donor: "ana@example.org", after: "ana@example.org" })
      }),
      workerEnv
    );
    expect(invalidBody.status).toBe(400);
  });

  it("maps statement configuration and single-donor failures to safe API errors", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const response = await worker.fetch(
      new Request("https://example.org/api/statements/stripe/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: JSON.stringify({ donor: "missing@example.org" })
      }),
      env(db, { STRIPE_MOCK_MODE: "1" })
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "stripe_annual_statement_donor_not_found" });
  });

  it("returns the Stripe service bulk result through the authenticated send route", async () => {
    const db = new InMemoryD1();
    db.sessionUser = { id: "user_admin", email: "admin@example.org", name: "Admin", role: "ADMIN" };
    const response = await worker.fetch(
      new Request("https://example.org/api/statements/stripe/annual/send?year=2025", {
        method: "POST",
        headers: { Authorization: "Bearer test-token", "Content-Type": "application/json" },
        body: "{}"
      }),
      env(db, { STRIPE_MOCK_MODE: "1" })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      year: 2025,
      livemode: false,
      mode: "bulk",
      processed: 0,
      sent: 0,
      review: 0,
      hasMore: false,
      nextCursor: null
    });
  });
});
