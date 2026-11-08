import Ajv, { type ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import cdeSchema from "../../../DTE/svfe-json-schemas/v2/fe-cd-v2.json";
import invalidacionSchema from "../../../DTE/svfe-json-schemas/v3/invalidacion-schema-v3.json";
import { OperatorSafeIssuanceError } from "./operatorSafeIssuanceError";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// Ajv's multipleOf divides binary floats: 21.15 / 1e-8 is 2114999999.9999998, so a
// valid cent amount fails MH's 1e-8 rule, and no fixed multipleOfPrecision tolerance
// holds at every magnitude. Check the decimal text instead — the exact number
// JSON.stringify sends to MH — so the rule passes or fails as MH reads it.
ajv.removeKeyword("multipleOf");
ajv.addKeyword({ keyword: "multipleOf", type: "number", schemaType: "number", errors: true, validate: decimalMultipleOf });

function decimalMultipleOf(step: number, value: number): boolean {
  decimalMultipleOf.errors = [{ keyword: "multipleOf", message: `must be multiple of ${step}`, params: { multipleOf: step } }];
  if (!Number.isFinite(value)) return false;
  const v = decimalUnits(value);
  const s = decimalUnits(step);
  const places = Math.max(v.places, s.places);
  const divisor = s.units * 10n ** BigInt(places - s.places);
  return divisor !== 0n && (v.units * 10n ** BigInt(places - v.places)) % divisor === 0n;
}
decimalMultipleOf.errors = [] as Partial<ErrorObject>[];

// n as an integer count of 10^-places, read from its shortest decimal text.
function decimalUnits(n: number): { units: bigint; places: number } {
  const [mantissa, exponent = "0"] = String(n).split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  return { units: BigInt(whole + fraction), places: fraction.length - Number(exponent) };
}

// El validador del evento de contingencia se eliminó junto con la emisión en
// contingencia: el Anexo de validaciones del evento (campo 35) no admite el CDE
// (tipo 15), así que este sistema nunca construye ese evento.
const validators = {
  cde: ajv.compile(cdeSchema),
  invalidacion: ajv.compile(invalidacionSchema)
};

export class DocumentSchemaValidationError extends OperatorSafeIssuanceError {
  constructor(
    readonly documentLabel: string,
    readonly detail: string
  ) {
    super(
      documentLabel === "CDE" ? "CDE_SCHEMA" : "ISSUANCE_SCHEMA",
      `La validación del esquema ${documentLabel} falló.`
    );
    this.name = "DocumentSchemaValidationError";
  }
}

export function validateCde(document: unknown): void {
  assertValid("CDE", validators.cde(document), validators.cde.errors);
}

export function validateInvalidacion(document: unknown): void {
  assertValid("Invalidación", validators.invalidacion(document), validators.invalidacion.errors);
}

function assertValid(label: string, valid: boolean, errors: ErrorObject[] | null | undefined): void {
  if (valid) {
    return;
  }
  const detail = (errors ?? [])
    .slice(0, 8)
    .map((error) => `${error.instancePath || "/"} ${error.message ?? ""}`.trim())
    .join("; ");
  throw new DocumentSchemaValidationError(label, detail);
}
