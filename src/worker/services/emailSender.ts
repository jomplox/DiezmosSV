import { isValidEmail } from "../../shared/email";

export const EMAIL_SENDER_NAME_SETTING_KEY = "email_sender_name";
export const EMAIL_REPLY_TO_SETTING_KEY = "email_reply_to";

const EMAIL_SENDER_NAME_MAX_LENGTH = 80;
const EMAIL_REPLY_TO_MAX_LENGTH = 254;
const EMAIL_SENDER_NAME_CONTROL_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;
const DEFAULT_EMAIL_SENDER_NAME = "ExamplePerson1";

export class EmailSenderValidationError extends Error {}

export function normalizeEmailSenderName(value: unknown): string {
  if (typeof value !== "string" || EMAIL_SENDER_NAME_CONTROL_PATTERN.test(value)) {
    throw new EmailSenderValidationError("El nombre del remitente contiene caracteres no permitidos.");
  }
  const senderName = value.trim();
  if (!senderName) {
    throw new EmailSenderValidationError("Ingrese el nombre visible del remitente.");
  }
  if (senderName.length > EMAIL_SENDER_NAME_MAX_LENGTH) {
    throw new EmailSenderValidationError(
      `El nombre del remitente no puede superar los ${EMAIL_SENDER_NAME_MAX_LENGTH} caracteres.`
    );
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

export function normalizeEmailReplyToAddress(value: unknown): string {
  if (typeof value !== "string") {
    throw new EmailSenderValidationError("Ingrese un correo válido para recibir respuestas.");
  }
  const replyToAddress = value.trim().toLowerCase();
  if (!replyToAddress) {
    return "";
  }
  if (replyToAddress.length > EMAIL_REPLY_TO_MAX_LENGTH) {
    throw new EmailSenderValidationError(
      `El correo para recibir respuestas no puede superar los ${EMAIL_REPLY_TO_MAX_LENGTH} caracteres.`
    );
  }
  if (!isValidEmail(replyToAddress)) {
    throw new EmailSenderValidationError("Ingrese un correo válido para recibir respuestas.");
  }
  return replyToAddress;
}

// An invalid value left by an older release must not block delivery. Omitting Reply-To
// makes email clients reply to the authenticated sender address instead.
export function resolveEmailReplyToAddress(value: unknown): string | null {
  try {
    return normalizeEmailReplyToAddress(value) || null;
  } catch {
    return null;
  }
}
