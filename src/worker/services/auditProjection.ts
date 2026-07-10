import type { Role } from "./auth";

const USER_ACTION_SUMMARIES: Record<string, string> = {
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

export function projectAuditRows(rows: Array<Record<string, unknown>>, role: Role): Array<Record<string, unknown>> {
  if (role === "ADMIN" || role === "OWNER") {
    return rows;
  }
  return rows.map((row) => {
    const projected: Record<string, unknown> = {
      ...row,
      actor_email: null,
      actor_ip: null,
      actor_context: null
    };
    if (row.entity_type === "user") {
      projected.actor_id = null;
      projected.actor_name = null;
      projected.entity_id = null;
      projected.summary = USER_ACTION_SUMMARIES[String(row.action)] ?? "Actividad de cuenta registrada";
      projected.metadata_json = "{}";
    }
    return projected;
  });
}
