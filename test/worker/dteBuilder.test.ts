import { describe, expect, it } from "vitest";
import wompiSample from "../../examples/wompi-webhook.sample.json";
import { buildAdvancedCdeDocument, buildCdeDocument, buildContingenciaEvent, buildInvalidacionEvent } from "../../src/worker/domain/dteBuilder";
import type { DteDocumentRecord, WompiWebhook } from "../../src/worker/types";
import { emisorConfig } from "./fixtures";

describe("DTE builders", () => {
  it("builds a schema-valid CDE from the Wompi webhook sample", () => {
    const document = buildCdeDocument(wompiSample as WompiWebhook, emisorConfig, {
      sequence: 1,
      issuedAt: new Date("2026-06-02T14:05:20.742-06:00")
    }) as Record<string, any>;

    expect(document.identificacion.tipoDte).toBe("15");
    expect(document.identificacion.ambiente).toBe("00");
    expect(document.identificacion.numeroControl).toBe("DTE-15-00010001-000000000000001");
    expect(document.otrosDocumentos[0].codDocAsociado).toBe(1);
    expect(document.receptor.nombre).toBe("Donante Demo");
    expect(document.resumen.valorTotal).toBe(10);
  });

  it("accepts valid DUI check-digit vectors in CDE receptor data", () => {
    const document = buildCdeDocument(
      { ...wompiSample, Cliente: { ...wompiSample.Cliente, DocumentoIdentidad: "00000000-0" } } as WompiWebhook,
      emisorConfig,
      {
        sequence: 1,
        issuedAt: new Date("2026-06-02T14:05:20.742-06:00")
      }
    ) as Record<string, any>;

    expect(document.receptor.tipoDocumento).toBe("13");
    expect(document.receptor.numDocumento).toBe("00000000-0");
  });

  it("rejects invalid DUI check digits before building a CDE for MH", () => {
    expect(() =>
      buildCdeDocument(
        { ...wompiSample, Cliente: { ...wompiSample.Cliente, DocumentoIdentidad: "00000000-9" } } as WompiWebhook,
        emisorConfig,
        {
          sequence: 1,
          issuedAt: new Date("2026-06-02T14:05:20.742-06:00")
        }
      )
    ).toThrow(/DUI.*digito verificador/i);
  });

  it("rejects invalid DUI values in advanced CDE drafts", () => {
    const draft = buildCdeDocument(
      { ...wompiSample, Cliente: { ...wompiSample.Cliente, DocumentoIdentidad: "00016297-5" } } as WompiWebhook,
      emisorConfig,
      {
        sequence: 1,
        issuedAt: new Date("2026-06-02T14:05:20.742-06:00")
      }
    ) as Record<string, any>;
    draft.receptor.numDocumento = "00016297-6";

    expect(() =>
      buildAdvancedCdeDocument(draft, emisorConfig, {
        sequence: 2,
        environment: "00",
        issuedAt: new Date("2026-06-02T14:05:20.742-06:00")
      })
    ).toThrow(/DUI.*digito verificador/i);
  });

  it("rejects country codes outside CAT-020 before building a CDE for MH", () => {
    expect(() =>
      buildCdeDocument(
        { ...wompiSample, Cliente: { ...wompiSample.Cliente, DocumentoIdentidad: "00000000-0", CodigoPais: "ZZ" } } as WompiWebhook,
        emisorConfig,
        {
          sequence: 1,
          issuedAt: new Date("2026-06-02T14:05:20.742-06:00")
        }
      )
    ).toThrow(/CAT-020/i);
  });

  it("builds a schema-valid contingency event for queued CDEs", () => {
    const event = buildContingenciaEvent(emisorConfig, {
      ambiente: "00",
      documents: [{ tipoDoc: "15", codigoGeneracion: "11111111-1111-4111-8111-111111111111" }],
      startedAt: new Date("2026-06-02T10:00:00-06:00"),
      endedAt: new Date("2026-06-02T11:00:00-06:00"),
      tipoContingencia: 1,
      motivoContingencia: "MH no disponible"
    }) as Record<string, any>;

    expect(event.identificacion.version).toBe(4);
    expect(event.detalleDTE).toHaveLength(1);
  });

  it("uses MH control-number codes for invalidation event establishment fields", () => {
    const original = buildCdeDocument(wompiSample as WompiWebhook, emisorConfig, {
      sequence: 1,
      issuedAt: new Date("2026-06-02T14:05:20.742-06:00")
    });
    const record = {
      id: "dte_1",
      wompi_event_id: "wompi_1",
      tipo_dte: "15",
      environment: "00",
      codigo_generacion: "11111111-1111-4111-8111-111111111111",
      numero_control: "DTE-15-M001P004-000000000000001",
      status: "ACCEPTED",
      plain_json: JSON.stringify(original),
      signed_jws: "signed",
      sello_recibido: "S".repeat(40),
      mh_estado: "PROCESADO",
      mh_observaciones_json: "[]",
      donor_email: null,
      donor_name: null,
      amount_cents: 1000,
      issued_at: "2026-06-02T20:05:20.742Z",
      accepted_at: "2026-06-02T20:06:20.742Z",
      contingency_period_id: null,
      created_at: "2026-06-02T20:05:20.742Z",
      updated_at: "2026-06-02T20:06:20.742Z"
    } satisfies DteDocumentRecord;
    const event = buildInvalidacionEvent(
      record,
      { ...emisorConfig, codEstableMH: "0002", codPuntoVentaMH: "0002", controlPrefix: "00020002" },
      {
        tipoAnulacion: 2,
        motivoAnulacion: "Invalidacion de prueba",
        nombreResponsable: "Responsable Legal",
        tipDocResponsable: "13",
        numDocResponsable: "000000000",
        nombreSolicita: "Operador",
        tipDocSolicita: "13",
        numDocSolicita: "000000000"
      },
      new Date("2026-06-02T15:05:20.742-06:00")
    ) as Record<string, any>;

    expect(event.emisor.codEstableMH).toBe("M001");
    expect(event.emisor.codPuntoVentaMH).toBe("P004");
  });
});
