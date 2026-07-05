import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");

describe("online donations UI contract", () => {
  it("renders the online-donations card with usted-form copy in the Exportar view", () => {
    expect(appSource).toContain("Donaciones en línea");
    expect(appSource).toContain("Últimas donaciones recibidas desde el formulario público de donación.");
    // Table columns: estado, monto, donante, fecha, and numero de control for COMPLETED.
    expect(appSource).toContain("<th>Estado</th>");
    expect(appSource).toContain(">Monto</th>");
    expect(appSource).toContain("<th>Donante</th>");
    expect(appSource).toContain("<th>Fecha</th>");
    expect(appSource).toContain("<th>Número de control</th>");
  });

  it("shows the Spanish empty state when there are no online donations", () => {
    expect(appSource).toContain("Sin donaciones en línea todavía.");
  });

  it("fetches the last online donation intents for the admin card", () => {
    expect(appSource).toContain("/api/donations/intents");
    expect(appSource).toContain("donationIntentStatusLabel");
  });

  it("surfaces the donor-data-verified badge on a document produced from an intent", () => {
    expect(appSource).toContain("Datos del donante verificados en el formulario de donación");
    expect(appSource).toContain("donorDataVerified");
  });
});
