import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");
const stylesSource = readFileSync(resolve(import.meta.dirname, "../../src/client/styles.css"), "utf8");
const displayTextSource = readFileSync(resolve(import.meta.dirname, "../../src/client/displayText.ts"), "utf8");

describe("monthly backups UI contract", () => {
  it("renders the backups card with usted-form copy in the Exportar view", () => {
    expect(appSource).toContain("Respaldos mensuales");
    expect(appSource).toContain("BackupsPanel");
    // Table headers, in Spanish.
    expect(appSource).toContain(">Mes<");
    expect(appSource).toContain(">Estado<");
    expect(appSource).toContain(">Filas<");
    expect(appSource).toContain(">Exportado el<");
    expect(appSource).toContain(">Acciones<");
  });

  it("shows the estado labels for the three statuses", () => {
    expect(appSource).toContain("Archivado");
    expect(appSource).toContain("Faltante");
    expect(appSource).toContain("En curso");
  });

  it("shows the health line for the fully-backed-up and missing cases", () => {
    expect(appSource).toContain("Todos los meses cerrados están respaldados.");
    expect(appSource).toContain("Falta el respaldo de");
  });

  it("shows the empty state when there are no closed months", () => {
    expect(appSource).toContain("Aún no hay meses cerrados para respaldar.");
  });

  it("wires the backend endpoints for the grid, verify, download, and export actions", () => {
    expect(appSource).toContain("/api/admin/backups");
    expect(appSource).toContain("/verify");
    expect(appSource).toContain("/download?table=");
    // Missing months reuse the existing retention-export endpoint with a confirm dialog.
    expect(appSource).toContain("/api/admin/retention-export?month=");
    expect(appSource).toContain("window.confirm");
    // Authenticated download follows the fetch + blob + Authorization pattern.
    expect(appSource).toContain("Verificar");
    expect(appSource).toContain("Descargar");
    expect(appSource).toContain("Exportar mes");
  });

  it("offers a full-month ZIP download for archived months", () => {
    // "Descargar todo" button alongside the per-table download control.
    expect(appSource).toContain("Descargar todo");
    expect(appSource).toContain("async function downloadAllBackup(");
    expect(appSource).toContain("/download-all");
    // Busy state keyed per month and a failure toast.
    expect(appSource).toContain("backup-download-all-");
    expect(appSource).toContain("respaldo-${month}.zip");
  });

  it("gates the backups card to ADMIN and up, like its neighbouring export panels", () => {
    expect(appSource).toContain('can(user, "ADMIN")');
  });

  it("styles the backups table", () => {
    expect(stylesSource).toContain(".backups-table");
  });

  it("labels the new audit actions in Spanish", () => {
    expect(displayTextSource).toContain("RETENTION_VERIFIED");
    expect(displayTextSource).toContain("RETENTION_VERIFY_FAILED");
    expect(displayTextSource).toContain("RETENTION_DOWNLOADED");
  });
});
