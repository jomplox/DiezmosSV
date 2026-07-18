import { describe, expect, it } from "vitest";
import wompiSample from "../../examples/wompi-webhook.sample.json";
import {
  FiscalCorrectionValidationError,
  fiscalCorrectionChangedFields,
  fiscalCorrectionPayload,
  validateFiscalReceptorCorrection,
  type FiscalReceptorCorrection
} from "../../src/shared/fiscalCorrection";
import { buildDirectCdeDocument } from "../../src/worker/domain/dteBuilder";
import {
  buildCorrectedDirectCandidate,
  buildCorrectedWompiCandidate,
  effectiveDocumentCorrectionData,
  effectiveWompiCorrectionData
} from "../../src/worker/services/fiscalCorrection";
import type { Repository } from "../../src/worker/storage/repository";
import type {
  DonationIntentRecord,
  DteDocumentRecord,
  WompiEventRecord,
  WompiWebhook
} from "../../src/worker/types";
import { emisorConfig } from "./fixtures";

const valid = () => ({
  tipoDocumento: "13",
  numDocumento: "100000027",
  nrc: "",
  nombre: " Ana Donante ",
  codActividad: "",
  descActividad: "",
  correo: " ANA@Example.org ",
  telefono: " 70001111 ",
  codDomiciliado: 1,
  codPais: "sv",
  departamento: "06",
  municipio: "22",
  distrito: "01",
  complemento: " Colonia Centro "
});

function validCorrection(
  overrides: Partial<FiscalReceptorCorrection> = {}
): FiscalReceptorCorrection {
  return validateFiscalReceptorCorrection({ ...valid(), ...overrides });
}

function rejectedDirectDocument(): DteDocumentRecord {
  const plain = buildDirectCdeDocument(
    {
      amount: "25.00",
      donorName: "Donante Original",
      donorEmail: "original@example.org",
      donorDocumentType: "13",
      donorDocument: "10000002-7",
      donorPhone: "70001111",
      donorAddress: "Colonia Original"
    },
    emisorConfig,
    {
      sequence: 7,
      environment: "00",
      issuedAt: new Date("2026-07-17T10:30:00-06:00")
    }
  );
  const identificacion = plain.identificacion as Record<string, string>;
  return {
    id: "dte_rejected_direct",
    wompi_event_id: null,
    tipo_dte: "15",
    environment: "00",
    codigo_generacion: identificacion.codigoGeneracion,
    numero_control: identificacion.numeroControl,
    status: "REJECTED",
    plain_json: JSON.stringify(plain),
    signed_jws: "original.signed.jws",
    sello_recibido: null,
    mh_estado: "RECHAZADO",
    mh_observaciones_json: JSON.stringify(["Documento del receptor inválido"]),
    donor_email: "original@example.org",
    donor_name: "Donante Original",
    amount_cents: 2500,
    issued_at: "2026-07-17T16:30:00.000Z",
    accepted_at: null,
    contingency_period_id: null,
    transmission_deferred_at: null,
    transmission_claim_id: null,
    created_at: "2026-07-17T16:30:00.000Z",
    updated_at: "2026-07-17T16:35:00.000Z"
  };
}

function donationIntent(overrides: Partial<DonationIntentRecord> = {}): DonationIntentRecord {
  return {
    id: "intent_correction",
    status: "LINK_CREATED",
    amount_cents: 1000,
    donor_name: null,
    donor_document_type: "13",
    donor_document: "10000002-7",
    donor_email: null,
    donor_phone: "70001111",
    direccion_departamento: "06",
    direccion_municipio: "22",
    direccion_distrito: "01",
    direccion_complemento: "Dirección original",
    donor_pais: null,
    gift_type: "OFRENDA",
    wompi_id_enlace: 123,
    wompi_url_enlace: null,
    wompi_url_enlace_largo: null,
    document_id: null,
    client_ip: null,
    datos_token_hash: null,
    rate_limit_claim_id: null,
    paid_at: "2026-07-17T16:25:00.000Z",
    created_at: "2026-07-17T16:20:00.000Z",
    updated_at: "2026-07-17T16:25:00.000Z",
    expires_at: "2026-07-17T17:20:00.000Z",
    ...overrides
  };
}

describe("fiscal receptor correction", () => {
  it("canonicalizes a valid domestic correction", () => {
    expect(validateFiscalReceptorCorrection(valid())).toEqual({
      tipoDocumento: "13",
      numDocumento: "10000002-7",
      nrc: null,
      nombre: "Ana Donante",
      codActividad: null,
      descActividad: null,
      correo: "ana@example.org",
      telefono: "70001111",
      codDomiciliado: 1,
      codPais: "SV",
      departamento: "06",
      municipio: "22",
      distrito: "01",
      complemento: "Colonia Centro"
    });
  });

  it("rejects an invalid DUI before any fiscal work", () => {
    expect(() => validateFiscalReceptorCorrection({
      ...valid(),
      numDocumento: "12345678-9"
    })).toThrowError(FiscalCorrectionValidationError);
  });

  it("accepts a foreign receptor without pretending 00 is an SV district", () => {
    expect(validateFiscalReceptorCorrection({
      ...valid(),
      tipoDocumento: "03",
      numDocumento: "P-A123456",
      codDomiciliado: 2,
      codPais: "GT",
      departamento: "00",
      municipio: "00",
      distrito: "00",
      complemento: "Zona 10, Ciudad de Guatemala"
    })).toMatchObject({
      codDomiciliado: 2,
      codPais: "GT",
      departamento: "00",
      municipio: "00",
      distrito: "00"
    });
  });

  it("returns sorted changed fields and a stable payload", () => {
    const before = validateFiscalReceptorCorrection(valid());
    const after = { ...before, correo: "new@example.org", nombre: "Nueva Donante" };
    expect(fiscalCorrectionChangedFields(before, after)).toEqual(["correo", "nombre"]);
    expect(fiscalCorrectionPayload(after)).toBe(fiscalCorrectionPayload({ ...after }));
  });
});

describe("fiscal correction candidates", () => {
  it("changes only receptor and system-generated identification in a direct correction", () => {
    const source = rejectedDirectDocument();
    const corrected = buildCorrectedDirectCandidate({
      sourceDocument: source,
      correction: validCorrection({ numDocumento: "10000002-7" }),
      config: emisorConfig,
      sequence: 42
    }) as Record<string, any>;
    const original = JSON.parse(source.plain_json) as Record<string, any>;

    expect(corrected.receptor.numDocumento).toBe("10000002-7");
    expect(corrected.emisor).toEqual(original.emisor);
    expect(corrected.cuerpoDocumento).toEqual(original.cuerpoDocumento);
    expect(corrected.resumen).toEqual(original.resumen);
    expect(corrected.otrosDocumentos).toEqual(original.otrosDocumentos);
    expect(corrected.identificacion.codigoGeneracion)
      .not.toBe(original.identificacion.codigoGeneracion);
    expect(corrected.identificacion.numeroControl)
      .toBe("DTE-15-00010001-000000000000042");
  });

  it("preserves protected source sections for a Wompi-backed rejected correction", () => {
    const source = {
      ...rejectedDirectDocument(),
      wompi_event_id: "wompi_rejected_source"
    };
    const durable = JSON.parse(source.plain_json) as Record<string, any>;
    durable.apendice.push({
      campo: "Protegido",
      etiqueta: "Evidencia original",
      valor: "No reconstruir"
    });
    source.plain_json = JSON.stringify(durable);
    const currentConfig = {
      ...emisorConfig,
      nombre: "Emisor configurado después del rechazo"
    };

    const corrected = buildCorrectedDirectCandidate({
      sourceDocument: source,
      correction: validCorrection({ nombre: "Receptor Corregido" }),
      config: currentConfig,
      sequence: 43
    }) as Record<string, any>;

    expect(corrected.receptor.nombre).toBe("Receptor Corregido");
    expect(corrected.emisor).toEqual(durable.emisor);
    expect(corrected.cuerpoDocumento).toEqual(durable.cuerpoDocumento);
    expect(corrected.resumen).toEqual(durable.resumen);
    expect(corrected.otrosDocumentos).toEqual(durable.otrosDocumentos);
    expect(corrected.apendice).toContainEqual({
      campo: "Protegido",
      etiqueta: "Evidencia original",
      valor: "No reconstruir"
    });
    expect(corrected.identificacion.codigoGeneracion)
      .not.toBe(durable.identificacion.codigoGeneracion);
    expect(corrected.identificacion.numeroControl)
      .not.toBe(durable.identificacion.numeroControl);
  });

  it("keeps Wompi amount, gift type, transaction, and authorization immutable", () => {
    const payload = {
      ...wompiSample,
      IdTransaccion: "transaction_original",
      CodigoAutorizacion: "authorization_original",
      Monto: "10.00"
    } as WompiWebhook;
    const corrected = buildCorrectedWompiCandidate({
      payload,
      intent: donationIntent(),
      correction: validCorrection({ nombre: "Receptor Corregido" }),
      config: emisorConfig,
      environment: "00",
      sequence: 11
    }) as Record<string, any>;

    expect(corrected.receptor.nombre).toBe("Receptor Corregido");
    expect(corrected.resumen.valorTotal).toBe(10);
    expect(corrected.resumen.pagos[0].referencia).toBe("authorization_original");
    expect(corrected.otrosDocumentos[0].detalleDocumento).toBe("transaction_original");
    expect(corrected.apendice).toContainEqual({
      campo: "TipoAportacion",
      etiqueta: "Tipo",
      valor: "Ofrenda"
    });
  });

  it("keeps a foreign address in the legal appendix with null receptor direccion", () => {
    const corrected = buildCorrectedWompiCandidate({
      payload: wompiSample as WompiWebhook,
      intent: donationIntent(),
      correction: validCorrection({
        tipoDocumento: "03",
        numDocumento: "P-A123456",
        codDomiciliado: 2,
        codPais: "GT",
        departamento: "00",
        municipio: "00",
        distrito: "00",
        complemento: "Zona 10, Ciudad de Guatemala"
      }),
      config: emisorConfig,
      environment: "00",
      sequence: 12
    }) as Record<string, any>;

    expect(corrected.receptor).toMatchObject({
      direccion: null,
      codDomiciliado: 2,
      codPais: "GT"
    });
    expect(corrected.apendice).toContainEqual({
      campo: "DireccionExtranjera",
      etiqueta: "Dirección en el extranjero",
      valor: "Guatemala: Zona 10, Ciudad de Guatemala"
    });
  });
});

describe("fiscal correction failure classification", () => {
  it.each([
    ["Campo #/receptor/numDocumento contiene un valor inválido", true],
    ["receptor.codActividad no existe en CAT-019", true],
    ["NIT del emisor inválido", false],
    ["Actividad del emisor inválida", false],
    ["Documento inválido", false],
    ["Dirección inválida", false]
  ])("classifies receptor-specific evidence only: %s", (reason, correctable) => {
    const data = effectiveDocumentCorrectionData({
      ...rejectedDirectDocument(),
      mh_observaciones_json: JSON.stringify([reason])
    });

    expect(data.correctable).toBe(correctable);
    expect(data.guidance).toBe(
      correctable
        ? null
        : "Revise Configuración y la evidencia técnica antes de volver a intentar."
    );
  });

  it("recognizes the structured local invalid-donor DUI code", async () => {
    const event = {
      id: "wompi_known_donor_code",
      transaction_id: "transaction_known_donor_code",
      environment: "00",
      result: "ExitosaAprobada",
      amount_cents: 1000,
      donor_email: "donante@example.org",
      donor_name: "Donante Demo",
      raw_body: JSON.stringify(wompiSample),
      headers_json: "{}",
      received_at: "2026-07-18T12:00:00.000Z",
      processed_at: "2026-07-18T12:01:00.000Z",
      created_document_id: null,
      issuance_status: "FAILED",
      control_prefix: null,
      control_sequence: null,
      reserved_numero_control: null,
      reserved_codigo_generacion: null,
      issuance_attempt_count: 1,
      issuance_attempt_id: null,
      issuance_error_code: "WOMPI_INVALID_DONOR_DUI",
      issuance_error_message: "La identidad suministrada no es válida.",
      issuance_last_attempt_at: "2026-07-18T12:01:00.000Z",
      issuance_failed_at: "2026-07-18T12:01:00.000Z",
      issuance_dead_lettered_at: null
    } satisfies WompiEventRecord;
    const repo = {
      getWompiEventById: async () => event
    } as unknown as Repository;

    await expect(
      effectiveWompiCorrectionData(repo, event.id)
    ).resolves.toMatchObject({
      correctable: true,
      guidance: null
    });
  });
});
