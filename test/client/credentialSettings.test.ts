import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { CredentialStatus } from "../../src/client/types";
import { certificateExpiryStatus, credentialSectionState, credentialSettingsSections } from "../../src/client/credentialSettings";

const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");

const status: CredentialStatus = {
  target: {
    appEnv: "staging",
    scriptName: "diezmossv-staging-resource-example",
    writerConfigured: true,
    writerMissing: []
  },
  groups: {
    mhTest: {
      label: "MH ambiente de pruebas",
      ready: true,
      items: []
    },
    mhProduction: {
      label: "MH ambiente producción",
      ready: false,
      items: []
    },
    signer: {
      label: "Certificado firmador MH",
      ready: true,
      items: []
    },
    wompi: {
      label: "Webhook entrante de Wompi",
      ready: true,
      items: []
    },
    email: {
      label: "Correo",
      ready: false,
      items: []
    },
    issuer: {
      label: "Emisor",
      ready: true,
      items: []
    }
  }
};

describe("credentialSectionState", () => {
  test("spells out the tax authority in credential navigation labels", () => {
    expect(credentialSettingsSections.find((section) => section.id === "mh")).toMatchObject({
      label: "API del Ministerio de Hacienda",
      description: "Usuario y contraseña del Ministerio de Hacienda."
    });
    expect(credentialSettingsSections.find((section) => section.id === "firmador")).toMatchObject({
      label: "Firmador del Ministerio de Hacienda"
    });
  });

  test("marks neutral sections as ready because they do not map to a secret group", () => {
    expect(credentialSectionState("ambiente", status)).toBe("ready");
    expect(credentialSectionState("plantillas", status)).toBe("ready");
  });

  test("marks a section pending when any mapped secret group is not ready", () => {
    expect(credentialSectionState("mh", status)).toBe("pending");
    expect(credentialSectionState("correo", status)).toBe("pending");
  });

  test("marks a section ready when all mapped secret groups are ready", () => {
    expect(credentialSectionState("firmador", status)).toBe("ready");
    expect(credentialSectionState("wompi", status)).toBe("ready");
    expect(credentialSectionState("emisor", status)).toBe("ready");
  });
});

describe("certificateExpiryStatus", () => {
  const reference = new Date("2026-07-04T12:00:00.000Z");

  test("reports a neutral pending tone when no expiry is known", () => {
    expect(certificateExpiryStatus(null, reference)).toEqual({
      tone: "pending",
      label: "Vigencia del certificado desconocida."
    });
  });

  test("shows the expiry date in green tone when more than 60 days remain", () => {
    const expiresAt = new Date(reference.getTime() + 61 * 24 * 60 * 60 * 1000).toISOString();

    const status = certificateExpiryStatus(expiresAt, reference);

    expect(status.tone).toBe("ok");
    expect(status.label).toBe(`Vence el ${"03/09/2026"}`);
  });

  test("shows an amber countdown at exactly 60 days remaining", () => {
    const expiresAt = new Date(reference.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString();

    const status = certificateExpiryStatus(expiresAt, reference);

    expect(status.tone).toBe("warning");
    expect(status.label).toBe("Vence en 60 días");
  });

  test("shows a red countdown at exactly 14 days remaining", () => {
    const expiresAt = new Date(reference.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

    const status = certificateExpiryStatus(expiresAt, reference);

    expect(status.tone).toBe("expired");
    expect(status.label).toBe("Vence en 14 días");
  });

  test("shows a red VENCIDO label once the certificate has already expired", () => {
    const expiresAt = new Date(reference.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();

    const status = certificateExpiryStatus(expiresAt, reference);

    expect(status.tone).toBe("expired");
    expect(status.label).toBe("VENCIDO");
  });
});

describe("Firmador panel certificate expiry wiring (source contract)", () => {
  test("computes the certificate expiry status from the credentials status field and renders it in the Firmador section", () => {
    expect(appSource).toContain("certificateExpiryStatus(status?.certificateExpiresAt ?? null)");
    expect(appSource).toContain("<h3>Firmador del Ministerio de Hacienda</h3>");
    expect(appSource).toContain("className={`legal-box ${certificateExpiry.tone} span-2`}");
    expect(appSource).toContain("<strong>{certificateExpiry.label}</strong>");
  });
});
