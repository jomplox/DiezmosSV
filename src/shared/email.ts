// Validación de correo compartida entre worker y cliente: un solo patrón para
// que formularios, configuración y plantillas acepten exactamente lo mismo.
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(value);
}
