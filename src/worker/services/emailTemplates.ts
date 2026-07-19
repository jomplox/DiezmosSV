import { formatCents } from "../../shared/money";
import type { DteDocumentRecord } from "../types";

export const EMAIL_TEMPLATES_SETTING_KEY = "email_templates_json";

type EmailTemplateType = "dteReceipt" | "dteInvalidation";

// Evidence types recorded in email_deliveries.email_type: the transitorio receipt
// (documento diferido: SIGNED + transmission_deferred_at, sin sello) se distingue del comprobante
// definitivo para que el reenvío/dedupe y la auditoría puedan diferenciarlos.
export type EmailEvidenceType = EmailTemplateType | "dteReceiptTransitorio";

export interface EmailTemplateValue {
  subject: string;
  body: string;
}

export type EmailTemplateSettings = Record<EmailTemplateType, EmailTemplateValue>;

export interface EmailTemplateDefinition {
  type: EmailTemplateType;
  label: string;
  description: string;
  defaultSubject: string;
  defaultBody: string;
}

export interface EmailTemplateResponse {
  definitions: EmailTemplateDefinition[];
  placeholders: string[];
  templates: EmailTemplateSettings;
}

export class EmailTemplateValidationError extends Error {}

const EMAIL_SUBJECT_CONTROL_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;

export function assertSafeEmailSubject(subject: string): void {
  if (EMAIL_SUBJECT_CONTROL_PATTERN.test(subject)) {
    throw new EmailTemplateValidationError("El asunto del correo contiene caracteres no permitidos.");
  }
}

export const EMAIL_TEMPLATE_DEFINITIONS: EmailTemplateDefinition[] = [
  {
    type: "dteReceipt",
    label: "Envío de comprobante",
    description: "Correo que recibe el donante con su CDE en PDF y JSON.",
    defaultSubject: "Comprobante de su donación {{numeroControl}}",
    defaultBody:
      "Hola {{donante}}:\n\nGracias por su donación de {{monto}}. Adjuntamos su Comprobante de Donación Electrónico {{numeroControl}} en PDF y JSON, con Sello de Recepción del Ministerio de Hacienda.\n\nConserve este correo para sus registros."
  },
  {
    type: "dteInvalidation",
    label: "Invalidación de comprobante",
    description: "Correo que recibe el donante cuando su CDE queda invalidado.",
    defaultSubject: "Invalidación de su comprobante {{numeroControl}}",
    defaultBody:
      "Hola {{donante}}:\n\nLe informamos que el Comprobante de Donación Electrónico {{numeroControl}} quedó INVALIDADO ante el Ministerio de Hacienda y dejó de tener validez fiscal. Adjuntamos la representación gráfica con la marca INVALIDADO y el JSON del documento para sus registros.\n\nSi la iglesia le emitió un comprobante corregido, lo recibirá en un correo aparte. Si no esperaba esta invalidación, escríbanos al correo de contacto al pie de este mensaje."
  }
];

const EMAIL_TEMPLATE_PLACEHOLDERS = [
  "{{numeroControl}}",
  "{{codigoGeneracion}}",
  "{{donante}}",
  "{{correoDonante}}",
  "{{monto}}",
  "{{ambiente}}",
  "{{estado}}"
];

export const DEFAULT_EMAIL_TEMPLATES: EmailTemplateSettings = {
  dteReceipt: {
    subject: EMAIL_TEMPLATE_DEFINITIONS[0].defaultSubject,
    body: EMAIL_TEMPLATE_DEFINITIONS[0].defaultBody
  },
  dteInvalidation: {
    subject: EMAIL_TEMPLATE_DEFINITIONS[1].defaultSubject,
    body: EMAIL_TEMPLATE_DEFINITIONS[1].defaultBody
  }
};

// Copy FIJA del comprobante transitorio (no editable por el operador): una plantilla
// personalizada de dteReceipt podría afirmar que el CDE ya tiene sello de recepción,
// lo cual sería falso mientras la transmisión está diferida. El asunto
// lleva el sufijo "(en trámite)" y el cuerpo enmarca el adjunto como provisional,
// prometiendo el envío automático del comprobante definitivo con Sello de Recepción.
export const TRANSITORIO_RECEIPT_TEMPLATE: EmailTemplateValue = {
  subject: "Comprobante de su donación (en trámite)",
  body:
    "Hola {{donante}}:\n\n" +
    "Gracias por su donación de {{monto}}. Adjuntamos la versión TRANSITORIA de su " +
    "Comprobante de Donación Electrónico {{numeroControl}}: su comprobante está en trámite " +
    "ante el Ministerio de Hacienda.\n\n" +
    "IMPORTANTE: Recibirá automáticamente por este medio el comprobante definitivo con el " +
    "Sello de Recepción en cuanto el Ministerio de Hacienda lo confirme. No necesita hacer nada.\n\n" +
    "Conserve este correo para sus registros."
};

export function emailTemplateResponse(settings: EmailTemplateSettings): EmailTemplateResponse {
  return {
    definitions: EMAIL_TEMPLATE_DEFINITIONS,
    placeholders: EMAIL_TEMPLATE_PLACEHOLDERS,
    templates: settings
  };
}

export function parseEmailTemplates(raw: string | null | undefined): EmailTemplateSettings {
  if (!raw) {
    return cloneDefaultTemplates();
  }
  try {
    return mergeEmailTemplates(JSON.parse(raw) as unknown);
  } catch {
    return cloneDefaultTemplates();
  }
}

export function normalizeEmailTemplateSettings(input: unknown): EmailTemplateSettings {
  if (!isRecord(input)) {
    throw new EmailTemplateValidationError("Ingrese las plantillas de correo.");
  }
  const normalized = {} as EmailTemplateSettings;
  for (const definition of EMAIL_TEMPLATE_DEFINITIONS) {
    const rawTemplate = input[definition.type];
    if (!isRecord(rawTemplate)) {
      throw new EmailTemplateValidationError(`Complete la plantilla: ${definition.label}.`);
    }
    const rawSubject = stringValue(rawTemplate.subject);
    assertSafeEmailSubject(rawSubject);
    const subject = rawSubject.trim();
    const body = stringValue(rawTemplate.body).trim();
    if (!subject || !body) {
      throw new EmailTemplateValidationError(`Complete asunto y cuerpo para: ${definition.label}.`);
    }
    normalized[definition.type] = { subject, body };
  }
  return normalized;
}

export function renderEmailTemplate(template: EmailTemplateValue, record: DteDocumentRecord): { subject: string; text: string } {
  const values = placeholderValues(record);
  const subject = replacePlaceholders(template.subject, values);
  assertSafeEmailSubject(subject);
  return {
    subject,
    text: replacePlaceholders(template.body, values)
  };
}

function mergeEmailTemplates(input: unknown): EmailTemplateSettings {
  const defaults = cloneDefaultTemplates();
  if (!isRecord(input)) {
    return defaults;
  }
  for (const definition of EMAIL_TEMPLATE_DEFINITIONS) {
    const rawTemplate = input[definition.type];
    if (!isRecord(rawTemplate)) continue;
    const rawSubject = stringValue(rawTemplate.subject);
    assertSafeEmailSubject(rawSubject);
    const subject = rawSubject.trim();
    const body = stringValue(rawTemplate.body).trim();
    defaults[definition.type] = {
      subject: subject || defaults[definition.type].subject,
      body: body || defaults[definition.type].body
    };
  }
  return defaults;
}

function cloneDefaultTemplates(): EmailTemplateSettings {
  return {
    dteReceipt: { ...DEFAULT_EMAIL_TEMPLATES.dteReceipt },
    dteInvalidation: { ...DEFAULT_EMAIL_TEMPLATES.dteInvalidation }
  };
}

function placeholderValues(record: DteDocumentRecord): Record<string, string> {
  return {
    "{{numeroControl}}": record.numero_control,
    "{{codigoGeneracion}}": record.codigo_generacion,
    "{{donante}}": record.donor_name || "donante",
    "{{correoDonante}}": record.donor_email || "",
    "{{monto}}": formatCents(record.amount_cents),
    "{{ambiente}}": record.environment === "01" ? "Producción" : "Pruebas",
    "{{estado}}": statusLabel(record.status)
  };
}

function replacePlaceholders(value: string, placeholders: Record<string, string>): string {
  return Object.entries(placeholders).reduce((text, [token, replacement]) => text.split(token).join(replacement), value);
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    ACCEPTED: "Aceptado",
    CONTINGENCY_PENDING: "En contingencia",
    FAILED: "Fallido",
    INVALIDATED: "Invalidado",
    REJECTED: "Rechazado",
    SIGNED: "Firmado"
  };
  return labels[status] ?? status;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
