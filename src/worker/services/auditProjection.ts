import type { Role } from "./auth";

const SAFE_ACTION_SUMMARIES: Record<string, string> = {
  ALERT_EMAIL_UPDATED: "Correo de alertas actualizado",
  OWNER_BOOTSTRAPPED: "Cuenta propietaria creada",
  LOGIN: "Inicio de sesión",
  LOGIN_FAILED: "Intento de inicio de sesión fallido",
  PASSWORD_RESET_REQUESTED: "Restablecimiento de contraseña solicitado",
  PASSWORD_RESET_THROTTLED: "Solicitud de restablecimiento limitada",
  PASSWORD_RESET_EMAIL_FAILED: "No se pudo enviar el restablecimiento",
  PASSWORD_RESET_COMPLETED: "Contraseña restablecida",
  USER_CREATED: "Usuario creado",
  USER_UPDATED: "Usuario actualizado",
  USER_PASSWORD_RESET: "Contraseña de usuario restablecida"
};

export function hasAccountAuditAudience(role: Role): boolean {
  return role === "ADMIN" || role === "OWNER";
}

export function projectAuditRows(rows: Array<Record<string, unknown>>, role: Role): Array<Record<string, unknown>> {
  if (hasAccountAuditAudience(role)) {
    return rows;
  }
  return rows.map((row) => ({
    id: row.id,
    actor_type: row.actor_type,
    actor_id: null,
    actor_name: null,
    actor_email: null,
    actor_ip: null,
    actor_context: null,
    action: row.action,
    entity_type: row.entity_type,
    entity_id: row.entity_type === "user" ? null : row.entity_id,
    summary:
      SAFE_ACTION_SUMMARIES[String(row.action)] ??
      (row.entity_type === "user" ? "Actividad de cuenta registrada" : "Actividad registrada"),
    metadata_json: "{}",
    created_at: row.created_at
  }));
}

export function projectContingencyEvents(rows: Array<Record<string, unknown>>, role: Role): Array<Record<string, unknown>> {
  if (hasAccountAuditAudience(role)) {
    return rows;
  }
  return rows.map(({ created_by: _createdBy, ...event }) => event);
}
