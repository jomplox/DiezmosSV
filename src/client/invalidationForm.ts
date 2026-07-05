const CODIGO_GENERACION_PATTERN = /^[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}$/;

export interface InvalidationFormInput {
  tipoAnulacion: 1 | 2;
  motivoAnulacion: string;
  codigoGeneracionR: string;
}

export function defaultInvalidationForm(): InvalidationFormInput {
  return { tipoAnulacion: 2, motivoAnulacion: "", codigoGeneracionR: "" };
}

export function invalidationFormValidationMessage(input: InvalidationFormInput): string {
  if (!input.motivoAnulacion.trim()) {
    return "Ingrese el motivo de la invalidación";
  }
  if (input.tipoAnulacion === 1 && !CODIGO_GENERACION_PATTERN.test(input.codigoGeneracionR.trim().toUpperCase())) {
    return "Ingrese el código de generación del CDE de reemplazo (formato UUID)";
  }
  return "";
}

export function invalidationRequestBody(input: InvalidationFormInput): {
  tipoAnulacion: 1 | 2;
  motivoAnulacion: string;
  codigoGeneracionR?: string;
} {
  return {
    tipoAnulacion: input.tipoAnulacion,
    motivoAnulacion: input.motivoAnulacion.trim(),
    ...(input.tipoAnulacion === 1 ? { codigoGeneracionR: input.codigoGeneracionR.trim().toUpperCase() } : {})
  };
}
