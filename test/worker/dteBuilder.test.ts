import { describe, expect, it } from "vitest";
import wompiSample from "../../examples/wompi-webhook.sample.json";
import { buildAdvancedCdeDocument, buildCdeDocument, buildContingenciaEvent, buildDirectCdeDocument, buildInvalidacionEvent } from "../../src/worker/domain/dteBuilder";
import type { DteDocumentRecord, WompiWebhook } from "../../src/worker/types";
import { emisorConfig } from "./fixtures";

const FALLBACK_COMPLEMENTO = "No proporcionada por el donante";

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

  it("builds a CDE for real payment-link payloads without document or address", () => {
    const cliente: Record<string, unknown> = { ...wompiSample.Cliente };
    delete cliente.DocumentoIdentidad;
    delete cliente.Direccion;
    const document = buildCdeDocument({ ...wompiSample, Cliente: cliente } as WompiWebhook, emisorConfig, {
      sequence: 1,
      issuedAt: new Date("2026-06-02T14:05:20.742-06:00")
    }) as Record<string, any>;

    expect(document.receptor.tipoDocumento).toBe("37");
    expect(document.receptor.numDocumento).toBe("SIN-DOCUMENTO");
    expect(document.receptor.direccion).toEqual({
      departamento: emisorConfig.direccion.departamento,
      municipio: emisorConfig.direccion.municipio,
      distrito: emisorConfig.direccion.distrito,
      complemento: FALLBACK_COMPLEMENTO
    });
  });

  it("formats unhyphenated DUIs canonically in the CDE receptor", () => {
    const document = buildCdeDocument(
      { ...wompiSample, Cliente: { ...wompiSample.Cliente, DocumentoIdentidad: "100000027" } } as WompiWebhook,
      emisorConfig,
      {
        sequence: 1,
        issuedAt: new Date("2026-06-02T14:05:20.742-06:00")
      }
    ) as Record<string, any>;

    expect(document.receptor.tipoDocumento).toBe("13");
    expect(document.receptor.numDocumento).toBe("10000002-7");
  });

  it("classifies non-DUI donor documents as Otro (CAT-022 37)", () => {
    const document = buildCdeDocument(
      { ...wompiSample, Cliente: { ...wompiSample.Cliente, DocumentoIdentidad: "P-A123456" } } as WompiWebhook,
      emisorConfig,
      {
        sequence: 1,
        issuedAt: new Date("2026-06-02T14:05:20.742-06:00")
      }
    ) as Record<string, any>;

    expect(document.receptor.tipoDocumento).toBe("37");
    expect(document.receptor.numDocumento).toBe("P-A123456");
  });

  it("falls back to the emisor geography when the quick CDE has no donor address", () => {
    const document = buildDirectCdeDocument(
      { donorName: "Donante Directo", donorDocument: "SIN-DOCUMENTO", donorDocumentType: "37", amount: "5.00" },
      emisorConfig,
      { sequence: 3, environment: "00", issuedAt: new Date("2026-06-02T14:05:20.742-06:00") }
    ) as Record<string, any>;

    expect(document.receptor.direccion).toEqual({
      departamento: emisorConfig.direccion.departamento,
      municipio: emisorConfig.direccion.municipio,
      distrito: emisorConfig.direccion.distrito,
      complemento: FALLBACK_COMPLEMENTO
    });
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

  it("rejects advanced CDE catalog values outside their MH catalogs", () => {
    const draft = buildCdeDocument(
      { ...wompiSample, Cliente: { ...wompiSample.Cliente, DocumentoIdentidad: "00000000-0" } } as WompiWebhook,
      emisorConfig,
      {
        sequence: 1,
        issuedAt: new Date("2026-06-02T14:05:20.742-06:00")
      }
    ) as Record<string, any>;
    draft.receptor.direccion = {
      departamento: "06",
      municipio: "22",
      distrito: "01",
      complemento: "Direccion de prueba"
    };
    draft.receptor.tipoDocumento = "99";
    draft.receptor.codDomiciliado = 9;
    draft.cuerpoDocumento[0].tipoDonacion = 9;
    draft.cuerpoDocumento[0].uniMedida = 999;
    draft.resumen.pagos[0].codigo = "ZZ";
    draft.otrosDocumentos[0].codDocAsociado = 99;

    expect(() =>
      buildAdvancedCdeDocument(draft, emisorConfig, {
        sequence: 2,
        environment: "00",
        issuedAt: new Date("2026-06-02T14:05:20.742-06:00")
      })
    ).toThrow(/catálogo/i);
  });

  it("uses the intent donorOverride for the receptor with real donor-chosen catalog codes", () => {
    const document = buildCdeDocument(
      { ...wompiSample, Cliente: { ...wompiSample.Cliente, DocumentoIdentidad: undefined, Direccion: undefined } } as WompiWebhook,
      emisorConfig,
      {
        sequence: 1,
        issuedAt: new Date("2026-06-02T14:05:20.742-06:00"),
        donorOverride: {
          tipoDocumento: "13",
          numDocumento: "10000002-7",
          nombre: "Ana Donante",
          correo: "ana@example.org",
          telefono: "70001111",
          direccion: {
            departamento: "05",
            municipio: "24",
            distrito: "01",
            complemento: "Calle Donante 123, Antiguo Cuscatlán"
          }
        }
      }
    ) as Record<string, any>;

    expect(document.receptor.tipoDocumento).toBe("13");
    expect(document.receptor.numDocumento).toBe("10000002-7");
    expect(document.receptor.nombre).toBe("Ana Donante");
    expect(document.receptor.correo).toBe("ana@example.org");
    expect(document.receptor.telefono).toBe("70001111");
    // The whole payoff: the receptor address carries the donor's own catalog codes,
    // not the emisor's default geography.
    expect(document.receptor.direccion).toEqual({
      departamento: "05",
      municipio: "24",
      distrito: "01",
      complemento: "Calle Donante 123, Antiguo Cuscatlán"
    });
  });

  it("marks the receptor non-domiciled with the override país for foreign-donor intents", () => {
    const document = buildCdeDocument(wompiSample as WompiWebhook, emisorConfig, {
      sequence: 1,
      issuedAt: new Date("2026-06-02T14:05:20.742-06:00"),
      donorOverride: {
        tipoDocumento: "03",
        numDocumento: "AB-123456",
        nombre: "John Foreign",
        correo: "john@example.org",
        telefono: null,
        direccion: {
          departamento: "00",
          municipio: "00",
          distrito: "00",
          complemento: "742 Evergreen Terrace, Springfield"
        },
        codPais: "US",
        codDomiciliado: 2
      }
    }) as Record<string, any>;

    expect(document.receptor.codPais).toBe("US");
    expect(document.receptor.codDomiciliado).toBe(2);
    expect(document.receptor.direccion).toEqual({
      departamento: "00",
      municipio: "00",
      distrito: "00",
      complemento: "742 Evergreen Terrace, Springfield"
    });
  });

  it("keeps the payload-derived codPais/codDomiciliado when the override carries none", () => {
    const document = buildCdeDocument(wompiSample as WompiWebhook, emisorConfig, {
      sequence: 1,
      issuedAt: new Date("2026-06-02T14:05:20.742-06:00"),
      donorOverride: {
        tipoDocumento: "13",
        numDocumento: "10000002-7",
        nombre: "Ana Donante",
        correo: "ana@example.org",
        telefono: null,
        direccion: { departamento: "05", municipio: "24", distrito: "01", complemento: "Calle Donante 123" }
      }
    }) as Record<string, any>;

    // A domestic intent (no donor_pais) leaves the existing payload-based
    // codPais/codDomiciliado behavior untouched.
    expect(document.receptor.codPais).toBe("SV");
    expect(document.receptor.codDomiciliado).toBe(1);
  });

  it("still validates a DUI donorOverride before building a CDE for MH", () => {
    expect(() =>
      buildCdeDocument(wompiSample as WompiWebhook, emisorConfig, {
        sequence: 1,
        issuedAt: new Date("2026-06-02T14:05:20.742-06:00"),
        donorOverride: {
          tipoDocumento: "13",
          numDocumento: "00000000-9",
          nombre: "Ana Donante",
          correo: "ana@example.org",
          telefono: null,
          direccion: { departamento: "05", municipio: "24", distrito: "01", complemento: "Calle Donante 123" }
        }
      })
    ).toThrow(/DUI.*digito verificador/i);
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
    }) as Record<string, any>;
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
      new Date("2026-06-03T15:05:20.742-06:00")
    ) as Record<string, any>;

    expect(event.emisor.codEstableMH).toBe("M001");
    expect(event.emisor.codPuntoVentaMH).toBe("P004");
    expect(event.identificacion.fecEmi).toBe(original.identificacion.fecEmi);
    expect(event.documento.fecEmi).toBe(original.identificacion.fecEmi);
  });
});
