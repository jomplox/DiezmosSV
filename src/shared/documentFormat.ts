// Formato visual del documento fiscal del receptor/emisor en PDFs: NIT de 14
// dígitos con guiones NIT, DUI de 9 dígitos como ########-#, y cualquier valor
// con letras (pasaportes, carnés) pasa sin cambios.
export function formatDocument(value: string | null | undefined): string {
  const source = value ?? "";
  if (/\p{L}/u.test(source)) {
    return source;
  }
  const digits = source.replace(/\D/g, "");
  if (digits.length === 14) {
    return `${digits.slice(0, 4)}-${digits.slice(4, 10)}-${digits.slice(10, 13)}-${digits.slice(13)}`;
  }
  if (digits.length === 9) {
    return `${digits.slice(0, 8)}-${digits.slice(8)}`;
  }
  return source;
}
