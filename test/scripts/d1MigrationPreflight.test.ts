import { describe, expect, it } from "vitest";
import * as preflight from "../../scripts/d1-migration-preflight.mjs";

const wranglerRows = (results: Array<Record<string, unknown>>) =>
  JSON.stringify([{ results, success: true }]);

describe("D1 migration preflight", () => {
  it("can identify a fresh database before querying dte_documents", () => {
    expect(preflight.DTE_DOCUMENTS_TABLE_QUERY).toContain("sqlite_schema");
    expect(preflight.hasDteDocumentsTable(wranglerRows([]))).toBe(false);
    expect(
      preflight.hasDteDocumentsTable(wranglerRows([{ name: "dte_documents" }]))
    ).toBe(true);
  });

  it("queries only duplicate non-null legal Wompi document links", () => {
    expect(preflight.DUPLICATE_WOMPI_EVENT_IDS_QUERY).toContain(
      "FROM dte_documents"
    );
    expect(preflight.DUPLICATE_WOMPI_EVENT_IDS_QUERY).toContain(
      "wompi_event_id IS NOT NULL"
    );
    expect(preflight.DUPLICATE_WOMPI_EVENT_IDS_QUERY).toContain(
      "HAVING COUNT(*) > 1"
    );
  });

  it("parses Wrangler JSON and aborts on duplicates without choosing a row", () => {
    const output = wranglerRows([
      { wompi_event_id: "wompi_duplicate", document_count: 2 }
    ]);

    const duplicates = preflight.parseDuplicateWompiEventIds(output);

    expect(duplicates).toEqual([
      { wompiEventId: "wompi_duplicate", documentCount: 2 }
    ]);
    expect(() => preflight.assertNoDuplicateWompiEventIds(duplicates)).toThrow(
      /manual review.*wompi_duplicate/i
    );
  });

  it("accepts an empty Wrangler duplicate result set", () => {
    const duplicates = preflight.parseDuplicateWompiEventIds(wranglerRows([]));

    expect(() =>
      preflight.assertNoDuplicateWompiEventIds(duplicates)
    ).not.toThrow();
  });

  it("matches only the exact 0004 ledger filename", () => {
    expect(
      preflight.isMigration0004Recorded(
        wranglerRows([{ name: "0004_email_delivery_evidence.sql" }])
      )
    ).toBe(true);
    expect(
      preflight.isMigration0004Recorded(
        wranglerRows([{ name: "0004_email_delivery_evidence.sql.backup" }])
      )
    ).toBe(false);
  });

  it("recognizes only the seven evidence columns in canonical order", () => {
    expect(
      preflight.parseEmailDeliveryEvidenceColumns(
        wranglerRows([
          { name: "provider_delivery_id" },
          { name: "to_email" },
          { name: "email_type" },
          { name: "pdf_sha256" }
        ])
      )
    ).toEqual(["email_type", "pdf_sha256", "provider_delivery_id"]);
  });

  it("rejects malformed Wrangler JSON without echoing its contents", () => {
    const malformed = '{"results":[{"to_email":"private@example.test"}]';

    expect(() => preflight.hasEmailDeliveriesTable(malformed)).toThrow(
      "Migration preflight could not parse Wrangler JSON."
    );
    try {
      preflight.hasEmailDeliveriesTable(malformed);
    } catch (error) {
      expect(String(error)).not.toContain("private@example.test");
    }
  });

  it("allows a fresh database with no migration or email tables", () => {
    expect(
      preflight.classifyEmailDeliveryEvidenceState({
        migration0004Recorded: false,
        emailDeliveriesExists: false,
        evidenceColumns: [],
        populatedEvidenceCount: null
      })
    ).toEqual({
      state: "fresh",
      evidenceColumns: [],
      populatedEvidenceCount: null
    });
  });

  it("allows a legacy table while 0004 is pending and evidence columns are absent", () => {
    expect(
      preflight.classifyEmailDeliveryEvidenceState({
        migration0004Recorded: false,
        emailDeliveriesExists: true,
        evidenceColumns: [],
        populatedEvidenceCount: null
      }).state
    ).toBe("legacy-pending");
  });

  it("allows an already-recorded 0004 without inspecting evidence values", () => {
    expect(
      preflight.classifyEmailDeliveryEvidenceState({
        migration0004Recorded: true,
        emailDeliveriesExists: true,
        evidenceColumns: ["email_type"],
        populatedEvidenceCount: null
      }).state
    ).toBe("recorded");
  });

  it("allows pending 0004 when all seven evidence columns are unpopulated", () => {
    expect(
      preflight.classifyEmailDeliveryEvidenceState({
        migration0004Recorded: false,
        emailDeliveriesExists: true,
        evidenceColumns: [
          "email_type",
          "document_status_at_send",
          "template_version",
          "pdf_renderer_version",
          "pdf_sha256",
          "dte_json_sha256",
          "provider_delivery_id"
        ],
        populatedEvidenceCount: 0
      }).state
    ).toBe("pending-unpopulated");
  });

  it("blocks pending 0004 when any evidence field is populated", () => {
    expect(
      preflight.classifyEmailDeliveryEvidenceState({
        migration0004Recorded: false,
        emailDeliveriesExists: true,
        evidenceColumns: ["email_type", "pdf_sha256"],
        populatedEvidenceCount: 1
      })
    ).toEqual({
      state: "blocked",
      evidenceColumns: ["email_type", "pdf_sha256"],
      populatedEvidenceCount: 1
    });
  });

  it("queries no evidence values for a fresh database", () => {
    const queries: string[] = [];
    const executeQuery = (query: string) => {
      queries.push(query);
      return wranglerRows([]);
    };

    expect(preflight.inspectEmailDeliveryEvidenceMigration(executeQuery).state)
      .toBe("fresh");
    expect(queries).toEqual([
      preflight.D1_MIGRATIONS_TABLE_QUERY,
      preflight.EMAIL_DELIVERIES_TABLE_QUERY
    ]);
  });

  it("does not aggregate evidence when 0004 is pending on a legacy table", () => {
    const queries: string[] = [];
    const executeQuery = (query: string) => {
      queries.push(query);
      if (query === preflight.D1_MIGRATIONS_TABLE_QUERY) {
        return wranglerRows([{ name: "d1_migrations" }]);
      }
      if (query === preflight.EMAIL_DELIVERIES_TABLE_QUERY) {
        return wranglerRows([{ name: "email_deliveries" }]);
      }
      return wranglerRows([]);
    };

    expect(preflight.inspectEmailDeliveryEvidenceMigration(executeQuery).state)
      .toBe("legacy-pending");
    expect(queries).toContain(preflight.MIGRATION_0004_LEDGER_QUERY);
    expect(queries).toContain(preflight.EMAIL_DELIVERY_EVIDENCE_COLUMNS_QUERY);
    expect(queries).toHaveLength(4);
  });

  it("does not inspect columns or values after exact 0004 is recorded", () => {
    const queries: string[] = [];
    const executeQuery = (query: string) => {
      queries.push(query);
      if (query === preflight.D1_MIGRATIONS_TABLE_QUERY) {
        return wranglerRows([{ name: "d1_migrations" }]);
      }
      if (query === preflight.MIGRATION_0004_LEDGER_QUERY) {
        return wranglerRows([{ name: "0004_email_delivery_evidence.sql" }]);
      }
      if (query === preflight.EMAIL_DELIVERIES_TABLE_QUERY) {
        return wranglerRows([{ name: "email_deliveries" }]);
      }
      throw new Error("evidence values must not be queried");
    };

    expect(preflight.inspectEmailDeliveryEvidenceMigration(executeQuery).state)
      .toBe("recorded");
    expect(queries).toEqual([
      preflight.D1_MIGRATIONS_TABLE_QUERY,
      preflight.MIGRATION_0004_LEDGER_QUERY,
      preflight.EMAIL_DELIVERIES_TABLE_QUERY
    ]);
  });

  it("aggregates only present partial evidence columns and allows a zero count", () => {
    let aggregateQuery = "";
    const executeQuery = (query: string) => {
      if (query === preflight.D1_MIGRATIONS_TABLE_QUERY) {
        return wranglerRows([{ name: "d1_migrations" }]);
      }
      if (query === preflight.MIGRATION_0004_LEDGER_QUERY) return wranglerRows([]);
      if (query === preflight.EMAIL_DELIVERIES_TABLE_QUERY) {
        return wranglerRows([{ name: "email_deliveries" }]);
      }
      if (query === preflight.EMAIL_DELIVERY_EVIDENCE_COLUMNS_QUERY) {
        return wranglerRows([{ name: "email_type" }, { name: "pdf_sha256" }]);
      }
      aggregateQuery = query;
      return wranglerRows([{ populated_evidence_count: 0 }]);
    };

    expect(preflight.inspectEmailDeliveryEvidenceMigration(executeQuery).state)
      .toBe("pending-unpopulated");
    expect(aggregateQuery).toContain("email_type IS NOT NULL");
    expect(aggregateQuery).toContain("pdf_sha256 IS NOT NULL");
    expect(aggregateQuery).not.toContain("provider_delivery_id IS NOT NULL");
  });

  it("blocks a populated partial evidence-column set with a count-only error", () => {
    const executeQuery = (query: string) => {
      if (query === preflight.D1_MIGRATIONS_TABLE_QUERY) {
        return wranglerRows([{ name: "d1_migrations" }]);
      }
      if (query === preflight.MIGRATION_0004_LEDGER_QUERY) return wranglerRows([]);
      if (query === preflight.EMAIL_DELIVERIES_TABLE_QUERY) {
        return wranglerRows([{ name: "email_deliveries" }]);
      }
      if (query === preflight.EMAIL_DELIVERY_EVIDENCE_COLUMNS_QUERY) {
        return wranglerRows([{ name: "provider_delivery_id" }]);
      }
      return wranglerRows([{ populated_evidence_count: 3 }]);
    };
    const state = preflight.inspectEmailDeliveryEvidenceMigration(executeQuery);

    expect(() => preflight.assertEmailDeliveryEvidenceMigrationSafe(state)).toThrow(
      "Migration blocked: 3 email delivery rows contain populated evidence while 0004_email_delivery_evidence.sql is pending; no row was changed."
    );
    try {
      preflight.assertEmailDeliveryEvidenceMigrationSafe(state);
    } catch (error) {
      const message = String(error);
      for (const forbidden of [
        "recipient@example.test",
        "provider-secret-id",
        "document-secret-id",
        "sha256-secret-value",
        "provider_delivery_id"
      ]) {
        expect(message).not.toContain(forbidden);
      }
    }
  });

  it("blocks risky evidence before reaching the legal-DTE query", () => {
    const executeQuery = (query: string) => {
      if (query === preflight.D1_MIGRATIONS_TABLE_QUERY) {
        return wranglerRows([{ name: "d1_migrations" }]);
      }
      if (query === preflight.MIGRATION_0004_LEDGER_QUERY) return wranglerRows([]);
      if (query === preflight.EMAIL_DELIVERIES_TABLE_QUERY) {
        return wranglerRows([{ name: "email_deliveries" }]);
      }
      if (query === preflight.EMAIL_DELIVERY_EVIDENCE_COLUMNS_QUERY) {
        return wranglerRows([{ name: "email_type" }]);
      }
      if (query.includes("populated_evidence_count")) {
        return wranglerRows([{ populated_evidence_count: 1 }]);
      }
      throw new Error("the legal-DTE query must not run after evidence blocks");
    };

    expect(() => preflight.runPreflightChecks(executeQuery)).toThrow(
      /1 email delivery rows.*0004_email_delivery_evidence\.sql is pending/i
    );
  });

  it("keeps the duplicate legal-DTE guard in the shared preflight path", () => {
    const executeQuery = (query: string) => {
      if (query === preflight.D1_MIGRATIONS_TABLE_QUERY) {
        return wranglerRows([{ name: "d1_migrations" }]);
      }
      if (query === preflight.MIGRATION_0004_LEDGER_QUERY) {
        return wranglerRows([{ name: "0004_email_delivery_evidence.sql" }]);
      }
      if (query === preflight.EMAIL_DELIVERIES_TABLE_QUERY) {
        return wranglerRows([{ name: "email_deliveries" }]);
      }
      if (query === preflight.DTE_DOCUMENTS_TABLE_QUERY) {
        return wranglerRows([{ name: "dte_documents" }]);
      }
      return wranglerRows([
        { wompi_event_id: "wompi_duplicate", document_count: 2 }
      ]);
    };

    expect(() => preflight.runPreflightChecks(executeQuery)).toThrow(
      /manual review.*wompi_duplicate/i
    );
  });
});
