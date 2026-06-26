import type { Ambiente, DteDocumentRecord, EmisorConfig, WompiWebhook } from "../types";
import { mhDateTime } from "../utils/dates";
import { generationCode, numeroControl } from "../utils/ids";
import { validateCde, validateContingencia, validateInvalidacion } from "./schema";
import { amountCents, ambienteFromWompi, donorName } from "./wompi";

interface CdeBuildOptions {
  sequence: number;
  issuedAt?: Date;
  contingency?: boolean;
}

export interface InvalidationInput {
  tipoAnulacion: 1 | 2 | 3;
  motivoAnulacion: string;
  nombreResponsable: string;
  tipDocResponsable: string;
  numDocResponsable: string;
  nombreSolicita: string;
  tipDocSolicita: string;
  numDocSolicita: string;
  codigoGeneracionR?: string | null;
}

export interface ContingencyInput {
  ambiente: Ambiente;
  documents: Array<{ codigoGeneracion: string; tipoDoc: string }>;
  startedAt: Date;
  endedAt: Date;
  tipoContingencia: number;
  motivoContingencia: string | null;
}

export function buildCdeDocument(payload: WompiWebhook, config: EmisorConfig, options: CdeBuildOptions): Record<string, unknown> {
  const issuedAt = options.issuedAt ?? new Date(payload.FechaTransaccion);
  const { date, time } = mhDateTime(issuedAt);
  const amount = centsToAmount(amountCents(payload));
  const name = donorName(payload);
  const donorEmail = payload.Cliente?.EMail?.trim() || null;
  const donorPhone = cleanNullable(payload.Cliente?.Celular);
  const donorDocument = cleanNullable(payload.Cliente?.DocumentoIdentidad) ?? "SIN-DOCUMENTO";
  const ambiente = ambienteFromWompi(payload);
  const document = {
    identificacion: {
      version: 2,
      ambiente,
      tipoDte: "15",
      numeroControl: numeroControl(config.controlPrefix, options.sequence),
      codigoGeneracion: generationCode(),
      tipoModelo: options.contingency ? 2 : 1,
      tipoOperacion: 1,
      fecEmi: date,
      horEmi: time,
      tipoMoneda: "USD"
    },
    emisor: {
      tipoDocumento: config.tipoDocumento,
      numDocumento: config.numDocumento,
      nrc: config.nrc,
      nombre: config.nombre,
      codActividad: config.codActividad,
      descActividad: config.descActividad,
      nombreComercial: config.nombreComercial,
      direccion: config.direccion,
      telefono: config.telefono,
      correo: config.correo,
      codEstable: config.codEstable,
      codPuntoVenta: config.codPuntoVenta
    },
    receptor: {
      tipoDocumento: config.defaultReceptorTipoDocumento,
      numDocumento: donorDocument,
      nrc: null,
      nombre: name,
      codActividad: null,
      descActividad: null,
      direccion: donorAddress(payload, config),
      telefono: donorPhone,
      correo: donorEmail,
      codDomiciliado: payload.Cliente?.CodigoPais === "SV" || !payload.Cliente?.CodigoPais ? 1 : 2,
      codPais: payload.Cliente?.CodigoPais ?? config.defaultCodPais
    },
    otrosDocumentos: [
      {
        codDocAsociado: 1,
        descDocumento: "Referencia Wompi",
        detalleDocumento: payload.IdTransaccion
      }
    ],
    cuerpoDocumento: [
      {
        numItem: 1,
        tipoDonacion: config.defaultDonationType,
        cantidad: payload.Cantidad ?? 1,
        codigo: payload.IdExterno?.slice(0, 25) || "DONACION",
        uniMedida: config.defaultUnidadMedida,
        descripcion: payload.EnlacePago?.NombreProducto || "Diezmos y ofrendas",
        tipoDepreciacion: 0,
        valorUni: amount,
        valor: amount
      }
    ],
    resumen: {
      valorTotal: amount,
      totalLetras: null,
      pagos: [
        {
          codigo: config.paymentMethodCode,
          montoPago: amount,
          referencia: payload.CodigoAutorizacion ?? payload.IdTransaccion
        }
      ]
    },
    apendice: [
      { campo: "IdTransaccion", etiqueta: "Wompi", valor: payload.IdTransaccion },
      { campo: "Autorizacion", etiqueta: "Codigo autorizacion", valor: payload.CodigoAutorizacion ?? "N/D" },
      { campo: "Aplicativo", etiqueta: "Aplicativo", valor: payload.Aplicativo?.Nombre ?? "Wompi" }
    ]
  };
  validateCde(document);
  return document;
}

export function buildInvalidacionEvent(
  record: DteDocumentRecord,
  config: EmisorConfig,
  input: InvalidationInput,
  emittedAt: Date = new Date()
): Record<string, unknown> {
  const original = JSON.parse(record.plain_json) as CdeDocumentShape;
  const { date, time } = mhDateTime(emittedAt);
  const eventCodes = mhEventCodes(record.numero_control, config);
  const document = {
    identificacion: {
      version: 3,
      ambiente: record.environment,
      codigoGeneracion: generationCode(),
      fecEmi: date,
      horEmi: time,
      fusion: null
    },
    emisor: {
      nit: config.numDocumento,
      nombre: config.nombre,
      codEstableMH: eventCodes.codEstableMH,
      codEstable: config.codEstable,
      codPuntoVentaMH: eventCodes.codPuntoVentaMH,
      codPuntoVenta: config.codPuntoVenta,
      telefono: config.telefono,
      correo: config.correo
    },
    documento: {
      tipoDte: record.tipo_dte,
      codigoGeneracion: record.codigo_generacion,
      selloRecibido: record.sello_recibido,
      numeroControl: record.numero_control,
      fecEmi: original.identificacion.fecEmi,
      codigoGeneracionR: input.codigoGeneracionR ?? null,
      tipoDocumento: original.receptor.tipoDocumento,
      numDocumento: original.receptor.numDocumento,
      nombre: original.receptor.nombre,
      telefono: original.receptor.telefono,
      correo: original.receptor.correo
    },
    motivo: {
      tipoAnulacion: input.tipoAnulacion,
      motivoAnulacion: input.motivoAnulacion,
      nombreResponsable: input.nombreResponsable,
      tipDocResponsable: input.tipDocResponsable,
      numDocResponsable: input.numDocResponsable,
      nombreSolicita: input.nombreSolicita,
      tipDocSolicita: input.tipDocSolicita,
      numDocSolicita: input.numDocSolicita
    }
  };
  validateInvalidacion(document);
  return document;
}

export function buildContingenciaEvent(config: EmisorConfig, input: ContingencyInput, emittedAt: Date = new Date()): Record<string, unknown> {
  const emitted = mhDateTime(emittedAt);
  const start = mhDateTime(input.startedAt);
  const end = mhDateTime(input.endedAt);
  const eventCodes = mhEventCodes(null, config);
  const document = {
    identificacion: {
      version: 4,
      ambiente: input.ambiente,
      codigoGeneracion: generationCode(),
      fTransmision: emitted.date,
      hTransmision: emitted.time
    },
    emisor: {
      nit: config.numDocumento,
      nombre: config.nombre,
      nombreResponsable: config.responsable.nombre,
      tipoDocResponsable: config.responsable.tipoDocumento,
      numeroDocResponsable: config.responsable.numeroDocumento,
      tipoEstablecimiento: config.responsable.tipoEstablecimiento,
      codEstableMH: eventCodes.codEstableMH,
      codPuntoVentaMH: eventCodes.codPuntoVentaMH,
      telefono: config.telefono,
      correo: config.correo
    },
    detalleDTE: input.documents.map((document, index) => ({
      noItem: index + 1,
      tipoDoc: document.tipoDoc,
      codigoGeneracion: document.codigoGeneracion
    })),
    motivo: {
      fInicio: start.date,
      fFin: end.date,
      hInicio: start.time,
      hFin: end.time,
      tipoContingencia: input.tipoContingencia,
      motivoContingencia: input.motivoContingencia
    }
  };
  validateContingencia(document);
  return document;
}

function donorAddress(payload: WompiWebhook, config: EmisorConfig): EmisorConfig["direccion"] | null {
  const complement = cleanNullable(payload.Cliente?.Direccion);
  if (!complement) {
    return null;
  }
  return {
    departamento: config.direccion.departamento,
    municipio: config.direccion.municipio,
    distrito: config.direccion.distrito,
    complemento: complement
  };
}

function centsToAmount(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

function cleanNullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function mhEventCodes(numeroControl: string | null | undefined, config: EmisorConfig): { codEstableMH: string; codPuntoVentaMH: string } {
  const controlPrefix = numeroControl?.split("-")[2];
  return mhCodesFromControlPrefix(controlPrefix) ?? mhCodesFromControlPrefix(config.controlPrefix) ?? {
    codEstableMH: config.codEstableMH,
    codPuntoVentaMH: config.codPuntoVentaMH
  };
}

function mhCodesFromControlPrefix(prefix: string | null | undefined): { codEstableMH: string; codPuntoVentaMH: string } | null {
  const match = prefix?.match(/^([MBSP]\d{3})(P\d{3})$/);
  if (!match) {
    return null;
  }
  return {
    codEstableMH: match[1],
    codPuntoVentaMH: match[2]
  };
}

interface CdeDocumentShape {
  identificacion: {
    fecEmi: string;
  };
  receptor: {
    tipoDocumento: string | null;
    numDocumento: string | null;
    nombre: string | null;
    telefono: string | null;
    correo: string | null;
  };
}
