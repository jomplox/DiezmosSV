import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { CredentialStatus } from "../../src/client/types";
import { certificateExpiryStatus, credentialSectionState, credentialSettingsSections } from "../../src/client/credentialSettings";

const credentialsPanelSource = readFileSync(resolve(import.meta.dirname, "../../src/client/credentialsPanel.tsx"), "utf8");
const appSource = readFileSync(resolve(import.meta.dirname, "../../src/client/App.tsx"), "utf8");

const status: CredentialStatus = {
  target: {
    appEnv: "staging",
    scriptName: "diezmossv-staging-example",
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
  },
  certificateExpiresAt: null
};

describe("credentialSectionState", () => {
  test("combines Ministerio de Hacienda API and signer credentials into one navigation section", () => {
    expect(credentialSettingsSections.find((section) => section.id === "mh")).toMatchObject({
      label: "Ministerio de Hacienda",
      description: "API, certificado firmador y llave privada.",
      groupIds: ["signer"]
    });
    expect(credentialSettingsSections.find((section) => section.label.includes("Firmador"))).toBeUndefined();
  });

  test("returns unknown (no badge) before the status has loaded", () => {
    // On first load the credential status is still in flight; PENDIENTE flashing to
    // LISTO reads as the UI being wrong. No status -> no badge, for every section.
    expect(credentialSectionState("mh", null)).toBe("unknown");
    // Even neutral sections show nothing until the panel has data to stand on.
    expect(credentialSectionState("ambiente", null)).toBe("unknown");
    expect(credentialSectionState("marca", null)).toBe("unknown");
  });

  test("marks neutral sections as ready because they do not map to a secret group", () => {
    expect(credentialSectionState("ambiente", status)).toBe("ready");
    expect(credentialSectionState("plantillas", status)).toBe("ready");
    expect(credentialSectionState("marca", status)).toBe("ready");
  });

  test("registers a white-label branding section", () => {
    expect(credentialSettingsSections.find((section) => section.id === "marca")).toMatchObject({
      label: "Marca"
    });
  });

  test("uses only the deployment-compatible MH lane for readiness", () => {
    expect(credentialSectionState("mh", status)).toBe("ready");
    expect(credentialSectionState("mh", {
      ...status,
      target: { ...status.target, appEnv: "production" },
      groups: {
        ...status.groups,
        mhTest: { ...status.groups.mhTest, ready: false },
        mhProduction: { ...status.groups.mhProduction, ready: true }
      }
    })).toBe("ready");
  });

  test("keeps MH readiness pending for a missing or unknown deployment lane", () => {
    expect(credentialSectionState("mh", {
      ...status,
      target: { ...status.target, appEnv: "preview" }
    })).toBe("pending");
  });

  test("marks a section pending when a mapped compatible secret group is not ready", () => {
    expect(credentialSectionState("correo", status)).toBe("pending");
  });

  test("marks a section ready when all mapped secret groups are ready", () => {
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
  test("computes the certificate expiry status from the credentials status field and renders it inside the Ministerio de Hacienda section", () => {
    expect(credentialsPanelSource).toContain("certificateExpiryStatus(status?.certificateExpiresAt ?? null)");
    expect(credentialsPanelSource).toContain("<h3>Firmador del Ministerio de Hacienda</h3>");
    expect(credentialsPanelSource).toContain("<h3>Credenciales API del Ministerio de Hacienda ({activeEnvironmentLabel})</h3>");
    expect(credentialsPanelSource).toContain("className={`legal-box ${certificateExpiry.tone} span-2`}");
    expect(credentialsPanelSource).toContain("<strong>{certificateExpiry.label}</strong>");
  });
});

describe("Emisor code field helper text (source contract)", () => {
  test("explains each similar establishment and point-of-sale code field", () => {
    expect(credentialsPanelSource).toContain("Identificador oficial del establecimiento autorizado por el Ministerio de Hacienda.");
    expect(credentialsPanelSource).toContain("Identificador oficial del punto de venta o terminal reconocido por el Ministerio de Hacienda.");
    expect(credentialsPanelSource).toContain("Código propio del emisor para agrupar documentos por sede interna; puede coincidir con el código MH si no manejan otro.");
    expect(credentialsPanelSource).toContain("Código propio del emisor para la caja, terminal o flujo interno que genera el CDE; no reemplaza el código MH.");
    expect(credentialsPanelSource).toContain("Prefijo usado para construir el número de control del CDE; normalmente combina establecimiento y punto de venta internos.");
  });

  test("treats the active issuer configuration as replacement-only", () => {
    expect(credentialsPanelSource).not.toContain('credentialItem(status, "EMISOR_CONFIG_JSON")?.displayValue');
    expect(credentialsPanelSource).not.toContain("Datos activos cargados en campos editables");
    expect(credentialsPanelSource).toContain("Configuración protegida; complete todos los campos para reemplazarla");
  });
});

describe("Correo alert recipients (source contract)", () => {
  test("allows multiple operational alert recipients separated by commas", () => {
    expect(credentialsPanelSource).toContain("Correos para avisos operativos");
    expect(credentialsPanelSource).toContain('placeholder="admin@example.org, soporte@example.org"');
    expect(credentialsPanelSource).toContain('type="email"');
    expect(credentialsPanelSource).toContain("multiple");
    expect(credentialsPanelSource).toContain("Separe varios correos con una sola coma (,).");
    expect(credentialsPanelSource).toContain("Guardar correos de alertas");
  });
});

describe("Correo provider destination authority (source contract)", () => {
  test("shows the provider destination as deployment-managed and not editable", () => {
    expect(credentialsPanelSource).toContain("EMAIL_PROVIDER_URL");
    expect(credentialsPanelSource).toContain("Administrado por el despliegue");
    expect(credentialsPanelSource).not.toContain("input.emailApiUrl");
    expect(credentialsPanelSource).not.toContain("EMAIL_API_URL");
  });

  test("offers independently saved visible sender and Reply-To fields in the Correo settings section", () => {
    expect(credentialsPanelSource).toContain("Nombre visible del remitente");
    expect(credentialsPanelSource).toContain("Correo para recibir respuestas (Reply-To)");
    expect(credentialsPanelSource).toContain('value={emailReplyToDraft}');
    expect(credentialsPanelSource).toContain('type="email"');
    expect(credentialsPanelSource).toContain("Déjelo vacío para que las respuestas lleguen al correo remitente activo.");
    expect(credentialsPanelSource).toContain("Guardar remitente");
    expect(credentialsPanelSource).toContain("onEmailSenderSubmit");
    expect(credentialsPanelSource).toContain("Dirección activa:");
    expect(credentialsPanelSource).toContain("maxLength={80}");
  });

  test("saves the visible sender instead of the surrounding secrets form when Enter is pressed", () => {
    const senderField = credentialsPanelSource.slice(
      credentialsPanelSource.indexOf('value={emailSenderDraft}'),
      credentialsPanelSource.indexOf('placeholder="Nombre que verán los destinatarios"') + 80
    );

    expect(senderField).toContain("onKeyDown");
    expect(senderField).toContain('event.key === "Enter"');
    expect(senderField).toContain("event.preventDefault()");
    expect(senderField).toContain("onEmailSenderSubmit()");
  });

  test("submits the Reply-To draft with the visible sender identity", () => {
    const updateEmailSender = appSource.slice(
      appSource.indexOf("async function updateEmailSender()"),
      appSource.indexOf("async function bootstrapCredentialWriter")
    );

    expect(updateEmailSender).toContain("senderName: emailSenderDraft");
    expect(updateEmailSender).toContain("replyToAddress: emailReplyToDraft");
    expect(updateEmailSender).toContain("applyEmailSender(result.emailSender)");
  });

  test("refreshes the sender identity after EMAIL_FROM credentials are saved", () => {
    const updateCredentials = appSource.slice(
      appSource.indexOf("async function updateCredentials()"),
      appSource.indexOf("async function updateEmissionEnvironment")
    );

    expect(updateCredentials).toContain('accountApi<{ emailSender: EmailSenderState }>("/api/settings/email-sender")');
    expect(updateCredentials).toContain("applyEmailSender(emailSenderResult.emailSender)");
  });

  test("refreshes the sender fallback after branding text is saved", () => {
    const brandingSaveHandler = appSource.slice(
      appSource.indexOf("onBrandingSave={(next) =>"),
      appSource.indexOf("onBootstrapWriter=", appSource.indexOf("onBrandingSave={(next) =>"))
    );

    expect(brandingSaveHandler).toContain('accountApi<{ emailSender: EmailSenderState }>("/api/settings/email-sender")');
    expect(brandingSaveHandler).toContain("applyEmailSender(emailSenderResult.emailSender)");
  });
});

describe("Ambiente emission-environment save guard (source contract)", () => {
  test("rejects deployment-incompatible choices and only short-circuits a matching persisted setting", () => {
    expect(credentialsPanelSource).toContain("!emissionEnvironment?.allowedEnvironments.includes(environment)");
    expect(credentialsPanelSource).toContain('emissionEnvironment.environment === environment && emissionEnvironment.source === "setting"');
    expect(credentialsPanelSource).not.toContain("if (emissionBusy || runtimeEnvironment.environment === environment) return;");
  });
});
