import { describe, expect, it } from "vitest";
import {
  FiscalCorrectionValidationError,
  fiscalCorrectionChangedFields,
  fiscalCorrectionPayload,
  validateFiscalReceptorCorrection
} from "../../src/shared/fiscalCorrection";

const valid = () => ({
  tipoDocumento: "13",
  numDocumento: "100000027",
  nrc: "",
  nombre: " Ana Donante ",
  codActividad: "",
  descActividad: "",
  correo: " ANA@Example.org ",
  telefono: " 70001111 ",
  codDomiciliado: 1,
  codPais: "sv",
  departamento: "06",
  municipio: "22",
  distrito: "01",
  complemento: " Colonia Centro "
});

describe("fiscal receptor correction", () => {
  it("canonicalizes a valid domestic correction", () => {
    expect(validateFiscalReceptorCorrection(valid())).toEqual({
      tipoDocumento: "13",
      numDocumento: "10000002-7",
      nrc: null,
      nombre: "Ana Donante",
      codActividad: null,
      descActividad: null,
      correo: "ana@example.org",
      telefono: "70001111",
      codDomiciliado: 1,
      codPais: "SV",
      departamento: "06",
      municipio: "22",
      distrito: "01",
      complemento: "Colonia Centro"
    });
  });

  it("rejects an invalid DUI before any fiscal work", () => {
    expect(() => validateFiscalReceptorCorrection({
      ...valid(),
      numDocumento: "12345678-9"
    })).toThrowError(FiscalCorrectionValidationError);
  });

  it("accepts a foreign receptor without pretending 00 is an SV district", () => {
    expect(validateFiscalReceptorCorrection({
      ...valid(),
      tipoDocumento: "03",
      numDocumento: "P-A123456",
      codDomiciliado: 2,
      codPais: "GT",
      departamento: "00",
      municipio: "00",
      distrito: "00",
      complemento: "Zona 10, Ciudad de Guatemala"
    })).toMatchObject({
      codDomiciliado: 2,
      codPais: "GT",
      departamento: "00",
      municipio: "00",
      distrito: "00"
    });
  });

  it("returns sorted changed fields and a stable payload", () => {
    const before = validateFiscalReceptorCorrection(valid());
    const after = { ...before, correo: "new@example.org", nombre: "Nueva Donante" };
    expect(fiscalCorrectionChangedFields(before, after)).toEqual(["correo", "nombre"]);
    expect(fiscalCorrectionPayload(after)).toBe(fiscalCorrectionPayload({ ...after }));
  });
});
