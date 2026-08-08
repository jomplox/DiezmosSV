import { describe, expect, it } from "vitest";
import * as preflight from "../../scripts/d1-migration-preflight.mjs";

const wranglerRows = (results: Array<Record<string, unknown>>) =>
  JSON.stringify([{ results, success: true }]);

const INVALID_WRANGLER_RESPONSE =
  "Migration preflight received an invalid Wrangler response.";

function expectSanitizedWranglerFailure(
  operation: () => unknown,
  maliciousText: string
): void {
  expect(operation).toThrow(INVALID_WRANGLER_RESPONSE);
  try {
    operation();
  } catch (error) {
    expect(String(error)).not.toContain(maliciousText);
  }
}

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
    expect(preflight.isMigration0004Recorded(wranglerRows([]))).toBe(false);
  });

  it("recognizes only the seven evidence columns in canonical order", () => {
    expect(
      preflight.parseEmailDeliveryEvidenceColumns(
        wranglerRows([
          { name: "provider_delivery_id" },
          { name: "email_type" },
          { name: "pdf_sha256" }
        ])
      )
    ).toEqual(["email_type", "pdf_sha256", "provider_delivery_id"]);
  });

  it("rejects malformed Wrangler JSON without echoing its contents", () => {
    const malformed = '{"results":[{"to_email":"private@example.test"}]';

    expectSanitizedWranglerFailure(
      () => preflight.hasEmailDeliveriesTable(malformed),
      "private@example.test"
    );
  });

  it.each([
    [
      "a provider-declared failure",
      JSON.stringify([
        {
          success: false,
          errors: [{ message: "provider-secret-id" }],
          results: []
        }
      ]),
      "provider-secret-id"
    ],
    [
      "a missing results array",
      JSON.stringify([{ success: true, provider_detail: "missing-results-secret" }]),
      "missing-results-secret"
    ],
    [
      "a non-array results value",
      JSON.stringify([
        {
          success: true,
          results: { name: "recipient@example.test" }
        }
      ]),
      "recipient@example.test"
    ],
    ["an empty envelope collection", "[]", "empty-envelope-secret"],
    [
      "a bare envelope object",
      JSON.stringify({
        success: true,
        results: [],
        provider_detail: "bare-envelope-secret"
      }),
      "bare-envelope-secret"
    ],
    [
      "multiple envelopes",
      JSON.stringify([
        { success: true, results: [] },
        {
          success: true,
          results: [],
          provider_detail: "second-envelope-secret"
        }
      ]),
      "second-envelope-secret"
    ],
    ["a null envelope", JSON.stringify([null]), "null-envelope-secret"],
    [
      "a scalar envelope",
      JSON.stringify(["scalar-envelope-secret"]),
      "scalar-envelope-secret"
    ],
    [
      "an array envelope",
      JSON.stringify([[{ provider_detail: "array-envelope-secret" }]]),
      "array-envelope-secret"
    ],
    [
      "a null result row",
      JSON.stringify([{ success: true, results: [null] }]),
      "null-row-secret"
    ],
    [
      "a scalar result row",
      JSON.stringify([{ success: true, results: ["scalar-row-secret"] }]),
      "scalar-row-secret"
    ],
    [
      "an array result row",
      JSON.stringify([
        { success: true, results: [["array-row-secret"]] }
      ]),
      "array-row-secret"
    ]
  ])("fails closed on %s", (_label, response, maliciousText) => {
    expectSanitizedWranglerFailure(
      () => preflight.runPreflightChecks(() => response),
      maliciousText
    );
  });

  it.each([
    ["d1 table", preflight.hasD1MigrationsTable, "d1_migrations"],
    ["email table", preflight.hasEmailDeliveriesTable, "email_deliveries"],
    ["DTE table", preflight.hasDteDocumentsTable, "dte_documents"],
    [
      "0004 ledger",
      preflight.isMigration0004Recorded,
      "0004_email_delivery_evidence.sql"
    ]
  ])("rejects duplicate %s rows", (_label, parser, name) => {
    expectSanitizedWranglerFailure(
      () => parser(wranglerRows([{ name }, { name }])),
      name
    );
  });

  it.each([
    ["d1 table", preflight.hasD1MigrationsTable, "different_table"],
    ["email table", preflight.hasEmailDeliveriesTable, "different_table"],
    ["DTE table", preflight.hasDteDocumentsTable, "different_table"],
    [
      "0004 ledger",
      preflight.isMigration0004Recorded,
      "0004_email_delivery_evidence.sql.backup"
    ]
  ])("rejects an unexpected %s row", (_label, parser, name) => {
    expectSanitizedWranglerFailure(
      () => parser(wranglerRows([{ name }])),
      name
    );
  });

  it("rejects missing or additional projected table fields", () => {
    expectSanitizedWranglerFailure(
      () => preflight.hasEmailDeliveriesTable(wranglerRows([{}])),
      "missing-name-secret"
    );
    expectSanitizedWranglerFailure(
      () =>
        preflight.hasEmailDeliveriesTable(
          wranglerRows([
            {
              name: "email_deliveries",
              provider_detail: "extra-field-secret"
            }
          ])
        ),
      "extra-field-secret"
    );
  });

  it("rejects duplicate, unexpected, and malformed evidence-column rows", () => {
    for (const rows of [
      [{ name: "email_type" }, { name: "email_type" }],
      [{ name: "to_email" }],
      [{}],
      [{ name: "email_type", provider_detail: "column-extra-secret" }]
    ]) {
      expectSanitizedWranglerFailure(
        () => preflight.parseEmailDeliveryEvidenceColumns(wranglerRows(rows)),
        "column-extra-secret"
      );
    }
  });

  it.each([
    ["null", null],
    ["boolean", false],
    ["empty string", ""],
    ["whitespace", "  "],
    ["numeric string", "7"],
    ["float", 1.5],
    ["negative", -1],
    ["unsafe integer", Number.MAX_SAFE_INTEGER + 1]
  ])("rejects a noncanonical %s populated-evidence count", (_label, count) => {
    const response = wranglerRows([{ populated_evidence_count: count }]);

    expect(() =>
      preflight.parsePopulatedEmailDeliveryEvidenceCount(response)
    ).toThrow(
      INVALID_WRANGLER_RESPONSE
    );
  });

  it("rejects missing, additional, duplicate, and multi-envelope count rows", () => {
    const invalidResponses = [
      wranglerRows([{}]),
      wranglerRows([
        { populated_evidence_count: 0, provider_detail: "count-extra-secret" }
      ]),
      wranglerRows([
        { populated_evidence_count: 0 },
        { populated_evidence_count: 7 }
      ]),
      JSON.stringify([
        { success: true, results: [{ populated_evidence_count: 0 }] },
        {
          success: true,
          results: [{ populated_evidence_count: 7 }],
          provider_detail: "later-count-secret"
        }
      ])
    ];

    for (const response of invalidResponses) {
      expectSanitizedWranglerFailure(
        () => preflight.parsePopulatedEmailDeliveryEvidenceCount(response),
        "later-count-secret"
      );
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
