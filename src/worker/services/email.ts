import { isMockMode } from "../config";
import type { DteDocumentRecord, Env } from "../types";
import { bytesToBase64 } from "../utils/encoding";
import { renderDtePdf } from "./pdf";

export class EmailService {
  constructor(private readonly env: Env) {}

  async sendReceipt(record: DteDocumentRecord, toEmail: string): Promise<unknown> {
    const pdf = await renderDtePdf(record);
    const subject = record.status === "CONTINGENCY_PENDING" ? "Comprobante DTE transitorio por donacion" : "Comprobante DTE por donacion";
    const from = this.env.EMAIL_FROM ?? "dte@example.org";
    const pdfAttachment = {
      filename: `${record.codigo_generacion}.pdf`,
      contentBase64: bytesToBase64(pdf),
      contentType: "application/pdf"
    };
    const jsonAttachment = {
      filename: `${record.codigo_generacion}.json`,
      contentBase64: bytesToBase64(new TextEncoder().encode(record.signed_jws ?? record.plain_json)),
      contentType: "application/json"
    };
    const payload = {
      from,
      to: toEmail,
      subject,
      text: `Adjuntamos su Comprobante de Donacion Electronico ${record.numero_control}.`,
      attachments: [
        {
          filename: pdfAttachment.filename,
          contentType: pdfAttachment.contentType,
          contentBase64: pdfAttachment.contentBase64
        },
        {
          filename: jsonAttachment.filename,
          contentType: jsonAttachment.contentType,
          contentBase64: jsonAttachment.contentBase64
        }
      ]
    };

    if (isMockMode(this.env)) {
      return { mock: true, toEmail, subject };
    }
    if (this.env.EMAIL) {
      const result = await this.env.EMAIL.send({
        from,
        to: toEmail,
        subject,
        text: payload.text,
        attachments: [
          {
            filename: pdfAttachment.filename,
            type: pdfAttachment.contentType,
            disposition: "attachment",
            content: pdfAttachment.contentBase64
          },
          {
            filename: jsonAttachment.filename,
            type: jsonAttachment.contentType,
            disposition: "attachment",
            content: jsonAttachment.contentBase64
          }
        ]
      });
      return { provider: "cloudflare-email", messageId: result.messageId };
    }
    throw new Error("Cloudflare EMAIL binding is required when mock mode is disabled");
  }
}
