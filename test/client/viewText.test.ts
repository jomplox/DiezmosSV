import { describe, expect, it } from "vitest";
import { FAILURE_VIEW_STATUSES, documentListEmptyMessage, viewSubtitle } from "../../src/client/App";

describe("viewSubtitle", () => {
  it("gives the Fallos view a subtitle describing errors needing attention", () => {
    expect(viewSubtitle("failures")).toBe("CDE con errores, rechazos o pagos sin comprobante que requieren su atención.");
  });

  it("gives the audit view a subtitle describing the action history", () => {
    expect(viewSubtitle("audit")).toBe("Historial de todas las acciones realizadas en el panel.");
  });

  it("gives the users view a subtitle describing account/role management", () => {
    expect(viewSubtitle("users")).toBe("Cree cuentas y asigne roles de acceso al panel.");
  });

  it("describes Contingencia as automatic retry behavior, not an archive", () => {
    expect(viewSubtitle("contingency")).toBe("El CDE no usa contingencia; cuando Hacienda no responde, queda en trámite y se reintenta automáticamente.");
  });

  it("keeps distinct, non-empty subtitles for the remaining views", () => {
    const views = ["documents", "credentials", "exports"] as const;
    const subtitles = views.map((view) => viewSubtitle(view));
    for (const subtitle of subtitles) {
      expect(subtitle.length).toBeGreaterThan(0);
    }
    expect(new Set(subtitles).size).toBe(subtitles.length);
  });
});

describe("documentListEmptyMessage", () => {
  it("does not claim everything is fine while pre-CDE failures are still loading", () => {
    expect(documentListEmptyMessage("failures", "", true)).toBe("Revisando pagos sin CDE creado…");
  });

  it("reassures the user in the failures view when there is no query", () => {
    expect(documentListEmptyMessage("failures", "")).toBe("Sin fallos pendientes. Todo en orden.");
  });

  it("mentions both issued CDEs and payments without a receipt when a Fallos query has no results", () => {
    expect(documentListEmptyMessage("failures", "abc")).toBe("No hay CDE ni pagos sin comprobante que coincidan con la búsqueda.");
  });

  it("keeps the generic no-results message in the documents view regardless of query", () => {
    expect(documentListEmptyMessage("documents", "")).toBe("No hay CDE que coincidan con la búsqueda o el filtro.");
    expect(documentListEmptyMessage("documents", "abc")).toBe("No hay CDE que coincidan con la búsqueda o el filtro.");
  });
});

describe("FAILURE_VIEW_STATUSES", () => {
  it("loads both failed and rejected documents for the Fallos view", () => {
    // The Fallos subtitle promises errores O rechazos: REJECTED CDEs are real MH
    // rejections that need operator action, so the view must request both statuses.
    expect(FAILURE_VIEW_STATUSES.split(",")).toEqual(["FAILED", "REJECTED"]);
  });
});
