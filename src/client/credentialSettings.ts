import type { CredentialStatus } from "./types";

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
    label: "MH API",
    description: "Usuario y contraseña de Hacienda.",
    groupIds: ["mhTest", "mhProduction"]
  },
  {
    id: "firmador",
    label: "Firmador MH",
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
