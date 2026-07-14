import { describe, expect, it } from "vitest";
import { filterPreCdeFailures } from "../../src/client/preCdeFailures";
import type { WompiIssuanceFailureItem } from "../../src/client/types";

const items: WompiIssuanceFailureItem[] = [
  {
    id: "wompi-event-1",
    environment: "00",
    amount_cents: 4_250,
    donor_name: "Jose Pérez",
    donor_email: "jose@example.com",
    received_at: "2026-07-13T20:00:00.000Z",
    issuance_status: "FAILED",
    issuance_attempt_count: 2,
    issuance_error_code: "CDE_SCHEMA",
    issuance_error_message: "Schema inválido para el comprobante",
    issuance_last_attempt_at: "2026-07-13T20:02:00.000Z",
    issuance_failed_at: "2026-07-13T20:02:00.000Z",
    issuance_dead_lettered_at: null,
    reserved_numero_control: "DTE-15-M001P004-000000000000031"
  },
  {
    id: "wompi-event-2",
    environment: "00",
    amount_cents: 10_000,
    donor_name: "Ana López",
    donor_email: "ana@example.com",
    received_at: "2026-07-13T21:00:00.000Z",
    issuance_status: "DEAD_LETTERED",
    issuance_attempt_count: 5,
    issuance_error_code: "CDE_BUILD_FAILED",
    issuance_error_message: "No fue posible construir el comprobante",
    issuance_last_attempt_at: "2026-07-13T21:05:00.000Z",
    issuance_failed_at: "2026-07-13T21:05:00.000Z",
    issuance_dead_lettered_at: "2026-07-13T21:05:00.000Z",
    reserved_numero_control: null
  }
];

describe("filterPreCdeFailures", () => {
  it("matches donor names without case sensitivity", () => {
    expect(filterPreCdeFailures(items, "jose")).toEqual([items[0]]);
  });

  it("matches the reserved control number", () => {
    expect(filterPreCdeFailures(items, "000031")).toEqual([items[0]]);
  });

  it("matches issuance errors", () => {
    expect(filterPreCdeFailures(items, "schema")).toEqual([items[0]]);
    expect(filterPreCdeFailures(items, " cde_schema ")).toEqual([items[0]]);
  });

  it("matches donor email and the amount rendered with two decimals", () => {
    expect(filterPreCdeFailures(items, "jose@example.com")).toEqual([items[0]]);
    expect(filterPreCdeFailures(items, "42.50")).toEqual([items[0]]);
  });

  it("returns the original items for an empty query", () => {
    expect(filterPreCdeFailures(items, "")).toEqual(items);
  });
});
