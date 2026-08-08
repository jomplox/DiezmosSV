import { expect, test, type Page, type Route } from "@playwright/test";

const ADMIN = {
  id: "certificate-race-admin",
  email: "certificate-race-admin@example.org",
  name: "Certificate Race Admin",
  role: "ADMIN"
};

type CertificateHandler = (route: Route, url: URL) => Promise<boolean>;

function donor(label: string) {
  const groupKey = `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}@example.org`;
  return {
    groupKey,
    donorName: label,
    donorEmail: groupKey,
    hasEmail: true,
    count: 1,
    totalLabel: "$1.00",
    hasTestEnvironment: false,
    dossierTooLarge: false
  };
}

function preview(year: number, labels: string[], options: { hasMore?: boolean; nextCursor?: string | null } = {}) {
  return {
    year,
    donors: labels.map(donor),
    hasMore: options.hasMore ?? false,
    nextCursor: options.nextCursor ?? null
  };
}

function sendResult(year: number, options: { hasMore?: boolean; nextCursor?: string | null } = {}) {
  return {
    year,
    mode: "bulk",
    processed: 1,
    sent: 1,
    skipped: 0,
    failed: 0,
    hasMore: options.hasMore ?? false,
    nextCursor: options.nextCursor ?? null
  };
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function fulfillJson(route: Route, value: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(value)
  });
}

async function installAdminApp(page: Page, handleCertificate: CertificateHandler): Promise<void> {
  await page.clock.setFixedTime(new Date("2026-08-08T12:00:00.000Z"));
  await page.addInitScript((admin) => {
    localStorage.setItem("diezmos_token", "certificate-race-token");
    localStorage.setItem("diezmos_user", JSON.stringify(admin));
  }, ADMIN);
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (await handleCertificate(route, url)) {
      return;
    }
    if (url.pathname === "/api/branding") {
      await fulfillJson(route, {});
      return;
    }
    if (url.pathname === "/api/documents") {
      await fulfillJson(route, { documents: [], hasMore: false, nextCursor: null, limit: 50 });
      return;
    }
    if (url.pathname === "/api/exports/f960") {
      await fulfillJson(route, { rows: [], rowCount: 0, amountTotal: "0.00" });
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
    if (url.pathname === "/api/settings/emission-environment") {
      await fulfillJson(route, {
        emissionEnvironment: {
          environment: "00",
          allowedEnvironments: ["00"]
        }
      });
      return;
    }
    throw new Error(`Unhandled admin API request in certificate race test: ${url.pathname}`);
  });
  page.on("dialog", (dialog) => void dialog.accept());
  await page.goto("/admin");
  await page.getByRole("button", { name: "Exportar" }).click();
  await expect(page.getByRole("heading", { name: "Constancia anual de donaciones" })).toBeVisible();
}

async function settleReact(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

function certificateYearSelect(page: Page) {
  return page
    .getByRole("heading", { name: "Constancia anual de donaciones" })
    .locator("xpath=ancestor::section[1]")
    .locator("select")
    .first();
}

test("ignores a delayed old-year bulk result and starts the new year without its cursor", async ({ page }) => {
  const oldBulk = deferred();
  let oldBulkRequestSeen = false;
  const newYearBodies: unknown[] = [];

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname === "/api/certificates/annual" && request.method() === "GET") {
      const year = Number(url.searchParams.get("year"));
      await fulfillJson(route, preview(year, [`Base ${year}`]));
      return true;
    }
    if (url.pathname === "/api/certificates/annual/send" && request.method() === "POST") {
      const year = Number(url.searchParams.get("year"));
      if (year === 2026) {
        oldBulkRequestSeen = true;
        await oldBulk.promise;
        await fulfillJson(route, sendResult(2026, {
          hasMore: true,
          nextCursor: "old-2026@example.org"
        }));
      } else {
        newYearBodies.push(request.postDataJSON());
        await fulfillJson(route, sendResult(year));
      }
      return true;
    }
    return false;
  });

  await expect(page.getByText("Base 2026")).toBeVisible();
  await page.getByRole("button", { name: "Enviar primera tanda" }).click();
  await expect.poll(() => oldBulkRequestSeen).toBe(true);

  await certificateYearSelect(page).selectOption("2025");
  await expect(page.getByText("Base 2025")).toBeVisible();
  oldBulk.release();

  await expect(page.getByRole("button", { name: "Enviar primera tanda" })).toBeEnabled();
  await page.getByRole("button", { name: "Enviar primera tanda" }).click();
  await expect.poll(() => newYearBodies.length).toBe(1);
  expect(newYearBodies).toEqual([{}]);
});

test("never appends a delayed old-year continuation after a year and search reset", async ({ page }) => {
  const oldPage = deferred();
  let oldPageRequestSeen = false;

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname !== "/api/certificates/annual" || request.method() !== "GET") {
      return false;
    }
    const year = Number(url.searchParams.get("year"));
    const search = url.searchParams.get("q") ?? "";
    const after = url.searchParams.get("after");
    if (year === 2026 && after === "cursor-2026") {
      oldPageRequestSeen = true;
      await oldPage.promise;
      await fulfillJson(route, preview(2026, ["Late 2026"]));
      return true;
    }
    if (year === 2026) {
      await fulfillJson(route, preview(2026, ["Base 2026"], {
        hasMore: true,
        nextCursor: "cursor-2026"
      }));
      return true;
    }
    await fulfillJson(route, preview(2025, [search ? "Search 2025" : "Base 2025"]));
    return true;
  });

  await expect(page.getByText("Base 2026")).toBeVisible();
  await page.getByRole("button", { name: "Ver más donantes" }).click();
  await expect.poll(() => oldPageRequestSeen).toBe(true);

  await certificateYearSelect(page).selectOption("2025");
  await page.getByPlaceholder("Buscar donante o correo").fill("nuevo");
  await expect(page.getByText("Search 2025")).toBeVisible();
  oldPage.release();

  await expect(page.getByRole("button", { name: "Enviar primera tanda" })).toBeEnabled();
  expect(await page.getByText("Late 2026").count()).toBe(0);
  await expect(page.getByText("Search 2025")).toBeVisible();
});

test("keeps the newest base preview when search responses finish out of order", async ({ page }) => {
  const oldSearch = deferred();
  let oldSearchRequestSeen = false;

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname !== "/api/certificates/annual" || request.method() !== "GET") {
      return false;
    }
    const year = Number(url.searchParams.get("year"));
    const search = url.searchParams.get("q") ?? "";
    if (search === "old") {
      oldSearchRequestSeen = true;
      await oldSearch.promise;
      await fulfillJson(route, preview(year, ["Old search result"]));
      return true;
    }
    await fulfillJson(route, preview(year, [search === "new" ? "New search result" : "Initial result"]));
    return true;
  });

  await expect(page.getByText("Initial result")).toBeVisible();
  const search = page.getByPlaceholder("Buscar donante o correo");
  await search.fill("old");
  await expect.poll(() => oldSearchRequestSeen).toBe(true);
  await search.fill("new");
  await expect(page.getByText("New search result")).toBeVisible();

  oldSearch.release();
  await settleReact(page);
  expect(await page.getByText("Old search result").count()).toBe(0);
  await expect(page.getByText("New search result")).toBeVisible();
});

test("ignores a delayed per-row refresh after the preview year resets", async ({ page }) => {
  const oldRefresh = deferred();
  let initial2026Served = false;
  let oldRefreshRequestSeen = false;

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname === "/api/certificates/annual/send" && request.method() === "POST") {
      await fulfillJson(route, { ...sendResult(2026), mode: "single", hasMore: false, nextCursor: null });
      return true;
    }
    if (url.pathname !== "/api/certificates/annual" || request.method() !== "GET") {
      return false;
    }
    const year = Number(url.searchParams.get("year"));
    if (year === 2026 && initial2026Served) {
      oldRefreshRequestSeen = true;
      await oldRefresh.promise;
      await fulfillJson(route, preview(2026, ["Refreshed 2026"]));
      return true;
    }
    if (year === 2026) {
      initial2026Served = true;
      await fulfillJson(route, preview(2026, ["Send 2026"]));
      return true;
    }
    await fulfillJson(route, preview(2025, ["Base 2025"]));
    return true;
  });

  const donorRow = page.getByRole("row", { name: /Send 2026/ });
  await expect(donorRow).toBeVisible();
  await donorRow.getByRole("button", { name: "Enviar" }).click();
  await expect.poll(() => oldRefreshRequestSeen).toBe(true);

  await certificateYearSelect(page).selectOption("2025");
  await expect(page.getByText("Base 2025")).toBeVisible();
  oldRefresh.release();
  await settleReact(page);

  expect(await page.getByText("Refreshed 2026").count()).toBe(0);
  await expect(page.getByText("Base 2025")).toBeVisible();
});
