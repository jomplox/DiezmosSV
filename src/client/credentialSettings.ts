import { formatElSalvadorDate } from "../shared/legalWindows";
import { createLatestRequestGate } from "./preCdeFailures";
import type { CredentialStatus, EmailTemplateValue, StripeSettingsState } from "./types";

type CertificateExpiryTone = "ok" | "warning" | "expired" | "pending";

export interface CertificateExpiryStatus {
  tone: CertificateExpiryTone;
  label: string;
}

const CERTIFICATE_EXPIRY_WARNING_DAYS = 60;
const CERTIFICATE_EXPIRY_CRITICAL_DAYS = 14;

export type StripeOrganizationConfiguration = StripeSettingsState["configuration"];
export type StripeOrganizationPatch = Partial<StripeOrganizationConfiguration>;

export const STRIPE_ORGANIZATION_FIELDS: Array<keyof StripeOrganizationConfiguration> = [
  "legalName",
  "ein",
  "timeZone",
  "organizationPhone",
  "organizationWebsite",
  "organizationMailingAddress",
  "signerName",
  "signerTitle"
];

const STRIPE_ORGANIZATION_SECRET_BY_FIELD: Record<
  keyof StripeOrganizationConfiguration,
  string
> = {
  legalName: "STRIPE_US_LEGAL_NAME",
  ein: "STRIPE_US_EIN",
  timeZone: "STRIPE_US_TIME_ZONE",
  organizationPhone: "STRIPE_US_PHONE",
  organizationWebsite: "STRIPE_US_WEBSITE",
  organizationMailingAddress: "STRIPE_US_MAILING_ADDRESS",
  signerName: "STRIPE_US_SIGNER_NAME",
  signerTitle: "STRIPE_US_SIGNER_TITLE"
};

export interface StripeOrganizationPendingWrite {
  values: StripeOrganizationPatch;
  savedAt: number;
}

export const STRIPE_ORGANIZATION_PENDING_WRITE_TTL_MS = 120_000;

export const createStripeSettingsRequestGate = createLatestRequestGate;

export function trimmedStripeOrganization(
  organization: Record<keyof StripeOrganizationConfiguration, string>
): StripeOrganizationConfiguration {
  return Object.fromEntries(
    STRIPE_ORGANIZATION_FIELDS.map((field) => [field, organization[field].trim()])
  ) as unknown as StripeOrganizationConfiguration;
}

export function stripeOrganizationDirtyPatch(
  organization: Record<keyof StripeOrganizationConfiguration, string>,
  baseline: StripeOrganizationConfiguration
): StripeOrganizationPatch {
  const submitted = trimmedStripeOrganization(organization);
  const patch: StripeOrganizationPatch = {};
  for (const field of STRIPE_ORGANIZATION_FIELDS) {
    if (submitted[field] !== baseline[field].trim()) {
      patch[field] = submitted[field];
    }
  }
  return patch;
}

export function stripeOrganizationPendingWrite(
  patch: StripeOrganizationPatch,
  updated: readonly string[],
  savedAt: number
): StripeOrganizationPendingWrite | null {
  const updatedNames = new Set(updated);
  const values: StripeOrganizationPatch = {};
  for (const field of STRIPE_ORGANIZATION_FIELDS) {
    if (patch[field] !== undefined && updatedNames.has(STRIPE_ORGANIZATION_SECRET_BY_FIELD[field])) {
      values[field] = patch[field];
    }
  }
  return Object.keys(values).length > 0 ? { values, savedAt } : null;
}

export function resolveStripeOrganizationHydration(
  configuration: StripeOrganizationConfiguration,
  pendingWrite: StripeOrganizationPendingWrite | null,
  now: number
): { configuration: StripeOrganizationConfiguration; pendingWrite: StripeOrganizationPendingWrite | null } {
  if (!pendingWrite) {
    return { configuration, pendingWrite: null };
  }
  if (now - pendingWrite.savedAt > STRIPE_ORGANIZATION_PENDING_WRITE_TTL_MS) {
    return { configuration, pendingWrite: null };
  }
  const pendingValues: StripeOrganizationPatch = {};
  const effective = { ...configuration };
  for (const field of STRIPE_ORGANIZATION_FIELDS) {
    const pendingValue = pendingWrite.values[field];
    if (pendingValue === undefined || configuration[field].trim() === pendingValue.trim()) {
      continue;
    }
    pendingValues[field] = pendingValue;
    effective[field] = pendingValue;
  }
  const pendingFields = Object.keys(pendingValues);
  if (pendingFields.length === 0) {
    return { configuration, pendingWrite: null };
  }
  return {
    configuration: effective,
    pendingWrite: pendingFields.length === Object.keys(pendingWrite.values).length
      ? pendingWrite
      : { ...pendingWrite, values: pendingValues }
  };
}

export function reconcileStripeOrganizationDraft(
  current: StripeOrganizationConfiguration,
  baseline: StripeOrganizationConfiguration,
  nextBaseline: StripeOrganizationConfiguration
): StripeOrganizationConfiguration {
  const reconciled = { ...nextBaseline };
  for (const field of STRIPE_ORGANIZATION_FIELDS) {
    if (current[field].trim() !== baseline[field].trim()) {
      reconciled[field] = current[field];
    }
  }
  return reconciled;
}

export function reconcileEmailTemplateDraft(
  current: Record<string, EmailTemplateValue>,
  requestDraft: Record<string, EmailTemplateValue>,
  server: Record<string, EmailTemplateValue>,
  baseline: Record<string, EmailTemplateValue>,
  submittedTypes: readonly string[]
): Record<string, EmailTemplateValue> {
  const reconciled = Object.fromEntries(
    Object.entries(current).map(([type, template]) => [type, { ...template }])
  );
  const submitted = new Set(submittedTypes);
  for (const [type, nextTemplate] of Object.entries(server)) {
    const currentTemplate = current[type];
    const requestedTemplate = requestDraft[type];
    const baselineTemplate = baseline[type];
    const preserveSubject = currentTemplate?.subject !== requestedTemplate?.subject
      || (!submitted.has(type) && requestedTemplate?.subject !== baselineTemplate?.subject);
    const preserveBody = currentTemplate?.body !== requestedTemplate?.body
      || (!submitted.has(type) && requestedTemplate?.body !== baselineTemplate?.body);
    reconciled[type] = {
      subject: preserveSubject
        ? currentTemplate?.subject ?? nextTemplate.subject
        : nextTemplate.subject,
      body: preserveBody
        ? currentTemplate?.body ?? nextTemplate.body
        : nextTemplate.body
    };
  }
  return reconciled;
}

export type CredentialSettingsSectionId =
  | "ambiente"
  | "mh"
  | "wompi"
  | "stripe"
  | "emisor"
  | "correo"
  | "plantillas"
  | "marca";

// "unknown" = the credential status has not loaded yet: the nav renders NO badge
// instead of a PENDIENTE that snaps to LISTO once the fetch lands.
export type CredentialSettingsSectionState = "ready" | "pending" | "unknown";

export interface CredentialSettingsSection {
  id: CredentialSettingsSectionId;
  label: string;
  description: string;
  groupIds: string[];
}

export const credentialSettingsSections: CredentialSettingsSection[] = [
  {
    id: "ambiente",
    label: "Ambiente",
    description: "Emisión activa y credenciales a editar.",
    groupIds: []
  },
  {
    id: "mh",
    label: "Ministerio de Hacienda",
    description: "API, certificado firmador y llave privada.",
    groupIds: ["signer"]
  },
  {
    id: "wompi",
    label: "Wompi",
    description: "Webhook entrante de pagos.",
    groupIds: ["wompi"]
  },
  {
    id: "stripe",
    label: "Stripe EE. UU.",
    description: "Configuración y salud del webhook de EE. UU.",
    groupIds: ["stripe"]
  },
  {
    id: "emisor",
    label: "Emisor",
    description: "Datos fiscales para construir CDE.",
    groupIds: ["issuer"]
  },
  {
    id: "correo",
    label: "Correo",
    description: "Cloudflare Email y respaldo HTTP.",
    groupIds: ["email"]
  },
  {
    id: "plantillas",
    label: "Plantillas",
    description: "Asunto y cuerpo de correos.",
    groupIds: []
  },
  {
    id: "marca",
    label: "Marca",
    description: "Nombre, color y logo de la organización.",
    groupIds: []
  }
];

export function credentialSectionState(
  sectionId: CredentialSettingsSectionId,
  status: CredentialStatus | null
): CredentialSettingsSectionState {
  if (!status) {
    return "unknown";
  }
  const section = credentialSettingsSections.find((item) => item.id === sectionId);
  if (!section || section.groupIds.length === 0) {
    return "ready";
  }
  const groupIds = [...section.groupIds];
  if (sectionId === "mh") {
    const mhGroupId = status.target.appEnv === "local" || status.target.appEnv === "staging"
      ? "mhTest"
      : status.target.appEnv === "production"
        ? "mhProduction"
        : null;
    if (!mhGroupId) {
      return "pending";
    }
    groupIds.unshift(mhGroupId);
  }
  return groupIds.every((groupId) => status.groups[groupId]?.ready) ? "ready" : "pending";
}

// Firmador status line thresholds: green (>60 días), amarillo (<=60 días),
// rojo (<=14 días o ya vencido). Reuses the legal-box tone vocabulary already
// used by the invalidation window banner.
export function certificateExpiryStatus(
  expiresAt: string | null,
  reference: Date = new Date()
): CertificateExpiryStatus {
  if (!expiresAt) {
    return { tone: "pending", label: "Vigencia del certificado desconocida." };
  }
  const remainingMs = new Date(expiresAt).getTime() - reference.getTime();
  if (remainingMs <= 0) {
    return { tone: "expired", label: "VENCIDO" };
  }
  const remainingDays = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  if (remainingDays <= CERTIFICATE_EXPIRY_CRITICAL_DAYS) {
    return { tone: "expired", label: `Vence en ${remainingDays} días` };
  }
  if (remainingDays <= CERTIFICATE_EXPIRY_WARNING_DAYS) {
    return { tone: "warning", label: `Vence en ${remainingDays} días` };
  }
  return { tone: "ok", label: `Vence el ${formatElSalvadorDate(expiresAt)}` };
}
