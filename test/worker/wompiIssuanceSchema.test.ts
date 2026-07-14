import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const initMigrationPath = resolve(import.meta.dirname, "../../migrations/0001_init.sql");
const issuanceMigrationPath = resolve(import.meta.dirname, "../../migrations/0019_wompi_issuance_lifecycle.sql");

describe("Wompi issuance reservation migration", () => {
  let database: DatabaseSync;

  beforeEach(() => {
    database = new DatabaseSync(":memory:");
    database.exec(readFileSync(initMigrationPath, "utf8"));
    database.exec(readFileSync(issuanceMigrationPath, "utf8"));
    insertApprovedWompiEvent(database, "wompi_a");
    insertApprovedWompiEvent(database, "wompi_b");
  });

  afterEach(() => {
    database.close();
  });

  it("reserves one stable control sequence per Wompi event", () => {
    reserve(database, "wompi_a", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA");
    expect(reservation(database, "wompi_a")).toEqual({
      control_sequence: 1,
      reserved_numero_control: "DTE-15-M001P004-000000000000001",
      reserved_codigo_generacion: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"
    });
    expect(nextValue(database)).toBe(2);

    reserve(database, "wompi_a", "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB");
    expect(reservation(database, "wompi_a")?.control_sequence).toBe(1);
    expect(nextValue(database)).toBe(2);

    reserve(database, "wompi_b", "CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC");
    expect(reservation(database, "wompi_b")?.control_sequence).toBe(2);
    expect(nextValue(database)).toBe(3);
  });

  it("rejects duplicate reserved generation codes", () => {
    reserve(database, "wompi_a", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA");

    expect(() =>
      reserve(database, "wompi_b", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA")
    ).toThrow(/UNIQUE constraint failed: wompi_events\.reserved_codigo_generacion/);
  });

  it("rejects duplicate environment, prefix, and control-sequence reservations", () => {
    reserve(database, "wompi_a", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA");

    expect(() =>
      database
        .prepare(
          `UPDATE wompi_events
           SET control_prefix = ?, control_sequence = ?
           WHERE id = ?`
        )
        .run("M001P004", 1, "wompi_b")
    ).toThrow(/UNIQUE constraint failed: wompi_events\.environment, wompi_events\.control_prefix, wompi_events\.control_sequence/);
  });

  it("canonicalizes a lowercase-only legacy sequence before reserving", () => {
    const legacy = new DatabaseSync(":memory:");
    try {
      legacy.exec(readFileSync(initMigrationPath, "utf8"));
      legacy.prepare(
        "INSERT INTO document_sequences (environment, control_prefix, next_value) VALUES ('00', 'm001p004', 17)"
      ).run();

      legacy.exec(readFileSync(issuanceMigrationPath, "utf8"));
      insertApprovedWompiEvent(legacy, "wompi_legacy_lowercase");
      reserve(legacy, "wompi_legacy_lowercase", "DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD");

      expect(reservation(legacy, "wompi_legacy_lowercase")?.control_sequence).toBe(17);
      expect(sequenceRows(legacy)).toEqual([
        { environment: "00", control_prefix: "M001P004", next_value: 18 }
      ]);
    } finally {
      legacy.close();
    }
  });

  it("merges case-colliding legacy sequences using the highest next value", () => {
    const legacy = new DatabaseSync(":memory:");
    try {
      legacy.exec(readFileSync(initMigrationPath, "utf8"));
      legacy.exec(`
        INSERT INTO document_sequences (environment, control_prefix, next_value)
        VALUES ('00', 'M001P004', 4), ('00', 'm001p004', 23);
      `);

      legacy.exec(readFileSync(issuanceMigrationPath, "utf8"));
      insertApprovedWompiEvent(legacy, "wompi_legacy_collision");
      reserve(legacy, "wompi_legacy_collision", "EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE");

      expect(reservation(legacy, "wompi_legacy_collision")?.control_sequence).toBe(23);
      expect(sequenceRows(legacy)).toEqual([
        { environment: "00", control_prefix: "M001P004", next_value: 24 }
      ]);
    } finally {
      legacy.close();
    }
  });
});

function insertApprovedWompiEvent(database: DatabaseSync, id: string): void {
  database
    .prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body
       ) VALUES (?, ?, '00', 'ExitosaAprobada', 1000, '{}')`
    )
    .run(id, `transaction_${id}`);
}

function reserve(database: DatabaseSync, id: string, codigoGeneracion: string): void {
  database
    .prepare(
      `UPDATE wompi_events
       SET control_prefix = ?, reserved_codigo_generacion = ?
       WHERE id = ?
         AND control_prefix IS NULL
         AND reserved_codigo_generacion IS NULL`
    )
    .run("M001P004", codigoGeneracion, id);
}

function reservation(database: DatabaseSync, id: string): {
  control_sequence: number;
  reserved_numero_control: string;
  reserved_codigo_generacion: string;
} | undefined {
  return database
    .prepare(
      `SELECT control_sequence, reserved_numero_control, reserved_codigo_generacion
       FROM wompi_events
       WHERE id = ?`
    )
    .get(id) as
    | {
        control_sequence: number;
        reserved_numero_control: string;
        reserved_codigo_generacion: string;
      }
    | undefined;
}

function nextValue(database: DatabaseSync): number | undefined {
  return database
    .prepare(
      `SELECT next_value
       FROM document_sequences
       WHERE environment = '00' AND control_prefix = 'M001P004'`
    )
    .get()?.next_value as number | undefined;
}

function sequenceRows(database: DatabaseSync): Array<{
  environment: string;
  control_prefix: string;
  next_value: number;
}> {
  return database
    .prepare(
      `SELECT environment, control_prefix, next_value
       FROM document_sequences
       ORDER BY environment, control_prefix`
    )
    .all() as Array<{
      environment: string;
      control_prefix: string;
      next_value: number;
    }>;
}
