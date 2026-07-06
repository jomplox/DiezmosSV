import { describe, expect, it } from "vitest";
import { auditActionLabel, auditActorLabel, auditLocationLabel, auditProtocolLabel, catalogOptionLabel, donationIntentStatusLabel, environmentLabel, parseAuditContext, roleLabel, statusLabel, userFacingErrorMessage } from "../../src/client/displayText";

describe("client display text", () => {
  it("localizes internal status values for user-facing badges", () => {
    expect(statusLabel("ACCEPTED")).toBe("Aceptado");
    expect(statusLabel("INVALIDATED")).toBe("Invalidado");
    expect(statusLabel("CONTINGENCY_PENDING")).toBe("Contingencia");
    // Transmisión diferida: MH no disponible al emitir, reintento automático.
    expect(statusLabel("TRANSMISSION_PENDING")).toBe("En trámite");
    expect(statusLabel("EVENT_ACCEPTED")).toBe("Evento aceptado");
    expect(statusLabel("BATCH_SENT")).toBe("Lote enviado");
  });

  it("localizes roles and environments without changing stored values", () => {
    expect(roleLabel("VIEWER")).toBe("Consulta");
    expect(roleLabel("OPERATOR")).toBe("Operador");
    expect(roleLabel("ADMIN")).toBe("Administrador");
    expect(roleLabel("OWNER")).toBe("Propietario");
    expect(environmentLabel("01")).toBe("Producción");
  });

  it("localizes audit action codes and common backend errors", () => {
    expect(auditActionLabel("USER_PASSWORD_RESET")).toBe("Contraseña restablecida");
    expect(auditActionLabel("LOGIN_FAILED")).toBe("Inicio de sesión fallido");
    expect(auditActionLabel("PASSWORD_RESET_THROTTLED")).toBe("Restablecimiento limitado por intentos");
    expect(auditActionLabel("DTE_INVALIDATION_REJECTED")).toBe("Invalidación rechazada");
    expect(auditActionLabel("QUICK_CDE_CREATED")).toBe("CDE rápido creado");
    expect(auditActionLabel("EMAIL_INVALIDATION_SENT")).toBe("Aviso de invalidación enviado");
    expect(auditActionLabel("EMAIL_INVALIDATION_FAILED")).toBe("Aviso de invalidación fallido");
    expect(auditActionLabel("EMAIL_TEMPLATES_UPDATED")).toBe("Plantillas de correo actualizadas");
    expect(auditActionLabel("EMISSION_ENVIRONMENT_UPDATED")).toBe("Ambiente de emisión actualizado");
    expect(auditActionLabel("CLOUDFLARE_WRITER_ENABLED")).toBe("Edición de secretos desde UI habilitada");
    expect(auditActionLabel("ISSUANCE_DEAD_LETTERED")).toBe("Emisión agotó reintentos en cola");
    expect(auditActionLabel("WOMPI_EVENT_REQUEUED")).toBe("Evento Wompi reencolado");
    expect(auditActionLabel("WOMPI_EVENT_STALLED")).toBe("Evento Wompi sin procesar — revisar");
    expect(auditActionLabel("ALERT_EMAIL_UPDATED")).toBe("Correo de alertas actualizado");
    expect(auditActionLabel("DTE_TRANSMISSION_DEFERRED")).toBe("Transmisión diferida");
    expect(auditActionLabel("ALERT_SENT:MH_UNAVAILABLE")).toBe("Alerta enviada: Hacienda no disponible");
    expect(auditActionLabel("ALERT_SENT:DTE_FAILED")).toBe("Alerta enviada: DTE fallido");
    expect(auditActionLabel("ALERT_SENT:ADVANCED_CDE_FAILED")).toBe("Alerta enviada: CDE avanzado fallido");
    expect(auditActionLabel("ALERT_SENT:CONTINGENCY_OPENED")).toBe("Alerta enviada: Contingencia abierta");
    expect(auditActionLabel("ALERT_SENT:ISSUANCE_DEAD_LETTERED")).toBe("Alerta enviada: Emisión agotó reintentos en cola");
    expect(auditActionLabel("ALERT_SENT:WOMPI_EVENT_STALLED")).toBe("Alerta enviada: Evento Wompi sin procesar — revisar");
    expect(auditActionLabel("ALERT_SENT:CERT_EXPIRING")).toBe("Alerta enviada: Certificado por vencer");
    expect(auditActionLabel("ALERT_FAILED:DTE_FAILED")).toBe("Alerta fallida: DTE fallido");
    expect(auditActionLabel("RETENTION_EXPORT_COMPLETED")).toBe("Exportación de retención completada");
    expect(auditActionLabel("RETENTION_EXPORT_SKIPPED")).toBe("Exportación de retención omitida");
    expect(auditActionLabel("RETENTION_EXPORT_FAILED")).toBe("Exportación de retención fallida");
    expect(auditActionLabel("RETENTION_EXPORT_REQUESTED")).toBe("Exportación de retención solicitada");
    expect(userFacingErrorMessage("Invalid credentials")).toBe("Correo o contraseña incorrectos.");
    expect(userFacingErrorMessage("Credenciales inválidas")).toBe("Correo o contraseña incorrectos.");
    expect(userFacingErrorMessage("MH auth failed")).toBe("Falló la autenticación con el Ministerio de Hacienda.");
    expect(userFacingErrorMessage("MH unavailable")).toBe("El Ministerio de Hacienda no está disponible.");
    expect(userFacingErrorMessage("MH auth failed: 401")).toBe("Falló la autenticación con el Ministerio de Hacienda: 401");
    expect(userFacingErrorMessage("MH unavailable: 503")).toBe("El Ministerio de Hacienda no está disponible: 503");
    expect(userFacingErrorMessage("Cloudflare EMAIL binding or EMAIL_API_URL and EMAIL_API_KEY are required when mock mode is disabled")).toBe("Configure el servicio de correo antes de enviar comprobantes.");
  });

  it("localizes donation-intent status values in Spanish", () => {
    expect(donationIntentStatusLabel("PENDING")).toBe("Pendiente");
    expect(donationIntentStatusLabel("LINK_CREATED")).toBe("Enlace creado");
    expect(donationIntentStatusLabel("COMPLETED")).toBe("Completada");
    expect(donationIntentStatusLabel("EXPIRED")).toBe("Vencida");
  });

  it("normalizes catalog option capitalization without changing acronyms", () => {
    expect(catalogOptionLabel("SAN SALVADOR ESTE")).toBe("San Salvador Este");
    expect(catalogOptionLabel("AGUILARES")).toBe("Aguilares");
    expect(catalogOptionLabel("NIT")).toBe("NIT");
    expect(catalogOptionLabel("Médico (solo aplica para contribuyentes obligados a la presentación de F-958)")).toBe("Médico (Solo Aplica para Contribuyentes Obligados a la Presentación de F-958)");
  });

  it("resolves the audit actor with a name/email/id fallback and Sistema for SYSTEM rows", () => {
    expect(auditActorLabel({ actor_type: "USER", actor_id: "u1", actor_name: "Ada Admin", actor_email: "ada@example.org" })).toBe("Ada Admin");
    expect(auditActorLabel({ actor_type: "USER", actor_id: "u1", actor_name: null, actor_email: "ada@example.org" })).toBe("ada@example.org");
    expect(auditActorLabel({ actor_type: "USER", actor_id: "user_abcdefghijklmnop", actor_name: null, actor_email: null })).toBe("user_abcdefg…");
    expect(auditActorLabel({ actor_type: "SYSTEM", actor_id: null, actor_name: null, actor_email: null })).toBe("Sistema");
  });

  it("parses the actor context blob defensively and formats location/protocol", () => {
    const context = parseAuditContext(JSON.stringify({ city: "San Salvador", country: "SV", tlsVersion: "TLSv1.3", httpProtocol: "HTTP/2" }));
    expect(auditLocationLabel(context)).toBe("San Salvador, SV");
    expect(auditProtocolLabel(context)).toBe("TLSv1.3 · HTTP/2");
    expect(parseAuditContext(null)).toBeNull();
    expect(parseAuditContext("not-json")).toBeNull();
    expect(auditLocationLabel(parseAuditContext(JSON.stringify({ country: "SV" })))).toBe("SV");
  });
});
