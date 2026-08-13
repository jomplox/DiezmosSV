import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource =
  readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8") +
  readFileSync(resolve(import.meta.dirname, "../../src/client/exportsPanel.tsx"), "utf8");

describe("CRM contacts export UI contract", () => {
  it("renders the Contactos para CRM panel with a provider-neutral description and active-ambiente note", () => {
    expect(appSource).toContain("Contactos para CRM");
    expect(appSource).toContain(
      "Exporte los datos de contacto de sus donantes para importarlos en su CRM."
    );
    expect(appSource).toContain("Se exportan los contactos del ambiente activo");
    expect(appSource).toContain("<ContactsExportPanel");
  });

  it("wires the download button to the contacts export endpoint using the active ambiente", () => {
    expect(appSource).toContain("async function downloadContacts()");
    // Query is now assembled via URLSearchParams (environment + optional filters).
    expect(appSource).toContain("/api/exports/contacts?${params.toString()}");
    expect(appSource).toContain('new URLSearchParams({ environment })');
    expect(appSource).toContain('runAction("export-contacts"');
    // Auth-header fetch → blob → anchor download, mirroring the F960 pattern.
    expect(appSource).toContain("Authorization: `Bearer ${token}`");
    expect(appSource).toContain('filenameFromDisposition(contentDisposition, "contactos-donantes.csv")');
    expect(appSource).toContain('setToast("Contactos exportados")');
  });

  it("loads the active ambiente when admins open the exports view", () => {
    expect(appSource).toContain('view === "exports" && can(user, "ADMIN")');
    expect(appSource).toContain('accountApi<{ emissionEnvironment: EmissionEnvironmentState }>("/api/settings/emission-environment")');
    expect(appSource).toContain("setEmissionEnvironment(environmentResult.emissionEnvironment)");
  });

  it("disables the button until the active ambiente is known and shows a busy state", () => {
    expect(appSource).toContain("disabled={busy || !environment");
    expect(appSource).toContain('busy === "export-contacts"');
  });

  it("offers period, tipo, and column controls that customize the export", () => {
    // Period select with the four presets.
    expect(appSource).toContain("Todo el tiempo");
    expect(appSource).toContain("Este año");
    expect(appSource).toContain("Año anterior");
    expect(appSource).toContain("Personalizado");
    // Tipo select: Todos / Diezmo / Ofrenda.
    expect(appSource).toContain('<option value="DIEZMO">Diezmo</option>');
    expect(appSource).toContain('<option value="OFRENDA">Ofrenda</option>');
    // Column checkbox group and its whitelist keys.
    expect(appSource).toContain("CONTACT_EXPORT_COLUMNS");
    expect(appSource).toContain("contacts-columns");
    // The from/to/giftType/columns params thread into the request.
    expect(appSource).toContain('params.set("from"');
    expect(appSource).toContain('params.set("giftType"');
    expect(appSource).toContain('params.set("columns"');
  });

  it("requires at least one column: disables the button and shows a Spanish hint", () => {
    expect(appSource).toContain("Seleccione al menos una columna para exportar.");
    // Button disabled predicate includes the no-columns guard.
    expect(appSource).toContain("noColumns");
  });
});
