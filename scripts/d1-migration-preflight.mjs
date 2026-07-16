import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DUPLICATE_WOMPI_EVENT_IDS_QUERY = `
SELECT wompi_event_id, COUNT(*) AS document_count
FROM dte_documents
WHERE wompi_event_id IS NOT NULL
GROUP BY wompi_event_id
HAVING COUNT(*) > 1
ORDER BY wompi_event_id;
`.trim();

export function parseDuplicateWompiEventIds(stdout) {
  const parsed = JSON.parse(String(stdout).trim());
  const envelopes = Array.isArray(parsed) ? parsed : [parsed];
  const rows = envelopes.flatMap((envelope) =>
    Array.isArray(envelope?.results) ? envelope.results : []
  );
  return rows.map((row) => ({
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
      throw new Error("Usage: d1-migration-preflight --database <name> --env <name>");
    }
    values.set(key.slice(2), value);
  }
  const database = values.get("database");
  const environment = values.get("env");
  if (!database || !environment) {
    throw new Error("Usage: d1-migration-preflight --database <name> --env <name>");
  }
  return { database, environment };
}

function runPreflight(argv) {
  const { database, environment } = parseArgs(argv);
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(
    executable,
    [
      "wrangler",
      "d1",
      "execute",
      database,
      "--env",
      environment,
      "--remote",
      "--json",
      "--command",
      DUPLICATE_WOMPI_EVENT_IDS_QUERY
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "D1 migration preflight query failed");
  }
  assertNoDuplicateWompiEventIds(parseDuplicateWompiEventIds(result.stdout));
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
