import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");
const stylesSource = readFileSync(resolve(import.meta.dirname, "../../src/client/styles.css"), "utf8");

describe("visual consistency pack", () => {
  it("right-aligns MONTO headers alongside their numeric cells", () => {
    const monthHeaderMatches = appSource.match(/<th[^>]*>Monto<\/th>/g) ?? [];
    expect(monthHeaderMatches.length).toBeGreaterThanOrEqual(3);
    for (const match of monthHeaderMatches) {
      expect(match).toBe('<th className="numeric">Monto</th>');
    }
    expect(stylesSource).toContain("td.numeric, th.numeric {\n  text-align: right;\n}");
  });

  it("gives table headers tighter letter spacing while keeping uppercase and color", () => {
    const thRuleMatch = stylesSource.match(/th \{[^}]*\}/);
    expect(thRuleMatch).not.toBeNull();
    const thRule = thRuleMatch?.[0] ?? "";
    expect(thRule).toContain("font-size: 12px;");
    expect(thRule).toContain("letter-spacing: 0.04em;");
    expect(thRule).toContain("text-transform: uppercase;");
    expect(thRule).toContain("color: #61737a;");
  });

  it("uses single-word stat labels with one shared caption line in both Stats branches", () => {
    expect(appSource).not.toContain("en esta vista");
    expect(appSource).toContain('<p className="stats-caption">Totales de la vista actual.</p>');
    expect(appSource).toContain('<Metric label="Aceptados"');
    expect(appSource).toContain('<Metric label="Fallidos"');
    expect(appSource).toContain('<Metric label="Contingencia"');
    expect(appSource).toContain('<Metric label="Invalidados"');
    expect(stylesSource).toContain(".stats-caption");
  });

  it("collapses the JSON DTE preview into a closed-by-default details element", () => {
    expect(appSource).toContain('<details className="json-details">');
    expect(appSource).toContain("<summary>Ver JSON completo</summary>");
    expect(appSource).not.toMatch(/<details className="json-details" open/);
    const detailsMatch = appSource.match(/<details className="json-details">([\s\S]*?)<\/details>/);
    expect(detailsMatch).not.toBeNull();
    const detailsBlock = detailsMatch?.[0] ?? "";
    expect(detailsBlock).toContain("<summary>Ver JSON completo</summary>");
    expect(detailsBlock).toContain("JSON DTE");
    expect(detailsBlock).toContain("<pre>{JSON.stringify(plain, null, 2)}</pre>");
  });

  it("renames the credentials nav label to Configuración while keeping the subtitle and id", () => {
    expect(appSource).toContain('{ id: "credentials", label: "Configuración", icon: Settings, minRole: "OWNER" }');
    expect(appSource).not.toMatch(/label: "Credenciales", icon: Settings/);
    expect(appSource).toContain('if (view === "credentials") return "Credenciales del Ministerio de Hacienda, Wompi y correo.";');
  });
});
