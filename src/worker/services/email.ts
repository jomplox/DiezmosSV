import { isMockMode } from "../config";
import type { DteDocumentRecord, Env } from "../types";
import { bytesToBase64 } from "../utils/encoding";
import { renderDtePdf } from "./pdf";

export class EmailService {
  constructor(private readonly env: Env) {}

  async sendReceipt(record: DteDocumentRecord, toEmail: string): Promise<unknown> {
    const pdf = await renderDtePdf(record);
    const subject = record.status === "CONTINGENCY_PENDING" ? "Comprobante DTE transitorio por donacion" : "Comprobante DTE por donacion";
    const payload = {
      from: this.env.EMAIL_FROM ?? "dte@example.org",
      to: toEmail,
      subject,
      text: `Adjuntamos su Comprobante de Donacion Electronico ${record.numero_control}.`,
      attachments: [
        {
          filename: `${record.codigo_generacion}.pdf`,
          contentType: "application/pdf",
          contentBase64: bytesToBase64(pdf)
        },
        {
          filename: `${record.codigo_generacion}.json`,
          contentType: "application/json",
          contentBase64: bytesToBase64(new TextEncoder().encode(record.signed_jws ?? record.plain_json))
        }
      ]
    };

    if (isMockMode(this.env)) {
      return { mock: true, toEmail, subject };
    }
    if (!this.env.EMAIL_API_URL || !this.env.EMAIL_API_KEY) {
      throw new Error("EMAIL_API_URL and EMAIL_API_KEY are required when mock mode is disabled");
    }
    const response = await fetch(this.env.EMAIL_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.env.EMAIL_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(`Email provider failed: ${response.status} ${body}`);
    }
    return body ? JSON.parse(body) : { ok: true };
  }
}
