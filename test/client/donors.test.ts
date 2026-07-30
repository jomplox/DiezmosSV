import { describe, expect, it } from "vitest";
import {
  buildDonorExportQuery,
  buildDonorExplorerQuery,
  maskDocumentNumber,
  type DonorExplorerFilters
} from "../../src/client/donors";

function filters(overrides: Partial<DonorExplorerFilters> = {}): DonorExplorerFilters {
  return {
    documentType: "",
    documentValue: "",
    name: "",
    email: "",
    minAmount: "",
    maxAmount: "",
    giftType: "",
    source: "",
    ...overrides
  };
}

describe("donor explorer query", () => {
  it("normalizes filters and converts visible USD amounts to integer cents", () => {
    const result = buildDonorExplorerQuery({
      filters: filters({
        documentType: "13",
        documentValue: " 0123-4567 ",
        name: " Ana ",
        email: " ANA@EXAMPLE.ORG ",
        minAmount: "25.50",
        maxAmount: "100",
        giftType: "DIEZMO",
        source: "WOMPI"
      }),
      environment: "00",
      limit: 25,
      offset: 50
    });

    expect(result.error).toBeNull();
    expect(result.params?.toString()).toBe(
      "environment=00&documentType=13&documentValue=0123-4567&name=Ana&email=ANA%40EXAMPLE.ORG&minTotalCents=2550&maxTotalCents=10000&giftType=DIEZMO&source=WOMPI&limit=25&offset=50"
    );
  });

  it.each([
    [{ minAmount: "-1" }, "Ingrese montos válidos"],
    [{ minAmount: "10.001" }, "Ingrese montos válidos"],
    [{ maxAmount: "abc" }, "Ingrese montos válidos"],
    [{ minAmount: "20", maxAmount: "10" }, "El monto desde no puede ser mayor"]
  ])("rejects an invalid amount filter", (amounts, expectedMessage) => {
    const result = buildDonorExplorerQuery({
      filters: filters(amounts),
      environment: "00",
      limit: 25,
      offset: 0
    });

    expect(result.params).toBeNull();
    expect(result.error).toContain(expectedMessage);
  });

  it("builds a full-result CSV query from the visible filters without page controls", () => {
    const result = buildDonorExportQuery({
      filters: filters({
        documentType: "13",
        documentValue: " 0123-4567 ",
        name: " Ana ",
        email: " ANA@EXAMPLE.ORG ",
        minAmount: "25.50",
        maxAmount: "100",
        giftType: "DIEZMO",
        source: "WOMPI"
      }),
      environment: "00"
    });

    expect(result.error).toBeNull();
    expect(result.params?.toString()).toBe(
      "environment=00&documentType=13&documentValue=0123-4567&name=Ana&email=ANA%40EXAMPLE.ORG&minTotalCents=2550&maxTotalCents=10000&giftType=DIEZMO&source=WOMPI"
    );
  });
});

describe("donor explorer document display", () => {
  it("masks document numbers in the table while preserving a useful suffix", () => {
    expect(maskDocumentNumber("10000000-1")).toBe("••••••00-1");
    expect(maskDocumentNumber("P123")).toBe("••••");
    expect(maskDocumentNumber("")).toBe("—");
  });
});
