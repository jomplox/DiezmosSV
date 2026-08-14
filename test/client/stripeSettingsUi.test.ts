import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import { credentialSettingsSections } from "../../src/client/credentialSettings";
import { userFacingErrorMessage } from "../../src/client/displayText";

const panelSource = readFileSync(resolve(import.meta.dirname, "../../src/client/credentialsPanel.tsx"), "utf8");
const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");
const credentialsServiceSource = readFileSync(
  resolve(import.meta.dirname, "../../src/worker/services/credentials.ts"),
  "utf8"
);

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

  test("names the emptied field in Spanish instead of showing the raw rejection code", () => {
    const codes = Array.from(
      credentialsServiceSource.matchAll(/blankCode: "([a-z_]+)"/g),
      (match) => match[1]
    );

    expect(codes).toEqual([
      "blank_us_legal_name",
      "blank_us_ein",
      "blank_us_time_zone",
      "blank_us_phone",
      "blank_us_website",
      "blank_us_mailing_address",
      "blank_us_signer_name",
      "blank_us_signer_title"
    ]);
    for (const code of codes) {
      expect(userFacingErrorMessage(code)).toMatch(/no puede quedar vací[oa]\.$/u);
    }
    expect(userFacingErrorMessage("blank_us_legal_name")).toBe("El nombre legal no puede quedar vacío.");
    expect(userFacingErrorMessage("blank_us_signer_title")).toBe("El cargo del firmante autorizado no puede quedar vacío.");
  });

  test("tells the owner that an unedited save has nothing to write", () => {
    expect(userFacingErrorMessage("no_stripe_credentials_supplied")).toBe("No hay cambios que guardar.");
  });

  test("keeps the prefilled organization values across form resets that do not refetch them", () => {
    // Los dos reinicios que ocurren con el panel abierto — cambio de ambiente de
    // emisión y guardado de secretos del MH — vaciarían los ocho campos y el
    // siguiente guardado de Stripe los enviaría en blanco.
    expect(appSource).toContain("...emptyCredentialInput(credentialEnvironment),");
    expect(appSource).toContain("...emptyCredentialInput(current.environment),");
    expect(appSource).not.toContain("setCredentialInput(emptyCredentialInput(credentialInput.environment))");
    expect(appSource.match(/\.\.\.preservedStripeOrganizationInput\(current\)/g)).toHaveLength(2);
    for (const field of [
      "stripeLegalName", "stripeEin", "stripeTimeZone", "stripeOrganizationPhone",
      "stripeOrganizationWebsite", "stripeOrganizationMailingAddress",
      "stripeSignerName", "stripeSignerTitle"
    ]) {
      expect(appSource).toContain(`${field}: current.${field}`);
    }
  });
});
