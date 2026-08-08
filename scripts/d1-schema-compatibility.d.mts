export interface ColumnMetadata {
  name: string;
  type: string;
  notnull: number | boolean;
  dflt_value?: string | null;
}

export interface IndexMetadata {
  name: string;
  unique: number | boolean;
  partial: number | boolean;
  columns: string[];
  sql: string | null;
}

export interface CompatibilitySnapshot {
  appliedMigrations: string[];
  tableColumns: Record<string, ColumnMetadata[]>;
  tableIndexes: Record<string, IndexMetadata[]>;
  schemaObjects: Record<string, SchemaObjectMetadata>;
  duplicateCounts: Record<string, number>;
  sequenceNoncanonicalCount?: number;
}

export interface SchemaObjectMetadata {
  type: "index" | "trigger";
  table: string;
  sql: string;
}

export interface RequiredColumn {
  migration: string;
  table: string;
  column: string;
  type: "TEXT" | "INTEGER";
  nullable: boolean;
  defaultValue?: string;
  addSql: string;
}

export interface RequiredIndex {
  migration: string;
  table: string;
  name: string;
  unique: true;
  partial: true;
  columns: readonly string[];
  predicate: string;
  duplicateCountKey: string;
  createSql: string;
}

export interface CompatibilityPlan {
  statements: string[];
  ledgerAliases: string[];
  temporary0024Body?: string;
}

export interface RequiredTrigger {
  migration: string;
  table: string;
  name: string;
  createSql: string;
}

export const REQUIRED_SCHEMA_MANIFEST: {
  readonly columns: readonly RequiredColumn[];
  readonly indexes: readonly RequiredIndex[];
  readonly triggers: readonly RequiredTrigger[];
};

export function buildCompatibilityPlan(
  snapshot: CompatibilitySnapshot
): CompatibilityPlan;

export function assertRequiredSchema(snapshot: CompatibilitySnapshot): void;

export function buildPending0024OverlayPlan(
  snapshot: CompatibilitySnapshot
): string | undefined;

export interface CompatibilityRunner {
  run(args: string[], options?: { capture?: boolean }): Promise<string>;
  cleanup(): void;
  terminate?(signal: NodeJS.Signals): void;
}

export function migrateSchemaCompatibility(options: {
  binding: string;
  environment: string;
  repositoryRoot?: string;
  createRunner?(options?: {
    repositoryRoot?: string;
    migrationsDirOverride?: string;
  }): CompatibilityRunner;
  signalSource?: Pick<NodeJS.Process, "once" | "removeListener">;
  exit?(code: number): void;
}): Promise<void>;
