import { describe, expect, it } from "vitest";
import {
  CAT012_DEPARTMENTS,
  CAT013_MUNICIPALITIES,
  CAT014_UNITS,
  CAT017_PAYMENT_FORMS,
  CAT019_ACTIVITIES,
  CAT021_ASSOCIATED_DOCUMENTS,
  CAT022_DOCUMENT_TYPES,
  CAT026_DONATION_TYPES,
  CAT032_DOMICILE,
  CAT020_COUNTRIES,
  getCat013Municipalities,
  getCat008Districts
} from "../../src/shared/catalogs";

describe("MH catalog options", () => {
  it("exposes human-readable options for advanced CDE catalog fields", () => {
    expect(CAT012_DEPARTMENTS).toContainEqual({ code: "06", label: "San Salvador" });
    expect(CAT020_COUNTRIES).toContainEqual({ code: "SV", label: "El Salvador" });
    expect(CAT022_DOCUMENT_TYPES).toContainEqual({ code: "03", label: "Pasaporte" });
    expect(CAT026_DONATION_TYPES).toContainEqual({ code: "1", label: "Efectivo" });
    expect(CAT014_UNITS).toContainEqual({ code: "59", label: "Unidad" });
    expect(CAT017_PAYMENT_FORMS).toContainEqual({ code: "05", label: "Transferencia-Depósito Bancario" });
    expect(CAT021_ASSOCIATED_DOCUMENTS).toContainEqual({ code: "1", label: "Emisor" });
    expect(CAT032_DOMICILE).toContainEqual({ code: "2", label: "No Domiciliado" });
    expect(CAT019_ACTIVITIES).toContainEqual({ code: "10005", label: "Otros" });
  });

  it("scopes municipality and district choices by selected department", () => {
    expect(CAT013_MUNICIPALITIES).toContainEqual({ code: "22", label: "SAN SALVADOR ESTE", departmentCode: "06" });
    expect(getCat013Municipalities("06")).toContainEqual({ code: "22", label: "SAN SALVADOR ESTE", departmentCode: "06" });
    expect(getCat013Municipalities("06")).not.toContainEqual({ code: "22", label: "SAN MIGUEL CENTRO", departmentCode: "12" });
    expect(getCat008Districts("06")).toContainEqual({ code: "13", label: "SAN MARTIN", departmentCode: "06" });
  });
});
