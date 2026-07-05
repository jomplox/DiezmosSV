import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateAdvancedCdeForm } from "../../src/client/App";

const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");

function validForm() {
  return {
    donorName: "Donante",
    donorTipoDocumento: "37",
    donorDocument: "SIN-DOCUMENTO",
    donorNrc: "",
    donorCodActividad: "",
    donorDescActividad: "",
    donorEmail: "donante@example.org",
    donorPhone: "00000000",
    codDomiciliado: "1",
    codPais: "SV",
    departamento: "06",
    municipio: "22",
    distrito: "01",
    direccionComplemento: "Calle Principal #123",
    tipoDonacion: "1",
    cantidad: "1",
    codigo: "DONACION",
    uniMedida: "59",
    descripcion: "Donación en efectivo",
    tipoDepreciacion: "0",
    valorUni: "1.00",
    valorTotal: "1.00",
    totalLetras: "",
    pagoCodigo: "01",
    pagoReferencia: "STAGING",
    documentoCodigo: "1",
    documentoDesc: "Referencia Wompi",
    documentoDetalle: "DTE avanzado",
    apendiceCampo: "Aplicativo",
    apendiceEtiqueta: "Aplicativo",
    apendiceValor: "DiezmosSV Staging"
  };
}

describe("advanced CDE wizard defaults", () => {
  it("never ships a placeholder test value that could reach a signed document", () => {
    expect(appSource).not.toContain("Dirección de prueba");
    expect(appSource).not.toContain("Donación de prueba");
    expect(appSource).not.toContain("Donante de Prueba");
  });

  it("gives descripcion and direccionComplemento helpful placeholder text instead of prefilled values", () => {
    expect(appSource).toContain('placeholder="Ej.: Donación en efectivo"');
    expect(appSource).toContain('placeholder="Calle, número, colonia…"');
  });

  it("rejects an empty descripcion", () => {
    expect(validateAdvancedCdeForm({ ...validForm(), descripcion: "" })).toBe("Descripción es requerido");
    expect(validateAdvancedCdeForm({ ...validForm(), descripcion: "   " })).toBe("Descripción es requerido");
  });

  it("rejects an empty direccionComplemento", () => {
    expect(validateAdvancedCdeForm({ ...validForm(), direccionComplemento: "" })).toBe("Dirección completa es requerido");
    expect(validateAdvancedCdeForm({ ...validForm(), direccionComplemento: "   " })).toBe("Dirección completa es requerido");
  });

  it("accepts a fully filled form", () => {
    expect(validateAdvancedCdeForm(validForm())).toBeNull();
  });
});

describe("advanced CDE wizard footer", () => {
  it("only shows Generar avanzado on the last step, not alongside Siguiente", () => {
    const modalMatch = appSource.match(/function AdvancedDteModal\([\s\S]*?\n}\n/);
    expect(modalMatch).not.toBeNull();
    const modalSource = modalMatch?.[0] ?? "";
    const footerMatch = modalSource.match(/<footer>[\s\S]*?<\/footer>/);
    expect(footerMatch).not.toBeNull();
    const footer = footerMatch?.[0] ?? "";
    const siguienteIndex = footer.indexOf("Siguiente");
    const generarIndex = footer.indexOf("Generar avanzado");
    expect(siguienteIndex).toBeGreaterThan(-1);
    expect(generarIndex).toBeGreaterThan(-1);
    const lastStepGuardBeforeSiguiente = footer.lastIndexOf("activeStep !== advancedCdeSteps.length - 1", siguienteIndex);
    const lastStepGuardBeforeGenerar = footer.lastIndexOf("activeStep === advancedCdeSteps.length - 1", generarIndex);
    expect(lastStepGuardBeforeSiguiente).toBeGreaterThan(-1);
    expect(lastStepGuardBeforeGenerar).toBeGreaterThan(-1);
  });
});
