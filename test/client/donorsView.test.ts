import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DonorsView } from "../../src/client/donorsView";

describe("DonorsView", () => {
  it("renders the complete filter and results-table contract in the admin design system", () => {
    const html = renderToStaticMarkup(
      createElement(DonorsView, {
        environment: "00",
        loadPage: async () => ({
          donors: [],
          total: 0,
          limit: 25,
          offset: 0,
          hasMore: false
        }),
        onError: () => undefined
      })
    );

    for (const label of [
      "Tipo de documento",
      "Número de documento",
      "Nombre",
      "Correo",
      "Total desde",
      "Total hasta",
      "Tipo de entrega",
      "Origen",
      "Donante",
      "Contacto",
      "Ubicación",
      "Actividad",
      "Total entregado",
      "Última entrega"
    ]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Solo se incluyen CDE aceptados del ambiente de pruebas.");
    expect(html).toContain("Limpiar filtros");
    expect(html).toContain("Actualizar");
  });
});
