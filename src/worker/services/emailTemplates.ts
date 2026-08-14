import { formatCents } from "../../shared/money";
import type { DteDocumentRecord } from "../types";
import { isRecord } from "../utils/guards";
import { emailTemplatePlainText } from "./emailHtml";

export const EMAIL_TEMPLATES_SETTING_KEY = "email_templates_json";

type DteEmailTemplateType = "dteReceipt" | "dteInvalidation";
export type EmailTemplateType =
  | DteEmailTemplateType
  | "stripeAcknowledgment"
  | "stripeRefund"
  | "stripeAnnualStatement";
export type EmailTemplateScope = "SV_CDE" | "US_STRIPE";

// Evidence types recorded in email_deliveries.email_type: the transitorio receipt
// (documento diferido: SIGNED + transmission_deferred_at, sin sello) se distingue del comprobante
// definitivo para que el reenvío/dedupe y la auditoría puedan diferenciarlos.
export type EmailEvidenceType = DteEmailTemplateType | "dteReceiptTransitorio";

export interface EmailTemplateValue {
  subject: string;
  body: string;
}

export type EmailTemplateSettings = Record<EmailTemplateType, EmailTemplateValue>;

export interface EmailTemplateDefinition {
  type: EmailTemplateType;
  scope: EmailTemplateScope;
  label: string;
  description: string;
  defaultSubject: string;
  defaultBody: string;
  placeholders: string[];
}

export interface EmailTemplateResponse {
  definitions: EmailTemplateDefinition[];
  placeholders: string[];
  templates: EmailTemplateSettings;
}

export class EmailTemplateValidationError extends Error {}
export class EmailTemplateStoredStateError extends Error {}

const EMAIL_SUBJECT_CONTROL_PATTERN = /[\u0000-\u001F\u007F-\u009F]/u;

const EMAIL_TEMPLATE_PLACEHOLDERS = [
  "{{numeroControl}}",
  "{{codigoGeneracion}}",
  "{{donante}}",
  "{{correoDonante}}",
  "{{monto}}",
  "{{ambiente}}",
  "{{estado}}"
];

const STRIPE_ACKNOWLEDGMENT_PLACEHOLDERS = [
  "{{donante}}",
  "{{monto}}",
  "{{fecha}}",
  "{{tipoEntrega}}",
  "{{frecuencia}}",
  "{{nombreLegal}}",
  "{{ein}}"
];

const STRIPE_REFUND_PLACEHOLDERS = [
  "{{donante}}",
  "{{tipoConstancia}}",
  "{{montoOriginal}}",
  "{{montoReembolsado}}",
  "{{montoNeto}}",
  "{{detalleReembolso}}",
  "{{fecha}}",
  "{{tipoEntrega}}",
  "{{frecuencia}}",
  "{{nombreLegal}}",
  "{{ein}}"
];

const STRIPE_ANNUAL_PLACEHOLDERS = [
  "{{donante}}",
  "{{tipoConstancia}}",
  "{{anio}}",
  "{{descripcionDonaciones}}",
  "{{totalNeto}}",
  "{{detalleCorreccion}}"
];

export function assertSafeEmailSubject(subject: string): void {
  if (EMAIL_SUBJECT_CONTROL_PATTERN.test(subject)) {
    throw new EmailTemplateValidationError("El asunto del correo contiene caracteres no permitidos.");
  }
}

export const EMAIL_TEMPLATE_DEFINITIONS: EmailTemplateDefinition[] = [
  {
    type: "dteReceipt",
    scope: "SV_CDE",
    label: "Envío de comprobante",
    description: "Correo que recibe el donante con su CDE en PDF y JSON.",
    defaultSubject: "Comprobante de su donación {{numeroControl}}",
    defaultBody:
      "Hola {{donante}}:\n\nGracias por su donación de {{monto}}. Adjuntamos su Comprobante de Donación Electrónico {{numeroControl}} en PDF y JSON, con Sello de Recepción del Ministerio de Hacienda.\n\nConserve este correo para sus registros.",
    placeholders: EMAIL_TEMPLATE_PLACEHOLDERS
  },
  {
    type: "dteInvalidation",
    scope: "SV_CDE",
    label: "Invalidación de comprobante",
    description: "Correo que recibe el donante cuando su CDE queda invalidado.",
    defaultSubject: "Invalidación de su comprobante {{numeroControl}}",
    defaultBody:
      "Hola {{donante}}:\n\nLe informamos que el Comprobante de Donación Electrónico {{numeroControl}} quedó INVALIDADO ante el Ministerio de Hacienda y dejó de tener validez fiscal. Adjuntamos la representación gráfica con la marca INVALIDADO y el JSON del documento para sus registros.\n\nSi la iglesia le emitió un comprobante corregido, lo recibirá en un correo aparte. Si no esperaba esta invalidación, escríbanos al correo de contacto al pie de este mensaje.",
    placeholders: EMAIL_TEMPLATE_PLACEHOLDERS
  },
  {
    type: "stripeAcknowledgment",
    scope: "US_STRIPE",
    label: "Constancia inmediata",
    description: "Se envía al confirmarse una donación única o mensual de Stripe.",
    defaultSubject: "Constancia de su donación",
    defaultBody:
      "Estimado(a) {{donante}}:\n\nGracias por su donación voluntaria de {{monto}}.\n\nOrganización legal: {{nombreLegal}}\nEIN {{ein}}\nFecha: {{fecha}}\nTipo: {{tipoEntrega}}\nFrecuencia: {{frecuencia}}\n\nNo se proporcionaron bienes ni servicios a cambio de esta donación.\n\nConserve este correo con sus registros. Consulte con su asesor sobre la aplicación a su situación fiscal.",
    placeholders: STRIPE_ACKNOWLEDGMENT_PLACEHOLDERS
  },
  {
    type: "stripeRefund",
    scope: "US_STRIPE",
    label: "Corrección o revocación por reembolso",
    description: "Reemplaza o revoca la constancia anterior según el monto reembolsado.",
    defaultSubject: "{{tipoConstancia}} de su donación",
    defaultBody:
      "Estimado(a) {{donante}}:\n\nGracias por su donación voluntaria de {{montoOriginal}}.\n\n{{detalleReembolso}}\n\nOrganización legal: {{nombreLegal}}\nEIN {{ein}}\nFecha: {{fecha}}\nTipo: {{tipoEntrega}}\nFrecuencia: {{frecuencia}}\n\nNo se proporcionaron bienes ni servicios a cambio de esta donación.\n\nConserve este correo con sus registros. Consulte con su asesor sobre la aplicación a su situación fiscal.",
    placeholders: STRIPE_REFUND_PLACEHOLDERS
  },
  {
    type: "stripeAnnualStatement",
    scope: "US_STRIPE",
    label: "Constancia anual",
    description: "Resume el total neto anual y acompaña cualquier corrección necesaria.",
    defaultSubject: "{{tipoConstancia}} {{anio}} — EE. UU.",
    defaultBody:
      "Estimado(a) {{donante}}:\n\nAdjuntamos su constancia anual de donaciones de {{anio}}, con {{descripcionDonaciones}} y un total neto de {{totalNeto}}.{{detalleCorreccion}}\n\nNo se proporcionaron bienes ni servicios a cambio de estas donaciones.\n\nConserve este documento con sus registros. Este mensaje no constituye asesoría fiscal.",
    placeholders: STRIPE_ANNUAL_PLACEHOLDERS
  }
];

export const DEFAULT_EMAIL_TEMPLATES: EmailTemplateSettings = {
  dteReceipt: {
    subject: EMAIL_TEMPLATE_DEFINITIONS[0].defaultSubject,
    body: EMAIL_TEMPLATE_DEFINITIONS[0].defaultBody
  },
  dteInvalidation: {
    subject: EMAIL_TEMPLATE_DEFINITIONS[1].defaultSubject,
    body: EMAIL_TEMPLATE_DEFINITIONS[1].defaultBody
  },
  stripeAcknowledgment: {
    subject: EMAIL_TEMPLATE_DEFINITIONS[2].defaultSubject,
    body: EMAIL_TEMPLATE_DEFINITIONS[2].defaultBody
  },
  stripeRefund: {
    subject: EMAIL_TEMPLATE_DEFINITIONS[3].defaultSubject,
    body: EMAIL_TEMPLATE_DEFINITIONS[3].defaultBody
  },
  stripeAnnualStatement: {
    subject: EMAIL_TEMPLATE_DEFINITIONS[4].defaultSubject,
    body: EMAIL_TEMPLATE_DEFINITIONS[4].defaultBody
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

export function parseEmailTemplateScope(value: unknown): EmailTemplateScope {
  if (value === "SV_CDE" || value === "US_STRIPE") {
    return value;
  }
  throw new EmailTemplateValidationError("Grupo de plantillas de correo no reconocido.");
}

export function prepareScopedEmailTemplateUpdate(
  storedRaw: string | null,
  submitted: unknown,
  scope: EmailTemplateScope
): { patch: Partial<EmailTemplateSettings>; templates: EmailTemplateSettings } {
  if (!isRecord(submitted)) {
    throw new EmailTemplateValidationError("Ingrese las plantillas de correo.");
  }
  const scopedCandidate: Record<string, unknown> = {};
  for (const definition of EMAIL_TEMPLATE_DEFINITIONS) {
    scopedCandidate[definition.type] = definition.scope === scope
      ? submitted[definition.type]
      : DEFAULT_EMAIL_TEMPLATES[definition.type];
  }
  const normalizedCandidate = normalizeEmailTemplateSettings(scopedCandidate);
  const patch = Object.fromEntries(
    EMAIL_TEMPLATE_DEFINITIONS
      .filter((definition) => definition.scope === scope)
      .map((definition) => [definition.type, normalizedCandidate[definition.type]])
  ) as Partial<EmailTemplateSettings>;

  let stored: unknown = cloneDefaultTemplates();
  if (storedRaw !== null) {
    try {
      stored = JSON.parse(storedRaw) as unknown;
    } catch {
      throw new EmailTemplateStoredStateError("Las plantillas guardadas deben volver a cargarse.");
    }
  }
  if (!isRecord(stored)) {
    throw new EmailTemplateStoredStateError("Las plantillas guardadas deben volver a cargarse.");
  }
  try {
    return {
      patch,
      templates: normalizeEmailTemplateSettings({ ...stored, ...patch })
    };
  } catch (error) {
    if (error instanceof EmailTemplateValidationError) {
      throw new EmailTemplateStoredStateError("Las plantillas guardadas deben volver a cargarse.");
    }
    throw error;
  }
}

export function renderEmailTemplate(template: EmailTemplateValue, record: DteDocumentRecord): { subject: string; text: string; formattedText: string } {
  return renderEmailTemplateValue(template, placeholderValues(record));
}

export function renderEmailTemplateValue(
  template: EmailTemplateValue,
  values: Record<string, string>
): { subject: string; text: string; formattedText: string } {
  const subject = replacePlaceholders(template.subject, values);
  const formattedText = replacePlaceholders(
    template.body,
    Object.fromEntries(
      Object.entries(values).map(([token, value]) => [token, escapeEmailTemplateFormattingValue(value)])
    )
  );
  assertSafeEmailSubject(subject);
  return {
    subject,
    text: emailTemplatePlainText(formattedText),
    formattedText
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
  return Object.fromEntries(
    EMAIL_TEMPLATE_DEFINITIONS.map((definition) => [
      definition.type,
      { ...DEFAULT_EMAIL_TEMPLATES[definition.type] }
    ])
  ) as EmailTemplateSettings;
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

// Neutraliza los marcadores del formateador del operador dentro de texto suministrado
// por la persona donante, para que un nombre con `*` o una línea que empiece con `>` no
// se interprete como formato en un correo con valor fiscal.
export function escapeEmailTemplateFormattingValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("*", "\\*")
    .replaceAll("+", "\\+")
    .replace(/^(\s*)>/gm, "$1\\>");
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
