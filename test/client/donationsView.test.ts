import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DonationsTable, DonationsView } from "../../src/client/donationsView";
import type { DonationLedgerRow } from "../../src/client/types";

const appSource =
  readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8") +
  readFileSync(resolve(import.meta.dirname, "../../src/client/exportsPanel.tsx"), "utf8") +
  readFileSync(resolve(import.meta.dirname, "../../src/client/documentsView.tsx"), "utf8");

function row(overrides: Partial<DonationLedgerRow>): DonationLedgerRow {
  return {
    id: "row",
    lane: "SV",
    receivedAt: "2026-09-28T16:00:44.000Z",
    amountCents: 2_500,
    refundedAmountCents: 0,
    frequency: "ONCE",
    giftType: null,
    donorName: null,
    donorEmail: null,
    documentId: null,
    numeroControl: null,
    documentStatus: null,
    giftStatus: null,
    acknowledgmentStatus: null,
    ...overrides
  };
}

describe("DonationsTable", () => {
  it("flags each gift's lane and shows the receipt that lane produces", () => {
    const html = renderToStaticMarkup(createElement(DonationsTable, {
      donations: [
        row({
          id: "di_sv",
          giftType: "DIEZMO",
          donorName: "Beto Ruiz",
          donorEmail: "beto@example.org",
          documentId: "doc_sv",
          numeroControl: "DTE-15-M001P004-000000000000042",
          documentStatus: "ACCEPTED"
        }),
        row({ id: "di_waiting" }),
        row({
          id: "stripe_gift_ana",
          lane: "US",
          amountCents: 22_500,
          giftType: "OFRENDA",
          donorName: "Ana C Delgado",
          donorEmail: "ana@example.org",
          giftStatus: "PAID",
          acknowledgmentStatus: "SENT"
        }),
        row({
          id: "stripe_gift_legacy",
          lane: "US",
          frequency: "MONTHLY",
          amountCents: 10_000,
          refundedAmountCents: 10_000,
          giftStatus: "REFUNDED",
          acknowledgmentStatus: "SUPPRESSED"
        })
      ]
    }));

    expect(html).toContain("🇸🇻");
    expect(html).toContain("🇺🇸");
    expect(html).toContain("El Salvador");
    expect(html).toContain("EE. UU.");
    expect(html).toContain("DTE-15-M001P004-000000000000042");
    expect(html).toContain("ACEPTADO");
    expect(html).toContain("Comprobante pendiente");
    expect(html).toContain("Agradecimiento enviado");
    expect(html).toContain("Histórico, sin agradecimiento");
    expect(html).toContain("Reembolsada");
    expect(html).toContain("Mensual");
    expect(html).toContain("$225.00");
    expect(html).toContain("Ana C Delgado");
    expect(html).toContain("ana@example.org");
    expect(html).toContain("28/09/2026, 10:00");
  });

  it("shows an empty state when no gift matches", () => {
    expect(renderToStaticMarkup(createElement(DonationsTable, { donations: [] })))
      .toContain("No hay donaciones que coincidan con los filtros.");
  });
});

describe("DonationsView", () => {
  it("renders search, lane and El Salvador date filters", () => {
    const html = renderToStaticMarkup(createElement(DonationsView, {
      loadPage: async () => ({ donations: [], hasMore: false, nextCursor: null, limit: 50 }),
      onError: () => undefined
    }));
    for (const label of ["Buscar", "País", "Todos", "Desde", "Hasta", "Actualizar", "Limpiar filtros"]) {
      expect(html).toContain(label);
    }
  });
});

describe("Donaciones tab wiring", () => {
  it("is a top-level admin view backed by the unified ledger, replacing the Exportar card", () => {
    expect(appSource).toContain('{ id: "donations", label: "Donaciones"');
    expect(appSource).toContain("/api/donations?");
    expect(appSource).not.toContain("/api/donations/intents");
    expect(appSource).not.toContain("OnlineDonationsPanel");
  });

  it("surfaces the donor-data-verified badge on a document produced from an intent", () => {
    expect(appSource).toContain("Datos del donante verificados en el formulario de donación");
    expect(appSource).toContain("donorDataVerified");
  });
});
