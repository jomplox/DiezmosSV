import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";
import {
  STRIPE_ORGANIZATION_PENDING_WRITE_TTL_MS,
  createStripeSettingsRequestGate,
  credentialSettingsSections,
  resolveStripeOrganizationHydration,
  trimmedStripeOrganization
} from "../../src/client/credentialSettings";
import { userFacingErrorMessage } from "../../src/client/displayText";
import type { StripeSettingsState } from "../../src/client/types";

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
    expect(appSource).toContain("...organizationPatch");
    expect(appSource).toContain("...emptyStripeWriteOnlyInput()");
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

  test("sends a dirty organization patch and guards only fields confirmed by the mutation response", () => {
    // patchCloudflareWorkerSecrets publica una versión nueva del Worker, así que el GET
    // inmediato puede atenderlo un isolate con el env anterior. Rehidratar de esa lectura
    // revierte el campo recién guardado y el siguiente guardado reescribe el valor viejo.
    const save = appSource.slice(
      appSource.indexOf("async function updateStripeCredentials("),
      appSource.indexOf("async function stageStripeWebhookSecret(")
    );

    expect(save).toContain("if (!organizationBaseline)");
    expect(save).toContain("stripeOrganizationDirtyPatch(organization, organizationBaseline)");
    expect(save).toContain("const pendingWrite = stripeOrganizationPendingWrite(organizationPatch, result.updated, Date.now())");
    expect(save).toContain("...organizationPatch");
    expect(save).not.toContain("values: trimmedStripeOrganization(organization)");
    expect(save).not.toContain("...stripeOrganizationCredentialInput(organization)");
  });

  test("funnels every Stripe settings GET through one latest-response gate and invalidates it after mutations", () => {
    expect(appSource.match(/accountApi<\{ stripe: StripeSettingsState \}>\("\/api\/settings\/stripe"\)/g)).toHaveLength(1);
    expect(appSource).toContain("const stripeSettingsRequest = stripeSettingsRequestsRef.current.start();");
    expect(appSource).toContain("commit: stripeSettingsRequest.commit");
    expect(appSource).toContain("return refresh.commit(() =>");
    expect(appSource).toContain("stripeSettingsRequestsRef.current.invalidate();");
  });

  test("reconciles every accepted refresh and refetches after a pending guard expires", () => {
    const apply = appSource.slice(
      appSource.indexOf("function applyStripeSettingsRefresh("),
      appSource.indexOf("function applyEmailSender(")
    );
    expect(apply).toContain("resolveStripeOrganizationHydration(settings.configuration, stripeOrganizationPendingWriteRef.current, Date.now())");
    expect(apply).toContain("reconcileStripeOrganizationDraft(currentOrganization, baseline, resolved.configuration)");
    expect(apply).toContain("stripeOrganizationBaselineRef.current = resolved.configuration;");

    const expiry = appSource.slice(
      appSource.indexOf("function scheduleStripeOrganizationPendingExpiry("),
      appSource.indexOf("function applyStripeSettingsRefresh(")
    );
    expect(expiry).toContain("resolveStripeOrganizationHydration(latestServerConfiguration, pendingWrite, Date.now())");
    expect(expiry).toContain("void fetchStripeSettings()");
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

describe("Stripe owner settings refresh ordering", () => {
  test("ignores refresh A when refresh B resolves first", async () => {
    const gate = createStripeSettingsRequestGate();
    const applied: string[] = [];
    let resolveA!: (value: string) => void;
    let resolveB!: (value: string) => void;
    const responseA = new Promise<string>((resolve) => { resolveA = resolve; });
    const responseB = new Promise<string>((resolve) => { resolveB = resolve; });
    const run = async (response: Promise<string>) => {
      const request = gate.start();
      const value = await response;
      request.commit(() => applied.push(value));
    };

    const refreshA = run(responseA);
    const refreshB = run(responseB);
    resolveB("B");
    await refreshB;
    resolveA("A");
    await refreshA;

    expect(applied).toEqual(["B"]);
  });
});

const savedOrganization: StripeSettingsState["configuration"] = {
  legalName: "Iglesia Elim USA",
  ein: "12-3456789",
  timeZone: "America/Chicago",
  organizationPhone: "+1 555 0100",
  organizationWebsite: "https://example.org",
  organizationMailingAddress: "1 Main St, Dallas TX",
  signerName: "Pastor",
  signerTitle: "Tesorero"
};

const SAVED_AT = 1_770_000_000_000;
const pendingWrite = {
  values: { organizationPhone: savedOrganization.organizationPhone },
  savedAt: SAVED_AT
};
const withinWindow = SAVED_AT + 1_000;

describe("Stripe organization propagation window", () => {
  test("keeps a just-saved value when the refresh still reads the pre-save Worker env", () => {
    // El GET lo atendió un isolate con el env anterior: devuelve el teléfono viejo.
    const stale = { ...savedOrganization, organizationPhone: "+1 555 0199" };

    const resolved = resolveStripeOrganizationHydration(stale, pendingWrite, withinWindow);

    expect(resolved.configuration.organizationPhone).toBe("+1 555 0100");
    expect(resolved.configuration).toEqual(savedOrganization);
    // La escritura pendiente sigue vigente: la próxima rehidratación debe protegerla igual.
    expect(resolved.pendingWrite).toBe(pendingWrite);
  });

  test("overlays only the organization field confirmed as updated", () => {
    const stale = {
      ...savedOrganization,
      legalName: "Nombre de otra persona propietaria",
      organizationPhone: "+1 555 0199"
    };

    const resolved = resolveStripeOrganizationHydration(stale, pendingWrite, withinWindow);

    expect(resolved.configuration.organizationPhone).toBe("+1 555 0100");
    expect(resolved.configuration.legalName).toBe("Nombre de otra persona propietaria");
  });

  test("clears the pending write once the server echoes the saved field", () => {
    const propagated = { ...savedOrganization, organizationPhone: "  +1 555 0100  " };

    const resolved = resolveStripeOrganizationHydration(propagated, pendingWrite, withinWindow);

    expect(resolved.pendingWrite).toBeNull();
    // Confirmada la propagación, el formulario vuelve a sembrarse del servidor.
    expect(resolved.configuration).toBe(propagated);
  });

  test("hydrates straight from the server when there is no pending write", () => {
    const resolved = resolveStripeOrganizationHydration(savedOrganization, null, withinWindow);

    expect(resolved.configuration).toBe(savedOrganization);
    expect(resolved.pendingWrite).toBeNull();
  });

  test("expires the pending write once the propagation window has clearly passed", () => {
    // Una lectura que sigue discrepando pasado el plazo ya no se explica por la
    // propagación: lo más probable es que otra persona propietaria cambiara el campo.
    const otherOwnersValue = { ...savedOrganization, organizationPhone: "+1 555 0177" };

    const lastMoment = resolveStripeOrganizationHydration(
      otherOwnersValue,
      pendingWrite,
      SAVED_AT + STRIPE_ORGANIZATION_PENDING_WRITE_TTL_MS
    );
    expect(lastMoment.configuration.organizationPhone).toBe("+1 555 0100");
    expect(lastMoment.pendingWrite).toBe(pendingWrite);

    const expired = resolveStripeOrganizationHydration(
      otherOwnersValue,
      pendingWrite,
      SAVED_AT + STRIPE_ORGANIZATION_PENDING_WRITE_TTL_MS + 1
    );
    expect(expired.configuration).toBe(otherOwnersValue);
    expect(expired.pendingWrite).toBeNull();
  });

  test("stops re-injecting a blank a half-configured deployment legitimately wrote", () => {
    // Un campo en blanco sobre un campo sin configurar es un no-op aceptado por el worker,
    // así que la escritura pendiente puede contener "". Si otra persona propietaria lo
    // completa después, superponer ese "" haría que cada guardado siguiente fallara con
    // blank_us_* hasta recargar; el vencimiento acota esa ventana.
    const blankPhoneWrite = {
      values: { organizationPhone: "" },
      savedAt: SAVED_AT
    };
    const populatedByAnotherOwner = { ...savedOrganization, organizationPhone: "+1 555 0177" };

    expect(resolveStripeOrganizationHydration(populatedByAnotherOwner, blankPhoneWrite, withinWindow)
      .configuration.organizationPhone).toBe("");

    const expired = resolveStripeOrganizationHydration(
      populatedByAnotherOwner,
      blankPhoneWrite,
      SAVED_AT + STRIPE_ORGANIZATION_PENDING_WRITE_TTL_MS + 1
    );
    expect(expired.configuration.organizationPhone).toBe("+1 555 0177");
    expect(expired.pendingWrite).toBeNull();
  });

  test("records the submitted organization trimmed, matching what the worker stores", () => {
    expect(trimmedStripeOrganization({
      legalName: "  Iglesia Elim USA  ",
      ein: " 12-3456789 ",
      timeZone: " America/Chicago ",
      organizationPhone: " +1 555 0100 ",
      organizationWebsite: " https://example.org ",
      organizationMailingAddress: " 1 Main St, Dallas TX ",
      signerName: " Pastor ",
      signerTitle: " Tesorero "
    })).toEqual(savedOrganization);
  });

  test("fixes every hydration path once instead of per caller", () => {
    // El botón "Actualizar", el refresco automático y la carga inicial de la vista
    // pasan todos por el mismo conciliador de una respuesta aceptada por generación.
    const hydrate = appSource.slice(
      appSource.indexOf("function applyStripeSettingsRefresh("),
      appSource.indexOf("function applyEmailSender(")
    );

    expect(hydrate).toContain("resolveStripeOrganizationHydration(settings.configuration, stripeOrganizationPendingWriteRef.current, Date.now())");
    expect(hydrate).toContain("stripeOrganizationPendingWriteRef.current = resolved.pendingWrite;");
    expect(hydrate).toContain("reconcileStripeOrganizationDraft(currentOrganization, baseline, resolved.configuration)");
    // stripeSettings conserva la lectura cruda del servidor para su consumidor actual.
    expect(hydrate).toContain("setStripeSettings(settings);");

    const save = appSource.slice(
      appSource.indexOf("async function updateStripeCredentials("),
      appSource.indexOf("async function stageStripeWebhookSecret(")
    );
    // El sello de tiempo se toma al guardar, no al resolver: es lo que acota la vigencia.
    expect(save).toContain("stripeOrganizationPendingWrite(organizationPatch, result.updated, Date.now())");
  });

  test("does not leak one account's pending write into the next session", () => {
    const reset = appSource.slice(
      appSource.indexOf("function resetAccountState() {"),
      appSource.indexOf("async function loadMoreDocuments(")
    );

    expect(reset).toContain("stripeOrganizationPendingWriteRef.current = null;");
    expect(reset).toContain("stripeSettingsRequestsRef.current.invalidate();");
    expect(reset).toContain("stripeOrganizationBaselineRef.current = null;");
  });

  test("invalidates Stripe refreshes and clears the pending expiry timer on unmount", () => {
    const start = appSource.indexOf("useEffect(() => () => {");
    const cleanup = appSource.slice(start, appSource.indexOf("}, []);", start));

    expect(cleanup).toContain("stripeSettingsRequestsRef.current.invalidate();");
    expect(cleanup).toContain("window.clearTimeout(stripeOrganizationPendingExpiryTimerRef.current);");
    expect(cleanup).toContain("stripeOrganizationPendingExpiryTimerRef.current = null;");
  });
});
