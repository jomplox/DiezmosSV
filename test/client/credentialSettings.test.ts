import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import type { CredentialStatus, EmailTemplateSettings, StripeSettingsState } from "../../src/client/types";
import {
  certificateExpiryStatus,
  credentialSectionState,
  credentialSettingsSections,
  reconcileStripeOrganizationDraft,
  resolveStripeOrganizationHydration,
  stripeOrganizationDirtyPatch,
  stripeOrganizationPendingWrite
} from "../../src/client/credentialSettings";
import { scopedEmailTemplates } from "../../src/client/credentialsPanel";

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
    },
    stripe: {
      label: "Stripe EE. UU.",
      ready: true,
      items: []
    }
  },
  certificateExpiresAt: null,
  stripeOperational: {
    appEnv: "staging",
    mode: "Pruebas",
    mockMode: false,
    localProxyConfigured: false
  }
};

const stripeOrganization: StripeSettingsState["configuration"] = {
  legalName: "Iglesia Elim USA",
  ein: "12-3456789",
  timeZone: "America/Chicago",
  organizationPhone: "+1 555 0100",
  organizationWebsite: "https://example.org",
  organizationMailingAddress: "1 Main St\nDallas, TX 75001",
  signerName: "Pastor",
  signerTitle: "Tesorero"
};

describe("Stripe organization owner reconciliation", () => {
  test("builds a trimmed patch containing only fields dirty from the authoritative baseline", () => {
    expect(stripeOrganizationDirtyPatch({
      ...stripeOrganization,
      legalName: "  Iglesia Elim USA  ",
      organizationPhone: "  +1 555 0199  "
    }, stripeOrganization)).toEqual({
      organizationPhone: "+1 555 0199"
    });

    expect(stripeOrganizationDirtyPatch(stripeOrganization, stripeOrganization)).toEqual({});
  });

  test("guards only dirty organization fields the server reports as updated", () => {
    expect(stripeOrganizationPendingWrite(
      {
        legalName: "Iglesia Elim USA Nueva",
        organizationPhone: "+1 555 0199"
      },
      ["STRIPE_RESTRICTED_KEY", "STRIPE_US_PHONE"],
      1_770_000_000_000
    )).toEqual({
      values: { organizationPhone: "+1 555 0199" },
      savedAt: 1_770_000_000_000
    });

    expect(stripeOrganizationPendingWrite(
      { legalName: "Iglesia Elim USA Nueva" },
      ["STRIPE_RESTRICTED_KEY"],
      1_770_000_000_000
    )).toBeNull();
  });

  test("expires partial pending values and replaces an untouched stale draft with the latest server value", () => {
    const pending = {
      values: { organizationPhone: "+1 555 0199" },
      savedAt: 1_770_000_000_000
    };
    const server = { ...stripeOrganization, organizationPhone: "+1 555 0177" };
    const current = { ...stripeOrganization, organizationPhone: "+1 555 0199" };
    const baseline = { ...stripeOrganization, organizationPhone: "+1 555 0199" };

    const resolved = resolveStripeOrganizationHydration(server, pending, 1_770_000_120_001);

    expect(resolved).toEqual({ configuration: server, pendingWrite: null });
    expect(reconcileStripeOrganizationDraft(current, baseline, resolved.configuration)).toEqual(server);
  });

  test("preserves a local edit made during refresh while accepting fresh untouched fields", () => {
    const current = { ...stripeOrganization, signerTitle: "Director ejecutivo" };
    const server = {
      ...stripeOrganization,
      organizationWebsite: "https://fresh.example.org",
      signerTitle: "Cargo remoto"
    };

    expect(reconcileStripeOrganizationDraft(current, stripeOrganization, server)).toEqual({
      ...server,
      signerTitle: "Director ejecutivo"
    });
  });
});

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
    expect(credentialSectionState("stripe", status)).toBe("ready");
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

describe("Stripe operational status loading (source contract)", () => {
  test("does not report the local proxy as unconfigured before Stripe settings load", () => {
    const start = credentialsPanelSource.indexOf("<span>Proxy local</span>");
    const proxyStatus = credentialsPanelSource.slice(
      start,
      credentialsPanelSource.indexOf("</div>", start)
    );

    expect(proxyStatus).toContain("stripeSettings ?");
    expect(proxyStatus).toContain('"Sin cargar"');
  });
});

describe("Ambiente emission-environment save guard (source contract)", () => {
  test("rejects deployment-incompatible choices and only short-circuits a matching persisted setting", () => {
    expect(credentialsPanelSource).toContain("!emissionEnvironment?.allowedEnvironments.includes(environment)");
    expect(credentialsPanelSource).toContain('emissionEnvironment.environment === environment && emissionEnvironment.source === "setting"');
    expect(credentialsPanelSource).not.toContain("if (emissionBusy || runtimeEnvironment.environment === environment) return;");
  });
});

describe("Plantillas country-scoped saving (source contract)", () => {
  test("each country button gates on its own group and submits only that group's drafts", () => {
    const editor = credentialsPanelSource.slice(
      credentialsPanelSource.indexOf("function EmailTemplateEditor({"),
      credentialsPanelSource.indexOf("export function isEmailTemplateScope(")
    );

    expect(editor).toContain("const groupComplete = (group: typeof definitions) => group.every(");
    expect(editor).toContain('disabled={busy || !salvadoranComplete} onClick={() => void onSubmit("SV_CDE")}');
    expect(editor).toContain('disabled={busy || !usComplete} onClick={() => void onSubmit("US_STRIPE")}');
    // Una sola compuerta global dejaría que un cuerpo vacío de EE. UU. bloqueara el
    // guardado salvadoreño sin explicar por qué.
    expect(editor).not.toContain("disabled={busy || !complete}");
  });

  test("declares the country on the PUT and sends only that country's templates", () => {
    // Rellenar el otro grupo con la copia cargada al abrir el panel revertía en silencio
    // lo que otro propietario hubiera guardado mientras tanto; ahora fusiona el servidor.
    const save = appSource.slice(
      appSource.indexOf("async function updateEmailTemplates("),
      appSource.indexOf("async function updateEmailSender(")
    );

    expect(save).toContain("body: { scope, templates: scopedEmailTemplates(emailTemplates, emailTemplateDraft, scope) }");
    expect(save).not.toContain("...(emailTemplates?.templates ?? {}),");
    expect(save).not.toContain("body: { templates: emailTemplateDraft }");
    // El editor y el envío deben particionar igual, o una plantilla visible en un grupo
    // quedaría fuera del guardado de ese grupo.
    expect(credentialsPanelSource).toContain('isEmailTemplateScope("SV_CDE", definition.scope)');
    expect(credentialsPanelSource).toContain('isEmailTemplateScope("US_STRIPE", definition.scope)');
    expect(credentialsPanelSource).toContain("isEmailTemplateScope(scope, definition.scope)");
  });

  test("each button's payload carries its own group and nothing from the other", () => {
    const settings: EmailTemplateSettings = {
      definitions: [
        { type: "dteReceipt", scope: "SV_CDE", label: "", description: "", defaultSubject: "", defaultBody: "", placeholders: [] },
        { type: "dteInvalidation", scope: "SV_CDE", label: "", description: "", defaultSubject: "", defaultBody: "", placeholders: [] },
        { type: "stripeAcknowledgment", scope: "US_STRIPE", label: "", description: "", defaultSubject: "", defaultBody: "", placeholders: [] },
        { type: "stripeRefund", scope: "US_STRIPE", label: "", description: "", defaultSubject: "", defaultBody: "", placeholders: [] },
        { type: "stripeAnnualStatement", scope: "US_STRIPE", label: "", description: "", defaultSubject: "", defaultBody: "", placeholders: [] }
      ],
      placeholders: [],
      templates: {}
    };
    const draft = Object.fromEntries(
      ["dteReceipt", "dteInvalidation", "stripeAcknowledgment", "stripeRefund", "stripeAnnualStatement"]
        .map((type) => [type, { subject: `${type} asunto`, body: `${type} cuerpo` }])
    );

    expect(Object.keys(scopedEmailTemplates(settings, draft, "SV_CDE"))).toEqual([
      "dteReceipt",
      "dteInvalidation"
    ]);
    expect(Object.keys(scopedEmailTemplates(settings, draft, "US_STRIPE"))).toEqual([
      "stripeAcknowledgment",
      "stripeRefund",
      "stripeAnnualStatement"
    ]);
    expect(scopedEmailTemplates(settings, draft, "US_STRIPE").stripeRefund).toEqual({
      subject: "stripeRefund asunto",
      body: "stripeRefund cuerpo"
    });
  });
});

describe("Plantillas format toolbar roving tabindex (source contract)", () => {
  test("resyncs the active index to whichever button actually holds focus", () => {
    for (const index of [0, 1, 2, 3]) {
      expect(credentialsPanelSource).toContain(
        `tabIndex={activeFormatIndex === ${index} ? 0 : -1} onFocus={() => setActiveFormatIndex(${index})}`
      );
    }
    expect(credentialsPanelSource).toContain('onMouseDown={(event) => event.preventDefault()}');
  });
});
