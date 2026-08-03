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

function parseWranglerRows(stdout) {
  const parsed = JSON.parse(String(stdout).trim());
  const envelopes = Array.isArray(parsed) ? parsed : [parsed];
  return envelopes.flatMap((envelope) =>
    Array.isArray(envelope?.results) ? envelope.results : []
  );
}

export function hasDteDocumentsTable(stdout) {
  return parseWranglerRows(stdout).some((row) => row.name === "dte_documents");
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
    if (!hasDteDocumentsTable(executeQuery(DTE_DOCUMENTS_TABLE_QUERY))) {
      process.stdout.write(
        "D1 migration preflight skipped: fresh database has no dte_documents table.\n"
      );
      return;
    }
    assertNoDuplicateWompiEventIds(
      parseDuplicateWompiEventIds(executeQuery(DUPLICATE_WOMPI_EVENT_IDS_QUERY))
    );
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
