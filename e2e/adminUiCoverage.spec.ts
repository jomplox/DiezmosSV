import { expect, test, type Page, type Route } from "@playwright/test";

const OWNER = {
  id: "ui-coverage-owner",
  email: "owner@example.org",
  name: "Propietario Ejemplo",
  role: "OWNER"
};

interface AdminUiHarness {
  createdUsers: Array<Record<string, unknown>>;
  f960Downloads: URL[];
  unhandledApiRequests: string[];
}

type AdminUiHandler = (route: Route, url: URL) => Promise<boolean>;

async function fulfillJson(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value)
  });
}

async function installOwnerAdmin(page: Page, handleApi?: AdminUiHandler): Promise<AdminUiHarness> {
  const harness: AdminUiHarness = {
    createdUsers: [],
    f960Downloads: [],
    unhandledApiRequests: []
  };

  await page.clock.setFixedTime(new Date("2026-08-09T16:00:00.000Z"));
  await page.addInitScript((owner) => {
    localStorage.setItem("diezmos_token", "ui-coverage-token");
    localStorage.setItem("diezmos_user", JSON.stringify(owner));
  }, OWNER);

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (await handleApi?.(route, url)) return;

    if (url.pathname === "/api/branding") {
      await fulfillJson(route, {
        displayName: "MISION EXAMPLEORGANIZATION",
        accentColor: "#0f766e",
        supportEmail: "soporte@example.org",
        logoVersion: null,
        donorLogoVersion: null
      });
      return;
    }
    if (url.pathname === "/api/documents") {
      await fulfillJson(route, { documents: [], hasMore: false, nextCursor: null, limit: 50 });
      return;
    }
    if (url.pathname === "/api/wompi-events/issuance-failures") {
      await fulfillJson(route, { failures: [] });
      return;
    }
    if (url.pathname === "/api/audit") {
      await fulfillJson(route, { audit: [], nextCursor: null });
      return;
    }
    if (url.pathname === "/api/users") {
      if (request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        harness.createdUsers.push(body);
        await fulfillJson(route, {
          user: {
            id: `created-${harness.createdUsers.length}`,
            ...body,
            disabled_at: null,
            created_at: "2026-08-09T16:00:00.000Z",
            updated_at: "2026-08-09T16:00:00.000Z"
          }
        }, 201);
        return;
      }
      await fulfillJson(route, {
        users: [{
          ...OWNER,
          disabled_at: null,
          created_at: "2026-08-09T16:00:00.000Z",
          updated_at: "2026-08-09T16:00:00.000Z"
        }]
      });
      return;
    }
    if (url.pathname === "/api/settings/emission-environment") {
      await fulfillJson(route, {
        emissionEnvironment: {
          environment: "00",
          source: "deployment_default",
          appEnv: "staging",
          locked: true,
          allowedEnvironments: ["00"]
        }
      });
      return;
    }
    if (url.pathname === "/api/donors") {
      await fulfillJson(route, { donors: [], total: 0, limit: 25, offset: 0, hasMore: false });
      return;
    }
    if (url.pathname === "/api/analytics") {
      await fulfillJson(route, {
        analytics: {
          range: { from: "2026-08-01", to: "2026-08-09" },
          environment: "00",
          hasData: false
        }
      });
      return;
    }
    if (url.pathname === "/api/exports/f960") {
      await fulfillJson(route, { rows: [], rowCount: 0, amountTotal: "0.00" });
      return;
    }
    if (url.pathname === "/api/exports/f960.csv" || url.pathname === "/api/exports/f960.xlsx") {
      harness.f960Downloads.push(url);
      await route.fulfill({
        status: 200,
        body: "read-only export fixture",
        headers: {
          "Content-Type": url.pathname.endsWith(".csv") ? "text/csv" : "application/octet-stream",
          "Content-Disposition": `attachment; filename="fixture.${url.pathname.endsWith(".csv") ? "csv" : "xlsx"}"`
        }
      });
      return;
    }
    if (url.pathname === "/api/certificates/annual") {
      await fulfillJson(route, {
        year: Number(url.searchParams.get("year") ?? 2026),
        donors: [],
        hasMore: false,
        nextCursor: null
      });
      return;
    }
    if (url.pathname === "/api/statements/stripe/annual" && request.method() === "GET") {
      await fulfillJson(route, {
        year: Number(url.searchParams.get("year") ?? 2026),
        livemode: false,
        timeZone: "America/New_York",
        donors: [],
        hasMore: false,
        nextCursor: null
      });
      return;
    }
    if (url.pathname === "/api/donations/intents") {
      await fulfillJson(route, { intents: [] });
      return;
    }
    if (url.pathname === "/api/admin/backups") {
      await fulfillJson(route, { months: [] });
      return;
    }
    if (url.pathname === "/api/credentials") {
      await fulfillJson(route, {
        credentials: {
          target: {
            appEnv: "staging",
            scriptName: "staging-worker",
            writerConfigured: false,
            writerMissing: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]
          },
          groups: {},
          certificateExpiresAt: null,
          stripeOperational: {
            appEnv: "staging",
            mode: "Pruebas",
            mockMode: false,
            localProxyConfigured: false
          }
        }
      });
      return;
    }
    if (url.pathname === "/api/settings/stripe/acknowledgments") {
      await fulfillJson(route, { acknowledgments: [] });
      return;
    }
    if (url.pathname === "/api/settings/stripe" && request.method() === "GET") {
      await fulfillJson(route, {
        stripe: {
          credentials: { label: "Stripe EE. UU.", ready: false, items: [] },
          operational: {
            appEnv: "staging",
            mode: "Pruebas",
            mockMode: false,
            localProxyConfigured: false
          },
          webhookHealth: { state: "none", label: "Sin eventos recibidos" }
        }
      });
      return;
    }
    if (url.pathname === "/api/settings/email-templates") {
      await fulfillJson(route, { emailTemplates: { definitions: [], placeholders: [], templates: {} } });
      return;
    }
    if (url.pathname === "/api/settings/email-sender") {
      await fulfillJson(route, {
        emailSender: {
          senderName: "MISION EXAMPLEORGANIZATION",
          senderAddress: "envios@example.org",
          replyToAddress: "soporte@example.org"
        }
      });
      return;
    }
    if (url.pathname === "/api/settings/wompi-notifications") {
      await fulfillJson(route, {
        wompiNotifications: {
          emailsNotificacion: "",
          telefonosNotificacion: "",
          notificarTransaccionCliente: false
        }
      });
      return;
    }
    if (url.pathname === "/api/settings/alert-email") {
      await fulfillJson(route, { alertEmail: "" });
      return;
    }

    harness.unhandledApiRequests.push(`${request.method()} ${url.pathname}`);
    await fulfillJson(route, { error: "unhandled_admin_ui_fixture" }, 500);
  });

  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Documentos", exact: true })).toBeVisible();
  return harness;
}

async function openView(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true, level: 1 })).toBeVisible();
}

test("covers every owner navigation surface with accessible filters and no app runtime errors", async ({ page }) => {
  const runtimeErrors: string[] = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") runtimeErrors.push(message.text());
  });
  const harness = await installOwnerAdmin(page);

  await expect(page.getByRole("heading", { name: "CDE rápido" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Buscar código, donante o correo" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Estado del documento" })).toBeVisible();

  await openView(page, "Donantes");
  await expect(page.getByRole("heading", { name: "Buscar donantes" })).toBeVisible();
  await page.getByLabel("Total desde").fill("20");
  await page.getByLabel("Total hasta").fill("10");
  await page.getByRole("button", { name: "Actualizar" }).click();
  await expect(page.getByRole("alert")).toHaveText("El monto desde no puede ser mayor que el monto hasta.");

  await openView(page, "Fallos");
  await expect(page.getByText("Sin fallos pendientes. Todo en orden.")).toBeVisible();

  await openView(page, "Contingencia");
  await expect(page.getByRole("heading", { name: "El CDE no usa modo de contingencia" })).toBeVisible();
  await expect(page.getByLabel("Flujo de reintento automático")).toBeVisible();

  await openView(page, "Auditoría");
  await expect(page.getByRole("textbox", { name: "Filtrar auditoría" })).toBeVisible();
  await expect(page.getByText("0 registros cargados.")).toBeVisible();

  await openView(page, "Analítica");
  await expect(page.getByRole("heading", { name: "Filtros" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Filtrar por tipo de donación" })).toBeVisible();

  await openView(page, "Usuarios");
  await expect(page.getByRole("button", { name: "Crear usuario" })).toBeVisible();

  await openView(page, "Exportar");
  await expect(page.getByRole("heading", { name: "F960" })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Buscar donante o correo", exact: true })).toBeVisible();

  await openView(page, "Configuración");
  const settingsNavigation = page.getByRole("navigation", { name: "Secciones de credenciales" });
  await expect(settingsNavigation.getByRole("button")).toHaveCount(8);
  await expect(page.getByRole("button", { name: "Producción 01" }).first()).toBeDisabled();

  expect(harness.unhandledApiRequests).toEqual([]);
  expect(runtimeErrors).toEqual([]);
});

test("edits Salvadoran and U.S. email templates separately while identifying the fixed U.S. PDFs", async ({ page }) => {
  let savedTemplates: Record<string, { subject: string; body: string }> | null = null;
  const definitions = [
    {
      type: "dteReceipt",
      scope: "SV_CDE",
      label: "Envío de comprobante",
      description: "Correo que recibe el donante con su CDE en PDF y JSON.",
      defaultSubject: "Comprobante de su donación {{numeroControl}}",
      defaultBody: "Cuerpo salvadoreño",
      placeholders: ["{{numeroControl}}", "{{donante}}", "{{monto}}"]
    },
    {
      type: "dteInvalidation",
      scope: "SV_CDE",
      label: "Invalidación de comprobante",
      description: "Correo que recibe el donante cuando su CDE queda invalidado.",
      defaultSubject: "Invalidación de su comprobante {{numeroControl}}",
      defaultBody: "Cuerpo de invalidación",
      placeholders: ["{{numeroControl}}", "{{donante}}", "{{estado}}"]
    },
    {
      type: "stripeAcknowledgment",
      scope: "US_STRIPE",
      label: "Constancia inmediata",
      description: "Se envía al confirmarse una donación única o mensual de Stripe.",
      defaultSubject: "Constancia de su donación",
      defaultBody: "Primera\r\nSegunda",
      placeholders: ["{{donante}}", "{{monto}}", "{{nombreLegal}}"]
    },
    {
      type: "stripeRefund",
      scope: "US_STRIPE",
      label: "Corrección o revocación por reembolso",
      description: "Reemplaza o revoca la constancia anterior según el monto reembolsado.",
      defaultSubject: "{{tipoConstancia}} de su donación",
      defaultBody: "Cuerpo de reembolso",
      placeholders: ["{{donante}}", "{{tipoConstancia}}", "{{montoNeto}}"]
    },
    {
      type: "stripeAnnualStatement",
      scope: "US_STRIPE",
      label: "Constancia anual",
      description: "Resume el total neto anual.",
      defaultSubject: "Constancia anual {{anio}} — EE. UU.",
      defaultBody: "Cuerpo anual",
      placeholders: ["{{donante}}", "{{anio}}", "{{totalNeto}}"]
    }
  ];
  let templates = Object.fromEntries(definitions.map((definition) => [
    definition.type,
    { subject: definition.defaultSubject, body: definition.defaultBody }
  ]));
  await installOwnerAdmin(page, async (route, url) => {
    if (url.pathname !== "/api/settings/email-templates") return false;
    if (route.request().method() === "PUT") {
      const payload = route.request().postDataJSON() as {
        scope?: "SV_CDE" | "US_STRIPE";
        templates: Record<string, { subject: string; body: string }>;
      };
      savedTemplates = payload.templates;
      // El endpoint real fusiona el grupo enviado sobre lo guardado y solo reemplaza las
      // cinco cuando el cuerpo no trae `scope`. Reemplazar siempre modelaría un servidor
      // que descarta el país que no se envió.
      templates = payload.scope ? { ...templates, ...payload.templates } : payload.templates;
    }
    await fulfillJson(route, {
      emailTemplates: {
        definitions,
        placeholders: ["{{numeroControl}}", "{{donante}}", "{{monto}}"],
        templates
      }
    });
    return true;
  });

  await openView(page, "Configuración");
  await page.getByRole("button", { name: /^Plantillas/ }).click();

  const templatePanel = page.locator(".email-template-panel");
  const salvadoranTemplates = templatePanel.getByRole("region", { name: "Plantillas de El Salvador — CDE" });
  const usTemplates = templatePanel.getByRole("region", { name: "Plantillas de EE. UU. — Stripe 501(c)(3)" });
  await expect(salvadoranTemplates.getByRole("heading", { name: "El Salvador — CDE" })).toBeVisible();
  await expect(salvadoranTemplates.getByRole("button", { name: "Guardar plantillas de El Salvador" })).toBeVisible();
  await expect(usTemplates.getByRole("heading", { name: "EE. UU. — Stripe 501(c)(3)" })).toBeVisible();
  await expect(usTemplates.getByText("PDF legal protegido")).toBeVisible();
  await expect(usTemplates.getByText(/El asunto y cuerpo de estos correos son editables/)).toBeVisible();
  await expect(usTemplates.getByRole("textbox")).toHaveCount(6);

  for (const definition of definitions) {
    const editor = templatePanel.getByRole("region", { name: definition.label, exact: true });
    await expect(editor).toBeVisible();
    await expect(editor.getByRole("textbox", { name: `Asunto — ${definition.label}`, exact: true })).toBeVisible();
    await expect(editor.getByRole("textbox", { name: `Cuerpo del correo — ${definition.label}`, exact: true })).toBeVisible();
    await expect(editor.getByRole("toolbar", { name: `Formato del cuerpo — ${definition.label}`, exact: true })).toBeVisible();
    for (const format of ["Negrita", "Cursiva", "Subrayado", "Cita"]) {
      await expect(editor.getByRole("button", { name: `${format} — ${definition.label}`, exact: true })).toBeVisible();
    }
  }

  const immediate = templatePanel.getByRole("region", { name: "Constancia inmediata", exact: true });
  const body = immediate.getByRole("textbox", { name: "Cuerpo del correo — Constancia inmediata", exact: true });
  await expect(body).toHaveValue("Primera\nSegunda");
  await body.evaluate((textarea: HTMLTextAreaElement) => textarea.select());
  await immediate.getByRole("button", { name: "Negrita — Constancia inmediata", exact: true }).click();
  await expect(body).toHaveValue("**Primera**\n**Segunda**");
  await expect(body).toBeFocused();
  await expect.poll(() => body.evaluate((textarea: HTMLTextAreaElement) => [textarea.selectionStart, textarea.selectionEnd]))
    .toEqual([2, 21]);

  const applyMultilineFormat = async (button: string, expected: string, expectedSelection: [number, number]) => {
    await body.fill("Primera\nSegunda\n\nTercera");
    await body.evaluate((textarea: HTMLTextAreaElement) => textarea.select());
    await immediate.getByRole("button", { name: `${button} — Constancia inmediata`, exact: true }).click();
    await expect(body).toHaveValue(expected);
    await expect.poll(() => body.evaluate((textarea: HTMLTextAreaElement) => [textarea.selectionStart, textarea.selectionEnd]))
      .toEqual(expectedSelection);
  };
  await applyMultilineFormat("Negrita", "**Primera**\n**Segunda**\n\n**Tercera**", [2, 34]);
  await applyMultilineFormat("Cursiva", "*Primera*\n*Segunda*\n\n*Tercera*", [1, 29]);
  await applyMultilineFormat("Subrayado", "++Primera++\n++Segunda++\n\n++Tercera++", [2, 34]);
  await body.fill("Texto");
  await body.evaluate((textarea: HTMLTextAreaElement) => textarea.select());
  await immediate.getByRole("button", { name: "Cita — Constancia inmediata", exact: true }).click();
  await expect(body).toHaveValue("> Texto");
  await immediate.getByRole("textbox", { name: "Asunto — Constancia inmediata", exact: true }).fill("Gracias por su entrega, {{donante}}");
  await usTemplates.getByRole("button", { name: "Guardar plantillas de EE. UU." }).click();
  await expect.poll(() => savedTemplates?.stripeAcknowledgment.subject ?? null)
    .toBe("Gracias por su entrega, {{donante}}");
  expect(savedTemplates?.stripeAcknowledgment.body).toBe("> Texto");
});

test("paginates every long preview table in Exportar without changing its data source", async ({ page }) => {
  const rows = Array.from({ length: 23 }, (_, index) => {
    const number = index + 1;
    return {
      fechaEmision: `2026-08-${String(number).padStart(2, "0")}`,
      nombre: `F960 Donante ${number}`,
      correo: `f960-${number}@example.org`,
      nit: "",
      dui: String(100000000 + number),
      monto: `${number}.00`,
      periodo: "082026",
      codigoGeneracion: `generation-${number}`,
      sello: `seal-${number}`,
      numeroControl: `DTE-${number}`
    };
  });
  const svDonors = Array.from({ length: 23 }, (_, index) => {
    const number = index + 1;
    return {
      groupKey: `sv-${number}`,
      donorName: `Donante SV ${number}`,
      donorEmail: `sv-${number}@example.org`,
      hasEmail: true,
      count: 1,
      totalLabel: `$${number}.00`,
      hasTestEnvironment: true,
      dossierTooLarge: false
    };
  });
  const usDonors = Array.from({ length: 23 }, (_, index) => {
    const number = index + 1;
    return {
      donorKey: `us-${number}`,
      donorName: `Donante EE. UU. ${number}`,
      donorEmail: `us-${number}@example.org`,
      hasEmail: true,
      count: 1,
      grossTotalLabel: `$${number}.00`,
      refundedTotalLabel: "$0.00",
      netTotalLabel: `$${number}.00`
    };
  });
  const intents = Array.from({ length: 23 }, (_, index) => {
    const number = index + 1;
    return {
      id: `intent-${number}`,
      status: "COMPLETED",
      amount_cents: number * 100,
      document_id: `document-${number}`,
      gift_type: number % 2 === 0 ? "OFRENDA" : "DIEZMO",
      created_at: `2026-08-${String(number).padStart(2, "0")}T12:00:00.000Z`,
      numero_control: `DTE-${number}`,
      document_donor_name: `Donante en línea ${number}`
    };
  });

  await installOwnerAdmin(page, async (route, url) => {
    if (url.pathname === "/api/exports/f960") {
      await fulfillJson(route, { rows, rowCount: rows.length, amountTotal: "276.00" });
      return true;
    }
    if (url.pathname === "/api/certificates/annual") {
      await fulfillJson(route, { year: 2026, donors: svDonors, hasMore: false, nextCursor: null });
      return true;
    }
    if (url.pathname === "/api/statements/stripe/annual" && route.request().method() === "GET") {
      await fulfillJson(route, {
        year: 2026,
        livemode: false,
        timeZone: "America/New_York",
        donors: usDonors,
        hasMore: false,
        nextCursor: null
      });
      return true;
    }
    if (url.pathname === "/api/donations/intents") {
      await fulfillJson(route, { intents });
      return true;
    }
    return false;
  });

  await openView(page, "Exportar");

  const f960 = page.locator("section.export-panel").filter({ has: page.getByRole("heading", { name: "F960", exact: true }) });
  const sv = page.locator("section.export-panel").filter({ has: page.getByRole("heading", { name: "El Salvador — CDE", exact: true }) });
  const us = page.locator("section.export-panel").filter({ has: page.getByRole("heading", { name: "EE. UU. — Stripe", exact: true }) });
  const online = page.locator("section.export-panel").filter({ has: page.getByRole("heading", { name: "Donaciones en línea", exact: true }) });

  for (const [panel, label] of [
    [f960, "F960"],
    [sv, "constancias de El Salvador"],
    [us, "constancias de EE. UU."],
    [online, "donaciones en línea"]
  ] as const) {
    await expect(panel.locator("tbody tr")).toHaveCount(10);
    await expect(panel.getByRole("navigation", { name: `Paginación de ${label}` })).toContainText("Página 1 de 3");
  }

  const f960Pagination = f960.getByRole("navigation", { name: "Paginación de F960" });
  await f960Pagination.getByRole("button", { name: "Siguiente" }).click();
  await expect(f960.locator("tbody tr").first()).toContainText("F960 Donante 11");
  await expect(f960Pagination).toContainText("Página 2 de 3");
});

test("does not dispatch user creation until name and a valid email are present", async ({ page }) => {
  const harness = await installOwnerAdmin(page);
  await openView(page, "Usuarios");

  await page.getByLabel("Contraseña inicial").fill("Fresh#Pass2026");
  await page.getByRole("button", { name: "Crear usuario" }).click();
  await expect(page.getByRole("status")).toContainText("Ingrese nombre y correo del usuario");
  expect(harness.createdUsers).toHaveLength(0);

  await page.getByLabel("Nombre").fill("Fresh User");
  await page.getByLabel("Correo").fill("not-an-email");
  await page.getByRole("button", { name: "Crear usuario" }).click();
  await expect(page.getByRole("status")).toContainText("Ingrese un correo válido");
  expect(harness.createdUsers).toHaveLength(0);
});

test("keeps native F960 date inputs controlled and blocks a reversed range before download", async ({ page }) => {
  const harness = await installOwnerAdmin(page);
  await openView(page, "Exportar");

  const start = page.getByLabel("Desde");
  const end = page.getByLabel("Hasta");
  await start.fill("2026-08-09");
  await end.fill("2026-08-01");
  await expect(start).toHaveValue("2026-08-09");
  await expect(end).toHaveValue("2026-08-01");
  await expect(page.getByRole("status")).toContainText("Revise el rango de fechas");

  await page.getByRole("button", { name: "Descargar CSV" }).click();
  await expect(page.getByRole("status")).toContainText("Revise el rango de fechas");
  expect(harness.f960Downloads).toHaveLength(0);
});

test("uses neutral placeholders and empty-draft branding previews", async ({ page }) => {
  await installOwnerAdmin(page);
  await openView(page, "Configuración");
  await page.getByRole("button", { name: /^Marca/ }).click();

  const organization = page.getByLabel("Nombre de la organización");
  const supportEmail = page.getByLabel("Correo de soporte");
  await organization.fill("");
  await supportEmail.fill("");

  await expect(organization).toHaveAttribute("placeholder", "Nombre de su organización");
  await expect(supportEmail).toHaveAttribute("placeholder", "soporte@su-dominio.org");
  await expect(page.locator(".branding-preview-email-name")).toHaveText("Su organización");
  await expect(page.locator(".branding-preview-email-footer")).toHaveText("Correo de soporte");
  await expect(page.locator(".branding-preview-donor-mark")).toHaveText("Su organización");
  await expect(page.getByText(/ExamplePerson1|legacy-contact-1@example\.com/)).toHaveCount(0);
});

test("does not show the prior account Stripe status while the next account loads", async ({ page }) => {
  let stripeGetCount = 0;
  let releaseSecondStripeGet = () => {};
  const secondStripeGet = new Promise<void>((resolve) => {
    releaseSecondStripeGet = resolve;
  });

  await installOwnerAdmin(page, async (route, url) => {
    const request = route.request();
    if (url.pathname === "/api/auth/logout" && request.method() === "POST") {
      await fulfillJson(route, {});
      return true;
    }
    if (url.pathname === "/api/auth/bootstrap-status" && request.method() === "GET") {
      await fulfillJson(route, { bootstrapAvailable: false });
      return true;
    }
    if (url.pathname === "/api/auth/login" && request.method() === "POST") {
      await fulfillJson(route, {
        user: { ...OWNER, id: "next-ui-coverage-owner", email: "next-owner@example.org" },
        token: "next-ui-coverage-token"
      });
      return true;
    }
    if (url.pathname === "/api/settings/stripe" && request.method() === "GET") {
      stripeGetCount += 1;
      if (stripeGetCount === 2) await secondStripeGet;
      await fulfillJson(route, {
        stripe: {
          credentials: { label: "Stripe EE. UU.", ready: false, items: [] },
          operational: {
            appEnv: "staging",
            mode: stripeGetCount === 1 ? "Pruebas" : "Producción",
            mockMode: false,
            localProxyConfigured: false
          },
          webhookHealth: { state: "none", label: "Sin eventos recibidos" }
        }
      });
      return true;
    }
    return false;
  });

  try {
    await openView(page, "Configuración");
    await page.getByRole("button", { name: /^Stripe EE\. UU\./ }).click();
    const stripeMode = page.locator(".stripe-status-grid > div").filter({ hasText: "Modo Stripe" }).locator("strong");
    await expect(stripeMode).toHaveText("Pruebas");

    await page.getByTitle("Cerrar sesión").click();
    await expect(page.getByRole("button", { name: "Continuar" })).toBeVisible();
    await page.getByLabel("Correo").fill("next-owner@example.org");
    await page.getByLabel("Contraseña").fill("next-owner-password");
    await page.getByRole("button", { name: "Continuar" }).click();
    await expect(page.getByRole("heading", { name: "Documentos", exact: true })).toBeVisible();

    await openView(page, "Configuración");
    await expect.poll(() => stripeGetCount).toBe(2);
    await page.getByRole("button", { name: /^Stripe EE\. UU\./ }).click();
    await expect(stripeMode).toHaveText("Sin cargar");

    releaseSecondStripeGet();
    await expect(stripeMode).toHaveText("Producción");
  } finally {
    releaseSecondStripeGet();
  }
});

test("preloads and edits owner-visible U.S. organization settings while Stripe credentials stay write-only", async ({ page }) => {
  const configuration = {
    legalName: "Friends of Example Church, Inc.",
    ein: "12-3456789",
    timeZone: "America/New_York",
    organizationPhone: "+1 (616) 555-0143",
    organizationWebsite: "https://example.org",
    organizationMailingAddress: "100 Example Avenue\nGrandville, MI 49418\nUnited States",
    signerName: "Alex Example",
    signerTitle: "Treasurer"
  };
  let submitted: Record<string, unknown> | null = null;
  await installOwnerAdmin(page, async (route, url) => {
    const request = route.request();
    if (url.pathname === "/api/settings/emission-environment" && request.method() === "GET") {
      await fulfillJson(route, {
        emissionEnvironment: {
          environment: "01",
          source: "deployment_default",
          appEnv: "production",
          locked: true,
          allowedEnvironments: ["01"]
        }
      });
      return true;
    }
    if (url.pathname === "/api/credentials" && request.method() === "GET") {
      await fulfillJson(route, {
        credentials: {
          target: { appEnv: "staging", scriptName: "staging-worker", writerConfigured: true, writerMissing: [] },
          groups: {},
          certificateExpiresAt: null,
          stripeOperational: { appEnv: "staging", mode: "Pruebas", mockMode: false, localProxyConfigured: false }
        }
      });
      return true;
    }
    if (url.pathname === "/api/settings/stripe" && request.method() === "GET") {
      // Después del POST este GET sigue sirviendo la `configuration` previa: es el
      // isolate que aún tiene el env anterior a la nueva versión del Worker.
      await fulfillJson(route, {
        stripe: {
          credentials: { label: "Stripe EE. UU.", ready: true, items: [] },
          operational: { appEnv: "staging", mode: "Pruebas", mockMode: false, localProxyConfigured: false },
          configuration,
          webhookHealth: { state: "none", label: "Sin eventos recibidos" }
        }
      });
      return true;
    }
    if (url.pathname === "/api/settings/stripe" && request.method() === "POST") {
      submitted = request.postDataJSON() as Record<string, unknown>;
      await fulfillJson(route, { updated: ["STRIPE_US_PHONE", "STRIPE_US_TIME_ZONE"] });
      return true;
    }
    return false;
  });

  await openView(page, "Configuración");
  await page.getByRole("button", { name: /^Stripe EE\. UU\./ }).click();

  await expect(page.getByLabel("Nombre legal")).toHaveValue(configuration.legalName);
  await expect(page.getByLabel("EIN")).toHaveValue(configuration.ein);
  await expect(page.getByLabel("Zona horaria")).toHaveValue(configuration.timeZone);
  await expect(page.getByLabel("Zona horaria")).toHaveJSProperty("tagName", "SELECT");
  await expect(page.getByLabel("Teléfono de la organización")).toHaveValue(configuration.organizationPhone);
  await expect(page.getByLabel("Sitio web")).toHaveValue(configuration.organizationWebsite);
  await expect(page.getByLabel("Dirección postal")).toHaveValue(configuration.organizationMailingAddress);
  await expect(page.getByLabel("Nombre del firmante autorizado")).toHaveValue(configuration.signerName);
  await expect(page.getByLabel("Cargo del firmante autorizado")).toHaveValue(configuration.signerTitle);
  await expect(page.getByLabel("Clave restringida")).toHaveValue("");
  await expect(page.getByLabel("Clave restringida")).toHaveAttribute("type", "password");

  await page.getByLabel("Zona horaria").selectOption("America/Chicago");
  await page.getByLabel("Teléfono de la organización").fill("+1 (312) 555-0100");
  const staleRefresh = page.waitForResponse((response) =>
    new URL(response.url()).pathname === "/api/settings/stripe" && response.request().method() === "GET");
  await page.getByRole("button", { name: "Guardar configuración de Stripe" }).click();

  await expect.poll(() => submitted).toEqual({
    restrictedKey: "",
    publishableKey: "",
    paymentMethodConfigurationId: "",
    billingPortalConfigurationId: "",
    timeZone: "America/Chicago",
    organizationPhone: "+1 (312) 555-0100"
  });
  for (const untouchedField of [
    "legalName",
    "ein",
    "organizationWebsite",
    "organizationMailingAddress",
    "signerName",
    "signerTitle"
  ]) {
    expect(submitted!).not.toHaveProperty(untouchedField);
  }

  // El GET de refresco ya respondió con la `configuration` original. El formulario debe
  // conservar los valores aceptados; si se rehidratara de esa lectura, el teléfono
  // volvería al anterior y el siguiente guardado lo reescribiría encima del nuevo.
  await staleRefresh;
  await expect(page.getByLabel("Teléfono de la organización")).toHaveValue("+1 (312) 555-0100");
  await expect(page.getByLabel("Zona horaria")).toHaveValue("America/Chicago");
});

test("clears Stripe write-only replacements after POST success even when status refresh fails", async ({ page }) => {
  let postSucceeded = false;
  let submitted: Record<string, unknown> | null = null;
  const legalName = "Friends of Durable Example, Inc.";
  await installOwnerAdmin(page, async (route, url) => {
    const request = route.request();
    if (url.pathname === "/api/credentials" && request.method() === "GET") {
      if (postSucceeded) {
        await fulfillJson(route, { error: "refresh_failed" }, 503);
      } else {
        await fulfillJson(route, {
          credentials: {
            target: { appEnv: "staging", scriptName: "staging-worker", writerConfigured: true, writerMissing: [] },
            groups: {},
            certificateExpiresAt: null,
            stripeOperational: { appEnv: "staging", mode: "Pruebas", mockMode: false, localProxyConfigured: false }
          }
        });
      }
      return true;
    }
    if (url.pathname === "/api/settings/stripe" && request.method() === "POST") {
      submitted = request.postDataJSON() as Record<string, unknown>;
      postSucceeded = true;
      await fulfillJson(route, { updated: ["STRIPE_RESTRICTED_KEY"] });
      return true;
    }
    if (url.pathname === "/api/settings/stripe" && request.method() === "GET") {
      if (postSucceeded) {
        await fulfillJson(route, { error: "refresh_failed" }, 503);
      } else {
        await fulfillJson(route, {
          stripe: {
            credentials: { label: "Stripe EE. UU.", ready: true, items: [] },
            operational: { appEnv: "staging", mode: "Pruebas", mockMode: false, localProxyConfigured: false },
            configuration: {
              legalName,
              ein: "12-3456789",
              timeZone: "America/New_York",
              organizationPhone: "+1 555 010 0100",
              organizationWebsite: "https://example.org",
              organizationMailingAddress: "100 Test Avenue\nNew York, NY 10001, USA",
              signerName: "Test Signer",
              signerTitle: "Treasurer"
            },
            webhookHealth: { state: "none", label: "Sin eventos recibidos" }
          }
        });
      }
      return true;
    }
    return false;
  });
  await openView(page, "Configuración");
  await page.getByRole("button", { name: /^Stripe EE\. UU\./ }).click();
  const replacement = page.getByLabel("Clave restringida");
  const visibleLegalName = page.getByLabel("Nombre legal");
  await expect(visibleLegalName).toHaveValue(legalName);
  await replacement.fill("rk_test_write_only_fixture");

  await page.getByRole("button", { name: "Guardar configuración de Stripe" }).click();

  await expect.poll(() => postSucceeded).toBe(true);
  expect(submitted).toEqual({
    restrictedKey: "rk_test_write_only_fixture",
    publishableKey: "",
    paymentMethodConfigurationId: "",
    billingPortalConfigurationId: ""
  });
  for (const organizationField of [
    "legalName",
    "ein",
    "timeZone",
    "organizationPhone",
    "organizationWebsite",
    "organizationMailingAddress",
    "signerName",
    "signerTitle"
  ]) {
    expect(submitted!).not.toHaveProperty(organizationField);
  }
  await expect(replacement).toHaveValue("");
  await expect(visibleLegalName).toHaveValue(legalName);
  await expect(page.getByRole("status")).toContainText(
    "Configuración de Stripe guardada, pero no se pudo actualizar el estado mostrado."
  );
});

test("keeps Stripe controls busy while an unrelated settings action finishes", async ({ page }) => {
  let stripePostStarted = false;
  let releaseStripePost!: () => void;
  const stripePostBarrier = new Promise<void>((resolve) => { releaseStripePost = resolve; });
  await installOwnerAdmin(page, async (route, url) => {
    const request = route.request();
    if (url.pathname === "/api/credentials" && request.method() === "GET") {
      await fulfillJson(route, {
        credentials: {
          target: { appEnv: "staging", scriptName: "staging-worker", writerConfigured: true, writerMissing: [] },
          groups: {},
          certificateExpiresAt: null,
          stripeOperational: { appEnv: "staging", mode: "Pruebas", mockMode: false, localProxyConfigured: false }
        }
      });
      return true;
    }
    if (url.pathname === "/api/settings/stripe" && request.method() === "POST") {
      stripePostStarted = true;
      await stripePostBarrier;
      await fulfillJson(route, { updated: ["STRIPE_RESTRICTED_KEY"] });
      return true;
    }
    if (url.pathname === "/api/settings/email-sender" && request.method() === "PUT") {
      await fulfillJson(route, {
        emailSender: {
          senderName: "MISION EXAMPLEORGANIZATION",
          senderAddress: "envios@example.org",
          replyToAddress: "soporte@example.org"
        }
      });
      return true;
    }
    return false;
  });

  try {
    await openView(page, "Configuración");
    await page.getByRole("button", { name: /^Stripe EE\. UU\./ }).click();
    const stripeSave = page.getByRole("button", { name: "Guardar configuración de Stripe" });
    await stripeSave.click();
    await expect.poll(() => stripePostStarted).toBe(true);

    await page.getByRole("button", { name: /^Correo/ }).click();
    await page.getByRole("button", { name: "Guardar remitente" }).click();
    await expect(page.getByRole("status")).toContainText("Configuración del remitente actualizada");

    await page.getByRole("button", { name: /^Stripe EE\. UU\./ }).click();
    await expect(page.getByRole("button", { name: /Guardar configuración de Stripe|Guardando/ })).toBeDisabled();
  } finally {
    releaseStripePost();
  }
});

test("clears the staged webhook secret after POST success even when status refresh fails", async ({ page }) => {
  let stageSucceeded = false;
  await installOwnerAdmin(page, async (route, url) => {
    const request = route.request();
    if (url.pathname === "/api/credentials" && request.method() === "GET") {
      if (stageSucceeded) {
        await fulfillJson(route, { error: "refresh_failed" }, 503);
      } else {
        await fulfillJson(route, {
          credentials: {
            target: { appEnv: "staging", scriptName: "staging-worker", writerConfigured: true, writerMissing: [] },
            groups: {},
            certificateExpiresAt: null,
            stripeOperational: { appEnv: "staging", mode: "Pruebas", mockMode: false, localProxyConfigured: false }
          }
        });
      }
      return true;
    }
    if (url.pathname === "/api/settings/stripe/webhook-secret/stage" && request.method() === "POST") {
      stageSucceeded = true;
      await fulfillJson(route, { ok: true });
      return true;
    }
    if (stageSucceeded && url.pathname === "/api/settings/stripe" && request.method() === "GET") {
      await fulfillJson(route, { error: "refresh_failed" }, 503);
      return true;
    }
    return false;
  });
  await openView(page, "Configuración");
  await page.getByRole("button", { name: /^Stripe EE\. UU\./ }).click();
  const nextSecret = page.locator('input[name="stripe-webhook-secret-next"]');
  await nextSecret.fill("whsec_next_write_only_fixture");

  await page.getByRole("button", { name: "Preparar secreto siguiente" }).click();

  await expect.poll(() => stageSucceeded).toBe(true);
  await expect(nextSecret).toHaveValue("");
  await expect(page.getByRole("status")).toContainText(
    "Secreto siguiente preparado, pero no se pudo actualizar el estado mostrado."
  );
});

test("commits webhook promotion before refresh and locks rotation until status reconciliation", async ({ page }) => {
  let promotionSucceeded = false;
  const stripeGroup = {
    label: "Stripe EE. UU.",
    ready: true,
    items: [{ name: "STRIPE_WEBHOOK_SECRET_NEXT", label: "Secreto siguiente", configured: true, protected: true }]
  };
  await installOwnerAdmin(page, async (route, url) => {
    const request = route.request();
    if (url.pathname === "/api/credentials" && request.method() === "GET") {
      if (promotionSucceeded) {
        await fulfillJson(route, { error: "refresh_failed" }, 503);
      } else {
        await fulfillJson(route, {
          credentials: {
            target: { appEnv: "staging", scriptName: "staging-worker", writerConfigured: true, writerMissing: [] },
            groups: { stripe: stripeGroup },
            certificateExpiresAt: null,
            stripeOperational: { appEnv: "staging", mode: "Pruebas", mockMode: false, localProxyConfigured: false }
          }
        });
      }
      return true;
    }
    if (url.pathname === "/api/settings/stripe" && request.method() === "GET") {
      if (promotionSucceeded) {
        await fulfillJson(route, { error: "refresh_failed" }, 503);
      } else {
        await fulfillJson(route, {
          stripe: {
            credentials: stripeGroup,
            operational: { appEnv: "staging", mode: "Pruebas", mockMode: false, localProxyConfigured: false },
            webhookHealth: { state: "none", label: "Sin eventos recibidos" }
          }
        });
      }
      return true;
    }
    if (url.pathname === "/api/settings/stripe/webhook-secret/promote" && request.method() === "POST") {
      promotionSucceeded = true;
      await fulfillJson(route, { ok: true, updated: ["STRIPE_WEBHOOK_SECRET", "STRIPE_WEBHOOK_SECRET_NEXT"], audit: "ok" });
      return true;
    }
    return false;
  });

  await openView(page, "Configuración");
  await page.getByRole("button", { name: /^Stripe EE\. UU\./ }).click();
  const promote = page.getByRole("button", { name: "Promover secreto preparado" });
  const cancel = page.getByRole("button", { name: "Cancelar secreto preparado" });
  await promote.click();

  await expect.poll(() => promotionSucceeded).toBe(true);
  await expect(page.getByRole("status")).toContainText(
    "Secreto promovido, pero el estado mostrado requiere conciliación."
  );
  await expect(promote).toBeDisabled();
  await expect(cancel).toBeDisabled();
  await expect(page.getByText("Rotación guardada; actualice el estado antes de otra acción.")).toBeVisible();
});
