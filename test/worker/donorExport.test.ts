import { describe, expect, it } from "vitest";
import {
  buildDonorExplorerCsv,
  donorExplorerCsvFilename
} from "../../src/worker/services/donorExport";
import type { DonorExplorerRow } from "../../src/worker/storage/repository/donors";

describe("donor explorer CSV", () => {
  it("exports useful labeled fields and neutralizes spreadsheet formulas", () => {
    const donor: DonorExplorerRow = {
      key: "document:13:100000001",
      documentType: "13",
      documentNumber: "10000000-1",
      name: "=Ana",
      email: "ana@example.org",
      phone: "70000000",
      department: "06",
      municipality: "23",
      district: "01",
      address: "Calle 1, local 2",
      country: "SV",
      firstGiftAt: "2026-07-01T18:00:00.000Z",
      lastGiftAt: "2026-07-02T19:30:00.000Z",
      giftCount: 2,
      totalCents: 2500,
      preferredGiftType: "DIEZMO",
      source: "MIXED"
    };

    expect(buildDonorExplorerCsv([donor])).toBe(
      "\uFEFFtipo_documento,numero_documento,nombre,correo,telefono,direccion,departamento,pais,primera_entrega,ultima_entrega,total_entregado_usd,numero_entregas,tipo_preferido,origen\r\n"
      + "DUI,10000000-1,'=Ana,ana@example.org,70000000,\"Calle 1, local 2\",San Salvador,El Salvador,\"01/07/2026, 12:00\",\"02/07/2026, 13:30\",25.00,2,Diezmo,En línea y manual\r\n"
    );
  });

  it("neutralizes formulas prefixed by a line feed", () => {
    const donor: DonorExplorerRow = {
      key: "document:13:100000001",
      documentType: "13",
      documentNumber: "\n=HYPERLINK(\"https://attacker.example\",\"click\")",
      name: "Ana",
      email: null,
      phone: null,
      department: "06",
      municipality: "23",
      district: "01",
      address: null,
      country: "SV",
      firstGiftAt: "2026-07-01T18:00:00.000Z",
      lastGiftAt: "2026-07-02T19:30:00.000Z",
      giftCount: 2,
      totalCents: 2500,
      preferredGiftType: "DIEZMO",
      source: "WOMPI"
    };

    expect(buildDonorExplorerCsv([donor])).toContain(
      `DUI,"'\n=HYPERLINK(""https://attacker.example"",""click"")",Ana`
    );
  });

  it("uses an environment-and-count filename that is safe for Content-Disposition", () => {
    expect(donorExplorerCsvFilename("00", 42)).toBe("donantes-00-42.csv");
  });
});
