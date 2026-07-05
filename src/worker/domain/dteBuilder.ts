import type { Ambiente, DteDocumentRecord, EmisorConfig, WompiWebhook } from "../types";
import { mhDateTime } from "../utils/dates";
import { generationCode, numeroControl } from "../utils/ids";
import {
  isCat008DistrictCode,
  isCat012DepartmentCode,
  isCat013MunicipalityCode,
  isCat014UnitCode,
  isCat017PaymentFormCode,
  isCat019ActivityCode,
  isCat020CountryCode,
  isCat021AssociatedDocumentCode,
  isCat022DocumentTypeCode,
  isCat026DonationTypeCode,
  isCat032DomicileCode
} from "../../shared/catalogs";
import { assertValidDui, isDuiDocumentType } from "../../shared/dui";
import { validateCde, validateContingencia, validateInvalidacion } from "./schema";
import { amountCents, ambienteFromWompi, donorName } from "./wompi";

interface CdeBuildOptions {
  sequence: number;
  environment?: Ambiente;
  issuedAt?: Date;
  contingency?: boolean;
}

interface AdvancedCdeBuildOptions {
  sequence: number;
  environment?: Ambiente;
  issuedAt?: Date;
}

export interface DirectCdeInput {
  amount?: string | number;
  donorName?: string;
  donorEmail?: string;
  donorDocumentType?: string;
  donorDocument?: string;
  donorPhone?: string;
  donorAddress?: string;
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
  const ambiente = options.environment ?? ambienteFromWompi(payload);
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
      { campo: "Autorizacion", etiqueta: "Código de autorización", valor: payload.CodigoAutorizacion ?? "N/D" },
      { campo: "Aplicativo", etiqueta: "Aplicativo", valor: payload.Aplicativo?.Nombre ?? "Wompi" }
    ]
  };
  validateCdeDui(document);
  validateCdeCatalogs(document);
  validateCde(document);
  return document;
}

export function buildDirectCdeDocument(input: DirectCdeInput, config: EmisorConfig, options: AdvancedCdeBuildOptions): Record<string, unknown> {
  const issuedAt = options.issuedAt ?? new Date();
  const { date, time } = mhDateTime(issuedAt);
  const amount = centsToAmount(amountToCents(input.amount));
  const donorName = cleanNullable(input.donorName);
  const donorDocumentType = cleanNullable(input.donorDocumentType) ?? config.defaultReceptorTipoDocumento;
  const donorDocument = cleanNullable(input.donorDocument);
  if (!donorName) {
    throw new Error("Ingrese nombre del donante");
  }
  if (!donorDocument) {
    throw new Error("Ingrese documento del donante");
  }
  const ambiente = options.environment ?? "00";
  const address = cleanNullable(input.donorAddress);
  const document = {
    identificacion: {
      version: 2,
      ambiente,
      tipoDte: "15",
      numeroControl: numeroControl(config.controlPrefix, options.sequence),
      codigoGeneracion: generationCode(),
      tipoModelo: 1,
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
      tipoDocumento: donorDocumentType,
      numDocumento: donorDocument,
      nrc: null,
      nombre: donorName,
      codActividad: null,
      descActividad: null,
      direccion: address
        ? {
            departamento: config.direccion.departamento,
            municipio: config.direccion.municipio,
            distrito: config.direccion.distrito,
            complemento: address
          }
        : null,
      telefono: cleanNullable(input.donorPhone),
      correo: cleanNullable(input.donorEmail),
      codDomiciliado: 1,
      codPais: config.defaultCodPais
    },
    otrosDocumentos: [
      {
        codDocAsociado: 1,
        descDocumento: "Generación directa",
        detalleDocumento: "Donación offline"
      }
    ],
    cuerpoDocumento: [
      {
        numItem: 1,
        tipoDonacion: config.defaultDonationType,
        cantidad: 1,
        codigo: "DONACION",
        uniMedida: config.defaultUnidadMedida,
        descripcion: "Donación offline",
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
          referencia: "Donación offline"
        }
      ]
    },
    apendice: [
      { campo: "Origen", etiqueta: "Origen", valor: "DTE rápido" },
      { campo: "Canal", etiqueta: "Canal", valor: "Donación offline" }
    ]
  };
  validateCdeDui(document);
  validateCdeCatalogs(document);
  validateCde(document);
  return document;
}

export function buildAdvancedCdeDocument(draft: unknown, config: EmisorConfig, options: AdvancedCdeBuildOptions): Record<string, unknown> {
  if (!isRecord(draft)) {
    throw new Error("El borrador CDE avanzado debe ser un objeto JSON");
  }
  const document = cloneJsonObject(draft);
  const issuedAt = options.issuedAt ?? new Date();
  const { date, time } = mhDateTime(issuedAt);
  const currentIdentification = isRecord(document.identificacion) ? document.identificacion : {};
  const ambiente = options.environment ?? ambienteValue(currentIdentification.ambiente) ?? "00";
  document.identificacion = {
    ...currentIdentification,
    version: 2,
    ambiente,
    tipoDte: "15",
    numeroControl: numeroControl(config.controlPrefix, options.sequence),
    codigoGeneracion: generationCode(),
    tipoModelo: currentIdentification.tipoModelo === 2 ? 2 : 1,
    tipoOperacion: 1,
    fecEmi: date,
    horEmi: time,
    tipoMoneda: "USD"
  };
  validateCdeDui(document);
  validateCdeCatalogs(document);
  validateCde(document);
  return document;
}

export function cdeDocumentSummary(document: Record<string, unknown>): {
  environment: Ambiente;
  codigoGeneracion: string;
  numeroControl: string;
  donorEmail: string | null;
  donorName: string | null;
  amountCents: number;
} {
  const identificacion = isRecord(document.identificacion) ? document.identificacion : {};
  const receptor = isRecord(document.receptor) ? document.receptor : {};
  const resumen = isRecord(document.resumen) ? document.resumen : {};
  return {
    environment: ambienteValue(identificacion.ambiente) ?? "00",
    codigoGeneracion: stringValue(identificacion.codigoGeneracion, "codigoGeneracion"),
    numeroControl: stringValue(identificacion.numeroControl, "numeroControl"),
    donorEmail: cleanNullable(valueAsString(receptor.correo)),
    donorName: cleanNullable(valueAsString(receptor.nombre)),
    amountCents: amountToCents(resumen.valorTotal)
  };
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
      fecEmi: original.identificacion.fecEmi,
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

function validateCdeDui(document: Record<string, unknown>): void {
  const receptor = isRecord(document.receptor) ? document.receptor : {};
  if (isDuiDocumentType(receptor.tipoDocumento)) {
    assertValidDui(valueAsString(receptor.numDocumento));
  }
}

function validateCdeCatalogs(document: Record<string, unknown>): void {
  const receptor = isRecord(document.receptor) ? document.receptor : {};
  assertCatalogField("receptor.tipoDocumento", "CAT-022 Tipo de documento de identificación", receptor.tipoDocumento, isCat022DocumentTypeCode);
  assertOptionalCatalogField("receptor.codActividad", "CAT-019 Código de Actividad Económica", receptor.codActividad, isCat019ActivityCode);
  assertCatalogField("receptor.codDomiciliado", "CAT-032 Domicilio Fiscal", receptor.codDomiciliado, isCat032DomicileCode);
  assertCatalogField("receptor.codPais", "CAT-020 País", receptor.codPais, isCat020CountryCode);

  const direccion = isRecord(receptor.direccion) ? receptor.direccion : null;
  if (direccion) {
    assertCatalogField("receptor.direccion.departamento", "CAT-012 Departamento", direccion.departamento, isCat012DepartmentCode);
    assertCatalogField("receptor.direccion.municipio", "CAT-013 Municipio", direccion.municipio, isCat013MunicipalityCode);
    assertCatalogField("receptor.direccion.distrito", "CAT-008 Distrito", direccion.distrito, isCat008DistrictCode);
  }

  const item = firstArrayRecord(document.cuerpoDocumento);
  if (item) {
    assertCatalogField("cuerpoDocumento.tipoDonacion", "CAT-026 Tipo de Donación", item.tipoDonacion, isCat026DonationTypeCode);
    assertCatalogField("cuerpoDocumento.uniMedida", "CAT-014 Unidad de Medida", item.uniMedida, isCat014UnitCode);
  }

  const resumen = isRecord(document.resumen) ? document.resumen : {};
  const pago = firstArrayRecord(resumen.pagos);
  if (pago) {
    assertOptionalCatalogField("resumen.pagos.codigo", "CAT-017 Forma de Pago", pago.codigo, isCat017PaymentFormCode);
  }

  const otrosDocumento = firstArrayRecord(document.otrosDocumentos);
  if (otrosDocumento) {
    assertOptionalCatalogField("otrosDocumentos.codDocAsociado", "CAT-021 Documentos Asociados", otrosDocumento.codDocAsociado, isCat021AssociatedDocumentCode);
  }
}

function assertCatalogField(label: string, catalogName: string, value: unknown, isValid: (value: unknown) => boolean): void {
  if (!isValid(value)) {
    throw new Error(`CDE ${label} debe existir en el catálogo ${catalogName}: ${displayValue(value)}`);
  }
}

function assertOptionalCatalogField(label: string, catalogName: string, value: unknown, isValid: (value: unknown) => boolean): void {
  if (value == null || value === "") {
    return;
  }
  assertCatalogField(label, catalogName, value, isValid);
}

function firstArrayRecord(value: unknown): Record<string, unknown> | null {
  return Array.isArray(value) && isRecord(value[0]) ? value[0] : null;
}

function displayValue(value: unknown): string {
  return value == null ? "missing" : String(value);
}

function centsToAmount(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

function cleanNullable(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function cloneJsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ambienteValue(value: unknown): Ambiente | null {
  return value === "01" ? "01" : value === "00" ? "00" : null;
}

function valueAsString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Falta CDE ${label}`);
  }
  return value;
}

function amountToCents(value: unknown): number {
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("CDE resumen.valorTotal debe ser un número positivo");
  }
  return Math.round(amount * 100);
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
