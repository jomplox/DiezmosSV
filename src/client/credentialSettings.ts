import { formatElSalvadorDate } from "../shared/legalWindows";
import type { CredentialStatus } from "./types";

type CertificateExpiryTone = "ok" | "warning" | "expired" | "pending";

export interface CertificateExpiryStatus {
  tone: CertificateExpiryTone;
  label: string;
}

const CERTIFICATE_EXPIRY_WARNING_DAYS = 60;
const CERTIFICATE_EXPIRY_CRITICAL_DAYS = 14;

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
