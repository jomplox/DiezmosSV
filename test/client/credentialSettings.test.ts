import { describe, expect, test } from "vitest";
import type { CredentialStatus } from "../../src/client/types";
import { credentialSectionState } from "../../src/client/credentialSettings";

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
