import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  legacyIssuanceAttemptId,
  Repository
} from "../../src/worker/storage/repository";
import { sqliteD1 } from "../worker/support/sqliteD1";

const scriptPath = resolve(
  import.meta.dirname,
  "../../scripts/d1-schema-compatibility.mjs"
);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const migrationsDirectory = resolve(repositoryRoot, "migrations");
const CURRENT_0023 = "0023_wompi_issuance_lifecycle.sql";
const LEGACY_0019 = "0019_wompi_issuance_lifecycle.sql";
const runnerScriptPath = resolve(
  import.meta.dirname,
  "../../scripts/run-private-wrangler.mjs"
);

const REQUIRED_INDEX_FIXTURES = [
  {
    name: "idx_email_deliveries_idempotency_key",
    table: "email_deliveries",
    columns: ["idempotency_key"],
    predicate: "idempotency_key IS NOT NULL",
    createSql: `CREATE UNIQUE INDEX idx_email_deliveries_idempotency_key
  ON email_deliveries(idempotency_key)
  WHERE idempotency_key IS NOT NULL;`
  },
  {
    name: "idx_wompi_reserved_control",
    table: "wompi_events",
    columns: ["environment", "control_prefix", "control_sequence"],
    predicate: "control_sequence IS NOT NULL",
    createSql: `CREATE UNIQUE INDEX idx_wompi_reserved_control
  ON wompi_events(environment, control_prefix, control_sequence)
  WHERE control_sequence IS NOT NULL;`
  },
  {
    name: "idx_wompi_reserved_generation",
    table: "wompi_events",
    columns: ["reserved_codigo_generacion"],
    predicate: "reserved_codigo_generacion IS NOT NULL",
    createSql: `CREATE UNIQUE INDEX idx_wompi_reserved_generation
  ON wompi_events(reserved_codigo_generacion)
  WHERE reserved_codigo_generacion IS NOT NULL;`
  },
  {
    name: "idx_dte_documents_wompi_unique",
    table: "dte_documents",
    columns: ["wompi_event_id"],
    predicate: "wompi_event_id IS NOT NULL",
    createSql: `CREATE UNIQUE INDEX idx_dte_documents_wompi_unique
  ON dte_documents(wompi_event_id)
  WHERE wompi_event_id IS NOT NULL;`
  }
] as const;

const INDEX_QUOTE_PATHS = [
  { quote: "double", ledger: "legacy" },
  { quote: "backtick", ledger: "current" },
  { quote: "bracket", ledger: "fresh-partial" }
] as const;

async function loadCompatibility() {
  expect(existsSync(scriptPath), "the D1 compatibility script exists").toBe(true);
  return import(scriptPath);
}

describe("legacy Wompi issuance migration compatibility", () => {
  it("repairs document correlation for databases that applied the original 0009", async () => {
    const { buildCompatibilityPlan } = await loadCompatibility();
    const plan = buildCompatibilityPlan({
      appliedMigrations: ["0009_donation_intents.sql"],
      tableColumns: {
        donation_intents: [{ name: "id", type: "TEXT", notnull: 0 }]
      },
      tableIndexes: {},
      schemaObjects: {},
      tableSql: {},
      duplicateCounts: {}
    });

    expect(plan.statements).toContain(
      "ALTER TABLE donation_intents ADD COLUMN document_id TEXT;"
    );
  });

  it("allowlists all 0023 columns, unique indexes, and the reservation trigger", async () => {
    const { REQUIRED_SCHEMA_MANIFEST } = await loadCompatibility();
    expect(
      REQUIRED_SCHEMA_MANIFEST.columns
        .filter((entry: { migration: string; table: string }) =>
          entry.migration === CURRENT_0023 && entry.table === "wompi_events"
        )
        .map((entry: { column: string }) => entry.column)
    ).toEqual([
      "issuance_status",
      "control_prefix",
      "control_sequence",
      "reserved_numero_control",
      "reserved_codigo_generacion",
      "issuance_attempt_count",
      "issuance_attempt_id",
      "issuance_error_code",
      "issuance_error_message",
      "issuance_last_attempt_at",
      "issuance_failed_at",
      "issuance_dead_lettered_at"
    ]);
    expect(
      REQUIRED_SCHEMA_MANIFEST.indexes.map(
        (entry: { name: string }) => entry.name
      )
    ).toEqual([
      "idx_email_deliveries_idempotency_key",
      "idx_wompi_reserved_control",
      "idx_wompi_reserved_generation",
      "idx_dte_documents_wompi_unique"
    ]);
    expect(
      REQUIRED_SCHEMA_MANIFEST.triggers.map(
        (entry: { name: string }) => entry.name
      )
    ).toEqual(["reserve_wompi_document_identifiers"]);
  });

  it("plans the missing late fields and a verified current-ledger alias for old 0019", async () => {
    const { buildCompatibilityPlan } = await loadCompatibility();
    const plan = buildCompatibilityPlan({
      appliedMigrations: ["0019_wompi_issuance_lifecycle.sql"],
      tableColumns: {
        wompi_events: [
          { name: "issuance_status", type: "TEXT", notnull: 0 },
          { name: "control_prefix", type: "TEXT", notnull: 0 },
          { name: "control_sequence", type: "INTEGER", notnull: 0 },
          { name: "reserved_numero_control", type: "TEXT", notnull: 0 },
          { name: "reserved_codigo_generacion", type: "TEXT", notnull: 0 },
          {
            name: "issuance_attempt_count",
            type: "INTEGER",
            notnull: 1,
            dflt_value: "0"
          },
          { name: "issuance_error_code", type: "TEXT", notnull: 0 },
          { name: "issuance_error_message", type: "TEXT", notnull: 0 },
          { name: "issuance_last_attempt_at", type: "TEXT", notnull: 0 },
          { name: "issuance_failed_at", type: "TEXT", notnull: 0 },
          { name: "issuance_dead_lettered_at", type: "TEXT", notnull: 0 }
        ],
        dte_documents: [],
        email_deliveries: [],
        donation_intents: [],
        audit_logs: []
      },
      tableIndexes: {
        wompi_events: [],
        dte_documents: [],
        email_deliveries: [],
        donation_intents: [],
        audit_logs: []
      },
      schemaObjects: {},
      tableSql: {
        wompi_events: `CREATE TABLE wompi_events (
          issuance_status TEXT CHECK (issuance_status IN ('PROCESSING', 'FAILED', 'DEAD_LETTERED', 'RETRY_QUEUED', 'DOCUMENT_CREATED', 'IGNORED')),
          issuance_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (issuance_attempt_count >= 0)
        )`
      },
      duplicateCounts: {
        idx_wompi_reserved_control: 0,
        idx_wompi_reserved_generation: 0
      }
    });

    expect(plan.statements).toEqual(expect.arrayContaining([
      "ALTER TABLE wompi_events ADD COLUMN issuance_attempt_id TEXT;",
      "ALTER TABLE dte_documents ADD COLUMN transmission_claim_id TEXT;",
      "ALTER TABLE email_deliveries ADD COLUMN claim_attempted_at TEXT;",
      "ALTER TABLE email_deliveries ADD COLUMN idempotency_key TEXT;",
      "ALTER TABLE email_deliveries ADD COLUMN claim_token TEXT;"
    ]));
    expect(plan.ledgerAliases).toEqual([
      "0023_wompi_issuance_lifecycle.sql"
    ]);
    expect(plan.reconcile0023).toBe(true);
  });

  it("reproduces the old 0019 claim failure, then converges and aliases 0023 only after repair", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    database.exec(initialLegacyIssuanceMigration());
    recordMigration(database, LEGACY_0019);
    database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body
       ) VALUES ('legacy_event', 'legacy_transaction', '00',
         'ExitosaAprobada', 100, '{}')`
    ).run();
    const repo = new Repository(sqliteD1(database));
    const attempt = legacyIssuanceAttemptId("legacy_event");

    await expect(
      repo.markWompiIssuanceProcessing("legacy_event", attempt, true)
    ).rejects.toThrow(/no such column: issuance_attempt_id/i);
    expect(() =>
      database.exec(readMigration(CURRENT_0023))
    ).toThrow(/duplicate column name: issuance_status/i);

    const runner = sqliteRunnerFactory(database);
    await migrateSchemaCompatibility({
      binding: "DB",
      environment: "staging",
      repositoryRoot,
      createRunner: runner.createRunner
    });

    expect(appliedMigrations(database)).toContain(CURRENT_0023);
    expect(columns(database, "wompi_events")).toContain("issuance_attempt_id");
    await expect(
      repo.markWompiIssuanceProcessing("legacy_event", attempt, true)
    ).resolves.toBe(true);

    const afterFirstRun = compatibilityFingerprint(database);
    await migrateSchemaCompatibility({
      binding: "DB",
      environment: "staging",
      repositoryRoot,
      createRunner: runner.createRunner
    });
    expect(compatibilityFingerprint(database)).toEqual(afterFirstRun);
    expect(
      appliedMigrations(database).filter((name) => name === CURRENT_0023)
    ).toHaveLength(1);
    database.close();
  });

  it("aliases the fully mutated old 0019 without changing populated fencing values", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    database.exec(readMigration(CURRENT_0023));
    recordMigration(database, LEGACY_0019);
    seedIssuanceEvidence(database);
    const before = issuanceEvidence(database);

    await runCompatibility(database, migrateSchemaCompatibility);
    await runCompatibility(database, migrateSchemaCompatibility);

    expect(issuanceEvidence(database)).toEqual(before);
    expect(
      appliedMigrations(database).filter((name) => name === CURRENT_0023)
    ).toHaveLength(1);
    database.close();
  });

  it("repairs a current recorded 0023 whose late fields are absent", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    database.exec(initialLegacyIssuanceMigration());
    recordMigration(database, CURRENT_0023);
    database.prepare(
      `INSERT INTO document_sequences (environment, control_prefix, next_value)
       VALUES ('00', 'm001p004', 12)`
    ).run();

    await runCompatibility(database, migrateSchemaCompatibility);

    expect(columns(database, "wompi_events")).toContain("issuance_attempt_id");
    expect(columns(database, "dte_documents")).toContain(
      "transmission_claim_id"
    );
    expect(columns(database, "email_deliveries")).toEqual(
      expect.arrayContaining([
        "claim_attempted_at",
        "idempotency_key",
        "claim_token"
      ])
    );
    expect(database.prepare(
      `SELECT control_prefix, next_value FROM document_sequences
       WHERE environment = '00'`
    ).all()).toEqual([{ control_prefix: "M001P004", next_value: 12 }]);
    database.close();
  });

  it("preserves every one- and two-column email-claim partial while converging twice", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const variants = [
      ["claim_attempted_at"],
      ["idempotency_key"],
      ["claim_token"],
      ["claim_attempted_at", "idempotency_key"],
      ["claim_attempted_at", "claim_token"],
      ["idempotency_key", "claim_token"]
    ];
    for (const present of variants) {
      const database = databaseThrough("0022");
      database.exec(initialLegacyIssuanceMigration());
      database.exec(
        "ALTER TABLE wompi_events ADD COLUMN issuance_attempt_id TEXT;"
      );
      database.exec(
        "ALTER TABLE dte_documents ADD COLUMN transmission_claim_id TEXT;"
      );
      for (const column of present) {
        database.exec(
          `ALTER TABLE email_deliveries ADD COLUMN ${column} TEXT;`
        );
      }
      recordMigration(database, CURRENT_0023);
      seedPartialEmailEvidence(database, present);
      const before = partialEmailEvidence(database, present);

      await runCompatibility(database, migrateSchemaCompatibility);
      await runCompatibility(database, migrateSchemaCompatibility);

      expect(partialEmailEvidence(database, present)).toEqual(before);
      expect(columns(database, "email_deliveries")).toEqual(
        expect.arrayContaining([
          "claim_attempted_at",
          "idempotency_key",
          "claim_token"
        ])
      );
      expect(database.prepare("PRAGMA index_list(email_deliveries)").all())
        .toContainEqual(expect.objectContaining({
          name: "idx_email_deliveries_idempotency_key",
          unique: 1
        }));
      database.close();
    }
  });

  for (const variant of ["zero", "donation", "audit", "both"] as const) {
    it(`converges pending 0024 with ${variant} existing provenance columns without losing values`, async () => {
      const { migrateSchemaCompatibility } = await loadCompatibility();
      const database = databaseThrough("0023");
      if (variant === "donation" || variant === "both") {
        database.exec(
          "ALTER TABLE donation_intents ADD COLUMN rate_limit_claim_id TEXT;"
        );
      }
      if (variant === "audit" || variant === "both") {
        database.exec(
          "ALTER TABLE audit_logs ADD COLUMN rate_limit_claim_id TEXT;"
        );
      }
      seedRateLimitEvidence(database, variant);
      const before = rateLimitEvidence(database, variant);
      const runner = sqliteRunnerFactory(database);

      await runCompatibility(
        database,
        migrateSchemaCompatibility,
        runner.createRunner
      );
      const afterFirst = compatibilityFingerprint(database);
      await runCompatibility(
        database,
        migrateSchemaCompatibility,
        runner.createRunner
      );

      expect(rateLimitEvidence(database, variant)).toEqual(before);
      expect(compatibilityFingerprint(database)).toEqual(afterFirst);
      expect(columns(database, "donation_intents")).toContain(
        "rate_limit_claim_id"
      );
      expect(columns(database, "audit_logs")).toContain("rate_limit_claim_id");
      if (variant !== "zero") {
        expect(runner.migrationDirectories.some(Boolean)).toBe(true);
      }
      database.close();
    });
  }

  it("repairs a recorded 0024 with only one provenance column", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0023");
    database.exec(
      "ALTER TABLE donation_intents ADD COLUMN rate_limit_claim_id TEXT;"
    );
    recordMigration(database, "0024_add_rate_limit_claim_ids.sql");
    seedRateLimitEvidence(database, "donation");

    await runCompatibility(database, migrateSchemaCompatibility);

    expect(rateLimitEvidence(database, "donation")).toEqual({
      donation: "claim-donation"
    });
    expect(columns(database, "audit_logs")).toContain("rate_limit_claim_id");
    database.close();
  });

  it("repairs a recorded 0030 whose canonical column is absent", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0029");
    recordMigration(database, "0030_wompi_reconciliation_lifecycle.sql");

    await runCompatibility(database, migrateSchemaCompatibility);
    await runCompatibility(database, migrateSchemaCompatibility);

    expect(columns(database, "wompi_events")).toContain(
      "stalled_requeue_epoch_at"
    );
    database.close();
  });

  it("aborts duplicate email keys before aliasing or changing rows", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    database.exec(withoutEmailIdempotencyIndex(readMigration(CURRENT_0023)));
    recordMigration(database, LEGACY_0019);
    seedDuplicateEmailKeys(database);
    const before = database.prepare(
      "SELECT id, idempotency_key FROM email_deliveries ORDER BY id"
    ).all();

    await expect(
      runCompatibility(database, migrateSchemaCompatibility)
    ).rejects.toThrow("D1 schema compatibility mismatch");

    expect(database.prepare(
      "SELECT id, idempotency_key FROM email_deliveries ORDER BY id"
    ).all()).toEqual(before);
    expect(appliedMigrations(database)).not.toContain(CURRENT_0023);
    database.close();
  });

  it.each(REQUIRED_INDEX_FIXTURES.flatMap((fixture) =>
    INDEX_QUOTE_PATHS.map((path) => ({
      label: `${fixture.name} ${path.quote} ${path.ledger}`,
      fixture,
      ...path
    }))
  ))("rejects quoted whole-predicate index decoy $label", async ({
    fixture,
    quote,
    ledger
  }) => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    prepareRequiredIndexFixture(database, fixture.name);
    const quotedPredicate = quoteSqlIdentifier(fixture.predicate, quote);
    database.exec(
      `ALTER TABLE ${fixture.table} ADD COLUMN ${quotedPredicate} INTEGER;`
    );
    const canonicalMigration = readMigration(CURRENT_0023);
    const decoyMigration = canonicalMigration.replace(
      fixture.createSql,
      fixture.createSql.replace(
        `WHERE ${fixture.predicate}`,
        `WHERE ${quotedPredicate}`
      )
    );
    expect(decoyMigration).not.toBe(canonicalMigration);
    database.exec(decoyMigration);
    if (ledger === "legacy") recordMigration(database, LEGACY_0019);
    if (ledger === "current") recordMigration(database, CURRENT_0023);
    seedRequiredIndexDuplicates(database, fixture.name);
    const before = indexCompatibilityEvidence(database, fixture.table);
    expect(before.rows).toHaveLength(2);

    await expect(
      runCompatibility(database, migrateSchemaCompatibility)
    ).rejects.toThrow("D1 schema compatibility mismatch");

    expect(indexCompatibilityEvidence(database, fixture.table)).toEqual(before);
    if (ledger !== "current") {
      expect(appliedMigrations(database)).not.toContain(CURRENT_0023);
    }
    database.close();
  });

  it("rejects a whole-predicate quoted identifier with zero canonical duplicates", async () => {
    const { buildCompatibilityPlan } = await loadCompatibility();
    const fixture = REQUIRED_INDEX_FIXTURES[0];
    const quotedPredicate = quoteSqlIdentifier(fixture.predicate, "double");
    const snapshot = singleRequiredIndexSnapshot(
      fixture,
      fixture.table,
      {
        sql: fixture.createSql.replace(
          `WHERE ${fixture.predicate}`,
          `WHERE ${quotedPredicate}`
        )
      }
    );

    expect(() => buildCompatibilityPlan(snapshot)).toThrow(
      "D1 schema compatibility mismatch"
    );
  });

  it.each([
    {
      label: "single-quoted literal predicate",
      predicateSql: "'idempotency_key IS NOT NULL'"
    },
    {
      label: "line-comment-hidden predicate",
      predicateSql: "-- idempotency_key IS NOT NULL\n  0"
    },
    {
      label: "block-comment-hidden predicate",
      predicateSql: "/* idempotency_key IS NOT NULL */ 0"
    },
    {
      label: "changed predicate",
      predicateSql: "idempotency_key IS NULL"
    }
  ])("rejects an email index with $label", async ({ predicateSql }) => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const fixture = REQUIRED_INDEX_FIXTURES[0];
    const database = databaseThrough("0022");
    const migration = readMigration(CURRENT_0023).replace(
      fixture.createSql,
      fixture.createSql.replace(
        `WHERE ${fixture.predicate}`,
        `WHERE ${predicateSql}`
      )
    );
    database.exec(migration);
    recordMigration(database, LEGACY_0019);
    const before = indexCompatibilityEvidence(database, fixture.table);

    await expect(
      runCompatibility(database, migrateSchemaCompatibility)
    ).rejects.toThrow("D1 schema compatibility mismatch");

    expect(indexCompatibilityEvidence(database, fixture.table)).toEqual(before);
    expect(appliedMigrations(database)).not.toContain(CURRENT_0023);
    database.close();
  });

  it("keeps comment-looking text inside an index identifier", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const fixture = REQUIRED_INDEX_FIXTURES[0];
    const database = databaseThrough("0022");
    const decoy = quoteSqlIdentifier(
      "idempotency_key/*not-a-comment*/",
      "double"
    );
    database.exec(
      `ALTER TABLE email_deliveries ADD COLUMN ${decoy} INTEGER;`
    );
    database.exec(readMigration(CURRENT_0023).replace(
      fixture.createSql,
      fixture.createSql.replace(
        `WHERE ${fixture.predicate}`,
        `WHERE ${decoy} IS NOT NULL`
      )
    ));
    recordMigration(database, LEGACY_0019);
    const before = indexCompatibilityEvidence(database, fixture.table);

    await expect(
      runCompatibility(database, migrateSchemaCompatibility)
    ).rejects.toThrow("D1 schema compatibility mismatch");

    expect(indexCompatibilityEvidence(database, fixture.table)).toEqual(before);
    expect(appliedMigrations(database)).not.toContain(CURRENT_0023);
    database.close();
  });

  it("rejects a required index with a missing predicate", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const fixture = REQUIRED_INDEX_FIXTURES[0];
    const database = databaseThrough("0022");
    database.exec(readMigration(CURRENT_0023).replace(
      fixture.createSql,
      fixture.createSql.replace(`\n  WHERE ${fixture.predicate}`, "")
    ));
    recordMigration(database, LEGACY_0019);
    const before = indexCompatibilityEvidence(database, fixture.table);

    await expect(
      runCompatibility(database, migrateSchemaCompatibility)
    ).rejects.toThrow("D1 schema compatibility mismatch");

    expect(indexCompatibilityEvidence(database, fixture.table)).toEqual(before);
    expect(appliedMigrations(database)).not.toContain(CURRENT_0023);
    database.close();
  });

  it.each(REQUIRED_INDEX_FIXTURES.map((fixture, position) => ({
    fixture,
    quote: INDEX_QUOTE_PATHS[position % INDEX_QUOTE_PATHS.length].quote
  })))("accepts a cosmetic typed index $fixture.name and enforces uniqueness", async ({
    fixture,
    quote
  }) => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    prepareRequiredIndexFixture(database, fixture.name);
    const quotedName = quoteSqlIdentifier(fixture.name, quote);
    const quotedTable = quoteSqlIdentifier(fixture.table, quote);
    const quotedColumns = fixture.columns
      .map((column) => quoteSqlIdentifier(column, quote))
      .join(" ,  ");
    const predicateColumn = fixture.predicate.split(" ")[0];
    const quotedPredicateColumn = quoteSqlIdentifier(predicateColumn, quote);
    const cosmeticSql = [
      `cReAtE UnIqUe InDeX IF NOT EXISTS ${quotedName}`,
      `  /* between grammar tokens */ ON ${quotedTable} ( ${quotedColumns} )`,
      `  WHERE ${quotedPredicateColumn} IS -- active predicate\n    NOT /* active predicate */ NULL;`
    ].join("\n");
    database.exec(readMigration(CURRENT_0023).replace(
      fixture.createSql,
      cosmeticSql
    ));
    recordMigration(database, LEGACY_0019);

    await runCompatibility(database, migrateSchemaCompatibility);

    seedRequiredIndexRow(database, fixture.name, "a");
    expect(() => seedRequiredIndexRow(database, fixture.name, "b")).toThrow();
    expect(appliedMigrations(database)).toContain(CURRENT_0023);
    database.close();
  });

  it("rejects positive duplicate counts at planning and final postflight", async () => {
    const { REQUIRED_SCHEMA_MANIFEST, assertRequiredSchema, buildCompatibilityPlan } =
      await loadCompatibility();
    const snapshot = canonicalCompatibilitySnapshot(REQUIRED_SCHEMA_MANIFEST);
    snapshot.duplicateCounts.idx_email_deliveries_idempotency_key = 1;

    expect(() => buildCompatibilityPlan(snapshot)).toThrow(
      "D1 schema compatibility mismatch"
    );
    expect(() => assertRequiredSchema(snapshot)).toThrow(
      "D1 schema compatibility mismatch"
    );
  });

  it.each([
    {
      label: "wrong owning table",
      fixture: REQUIRED_INDEX_FIXTURES[0],
      ownerTable: "wompi_events",
      overrides: {}
    },
    {
      label: "wrong indexed column",
      fixture: REQUIRED_INDEX_FIXTURES[0],
      ownerTable: "email_deliveries",
      overrides: { columns: ["claim_token"] }
    },
    {
      label: "wrong SQL-declared name",
      fixture: REQUIRED_INDEX_FIXTURES[0],
      ownerTable: "email_deliveries",
      overrides: {
        sql: REQUIRED_INDEX_FIXTURES[0].createSql.replace(
          REQUIRED_INDEX_FIXTURES[0].name,
          "idx_wrong_name"
        )
      }
    },
    {
      label: "wrong composite-column order",
      fixture: REQUIRED_INDEX_FIXTURES[1],
      ownerTable: "wompi_events",
      overrides: {
        columns: ["control_prefix", "environment", "control_sequence"]
      }
    },
    {
      label: "non-unique index",
      fixture: REQUIRED_INDEX_FIXTURES[0],
      ownerTable: "email_deliveries",
      overrides: { unique: 0 }
    },
    {
      label: "non-partial index",
      fixture: REQUIRED_INDEX_FIXTURES[0],
      ownerTable: "email_deliveries",
      overrides: { partial: 0 }
    },
    {
      label: "IF NOT EXISTS outside its grammar position",
      fixture: REQUIRED_INDEX_FIXTURES[0],
      ownerTable: "email_deliveries",
      overrides: {
        sql: `CREATE UNIQUE INDEX idx_email_deliveries_idempotency_key
          IF NOT EXISTS ON email_deliveries(idempotency_key)
          WHERE idempotency_key IS NOT NULL;`
      }
    }
  ])("rejects a required index with $label", async ({
    fixture,
    ownerTable,
    overrides
  }) => {
    const { buildCompatibilityPlan } = await loadCompatibility();
    const snapshot = singleRequiredIndexSnapshot(
      fixture,
      ownerTable,
      overrides
    );

    expect(() => buildCompatibilityPlan(snapshot)).toThrow(
      "D1 schema compatibility mismatch"
    );
  });

  it("plans the canonical index alongside a differently named extra index", async () => {
    const { buildCompatibilityPlan } = await loadCompatibility();
    const fixture = REQUIRED_INDEX_FIXTURES[0];
    const snapshot = singleRequiredIndexSnapshot(
      fixture,
      fixture.table,
      {
        name: "idx_wrong_name",
        sql: fixture.createSql.replace(
          fixture.name,
          "idx_wrong_name"
        )
      }
    );

    expect(buildCompatibilityPlan(snapshot).statements).toContain(
      fixture.createSql
    );
  });

  it("canonicalizes late lowercase sequence rows before recording the 0023 alias", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    database.exec(initialLegacyIssuanceMigration());
    recordMigration(database, LEGACY_0019);
    database.exec(`
      INSERT INTO document_sequences (environment, control_prefix, next_value)
      VALUES ('00', 'M001P004', 4), ('00', 'm001p004', 23);
    `);

    await runCompatibility(database, migrateSchemaCompatibility);

    expect(database.prepare(
      `SELECT environment, control_prefix, next_value
       FROM document_sequences ORDER BY environment, control_prefix`
    ).all()).toEqual([
      { environment: "00", control_prefix: "M001P004", next_value: 23 }
    ]);
    expect(appliedMigrations(database)).toContain(CURRENT_0023);
    database.close();
  });

  it("canonicalizes a schema-detected partial 0023 with no predecessor ledger name", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    database.exec(canonicalIssuanceStatusColumnSql());
    database.prepare(
      `INSERT INTO document_sequences (environment, control_prefix, next_value)
       VALUES ('00', 'm001p004', 19)`
    ).run();

    await runCompatibility(database, migrateSchemaCompatibility);

    expect(appliedMigrations(database)).toContain(CURRENT_0023);
    expect(database.prepare(
      `SELECT environment, control_prefix, next_value
       FROM document_sequences ORDER BY environment, control_prefix`
    ).all()).toEqual([
      { environment: "00", control_prefix: "M001P004", next_value: 19 }
    ]);
    database.close();
  });

  it("reruns sequence normalization after interruption following the last schema repair", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    database.exec(initialLegacyIssuanceMigration());
    recordMigration(database, CURRENT_0023);
    database.prepare(
      `INSERT INTO document_sequences (environment, control_prefix, next_value)
       VALUES ('00', 'm001p004', 27)`
    ).run();
    const base = sqliteRunnerFactory(database);
    let interrupted = false;
    const failFirstSequenceRepair = (
      options: { migrationsDirOverride?: string } = {}
    ) => {
      const runner = base.createRunner(options);
      return {
        async run(args: string[]) {
          const query = args[args.indexOf("--command") + 1] ?? "";
          if (
            !interrupted &&
            query.startsWith("INSERT OR IGNORE INTO document_sequences")
          ) {
            interrupted = true;
            throw new Error("injected post-DDL interruption");
          }
          return runner.run(args);
        },
        cleanup: runner.cleanup
      };
    };

    await expect(
      runCompatibility(
        database,
        migrateSchemaCompatibility,
        failFirstSequenceRepair
      )
    ).rejects.toThrow("injected post-DDL interruption");
    expect(columns(database, "email_deliveries")).toEqual(
      expect.arrayContaining([
        "claim_attempted_at",
        "idempotency_key",
        "claim_token"
      ])
    );

    await runCompatibility(database, migrateSchemaCompatibility);

    expect(database.prepare(
      `SELECT control_prefix, next_value FROM document_sequences
       WHERE environment = '00'`
    ).all()).toEqual([{ control_prefix: "M001P004", next_value: 27 }]);
    database.close();
  });

  it("includes canonical sequence state in the final postflight", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0031");
    const base = sqliteRunnerFactory(database);
    let injected = false;
    const injectPostMigrationSequence = (
      options: { migrationsDirOverride?: string } = {}
    ) => {
      const runner = base.createRunner(options);
      return {
        async run(args: string[]) {
          const output = await runner.run(args);
          if (
            !injected &&
            args[0] === "d1" &&
            args[1] === "migrations"
          ) {
            injected = true;
            database.prepare(
              `INSERT INTO document_sequences (
                 environment, control_prefix, next_value
               ) VALUES ('00', 'm001p004', 31)`
            ).run();
          }
          return output;
        },
        cleanup: runner.cleanup
      };
    };

    await expect(
      runCompatibility(
        database,
        migrateSchemaCompatibility,
        injectPostMigrationSequence
      )
    ).rejects.toThrow("D1 schema compatibility mismatch");
    database.close();
  });

  it("rejects missing or altered lifecycle CHECK constraints without changing rows", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const variants = [
      {
        label: "missing status check",
        sql: "ALTER TABLE wompi_events ADD COLUMN issuance_status TEXT;"
      },
      {
        label: "altered status check",
        sql: `ALTER TABLE wompi_events ADD COLUMN issuance_status TEXT
          CHECK (issuance_status IN ('PROCESSING', 'FAILED', 'NOT_CANONICAL'));`
      },
      {
        label: "missing attempt check",
        sql: `${canonicalIssuanceStatusColumnSql()}
          ALTER TABLE wompi_events ADD COLUMN issuance_attempt_count INTEGER NOT NULL DEFAULT 0;`
      },
      {
        label: "altered attempt check",
        sql: `${canonicalIssuanceStatusColumnSql()}
          ALTER TABLE wompi_events ADD COLUMN issuance_attempt_count INTEGER NOT NULL DEFAULT 0
            CHECK (issuance_attempt_count >= -1);`
      }
    ];

    for (const variant of variants) {
      const database = databaseThrough("0022");
      database.prepare(
        `INSERT INTO wompi_events (
           id, transaction_id, environment, result, amount_cents, raw_body
         ) VALUES ('constraint_event', 'constraint_transaction', '00',
           'ExitosaAprobada', 100, '{}')`
      ).run();
      database.exec(variant.sql);
      const rowBefore = database.prepare(
        `SELECT id, transaction_id, environment, result, amount_cents, raw_body
         FROM wompi_events WHERE id = 'constraint_event'`
      ).get();
      const schemaBefore = database.prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'wompi_events'"
      ).get();

      await expect(
        runCompatibility(database, migrateSchemaCompatibility),
        variant.label
      ).rejects.toThrow("D1 schema compatibility mismatch");

      expect(database.prepare(
        `SELECT id, transaction_id, environment, result, amount_cents, raw_body
         FROM wompi_events WHERE id = 'constraint_event'`
      ).get()).toEqual(rowBefore);
      expect(database.prepare(
        "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'wompi_events'"
      ).get()).toEqual(schemaBefore);
      expect(appliedMigrations(database)).not.toContain(CURRENT_0023);
      database.close();
    }
  });

  it.each([
    {
      label: "block-commented status check",
      sql: `ALTER TABLE wompi_events ADD COLUMN issuance_status TEXT
        /* CHECK (issuance_status IN ('PROCESSING', 'FAILED', 'DEAD_LETTERED', 'RETRY_QUEUED', 'DOCUMENT_CREATED', 'IGNORED')) */;`
    },
    {
      label: "block-commented attempt-count check",
      sql: `${canonicalIssuanceStatusColumnSql()}
        ALTER TABLE wompi_events ADD COLUMN issuance_attempt_count INTEGER NOT NULL DEFAULT 0
          /* CHECK (issuance_attempt_count >= 0) */;`
    }
  ])("rejects a $label without changing rows", async ({ sql }) => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body
       ) VALUES ('commented_check_event', 'commented_check_transaction', '00',
         'ExitosaAprobada', 100, '{}')`
    ).run();
    database.exec(sql);
    const rowBefore = database.prepare(
      "SELECT * FROM wompi_events WHERE id = 'commented_check_event'"
    ).get();
    const schemaBefore = database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'wompi_events'"
    ).get();

    await expect(
      runCompatibility(database, migrateSchemaCompatibility)
    ).rejects.toThrow("D1 schema compatibility mismatch");

    expect(database.prepare(
      "SELECT * FROM wompi_events WHERE id = 'commented_check_event'"
    ).get()).toEqual(rowBefore);
    expect(database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'wompi_events'"
    ).get()).toEqual(schemaBefore);
    expect(appliedMigrations(database)).not.toContain(CURRENT_0023);
    database.close();
  });

  it.each([
    {
      label: "double-quoted attempt-count decoy with legacy 0019",
      requiredColumnSql:
        "issuance_attempt_count INTEGER NOT NULL DEFAULT 0",
      decoyIdentifier: '"CHECK (issuance_attempt_count >= 0)"',
      invalidColumn: "issuance_attempt_count",
      invalidValue: -1,
      recordLegacy: true
    },
    {
      label: "backtick-quoted attempt-count decoy with no predecessor ledger",
      requiredColumnSql:
        "issuance_attempt_count INTEGER NOT NULL DEFAULT 0",
      decoyIdentifier: "`CHECK (issuance_attempt_count >= 0)`",
      invalidColumn: "issuance_attempt_count",
      invalidValue: -1,
      recordLegacy: false
    },
    {
      label: "bracket-quoted attempt-count decoy with no predecessor ledger",
      requiredColumnSql:
        "issuance_attempt_count INTEGER NOT NULL DEFAULT 0",
      decoyIdentifier: "[CHECK (issuance_attempt_count >= 0)]",
      invalidColumn: "issuance_attempt_count",
      invalidValue: -1,
      recordLegacy: false
    },
    {
      label: "double-quoted status decoy with no predecessor ledger",
      requiredColumnSql: "issuance_status TEXT",
      decoyIdentifier:
        "\"CHECK (issuance_status IN ('PROCESSING', 'FAILED', 'DEAD_LETTERED', 'RETRY_QUEUED', 'DOCUMENT_CREATED', 'IGNORED'))\"",
      invalidColumn: "issuance_status",
      invalidValue: "NOT_A_CANONICAL_STATUS",
      recordLegacy: false
    }
  ])("rejects a $label without aliasing or mutation", async ({
    requiredColumnSql,
    decoyIdentifier,
    invalidColumn,
    invalidValue,
    recordLegacy: shouldRecordLegacy
  }) => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    database.exec(`
      ALTER TABLE wompi_events ADD COLUMN ${requiredColumnSql};
      ALTER TABLE wompi_events ADD COLUMN ${decoyIdentifier} TEXT;
    `);
    database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body,
         ${invalidColumn}
       ) VALUES ('quoted_decoy_event', 'quoted_decoy_transaction', '00',
         'ExitosaAprobada', 100, '{}', ?)`
    ).run(invalidValue);
    if (shouldRecordLegacy) recordMigration(database, LEGACY_0019);
    const rowBefore = database.prepare(
      "SELECT * FROM wompi_events WHERE id = 'quoted_decoy_event'"
    ).get();
    const schemaBefore = database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'wompi_events'"
    ).get();

    await expect(
      runCompatibility(database, migrateSchemaCompatibility)
    ).rejects.toThrow("D1 schema compatibility mismatch");

    expect(database.prepare(
      "SELECT * FROM wompi_events WHERE id = 'quoted_decoy_event'"
    ).get()).toEqual(rowBefore);
    expect(database.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'wompi_events'"
    ).get()).toEqual(schemaBefore);
    expect(appliedMigrations(database)).not.toContain(CURRENT_0023);
    database.close();
  });

  it("accepts active lifecycle CHECKs with legitimately quoted column references and comments", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    database.exec(
      readMigration(CURRENT_0023)
        .replace(
          "CHECK (issuance_status IN",
          'CHECK /* active status constraint */ ("issuance_status" -- active expression\n  IN'
        )
        .replace(
          "CHECK (issuance_attempt_count >= 0)",
          "CHECK ([issuance_attempt_count] /* active expression */ >= 0)"
        )
    );
    recordMigration(database, LEGACY_0019);

    await runCompatibility(database, migrateSchemaCompatibility);

    expect(appliedMigrations(database)).toContain(CURRENT_0023);
    expect(() => database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body,
         issuance_status, issuance_attempt_count
       ) VALUES ('quoted_check_invalid', 'quoted_check_transaction', '00',
         'ExitosaAprobada', 100, '{}', 'NOT_A_CANONICAL_STATUS', -1)`
    ).run()).toThrow();
    database.close();
  });

  it.each([
    "/* unterminated block comment",
    "'unterminated literal",
    '"unterminated identifier',
    "`unterminated identifier",
    "[unterminated identifier"
  ])("fails closed on malformed table SQL: %s", async (malformedSql) => {
    const { buildCompatibilityPlan } = await loadCompatibility();
    expect(() => buildCompatibilityPlan({
      appliedMigrations: [LEGACY_0019],
      tableColumns: {
        wompi_events: [{
          name: "issuance_attempt_count",
          type: "INTEGER",
          notnull: 1,
          dflt_value: "0"
        }]
      },
      tableSql: {
        wompi_events: `CREATE TABLE wompi_events (
          issuance_attempt_count INTEGER NOT NULL DEFAULT 0
          CHECK (issuance_attempt_count >= 0)
        ) ${malformedSql}`
      },
      tableIndexes: {},
      schemaObjects: {},
      duplicateCounts: {},
      sequenceNoncanonicalCount: 0
    })).toThrow("D1 schema compatibility mismatch");
  });

  it("rejects a behaviorally different trigger literal before aliasing", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    database.exec(
      readMigration(CURRENT_0023).replace("'DTE-15-'", "'dte-15-'")
    );
    recordMigration(database, LEGACY_0019);
    database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body
       ) VALUES ('wrong_trigger_event', 'wrong_trigger_transaction', '00',
         'ExitosaAprobada', 100, '{}')`
    ).run();
    const before = database.prepare(
      "SELECT * FROM wompi_events WHERE id = 'wrong_trigger_event'"
    ).get();

    await expect(
      runCompatibility(database, migrateSchemaCompatibility)
    ).rejects.toThrow("D1 schema compatibility mismatch");

    expect(database.prepare(
      "SELECT * FROM wompi_events WHERE id = 'wrong_trigger_event'"
    ).get()).toEqual(before);
    expect(appliedMigrations(database)).not.toContain(CURRENT_0023);
    database.close();
  });

  it("keeps comment-looking text inside a trigger literal", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    database.exec(
      readMigration(CURRENT_0023).replace(
        "'DTE-15-'",
        "'DTE-15-/*not a SQL comment*/'"
      )
    );
    recordMigration(database, LEGACY_0019);
    database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body
       ) VALUES ('comment_literal_event', 'comment_literal_transaction', '00',
         'ExitosaAprobada', 100, '{}')`
    ).run();
    const before = database.prepare(
      "SELECT * FROM wompi_events WHERE id = 'comment_literal_event'"
    ).get();

    await expect(
      runCompatibility(database, migrateSchemaCompatibility)
    ).rejects.toThrow("D1 schema compatibility mismatch");

    expect(database.prepare(
      "SELECT * FROM wompi_events WHERE id = 'comment_literal_event'"
    ).get()).toEqual(before);
    expect(appliedMigrations(database)).not.toContain(CURRENT_0023);
    database.close();
  });

  it.each([
    {
      label: "double-quoted printf format identifier",
      source: "'%015d'",
      replacement: "\"'%015d'\"",
      provesRuntimeFailure: true
    },
    {
      label: "backtick-quoted printf format identifier",
      source: "'%015d'",
      replacement: "`'%015d'`",
      provesRuntimeFailure: false
    },
    {
      label: "bracket-quoted printf format identifier",
      source: "'%015d'",
      replacement: "['%015d']",
      provesRuntimeFailure: false
    },
    {
      label: "double-quoted control-number prefix identifier",
      source: "'DTE-15-'",
      replacement: "\"'DTE-15-'\"",
      provesRuntimeFailure: false
    },
    {
      label: "escaped single-quoted separator literal",
      source: "'-'",
      replacement: "'-''-'",
      provesRuntimeFailure: false
    }
  ])("rejects a $label before aliasing", async ({
    source,
    replacement,
    provesRuntimeFailure
  }) => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    database.exec(readMigration(CURRENT_0023).replace(source, replacement));
    recordMigration(database, LEGACY_0019);
    database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body
       ) VALUES ('trigger_decoy_event', 'trigger_decoy_transaction', '00',
         'ExitosaAprobada', 100, '{}')`
    ).run();
    const rowBefore = database.prepare(
      "SELECT * FROM wompi_events WHERE id = 'trigger_decoy_event'"
    ).get();
    const schemaBefore = database.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
    ).all();

    if (provesRuntimeFailure) {
      expect(() => database.prepare(
        `UPDATE wompi_events
         SET control_prefix = 'M001P004',
             reserved_codigo_generacion = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
         WHERE id = 'trigger_decoy_event'`
      ).run()).toThrow(/no such column/i);
      expect(database.prepare(
        "SELECT * FROM wompi_events WHERE id = 'trigger_decoy_event'"
      ).get()).toEqual(rowBefore);
    }

    await expect(
      runCompatibility(database, migrateSchemaCompatibility)
    ).rejects.toThrow("D1 schema compatibility mismatch");

    expect(database.prepare(
      "SELECT * FROM wompi_events WHERE id = 'trigger_decoy_event'"
    ).get()).toEqual(rowBefore);
    expect(database.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
    ).all()).toEqual(schemaBefore);
    expect(appliedMigrations(database)).not.toContain(CURRENT_0023);
    database.close();
  });

  it("accepts harmless SQL keyword and identifier case differences without changing literals", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    const cosmeticMigration = readMigration(CURRENT_0023)
      .replace(
        "CREATE TRIGGER reserve_wompi_document_identifiers",
        'CREATE TRIGGER "reserve_wompi_document_identifiers"'
      )
      .replace(
        "  UPDATE wompi_events\n  SET control_sequence",
        "  UPDATE   wompi_events\n  SET   control_sequence"
      )
      .replace(
        "AFTER UPDATE OF control_prefix, reserved_codigo_generacion ON wompi_events",
        "AFTER UPDATE -- harmless schema comment\nOF control_prefix, reserved_codigo_generacion ON wompi_events"
      )
      .replace(
        "FOR EACH ROW",
        "FOR EACH /* harmless block comment */ ROW"
      )
      .replace(
        "NEW.control_prefix IS NOT NULL",
        'NEW."control_prefix" IS NOT NULL'
      )
      .replace(
        "NEW.reserved_codigo_generacion IS NOT NULL",
        "NEW.`reserved_codigo_generacion` IS NOT NULL"
      )
      .replace(
        "VALUES (NEW.environment, NEW.control_prefix, 1)",
        "VALUES (NEW.[environment], NEW.control_prefix, 1)"
      );
    database.exec(lowercaseSqlOutsideStringLiterals(cosmeticMigration));
    recordMigration(database, LEGACY_0019);

    await runCompatibility(database, migrateSchemaCompatibility);
    database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body
       ) VALUES ('cosmetic_trigger_event', 'cosmetic_trigger_transaction', '00',
         'ExitosaAprobada', 100, '{}')`
    ).run();
    database.prepare(
      `UPDATE wompi_events
       SET control_prefix = 'M001P004',
           reserved_codigo_generacion = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
       WHERE id = 'cosmetic_trigger_event'`
    ).run();

    expect(database.prepare(
      `SELECT reserved_numero_control FROM wompi_events
       WHERE id = 'cosmetic_trigger_event'`
    ).get()).toEqual({
      reserved_numero_control: "DTE-15-M001P004-000000000000001"
    });
    database.close();
  });

  it("rejects duplicate reservation keys rather than choosing or rewriting a row", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    database.exec(withoutIndex(
      readMigration(CURRENT_0023),
      "idx_wompi_reserved_control"
    ));
    recordMigration(database, LEGACY_0019);
    for (const [id, generation] of [
      ["conflict_a", "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA"],
      ["conflict_b", "BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB"]
    ] as const) {
      database.prepare(
        `INSERT INTO wompi_events (
           id, transaction_id, environment, result, amount_cents, raw_body,
           control_prefix, control_sequence, reserved_codigo_generacion
         ) VALUES (?, ?, '00', 'ExitosaAprobada', 100, '{}',
           'M001P004', 7, ?)`
      ).run(id, `${id}_transaction`, generation);
    }
    const before = database.prepare(
      `SELECT id, control_prefix, control_sequence, reserved_codigo_generacion
       FROM wompi_events ORDER BY id`
    ).all();

    await expect(
      runCompatibility(database, migrateSchemaCompatibility)
    ).rejects.toThrow("D1 schema compatibility mismatch");

    expect(database.prepare(
      `SELECT id, control_prefix, control_sequence, reserved_codigo_generacion
       FROM wompi_events ORDER BY id`
    ).all()).toEqual(before);
    expect(appliedMigrations(database)).not.toContain(CURRENT_0023);
    database.close();
  });

  it("rejects same-name index and owned-column definitions with the wrong shape", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const wrongIndex = databaseThrough("0022");
    wrongIndex.exec(withoutEmailIdempotencyIndex(readMigration(CURRENT_0023)));
    wrongIndex.exec(
      "CREATE INDEX idx_email_deliveries_idempotency_key ON email_deliveries(claim_token);"
    );
    recordMigration(wrongIndex, LEGACY_0019);
    await expect(
      runCompatibility(wrongIndex, migrateSchemaCompatibility)
    ).rejects.toThrow("D1 schema compatibility mismatch");
    expect(appliedMigrations(wrongIndex)).not.toContain(CURRENT_0023);
    wrongIndex.close();

    const wrongColumn = databaseThrough("0022");
    wrongColumn.exec(initialLegacyIssuanceMigration());
    wrongColumn.exec(
      "ALTER TABLE wompi_events ADD COLUMN issuance_attempt_id INTEGER;"
    );
    recordMigration(wrongColumn, LEGACY_0019);
    await expect(
      runCompatibility(wrongColumn, migrateSchemaCompatibility)
    ).rejects.toThrow("D1 schema compatibility mismatch");
    expect(appliedMigrations(wrongColumn)).not.toContain(CURRENT_0023);
    wrongColumn.close();
  });

  it("resumes after an interrupted column repair without prematurely aliasing", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = databaseThrough("0022");
    database.exec(initialLegacyIssuanceMigration());
    recordMigration(database, LEGACY_0019);
    const base = sqliteRunnerFactory(database);
    let alterations = 0;
    const failSecondAlter = (options: { migrationsDirOverride?: string } = {}) => {
      const runner = base.createRunner(options);
      return {
        async run(args: string[]) {
          const query = args[args.indexOf("--command") + 1] ?? "";
          if (query.startsWith("ALTER ") && (alterations += 1) === 2) {
            throw new Error("injected compatibility interruption");
          }
          return runner.run(args);
        },
        cleanup: runner.cleanup
      };
    };

    await expect(
      runCompatibility(database, migrateSchemaCompatibility, failSecondAlter)
    ).rejects.toThrow("injected compatibility interruption");
    expect(columns(database, "wompi_events")).toContain("issuance_attempt_id");
    expect(appliedMigrations(database)).not.toContain(CURRENT_0023);

    await runCompatibility(database, migrateSchemaCompatibility);
    expect(appliedMigrations(database)).toContain(CURRENT_0023);
    database.close();
  });

  it("lets the complete fresh chain initialize normally and remains idempotent", async () => {
    const { migrateSchemaCompatibility } = await loadCompatibility();
    const database = new DatabaseSync(":memory:");
    database.exec("PRAGMA foreign_keys = ON");

    await runCompatibility(database, migrateSchemaCompatibility);
    const first = compatibilityFingerprint(database);
    await runCompatibility(database, migrateSchemaCompatibility);

    expect(compatibilityFingerprint(database)).toEqual(first);
    expect(appliedMigrations(database)).toEqual(migrationFiles());
    database.close();
  });

  it("captures Wrangler JSON through the private runner and cleans its temporary config", async () => {
    const { createPrivateWranglerRunner } = await import(runnerScriptPath);
    const isolatedRepository = mkdtempSync(join(tmpdir(), "diezmos-runner-repo-"));
    const privateRoot = mkdtempSync(join(tmpdir(), "diezmos-runner-private-"));
    const configPath = join(privateRoot, "wrangler.toml");
    writeFileSync(
      configPath,
      [
        'name = "example"',
        "[[send_email]]",
        'name = "EMAIL"',
        "[[env.staging.send_email]]",
        'name = "EMAIL"',
        "[[env.production.send_email]]",
        'name = "EMAIL"'
      ].join("\n"),
      { mode: 0o600 }
    );
    const spawnCalls: Array<{ args: string[]; stdio: unknown }> = [];
    const spawnImpl = ((_executable: string, args: string[], options: {
      stdio: unknown;
    }) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: PassThrough;
        stderr: PassThrough;
        kill(signal: NodeJS.Signals): void;
      };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => undefined;
      spawnCalls.push({ args, stdio: options.stdio });
      queueMicrotask(() => {
        child.stdout.end('{"captured":true}\n');
        child.stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    }) as unknown as typeof import("node:child_process").spawn;
    const runner = createPrivateWranglerRunner({
      repositoryRoot: isolatedRepository,
      configPath,
      spawnImpl
    });
    const preparedConfig = runner.configPath;

    await expect(runner.run(["whoami"], { capture: true })).resolves.toBe(
      '{"captured":true}\n'
    );
    expect(spawnCalls).toEqual([
      {
        args: [`--config=${preparedConfig}`, "whoami"],
        stdio: ["inherit", "pipe", "pipe"]
      }
    ]);
    expect(existsSync(preparedConfig)).toBe(true);
    runner.cleanup();
    expect(existsSync(preparedConfig)).toBe(false);
  });
});

function migrationFiles(directory = migrationsDirectory): string[] {
  return readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

function readMigration(name: string, directory = migrationsDirectory): string {
  return readFileSync(resolve(directory, name), "utf8");
}

function createMigrationLedger(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);
}

function recordMigration(database: DatabaseSync, name: string): void {
  database.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
}

function databaseThrough(prefix: string): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  createMigrationLedger(database);
  for (const name of migrationFiles()) {
    if (name.slice(0, 4) > prefix) break;
    database.exec(readMigration(name));
    recordMigration(database, name);
  }
  return database;
}

function initialLegacyIssuanceMigration(): string {
  const current = readMigration(CURRENT_0023);
  const core = current
    .slice(0, current.indexOf("-- Fencing token"))
    .replace(
      "ALTER TABLE wompi_events ADD COLUMN issuance_attempt_id TEXT;\n",
      ""
    );
  const reservations = current.slice(
    current.indexOf("-- Legacy sequence prefixes")
  );
  return `${core}${reservations}`;
}

function canonicalIssuanceStatusColumnSql(): string {
  return `ALTER TABLE wompi_events ADD COLUMN issuance_status TEXT
  CHECK (issuance_status IN ('PROCESSING', 'FAILED', 'DEAD_LETTERED', 'RETRY_QUEUED', 'DOCUMENT_CREATED', 'IGNORED'));`;
}

function lowercaseSqlOutsideStringLiterals(sql: string): string {
  let result = "";
  let index = 0;
  while (index < sql.length) {
    if (sql[index] !== "'") {
      result += sql[index].toLowerCase();
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < sql.length) {
      if (sql[index] !== "'") {
        index += 1;
        continue;
      }
      index += 1;
      if (sql[index] === "'") {
        index += 1;
        continue;
      }
      break;
    }
    result += sql.slice(start, index);
  }
  return result;
}

function appliedMigrations(database: DatabaseSync): string[] {
  if (!database.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations'"
  ).get()) {
    return [];
  }
  return database
    .prepare("SELECT name FROM d1_migrations ORDER BY id")
    .all()
    .map((row) => String(row.name));
}

function columns(database: DatabaseSync, table: string): string[] {
  return database
    .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
    .all()
    .map((row) => String(row.name));
}

function compatibilityFingerprint(database: DatabaseSync): unknown {
  return {
    ledger: appliedMigrations(database),
    schema: database.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
    ).all(),
    event: database.prepare(
      `SELECT id, issuance_status, issuance_attempt_id, processed_at
       FROM wompi_events WHERE id = 'legacy_event'`
    ).get()
  };
}

async function runCompatibility(
  database: DatabaseSync,
  migrateSchemaCompatibility: (options: Record<string, unknown>) => Promise<void>,
  createRunner = sqliteRunnerFactory(database).createRunner
): Promise<void> {
  await migrateSchemaCompatibility({
    binding: "DB",
    environment: "staging",
    repositoryRoot,
    createRunner
  });
}

function seedIssuanceEvidence(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO wompi_events (
       id, transaction_id, environment, result, amount_cents, raw_body,
       issuance_attempt_id
     ) VALUES ('evidence_event', 'evidence_transaction', '00',
       'ExitosaAprobada', 100, '{}', 'attempt-preserved')`
  ).run();
  database.prepare(
    `INSERT INTO dte_documents (
       id, wompi_event_id, environment, codigo_generacion, numero_control,
       status, plain_json, amount_cents, issued_at, transmission_claim_id
     ) VALUES ('evidence_document', 'evidence_event', '00',
       'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
       'DTE-15-M001P004-000000000000001', 'PENDING', '{}', 100,
       '2026-08-08T00:00:00.000Z', 'transmission-preserved')`
  ).run();
  database.prepare(
    `INSERT INTO email_deliveries (
       id, document_id, to_email, status, claim_attempted_at,
       idempotency_key, claim_token
     ) VALUES ('evidence_email', 'evidence_document', 'donor@example.org',
       'PENDING', '2026-08-08T00:01:00.000Z', 'email-key-preserved',
       'email-token-preserved')`
  ).run();
}

function issuanceEvidence(database: DatabaseSync): unknown {
  return {
    event: database.prepare(
      "SELECT issuance_attempt_id FROM wompi_events WHERE id = 'evidence_event'"
    ).get(),
    document: database.prepare(
      "SELECT transmission_claim_id FROM dte_documents WHERE id = 'evidence_document'"
    ).get(),
    email: database.prepare(
      `SELECT claim_attempted_at, idempotency_key, claim_token
       FROM email_deliveries WHERE id = 'evidence_email'`
    ).get()
  };
}

function seedRateLimitEvidence(
  database: DatabaseSync,
  variant: "zero" | "donation" | "audit" | "both"
): void {
  if (variant === "donation" || variant === "both") {
    database.prepare(
      `INSERT INTO donation_intents (
         id, amount_cents, donor_document_type, expires_at,
         rate_limit_claim_id
       ) VALUES ('intent-provenance', 100, '13',
         '2026-08-09T00:00:00.000Z', 'claim-donation')`
    ).run();
  }
  if (variant === "audit" || variant === "both") {
    database.prepare(
      `INSERT INTO audit_logs (
         id, actor_type, action, entity_type, entity_id, summary,
         rate_limit_claim_id
       ) VALUES ('audit-provenance', 'SYSTEM', 'TEST', 'test', 'test',
         'Preserved provenance', 'claim-audit')`
    ).run();
  }
}

function rateLimitEvidence(
  database: DatabaseSync,
  variant: "zero" | "donation" | "audit" | "both"
): Record<string, string | null> {
  const evidence: Record<string, string | null> = {};
  if (variant === "donation" || variant === "both") {
    evidence.donation = database.prepare(
      "SELECT rate_limit_claim_id FROM donation_intents WHERE id = 'intent-provenance'"
    ).get()?.rate_limit_claim_id as string | null;
  }
  if (variant === "audit" || variant === "both") {
    evidence.audit = database.prepare(
      "SELECT rate_limit_claim_id FROM audit_logs WHERE id = 'audit-provenance'"
    ).get()?.rate_limit_claim_id as string | null;
  }
  return evidence;
}

function withoutEmailIdempotencyIndex(sql: string): string {
  return sql.replace(
    /CREATE UNIQUE INDEX idx_email_deliveries_idempotency_key[\s\S]*?WHERE idempotency_key IS NOT NULL;\n/,
    ""
  );
}

function withoutIndex(sql: string, indexName: string): string {
  return sql.replace(
    new RegExp(
      `CREATE UNIQUE INDEX ${indexName}[\\s\\S]*?WHERE [^;]+;\\n`
    ),
    ""
  );
}

function quoteSqlIdentifier(
  value: string,
  quote: "double" | "backtick" | "bracket"
): string {
  if (quote === "double") return `"${value.replaceAll('"', '""')}"`;
  if (quote === "backtick") return `\`${value.replaceAll("`", "``")}\``;
  return `[${value.replaceAll("]", "]]")}]`;
}

function seedRequiredIndexDuplicates(
  database: DatabaseSync,
  indexName: (typeof REQUIRED_INDEX_FIXTURES)[number]["name"]
): void {
  if (indexName === "idx_email_deliveries_idempotency_key") {
    seedDuplicateEmailKeys(database);
    return;
  }
  if (indexName === "idx_wompi_reserved_control") {
    for (const suffix of ["a", "b"]) {
      database.prepare(
        `INSERT INTO wompi_events (
           id, transaction_id, environment, result, amount_cents, raw_body,
           control_prefix, control_sequence, reserved_codigo_generacion
         ) VALUES (?, ?, '00', 'ExitosaAprobada', 100, '{}',
           'M001P004', 17, ?)`
      ).run(
        `index_control_${suffix}`,
        `index_control_transaction_${suffix}`,
        `${suffix.toUpperCase().repeat(8)}-${suffix.toUpperCase().repeat(4)}-4AAA-8AAA-${suffix.toUpperCase().repeat(12)}`
      );
    }
    return;
  }
  if (indexName === "idx_wompi_reserved_generation") {
    for (const suffix of ["a", "b"]) {
      database.prepare(
        `INSERT INTO wompi_events (
           id, transaction_id, environment, result, amount_cents, raw_body,
           reserved_codigo_generacion
         ) VALUES (?, ?, '00', 'ExitosaAprobada', 100, '{}',
           'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC')`
      ).run(
        `index_generation_${suffix}`,
        `index_generation_transaction_${suffix}`
      );
    }
    return;
  }

  database.prepare(
    `INSERT INTO wompi_events (
       id, transaction_id, environment, result, amount_cents, raw_body
     ) VALUES ('index_document_event', 'index_document_transaction', '00',
       'ExitosaAprobada', 100, '{}')`
  ).run();
  for (const [suffix, generation, control] of [
    ["a", "DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD", "000000000000021"],
    ["b", "EEEEEEEE-EEEE-4EEE-8EEE-EEEEEEEEEEEE", "000000000000022"]
  ] as const) {
    database.prepare(
      `INSERT INTO dte_documents (
         id, wompi_event_id, environment, codigo_generacion, numero_control,
         status, plain_json, amount_cents, issued_at
       ) VALUES (?, 'index_document_event', '00', ?, ?, 'PENDING', '{}', 100,
         '2026-08-08T00:00:00.000Z')`
    ).run(
      `index_document_${suffix}`,
      generation,
      `DTE-15-M001P004-${control}`
    );
  }
}

function prepareRequiredIndexFixture(
  database: DatabaseSync,
  indexName: (typeof REQUIRED_INDEX_FIXTURES)[number]["name"]
): void {
  if (indexName === "idx_dte_documents_wompi_unique") {
    database.exec("DROP INDEX idx_dte_documents_unique_wompi_event;");
  }
}

function seedRequiredIndexRow(
  database: DatabaseSync,
  indexName: (typeof REQUIRED_INDEX_FIXTURES)[number]["name"],
  suffix: "a" | "b"
): void {
  if (indexName === "idx_email_deliveries_idempotency_key") {
    if (suffix === "a") {
      database.prepare(
        `INSERT INTO wompi_events (
           id, transaction_id, environment, result, amount_cents, raw_body
         ) VALUES ('cosmetic_email_event', 'cosmetic_email_transaction', '00',
           'ExitosaAprobada', 100, '{}')`
      ).run();
      database.prepare(
        `INSERT INTO dte_documents (
           id, wompi_event_id, environment, codigo_generacion, numero_control,
           status, plain_json, amount_cents, issued_at
         ) VALUES ('cosmetic_email_document', 'cosmetic_email_event', '00',
           'FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF',
           'DTE-15-M001P004-000000000000031', 'PENDING', '{}', 100,
           '2026-08-08T00:00:00.000Z')`
      ).run();
    }
    database.prepare(
      `INSERT INTO email_deliveries (
         id, document_id, to_email, status, idempotency_key
       ) VALUES (?, 'cosmetic_email_document', 'donor@example.org', 'PENDING',
         'same-cosmetic-key')`
    ).run(`cosmetic_email_${suffix}`);
    return;
  }
  if (indexName === "idx_wompi_reserved_control") {
    database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body,
         control_prefix, control_sequence, reserved_codigo_generacion
       ) VALUES (?, ?, '00', 'ExitosaAprobada', 100, '{}',
         'M001P004', 37, ?)`
    ).run(
      `cosmetic_control_${suffix}`,
      `cosmetic_control_transaction_${suffix}`,
      suffix === "a"
        ? "11111111-1111-4111-8111-111111111111"
        : "22222222-2222-4222-8222-222222222222"
    );
    return;
  }
  if (indexName === "idx_wompi_reserved_generation") {
    database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body,
         reserved_codigo_generacion
       ) VALUES (?, ?, '00', 'ExitosaAprobada', 100, '{}',
         '33333333-3333-4333-8333-333333333333')`
    ).run(
      `cosmetic_generation_${suffix}`,
      `cosmetic_generation_transaction_${suffix}`
    );
    return;
  }

  if (suffix === "a") {
    database.prepare(
      `INSERT INTO wompi_events (
         id, transaction_id, environment, result, amount_cents, raw_body
       ) VALUES ('cosmetic_document_event', 'cosmetic_document_transaction',
         '00', 'ExitosaAprobada', 100, '{}')`
    ).run();
  }
  database.prepare(
    `INSERT INTO dte_documents (
       id, wompi_event_id, environment, codigo_generacion, numero_control,
       status, plain_json, amount_cents, issued_at
     ) VALUES (?, 'cosmetic_document_event', '00', ?, ?, 'PENDING', '{}', 100,
       '2026-08-08T00:00:00.000Z')`
  ).run(
    `cosmetic_document_${suffix}`,
    suffix === "a"
      ? "44444444-4444-4444-8444-444444444444"
      : "55555555-5555-4555-8555-555555555555",
    suffix === "a"
      ? "DTE-15-M001P004-000000000000041"
      : "DTE-15-M001P004-000000000000042"
  );
}

function indexCompatibilityEvidence(
  database: DatabaseSync,
  table: string
): { ledger: string[]; schema: unknown[]; rows: unknown[] } {
  return {
    ledger: appliedMigrations(database),
    schema: database.prepare(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema
       WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
    ).all(),
    rows: database.prepare(
      `SELECT * FROM ${table} ORDER BY id`
    ).all()
  };
}

function canonicalCompatibilitySnapshot(manifest: {
  columns: ReadonlyArray<Record<string, unknown>>;
  indexes: ReadonlyArray<Record<string, unknown>>;
  triggers: ReadonlyArray<Record<string, unknown>>;
}) {
  const tableColumns: Record<string, Array<Record<string, unknown>>> = {};
  for (const entry of manifest.columns) {
    const table = String(entry.table);
    (tableColumns[table] ??= []).push({
      name: entry.column,
      type: entry.type,
      notnull: entry.nullable ? 0 : 1,
      dflt_value: entry.defaultValue ?? null
    });
  }
  const tableIndexes: Record<string, Array<Record<string, unknown>>> = {};
  for (const entry of manifest.indexes) {
    const table = String(entry.table);
    (tableIndexes[table] ??= []).push({
      name: entry.name,
      unique: 1,
      partial: 1,
      columns: entry.columns,
      sql: entry.createSql
    });
  }
  const trigger = manifest.triggers[0];
  return {
    appliedMigrations: [
      CURRENT_0023,
      "0024_add_rate_limit_claim_ids.sql",
      "0030_wompi_reconciliation_lifecycle.sql"
    ],
    tableColumns,
    tableSql: {
      wompi_events: `CREATE TABLE wompi_events (
        issuance_status TEXT CHECK (issuance_status IN ('PROCESSING', 'FAILED', 'DEAD_LETTERED', 'RETRY_QUEUED', 'DOCUMENT_CREATED', 'IGNORED')),
        issuance_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (issuance_attempt_count >= 0)
      )`
    },
    tableIndexes,
    schemaObjects: {
      [String(trigger.name)]: {
        type: "trigger",
        table: trigger.table,
        sql: trigger.createSql
      }
    },
    duplicateCounts: Object.fromEntries(
      manifest.indexes.map((entry) => [String(entry.duplicateCountKey), 0])
    ),
    sequenceNoncanonicalCount: 0
  };
}

function singleRequiredIndexSnapshot(
  fixture: (typeof REQUIRED_INDEX_FIXTURES)[number],
  ownerTable: string,
  overrides: Record<string, unknown>
) {
  const tableColumns = {
    [fixture.table]: fixture.columns.map((name) => ({
      name,
      type: name === "control_sequence" ? "INTEGER" : "TEXT",
      notnull: 0,
      dflt_value: null
    }))
  };
  return {
    appliedMigrations: [CURRENT_0023],
    tableColumns,
    tableSql: {},
    tableIndexes: {
      [ownerTable]: [{
        name: fixture.name,
        unique: 1,
        partial: 1,
        columns: [...fixture.columns],
        sql: fixture.createSql,
        ...overrides
      }]
    },
    schemaObjects: {},
    duplicateCounts: { [fixture.name]: 0 },
    sequenceNoncanonicalCount: 0
  };
}

function seedDuplicateEmailKeys(database: DatabaseSync): void {
  database.prepare(
    `INSERT INTO wompi_events (
       id, transaction_id, environment, result, amount_cents, raw_body
     ) VALUES ('duplicate_event', 'duplicate_transaction', '00',
       'ExitosaAprobada', 100, '{}')`
  ).run();
  database.prepare(
    `INSERT INTO dte_documents (
       id, wompi_event_id, environment, codigo_generacion, numero_control,
       status, plain_json, amount_cents, issued_at
     ) VALUES ('duplicate_document', 'duplicate_event', '00',
       'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
       'DTE-15-M001P004-000000000000002', 'PENDING', '{}', 100,
       '2026-08-08T00:00:00.000Z')`
  ).run();
  for (const id of ["duplicate_email_a", "duplicate_email_b"]) {
    database.prepare(
      `INSERT INTO email_deliveries (
         id, document_id, to_email, status, idempotency_key
       ) VALUES (?, 'duplicate_document', 'donor@example.org', 'PENDING',
         'duplicate-provider-key')`
    ).run(id);
  }
}

const PARTIAL_EMAIL_VALUES: Record<string, string> = {
  claim_attempted_at: "2026-08-08T02:00:00.000Z",
  idempotency_key: "partial-email-provider-key",
  claim_token: "partial-email-claim-token"
};

function seedPartialEmailEvidence(
  database: DatabaseSync,
  present: string[]
): void {
  database.prepare(
    `INSERT INTO wompi_events (
       id, transaction_id, environment, result, amount_cents, raw_body
     ) VALUES ('partial_email_event', 'partial_email_transaction', '00',
       'ExitosaAprobada', 100, '{}')`
  ).run();
  database.prepare(
    `INSERT INTO dte_documents (
       id, wompi_event_id, environment, codigo_generacion, numero_control,
       status, plain_json, amount_cents, issued_at
     ) VALUES ('partial_email_document', 'partial_email_event', '00',
       'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
       'DTE-15-M001P004-000000000000003', 'PENDING', '{}', 100,
       '2026-08-08T00:00:00.000Z')`
  ).run();
  database.prepare(
    `INSERT INTO email_deliveries (id, document_id, to_email, status)
     VALUES ('partial_email', 'partial_email_document',
       'donor@example.org', 'PENDING')`
  ).run();
  database.prepare(
    `UPDATE email_deliveries SET ${present.map((column) => `${column} = ?`).join(", ")}
     WHERE id = 'partial_email'`
  ).run(...present.map((column) => PARTIAL_EMAIL_VALUES[column]));
}

function partialEmailEvidence(
  database: DatabaseSync,
  present: string[]
): unknown {
  return database.prepare(
    `SELECT ${present.join(", ")} FROM email_deliveries
     WHERE id = 'partial_email'`
  ).get();
}

function sqliteRunnerFactory(database: DatabaseSync) {
  const migrationDirectories: Array<string | undefined> = [];
  const createRunner = ({
    migrationsDirOverride
  }: { migrationsDirOverride?: string } = {}) => {
    migrationDirectories.push(migrationsDirOverride);
    return {
      async run(args: string[]): Promise<string> {
        if (args[0] === "d1" && args[1] === "execute") {
          const query = args[args.indexOf("--command") + 1];
          const rows = /^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(query)
            ? database.prepare(query).all()
            : (database.exec(query), []);
          return JSON.stringify([{ success: true, results: rows }]);
        }
        if (args[0] === "d1" && args[1] === "migrations") {
          applyPendingMigrations(database, migrationsDirOverride);
          return "";
        }
        throw new Error(`Unexpected Wrangler command: ${args.join(" ")}`);
      },
      cleanup() {}
    };
  };
  return { createRunner, migrationDirectories };
}

function applyPendingMigrations(
  database: DatabaseSync,
  directory = migrationsDirectory
): void {
  if (appliedMigrations(database).length === 0 && !database.prepare(
    "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations'"
  ).get()) {
    createMigrationLedger(database);
  }
  const recorded = new Set(appliedMigrations(database));
  for (const name of migrationFiles(directory)) {
    if (recorded.has(name)) continue;
    database.exec(readMigration(name, directory));
    recordMigration(database, name);
    recorded.add(name);
  }
}
