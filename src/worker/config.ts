import type { EmisorConfig, Env } from "./types";
import {
  isCat008DistrictCode,
  isCat012DepartmentCode,
  isCat013MunicipalityCode,
  isCat014UnitCode,
  isCat017PaymentFormCode,
  isCat019ActivityCode,
  isCat020CountryCode,
  isCat022DocumentTypeCode,
  isCat022IssuerDocumentTypeCode,
  isCat026DonationTypeCode
} from "../shared/catalogs";
import { assertValidDui, isDuiDocumentType } from "../shared/dui";

export function isMockMode(env: Env): boolean {
  // Explicit opt-in: external services are only mocked when MOCK_EXTERNAL_SERVICES
  // is exactly "true". Any other value — including unset — performs real calls, so
  // a forgotten flag fails safe toward production behavior rather than silent mocks.
  return env.MOCK_EXTERNAL_SERVICES === "true";
}

export function getEmisorConfig(env: Env): EmisorConfig {
  if (!env.EMISOR_CONFIG_JSON) {
    throw new Error("EMISOR_CONFIG_JSON es requerido");
  }
  let config: unknown;
  try {
    config = JSON.parse(env.EMISOR_CONFIG_JSON);
  } catch {
    throw invalidConfig("no es JSON válido. Revise comillas y caracteres de escape del secreto.");
  }
  validateEmisorConfig(config);
  return config as EmisorConfig;
}

function validateEmisorConfig(value: unknown): asserts value is EmisorConfig {
  const config = requiredRecord(value, "emisor");
  const direccion = requiredRecord(config.direccion, "emisor.direccion");
  const responsable = requiredRecord(config.responsable, "emisor.responsable");

  const tipoDocumento = requiredText(config.tipoDocumento, "emisor.tipoDocumento", 1, 2);
  assertCatalog("emisor.tipoDocumento", "CAT-022 emisor", tipoDocumento, isCat022IssuerDocumentTypeCode, "debe ser 36 - NIT");
  assertPattern("emisor.numDocumento", requiredText(config.numDocumento, "emisor.numDocumento", 9, 14), /^\d{9,14}$/, "debe tener de 9 a 14 digitos");
  optionalText(config.nrc, "emisor.nrc", 2, 8, /^\d{2,8}$/);
  requiredText(config.nombre, "emisor.nombre", 1, 250);
  const codActividad = requiredText(config.codActividad, "emisor.codActividad", 5, 6);
  assertCatalog("emisor.codActividad", "CAT-019 actividad economica", codActividad, isCat019ActivityCode);
  requiredText(config.descActividad, "emisor.descActividad", 5, 150);
  optionalText(config.nombreComercial, "emisor.nombreComercial", 1, 150);

  const departamento = requiredText(direccion.departamento, "emisor.direccion.departamento", 2, 2);
  assertCatalog("emisor.direccion.departamento", "CAT-012 departamento", departamento, isCat012DepartmentCode);
  const municipio = requiredText(direccion.municipio, "emisor.direccion.municipio", 2, 2);
  if (!isCat013MunicipalityCode(municipio, departamento)) {
    throw invalidConfig("emisor.direccion.municipio debe existir en CAT-013 para el departamento seleccionado");
  }
  const distrito = requiredText(direccion.distrito, "emisor.direccion.distrito", 2, 2);
  if (!isCat008DistrictCode(distrito, departamento)) {
    throw invalidConfig("emisor.direccion.distrito debe existir en CAT-008 para el departamento seleccionado");
  }
  requiredText(direccion.complemento, "emisor.direccion.complemento", 1, 200);

  requiredText(config.telefono, "emisor.telefono", 8, 30);
  const correo = requiredText(config.correo, "emisor.correo", 6, 100);
  assertPattern("emisor.correo", correo, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, "debe tener formato de correo valido");
  optionalText(config.codEstable, "emisor.codEstable", 4, 4);
  requiredText(config.codEstableMH, "emisor.codEstableMH", 4, 4);
  optionalText(config.codPuntoVenta, "emisor.codPuntoVenta", 1, 15);
  requiredText(config.codPuntoVentaMH, "emisor.codPuntoVentaMH", 4, 4);
  assertPattern("emisor.controlPrefix", requiredText(config.controlPrefix, "emisor.controlPrefix", 8, 8), /^[A-Z0-9]{8}$/i, "debe tener 8 caracteres alfanumericos");

  assertCatalog("emisor.defaultReceptorTipoDocumento", "CAT-022 tipo documento receptor", requiredText(config.defaultReceptorTipoDocumento, "emisor.defaultReceptorTipoDocumento", 2, 2), isCat022DocumentTypeCode);
  assertCatalog("emisor.defaultCodPais", "CAT-020 pais", requiredText(config.defaultCodPais, "emisor.defaultCodPais", 2, 2), isCat020CountryCode);
  assertCatalog("emisor.defaultDonationType", "CAT-026 tipo donacion", requiredNumber(config.defaultDonationType, "emisor.defaultDonationType"), isCat026DonationTypeCode);
  assertCatalog("emisor.defaultUnidadMedida", "CAT-014 unidad de medida", requiredNumber(config.defaultUnidadMedida, "emisor.defaultUnidadMedida"), isCat014UnitCode);
  optionalCatalog("emisor.paymentMethodCode", "CAT-017 forma de pago", config.paymentMethodCode, isCat017PaymentFormCode);

  requiredText(responsable.nombre, "emisor.responsable.nombre", 1, 250);
  const responsableTipoDocumento = requiredText(responsable.tipoDocumento, "emisor.responsable.tipoDocumento", 2, 2);
  assertCatalog("emisor.responsable.tipoDocumento", "CAT-022 tipo documento responsable", responsableTipoDocumento, isCat022DocumentTypeCode);
  const responsableNumeroDocumento = requiredText(responsable.numeroDocumento, "emisor.responsable.numeroDocumento", 3, 20);
  if (isDuiDocumentType(responsableTipoDocumento)) {
    assertValidDui(responsableNumeroDocumento);
  }
  requiredText(responsable.tipoEstablecimiento, "emisor.responsable.tipoEstablecimiento", 1, 20);
}

function requiredRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidConfig(`${name} debe ser un objeto`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, name: string, minLength: number, maxLength: number): string {
  if (typeof value !== "string") {
    throw invalidConfig(`${name} debe ser texto`);
  }
  const clean = value.trim();
  if (clean.length < minLength || clean.length > maxLength) {
    throw invalidConfig(`${name} debe tener entre ${minLength} y ${maxLength} caracteres`);
  }
  return clean;
}

function optionalText(value: unknown, name: string, minLength: number, maxLength: number, pattern?: RegExp): string | null {
  if (value == null) return null;
  const clean = requiredText(value, name, minLength, maxLength);
  if (pattern) {
    assertPattern(name, clean, pattern, "tiene formato invalido");
  }
  return clean;
}

function requiredNumber(value: unknown, name: string): number {
  if (!Number.isInteger(value)) {
    throw invalidConfig(`${name} debe ser numero entero`);
  }
  return value as number;
}

function assertPattern(name: string, value: string, pattern: RegExp, message: string): void {
  if (!pattern.test(value)) {
    throw invalidConfig(`${name} ${message}`);
  }
}

function assertCatalog(name: string, catalogName: string, value: string | number, validator: (value: unknown) => boolean, detail?: string): void {
  if (!validator(value)) {
    throw invalidConfig(`${name} debe existir en ${catalogName}${detail ? ` (${detail})` : ""}`);
  }
}

function optionalCatalog(name: string, catalogName: string, value: unknown, validator: (value: unknown) => boolean): void {
  if (value == null) return;
  if (typeof value !== "string" || value.trim().length === 0) return;
  assertCatalog(name, catalogName, value, validator);
}

function invalidConfig(message: string): Error {
  return new Error(`EMISOR_CONFIG_JSON invalido: ${message}`);
}

export function requireSecret(env: Env, key: keyof Env): string {
  const value = env[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${String(key)} es requerido`);
  }
  return value;
}

export function getMhCertificateXml(env: Env): string {
  if (typeof env.MH_CERT_XML === "string" && env.MH_CERT_XML.length > 0) {
    return env.MH_CERT_XML;
  }

  const part1 = env.MH_CERT_XML_PART_1;
  const part2 = env.MH_CERT_XML_PART_2;
  if (part1 || part2) {
    if (typeof part1 === "string" && part1.length > 0 && typeof part2 === "string" && part2.length > 0) {
      return `${part1}${part2}`;
    }
    throw new Error("MH_CERT_XML_PART_1 y MH_CERT_XML_PART_2 son requeridos cuando MH_CERT_XML no está configurado");
  }

  throw new Error("MH_CERT_XML es requerido");
}

export function mhEndpoint(env: Env, name: "auth" | "recepcion" | "anulacion", ambiente: "00" | "01"): string {
  const suffix = ambiente === "01" ? "PROD" : "TEST";
  const key = `MH_${name.toUpperCase()}_URL_${suffix}` as keyof Env;
  return requireSecret(env, key);
}
