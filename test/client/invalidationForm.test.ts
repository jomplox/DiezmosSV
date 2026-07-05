import { describe, expect, it } from "vitest";
import { defaultInvalidationForm, invalidationFormValidationMessage, invalidationRequestBody } from "../../src/client/invalidationForm";

describe("invalidation form", () => {
  it("defaults to rescission (tipo 2) with an empty motive", () => {
    expect(defaultInvalidationForm()).toEqual({ tipoAnulacion: 2, motivoAnulacion: "", codigoGeneracionR: "" });
  });

  it("requires a motive for every invalidation", () => {
    expect(invalidationFormValidationMessage({ tipoAnulacion: 2, motivoAnulacion: "   ", codigoGeneracionR: "" })).toBe(
      "Ingrese el motivo de la invalidación"
    );
    expect(invalidationFormValidationMessage({ tipoAnulacion: 2, motivoAnulacion: "Donación duplicada", codigoGeneracionR: "" })).toBe("");
  });

  it("requires a valid replacement codigo de generación for tipo 1", () => {
    const base = { tipoAnulacion: 1 as const, motivoAnulacion: "Nombre del donante errado" };
    expect(invalidationFormValidationMessage({ ...base, codigoGeneracionR: "" })).toMatch(/código de generación del CDE de reemplazo/);
    expect(invalidationFormValidationMessage({ ...base, codigoGeneracionR: "not-a-uuid" })).toMatch(/código de generación/);
    expect(invalidationFormValidationMessage({ ...base, codigoGeneracionR: "9363be81-12ea-4c85-9f1f-a9821f62b72f" })).toBe("");
  });

  it("builds the request body, omitting the replacement for tipo 2 and uppercasing it for tipo 1", () => {
    expect(invalidationRequestBody({ tipoAnulacion: 2, motivoAnulacion: " Donación duplicada ", codigoGeneracionR: "" })).toEqual({
      tipoAnulacion: 2,
      motivoAnulacion: "Donación duplicada"
    });
    expect(
      invalidationRequestBody({ tipoAnulacion: 1, motivoAnulacion: "Nombre errado", codigoGeneracionR: "9363be81-12ea-4c85-9f1f-a9821f62b72f" })
    ).toEqual({
      tipoAnulacion: 1,
      motivoAnulacion: "Nombre errado",
      codigoGeneracionR: "9363BE81-12EA-4C85-9F1F-A9821F62B72F"
    });
  });
});
