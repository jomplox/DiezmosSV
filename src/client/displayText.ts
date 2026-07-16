import type { AuditActorContext, AuditRow } from "./types";

export type DisplayRole = "VIEWER" | "OPERATOR" | "ADMIN" | "OWNER";

const STATUS_LABELS: Record<string, string> = {
  ACCEPTED: "Aceptado",
  ACCEPTED_WITH_OBSERVATIONS: "Aceptado con observaciones",
  BATCH_SENT: "Lote enviado",
  CLOSED: "Cerrada",
  CONTINGENCY_PENDING: "Histórico sin sello",
  DRAFT: "Borrador",
  DONE: "Completado",
  EVENT_ACCEPTED: "Evento aceptado",
  EVENT_REJECTED: "Evento rechazado",
  FAILED: "Fallido",
  INVALIDATED: "Invalidado",
  LOCAL_ISSUED: "Emitido local",
  MANUAL_REVIEW: "Revisión manual",
  OPEN: "Abierta",
  PARTIAL: "Parcial",
  PENDING: "Pendiente",
  PROCESSING: "Procesando",
  REJECTED: "Rechazado",
  SENT: "Enviado",
  SIGNED: "Firmado",
  SUBMITTED: "Transmitido",
  // Transmisión diferida: MH no estaba disponible al emitir; el donante ya tiene su
  // comprobante transitorio y el cron reintenta cada 15 minutos.
  TRANSMISSION_PENDING: "En trámite"
};

// Donor-checkout intent lifecycle (donation_intents.status). Kept separate from
// STATUS_LABELS because PENDING is shared with the CDE lifecycle but reads
// differently for an online donation.
const DONATION_INTENT_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pendiente",
  LINK_CREATED: "Enlace creado",
  COMPLETED: "Completada",
  EXPIRED: "Vencida"
};

const ROLE_LABELS: Record<DisplayRole, string> = {
  VIEWER: "Consulta",
  OPERATOR: "Operador",
  ADMIN: "Administrador",
  OWNER: "Propietario"
};

const AUDIT_ACTION_LABELS: Record<string, string> = {
  BRANDING_UPDATED: "Marca actualizada",
  BRANDING_LOGO_UPDATED: "Logo de marca actualizado",
  BRANDING_LOGO_REMOVED: "Logo de marca eliminado",
  BRANDING_DONOR_LOGO_UPDATED: "Logo de donantes actualizado",
  BRANDING_DONOR_LOGO_REMOVED: "Logo de donantes eliminado",
  DONATION_INTENT_CREATED: "Intención de donación creada",
  DONATION_INTENT_DATOS_ATTACHED: "Datos fiscales adjuntados a la intención",
  DONATION_INTENT_COMPLETED: "Intención de donación completada",
  DONATION_INTENT_AMOUNT_MISMATCH: "Monto de la intención no coincide",
  DONOR_CERTIFICATES_RUN: "Envío de constancias anuales",
  ADVANCED_CDE_ACCEPTED: "CDE avanzado aceptado",
  ALERT_EMAIL_UPDATED: "Correo de alertas actualizado",
  ADVANCED_CDE_CREATED: "CDE avanzado creado",
  ADVANCED_CDE_FAILED: "CDE avanzado fallido",
  ADVANCED_CDE_REJECTED: "CDE avanzado rechazado",
  CERT_EXPIRING: "Certificado por vencer",
  CLOUDFLARE_WRITER_ENABLED: "Edición de secretos desde UI habilitada",
  CONTINGENCY_BATCH_SUBMITTED: "Lote histórico enviado",
  CONTINGENCY_DTE_ACCEPTED: "CDE histórico aceptado",
  CONTINGENCY_DTE_REJECTED: "CDE histórico rechazado",
  CONTINGENCY_OPEN_REUSED: "Periodo histórico reutilizado",
  CONTINGENCY_OPENED: "Periodo histórico abierto",
  CONTACTS_EXPORTED: "Exportación de contactos",
  CREDENTIALS_UPDATED: "Credenciales actualizadas",
  DTE_ACCEPTED: "DTE aceptado",
  DTE_CONTINGENCY_PENDING: "DTE histórico sin sello",
  DTE_EMAIL_UPDATED: "Correo de envío actualizado",
  DTE_FAILED: "DTE fallido",
  DTE_INVALIDATED: "DTE invalidado",
  DTE_INVALIDATION_REJECTED: "Invalidación rechazada",
  DTE_REJECTED: "DTE rechazado",
  DTE_RETRIED: "DTE reintentado",
  DTE_RETRY_ENQUEUED: "DTE en cola de reintento",
  // Transmisión diferida (MH no disponible al emitir; reintento automático cada 15 min).
  DTE_TRANSMISSION_DEFERRED: "Transmisión diferida",
  MH_UNAVAILABLE: "Hacienda no disponible",
  EMAIL_FAILED: "Correo fallido",
  EMAIL_INVALIDATION_FAILED: "Aviso de invalidación fallido",
  EMAIL_INVALIDATION_SENT: "Aviso de invalidación enviado",
  EMAIL_RESEND_FAILED: "Reenvío de correo fallido",
  EMAIL_RESENT: "Correo reenviado",
  EMAIL_SENT: "Correo enviado",
  EMAIL_SKIPPED: "Correo omitido",
  EMAIL_TEMPLATES_UPDATED: "Plantillas de correo actualizadas",
  EMISSION_ENVIRONMENT_UPDATED: "Ambiente de emisión actualizado",
  EXPORT_F960_CSV: "CSV F960 exportado",
  ISSUANCE_DEAD_LETTERED: "Emisión agotó reintentos en cola",
  EXPORT_F960_XLSX: "XLSX F960 exportado",
  LOGIN: "Inicio de sesión",
  LOGIN_FAILED: "Inicio de sesión fallido",
  OWNER_BOOTSTRAPPED: "Propietario inicial creado",
  PASSWORD_RESET_COMPLETED: "Contraseña restablecida por enlace",
  PASSWORD_RESET_EMAIL_FAILED: "Correo de restablecimiento fallido",
  PASSWORD_RESET_REQUESTED: "Restablecimiento de contraseña solicitado",
  PASSWORD_RESET_THROTTLED: "Restablecimiento limitado por intentos",
  QUICK_CDE_CREATED: "CDE rápido creado",
  RETENTION_DOWNLOADED: "Respaldo descargado",
  RETENTION_EXPORT_COMPLETED: "Exportación de retención completada",
  RETENTION_EXPORT_FAILED: "Exportación de retención fallida",
  RETENTION_EXPORT_REQUESTED: "Exportación de retención solicitada",
  RETENTION_EXPORT_SKIPPED: "Exportación de retención omitida",
  RETENTION_VERIFIED: "Respaldo verificado",
  RETENTION_VERIFY_FAILED: "Verificación de respaldo fallida",
  TEST_WOMPI_CREATED: "CDE rápido creado",
  TEST_WOMPI_DUPLICATE: "CDE rápido duplicado",
  USER_CREATED: "Usuario creado",
  USER_PASSWORD_RESET: "Contraseña restablecida",
  USER_UPDATED: "Usuario actualizado",
  WOMPI_DUPLICATE: "Wompi duplicado",
  WOMPI_EVENT_REQUEUED: "Evento Wompi reencolado",
  WOMPI_EVENT_STALLED: "Evento Wompi sin procesar — revisar",
  WOMPI_IGNORED: "Wompi ignorado",
  WOMPI_ISSUANCE_FAILED: "CDE no creado",
  WOMPI_ISSUANCE_RETRY_QUEUED: "Reintento de creación en cola",
  WOMPI_RECEIVED: "Wompi recibido"
};

const ENTITY_LABELS: Record<string, string> = {
  app_setting: "Configuración",
  contingency_period: "Contingencia",
  donation_intent: "Intención de donación",
  donor_certificate: "Constancia de donante",
  donor_certificate_run: "Envío de constancias",
  credentials: "Credenciales",
  dte_document: "Documento DTE",
  export: "Exportación",
  retention_export: "Exportación de retención",
  user: "Usuario",
  wompi_event: "Evento Wompi"
};

const ERROR_LABELS: Record<string, string> = {
  Authentication_required: "Debe iniciar sesión.",
  "Authentication required": "Debe iniciar sesión.",
  Cloudflare_EMAIL_binding_or_EMAIL_PROVIDER_URL_and_EMAIL_API_KEY_are_required_when_mock_mode_is_disabled: "Configure el servicio de correo antes de enviar comprobantes.",
  "Cloudflare EMAIL binding or EMAIL_PROVIDER_URL and EMAIL_API_KEY are required when mock mode is disabled": "Configure el servicio de correo antes de enviar comprobantes.",
  "Cloudflare secret writer is not configured for this Worker": "El escritor de secretos de Cloudflare no está configurado para este Worker.",
  bootstrap_token_required: "Ingrese el token de configuración.",
  "CDE resumen.valorTotal must be a positive number": "CDE resumen.valorTotal debe ser un número positivo.",
  credential_update_failed: "No se pudieron actualizar las credenciales.",
  email_send_failed: "No se pudo enviar el correo.",
  "MH auth failed": "Falló la autenticación con el Ministerio de Hacienda.",
  "MH unavailable": "El Ministerio de Hacienda no está disponible.",
  "Invalid credentials": "Correo o contraseña incorrectos.",
  "Credenciales inválidas": "Correo o contraseña incorrectos.",
  Insufficient_role: "Su usuario no tiene permisos suficientes.",
  "Insufficient role": "Su usuario no tiene permisos suficientes.",
  destination_address_is_not_a_verified_address: "La dirección de destino no está verificada en el proveedor de correo.",
  "destination address is not a verified address": "La dirección de destino no está verificada en el proveedor de correo.",
  document_not_accepted: "El DTE debe estar aceptado y sellado para esta acción.",
  document_not_retryable: "Este DTE no tiene fallos pendientes para reintentar.",
  invalid_advanced_cde: "CDE avanzado inválido.",
  invalid_advanced_template: "No se pudo preparar la plantilla avanzada.",
  invalid_contingency_environment: "Seleccione un ambiente de contingencia válido.",
  invalid_contingency_type: "Seleccione un tipo de contingencia válido.",
  invalid_credential_environment: "Seleccione un ambiente válido para las credenciales.",
  invalid_email: "Ingrese un correo válido.",
  invalid_export_filter: "Seleccione un filtro de exportación válido.",
  invalid_test_payload: "Revise los datos del CDE rápido.",
  invalid_wompi_hash: "Firma Wompi inválida.",
  method_not_allowed: "Método no permitido.",
  missing_email: "Este documento no tiene correo de envío.",
  no_credentials_supplied: "Ingrese al menos un secreto para actualizar.",
  not_found: "No se encontró el recurso solicitado.",
  outside_legal_window: "La ventana legal para invalidar este CDE ya venció.",
  replacement_required_for_tipo_1: "Para invalidar por error, primero emita el CDE de reemplazo e indique su código de generación.",
  test_generation_disabled_in_production: "La generación rápida no está habilitada en producción."
};

const CATALOG_UPPERCASE_TOKENS = new Set([
  "API",
  "CDE",
  "DTE",
  "DUI",
  "HTTP",
  "HTTPS",
  "IVA",
  "JSON",
  "MH",
  "NIT",
  "NRC",
  "PDF",
  "POST",
  "SV",
  "URL",
  "USD"
]);

const CATALOG_LOWERCASE_WORDS = new Set(["a", "al", "con", "de", "del", "e", "el", "en", "la", "las", "lo", "los", "o", "para", "por", "u", "y"]);

// Estado VISUAL de un CDE: la transmisión diferida se persiste como SIGNED +
// transmission_deferred_at (D1 no permite ampliar el CHECK de status en una tabla
// padre de FK), y la UI la presenta como el estado virtual TRANSMISSION_PENDING
// ("En trámite"). Un SIGNED plano — transitorio de pipeline, sin marcador — se
// sigue mostrando como Firmado.
export function documentDisplayStatus(document: { status: string; transmission_deferred_at?: string | null }): string {
  return document.status === "SIGNED" && document.transmission_deferred_at ? "TRANSMISSION_PENDING" : document.status;
}

export function statusLabel(status: string | null | undefined): string {
  if (!status) return "Sin estado";
  return STATUS_LABELS[status] ?? readableCode(status);
}

export function donationIntentStatusLabel(status: string | null | undefined): string {
  if (!status) return "Sin estado";
  return DONATION_INTENT_STATUS_LABELS[status] ?? readableCode(status);
}

export function roleLabel(role: string | null | undefined): string {
  if (!role) return "Sin rol";
  return ROLE_LABELS[role as DisplayRole] ?? readableCode(role);
}

export function environmentLabel(environment: "00" | "01" | string | null | undefined): string {
  if (environment === "01") return "Producción";
  if (environment === "00") return "Pruebas";
  return "—";
}

export function catalogOptionLabel(label: string): string {
  let startsPhrase = true;
  return label
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[A-Za-zÁÉÍÓÚÜÑáéíóúüñ0-9]+/g, (word, offset, text) => {
      const previous = text[offset - 1] ?? "";
      const startsSegment = startsPhrase || previous === "(" || previous === "/" || previous === "-";
      startsPhrase = false;
      return catalogWordLabel(word, startsSegment);
    });
}

export function auditActionLabel(action: string | null | undefined): string {
  if (!action) return "Acción";
  if (AUDIT_ACTION_LABELS[action]) return AUDIT_ACTION_LABELS[action];
  const alertSentKind = action.startsWith("ALERT_SENT:") ? action.slice("ALERT_SENT:".length) : null;
  if (alertSentKind) return `Alerta enviada: ${auditActionLabel(alertSentKind)}`;
  const alertFailedKind = action.startsWith("ALERT_FAILED:") ? action.slice("ALERT_FAILED:".length) : null;
  if (alertFailedKind) return `Alerta fallida: ${auditActionLabel(alertFailedKind)}`;
  return readableCode(action);
}

export function entityLabel(entity: string | null | undefined): string {
  if (!entity) return "Entidad";
  return ENTITY_LABELS[entity] ?? readableCode(entity);
}

export function auditSummaryLabel(summary: string | null | undefined): string {
  if (!summary) return "";
  if (summary === "Password reset by admin") return "Contraseña restablecida por administrador";
  if (summary === "User updated") return "Usuario actualizado";
  if (summary === "Retry queued") return "Reintento en cola";
  if (summary === "Document has no donor email") return "Documento sin correo del donante";
  if (summary.startsWith("Receipt sent to ")) return `Comprobante enviado a ${summary.slice("Receipt sent to ".length)}`;
  if (summary.startsWith("Resent to ")) return `Reenviado a ${summary.slice("Resent to ".length)}`;
  if (summary.startsWith("Delivery email updated to ")) return `Correo de envío actualizado a ${summary.slice("Delivery email updated to ".length)}`;
  if (summary.startsWith("Ignored Wompi result ")) return `Resultado Wompi ignorado: ${summary.slice("Ignored Wompi result ".length)}`;
  if (summary === "Updated test credential secrets") return "Secretos de pruebas actualizados";
  if (summary === "Updated production credential secrets") return "Secretos de producción actualizados";
  const exported = summary.match(/^(\d+) rows exported$/);
  if (exported) return `${exported[1]} filas exportadas`;
  return summary;
}

// Resolves the "Usuario" column: prefer the joined display name, then email, then a
// shortened actor id. SYSTEM rows (no actor) render as "Sistema".
export function auditActorLabel(row: Pick<AuditRow, "actor_type" | "actor_id" | "actor_name" | "actor_email">): string {
  if (row.actor_type !== "USER") return "Sistema";
  const name = row.actor_name?.trim();
  if (name) return name;
  const email = row.actor_email?.trim();
  if (email) return email;
  const id = row.actor_id?.trim();
  if (id) return id.length > 12 ? `${id.slice(0, 12)}…` : id;
  return "Usuario";
}

// Parses the stored actor_context JSON blob defensively; malformed/absent blobs
// (older rows predate migration 0013) yield null.
export function parseAuditContext(raw: string | null | undefined): AuditActorContext | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as AuditActorContext) : null;
  } catch {
    return null;
  }
}

// "San Salvador, SV" from city + country; falls back to whichever is present.
export function auditLocationLabel(context: AuditActorContext | null): string | null {
  if (!context) return null;
  const parts = [context.city?.trim(), context.country?.trim()].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(", ") : null;
}

// "TLSv1.3 · HTTP/2" style protocol summary for the context detail.
export function auditProtocolLabel(context: AuditActorContext | null): string | null {
  if (!context) return null;
  const parts = [context.tlsVersion?.trim(), context.httpProtocol?.trim()].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

export const AUDIT_CONTEXT_LABELS = {
  location: "Ubicación",
  isp: "ISP",
  browser: "Navegador",
  protocol: "TLS/Protocolo",
  ip: "IP"
} as const;

export function userFacingErrorMessage(message: string): string {
  const cleaned = message.trim();
  if (!cleaned) return "Ocurrió un error.";
  if (ERROR_LABELS[cleaned]) return ERROR_LABELS[cleaned];
  if (ERROR_LABELS[cleaned.replaceAll(" ", "_")]) return ERROR_LABELS[cleaned.replaceAll(" ", "_")];
  if (cleaned.startsWith("Cloudflare secret update failed:")) {
    return `Falló la actualización de secretos en Cloudflare: ${cleaned.slice("Cloudflare secret update failed:".length).trim()}`;
  }
  if (cleaned.startsWith("Email provider failed:")) {
    return `Falló el proveedor de correo: ${cleaned.slice("Email provider failed:".length).trim()}`;
  }
  if (cleaned.startsWith("MH auth failed:")) {
    return `Falló la autenticación con el Ministerio de Hacienda: ${cleaned.slice("MH auth failed:".length).trim()}`;
  }
  if (cleaned.startsWith("Falló la autenticación con el Ministerio de Hacienda:")) {
    return cleaned;
  }
  if (cleaned.startsWith("MH unavailable:")) {
    return `El Ministerio de Hacienda no está disponible: ${cleaned.slice("MH unavailable:".length).trim()}`;
  }
  if (cleaned.startsWith("Ministerio de Hacienda no disponible:")) {
    return `El Ministerio de Hacienda no está disponible: ${cleaned.slice("Ministerio de Hacienda no disponible:".length).trim()}`;
  }
  if (cleaned.startsWith("Password must be at least 10 characters")) {
    return "La contraseña debe tener al menos 10 caracteres.";
  }
  if (cleaned.startsWith("Password must include an uppercase letter")) {
    return "La contraseña debe incluir una letra mayúscula.";
  }
  if (cleaned.startsWith("Password must include a lowercase letter")) {
    return "La contraseña debe incluir una letra minúscula.";
  }
  if (cleaned.startsWith("Password must include a number")) {
    return "La contraseña debe incluir un número.";
  }
  if (cleaned.startsWith("Password must include a symbol")) {
    return "La contraseña debe incluir un símbolo.";
  }
  return cleaned;
}

function readableCode(value: string): string {
  return value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/^\w| \w/g, (match) => match.toUpperCase());
}

function catalogWordLabel(word: string, startsSegment: boolean): string {
  const upper = word.toUpperCase();
  if (CATALOG_UPPERCASE_TOKENS.has(upper)) return upper;
  if (/^\d+$/.test(word)) return word;
  const lower = word.toLowerCase();
  if (!startsSegment && CATALOG_LOWERCASE_WORDS.has(lower)) return lower;
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
