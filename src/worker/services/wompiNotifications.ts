import { isValidEmail } from "../../shared/email";

export const WOMPI_NOTIFICATION_EMAILS_SETTING_KEY = "wompi_notification_emails";
export const WOMPI_NOTIFICATION_PHONES_SETTING_KEY = "wompi_notification_phones";
export const WOMPI_NOTIFY_DONOR_EMAIL_SETTING_KEY = "wompi_notify_donor_email";

const EMAIL_MAX_LENGTH = 254;
const NOTIFICATION_LIST_MAX_LENGTH = 2_000;
const PHONE_FORMATTING_PATTERN = /[\s().-]/gu;
const PHONE_PATTERN = /^\+?[0-9]{8,15}$/u;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;

export interface WompiNotificationSettings {
  emailsNotificacion: string;
  telefonosNotificacion: string;
  notificarTransaccionCliente: boolean;
}

export class WompiNotificationValidationError extends Error {}

export function normalizeWompiNotificationSettings(input: {
  emailsNotificacion: unknown;
  telefonosNotificacion: unknown;
  notificarTransaccionCliente: unknown;
}): WompiNotificationSettings {
  return {
    emailsNotificacion: normalizeNotificationEmails(input.emailsNotificacion),
    telefonosNotificacion: normalizeNotificationPhones(input.telefonosNotificacion),
    notificarTransaccionCliente: normalizeNotifyDonorEmail(input.notificarTransaccionCliente)
  };
}

export async function loadWompiNotificationSettings(settings: {
  getSetting(key: string): Promise<string | null>;
}): Promise<WompiNotificationSettings> {
  const [emails, phones, notifyDonor] = await Promise.all([
    settings.getSetting(WOMPI_NOTIFICATION_EMAILS_SETTING_KEY),
    settings.getSetting(WOMPI_NOTIFICATION_PHONES_SETTING_KEY),
    settings.getSetting(WOMPI_NOTIFY_DONOR_EMAIL_SETTING_KEY)
  ]);
  return {
    emailsNotificacion: safelyNormalize(normalizeNotificationEmails, emails),
    telefonosNotificacion: safelyNormalize(normalizeNotificationPhones, phones),
    notificarTransaccionCliente: notifyDonor === "true"
  };
}

function normalizeNotificationEmails(value: unknown): string {
  const raw = requiredString(value, "Ingrese correos válidos separados por coma.");
  if (!raw) {
    return "";
  }
  const recipients = raw.split(",").map((recipient) => recipient.trim().toLowerCase());
  if (
    recipients.some(
      (recipient) =>
        !recipient
        || recipient.length > EMAIL_MAX_LENGTH
        || CONTROL_CHARACTER_PATTERN.test(recipient)
        || !isValidEmail(recipient)
    )
  ) {
    throw new WompiNotificationValidationError("Ingrese correos válidos separados por coma.");
  }
  const normalized = recipients.join(",");
  if (normalized.length > NOTIFICATION_LIST_MAX_LENGTH) {
    throw new WompiNotificationValidationError("La lista de correos de Wompi es demasiado larga.");
  }
  return normalized;
}

function normalizeNotificationPhones(value: unknown): string {
  const raw = requiredString(value, "Ingrese celulares válidos separados por coma.");
  if (!raw) {
    return "";
  }
  const recipients = raw.split(",").map((recipient) =>
    recipient.trim().replace(PHONE_FORMATTING_PATTERN, "")
  );
  if (
    recipients.some(
      (recipient) =>
        !recipient
        || CONTROL_CHARACTER_PATTERN.test(recipient)
        || !PHONE_PATTERN.test(recipient)
    )
  ) {
    throw new WompiNotificationValidationError(
      "Ingrese celulares de 8 a 15 dígitos, con código de país opcional, separados por coma."
    );
  }
  const normalized = recipients.join(",");
  if (normalized.length > NOTIFICATION_LIST_MAX_LENGTH) {
    throw new WompiNotificationValidationError("La lista de celulares de Wompi es demasiado larga.");
  }
  return normalized;
}

function normalizeNotifyDonorEmail(value: unknown): boolean {
  if (typeof value !== "boolean") {
    throw new WompiNotificationValidationError("Seleccione si Wompi enviará un correo adicional al donante.");
  }
  return value;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new WompiNotificationValidationError(message);
  }
  return value.trim();
}

function safelyNormalize(
  normalize: (value: unknown) => string,
  value: unknown
): string {
  try {
    return normalize(value ?? "");
  } catch {
    // A malformed value left by an older release must never block link creation.
    return "";
  }
}
