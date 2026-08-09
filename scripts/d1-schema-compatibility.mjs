import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPrivateWranglerRunner,
  createSignalCleanupHandler
} from "./run-private-wrangler.mjs";

const MIGRATION_0023 = "0023_wompi_issuance_lifecycle.sql";
const LEGACY_MIGRATION_0019 = "0019_wompi_issuance_lifecycle.sql";
const MIGRATION_0024 = "0024_add_rate_limit_claim_ids.sql";
const MIGRATION_0030 = "0030_wompi_reconciliation_lifecycle.sql";
const SCHEMA_MISMATCH_MESSAGE = "D1 schema compatibility mismatch";
const SEQUENCE_CANONICALIZATION_STATEMENTS = Object.freeze([
  `INSERT OR IGNORE INTO document_sequences (environment, control_prefix, next_value)
SELECT environment, UPPER(control_prefix), next_value
FROM document_sequences
WHERE control_prefix <> UPPER(control_prefix);`,
  `UPDATE document_sequences
SET next_value = (
  SELECT MAX(source.next_value)
  FROM document_sequences AS source
  WHERE source.environment = document_sequences.environment
    AND UPPER(source.control_prefix) = UPPER(document_sequences.control_prefix)
)
WHERE control_prefix = UPPER(control_prefix);`,
  `DELETE FROM document_sequences
WHERE control_prefix <> UPPER(control_prefix);`
]);

const requiredColumns = [
  {
    migration: MIGRATION_0023,
    table: "wompi_events",
    column: "issuance_status",
    type: "TEXT",
    nullable: true,
    checkSql:
      "CHECK (issuance_status IN ('PROCESSING', 'FAILED', 'DEAD_LETTERED', 'RETRY_QUEUED', 'DOCUMENT_CREATED', 'IGNORED'))",
    addSql: [
      "ALTER TABLE wompi_events ADD COLUMN issuance_status TEXT",
      "  CHECK (issuance_status IN ('PROCESSING', 'FAILED', 'DEAD_LETTERED', 'RETRY_QUEUED', 'DOCUMENT_CREATED', 'IGNORED'));"
    ].join("\n")
  },
  {
    migration: MIGRATION_0023,
    table: "wompi_events",
    column: "control_prefix",
    type: "TEXT",
    nullable: true,
    addSql: "ALTER TABLE wompi_events ADD COLUMN control_prefix TEXT;"
  },
  {
    migration: MIGRATION_0023,
    table: "wompi_events",
    column: "control_sequence",
    type: "INTEGER",
    nullable: true,
    addSql: "ALTER TABLE wompi_events ADD COLUMN control_sequence INTEGER;"
  },
  {
    migration: MIGRATION_0023,
    table: "wompi_events",
    column: "reserved_numero_control",
    type: "TEXT",
    nullable: true,
    addSql: "ALTER TABLE wompi_events ADD COLUMN reserved_numero_control TEXT;"
  },
  {
    migration: MIGRATION_0023,
    table: "wompi_events",
    column: "reserved_codigo_generacion",
    type: "TEXT",
    nullable: true,
    addSql: "ALTER TABLE wompi_events ADD COLUMN reserved_codigo_generacion TEXT;"
  },
  {
    migration: MIGRATION_0023,
    table: "wompi_events",
    column: "issuance_attempt_count",
    type: "INTEGER",
    nullable: false,
    defaultValue: "0",
    checkSql: "CHECK (issuance_attempt_count >= 0)",
    addSql: [
      "ALTER TABLE wompi_events ADD COLUMN issuance_attempt_count INTEGER NOT NULL DEFAULT 0",
      "  CHECK (issuance_attempt_count >= 0);"
    ].join("\n")
  },
  {
    migration: MIGRATION_0023,
    table: "wompi_events",
    column: "issuance_attempt_id",
    type: "TEXT",
    nullable: true,
    addSql: "ALTER TABLE wompi_events ADD COLUMN issuance_attempt_id TEXT;"
  },
  {
    migration: MIGRATION_0023,
    table: "wompi_events",
    column: "issuance_error_code",
    type: "TEXT",
    nullable: true,
    addSql: "ALTER TABLE wompi_events ADD COLUMN issuance_error_code TEXT;"
  },
  {
    migration: MIGRATION_0023,
    table: "wompi_events",
    column: "issuance_error_message",
    type: "TEXT",
    nullable: true,
    addSql: "ALTER TABLE wompi_events ADD COLUMN issuance_error_message TEXT;"
  },
  {
    migration: MIGRATION_0023,
    table: "wompi_events",
    column: "issuance_last_attempt_at",
    type: "TEXT",
    nullable: true,
    addSql: "ALTER TABLE wompi_events ADD COLUMN issuance_last_attempt_at TEXT;"
  },
  {
    migration: MIGRATION_0023,
    table: "wompi_events",
    column: "issuance_failed_at",
    type: "TEXT",
    nullable: true,
    addSql: "ALTER TABLE wompi_events ADD COLUMN issuance_failed_at TEXT;"
  },
  {
    migration: MIGRATION_0023,
    table: "wompi_events",
    column: "issuance_dead_lettered_at",
    type: "TEXT",
    nullable: true,
    addSql: "ALTER TABLE wompi_events ADD COLUMN issuance_dead_lettered_at TEXT;"
  },
  {
    migration: MIGRATION_0023,
    table: "dte_documents",
    column: "transmission_claim_id",
    type: "TEXT",
    nullable: true,
    addSql: "ALTER TABLE dte_documents ADD COLUMN transmission_claim_id TEXT;"
  },
  {
    migration: MIGRATION_0023,
    table: "email_deliveries",
    column: "claim_attempted_at",
    type: "TEXT",
    nullable: true,
    addSql: "ALTER TABLE email_deliveries ADD COLUMN claim_attempted_at TEXT;"
  },
  {
    migration: MIGRATION_0023,
    table: "email_deliveries",
    column: "idempotency_key",
    type: "TEXT",
    nullable: true,
    addSql: "ALTER TABLE email_deliveries ADD COLUMN idempotency_key TEXT;"
  },
  {
    migration: MIGRATION_0023,
    table: "email_deliveries",
    column: "claim_token",
    type: "TEXT",
    nullable: true,
    addSql: "ALTER TABLE email_deliveries ADD COLUMN claim_token TEXT;"
  },
  {
    migration: MIGRATION_0024,
    table: "donation_intents",
    column: "rate_limit_claim_id",
    type: "TEXT",
    nullable: true,
    addSql: "ALTER TABLE donation_intents ADD COLUMN rate_limit_claim_id TEXT;"
  },
  {
    migration: MIGRATION_0024,
    table: "audit_logs",
    column: "rate_limit_claim_id",
    type: "TEXT",
    nullable: true,
    addSql: "ALTER TABLE audit_logs ADD COLUMN rate_limit_claim_id TEXT;"
  },
  {
    migration: MIGRATION_0030,
    table: "wompi_events",
    column: "stalled_requeue_epoch_at",
    type: "TEXT",
    nullable: true,
    addSql: "ALTER TABLE wompi_events ADD COLUMN stalled_requeue_epoch_at TEXT;"
  }
];

const requiredIndexes = [
  {
    migration: MIGRATION_0023,
    table: "email_deliveries",
    name: "idx_email_deliveries_idempotency_key",
    unique: true,
    partial: true,
    columns: ["idempotency_key"],
    predicate: "idempotency_key IS NOT NULL",
    duplicateCountKey: "idx_email_deliveries_idempotency_key",
    createSql: [
      "CREATE UNIQUE INDEX idx_email_deliveries_idempotency_key",
      "  ON email_deliveries(idempotency_key)",
      "  WHERE idempotency_key IS NOT NULL;"
    ].join("\n")
  },
  {
    migration: MIGRATION_0023,
    table: "wompi_events",
    name: "idx_wompi_reserved_control",
    unique: true,
    partial: true,
    columns: ["environment", "control_prefix", "control_sequence"],
    predicate: "control_sequence IS NOT NULL",
    duplicateCountKey: "idx_wompi_reserved_control",
    createSql: [
      "CREATE UNIQUE INDEX idx_wompi_reserved_control",
      "  ON wompi_events(environment, control_prefix, control_sequence)",
      "  WHERE control_sequence IS NOT NULL;"
    ].join("\n")
  },
  {
    migration: MIGRATION_0023,
    table: "wompi_events",
    name: "idx_wompi_reserved_generation",
    unique: true,
    partial: true,
    columns: ["reserved_codigo_generacion"],
    predicate: "reserved_codigo_generacion IS NOT NULL",
    duplicateCountKey: "idx_wompi_reserved_generation",
    createSql: [
      "CREATE UNIQUE INDEX idx_wompi_reserved_generation",
      "  ON wompi_events(reserved_codigo_generacion)",
      "  WHERE reserved_codigo_generacion IS NOT NULL;"
    ].join("\n")
  },
  {
    migration: MIGRATION_0023,
    table: "dte_documents",
    name: "idx_dte_documents_wompi_unique",
    unique: true,
    partial: true,
    columns: ["wompi_event_id"],
    predicate: "wompi_event_id IS NOT NULL",
    duplicateCountKey: "idx_dte_documents_wompi_unique",
    createSql: [
      "CREATE UNIQUE INDEX idx_dte_documents_wompi_unique",
      "  ON dte_documents(wompi_event_id)",
      "  WHERE wompi_event_id IS NOT NULL;"
    ].join("\n")
  }
];

const requiredTriggers = [
  {
    migration: MIGRATION_0023,
    table: "wompi_events",
    name: "reserve_wompi_document_identifiers",
    createSql: `CREATE TRIGGER reserve_wompi_document_identifiers
AFTER UPDATE OF control_prefix, reserved_codigo_generacion ON wompi_events
FOR EACH ROW
WHEN OLD.control_prefix IS NULL
  AND OLD.control_sequence IS NULL
  AND OLD.reserved_numero_control IS NULL
  AND OLD.reserved_codigo_generacion IS NULL
  AND NEW.control_prefix IS NOT NULL
  AND NEW.reserved_codigo_generacion IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO document_sequences (environment, control_prefix, next_value)
  VALUES (NEW.environment, NEW.control_prefix, 1);

  UPDATE wompi_events
  SET control_sequence = (
        SELECT next_value
        FROM document_sequences
        WHERE environment = NEW.environment
          AND control_prefix = NEW.control_prefix
      ),
      reserved_numero_control = 'DTE-15-' || NEW.control_prefix || '-' || printf(
        '%015d',
        (
          SELECT next_value
          FROM document_sequences
          WHERE environment = NEW.environment
            AND control_prefix = NEW.control_prefix
        )
      )
  WHERE id = NEW.id
    AND control_sequence IS NULL
    AND reserved_numero_control IS NULL;

  UPDATE document_sequences
  SET next_value = next_value + 1
  WHERE environment = NEW.environment
    AND control_prefix = NEW.control_prefix
    AND next_value = (
      SELECT control_sequence
      FROM wompi_events
      WHERE id = NEW.id
    );
END;`
  }
];

export const REQUIRED_SCHEMA_MANIFEST = Object.freeze({
  columns: Object.freeze(requiredColumns.map((column) => Object.freeze(column))),
  indexes: Object.freeze(
    requiredIndexes.map((index) =>
      Object.freeze({ ...index, columns: Object.freeze([...index.columns]) })
    )
  ),
  triggers: Object.freeze(
    requiredTriggers.map((trigger) => Object.freeze(trigger))
  )
});

function schemaMismatch() {
  return new Error(SCHEMA_MISMATCH_MESSAGE);
}

function isRecorded(snapshot, migration) {
  if (!Array.isArray(snapshot?.appliedMigrations)) throw schemaMismatch();
  return snapshot.appliedMigrations.includes(migration);
}

function tableColumns(snapshot, table) {
  const columns = snapshot?.tableColumns?.[table];
  if (columns === undefined) return [];
  if (!Array.isArray(columns)) throw schemaMismatch();
  return columns;
}

function findColumn(snapshot, requirement) {
  return tableColumns(snapshot, requirement.table).find(
    (column) => column?.name === requirement.column
  );
}

function hasRequiredColumnShape(snapshot, column, requirement) {
  return (
    typeof column?.type === "string" &&
    column.type.trim().toUpperCase() === requirement.type &&
    (requirement.nullable
      ? column.notnull === 0 || column.notnull === false
      : column.notnull === 1 || column.notnull === true) &&
    (requirement.defaultValue === undefined ||
      String(column.dflt_value).replace(/^\((.*)\)$/, "$1") ===
        requirement.defaultValue) &&
    (requirement.checkSql === undefined ||
      hasActiveSchemaTokenSequence(
        snapshot?.tableSql?.[requirement.table],
        requirement.checkSql
      ))
  );
}

function assertExistingColumns(snapshot) {
  for (const requirement of REQUIRED_SCHEMA_MANIFEST.columns) {
    const column = findColumn(snapshot, requirement);
    if (column && !hasRequiredColumnShape(snapshot, column, requirement)) {
      throw schemaMismatch();
    }
  }
}

function namedIndexes(snapshot, name) {
  if (
    snapshot?.tableIndexes === null ||
    typeof snapshot?.tableIndexes !== "object" ||
    Array.isArray(snapshot?.tableIndexes)
  ) {
    throw schemaMismatch();
  }

  const matches = [];
  for (const [table, indexes] of Object.entries(snapshot.tableIndexes)) {
    if (!Array.isArray(indexes)) throw schemaMismatch();
    for (const index of indexes) {
      if (index?.name === name) matches.push({ table, index });
    }
  }
  return matches;
}

function hasRequiredIndexShape(table, index, requirement) {
  return (
    table === requirement.table &&
    (index?.unique === 1 || index?.unique === true) &&
    (index?.partial === 1 || index?.partial === true) &&
    Array.isArray(index?.columns) &&
    index.columns.length === requirement.columns.length &&
    index.columns.every(
      (column, position) => column === requirement.columns[position]
    ) &&
    indexTokenArraysEqual(index.sql, requirement.createSql)
  );
}

function existingRequiredIndex(snapshot, requirement) {
  const matches = namedIndexes(snapshot, requirement.name);
  if (matches.length === 0) return undefined;
  if (
    matches.length !== 1 ||
    !hasRequiredIndexShape(matches[0].table, matches[0].index, requirement)
  ) {
    throw schemaMismatch();
  }
  if (duplicateCount(snapshot, requirement.duplicateCountKey) !== 0) {
    throw schemaMismatch();
  }
  return matches[0].index;
}

const SCHEMA_SQL_KEYWORDS = new Set([
  "after",
  "and",
  "begin",
  "check",
  "create",
  "each",
  "end",
  "exists",
  "for",
  "from",
  "if",
  "ignore",
  "in",
  "index",
  "insert",
  "into",
  "is",
  "not",
  "null",
  "of",
  "on",
  "or",
  "row",
  "select",
  "set",
  "trigger",
  "unique",
  "update",
  "values",
  "when",
  "where"
]);
const SQL_IDENTIFIER_TOKEN_TYPES = new Set([
  "identifier",
  "quotedIdentifier"
]);
const SQL_PUNCTUATION = new Set(["(", ")", ",", ";", "."]);
const SQL_OPERATORS = new Set([
  "->>",
  ">=",
  "<=",
  "<>",
  "!=",
  "==",
  "||",
  "->",
  "<<",
  ">>",
  "+",
  "-",
  "*",
  "/",
  "%",
  "=",
  "<",
  ">",
  "!",
  "|",
  "&",
  "~"
]);

function tokenizeSchemaSql(sql) {
  if (typeof sql !== "string") return undefined;
  const tokens = [];
  for (let position = 0; position < sql.length;) {
    const character = sql[position];
    if (/\s/u.test(character)) {
      position += 1;
      continue;
    }
    if (character === "-" && sql[position + 1] === "-") {
      position += 2;
      while (
        position < sql.length &&
        sql[position] !== "\n" &&
        sql[position] !== "\r"
      ) {
        position += 1;
      }
      continue;
    }
    if (character === "/" && sql[position + 1] === "*") {
      const end = sql.indexOf("*/", position + 2);
      if (end === -1) return undefined;
      position = end + 2;
      continue;
    }
    if (
      character === "'" ||
      character === '"' ||
      character === "`" ||
      character === "["
    ) {
      const start = position;
      const closingCharacter = character === "[" ? "]" : character;
      position += 1;
      let closed = false;
      while (position < sql.length) {
        if (sql[position] !== closingCharacter) {
          position += 1;
          continue;
        }
        if (sql[position + 1] === closingCharacter) {
          position += 2;
          continue;
        }
        position += 1;
        closed = true;
        break;
      }
      if (!closed) return undefined;
      const token = sql.slice(start, position);
      if (character === "'") {
        tokens.push({ type: "literal", value: token });
      } else {
        tokens.push({
          type: "quotedIdentifier",
          value: token
            .slice(1, -1)
            .replaceAll(closingCharacter + closingCharacter, closingCharacter)
            .toLowerCase()
        });
      }
      continue;
    }
    if (/[A-Za-z_\u0080-\uFFFF]/u.test(character)) {
      const start = position;
      position += 1;
      while (
        position < sql.length &&
        /[A-Za-z0-9_$\u0080-\uFFFF]/u.test(sql[position])
      ) {
        position += 1;
      }
      const value = sql.slice(start, position).toLowerCase();
      tokens.push({
        type: SCHEMA_SQL_KEYWORDS.has(value) ? "keyword" : "identifier",
        value
      });
      continue;
    }
    if (/\d/u.test(character)) {
      const numeric = sql.slice(position).match(
        /^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/iu
      )?.[0];
      if (!numeric) return undefined;
      tokens.push({ type: "number", value: numeric.toLowerCase() });
      position += numeric.length;
      continue;
    }

    const operator = [3, 2, 1]
      .map((length) => sql.slice(position, position + length))
      .find((candidate) => SQL_OPERATORS.has(candidate));
    if (operator) {
      tokens.push({ type: "operator", value: operator });
      position += operator.length;
      continue;
    }
    if (SQL_PUNCTUATION.has(character)) {
      tokens.push({ type: "punctuation", value: character });
      position += 1;
      continue;
    }
    return undefined;
  }
  return tokens;
}

function schemaTokensMatch(actual, expected) {
  return (
    actual?.value === expected?.value &&
    (actual?.type === expected?.type ||
      (SQL_IDENTIFIER_TOKEN_TYPES.has(actual?.type) &&
        SQL_IDENTIFIER_TOKEN_TYPES.has(expected?.type)))
  );
}

function hasActiveSchemaTokenSequence(sql, requiredSql) {
  const tokens = tokenizeSchemaSql(sql);
  const requiredTokens = tokenizeSchemaSql(requiredSql);
  if (!tokens || !requiredTokens || requiredTokens.length === 0) return false;
  return tokens.some((_token, start) =>
    requiredTokens.every((expected, offset) =>
      schemaTokensMatch(tokens[start + offset], expected)
    )
  );
}

function schemaTokenArraysEqual(actualSql, expectedSql) {
  const actual = tokenizeSchemaSql(actualSql);
  const expected = tokenizeSchemaSql(expectedSql);
  if (!actual || !expected) return false;
  while (
    actual.at(-1)?.type === "punctuation" &&
    actual.at(-1)?.value === ";"
  ) {
    actual.pop();
  }
  while (
    expected.at(-1)?.type === "punctuation" &&
    expected.at(-1)?.value === ";"
  ) {
    expected.pop();
  }
  return (
    actual.length === expected.length &&
    expected.every((token, position) =>
      schemaTokensMatch(actual[position], token)
    )
  );
}

function indexTokensForComparison(sql) {
  const tokens = tokenizeSchemaSql(sql);
  if (!tokens) return undefined;
  while (
    tokens.at(-1)?.type === "punctuation" &&
    tokens.at(-1)?.value === ";"
  ) {
    tokens.pop();
  }
  const optionalClause = ["if", "not", "exists"];
  if (
    tokens[0]?.type === "keyword" && tokens[0]?.value === "create" &&
    tokens[1]?.type === "keyword" && tokens[1]?.value === "unique" &&
    tokens[2]?.type === "keyword" && tokens[2]?.value === "index" &&
    optionalClause.every(
      (value, offset) =>
        tokens[offset + 3]?.type === "keyword" &&
        tokens[offset + 3]?.value === value
    )
  ) {
    tokens.splice(3, optionalClause.length);
  }
  return tokens;
}

function indexTokenArraysEqual(actualSql, expectedSql) {
  const actual = indexTokensForComparison(actualSql);
  const expected = indexTokensForComparison(expectedSql);
  return (
    actual !== undefined &&
    expected !== undefined &&
    actual.length === expected.length &&
    expected.every((token, position) =>
      schemaTokensMatch(actual[position], token)
    )
  );
}

function existingRequiredTrigger(snapshot, requirement) {
  const objects = snapshot?.schemaObjects;
  if (objects === null || typeof objects !== "object" || Array.isArray(objects)) {
    throw schemaMismatch();
  }
  const existing = objects[requirement.name];
  if (existing === undefined) return undefined;
  if (
    existing?.type !== "trigger" ||
    existing?.table !== requirement.table ||
    !schemaTokenArraysEqual(existing?.sql, requirement.createSql)
  ) {
    throw schemaMismatch();
  }
  return existing;
}

function duplicateCount(snapshot, key) {
  const count = snapshot?.duplicateCounts?.[key];
  if (!Number.isSafeInteger(count) || count < 0) throw schemaMismatch();
  return count;
}

export function buildPending0024OverlayPlan(snapshot) {
  assertExistingColumns(snapshot);
  if (isRecorded(snapshot, MIGRATION_0024)) return undefined;

  const requirements = REQUIRED_SCHEMA_MANIFEST.columns.filter(
    (column) => column.migration === MIGRATION_0024
  );
  const existing = requirements.filter((requirement) =>
    findColumn(snapshot, requirement)
  );
  if (existing.length === 0) return undefined;
  if (existing.length === requirements.length) return "SELECT 1;\n";

  const missing = requirements.find(
    (requirement) => !findColumn(snapshot, requirement)
  );
  if (!missing) throw schemaMismatch();
  return `${missing.addSql}\n`;
}

export function buildCompatibilityPlan(snapshot) {
  assertExistingColumns(snapshot);
  const statements = [];
  const reconcile0023 =
    isRecorded(snapshot, MIGRATION_0023) ||
    isRecorded(snapshot, LEGACY_MIGRATION_0019) ||
    REQUIRED_SCHEMA_MANIFEST.columns
      .filter((requirement) => requirement.migration === MIGRATION_0023)
      .some((requirement) => findColumn(snapshot, requirement));

  for (const requirement of REQUIRED_SCHEMA_MANIFEST.columns) {
    if (
      (isRecorded(snapshot, requirement.migration) ||
        (requirement.migration === MIGRATION_0023 && reconcile0023)) &&
      !findColumn(snapshot, requirement)
    ) {
      statements.push(requirement.addSql);
    }
  }

  for (const requirement of REQUIRED_SCHEMA_MANIFEST.indexes) {
    const existing = existingRequiredIndex(snapshot, requirement);
    if (
      !existing &&
      (isRecorded(snapshot, requirement.migration) ||
        (requirement.migration === MIGRATION_0023 && reconcile0023))
    ) {
      const indexedColumnsExist = requirement.columns.every((column) =>
        tableColumns(snapshot, requirement.table).some(
          (candidate) => candidate?.name === column
        )
      );
      if (
        indexedColumnsExist &&
        duplicateCount(snapshot, requirement.duplicateCountKey) !== 0
      ) {
        throw schemaMismatch();
      }
      statements.push(requirement.createSql);
    }
  }

  for (const requirement of REQUIRED_SCHEMA_MANIFEST.triggers) {
    const existing = existingRequiredTrigger(snapshot, requirement);
    if (
      !existing &&
      (isRecorded(snapshot, requirement.migration) ||
        (requirement.migration === MIGRATION_0023 && reconcile0023))
    ) {
      statements.push(requirement.createSql);
    }
  }

  const temporary0024Body = buildPending0024OverlayPlan(snapshot);
  const ledgerAliases =
    reconcile0023 && !isRecorded(snapshot, MIGRATION_0023)
      ? [MIGRATION_0023]
      : [];
  return temporary0024Body === undefined
    ? { statements, ledgerAliases, reconcile0023 }
    : { statements, ledgerAliases, reconcile0023, temporary0024Body };
}

export function assertRequiredSchema(snapshot) {
  try {
    for (const requirement of REQUIRED_SCHEMA_MANIFEST.columns) {
      const column = findColumn(snapshot, requirement);
      if (!column || !hasRequiredColumnShape(snapshot, column, requirement)) {
        throw schemaMismatch();
      }
    }
    for (const requirement of REQUIRED_SCHEMA_MANIFEST.indexes) {
      if (!existingRequiredIndex(snapshot, requirement)) throw schemaMismatch();
    }
    for (const requirement of REQUIRED_SCHEMA_MANIFEST.triggers) {
      if (!existingRequiredTrigger(snapshot, requirement)) throw schemaMismatch();
    }
    if (snapshot.sequenceNoncanonicalCount !== 0) throw schemaMismatch();
  } catch {
    throw schemaMismatch();
  }
}

function assertMigrationSchema(snapshot, migration) {
  try {
    for (const requirement of REQUIRED_SCHEMA_MANIFEST.columns) {
      if (requirement.migration !== migration) continue;
      const column = findColumn(snapshot, requirement);
      if (!column || !hasRequiredColumnShape(snapshot, column, requirement)) {
        throw schemaMismatch();
      }
    }
    for (const requirement of REQUIRED_SCHEMA_MANIFEST.indexes) {
      if (requirement.migration !== migration) continue;
      if (!existingRequiredIndex(snapshot, requirement)) throw schemaMismatch();
    }
    for (const requirement of REQUIRED_SCHEMA_MANIFEST.triggers) {
      if (requirement.migration !== migration) continue;
      if (!existingRequiredTrigger(snapshot, requirement)) throw schemaMismatch();
    }
    if (
      migration === MIGRATION_0023 &&
      snapshot.sequenceNoncanonicalCount !== 0
    ) {
      throw schemaMismatch();
    }
  } catch {
    throw schemaMismatch();
  }
}

const OWNED_TABLES = Object.freeze([
  "wompi_events",
  "dte_documents",
  "email_deliveries",
  "donation_intents",
  "audit_logs",
  "document_sequences"
]);
const REQUIRED_INDEX_NAMES = Object.freeze(
  REQUIRED_SCHEMA_MANIFEST.indexes.map((index) => index.name)
);
const REQUIRED_INDEX_NAME_SET = new Set(REQUIRED_INDEX_NAMES);
const MIGRATION_LEDGER_QUERY = `
SELECT name
FROM sqlite_schema
WHERE type = 'table' AND name = 'd1_migrations';
`.trim();
const APPLIED_MIGRATIONS_QUERY = `
SELECT name
FROM d1_migrations
ORDER BY id;
`.trim();
const WOMPI_EVENTS_TABLE_SQL_QUERY = `
SELECT name, sql
FROM sqlite_schema
WHERE type = 'table' AND name = 'wompi_events';
`.trim();
const REQUIRED_SCHEMA_OBJECTS_QUERY = `
SELECT name, tbl_name AS table_name, sql
FROM sqlite_schema
WHERE (type = 'index' AND name IN (${REQUIRED_INDEX_NAMES.map(
  (name) => `'${name}'`
).join(", ")}))
   OR (type = 'trigger' AND name = 'reserve_wompi_document_identifiers')
ORDER BY type, name;
`.trim();
const DUPLICATE_QUERIES = Object.freeze({
  idx_email_deliveries_idempotency_key: `
    SELECT COUNT(*) AS duplicate_count FROM (
      SELECT idempotency_key FROM email_deliveries
      WHERE idempotency_key IS NOT NULL
      GROUP BY idempotency_key HAVING COUNT(*) > 1
    );`.trim(),
  idx_wompi_reserved_control: `
    SELECT COUNT(*) AS duplicate_count FROM (
      SELECT environment, control_prefix, control_sequence FROM wompi_events
      WHERE control_sequence IS NOT NULL
      GROUP BY environment, control_prefix, control_sequence HAVING COUNT(*) > 1
    );`.trim(),
  idx_wompi_reserved_generation: `
    SELECT COUNT(*) AS duplicate_count FROM (
      SELECT reserved_codigo_generacion FROM wompi_events
      WHERE reserved_codigo_generacion IS NOT NULL
      GROUP BY reserved_codigo_generacion HAVING COUNT(*) > 1
    );`.trim(),
  idx_dte_documents_wompi_unique: `
    SELECT COUNT(*) AS duplicate_count FROM (
      SELECT wompi_event_id FROM dte_documents
      WHERE wompi_event_id IS NOT NULL
      GROUP BY wompi_event_id HAVING COUNT(*) > 1
    );`.trim()
});
const NONCANONICAL_SEQUENCES_QUERY = `
SELECT COUNT(*) AS noncanonical_count
FROM document_sequences
WHERE control_prefix <> UPPER(control_prefix);
`.trim();

function pragmaQuery(pragma, name) {
  return `PRAGMA ${pragma}(${JSON.stringify(name)});`;
}

function executeArgs(binding, environment, query) {
  return [
    "d1",
    "execute",
    binding,
    "--env",
    environment,
    "--remote",
    "--json",
    "--command",
    query
  ];
}

function ledgerAliasSql(migration) {
  if (migration !== MIGRATION_0023) throw schemaMismatch();
  return [
    "INSERT INTO d1_migrations (name)",
    `SELECT '${MIGRATION_0023}'`,
    `WHERE NOT EXISTS (SELECT 1 FROM d1_migrations WHERE name = '${MIGRATION_0023}');`
  ].join("\n");
}

function parseWranglerRows(stdout) {
  try {
    const parsed = JSON.parse(String(stdout).trim());
    const envelopes = Array.isArray(parsed) ? parsed : [parsed];
    if (envelopes.length === 0) throw schemaMismatch();
    const rows = [];
    for (const envelope of envelopes) {
      if (
        envelope === null ||
        typeof envelope !== "object" ||
        envelope.success === false ||
        !Array.isArray(envelope.results)
      ) {
        throw schemaMismatch();
      }
      for (const row of envelope.results) {
        if (row === null || typeof row !== "object" || Array.isArray(row)) {
          throw schemaMismatch();
        }
        rows.push(row);
      }
    }
    return rows;
  } catch {
    throw schemaMismatch();
  }
}

function booleanMetadata(value) {
  if (value === 0 || value === 1 || value === false || value === true) {
    return value;
  }
  throw schemaMismatch();
}

async function inspectCompatibilitySnapshot(runner, binding, environment) {
  const query = async (sql) =>
    parseWranglerRows(
      await runner.run(executeArgs(binding, environment, sql), {
        capture: true
      })
    );

  const ledgerRows = await query(MIGRATION_LEDGER_QUERY);
  if (
    ledgerRows.length > 1 ||
    ledgerRows.some((row) => row.name !== "d1_migrations")
  ) {
    throw schemaMismatch();
  }
  const appliedMigrations = [];
  if (ledgerRows.length === 1) {
    for (const row of await query(APPLIED_MIGRATIONS_QUERY)) {
      if (typeof row.name !== "string") throw schemaMismatch();
      appliedMigrations.push(row.name);
    }
  }

  const tableColumns = {};
  for (const table of OWNED_TABLES) {
    tableColumns[table] = (await query(pragmaQuery("table_info", table))).map(
      (row) => {
        if (
          typeof row.name !== "string" ||
          typeof row.type !== "string"
        ) {
          throw schemaMismatch();
        }
        return {
          name: row.name,
          type: row.type,
          notnull: booleanMetadata(row.notnull),
          dflt_value:
            row.dflt_value === null || typeof row.dflt_value === "string"
              ? row.dflt_value
              : (() => {
                  throw schemaMismatch();
                })()
        };
      }
    );
  }

  const wompiEventsTableRows = await query(WOMPI_EVENTS_TABLE_SQL_QUERY);
  if (
    wompiEventsTableRows.length > 1 ||
    wompiEventsTableRows.some(
      (row) => row.name !== "wompi_events" || typeof row.sql !== "string"
    ) ||
    (tableColumns.wompi_events.length > 0) !==
      (wompiEventsTableRows.length === 1)
  ) {
    throw schemaMismatch();
  }
  const tableSql =
    wompiEventsTableRows.length === 1
      ? { wompi_events: wompiEventsTableRows[0].sql }
      : {};

  const requiredIndexMetadata = [];
  for (const table of OWNED_TABLES) {
    for (const row of await query(pragmaQuery("index_list", table))) {
      if (typeof row.name !== "string") throw schemaMismatch();
      if (!REQUIRED_INDEX_NAME_SET.has(row.name)) continue;
      requiredIndexMetadata.push({
        table,
        name: row.name,
        unique: booleanMetadata(row.unique),
        partial: booleanMetadata(row.partial)
      });
    }
  }

  const schemaRows = await query(REQUIRED_SCHEMA_OBJECTS_QUERY);
  const schemaObjects = {};
  for (const row of schemaRows) {
    if (
      typeof row.name !== "string" ||
      typeof row.table_name !== "string" ||
      typeof row.sql !== "string" ||
      schemaObjects[row.name] !== undefined
    ) {
      throw schemaMismatch();
    }
    schemaObjects[row.name] = {
      type:
        row.name === "reserve_wompi_document_identifiers"
          ? "trigger"
          : "index",
      table: row.table_name,
      sql: row.sql
    };
  }

  const indexColumns = {};
  for (const name of REQUIRED_INDEX_NAMES) {
    indexColumns[name] = (await query(pragmaQuery("index_info", name)))
      .map((row) => {
        if (!Number.isSafeInteger(row.seqno) || typeof row.name !== "string") {
          throw schemaMismatch();
        }
        return { seqno: row.seqno, name: row.name };
      })
      .sort((left, right) => left.seqno - right.seqno)
      .map(({ name: column }) => column);
  }

  const tableIndexes = Object.fromEntries(
    OWNED_TABLES.map((table) => [table, []])
  );
  for (const metadata of requiredIndexMetadata) {
    const schemaObject = schemaObjects[metadata.name];
    if (schemaObject?.type !== "index") {
        throw schemaMismatch();
      }
    tableIndexes[metadata.table].push({
      name: metadata.name,
      unique: metadata.unique,
      partial: metadata.partial,
      columns: indexColumns[metadata.name],
      sql: schemaObject.sql
    });
  }

  const duplicateCounts = {};
  for (const requirement of REQUIRED_SCHEMA_MANIFEST.indexes) {
    const columnsExist = requirement.columns.every((name) =>
      tableColumns[requirement.table].some((column) => column.name === name)
    );
    if (!columnsExist) continue;
    const duplicateRows = await query(
      DUPLICATE_QUERIES[requirement.duplicateCountKey]
    );
    if (
      duplicateRows.length !== 1 ||
      !Number.isSafeInteger(duplicateRows[0].duplicate_count) ||
      duplicateRows[0].duplicate_count < 0
    ) {
      throw schemaMismatch();
    }
    duplicateCounts[requirement.duplicateCountKey] =
      duplicateRows[0].duplicate_count;
  }

  let sequenceNoncanonicalCount = 0;
  if (tableColumns.document_sequences.length > 0) {
    const rows = await query(NONCANONICAL_SEQUENCES_QUERY);
    if (
      rows.length !== 1 ||
      !Number.isSafeInteger(rows[0].noncanonical_count) ||
      rows[0].noncanonical_count < 0
    ) {
      throw schemaMismatch();
    }
    sequenceNoncanonicalCount = rows[0].noncanonical_count;
  }

  return {
    appliedMigrations,
    tableColumns,
    tableSql,
    tableIndexes,
    schemaObjects,
    duplicateCounts,
    sequenceNoncanonicalCount
  };
}

function createMigrationOverlay(repositoryRoot, temporary0024Body) {
  const migrationsDirectory = join(realpathSync(repositoryRoot), "migrations");
  const migrationsEntry = lstatSync(migrationsDirectory);
  if (!migrationsEntry.isDirectory() || migrationsEntry.isSymbolicLink()) {
    throw new Error("Repository migrations directory is invalid");
  }
  const entries = readdirSync(migrationsDirectory, { withFileTypes: true }).sort(
    (left, right) => left.name.localeCompare(right.name)
  );
  if (
    !entries.some((entry) => entry.name === MIGRATION_0024) ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    throw new Error("Repository migrations are invalid");
  }

  const directory = mkdtempSync(join(tmpdir(), "diezmos-d1-migrations-"));
  chmodSync(directory, 0o700);
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    for (const entry of entries) {
      const destination = join(directory, entry.name);
      copyFileSync(join(migrationsDirectory, entry.name), destination);
      chmodSync(destination, 0o600);
    }
    const temporary0024 = join(directory, MIGRATION_0024);
    writeFileSync(temporary0024, temporary0024Body, { mode: 0o600 });
    chmodSync(temporary0024, 0o600);
    return { directory, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function migrateSchemaCompatibility({
  binding,
  environment,
  repositoryRoot = process.cwd(),
  createRunner = createPrivateWranglerRunner,
  signalSource = process,
  exit = (code) => process.exit(code)
}) {
  let runner;
  let overlay;
  const cleanup = () => {
    runner?.cleanup();
    overlay?.cleanup();
  };
  const signalHandler = createSignalCleanupHandler({
    cleanup,
    terminate: (signal) => runner?.terminate?.(signal),
    exit
  });
  signalSource.once("SIGINT", signalHandler);
  signalSource.once("SIGTERM", signalHandler);

  try {
    runner = createRunner({ repositoryRoot });
    const initialSnapshot = await inspectCompatibilitySnapshot(
      runner,
      binding,
      environment
    );
    const plan = buildCompatibilityPlan(initialSnapshot);
    const reconcile0023Sequences = plan.reconcile0023;
    for (const statement of plan.statements) {
      parseWranglerRows(
        await runner.run(executeArgs(binding, environment, statement), {
          capture: true
        })
      );
    }

    let repairedSnapshot;
    if (reconcile0023Sequences) {
      for (const statement of SEQUENCE_CANONICALIZATION_STATEMENTS) {
        parseWranglerRows(
          await runner.run(executeArgs(binding, environment, statement), {
            capture: true
          })
        );
      }
      repairedSnapshot = await inspectCompatibilitySnapshot(
        runner,
        binding,
        environment
      );
      if (repairedSnapshot.sequenceNoncanonicalCount !== 0) {
        throw schemaMismatch();
      }
      assertMigrationSchema(repairedSnapshot, MIGRATION_0023);
    }
    if (plan.ledgerAliases.length > 0) {
      repairedSnapshot ??= await inspectCompatibilitySnapshot(
        runner,
        binding,
        environment
      );
      for (const migration of plan.ledgerAliases) {
        assertMigrationSchema(repairedSnapshot, migration);
        parseWranglerRows(
          await runner.run(
            executeArgs(binding, environment, ledgerAliasSql(migration)),
            { capture: true }
          )
        );
      }
    }

    const preMigrationPlan = buildCompatibilityPlan(
      await inspectCompatibilitySnapshot(runner, binding, environment)
    );
    if (preMigrationPlan.temporary0024Body !== undefined) {
      overlay = createMigrationOverlay(
        repositoryRoot,
        preMigrationPlan.temporary0024Body
      );
      const previousRunner = runner;
      runner = undefined;
      previousRunner.cleanup();
      runner = createRunner({
        repositoryRoot,
        migrationsDirOverride: overlay.directory
      });
    }

    await runner.run(
      [
        "d1",
        "migrations",
        "apply",
        binding,
        "--env",
        environment,
        "--remote"
      ],
      { capture: false }
    );
    assertRequiredSchema(
      await inspectCompatibilitySnapshot(runner, binding, environment)
    );
  } finally {
    signalSource.removeListener("SIGINT", signalHandler);
    signalSource.removeListener("SIGTERM", signalHandler);
    cleanup();
  }
}

function parseMigrateArgs(argv) {
  const usage = "Usage: d1-schema-compatibility migrate --binding <name> --env <name>";
  if (argv[0] !== "migrate") throw new Error(usage);
  const values = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (
      (key !== "--binding" && key !== "--env") ||
      !value ||
      values.has(key)
    ) {
      throw new Error(usage);
    }
    values.set(key, value);
  }
  const binding = values.get("--binding");
  const environment = values.get("--env");
  if (!binding || !environment || argv.length !== 5) throw new Error(usage);
  return { binding, environment };
}

async function runCli() {
  try {
    await migrateSchemaCompatibility(parseMigrateArgs(process.argv.slice(2)));
    process.stdout.write("D1 schema compatibility migration passed.\n");
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
