import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { quickDteValidationMessage } from "../../src/client/App";

const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");
const stylesSource = readFileSync(resolve(import.meta.dirname, "../../src/client/styles.css"), "utf8");

describe("quick DTE UI contract", () => {
  it("uses donation wording, compact controls, and human-readable donor document labels", () => {
    expect(appSource).toContain("Registre una donación recibida en persona y emita su comprobante al instante.");
    expect(appSource).toContain('placeholder="Nombre o razón social"');
    expect(appSource).toContain("className=\"quick-document-type\"");
    expect(appSource).toContain("showCodes={false}");
    expect(stylesSource).toContain(".quick-document-type");
  });

  it("keeps DUI validation conditional and rejects malformed quick donor email", () => {
    expect(quickDteValidationMessage({
      amount: "1.00",
      donorName: "Donante",
      donorDocumentType: "13",
      donorDocument: "RECIBO-123",
      donorEmail: "",
      donorPhone: ""
    })).toBe("DUI debe tener 9 dígitos");

    expect(quickDteValidationMessage({
      amount: "1.00",
      donorName: "Donante",
      donorDocumentType: "37",
      donorDocument: "RECIBO-123",
      donorEmail: "correo-invalido",
      donorPhone: ""
    })).toBe("Ingrese un correo válido");

    expect(quickDteValidationMessage({
      amount: "1.00",
      donorName: "Donante",
      donorDocumentType: "37",
      donorDocument: "RECIBO-123",
      donorEmail: "",
      donorPhone: ""
    })).toBe("");
  });
});
