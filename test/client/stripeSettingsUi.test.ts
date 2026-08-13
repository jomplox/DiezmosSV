import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { credentialSettingsSections } from "../../src/client/credentialSettings";

const panelSource = readFileSync(resolve(import.meta.dirname, "../../src/client/credentialsPanel.tsx"), "utf8");
const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");

describe("Stripe owner settings UI", () => {
  test("registers Stripe EE. UU. in the existing configuration navigation", () => {
    expect(credentialSettingsSections).toContainEqual(expect.objectContaining({
      id: "stripe",
      label: "Stripe EE. UU.",
      groupIds: ["stripe"]
    }));
  });

  test("keeps credentials write-only while organization fields and timezone are directly editable", () => {
    for (const label of [
      "Clave restringida", "Clave publicable", "Configuración de métodos de entrega",
      "Configuración del portal", "Nombre legal", "EIN", "Zona horaria",
      "Teléfono de la organización", "Sitio web", "Dirección postal",
      "Nombre del firmante autorizado", "Cargo del firmante autorizado"
    ]) {
      expect(panelSource).toContain(label);
    }
    expect(panelSource).toContain('value={input.stripeTimeZone}');
    expect(panelSource).toContain('value={input.stripeOrganizationPhone}');
    expect(panelSource).toContain('value={input.stripeOrganizationWebsite}');
    expect(panelSource).toContain('value={input.stripeOrganizationMailingAddress}');
    expect(panelSource).toContain('value={input.stripeSignerName}');
    expect(panelSource).toContain('value={input.stripeSignerTitle}');
    expect(panelSource).toContain('name="stripe-webhook-secret-next"');
    expect(panelSource).not.toContain('name="stripe-webhook-secret-active"');
    expect(panelSource).toContain("Las credenciales y secretos de reemplazo nunca se precargan");
  });

  test("shows operational mode, safe webhook health, and a copyable endpoint", () => {
    expect(panelSource).toContain('new URL("/webhooks/stripe", window.location.origin)');
    expect(panelSource).toContain("Copiar URL del webhook de Stripe");
    expect(panelSource).toContain("Sin eventos recibidos");
    expect(panelSource).toContain("Verificado por último evento procesado");
    expect(panelSource).toContain("No verificado por la aplicación");
    expect(panelSource).toContain("livemodeMatches");
  });

  test("offers explicit stage, promote, and cancel controls without Payment Method toggles", () => {
    expect(panelSource).toContain("Preparar secreto siguiente");
    expect(panelSource).toContain("Promover secreto preparado");
    expect(panelSource).toContain("Cancelar secreto preparado");
    expect(panelSource).toContain("Stripe Dashboard Payment Method Configuration");
    expect(panelSource).toContain("BNPL");
    expect(panelSource).not.toContain("stripeBnplEnabled");
  });

  test("wires owner-only endpoints and clears replacements after successful saves", () => {
    expect(appSource).toContain('"/api/settings/stripe"');
    expect(appSource).toContain('"/api/settings/stripe/webhook-secret/stage"');
    expect(appSource).toContain('"/api/settings/stripe/webhook-secret/promote"');
    expect(appSource).toContain('"/api/settings/stripe/webhook-secret/cancel"');
    expect(appSource).toContain("emptyStripeCredentialInput()");
    expect(appSource).toContain("organizationPhone: credentialInput.stripeOrganizationPhone");
    expect(appSource).toContain("organizationWebsite: credentialInput.stripeOrganizationWebsite");
    expect(appSource).toContain("organizationMailingAddress: credentialInput.stripeOrganizationMailingAddress");
    expect(appSource).toContain("signerName: credentialInput.stripeSignerName");
    expect(appSource).toContain("signerTitle: credentialInput.stripeSignerTitle");
  });
});
