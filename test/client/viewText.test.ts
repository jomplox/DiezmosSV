import { describe, expect, it } from "vitest";
import { documentListEmptyMessage, viewSubtitle } from "../../src/client/App";

describe("viewSubtitle", () => {
  it("gives the Fallos view a subtitle describing errors needing attention", () => {
    expect(viewSubtitle("failures")).toBe("CDE con errores o rechazos que requieren su atención.");
  });

  it("gives the audit view a subtitle describing the action history", () => {
    expect(viewSubtitle("audit")).toBe("Historial de todas las acciones realizadas en el panel.");
  });

  it("gives the users view a subtitle describing account/role management", () => {
    expect(viewSubtitle("users")).toBe("Cree cuentas y asigne roles de acceso al panel.");
  });

  it("keeps distinct, non-empty subtitles for the remaining views", () => {
    const views = ["documents", "contingency", "credentials", "exports"] as const;
    const subtitles = views.map((view) => viewSubtitle(view));
    for (const subtitle of subtitles) {
      expect(subtitle.length).toBeGreaterThan(0);
    }
    expect(new Set(subtitles).size).toBe(subtitles.length);
  });
});

describe("documentListEmptyMessage", () => {
  it("reassures the user in the failures view when there is no query", () => {
    expect(documentListEmptyMessage("failures", "")).toBe("Sin fallos pendientes. Todo en orden.");
  });

  it("keeps the generic no-results message in the failures view when a query is active", () => {
    expect(documentListEmptyMessage("failures", "abc")).toBe("No hay CDE que coincidan con la búsqueda o el filtro.");
  });

  it("keeps the generic no-results message in the documents view regardless of query", () => {
    expect(documentListEmptyMessage("documents", "")).toBe("No hay CDE que coincidan con la búsqueda o el filtro.");
    expect(documentListEmptyMessage("documents", "abc")).toBe("No hay CDE que coincidan con la búsqueda o el filtro.");
  });
});
