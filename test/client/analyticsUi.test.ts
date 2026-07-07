import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");
const viewSource = readFileSync(resolve(import.meta.dirname, "../../src/client/analyticsView.tsx"), "utf8");
const helperSource = readFileSync(resolve(import.meta.dirname, "../../src/client/analytics.ts"), "utf8");
const stylesSource = readFileSync(resolve(import.meta.dirname, "../../src/client/styles.css"), "utf8");

describe("Analítica navigation and wiring", () => {
  it("registers the Analítica nav item with a chart icon and VIEWER access", () => {
    expect(appSource).toContain('{ id: "analytics", label: "Analítica", icon: LineChart }');
    // No minRole => VIEWER (read-only), like documents/audit.
    expect(appSource).not.toContain('{ id: "analytics", label: "Analítica", icon: LineChart, minRole');
  });

  it("mounts the extracted AnalyticsView and fetches the analytics endpoint", () => {
    expect(appSource).toContain("import { AnalyticsView } from \"./analyticsView\"");
    expect(appSource).toContain('view === "analytics"');
    expect(appSource).toContain("/api/analytics?");
  });

  it("defaults the ambiente selector to the active emission environment", () => {
    // The view opens by loading the active emission environment for its default selector.
    expect(appSource).toContain('api<{ emissionEnvironment: EmissionEnvironmentState }>("/api/settings/emission-environment"');
    expect(appSource).toContain("setAnalyticsEnvironment");
  });
});

describe("Analítica view contract (usted-form Spanish, Wompi lane)", () => {
  it("states the Wompi-lane scope and excludes manual CDEs in copy", () => {
    expect(viewSource).toContain("carril Wompi");
    expect(viewSource).toContain("Los CDE emitidos a mano no se incluyen.");
  });

  it("offers the required date-range presets and gift-type filter", () => {
    // Preset labels live in the pure helper; the gift-type filter in the view.
    expect(helperSource).toContain("Este mes");
    expect(helperSource).toContain("Últimos 3 meses");
    expect(helperSource).toContain("Este año");
    expect(helperSource).toContain("Año anterior");
    expect(helperSource).toContain("Personalizado");
    expect(viewSource).toContain('{ id: "todos", label: "Todos" }');
    expect(viewSource).toContain('{ id: "diezmo", label: "Diezmo" }');
    expect(viewSource).toContain('{ id: "ofrenda", label: "Ofrenda" }');
  });

  it("renders each required section heading", () => {
    expect(viewSource).toContain("Tendencias de donación");
    expect(viewSource).toContain("Embudo y operación");
    expect(viewSource).toContain("Análisis profundo");
    expect(viewSource).toContain("Diezmo vs. Ofrenda");
    expect(viewSource).toContain("Nuevos vs. recurrentes");
    expect(viewSource).toContain("Top 10 donantes recurrentes");
    expect(viewSource).toContain("Distribución geográfica");
    expect(viewSource).toContain("Embudo de conversión");
    expect(viewSource).toContain("Salud del Ministerio de Hacienda");
    expect(viewSource).toContain("Entregabilidad de correo");
    expect(viewSource).toContain("Retención por cohortes");
    expect(viewSource).toContain("Donantes inactivos");
    expect(viewSource).toContain("Mapa de calor");
    expect(viewSource).toContain("Proyección");
  });

  it("labels the projection as simple, without ML claims", () => {
    expect(viewSource).toContain("Proyección simple");
    expect(viewSource).toContain("no es un pronóstico");
  });

  it("shows the Spanish empty state per section", () => {
    expect(viewSource).toContain("Sin donaciones en este período.");
  });

  it("never exposes full document numbers in the donor tables", () => {
    // Top-10 and lapsed lists render name/email/total only — no numero_control column.
    expect(viewSource).not.toContain("numero_control");
    expect(viewSource).not.toContain("codigo_generacion");
  });

  it("gives every chart an aria-label and uses only theme variables (no new hex)", () => {
    expect(viewSource).toContain('role="img"');
    expect(viewSource).toContain("aria-label=");
    // Charts theme with CSS variables; no raw hex color literals in the view.
    expect(viewSource).not.toMatch(/#[0-9a-fA-F]{6}\b/);
  });
});

describe("Analítica styles", () => {
  it("themes the charts with existing variables and defines the grid", () => {
    expect(stylesSource).toContain(".analytics-view");
    expect(stylesSource).toContain(".analytics-line");
    expect(stylesSource).toContain(".analytics-heatmap-cell");
    // Accent-tinted chart fills reuse the theme variables.
    expect(stylesSource).toContain("var(--accent)");
  });
});
