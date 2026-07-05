import { formatElSalvadorDate } from "../shared/legalWindows";
import type { CredentialStatus } from "./types";

export type CertificateExpiryTone = "ok" | "warning" | "expired" | "pending";

export interface CertificateExpiryStatus {
  tone: CertificateExpiryTone;
  label: string;
}

const CERTIFICATE_EXPIRY_WARNING_DAYS = 60;
const CERTIFICATE_EXPIRY_CRITICAL_DAYS = 14;

export type CredentialSettingsSectionId =
  | "ambiente"
  | "mh"
  | "firmador"
  | "wompi"
  | "emisor"
  | "correo"
  | "plantillas";

export type CredentialSettingsSectionState = "ready" | "pending";

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
    label: "API del Ministerio de Hacienda",
    description: "Usuario y contraseña del Ministerio de Hacienda.",
    groupIds: ["mhTest", "mhProduction"]
  },
  {
    id: "firmador",
    label: "Firmador del Ministerio de Hacienda",
    description: "Certificado y llave privada.",
    groupIds: ["signer"]
  },
  {
    id: "wompi",
    label: "Wompi",
    description: "Webhook entrante de pagos.",
    groupIds: ["wompi"]
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
  }
];

export function credentialSectionState(
  sectionId: CredentialSettingsSectionId,
  status: CredentialStatus | null
): CredentialSettingsSectionState {
  const section = credentialSettingsSections.find((item) => item.id === sectionId);
  if (!section || section.groupIds.length === 0) {
    return "ready";
  }
  return section.groupIds.every((groupId) => status?.groups[groupId]?.ready) ? "ready" : "pending";
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
