import { describe, expect, it } from "vitest";
import {
  DUPLICATE_WOMPI_EVENT_IDS_QUERY,
  assertNoDuplicateWompiEventIds,
  parseDuplicateWompiEventIds
} from "../../scripts/d1-migration-preflight.mjs";

describe("D1 migration preflight", () => {
  it("queries only duplicate non-null legal Wompi document links", () => {
    expect(DUPLICATE_WOMPI_EVENT_IDS_QUERY).toContain("FROM dte_documents");
    expect(DUPLICATE_WOMPI_EVENT_IDS_QUERY).toContain("wompi_event_id IS NOT NULL");
    expect(DUPLICATE_WOMPI_EVENT_IDS_QUERY).toContain("HAVING COUNT(*) > 1");
  });

  it("parses Wrangler JSON and aborts on duplicates without choosing a row", () => {
    const output = JSON.stringify([
      {
        results: [
          { wompi_event_id: "wompi_duplicate", document_count: 2 }
        ],
        success: true
      }
    ]);

    const duplicates = parseDuplicateWompiEventIds(output);

    expect(duplicates).toEqual([
      { wompiEventId: "wompi_duplicate", documentCount: 2 }
    ]);
    expect(() => assertNoDuplicateWompiEventIds(duplicates)).toThrow(
      /manual review.*wompi_duplicate/i
    );
  });

  it("accepts an empty Wrangler result set", () => {
    const duplicates = parseDuplicateWompiEventIds(
      JSON.stringify([{ results: [], success: true }])
    );

    expect(() => assertNoDuplicateWompiEventIds(duplicates)).not.toThrow();
  });
});
