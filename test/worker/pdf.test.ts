import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDteQrPayload, renderDtePdf } from "../../src/worker/services/pdf";
import type { DteDocumentRecord } from "../../src/worker/types";

describe("DTE PDF rendering", () => {
  it("uses the real comprobante de donacion fiscal layout", async () => {
    const pdf = await renderDtePdf(testDocument());
    const dir = mkdtempSync(join(tmpdir(), "diezmos-pdf-"));
    const pdfPath = join(dir, "cde.pdf");
    const txtPath = join(dir, "cde.txt");
    writeFileSync(pdfPath, pdf);

    execFileSync("pdftotext", ["-layout", pdfPath, txtPath]);
    const text = execFileSync("cat", [txtPath], { encoding: "utf8" });

    expect(text).toContain("DOCUMENTO TRIBUTARIO ELECTRÓNICO");
    expect(text).toContain("COMPROBANTE DE DONACIÓN");
    expect(text).toContain("Código de generación:");
    expect(text).toContain("TIPO DE MODELO:");
    expect(text).toContain("PREVIO / TIPO DTE: 15");
    expect(text).toContain("TIPO DE TRANSMISIÓN:");
    expect(text).toContain("EMISOR:");
    expect(text).toContain("RECEPTOR:");
    expect(text).toContain("CANTIDAD");
    expect(text).toContain("DESCRIPCIÓN");
    expect(text).toContain("VALOR");
    expect(text).toContain("Valor en Letras:");
    expect(text).toContain("CIEN DOLARES 00/100 CTVS.");
    expect(text).toContain("Total de la Donación");
  });

  it("draws the default logo as vector paths instead of an embedded raster image", async () => {
    const pdf = await renderDtePdf(testDocument());
    const pdfBody = Buffer.from(pdf).toString("latin1");

    expect(pdfBody).not.toContain("/Subtype /Image");
  });

  it("uses the MH public consultation QR URL with generation code and issue date", () => {
    const url = new URL(buildDteQrPayload(testDocument()));

    expect(url.href).toBe("https://admin.factura.gob.sv/consultaPublica?ambiente=00&codGen=6CAE5F7E-A590-4573-8EF2-FE48B14796C4&fechaEmi=2026-06-25");
    expect(url.searchParams.get("estado")).toBeNull();
    expect(url.searchParams.get("tipoDte")).toBeNull();
    expect(url.searchParams.get("codigoGeneracion")).toBeNull();
    expect(url.searchParams.get("sello")).toBeNull();
  });

  it("marks invalidated CDE PDFs and updates the QR payload", async () => {
    const invalidated = { ...testDocument(), status: "INVALIDATED" };
    const url = new URL(buildDteQrPayload(invalidated));
    expect(url.searchParams.get("estado")).toBe("INVALIDADO");

    const pdf = await renderDtePdf(invalidated);
    const dir = mkdtempSync(join(tmpdir(), "diezmos-pdf-invalidated-"));
    const pdfPath = join(dir, "cde-invalidated.pdf");
    const txtPath = join(dir, "cde-invalidated.txt");
    writeFileSync(pdfPath, pdf);

    execFileSync("pdftotext", ["-layout", pdfPath, txtPath]);
    const text = execFileSync("cat", [txtPath], { encoding: "utf8" });

    expect(text).toContain("INVALIDADO");
  });
});

function testDocument(): DteDocumentRecord {
  return {
    id: "doc_1",
    wompi_event_id: "wompi_1",
    tipo_dte: "15",
    environment: "00",
    codigo_generacion: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4",
    numero_control: "DTE-15-M001P004-000000000000009",
    status: "ACCEPTED",
    plain_json: JSON.stringify({
      identificacion: {
        version: 2,
        ambiente: "00",
        tipoDte: "15",
        numeroControl: "DTE-15-M001P004-000000000000009",
        codigoGeneracion: "6CAE5F7E-A590-4573-8EF2-FE48B14796C4",
        tipoModelo: 1,
        tipoOperacion: 1,
        fecEmi: "2026-06-25",
        horEmi: "19:46:40",
        tipoMoneda: "USD"
      },
      emisor: {
        tipoDocumento: "36",
        numDocumento: "10000003520015",
        nrc: "2400001",
        nombre: "MISIÓN EXAMPLEORGANIZATION",
        codActividad: "94910",
        descActividad: "ACTIVIDADES DE ORGANIZACIONES RELIGIOSAS",
        nombreComercial: "MISIÓN EXAMPLEORGANIZATION",
        direccion: {
          departamento: "06",
          municipio: "22",
          distrito: "01",
          complemento: "AVENIDA EJEMPLO 100,  COLONIA EJEMPLO #1 SOYAPANGO."
        },
        telefono: "7000-0004",
        correo: "legacy-contact-4@example.com",
        codEstable: "0002",
        codPuntoVenta: "0002"
      },
      receptor: {
        tipoDocumento: "13",
        numDocumento: "0123",
        nrc: null,
        nombre: "Example Person",
        codActividad: null,
        descActividad: null,
        direccion: {
          departamento: "06",
          municipio: "22",
          distrito: "01",
          complemento: "SAN SALVADOR"
        },
        telefono: "70000001",
        correo: "legacy-contact-2@example.com",
        codDomiciliado: 1,
        codPais: "SV"
      },
      cuerpoDocumento: [
        {
          numItem: 1,
          tipoDonacion: 2,
          cantidad: 1,
          codigo: "DTE-TEST",
          uniMedida: 99,
          descripcion: "DONACIÓN",
          tipoDepreciacion: 0,
          valorUni: 100,
          valor: 100
        }
      ],
      resumen: {
        valorTotal: 100,
        totalLetras: null,
        pagos: [{ codigo: "01", montoPago: 100, referencia: "STAGING" }]
      }
    }),
    signed_jws: null,
    sello_recibido: "20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGEQ",
    mh_estado: "PROCESADO",
    mh_observaciones_json: "[]",
    donor_email: "legacy-contact-2@example.com",
    donor_name: "Example Person",
    amount_cents: 10000,
    issued_at: "2026-06-26T01:46:47.015Z",
    accepted_at: "2026-06-26T01:46:48.000Z",
    contingency_period_id: null,
    created_at: "2026-06-26T01:46:47.015Z",
    updated_at: "2026-06-26T01:46:48.000Z"
  };
}
