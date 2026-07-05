export function cleanDui(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

export function isValidDui(raw: string | null | undefined): boolean {
  const digits = cleanDui(raw);
  if (digits.length !== 9) {
    return false;
  }
  const total = digits
    .slice(0, 8)
    .split("")
    .reduce((sum, digit, index) => sum + Number(digit) * (9 - index), 0);
  const expectedCheck = (10 - (total % 10)) % 10;
  return expectedCheck === Number(digits[8]);
}

export function assertValidDui(raw: string | null | undefined): void {
  const digits = cleanDui(raw);
  if (digits.length !== 9) {
    throw new Error("DUI debe tener formato XXXXXXXX-X (9 digitos).");
  }
  if (!isValidDui(raw)) {
    throw new Error(`DUI ${raw}: digito verificador invalido.`);
  }
}

export function formatDui(raw: string | null | undefined): string {
  const digits = cleanDui(raw);
  return `${digits.slice(0, 8)}-${digits.slice(8)}`;
}

export function isDuiDocumentType(value: unknown): boolean {
  return String(value ?? "").trim() === "13";
}
