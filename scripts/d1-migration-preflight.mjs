import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  preparePrivateWranglerConfig,
  resolvePrivateWranglerConfig
} from "./private-wrangler-config.mjs";

export const DTE_DOCUMENTS_TABLE_QUERY = `
SELECT name
FROM sqlite_schema
WHERE type = 'table' AND name = 'dte_documents';
`.trim();

export const DUPLICATE_WOMPI_EVENT_IDS_QUERY = `
SELECT wompi_event_id, COUNT(*) AS document_count
FROM dte_documents
WHERE wompi_event_id IS NOT NULL
GROUP BY wompi_event_id
HAVING COUNT(*) > 1
ORDER BY wompi_event_id;
`.trim();

const MIGRATION_0004 = "0004_email_delivery_evidence.sql";
const EMAIL_DELIVERY_EVIDENCE_COLUMNS = Object.freeze([
  "email_type",
  "document_status_at_send",
  "template_version",
  "pdf_renderer_version",
  "pdf_sha256",
  "dte_json_sha256",
  "provider_delivery_id"
]);
const INVALID_WRANGLER_RESPONSE =
  "Migration preflight received an invalid Wrangler response.";

export const D1_MIGRATIONS_TABLE_QUERY = `
SELECT name
FROM sqlite_schema
WHERE type = 'table' AND name = 'd1_migrations';
`.trim();

export const EMAIL_DELIVERIES_TABLE_QUERY = `
SELECT name
FROM sqlite_schema
WHERE type = 'table' AND name = 'email_deliveries';
`.trim();

export const MIGRATION_0004_LEDGER_QUERY = `
SELECT name
FROM d1_migrations
WHERE name = '${MIGRATION_0004}';
`.trim();

export const EMAIL_DELIVERY_EVIDENCE_COLUMNS_QUERY = `
SELECT name
FROM pragma_table_info('email_deliveries')
WHERE name IN (${EMAIL_DELIVERY_EVIDENCE_COLUMNS.map((name) => `'${name}'`).join(", ")});
`.trim();

function parseWranglerRows(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(String(stdout).trim());
  } catch {
    throw new Error(INVALID_WRANGLER_RESPONSE);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(INVALID_WRANGLER_RESPONSE);
  }
  const [envelope] = parsed;
  if (
    !isNonArrayObject(envelope) ||
    envelope.success !== true ||
    !Array.isArray(envelope.results) ||
    !envelope.results.every(isNonArrayObject)
  ) {
    throw new Error(INVALID_WRANGLER_RESPONSE);
  }
  return envelope.results;
}

function isNonArrayObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactFields(row, fields) {
  const keys = Object.keys(row);
  return (
    keys.length === fields.length &&
    fields.every((field) => Object.hasOwn(row, field))
  );
}

function parseExactNamePresence(stdout, expectedName) {
  const rows = parseWranglerRows(stdout);
  if (rows.length > 1) throw new Error(INVALID_WRANGLER_RESPONSE);
  if (rows.length === 0) return false;
  const [row] = rows;
  if (!hasExactFields(row, ["name"]) || row.name !== expectedName) {
    throw new Error(INVALID_WRANGLER_RESPONSE);
  }
  return true;
}

export function hasDteDocumentsTable(stdout) {
  return parseExactNamePresence(stdout, "dte_documents");
}

export function hasD1MigrationsTable(stdout) {
  return parseExactNamePresence(stdout, "d1_migrations");
}

export function hasEmailDeliveriesTable(stdout) {
  return parseExactNamePresence(stdout, "email_deliveries");
}

export function isMigration0004Recorded(stdout) {
  return parseExactNamePresence(stdout, MIGRATION_0004);
}

export function parseEmailDeliveryEvidenceColumns(stdout) {
  const names = new Set();
  for (const row of parseWranglerRows(stdout)) {
    if (
      !hasExactFields(row, ["name"]) ||
      !EMAIL_DELIVERY_EVIDENCE_COLUMNS.includes(row.name) ||
      names.has(row.name)
    ) {
      throw new Error(INVALID_WRANGLER_RESPONSE);
    }
    names.add(row.name);
  }
  return EMAIL_DELIVERY_EVIDENCE_COLUMNS.filter((name) => names.has(name));
}

export function parsePopulatedEmailDeliveryEvidenceCount(stdout) {
  const rows = parseWranglerRows(stdout);
  if (rows.length !== 1) throw new Error(INVALID_WRANGLER_RESPONSE);
  const [row] = rows;
  if (!hasExactFields(row, ["populated_evidence_count"])) {
    throw new Error(INVALID_WRANGLER_RESPONSE);
  }
  const count = row.populated_evidence_count;
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 0
  ) {
    throw new Error(INVALID_WRANGLER_RESPONSE);
  }
  return count;
}

export function parseDuplicateWompiEventIds(stdout) {
  return parseWranglerRows(stdout).map((row) => ({
    wompiEventId: String(row.wompi_event_id),
    documentCount: Number(row.document_count)
  }));
}

export function assertNoDuplicateWompiEventIds(duplicates) {
  if (duplicates.length === 0) return;
  const details = duplicates
    .map(({ wompiEventId, documentCount }) => `${wompiEventId} (${documentCount})`)
    .join(", ");
  throw new Error(
    `Migration blocked: duplicate legal DTE links require manual review; no row was changed. ${details}`
  );
}

export function classifyEmailDeliveryEvidenceState({
  migration0004Recorded,
  emailDeliveriesExists,
  evidenceColumns,
  populatedEvidenceCount
}) {
  if (migration0004Recorded) {
    return {
      state: "recorded",
      evidenceColumns: [...evidenceColumns],
      populatedEvidenceCount: null
    };
  }
  if (!emailDeliveriesExists) {
    return {
      state: "fresh",
      evidenceColumns: [],
      populatedEvidenceCount: null
    };
  }
  if (evidenceColumns.length === 0) {
    return {
      state: "legacy-pending",
      evidenceColumns: [],
      populatedEvidenceCount: null
    };
  }
  if (
    !Number.isSafeInteger(populatedEvidenceCount) ||
    populatedEvidenceCount < 0
  ) {
    throw new Error(
      "Migration preflight requires a valid populated evidence count."
    );
  }
  return {
    state: populatedEvidenceCount === 0 ? "pending-unpopulated" : "blocked",
    evidenceColumns: [...evidenceColumns],
    populatedEvidenceCount
  };
}

function populatedEmailDeliveryEvidenceCountQuery(evidenceColumns) {
  const safeColumns = evidenceColumns.filter((name) =>
    EMAIL_DELIVERY_EVIDENCE_COLUMNS.includes(name)
  );
  if (
    safeColumns.length !== evidenceColumns.length ||
    safeColumns.length === 0
  ) {
    throw new Error("Migration preflight received invalid evidence columns.");
  }
  return `
SELECT COUNT(*) AS populated_evidence_count
FROM email_deliveries
WHERE ${safeColumns.map((name) => `${name} IS NOT NULL`).join(" OR ")};
`.trim();
}

export function inspectEmailDeliveryEvidenceMigration(executeQuery) {
  const migration0004Recorded = hasD1MigrationsTable(
    executeQuery(D1_MIGRATIONS_TABLE_QUERY)
  )
    ? isMigration0004Recorded(executeQuery(MIGRATION_0004_LEDGER_QUERY))
    : false;
  const emailDeliveriesExists = hasEmailDeliveriesTable(
    executeQuery(EMAIL_DELIVERIES_TABLE_QUERY)
  );

  if (migration0004Recorded || !emailDeliveriesExists) {
    return classifyEmailDeliveryEvidenceState({
      migration0004Recorded,
      emailDeliveriesExists,
      evidenceColumns: [],
      populatedEvidenceCount: null
    });
  }

  const evidenceColumns = parseEmailDeliveryEvidenceColumns(
    executeQuery(EMAIL_DELIVERY_EVIDENCE_COLUMNS_QUERY)
  );
  const populatedEvidenceCount =
    evidenceColumns.length === 0
      ? null
      : parsePopulatedEmailDeliveryEvidenceCount(
          executeQuery(populatedEmailDeliveryEvidenceCountQuery(evidenceColumns))
        );

  return classifyEmailDeliveryEvidenceState({
    migration0004Recorded,
    emailDeliveriesExists,
    evidenceColumns,
    populatedEvidenceCount
  });
}

export function assertEmailDeliveryEvidenceMigrationSafe(state) {
  if (state.state !== "blocked") return;
  throw new Error(
    `Migration blocked: ${state.populatedEvidenceCount} email delivery rows contain populated evidence while ${MIGRATION_0004} is pending; no row was changed.`
  );
}

export function runPreflightChecks(executeQuery) {
  assertEmailDeliveryEvidenceMigrationSafe(
    inspectEmailDeliveryEvidenceMigration(executeQuery)
  );
  const dteDocumentsTableExists = hasDteDocumentsTable(
    executeQuery(DTE_DOCUMENTS_TABLE_QUERY)
  );
  if (dteDocumentsTableExists) {
    assertNoDuplicateWompiEventIds(
      parseDuplicateWompiEventIds(executeQuery(DUPLICATE_WOMPI_EVENT_IDS_QUERY))
    );
  }
  return { dteDocumentsTableExists };
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) {
      throw new Error("Usage: d1-migration-preflight --binding <name> --env <name>");
    }
    values.set(key.slice(2), value);
  }
  const binding = values.get("binding");
  const environment = values.get("env");
  if (!binding || !environment) {
    throw new Error("Usage: d1-migration-preflight --binding <name> --env <name>");
  }
  return { binding, environment };
}

function runPreflight(argv) {
  const { binding, environment } = parseArgs(argv);
  const preparedConfig = preparePrivateWranglerConfig(
    resolvePrivateWranglerConfig()
  );
  const executable = join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "wrangler.cmd" : "wrangler"
  );
  const executeQuery = (query) => {
    const result = spawnSync(
      executable,
      [
        `--config=${preparedConfig.configPath}`,
        "d1",
        "execute",
        binding,
        "--env",
        environment,
        "--remote",
        "--json",
        "--command",
        query
      ],
      { encoding: "utf8" }
    );
    if (result.status !== 0) {
      throw new Error(
        result.stderr.trim() || "D1 migration preflight query failed"
      );
    }
    return result.stdout;
  };
  try {
    const { dteDocumentsTableExists } = runPreflightChecks(executeQuery);
    if (!dteDocumentsTableExists) {
      process.stdout.write(
        "D1 migration preflight skipped: fresh database has no dte_documents table.\n"
      );
      return;
    }
  } finally {
    preparedConfig.cleanup();
  }
  process.stdout.write("D1 migration preflight passed: no duplicate Wompi document links.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runPreflight(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
