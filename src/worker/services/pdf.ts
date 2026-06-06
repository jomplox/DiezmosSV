import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import QRCode from "qrcode";
import type { DteDocumentRecord } from "../types";

export async function renderDtePdf(record: DteDocumentRecord): Promise<Uint8Array> {
  const document = JSON.parse(record.plain_json) as {
    emisor: { nombre: string };
    receptor: { nombre: string; correo: string | null };
    resumen: { valorTotal: number };
    identificacion: { fecEmi: string; horEmi: string };
  };
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const charcoal = rgb(0.12, 0.16, 0.18);
  const teal = rgb(0.0, 0.45, 0.43);

  page.drawText("Comprobante de Donacion Electronico", { x: 54, y: 720, size: 20, font: bold, color: charcoal });
  page.drawText(document.emisor.nombre, { x: 54, y: 694, size: 12, font: regular, color: teal });
  page.drawText(`Codigo de generacion: ${record.codigo_generacion}`, { x: 54, y: 650, size: 10, font: regular, color: charcoal });
  page.drawText(`Numero de control: ${record.numero_control}`, { x: 54, y: 632, size: 10, font: regular, color: charcoal });
  page.drawText(`Sello de recepcion: ${record.sello_recibido ?? "TRANSITORIO"}`, { x: 54, y: 614, size: 10, font: regular, color: charcoal });
  page.drawText(`Donante: ${document.receptor.nombre}`, { x: 54, y: 574, size: 12, font: bold, color: charcoal });
  page.drawText(`Correo: ${document.receptor.correo ?? "N/D"}`, { x: 54, y: 554, size: 10, font: regular, color: charcoal });
  page.drawText(`Monto: $${document.resumen.valorTotal.toFixed(2)}`, { x: 54, y: 526, size: 14, font: bold, color: teal });
  page.drawText(`Emision: ${document.identificacion.fecEmi} ${document.identificacion.horEmi}`, { x: 54, y: 506, size: 10, font: regular, color: charcoal });

  drawQr(page, buildQrPayload(record), 412, 592, 112);
  page.drawText("Escanee para consultar el comprobante", { x: 390, y: 574, size: 8, font: regular, color: charcoal });

  page.drawLine({ start: { x: 54, y: 474 }, end: { x: 558, y: 474 }, thickness: 1, color: rgb(0.86, 0.88, 0.9) });
  page.drawText("Este documento fue generado automaticamente a partir de una donacion Wompi aprobada.", {
    x: 54,
    y: 446,
    size: 9,
    font: regular,
    color: charcoal
  });
  page.drawText("Conserve el JSON firmado y esta representacion grafica para sus registros.", {
    x: 54,
    y: 430,
    size: 9,
    font: regular,
    color: charcoal
  });

  return pdf.save();
}

function drawQr(page: PDFPageLike, text: string, x: number, y: number, size: number): void {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" }) as unknown as { modules: { size: number; data: Uint8Array } };
  const moduleSize = size / qr.modules.size;
  qr.modules.data.forEach((enabled, index) => {
    if (enabled === 0) {
      return;
    }
    const row = Math.floor(index / qr.modules.size);
    const col = index % qr.modules.size;
    page.drawRectangle({
      x: x + col * moduleSize,
      y: y + size - (row + 1) * moduleSize,
      width: moduleSize,
      height: moduleSize,
      color: rgb(0.08, 0.12, 0.14)
    });
  });
}

function buildQrPayload(record: DteDocumentRecord): string {
  const params = new URLSearchParams({
    ambiente: record.environment,
    tipoDte: record.tipo_dte,
    codigoGeneracion: record.codigo_generacion,
    sello: record.sello_recibido ?? "TRANSITORIO"
  });
  return `https://admin.factura.gob.sv/consultaPublica?${params.toString()}`;
}

interface PDFPageLike {
  drawRectangle(options: { x: number; y: number; width: number; height: number; color: ReturnType<typeof rgb> }): void;
}
