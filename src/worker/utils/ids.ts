export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function generationCode(): string {
  return crypto.randomUUID().toUpperCase();
}

export function padControlSequence(value: number): string {
  return String(value).padStart(15, "0");
}

export function numeroControl(controlPrefix: string, sequence: number): string {
  const cleanPrefix = controlPrefix.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(cleanPrefix)) {
    throw new Error("El prefijo de control debe tener exactamente 8 caracteres alfanuméricos");
  }
  return `DTE-15-${cleanPrefix}-${padControlSequence(sequence)}`;
}
