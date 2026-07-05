import type { DteDocumentRecord } from "../types";

export const EMAIL_TEMPLATES_SETTING_KEY = "email_templates_json";

export type EmailTemplateType = "dteReceipt" | "dteInvalidation";

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

export const EMAIL_TEMPLATE_DEFINITIONS: EmailTemplateDefinition[] = [
  {
    type: "dteReceipt",
    label: "Envío de DTE",
    description: "Correo que recibe el donante cuando se envía el CDE con PDF y JSON.",
    defaultSubject: "Comprobante DTE por donación",
    defaultBody: "Adjuntamos su Comprobante de Donación Electrónico {{numeroControl}}."
  },
  {
    type: "dteInvalidation",
    label: "Invalidación de DTE",
    description: "Correo que recibe el donante cuando un CDE emitido queda invalidado.",
    defaultSubject: "Invalidación de CDE {{numeroControl}}",
    defaultBody: "El Comprobante de Donación Electrónico {{numeroControl}} fue INVALIDADO ante el Ministerio de Hacienda. Adjuntamos la representación gráfica actualizada con marca INVALIDADO y el JSON del documento para sus registros."
  }
];

export const EMAIL_TEMPLATE_PLACEHOLDERS = [
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
    const subject = stringValue(rawTemplate.subject).trim();
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
  return {
    subject: replacePlaceholders(template.subject, values),
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
    const subject = stringValue(rawTemplate.subject).trim();
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
    "{{monto}}": money(record.amount_cents),
    "{{ambiente}}": record.environment === "01" ? "Producción" : "Pruebas",
    "{{estado}}": statusLabel(record.status)
  };
}

function replacePlaceholders(value: string, placeholders: Record<string, string>): string {
  return Object.entries(placeholders).reduce((text, [token, replacement]) => text.split(token).join(replacement), value);
}

function money(amountCents: number): string {
  return `$${(amountCents / 100).toFixed(2)}`;
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
