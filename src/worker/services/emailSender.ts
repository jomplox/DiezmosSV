export const EMAIL_SENDER_NAME_SETTING_KEY = "email_sender_name";

const EMAIL_SENDER_NAME_MAX_LENGTH = 80;
const EMAIL_SENDER_NAME_CONTROL_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;
const DEFAULT_EMAIL_SENDER_NAME = "ExamplePerson1";

export class EmailSenderValidationError extends Error {}

export function normalizeEmailSenderName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new EmailSenderValidationError("Ingrese el nombre visible del remitente.");
  }
  const senderName = value.trim();
  if (senderName.length > EMAIL_SENDER_NAME_MAX_LENGTH) {
    throw new EmailSenderValidationError(
      `El nombre del remitente no puede superar los ${EMAIL_SENDER_NAME_MAX_LENGTH} caracteres.`
    );
  }
  if (EMAIL_SENDER_NAME_CONTROL_PATTERN.test(senderName)) {
    throw new EmailSenderValidationError("El nombre del remitente contiene caracteres no permitidos.");
  }
  return senderName;
}

// Stored settings from an older release must never block email delivery. Prefer the
// configured sender, then the validated organization name, then the historical default.
export function resolveEmailSenderName(value: unknown, organizationName: unknown): string {
  for (const candidate of [value, organizationName, DEFAULT_EMAIL_SENDER_NAME]) {
    try {
      return normalizeEmailSenderName(candidate);
    } catch {
      // Continue to the next safe fallback.
    }
  }
  return DEFAULT_EMAIL_SENDER_NAME;
}
