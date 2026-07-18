import {
  isCat008DistrictCode,
  isCat012DepartmentCode,
  isCat013MunicipalityCode,
  isCat019ActivityCode,
  isCat020CountryCode,
  isCat022DocumentTypeCode,
  isCat032DomicileCode,
  normalizeCat020CountryCode
} from "./catalogs";
import { formatDui, isDuiDocumentType, isValidDui } from "./dui";
import { formatNit, isValidNitFormat } from "./nit";

export interface FiscalReceptorCorrection {
  tipoDocumento: string;
  numDocumento: string;
  nrc: string | null;
  nombre: string;
  codActividad: string | null;
  descActividad: string | null;
  correo: string | null;
  telefono: string | null;
  codDomiciliado: 1 | 2;
  codPais: string;
  departamento: string;
  municipio: string;
  distrito: string;
  complemento: string;
}

export type FiscalCorrectionStatus =
  | "QUEUED"
  | "PROCESSING"
  | "ACCEPTED"
  | "REJECTED"
  | "FAILED"
  | "REVIEW_REQUIRED";

export class FiscalCorrectionValidationError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "FiscalCorrectionValidationError";
  }
}

const KEYS = [
  "tipoDocumento", "numDocumento", "nrc", "nombre", "codActividad",
  "descActividad", "correo", "telefono", "codDomiciliado", "codPais",
  "departamento", "municipio", "distrito", "complemento"
] as const;

export function validateFiscalReceptorCorrection(
  input: Record<string, unknown>
): FiscalReceptorCorrection {
  for (const key of Object.keys(input)) {
    if (!(KEYS as readonly string[]).includes(key)) {
      throw new FiscalCorrectionValidationError(
        "protected_field",
        `El campo ${key} no se puede corregir desde esta pantalla.`
      );
    }
  }
  return normalizeAndValidate(input);
}

export function fiscalCorrectionChangedFields(
  before: FiscalReceptorCorrection,
  after: FiscalReceptorCorrection
): Array<keyof FiscalReceptorCorrection> {
  return KEYS.filter((key) => before[key] !== after[key]).sort();
}

export function fiscalCorrectionPayload(value: FiscalReceptorCorrection): string {
  return JSON.stringify(Object.fromEntries(KEYS.map((key) => [key, value[key]])));
}

function normalizeAndValidate(input: Record<string, unknown>): FiscalReceptorCorrection {
  const tipoDocumento = requiredText(input.tipoDocumento, "tipoDocumento", 2, 2).toUpperCase();
  if (!isCat022DocumentTypeCode(tipoDocumento)) {
    invalid("tipoDocumento debe existir en CAT-022.");
  }

  const rawNumDocumento = requiredText(input.numDocumento, "numDocumento", 3, 20);
  const numDocumento = normalizeDocumentNumber(tipoDocumento, rawNumDocumento);
  const nrc = optionalText(input.nrc, "nrc", 2, 8, /^\d{2,8}$/);
  const nombre = requiredText(input.nombre, "nombre", 1, 250);
  const codActividad = optionalText(input.codActividad, "codActividad", 1, 6);
  if (codActividad !== null && !isCat019ActivityCode(codActividad)) {
    invalid("codActividad debe existir en CAT-019.");
  }
  const descActividad = optionalText(input.descActividad, "descActividad", 1, 150);
  if (codActividad !== null && descActividad === null) {
    invalid("descActividad es requerido cuando codActividad está presente.");
  }

  const correo = optionalText(input.correo, "correo", 6, 100)?.toLowerCase() ?? null;
  if (correo !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) {
    invalid("correo debe tener formato de correo válido.");
  }
  const telefono = optionalText(input.telefono, "telefono", 8, 30);
  const codDomiciliado = domicileCode(input.codDomiciliado);
  const codPais = normalizeCat020CountryCode(requiredText(input.codPais, "codPais", 2, 2));
  if (!isCat020CountryCode(codPais)) {
    invalid("codPais debe existir en CAT-020.");
  }

  const departamento = requiredText(input.departamento, "departamento", 2, 2).toUpperCase();
  const municipio = requiredText(input.municipio, "municipio", 2, 2).toUpperCase();
  const distrito = requiredText(input.distrito, "distrito", 2, 2).toUpperCase();
  const complemento = requiredText(input.complemento, "complemento", 1, 200);

  if (codDomiciliado === 1) {
    if (codPais !== "SV") {
      invalid("Un receptor domiciliado debe usar el país SV.");
    }
    if (
      departamento === "00" ||
      !isCat012DepartmentCode(departamento) ||
      !isCat013MunicipalityCode(municipio, departamento) ||
      !isCat008DistrictCode(distrito, departamento)
    ) {
      invalid("La dirección domiciliada debe usar geografía nacional válida.");
    }
  } else {
    if (codPais === "SV") {
      invalid("Un receptor no domiciliado no puede usar el país SV.");
    }
    if (departamento !== "00" || municipio !== "00" || distrito !== "00") {
      invalid("La dirección extranjera debe usar 00/00/00.");
    }
  }

  return {
    tipoDocumento,
    numDocumento,
    nrc,
    nombre,
    codActividad,
    descActividad,
    correo,
    telefono,
    codDomiciliado,
    codPais,
    departamento,
    municipio,
    distrito,
    complemento
  };
}

function normalizeDocumentNumber(tipoDocumento: string, value: string): string {
  if (isDuiDocumentType(tipoDocumento)) {
    if (!isValidDui(value)) {
      invalid("numDocumento debe ser un DUI válido.");
    }
    return formatDui(value);
  }
  if (tipoDocumento === "36") {
    if (!isValidNitFormat(value)) {
      invalid("numDocumento debe ser un NIT válido.");
    }
    return formatNit(value);
  }
  return value.toUpperCase();
}

function domicileCode(value: unknown): 1 | 2 {
  if (!Number.isInteger(value) || !isCat032DomicileCode(value)) {
    invalid("codDomiciliado debe ser 1 o 2.");
  }
  return value as 1 | 2;
}

function requiredText(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== "string") {
    invalid(`${field} debe ser texto.`);
  }
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    invalid(`${field} debe tener entre ${min} y ${max} caracteres.`);
  }
  return normalized;
}

function optionalText(
  value: unknown,
  field: string,
  min: number,
  max: number,
  pattern?: RegExp
): string | null {
  if (value == null) return null;
  if (typeof value !== "string") {
    invalid(`${field} debe ser texto.`);
  }
  const normalized = value.trim();
  if (!normalized) return null;
  if (normalized.length < min || normalized.length > max || (pattern && !pattern.test(normalized))) {
    invalid(`${field} tiene formato inválido.`);
  }
  return normalized;
}

function invalid(message: string): never {
  throw new FiscalCorrectionValidationError("invalid_correction", message);
}
