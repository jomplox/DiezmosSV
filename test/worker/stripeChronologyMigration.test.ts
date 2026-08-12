import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migratedDatabaseThrough } from "./support/migratedDatabase";

const migrationPath = resolve(
  import.meta.dirname,
  "../../migrations/0035_stripe_provider_chronology.sql"
);

describe("Stripe provider chronology persistence", () => {
  const databases: ReturnType<typeof migratedDatabaseThrough>[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it("upgrades 0034 with independent checkout and subscription chronology", () => {
    expect(existsSync(migrationPath)).toBe(true);
    const database = migratedDatabaseThrough("0034");
    databases.push(database);

    database.exec(readFileSync(migrationPath, "utf8"));

    const columns = database.prepare("PRAGMA table_info(stripe_checkout_sessions)").all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    expect(columns.map(({ name }) => name)).toEqual(expect.arrayContaining([
      "checkout_event_created",
      "checkout_event_rank",
      "checkout_event_id",
      "subscription_event_created",
      "subscription_event_rank",
      "subscription_event_id"
    ]));
    expect(Object.fromEntries(columns.map(({ name, dflt_value }) => [name, dflt_value]))).toMatchObject({
      checkout_event_created: "0",
      checkout_event_rank: "0",
      subscription_event_created: "0",
      subscription_event_rank: "0"
    });
  });
});
