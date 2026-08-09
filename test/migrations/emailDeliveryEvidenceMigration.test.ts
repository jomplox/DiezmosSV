import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import * as preflight from "../../scripts/d1-migration-preflight.mjs";

const migration0004 = readFileSync(
  resolve(
    import.meta.dirname,
    "../../migrations/0004_email_delivery_evidence.sql"
  ),
  "utf8"
);

const LEGACY_EMAIL_DELIVERIES_SCHEMA = `
CREATE TABLE dte_documents (id TEXT PRIMARY KEY);
CREATE TABLE email_deliveries (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES dte_documents(id),
  to_email TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  provider_response_json TEXT NOT NULL DEFAULT '{}',
  sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`;

const EVIDENCE_COLUMNS = [
  "email_type",
  "document_status_at_send",
  "template_version",
  "pdf_renderer_version",
  "pdf_sha256",
  "dte_json_sha256",
  "provider_delivery_id"
] as const;

describe("0004 email delivery evidence migration", () => {
  it("preserves every legacy/base field on the normal historical path", () => {
    const database = legacyDatabase();
    database.exec(`
      INSERT INTO dte_documents (id) VALUES ('document-legacy');
      INSERT INTO email_deliveries (
        id, document_id, to_email, status, provider_response_json, sent_at, created_at
      ) VALUES (
        'delivery-legacy',
        'document-legacy',
        'legacy@example.test',
        'SENT',
        '{"provider":"accepted"}',
        '2026-06-30T12:34:56.000Z',
        '2026-06-30T12:00:00.000Z'
      );
    `);

    database.exec(migration0004);

    expect(
      database.prepare(`
        SELECT id, document_id, to_email, status, provider_response_json, sent_at, created_at
        FROM email_deliveries
      `).get()
    ).toEqual({
      id: "delivery-legacy",
      document_id: "document-legacy",
      to_email: "legacy@example.test",
      status: "SENT",
      provider_response_json: '{"provider":"accepted"}',
      sent_at: "2026-06-30T12:34:56.000Z",
      created_at: "2026-06-30T12:00:00.000Z"
    });
    expect(evidence(database)).toEqual({
      email_type: null,
      document_status_at_send: null,
      template_version: null,
      pdf_renderer_version: null,
      pdf_sha256: null,
      dte_json_sha256: null,
      provider_delivery_id: null
    });
    database.close();
  });

  it("blocks the populated-evidence pending-ledger state before destructive 0004 runs", () => {
    const guarded = riskyPendingDatabase();
    const destructiveControl = riskyPendingDatabase();
    const before = evidence(guarded);

    destructiveControl.exec(migration0004);
    expect(evidence(destructiveControl)).toEqual({
      email_type: null,
      document_status_at_send: null,
      template_version: null,
      pdf_renderer_version: null,
      pdf_sha256: null,
      dte_json_sha256: null,
      provider_delivery_id: null
    });

    expect(() => {
      const state = preflight.inspectEmailDeliveryEvidenceMigration(
        sqliteWranglerQuery(guarded)
      );
      preflight.assertEmailDeliveryEvidenceMigrationSafe(state);
      guarded.exec(migration0004);
    }).toThrow(
      /1 email delivery rows.*0004_email_delivery_evidence\.sql is pending/i
    );
    expect(evidence(guarded)).toEqual(before);

    guarded.close();
    destructiveControl.close();
  });
});

function legacyDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(LEGACY_EMAIL_DELIVERIES_SCHEMA);
  return database;
}

function riskyPendingDatabase(): DatabaseSync {
  const database = legacyDatabase();
  for (const column of EVIDENCE_COLUMNS) {
    database.exec(`ALTER TABLE email_deliveries ADD COLUMN ${column} TEXT;`);
  }
  database.exec(`
    CREATE TABLE d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO d1_migrations (name) VALUES ('0001_init.sql');
    INSERT INTO dte_documents (id) VALUES ('document-risky');
    INSERT INTO email_deliveries (
      id, document_id, to_email, status, provider_response_json,
      email_type, document_status_at_send, template_version,
      pdf_renderer_version, pdf_sha256, dte_json_sha256, provider_delivery_id,
      sent_at, created_at
    ) VALUES (
      'delivery-risky', 'document-risky', 'private@example.test', 'SENT', '{}',
      'CDE', 'ACCEPTED', 'template-v1', 'renderer-v1',
      'pdf-secret-hash', 'json-secret-hash', 'provider-secret-id',
      '2026-08-08T01:02:03.000Z', '2026-08-08T01:00:00.000Z'
    );
  `);
  return database;
}

function evidence(database: DatabaseSync): Record<string, unknown> {
  return database.prepare(`
    SELECT email_type, document_status_at_send, template_version,
      pdf_renderer_version, pdf_sha256, dte_json_sha256, provider_delivery_id
    FROM email_deliveries
  `).get() as Record<string, unknown>;
}

function sqliteWranglerQuery(database: DatabaseSync) {
  return (query: string): string =>
    JSON.stringify([{ results: database.prepare(query).all(), success: true }]);
}
