import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { migratedDatabaseThrough } from "./support/migratedDatabase";

// Pins the drift that caused a live D1_ERROR: no such column: created_at.
// wompi_events (migrations/0001_init.sql) records received_at, not created_at —
// every other retention/sweep table (dte_documents, dte_events, email_deliveries,
// audit_logs, contingency_*) does have created_at, but wompi_events never has.
// If a future change reintroduces a `created_at` reference in a wompi_events
// query, these assertions catch it before it reaches staging.

const initMigration = readFileSync(resolve(import.meta.dirname, "../../migrations/0001_init.sql"), "utf8");
const paymentLinkDedupMigration = readFileSync(
  resolve(import.meta.dirname, "../../migrations/0029_wompi_payment_link_dedup.sql"),
  "utf8"
);
const repositorySource = readFileSync(resolve(import.meta.dirname, "../../src/worker/storage/repository.ts"), "utf8");

describe("wompi_events schema contract", () => {
  it("the real wompi_events table has received_at and no created_at column", () => {
    const createTableBlock = extractCreateTableBlock(initMigration, "wompi_events");
    expect(createTableBlock).toBeTruthy();
    expect(createTableBlock).toContain("received_at");
    expect(createTableBlock).not.toContain("created_at");
  });

  it("repository.ts never queries wompi_events using a created_at column", () => {
    for (const wompiEventsQuery of extractWompiEventsQueries(repositorySource)) {
      expect(wompiEventsQuery).not.toMatch(/\bcreated_at\b/);
    }
  });

  it("backfills and uniquely guards the stable payment-link id for dynamic approved donations", () => {
    const database = migratedDatabaseThrough("0028");
    database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body
       ) VALUES (?, ?, '01', 'ExitosaAprobada', 17800, ?)`
    ).run(
      "wompi_existing",
      "uuid-from-webhook",
      JSON.stringify({
        EnlacePago: {
          Id: 9000001,
          IdentificadorEnlaceComercio: "di_existing"
        }
      })
    );

    database.exec(paymentLinkDedupMigration);

    expect(database.prepare(
      "SELECT payment_link_id FROM wompi_events WHERE id = 'wompi_existing'"
    ).get()).toEqual({ payment_link_id: 9000001 });
    expect(() => database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, payment_link_id, environment, result, amount_cents, raw_body
       ) VALUES ('wompi_duplicate', 'display-id-from-api', 9000001, '01', 'ExitosaAprobada', 17800, '{}')`
    ).run()).toThrow(/UNIQUE/);
  });
});

function extractCreateTableBlock(sql: string, table: string): string | null {
  const match = sql.match(new RegExp(`CREATE TABLE[^;]*\\b${table}\\b[^;]*;`, "s"));
  return match ? match[0] : null;
}

// A "wompi_events query" here is the string argument passed to `.prepare(...)`
// (single-quoted, double-quoted, or a single template literal — not a joined
// span across multiple unrelated literals) wherever that argument mentions the
// wompi_events table. Scoping to `.prepare(...)` call sites avoids accidentally
// matching unrelated code between two unrelated string literals.
function extractWompiEventsQueries(source: string): string[] {
  const queries: string[] = [];
  const prepareCallRe = /\.prepare\(\s*(`[^`]*`|"[^"]*"|'[^']*')/gs;
  let match: RegExpExecArray | null;
  while ((match = prepareCallRe.exec(source)) !== null) {
    const literal = match[1];
    const contents = literal.slice(1, -1);
    if (contents.includes("wompi_events")) {
      queries.push(contents);
    }
  }
  return queries;
}
