import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");

describe("CRM contacts export UI contract", () => {
  it("renders the Contactos para CRM panel with the GiveButter description and active-ambiente note", () => {
    expect(appSource).toContain("Contactos para CRM");
    expect(appSource).toContain(
      "Exporte los datos de contacto de sus donantes para importarlos en un CRM como GiveButter."
    );
    expect(appSource).toContain("Se exportan los contactos del ambiente activo");
    expect(appSource).toContain("<ContactsExportPanel");
  });

  it("wires the download button to the contacts export endpoint using the active ambiente", () => {
    expect(appSource).toContain("async function downloadContacts()");
    expect(appSource).toContain("/api/exports/contacts?environment=${environment}");
    expect(appSource).toContain('runAction("export-contacts"');
    // Auth-header fetch → blob → anchor download, mirroring the F960 pattern.
    expect(appSource).toContain("Authorization: `Bearer ${token}`");
    expect(appSource).toContain('filenameFromDisposition(response.headers.get("Content-Disposition"), "contactos-donantes.csv")');
    expect(appSource).toContain('setToast("Contactos exportados")');
  });

  it("disables the button until the active ambiente is known and shows a busy state", () => {
    expect(appSource).toContain("disabled={busy || !environment}");
    expect(appSource).toContain('busy === "export-contacts"');
  });
});
