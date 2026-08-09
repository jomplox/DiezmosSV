import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDteQrPayload, DTE_PDF_RENDERER_VERSION, renderDtePdf } from "../../src/worker/services/pdf";
import type { DteDocumentRecord } from "../../src/worker/types";
import { makeDocument } from "./fixtures";

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

  it("uppercases party values except emails and hides the internal establishment code", async () => {
    const record = testDocument();
    const plain = JSON.parse(record.plain_json) as Record<string, any>;
    plain.emisor.nombre = "Misión ExampleOrganization";
    plain.emisor.nombreComercial = "Misión ExampleOrganization";
    plain.emisor.descActividad = "Actividades de organizaciones religiosas";
    plain.emisor.direccion.complemento = "Avenida Ejemplo 100";
    plain.emisor.correo = "legacy-email-107@example.com";
    plain.emisor.codEstable = "0002";
    plain.receptor.nombre = "José Pérez";
    plain.receptor.descActividad = "Servicios profesionales";
    plain.receptor.tipoDocumento = "03";
    plain.receptor.numDocumento = "ab123456789";
    plain.receptor.direccion.complemento = "Colonia Escalón";
    plain.receptor.correo = "Donor.Mixed@Example.Org";
    record.plain_json = JSON.stringify(plain);
    const originalJson = record.plain_json;

    const text = await renderToText(record);

    expect(text).toContain("MISIÓN EXAMPLEORGANIZATION");
    expect(text).toContain("ACTIVIDADES DE ORGANIZACIONES RELIGIOSAS");
    expect(text).toContain("AVENIDA EJEMPLO 100");
    expect(text).toContain("JOSÉ PÉREZ");
    expect(text).toContain("SERVICIOS PROFESIONALES");
    expect(text).toContain("AB123456789");
    expect(text).toContain("COLONIA ESCALÓN");
    expect(text).toContain("SAN SALVADOR");
    expect(text).toContain("legacy-email-107@example.com");
    expect(text).toContain("Donor.Mixed@Example.Org");
    expect(text).not.toContain("Misión ExampleOrganization");
    expect(text).not.toContain("José Pérez");
    expect(text).not.toContain("ab123456789");
    expect(text).not.toContain("12345678-9");
    expect(text).not.toContain("LEGACY-EMAIL-107@EXAMPLE.COM");
    expect(text).not.toContain("DONOR.MIXED@EXAMPLE.ORG");
    expect(text).not.toContain("(0002)");
    expect(record.plain_json).toBe(originalJson);
  });

  it("versions the black currency renderer as PDF evidence v4", () => {
    expect(DTE_PDF_RENDERER_VERSION).toBe("cde-pdf:v4");
  });

  it("renders the currency code in black like the surrounding label", async () => {
    const pdf = await renderDtePdf(testDocument());
    const dir = mkdtempSync(join(tmpdir(), "diezmos-pdf-currency-"));
    const pdfPath = join(dir, "cde-currency.pdf");
    const ppmPrefix = join(dir, "cde-currency");
    writeFileSync(pdfPath, pdf);
    execFileSync("pdftoppm", ["-r", "72", "-singlefile", pdfPath, ppmPrefix]);
    const image = readPpm(`${ppmPrefix}.ppm`);
    const currencyCrop = { left: 460, right: 490, top: 88, bottom: 108 };

    expect(pixelCount(image, currencyCrop, (red, green, blue) => red - green > 18 && red - blue > 18)).toBe(0);
    expect(pixelCount(image, currencyCrop, (red, green, blue) => red < 100 && green < 100 && blue < 100)).toBeGreaterThan(8);
  });

  it("labels the receptor document by CAT-022 type and renders the full geographic address", async () => {
    const text = await renderToText(testDocument());

    expect(text).toMatch(/DUI:\s+10000002-7/);
    expect(text).not.toMatch(/NIT:\s+10000002-7/);
    // Receptor address: complemento + distrito/municipio/departamento NAMES (dept 06 / muni 23 / distrito 03).
    expect(text).toContain("AYUTUX");
    expect(text).toContain("AYUTUXTEPEQUE");
    expect(text).toContain("SAN SALVADOR CENTRO");
    expect(text).toContain("SAN SALVADOR");
  });

  it("renders the emisor geographic address labels", async () => {
    const text = await renderToText(testDocument());

    // Emisor dir: dept 06 / muni 22 / distrito 01.
    expect(text).toContain("AGUILARES");
    expect(text).toContain("SAN SALVADOR ESTE");
  });

  it("wraps a long emisor address instead of overflowing into the receptor box", async () => {
    const text = await renderToText(testDocument());
    const lines = text.split("\n");

    // The emisor address (complemento + AGUILARES, SAN SALVADOR ESTE, SAN SALVADOR + phone)
    // is far too wide for the 294pt box, so it must wrap onto multiple rendered lines: the head
    // ("SOYAPANGO.") and the tail ("SAN SALVADOR ESTE") land on DIFFERENT extracted lines.
    const head = lines.findIndex((line) => line.includes("SOYAPANGO."));
    const tail = lines.findIndex((line) => line.includes("SAN SALVADOR ESTE"));
    expect(head).toBeGreaterThanOrEqual(0);
    expect(tail).toBeGreaterThanOrEqual(0);
    expect(tail).not.toBe(head);
    // Wrapping must preserve the geographic segment intact (not split "SAN SALVADOR" mid-phrase).
    expect(text).toContain("SAN SALVADOR ESTE");

    // Overlap symptom (the live bug): the entire emisor address rendered as ONE over-wide line
    // — complemento + every geographic segment + the emisor phone — that ran straight through the
    // emisor box's right edge into the receptor column. Assert that single-line pattern (head
    // "SOYAPANGO." AND tail "SAN SALVADOR ESTE" AND emisor phone "7000-0004" together) is gone.
    // (pdftotext -layout legitimately places the emisor and receptor columns on the same y, so
    // co-occurrence of the two columns on one extracted line is NOT the symptom — the symptom is
    // the whole address collapsed onto a single over-wide emisor line.)
    const overrun = lines.filter(
      (line) => line.includes("SOYAPANGO.") && line.includes("SAN SALVADOR ESTE") && line.includes("7000-0004")
    );
    expect(overrun).toEqual([]);
  });

  it("keeps the emisor correo visible even when the wrapped address takes two lines", async () => {
    // The emisor box clamps at 3 rendered lines. With the real church address the
    // wrapped address needs two of them, so the correo must ride on the (short)
    // establishment line instead of occupying a fourth line that would be clamped.
    const text = await renderToText(testDocument());
    expect(text).toContain("legacy-contact-4@example.com");
  });

  it("keeps short addresses on a single unwrapped line", async () => {
    const document = withReceptor(testDocument(), {
      direccion: { departamento: "06", municipio: "23", distrito: "03", complemento: "Col 1" },
      telefono: null,
      correo: null
    });
    const text = await renderToText(document);
    const lines = text.split("\n");

    // A short receptor address fits in one line: complemento + geography all together.
    const receptorLine = lines.filter(
      (line) => line.includes("COL 1") && line.includes("AYUTUXTEPEQUE") && line.includes("SAN SALVADOR")
    );
    expect(receptorLine.length).toBeGreaterThan(0);
  });

  it("renders a foreign receptor address as complemento + CAT-020 country, without the 00-code labels", async () => {
    const document = withReceptor(testDocument(), {
      direccion: { departamento: "00", municipio: "00", distrito: "00", complemento: "742 Evergreen Tce" },
      codPais: "US",
      codDomiciliado: 2
    });

    const text = await renderToText(document);

    // The donor's foreign address plus their CAT-020 country label...
    expect(text).toContain("742 EVERGREEN TCE");
    expect(text).toContain("ESTADOS UNIDOS");
    // ...and never the "Otro (Para extranjeros)" placeholder printed three times
    // (the 00 code's label in CAT-008/012/013).
    expect(text).not.toContain("OTRO (PARA EXTRANJEROS)");
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

function pixelCount(
  image: { width: number; height: number; pixels: Buffer },
  crop: { left: number; right: number; top: number; bottom: number },
  matches: (red: number, green: number, blue: number) => boolean
): number {
  let count = 0;
  for (let y = crop.top; y < Math.min(crop.bottom, image.height); y += 1) {
    for (let x = crop.left; x < Math.min(crop.right, image.width); x += 1) {
      const index = (y * image.width + x) * 3;
      if (matches(image.pixels[index], image.pixels[index + 1], image.pixels[index + 2])) {
        count += 1;
      }
    }
  }
  return count;
}

describe("renderDtePdf unicode sanitization", () => {
  it("replaces unsupported Unicode from donor-controlled fields instead of throwing", async () => {
    // Wompi passes donor-typed strings straight through; WinAnsi StandardFonts throw
    // on emoji/CJK, which killed the receipt email. Unsupported chars become "?".
    const record = testDocument();
    const plain = JSON.parse(record.plain_json) as Record<string, any>;
    plain.receptor.nombre = "Jose 🙏 Vega";
    plain.receptor.direccion = { departamento: "06", municipio: "23", distrito: "03", complemento: "Casa 🏠 azul 你好" };
    plain.cuerpoDocumento[0].descripcion = "Diezmo 🙏 familiar";
    record.plain_json = JSON.stringify(plain);

    const pdf = await renderDtePdf(record);
    const dir = mkdtempSync(join(tmpdir(), "diezmos-pdf-unicode-"));
    const pdfPath = join(dir, "doc.pdf");
    const txtPath = join(dir, "doc.txt");
    writeFileSync(pdfPath, pdf);
    execFileSync("pdftotext", ["-layout", pdfPath, txtPath]);
    const text = readFileSync(txtPath, "utf8");
    expect(text).toContain("JOSE ? VEGA");
    expect(text).toContain("CASA ? AZUL ??");
  });
});

describe("renderDtePdf foreign receptor", () => {
  it("prints the país and the apéndice foreign address when direccion is null, without label overlap", async () => {
    const record = testDocument();
    const plain = JSON.parse(record.plain_json) as Record<string, any>;
    plain.receptor.direccion = null;
    plain.receptor.codPais = "AI";
    plain.receptor.codDomiciliado = 2;
    plain.receptor.tipoDocumento = "37";
    plain.receptor.numDocumento = "29092948";
    plain.apendice = [
      ...(plain.apendice ?? []),
      { campo: "DireccionExtranjera", etiqueta: "Dirección en el extranjero", valor: "Anguila: 742 Evergreen Terrace" }
    ];
    record.plain_json = JSON.stringify(plain);

    const pdf = await renderDtePdf(record);
    const dir = mkdtempSync(join(tmpdir(), "diezmos-pdf-foreign-"));
    const pdfPath = join(dir, "doc.pdf");
    const txtPath = join(dir, "doc.txt");
    writeFileSync(pdfPath, pdf);
    execFileSync("pdftotext", ["-layout", pdfPath, txtPath]);
    const text = readFileSync(txtPath, "utf8");

    // The receptor box shows the donor's real country + typed address (from the apéndice).
    expect(text).toContain("ANGUILA: 742 EVERGREEN TERRACE");
    // No overlap: with the fixed label width, "Documento:" and its number extract as
    // intact tokens instead of interleaved characters (the reported glitch).
    expect(text).toContain("Documento:");
    expect(text).toContain("29092948");
    expect(text).not.toMatch(/Documen[0-9]/);
  });
});

function testDocument(): DteDocumentRecord {
  return makeDocument({
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
    sello_recibido: "20269A41C96A1C404F2D8CFA1E1FD32DD5BBBGEQ",
    post_accept_finalized_at: null
  });
}
