export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function generationCode(): string {
  return crypto.randomUUID().toUpperCase();
}

function padControlSequence(value: number): string {
  return String(value).padStart(15, "0");
}

export function normalizeControlPrefix(controlPrefix: string): string {
  const normalized = controlPrefix.replace(/[^A-Z0-9]/gi, "").toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(normalized)) {
    throw new Error("El prefijo de control debe tener exactamente 8 caracteres alfanuméricos");
  }
  return normalized;
}

export function numeroControl(controlPrefix: string, sequence: number): string {
  return `DTE-15-${normalizeControlPrefix(controlPrefix)}-${padControlSequence(sequence)}`;
}
