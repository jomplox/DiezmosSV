import { describe, expect, it } from "vitest";
import { auditActionLabel, catalogOptionLabel, environmentLabel, roleLabel, statusLabel, userFacingErrorMessage } from "../../src/client/displayText";

describe("client display text", () => {
  it("localizes internal status values for user-facing badges", () => {
    expect(statusLabel("ACCEPTED")).toBe("Aceptado");
    expect(statusLabel("INVALIDATED")).toBe("Invalidado");
    expect(statusLabel("CONTINGENCY_PENDING")).toBe("Contingencia");
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
    expect(auditActionLabel("DTE_INVALIDATION_REJECTED")).toBe("Invalidación rechazada");
    expect(auditActionLabel("QUICK_CDE_CREATED")).toBe("CDE rápido creado");
    expect(auditActionLabel("EMAIL_INVALIDATION_SENT")).toBe("Aviso de invalidación enviado");
    expect(auditActionLabel("EMAIL_INVALIDATION_FAILED")).toBe("Aviso de invalidación fallido");
    expect(auditActionLabel("EMAIL_TEMPLATES_UPDATED")).toBe("Plantillas de correo actualizadas");
    expect(auditActionLabel("EMISSION_ENVIRONMENT_UPDATED")).toBe("Ambiente de emisión actualizado");
    expect(auditActionLabel("CLOUDFLARE_WRITER_ENABLED")).toBe("Edición de secretos desde UI habilitada");
    expect(userFacingErrorMessage("Invalid credentials")).toBe("Correo o contraseña incorrectos.");
    expect(userFacingErrorMessage("Credenciales inválidas")).toBe("Correo o contraseña incorrectos.");
    expect(userFacingErrorMessage("MH auth failed")).toBe("Falló la autenticación con el Ministerio de Hacienda.");
    expect(userFacingErrorMessage("MH unavailable")).toBe("El Ministerio de Hacienda no está disponible.");
    expect(userFacingErrorMessage("MH auth failed: 401")).toBe("Falló la autenticación con el Ministerio de Hacienda: 401");
    expect(userFacingErrorMessage("MH unavailable: 503")).toBe("El Ministerio de Hacienda no está disponible: 503");
    expect(userFacingErrorMessage("Cloudflare EMAIL binding or EMAIL_API_URL and EMAIL_API_KEY are required when mock mode is disabled")).toBe("Configure el servicio de correo antes de enviar comprobantes.");
  });

  it("normalizes catalog option capitalization without changing acronyms", () => {
    expect(catalogOptionLabel("SAN SALVADOR ESTE")).toBe("San Salvador Este");
    expect(catalogOptionLabel("AGUILARES")).toBe("Aguilares");
    expect(catalogOptionLabel("NIT")).toBe("NIT");
    expect(catalogOptionLabel("Médico (solo aplica para contribuyentes obligados a la presentación de F-958)")).toBe("Médico (Solo Aplica para Contribuyentes Obligados a la Presentación de F-958)");
  });
});
