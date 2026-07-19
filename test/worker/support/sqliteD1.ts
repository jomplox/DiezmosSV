import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";

export class SqliteD1 {
  constructor(private readonly sqlite: DatabaseSync) {}

  readonly statements: SqliteStatement[] = [];

  readonly database = {
    prepare: (sql: string) => {
      const statement = new SqliteStatement(this.sqlite, sql);
      this.statements.push(statement);
      return statement;
    },
    batch: async (statements: SqliteStatement[]) => {
      this.sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => statement.runSync());
        this.sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        this.sqlite.exec("ROLLBACK");
        throw error;
      }
    }
  } as unknown as D1Database;
}

export class SqliteStatement {
  args: SQLInputValue[] = [];
  private readonly statement: StatementSync;

  constructor(database: DatabaseSync, readonly sql: string) {
    this.statement = database.prepare(sql);
  }

  bind(...args: unknown[]): this {
    this.args = args as SQLInputValue[];
    return this;
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.args) ?? null) as T | null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.args) as T[] };
  }

  async run(): Promise<D1Result> {
    return this.runSync() as unknown as D1Result;
  }

  runSync(): { success: true; meta: { changes: number }; results: never[] } {
    const result = this.statement.run(...this.args);
    return { success: true, meta: { changes: Number(result.changes) }, results: [] };
  }
}

export function sqliteD1(database: DatabaseSync): D1Database {
  return new SqliteD1(database).database;
}
