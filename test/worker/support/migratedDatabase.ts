import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const migrationsDirectory = resolve(import.meta.dirname, "../../../migrations");

export function migrationFiles(): string[] {
  return readdirSync(migrationsDirectory)
    .filter((filename) => /^\d{4}_.+\.sql$/.test(filename))
    .sort();
}

export function applyMigrations(database: DatabaseSync): void {
  for (const filename of migrationFiles()) {
    database.exec(readFileSync(resolve(migrationsDirectory, filename), "utf8"));
  }
}

export function migratedDatabase(): DatabaseSync {
  return migratedDatabaseThrough(null);
}

export function migratedDatabaseThrough(lastMigrationPrefix: string | null): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of migrationFiles()) {
    if (lastMigrationPrefix && filename.slice(0, 4) > lastMigrationPrefix) {
      break;
    }
    database.exec(readFileSync(resolve(migrationsDirectory, filename), "utf8"));
  }
  database.prepare(
    `INSERT INTO users (id, email, name, role, password_hash, password_salt)
     VALUES ('user_operator', 'operator@example.org', 'Operator', 'OPERATOR', 'hash', 'salt')`
  ).run();
  return database;
}
