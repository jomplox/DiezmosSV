import type { Ambiente, DonationGiftType, DteDocumentRecord, EmisorConfig, WompiWebhook } from "../types";
import { mhDateTime } from "../utils/dates";
import { generationCode, numeroControl } from "../utils/ids";
import {
  isCat008DistrictCode,
  isCat012DepartmentCode,
  isCat013MunicipalityCode,
  isCat014UnitCode,
  isCat017PaymentFormCode,
  isCat019ActivityCode,
  CAT020_COUNTRIES,
  isCat020CountryCode,
  isCat021AssociatedDocumentCode,
  isCat022DocumentTypeCode,
  isCat026DonationTypeCode,
  isCat032DomicileCode
} from "../../shared/catalogs";
import { assertValidDui, cleanDui, formatDui, isDuiDocumentType } from "../../shared/dui";
import { validateCde, validateInvalidacion } from "./schema";
import { amountCents, ambienteFromWompi, donorName } from "./wompi";

// Receptor fields lifted from a correlated donation intent (donor-checkout). When
// present they replace the fallback receptor derived from the raw Wompi payload,
// so the CDE carries the donor's validated identity and real catalog-coded address
// instead of the emisor geography. The DUI/catalog/schema guards below still run.
export interface IntentDonorOverride {
  tipoDocumento: string;
  numDocumento: string;
  nombre: string;
  correo: string | null;
  telefono: string | null;
  direccion: {
    departamento: string;
    municipio: string;
    distrito: string;
    complemento: string;
  };
  // Foreign-donor path: set together when the intent carries a donor_pais (the
  // receptor is a non-domiciled resident of that CAT-020 country). When absent the
  // builder keeps its payload-derived codPais/codDomiciliado behavior.
  codPais?: string;
  codDomiciliado?: 1 | 2;
  // Diezmo vs Ofrenda: when the correlated intent carries a gift_type, an
  // informational "TipoAportacion" line is appended to the CDE apéndice. The legal
  // cuerpoDocumento.descripcion stays "DONACIÓN" regardless — the tipo is metadata.
  giftType?: DonationGiftType;
}

// The legal donation description, pinned to the church's real production convention
// (see examples/DTE-15-M001P004-000000000006702.json: uppercase, accented). Wompi
// payment links carry a free-form NombreProducto (e.g. "Testing") that must NEVER
// leak into the fiscal document — the descripcion is a constant, not donor input.
const CDE_DONATION_DESCRIPCION = "DONACIÓN";

// Donor-facing labels for the informational apéndice line, hard-coded from the enum
// so no raw client string ever reaches the CDE.
const GIFT_TYPE_APENDICE_LABEL: Record<DonationGiftType, string> = {
  DIEZMO: "Diezmo",
  OFRENDA: "Ofrenda"
};

interface CdeBuildOptions {
  sequence: number;
  environment?: Ambiente;
  issuedAt?: Date;
  donorOverride?: IntentDonorOverride;
}

interface AdvancedCdeBuildOptions {
  sequence: number;
  environment?: Ambiente;
  issuedAt?: Date;
}

interface DirectCdeBuildOptions extends AdvancedCdeBuildOptions {
  // Salta TODA la validación (presencia de donante, DUI, catálogos y esquema MH)
  // para producir borradores editables con receptor vacío. Solo puede usarse en
  // rutas de plantilla/vista previa; NUNCA en una ruta que firme o transmita.
  templatePreview?: boolean;
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

export function buildCdeDocument(payload: WompiWebhook, config: EmisorConfig, options: CdeBuildOptions): Record<string, unknown> {
  const issuedAt = options.issuedAt ?? new Date(payload.FechaTransaccion);
  const { date, time } = mhDateTime(issuedAt);
  const amount = centsToAmount(amountCents(payload));
  const name = donorName(payload);
  const donorEmail = payload.Cliente?.EMail?.trim() || null;
  const donorPhone = cleanNullable(payload.Cliente?.Celular);
  // Wompi payment links only carry a free-form DocumentoIdentidad (often none at
  // all): declare it as DUI ("13") solo when it has the 9 digits a DUI requires —
  // the check-digit guard still rejects typos — and as Otro (CAT-022 "37") in
  // every other case, so donations without documents remain emittable.
  const donorDocumentRaw = cleanNullable(payload.Cliente?.DocumentoIdentidad);
  const donorIsDui = donorDocumentRaw !== null && cleanDui(donorDocumentRaw).length === 9;
  const donorDocumentType = donorIsDui ? "13" : "37";
  const donorDocument = donorIsDui ? formatDui(donorDocumentRaw) : donorDocumentRaw ?? "SIN-DOCUMENTO";
  const override = options.donorOverride;
  const ambiente = options.environment ?? ambienteFromWompi(payload);
  const document = {
    identificacion: {
      version: 2,
      ambiente,
      tipoDte: "15",
      numeroControl: numeroControl(config.controlPrefix, options.sequence),
      codigoGeneracion: generationCode(),
      // Siempre modelo 1 (previo): el CDE no participa del evento de contingencia
      // (Anexo, campo 35), así que el modelo diferido (2) nunca aplica al tipo 15.
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
      tipoDocumento: override ? override.tipoDocumento : donorDocumentType,
      numDocumento: override ? override.numDocumento : donorDocument,
      nrc: null,
      nombre: override ? override.nombre : name,
      codActividad: null,
      descActividad: null,
      direccion: override ? intentReceptorDireccion(override.direccion, override.codPais, config) : donorAddress(payload, config),
      telefono: override ? override.telefono : donorPhone,
      correo: override ? override.correo : donorEmail,
      codDomiciliado: override?.codDomiciliado ?? (payload.Cliente?.CodigoPais === "SV" || !payload.Cliente?.CodigoPais ? 1 : 2),
      codPais: override?.codPais ?? payload.Cliente?.CodigoPais ?? config.defaultCodPais
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
        descripcion: CDE_DONATION_DESCRIPCION,
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
      { campo: "Aplicativo", etiqueta: "Aplicativo", valor: payload.Aplicativo?.Nombre ?? "Wompi" },
      // Informational "Tipo" line, present only when the correlated intent carries a
      // gift_type. The legal descripcion above stays "DONACIÓN"; this is metadata.
      ...(override?.giftType
        ? [{ campo: "TipoAportacion", etiqueta: "Tipo", valor: GIFT_TYPE_APENDICE_LABEL[override.giftType] }]
        : [])
    ]
  };
  validateCdeDui(document);
  validateCdeCatalogs(document);
  validateCde(document);
  return document;
}

export function buildDirectCdeDocument(input: DirectCdeInput, config: EmisorConfig, options: DirectCdeBuildOptions): Record<string, unknown> {
  const issuedAt = options.issuedAt ?? new Date();
  const { date, time } = mhDateTime(issuedAt);
  const amount = centsToAmount(amountToCents(input.amount));
  const donorName = cleanNullable(input.donorName);
  const donorDocumentType = cleanNullable(input.donorDocumentType) ?? config.defaultReceptorTipoDocumento;
  const donorDocument = cleanNullable(input.donorDocument);
  if (!donorName && !options.templatePreview) {
    throw new Error("Ingrese nombre del donante");
  }
  if (!donorDocument && !options.templatePreview) {
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
      numDocumento: donorDocument ?? "",
      nrc: null,
      nombre: donorName ?? "",
      codActividad: null,
      descActividad: null,
      direccion: {
        departamento: config.direccion.departamento,
        municipio: config.direccion.municipio,
        distrito: config.direccion.distrito,
        complemento: address ?? RECEPTOR_ADDRESS_FALLBACK
      },
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
        descripcion: CDE_DONATION_DESCRIPCION,
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
  if (!options.templatePreview) {
    validateCdeDui(document);
    validateCdeCatalogs(document);
    validateCde(document);
  }
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
    // Forzado a modelo 1: un borrador avanzado con tipoModelo 2 emitiría un CDE en
    // forma de contingencia, que la normativa excluye para el tipo 15.
    tipoModelo: 1,
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

// MH rejects receptor.direccion null bajo la Normativa de Cumplimiento
// (codigoMsg 096: "Campo #/receptor/direccion contiene un valor inválido"),
// so a donor without an address gets the emisor's geography with an explicit
// "not provided" complemento instead of null.
const RECEPTOR_ADDRESS_FALLBACK = "No proporcionada por el donante";

function donorAddress(payload: WompiWebhook, config: EmisorConfig): EmisorConfig["direccion"] {
  return {
    departamento: config.direccion.departamento,
    municipio: config.direccion.municipio,
    distrito: config.direccion.distrito,
    complemento: cleanNullable(payload.Cliente?.Direccion) ?? RECEPTOR_ADDRESS_FALLBACK
  };
}

// Normativa campos 47-49: el código 00 "Otro (Para extranjeros)" existe para
// departamento y municipio, pero CAT-008 NO define un distrito 00 y MH rechaza la
// direccion 00/00/00 completa bajo la Normativa de Cumplimiento (codigoMsg 096,
// verificado en ambiente 00 el 2026-07-06). El receptor extranjero ya queda marcado
// fiscalmente por codPais + codDomiciliado 2, así que su direccion viaja con la
// geografía del emisor — la misma convención que MH ya acepta para donantes sin
// dirección — y el complemento conserva el país y la dirección extranjera reales.
function intentReceptorDireccion(
  direccion: { departamento: string; municipio: string; distrito: string; complemento: string },
  codPais: string | undefined,
  config: EmisorConfig
): EmisorConfig["direccion"] {
  if (direccion.departamento !== "00") {
    return { ...direccion };
  }
  const country = CAT020_COUNTRIES.find((option) => option.code === codPais)?.label ?? codPais ?? "Extranjero";
  return {
    departamento: config.direccion.departamento,
    municipio: config.direccion.municipio,
    distrito: config.direccion.distrito,
    complemento: `${country}: ${direccion.complemento}`.slice(0, 200)
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
