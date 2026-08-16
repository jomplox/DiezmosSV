import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Repository } from "../../src/worker/storage/repository";
import { migratedDatabase } from "./support/migratedDatabase";
import { sqliteD1 } from "./support/sqliteD1";

describe("Stripe Billing Portal security repository", () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it("atomically enforces IP, customer, and aggregate budgets", async () => {
    const database = migratedDatabase();
    databases.push(database);
    const repo = new Repository(sqliteD1(database));
    const base = {
      now: "2026-08-16T00:10:00.000Z",
      cutoff: "2026-08-15T23:55:00.000Z",
      expiresAt: "2026-08-16T00:25:00.000Z",
      ipLimit: 3,
      customerLimit: 2,
      aggregateLimit: 4
    };

    const sameCustomer = await Promise.all(
      Array.from({ length: 20 }, () => repo.claimStripePortalRateLimit({
        ...base,
        ipKeyHash: "ip-a",
        customerKeyHash: "customer-a"
      }))
    );
    expect(sameCustomer.filter(Boolean)).toHaveLength(2);

    expect(await repo.claimStripePortalRateLimit({
      ...base,
      ipKeyHash: "ip-b",
      customerKeyHash: "customer-a"
    })).toBeNull();

    expect(await repo.claimStripePortalRateLimit({
      ...base,
      ipKeyHash: "ip-a",
      customerKeyHash: "customer-b"
    })).not.toBeNull();
    expect(await repo.claimStripePortalRateLimit({
      ...base,
      ipKeyHash: "ip-c",
      customerKeyHash: "customer-c"
    })).not.toBeNull();
    expect(await repo.claimStripePortalRateLimit({
      ...base,
      ipKeyHash: "ip-d",
      customerKeyHash: "customer-d"
    })).toBeNull();

    expect(database.prepare(
      "SELECT COUNT(*) AS count FROM stripe_portal_rate_limit_claims"
    ).get()).toEqual({ count: 4 });
  });

  it("admits a new claim after the rolling window expires", async () => {
    const database = migratedDatabase();
    databases.push(database);
    const repo = new Repository(sqliteD1(database));
    const first = await repo.claimStripePortalRateLimit({
      ipKeyHash: "ip-expiry",
      customerKeyHash: "customer-expiry",
      now: "2026-08-16T00:00:00.000Z",
      cutoff: "2026-08-15T23:45:00.000Z",
      expiresAt: "2026-08-16T00:15:00.000Z",
      ipLimit: 1,
      customerLimit: 1,
      aggregateLimit: 1
    });
    expect(first).not.toBeNull();
    expect(await repo.claimStripePortalRateLimit({
      ipKeyHash: "ip-expiry",
      customerKeyHash: "customer-expiry",
      now: "2026-08-16T00:16:00.000Z",
      cutoff: "2026-08-16T00:01:00.000Z",
      expiresAt: "2026-08-16T00:31:00.000Z",
      ipLimit: 1,
      customerLimit: 1,
      aggregateLimit: 1
    })).not.toBeNull();
  });
});
