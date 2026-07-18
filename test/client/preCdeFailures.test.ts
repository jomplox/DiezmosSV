import { describe, expect, it } from "vitest";
import {
  createLatestRequestGate,
  filterPreCdeFailures,
  isPreCdeRetryInFlight,
  preCdeActionLabel
} from "../../src/client/preCdeFailures";
import type { WompiIssuanceFailureItem } from "../../src/client/types";

const items: WompiIssuanceFailureItem[] = [
  {
    id: "wompi-event-1",
    environment: "00",
    amount_cents: 4_250,
    donor_name: "Jose Pérez",
    donor_email: "jose@example.com",
    received_at: "2026-07-13T20:00:00.000Z",
    processed_at: "2026-07-13T20:02:00.000Z",
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
    processed_at: "2026-07-13T21:05:00.000Z",
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

describe("isPreCdeRetryInFlight", () => {
  it("distinguishes live retry work from a legacy terminal row stuck in an in-flight status", () => {
    expect(isPreCdeRetryInFlight({
      issuance_status: "PROCESSING",
      processed_at: null
    })).toBe(true);
    expect(isPreCdeRetryInFlight({
      issuance_status: "RETRY_QUEUED",
      processed_at: null
    })).toBe(true);
    expect(isPreCdeRetryInFlight({
      issuance_status: "PROCESSING",
      processed_at: "2026-07-17T17:00:00.000Z"
    })).toBe(false);
    expect(isPreCdeRetryInFlight({
      issuance_status: "RETRY_QUEUED",
      processed_at: "2026-07-17T17:00:00.000Z"
    })).toBe(false);
  });

  it("exposes the guarded correction label for legacy terminal in-flight statuses", () => {
    expect(preCdeActionLabel({
      issuance_status: "PROCESSING",
      processed_at: "2026-07-17T17:00:00.000Z"
    }, true)).toBe("Corregir y reintentar");
    expect(preCdeActionLabel({
      issuance_status: "RETRY_QUEUED",
      processed_at: "2026-07-17T17:00:00.000Z"
    }, true)).toBe("Corregir y reintentar");
    expect(preCdeActionLabel({
      issuance_status: "PROCESSING",
      processed_at: null
    }, true)).toBe("Procesando corrección");
    expect(preCdeActionLabel({
      issuance_status: "RETRY_QUEUED",
      processed_at: null
    }, true)).toBe("Corrección en cola");
  });

  it("exposes generic retry only for a non-correctable legacy terminal row", () => {
    expect(preCdeActionLabel({
      issuance_status: "PROCESSING",
      processed_at: "2026-07-17T17:00:00.000Z"
    }, false)).toBe("Reintentar creación");
    expect(preCdeActionLabel({
      issuance_status: "PROCESSING",
      processed_at: null
    }, false)).toBe("Reintento en cola");
  });
});

describe("createLatestRequestGate", () => {
  it("does not let a stale completion clear a newer request's loading state", () => {
    const gate = createLatestRequestGate();
    const state = { loading: false };
    const olderRequest = gate.start();
    olderRequest.commit(() => {
      state.loading = true;
    });
    const newerRequest = gate.start();
    newerRequest.commit(() => {
      state.loading = true;
    });

    expect(olderRequest.commit(() => {
      state.loading = false;
    })).toBe(false);
    expect(state.loading).toBe(true);
    expect(newerRequest.commit(() => {
      state.loading = false;
    })).toBe(true);
    expect(state.loading).toBe(false);
  });

  it("prevents an older request from replacing newer items or errors", () => {
    const gate = createLatestRequestGate();
    const state = { items: [] as string[], error: "" };
    const olderRequest = gate.start();
    const newerRequest = gate.start();

    expect(newerRequest.commit(() => {
      state.items = ["newer"];
    })).toBe(true);
    expect(olderRequest.commit(() => {
      state.items = ["older"];
    })).toBe(false);
    expect(olderRequest.commit(() => {
      state.error = "stale error";
    })).toBe(false);
    expect(state).toEqual({ items: ["newer"], error: "" });
  });

  it("prevents requests invalidated by leaving Fallos or logout from committing", () => {
    const gate = createLatestRequestGate();
    const state = { items: [] as string[], error: "" };
    const requestBeforeLeaving = gate.start();

    gate.invalidate();
    expect(requestBeforeLeaving.commit(() => {
      state.items = ["stale after leaving"];
    })).toBe(false);

    const requestBeforeLogout = gate.start();
    gate.invalidate();
    expect(requestBeforeLogout.commit(() => {
      state.error = "stale after logout";
    })).toBe(false);
    expect(state).toEqual({ items: [], error: "" });
  });
});
