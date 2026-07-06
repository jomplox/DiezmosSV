export function cleanNit(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\D/g, "");
}

// Format-only validation: exactly 14 digits after stripping separators. There is
// deliberately NO check-digit algorithm here (v1): MH validates the NIT
// server-side on transmission, and a wrong homebrew checksum would reject valid
// NITs — several NIT generations carry different verifier rules, so format-only
// keeps every real NIT emittable while still catching length typos.
export function isValidNitFormat(raw: string | null | undefined): boolean {
  return cleanNit(raw).length === 14;
}

// Canonical storage/display form XXXX-XXXXXX-XXX-X (4-6-3-1), matching the PDF
// renderer's formatDocument grouping so a stored NIT round-trips unchanged.
export function formatNit(raw: string | null | undefined): string {
  const digits = cleanNit(raw);
  return `${digits.slice(0, 4)}-${digits.slice(4, 10)}-${digits.slice(10, 13)}-${digits.slice(13)}`;
}
