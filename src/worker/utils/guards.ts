// Micro-utilidades compartidas del worker: type guards y normalizadores que
// antes vivían copiados en handlers, dominios y servicios.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function onlyDigits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Recorta, pasa a minúsculas y valida un UUID v4; null para cualquier otra cosa.
export function normalizeUuidV4(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return UUID_V4_PATTERN.test(normalized) ? normalized : null;
}
