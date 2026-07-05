import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  it("labels the receptor document by CAT-022 type and renders the full geographic address", async () => {
    const text = await renderToText(testDocument());

    expect(text).toMatch(/DUI:\s+10000002-7/);
    expect(text).not.toMatch(/NIT:\s+10000002-7/);
    // Receptor address: complemento + distrito/municipio/departamento NAMES (dept 06 / muni 23 / distrito 03).
    expect(text).toContain("Ayutux");
    expect(text).toContain("AYUTUXTEPEQUE");
    expect(text).toContain("SAN SALVADOR CENTRO");
    expect(text).toContain("San Salvador");
  });

  it("renders the emisor geographic address labels", async () => {
    const text = await renderToText(testDocument());

    // Emisor dir: dept 06 / muni 22 / distrito 01.
    expect(text).toContain("AGUILARES");
    expect(text).toContain("SAN SALVADOR ESTE");
  });

  it("labels a NIT receptor with the NIT: prefix", async () => {
    const document = withReceptor(testDocument(), {
      tipoDocumento: "36",
      numDocumento: "06142803901121"
    });

    const text = await renderToText(document);

    // 14-digit NIT is hyphenated by formatDocument and follows the NIT: label.
    expect(text).toMatch(/NIT:\s+0614-280390-112-1/);
    expect(text).not.toMatch(/DUI:\s+0614-280390-112-1/);
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
    writeFileSync(pdfPath, pdf);

    const ppmPrefix = join(dir, "cde-invalidated");
    execFileSync("pdftoppm", ["-r", "72", "-singlefile", pdfPath, ppmPrefix]);
    const watermarkBounds = redPixelBounds(readPpm(`${ppmPrefix}.ppm`), {
      top: 230,
      bottom: 650
    });

    expect(watermarkBounds.count).toBeGreaterThan(900);
    expect(watermarkBounds.width).toBeGreaterThan(360);
    expect(watermarkBounds.height).toBeGreaterThan(220);
  });
});

async function renderToText(record: DteDocumentRecord): Promise<string> {
  const pdf = await renderDtePdf(record);
  const dir = mkdtempSync(join(tmpdir(), "diezmos-pdf-text-"));
  const pdfPath = join(dir, "cde.pdf");
  const txtPath = join(dir, "cde.txt");
  writeFileSync(pdfPath, pdf);
  execFileSync("pdftotext", ["-layout", pdfPath, txtPath]);
  return readFileSync(txtPath, "utf8");
}

function withReceptor(record: DteDocumentRecord, receptor: Record<string, unknown>): DteDocumentRecord {
  const document = JSON.parse(record.plain_json) as { receptor?: Record<string, unknown> };
  document.receptor = { ...document.receptor, ...receptor };
  return { ...record, plain_json: JSON.stringify(document) };
}

function readPpm(path: string): { width: number; height: number; pixels: Buffer } {
  const bytes = readFileSync(path);
  let offset = 0;
  const isWhitespace = (byte: number) => byte === 9 || byte === 10 || byte === 13 || byte === 32;
  const skipWhitespaceAndComments = () => {
    while (offset < bytes.length) {
      if (isWhitespace(bytes[offset])) {
        offset += 1;
        continue;
      }
      if (bytes[offset] === 35) {
        while (offset < bytes.length && bytes[offset] !== 10) offset += 1;
        continue;
      }
      break;
    }
  };
  const nextToken = () => {
    skipWhitespaceAndComments();
    const start = offset;
    while (offset < bytes.length && !isWhitespace(bytes[offset])) offset += 1;
    return bytes.subarray(start, offset).toString("ascii");
  };

  expect(nextToken()).toBe("P6");
  const width = Number(nextToken());
  const height = Number(nextToken());
  expect(Number(nextToken())).toBe(255);
  skipWhitespaceAndComments();
  return { width, height, pixels: bytes.subarray(offset) };
}

function redPixelBounds(
  image: { width: number; height: number; pixels: Buffer },
  crop: { top: number; bottom: number }
): { count: number; width: number; height: number } {
  let minX = image.width;
  let maxX = -1;
  let minY = image.height;
  let maxY = -1;
  let count = 0;
  for (let y = crop.top; y < Math.min(crop.bottom, image.height); y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const index = (y * image.width + x) * 3;
      const red = image.pixels[index];
      const green = image.pixels[index + 1];
      const blue = image.pixels[index + 2];
      if (red > 210 && green < 235 && blue < 235 && red - green > 18 && red - blue > 18) {
        count += 1;
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  return {
    count,
    width: maxX >= minX ? maxX - minX + 1 : 0,
    height: maxY >= minY ? maxY - minY + 1 : 0
  };
}

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
        numDocumento: "10000002-7",
        nrc: null,
        nombre: "Example Person",
        codActividad: null,
        descActividad: null,
        direccion: {
          departamento: "06",
          municipio: "23",
          distrito: "03",
          complemento: "Ayutux"
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
