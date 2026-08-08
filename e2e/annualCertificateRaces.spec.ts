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

async function fulfillError(route: Route, message: string, status = 500): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify({ error: message })
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
    if (url.pathname === "/api/auth/logout") {
      await fulfillJson(route, {});
      return;
    }
    if (url.pathname === "/api/auth/bootstrap-status") {
      await fulfillJson(route, { bootstrapAvailable: false });
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

async function nativeDoubleClick(page: Page, accessibleName: string): Promise<void> {
  await page.getByRole("button", { name: accessibleName }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
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

test("invalidates the visible preview as soon as raw search changes and rejects a page released inside the debounce", async ({ page }) => {
  const oldPage = deferred();
  let oldPageRequestSeen = false;
  let oldPageCompleted = false;

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname !== "/api/certificates/annual" || request.method() !== "GET") {
      return false;
    }
    const year = Number(url.searchParams.get("year"));
    const search = url.searchParams.get("q") ?? "";
    const after = url.searchParams.get("after");
    if (after === "raw-search-cursor") {
      oldPageRequestSeen = true;
      await oldPage.promise;
      await fulfillJson(route, preview(year, ["Late raw page"]));
      oldPageCompleted = true;
      return true;
    }
    await fulfillJson(route, preview(year, [search ? "Raw search result" : "Raw base result"], search ? {} : {
      hasMore: true,
      nextCursor: "raw-search-cursor"
    }));
    return true;
  });

  await expect(page.getByText("Raw base result")).toBeVisible();
  await page.getByRole("button", { name: "Ver más donantes" }).click();
  await expect.poll(() => oldPageRequestSeen).toBe(true);

  try {
    await page.getByPlaceholder("Buscar donante o correo").fill("nuevo");
    expect(await page.getByText("Raw base result").count()).toBe(0);

    oldPage.release();
    await expect.poll(() => oldPageCompleted).toBe(true);
    await settleReact(page);
    expect(await page.getByText("Late raw page").count()).toBe(0);
    await expect(page.getByText("Raw search result")).toBeVisible();
  } finally {
    oldPage.release();
  }
});

test("keeps an old continuation stale when the year changes during the raw-search debounce", async ({ page }) => {
  const oldPage = deferred();
  let oldPageRequestSeen = false;
  const requests: Array<{ year: number; search: string; after: string | null }> = [];

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname !== "/api/certificates/annual" || request.method() !== "GET") {
      return false;
    }
    const year = Number(url.searchParams.get("year"));
    const search = url.searchParams.get("q") ?? "";
    const after = url.searchParams.get("after");
    requests.push({ year, search, after });
    if (year === 2026 && after === "debounce-cursor") {
      oldPageRequestSeen = true;
      await oldPage.promise;
      await fulfillJson(route, preview(2026, ["Late debounce page"]));
      return true;
    }
    if (year === 2026) {
      await fulfillJson(route, preview(2026, ["Debounce base"], {
        hasMore: true,
        nextCursor: "debounce-cursor"
      }));
      return true;
    }
    await fulfillJson(route, preview(year, [search ? "New year searched" : "New year base"]));
    return true;
  });

  await expect(page.getByText("Debounce base")).toBeVisible();
  await page.getByRole("button", { name: "Ver más donantes" }).click();
  await expect.poll(() => oldPageRequestSeen).toBe(true);

  try {
    await page.getByPlaceholder("Buscar donante o correo").fill("nuevo");
    await certificateYearSelect(page).selectOption("2025");
    oldPage.release();

    await expect(page.getByText("New year searched")).toBeVisible();
    expect(await page.getByText("Late debounce page").count()).toBe(0);
    expect(requests.some((entry) => entry.year === 2025 && entry.search === "nuevo" && entry.after === null)).toBe(true);
  } finally {
    oldPage.release();
  }
});

test("suppresses a stale continuation HTTP error after a newer year succeeds", async ({ page }) => {
  const staleError = deferred();
  let staleRequestSeen = false;
  let staleRequestCompleted = false;

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname !== "/api/certificates/annual" || request.method() !== "GET") {
      return false;
    }
    const year = Number(url.searchParams.get("year"));
    const after = url.searchParams.get("after");
    if (year === 2026 && after === "stale-error-cursor") {
      staleRequestSeen = true;
      await staleError.promise;
      await fulfillError(route, "STALE CONTINUATION ERROR");
      staleRequestCompleted = true;
      return true;
    }
    await fulfillJson(route, preview(year, [`Error base ${year}`], year === 2026 ? {
      hasMore: true,
      nextCursor: "stale-error-cursor"
    } : {}));
    return true;
  });

  await expect(page.getByText("Error base 2026")).toBeVisible();
  await page.getByRole("button", { name: "Ver más donantes" }).click();
  await expect.poll(() => staleRequestSeen).toBe(true);

  try {
    await certificateYearSelect(page).selectOption("2025");
    await expect(page.getByText("Error base 2025")).toBeVisible();
    staleError.release();
    await expect.poll(() => staleRequestCompleted).toBe(true);
    await settleReact(page);

    expect(await page.getByText("STALE CONTINUATION ERROR").count()).toBe(0);
    await expect(page.getByText("Error base 2025")).toBeVisible();
  } finally {
    staleError.release();
  }
});

test("suppresses a stale bulk HTTP error but still surfaces the current generation error", async ({ page }) => {
  const staleBulk = deferred();
  let staleBulkSeen = false;
  let staleBulkCompleted = false;

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname === "/api/certificates/annual" && request.method() === "GET") {
      const year = Number(url.searchParams.get("year"));
      await fulfillJson(route, preview(year, [`Bulk error ${year}`]));
      return true;
    }
    if (url.pathname === "/api/certificates/annual/send" && request.method() === "POST") {
      const year = Number(url.searchParams.get("year"));
      if (year === 2026) {
        staleBulkSeen = true;
        await staleBulk.promise;
        await fulfillError(route, "STALE BULK ERROR");
        staleBulkCompleted = true;
      } else {
        await fulfillError(route, "CURRENT BULK ERROR");
      }
      return true;
    }
    return false;
  });

  await expect(page.getByText("Bulk error 2026")).toBeVisible();
  await page.getByRole("button", { name: "Enviar primera tanda" }).click();
  await expect.poll(() => staleBulkSeen).toBe(true);

  try {
    await certificateYearSelect(page).selectOption("2025");
    await expect(page.getByText("Bulk error 2025")).toBeVisible();
    staleBulk.release();
    await expect.poll(() => staleBulkCompleted).toBe(true);
    await expect(page.getByRole("button", { name: "Enviar primera tanda" })).toBeEnabled();
    expect(await page.getByText("STALE BULK ERROR").count()).toBe(0);

    await page.getByRole("button", { name: "Enviar primera tanda" }).click();
    await expect(page.getByText("CURRENT BULK ERROR")).toBeVisible();
  } finally {
    staleBulk.release();
  }
});

test("still surfaces a current continuation HTTP error and releases its control", async ({ page }) => {
  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname !== "/api/certificates/annual" || request.method() !== "GET") {
      return false;
    }
    const after = url.searchParams.get("after");
    if (after === "current-error-cursor") {
      await fulfillError(route, "CURRENT CONTINUATION ERROR");
      return true;
    }
    await fulfillJson(route, preview(Number(url.searchParams.get("year")), ["Current error base"], {
      hasMore: true,
      nextCursor: "current-error-cursor"
    }));
    return true;
  });

  await expect(page.getByText("Current error base")).toBeVisible();
  await page.getByRole("button", { name: "Ver más donantes" }).click();
  await expect(page.getByText("CURRENT CONTINUATION ERROR")).toBeVisible();
  await expect(page.getByRole("button", { name: "Ver más donantes" })).toBeEnabled();
});

test("suppresses a stale base-preview HTTP error after a newer search succeeds", async ({ page }) => {
  const staleBase = deferred();
  let staleBaseSeen = false;
  let staleBaseCompleted = false;

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname !== "/api/certificates/annual" || request.method() !== "GET") {
      return false;
    }
    const year = Number(url.searchParams.get("year"));
    const search = url.searchParams.get("q") ?? "";
    if (search === "old") {
      staleBaseSeen = true;
      await staleBase.promise;
      await fulfillError(route, "STALE BASE ERROR");
      staleBaseCompleted = true;
      return true;
    }
    await fulfillJson(route, preview(year, [search === "new" ? "New base success" : "Base before errors"]));
    return true;
  });

  await expect(page.getByText("Base before errors")).toBeVisible();
  const search = page.getByPlaceholder("Buscar donante o correo");
  await search.fill("old");
  await expect.poll(() => staleBaseSeen).toBe(true);
  await search.fill("new");
  await expect(page.getByText("New base success")).toBeVisible();

  try {
    staleBase.release();
    await expect.poll(() => staleBaseCompleted).toBe(true);
    await settleReact(page);
    expect(await page.getByText("STALE BASE ERROR").count()).toBe(0);
    await expect(page.getByText("New base success")).toBeVisible();
  } finally {
    staleBase.release();
  }
});

test("still surfaces a current base-preview HTTP error", async ({ page }) => {
  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname !== "/api/certificates/annual" || request.method() !== "GET") {
      return false;
    }
    if (url.searchParams.get("q") === "broken") {
      await fulfillError(route, "CURRENT BASE ERROR");
      return true;
    }
    await fulfillJson(route, preview(Number(url.searchParams.get("year")), ["Base before current error"]));
    return true;
  });

  await expect(page.getByText("Base before current error")).toBeVisible();
  await page.getByPlaceholder("Buscar donante o correo").fill("broken");
  await expect(page.getByText("CURRENT BASE ERROR")).toBeVisible();
});

test("suppresses a stale per-row refresh error but surfaces the current refresh error", async ({ page }) => {
  const staleRefresh = deferred();
  let staleRefreshSeen = false;
  let staleRefreshCompleted = false;
  const getCount = new Map<number, number>();

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname === "/api/certificates/annual/send" && request.method() === "POST") {
      const year = Number(url.searchParams.get("year"));
      await fulfillJson(route, { ...sendResult(year), mode: "single", hasMore: false, nextCursor: null });
      return true;
    }
    if (url.pathname !== "/api/certificates/annual" || request.method() !== "GET") {
      return false;
    }
    const year = Number(url.searchParams.get("year"));
    const count = (getCount.get(year) ?? 0) + 1;
    getCount.set(year, count);
    if (count === 1) {
      await fulfillJson(route, preview(year, [`Row refresh ${year}`]));
      return true;
    }
    if (year === 2026) {
      staleRefreshSeen = true;
      await staleRefresh.promise;
      await fulfillError(route, "STALE ROW REFRESH ERROR");
      staleRefreshCompleted = true;
      return true;
    }
    await fulfillError(route, "CURRENT ROW REFRESH ERROR");
    return true;
  });

  await expect(page.getByText("Row refresh 2026")).toBeVisible();
  await page.getByRole("row", { name: /Row refresh 2026/ }).getByRole("button", { name: "Enviar" }).click();
  await expect.poll(() => staleRefreshSeen).toBe(true);

  try {
    await certificateYearSelect(page).selectOption("2025");
    await expect(page.getByText("Row refresh 2025")).toBeVisible();
    staleRefresh.release();
    await expect.poll(() => staleRefreshCompleted).toBe(true);
    await settleReact(page);
    expect(await page.getByText("STALE ROW REFRESH ERROR").count()).toBe(0);

    await page.getByRole("row", { name: /Row refresh 2025/ }).getByRole("button", { name: "Enviar" }).click();
    await expect(page.getByText("CURRENT ROW REFRESH ERROR")).toBeVisible();
  } finally {
    staleRefresh.release();
  }
});

test("does not let a stale certificate finalizer re-enable a newer unresolved F960 CSV action", async ({ page }) => {
  const oldPage = deferred();
  const csv = deferred();
  let oldPageSeen = false;
  let csvSeen = false;

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname === "/api/exports/f960.csv") {
      csvSeen = true;
      await csv.promise;
      await route.fulfill({
        status: 200,
        contentType: "text/csv",
        headers: { "Content-Disposition": "attachment; filename=f960.csv" },
        body: "fila\n"
      });
      return true;
    }
    if (url.pathname !== "/api/certificates/annual" || request.method() !== "GET") {
      return false;
    }
    const year = Number(url.searchParams.get("year"));
    const after = url.searchParams.get("after");
    if (year === 2026 && after === "finalizer-cursor") {
      oldPageSeen = true;
      await oldPage.promise;
      await fulfillJson(route, preview(2026, ["Old finalizer page"]));
      return true;
    }
    await fulfillJson(route, preview(year, [`Finalizer base ${year}`], year === 2026 ? {
      hasMore: true,
      nextCursor: "finalizer-cursor"
    } : {}));
    return true;
  });

  await expect(page.getByText("Finalizer base 2026")).toBeVisible();
  await page.getByRole("button", { name: "Ver más donantes" }).click();
  await expect.poll(() => oldPageSeen).toBe(true);
  await certificateYearSelect(page).selectOption("2025");
  await expect(page.getByText("Finalizer base 2025")).toBeVisible();

  try {
    await page.getByRole("button", { name: "Descargar CSV" }).click();
    await expect.poll(() => csvSeen).toBe(true);
    await expect(page.getByRole("button", { name: "Preparando" })).toBeDisabled();

    oldPage.release();
    await settleReact(page);
    await expect(page.getByRole("button", { name: "Preparando" })).toBeDisabled();
  } finally {
    oldPage.release();
    csv.release();
  }

  await expect(page.getByRole("button", { name: "Descargar CSV" })).toBeEnabled();
});

test("claims a bulk generation and cursor synchronously so two native clicks dispatch one POST", async ({ page }) => {
  const bulk = deferred();
  const bodies: unknown[] = [];

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname === "/api/certificates/annual/send" && request.method() === "POST") {
      bodies.push(request.postDataJSON());
      await bulk.promise;
      await fulfillJson(route, sendResult(2026));
      return true;
    }
    if (url.pathname === "/api/certificates/annual" && request.method() === "GET") {
      await fulfillJson(route, preview(2026, ["Bulk claim donor"]));
      return true;
    }
    return false;
  });

  await expect(page.getByText("Bulk claim donor")).toBeVisible();
  try {
    await nativeDoubleClick(page, "Enviar primera tanda");
    await expect.poll(() => bodies.length).toBeGreaterThanOrEqual(1);
    await settleReact(page);
    expect(bodies).toEqual([{}]);
    await expect(page.getByRole("button", { name: "Enviando" })).toBeDisabled();
  } finally {
    bulk.release();
  }
  await expect(page.getByRole("button", { name: "Iniciar nuevo recorrido" })).toBeVisible();
});

test("claims preview pagination synchronously so two native clicks dispatch one continuation GET", async ({ page }) => {
  const nextPage = deferred();
  const continuationUrls: string[] = [];

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname !== "/api/certificates/annual" || request.method() !== "GET") {
      return false;
    }
    const after = url.searchParams.get("after");
    if (after === "pagination-claim-cursor") {
      continuationUrls.push(url.toString());
      await nextPage.promise;
      await fulfillJson(route, preview(2026, ["Pagination claimed page"]));
      return true;
    }
    await fulfillJson(route, preview(2026, ["Pagination claim base"], {
      hasMore: true,
      nextCursor: "pagination-claim-cursor"
    }));
    return true;
  });

  await expect(page.getByText("Pagination claim base")).toBeVisible();
  try {
    await nativeDoubleClick(page, "Ver más donantes");
    await expect.poll(() => continuationUrls.length).toBeGreaterThanOrEqual(1);
    await settleReact(page);
    expect(continuationUrls).toHaveLength(1);
    await expect(page.getByRole("button", { name: "Cargando" })).toBeDisabled();
  } finally {
    nextPage.release();
  }
  await expect(page.getByText("Pagination claimed page")).toBeVisible();
});

test("claims a recipient synchronously so two native clicks dispatch one single-recipient POST", async ({ page }) => {
  const single = deferred();
  const bodies: unknown[] = [];

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname === "/api/certificates/annual/send" && request.method() === "POST") {
      bodies.push(request.postDataJSON());
      await single.promise;
      await fulfillJson(route, { ...sendResult(2026), mode: "single", hasMore: false, nextCursor: null });
      return true;
    }
    if (url.pathname === "/api/certificates/annual" && request.method() === "GET") {
      await fulfillJson(route, preview(2026, ["Single claim donor"]));
      return true;
    }
    return false;
  });

  const row = page.getByRole("row", { name: /Single claim donor/ });
  await expect(row).toBeVisible();
  try {
    await row.getByRole("button", { name: "Enviar" }).evaluate((button) => {
      (button as HTMLButtonElement).click();
      (button as HTMLButtonElement).click();
    });
    await expect.poll(() => bodies.length).toBeGreaterThanOrEqual(1);
    await settleReact(page);
    expect(bodies).toEqual([{ donor: "single-claim-donor@example.org" }]);
    await expect(row.getByRole("button", { name: "Enviando" })).toBeDisabled();
  } finally {
    single.release();
  }
  await expect(page.getByText("Single claim donor")).toBeVisible();
});

test("keeps bulk traversal independent from search and explicitly starts over without the old cursor", async ({ page }) => {
  const bodies: unknown[] = [];

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname === "/api/certificates/annual/send" && request.method() === "POST") {
      const body = request.postDataJSON();
      bodies.push(body);
      await fulfillJson(route, sendResult(2026, bodies.length === 1 ? {
        hasMore: true,
        nextCursor: "bulk-independent-cursor"
      } : {}));
      return true;
    }
    if (url.pathname === "/api/certificates/annual" && request.method() === "GET") {
      const search = url.searchParams.get("q") ?? "";
      await fulfillJson(route, preview(2026, [search ? "Independent search" : "Independent base"]));
      return true;
    }
    return false;
  });

  await expect(page.getByText("Independent base")).toBeVisible();
  await page.getByRole("button", { name: "Enviar primera tanda" }).click();
  await expect(page.getByRole("button", { name: "Enviar siguiente tanda" })).toBeVisible();

  await page.getByPlaceholder("Buscar donante o correo").fill("nuevo");
  await expect(page.getByText("Independent search")).toBeVisible();
  await page.getByRole("button", { name: "Enviar siguiente tanda" }).click();
  await expect.poll(() => bodies.length).toBe(2);
  expect(bodies[1]).toEqual({ after: "bulk-independent-cursor" });

  await page.getByRole("button", { name: "Iniciar nuevo recorrido" }).click();
  await page.getByRole("button", { name: "Enviar primera tanda" }).click();
  await expect.poll(() => bodies.length).toBe(3);
  expect(bodies[2]).toEqual({});
});

test("invalidates a pending certificate operation when the account resets", async ({ page }) => {
  const oldPage = deferred();
  let oldPageSeen = false;

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname !== "/api/certificates/annual" || request.method() !== "GET") {
      return false;
    }
    const after = url.searchParams.get("after");
    if (after === "logout-cursor") {
      oldPageSeen = true;
      await oldPage.promise;
      await fulfillError(route, "STALE LOGOUT ERROR");
      return true;
    }
    await fulfillJson(route, preview(2026, ["Logout base"], {
      hasMore: true,
      nextCursor: "logout-cursor"
    }));
    return true;
  });

  await expect(page.getByText("Logout base")).toBeVisible();
  await page.getByRole("button", { name: "Ver más donantes" }).click();
  await expect.poll(() => oldPageSeen).toBe(true);

  try {
    await page.getByTitle("Cerrar sesión").click();
    await expect(page.getByRole("button", { name: "Continuar" })).toBeVisible();
    oldPage.release();
    await settleReact(page);
    expect(await page.getByText("STALE LOGOUT ERROR").count()).toBe(0);
    await expect(page.getByRole("button", { name: "Continuar" })).toBeVisible();
  } finally {
    oldPage.release();
  }
});

test("refreshes a settled search revision when raw input returns to the same trimmed value", async ({ page }) => {
  const previewGets: Array<{ year: string | null; search: string | null; hasSearch: boolean }> = [];

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname !== "/api/certificates/annual" || request.method() !== "GET") {
      return false;
    }
    previewGets.push({
      year: url.searchParams.get("year"),
      search: url.searchParams.get("q"),
      hasSearch: url.searchParams.has("q")
    });
    await fulfillJson(route, preview(Number(url.searchParams.get("year")), ["Restored settled search"]));
    return true;
  });

  await expect(page.getByText("Restored settled search")).toBeVisible();
  expect(previewGets).toEqual([{ year: "2026", search: null, hasSearch: false }]);
  const search = page.getByPlaceholder("Buscar donante o correo");

  await search.fill("temporary");
  expect(await page.getByText("Restored settled search").count()).toBe(0);
  await search.fill("");
  await expect.poll(() => previewGets.length).toBe(2);
  expect(previewGets[1]).toEqual({ year: "2026", search: null, hasSearch: false });
  await expect(page.getByText("Restored settled search")).toBeVisible();

  await search.fill("   ");
  expect(await page.getByText("Restored settled search").count()).toBe(0);
  await expect.poll(() => previewGets.length).toBe(3);
  expect(previewGets[2]).toEqual({ year: "2026", search: null, hasSearch: false });
  await expect(page.getByText("Restored settled search")).toBeVisible();
});

test("keeps a newer F960 failure authoritative when an older CSV succeeds later", async ({ page }) => {
  const csv = deferred();
  let csvSeen = false;
  let csvCompleted = false;

  await installAdminApp(page, async (route, url) => {
    if (url.pathname === "/api/exports/f960.csv") {
      csvSeen = true;
      await csv.promise;
      await route.fulfill({
        status: 200,
        contentType: "text/csv",
        headers: { "Content-Disposition": "attachment; filename=f960.csv" },
        body: "fila\n"
      });
      csvCompleted = true;
      return true;
    }
    if (url.pathname === "/api/exports/f960.xlsx") {
      await fulfillError(route, "CURRENT XLSX ERROR");
      return true;
    }
    if (url.pathname === "/api/certificates/annual") {
      await fulfillJson(route, preview(2026, ["F960 ownership donor"]));
      return true;
    }
    return false;
  });

  await expect(page.getByText("F960 ownership donor")).toBeVisible();
  try {
    await page.getByRole("button", { name: "Descargar CSV" }).click();
    await expect.poll(() => csvSeen).toBe(true);
    await page.getByRole("button", { name: "XLSX de inspección" }).click();
    await expect(page.getByText("CURRENT XLSX ERROR")).toBeVisible();

    csv.release();
    await expect.poll(() => csvCompleted).toBe(true);
    await settleReact(page);
    await expect(page.getByText("CURRENT XLSX ERROR")).toBeVisible();
    expect(await page.getByText("CSV F960 descargado").count()).toBe(0);
  } finally {
    csv.release();
  }
});

test("serializes distinct recipient sends and permits the next row after the first settles", async ({ page }) => {
  const alpha = deferred();
  let alphaSeen = false;
  const bodies: unknown[] = [];
  const twoDonors = {
    ...preview(2026, []),
    donors: [
      { ...donor("Alpha donor"), groupKey: "alpha@example.org", donorEmail: "alpha@example.org" },
      { ...donor("Beta donor"), groupKey: "beta@example.org", donorEmail: "beta@example.org" }
    ]
  };

  await installAdminApp(page, async (route, url) => {
    const request = route.request();
    if (url.pathname === "/api/certificates/annual/send" && request.method() === "POST") {
      const body = request.postDataJSON();
      bodies.push(body);
      if (body.donor === "alpha@example.org") {
        alphaSeen = true;
        await alpha.promise;
      }
      await fulfillJson(route, { ...sendResult(2026), mode: "single", hasMore: false, nextCursor: null });
      return true;
    }
    if (url.pathname === "/api/certificates/annual" && request.method() === "GET") {
      await fulfillJson(route, twoDonors);
      return true;
    }
    return false;
  });

  await expect(page.getByText("Alpha donor")).toBeVisible();
  await expect(page.getByText("Beta donor")).toBeVisible();
  try {
    await page.locator(".certificate-table tbody button").evaluateAll((buttons) => {
      (buttons[0] as HTMLButtonElement).click();
      (buttons[1] as HTMLButtonElement).click();
    });
    await expect.poll(() => alphaSeen).toBe(true);
    await settleReact(page);
    expect(bodies).toEqual([{ donor: "alpha@example.org" }]);
    await expect(page.getByRole("row", { name: /Beta donor/ }).getByRole("button", { name: "Enviar" })).toBeDisabled();

    alpha.release();
    await expect(page.getByText("Constancia 2026 enviada a Alpha donor.")).toBeVisible();
    await expect(page.getByRole("row", { name: /Beta donor/ }).getByRole("button", { name: "Enviar" })).toBeEnabled();
    expect(bodies).toEqual([{ donor: "alpha@example.org" }]);

    await page.getByRole("row", { name: /Beta donor/ }).getByRole("button", { name: "Enviar" }).click();
    await expect.poll(() => bodies.length).toBe(2);
    expect(bodies).toEqual([
      { donor: "alpha@example.org" },
      { donor: "beta@example.org" }
    ]);
    await expect(page.getByText("Constancia 2026 enviada a Beta donor.")).toBeVisible();
  } finally {
    alpha.release();
  }
});
