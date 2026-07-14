import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import cdeSchema from "../../../DTE/svfe-json-schemas/v2/fe-cd-v2.json";
import invalidacionSchema from "../../../DTE/svfe-json-schemas/v3/invalidacion-schema-v3.json";
import { OperatorSafeIssuanceError } from "./operatorSafeIssuanceError";

// JSON amounts such as 1.11 become binary floating-point values after parsing,
// so exact division by the official MH schema's 0.01 multiple can leave a tiny
// remainder. This Ajv tolerance prevents false rejections without changing MH's schema.
const ajv = new Ajv({ allErrors: true, strict: false, multipleOfPrecision: 12 });
addFormats(ajv);

// El validador del evento de contingencia se eliminó junto con la emisión en
// contingencia: el Anexo de validaciones del evento (campo 35) no admite el CDE
// (tipo 15), así que este sistema nunca construye ese evento.
const validators = {
  cde: ajv.compile(cdeSchema),
  invalidacion: ajv.compile(invalidacionSchema)
};

export function validateCde(document: unknown): void {
  assertValid("CDE", validators.cde(document), validators.cde.errors);
}

export function validateInvalidacion(document: unknown): void {
  assertValid("Invalidación", validators.invalidacion(document), validators.invalidacion.errors);
}

function assertValid(label: string, valid: boolean, _errors: ErrorObject[] | null | undefined): void {
  if (valid) {
    return;
  }
  throw new OperatorSafeIssuanceError(
    label === "CDE" ? "CDE_SCHEMA" : "ISSUANCE_SCHEMA",
    `La validación del esquema ${label} falló.`
  );
}
