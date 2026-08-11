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

async function fulfillJson(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(value)
  });
}

async function installOwnerAdmin(page: Page): Promise<AdminUiHarness> {
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
