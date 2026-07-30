import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * End-to-end smoke test for the money path against a REAL local Cloudflare Worker
 * (SPA + API served by `wrangler dev`, not vite). Flow:
 *   bootstrap owner (fresh D1 -> bootstrap mode) -> login -> emit quick CDE
 *   (mock MH) -> row reaches ACEPTADO -> invalidate via dialog -> row INVALIDADO.
 *
 * The Worker is started by playwright.config.ts's webServer, which builds the
 * client, applies local D1 migrations, and runs `wrangler dev` on port 8787 with
 * env from DIEZMOSSV_ENV_FILE. Mock mode (MOCK_EXTERNAL_SERVICES="true") makes MH
 * transmission + email synthetic so a quick CDE reaches ACEPTADO via the local
 * queue within ~1-5s.
 *
 * This test targets the FRESH-DB bootstrap path (its primary/only path): the
 * bootstrap segmented control appears only when no users exist. Because a dev
 * checkout's local D1 usually already has users, run it against an isolated,
 * fresh wrangler state directory locally:
 *
 *   DIEZMOSSV_ENV_FILE=.dev.vars.ci PW_PERSIST_TO="$(mktemp -d)" npx playwright test
 *
 * CI selects .dev.vars.ci directly and runs on a fresh runner (no .wrangler state),
 * so the bootstrap path is exercised without any persist dir.
 */

const OWNER = {
  name: "CI Owner",
  email: "ci-owner@example.org",
  // Satisfies the password policy: 10+ chars, upper, lower, number, symbol.
  password: "CiSmoke2026!",
  // Matches BOOTSTRAP_OWNER_TOKEN in .dev.vars.ci.
  setupToken: "bt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
};

const DONOR = {
  amount: "42.50",
  name: "Donante Prueba E2E",
  // Document type "Otro" (code 37) avoids DUI-format validation.
  document: "E2E-000123"
};

// Poll the documents table by clicking "Actualizar" until `predicate` holds.
async function refreshUntil(page: Page, predicate: () => Promise<boolean>, attempts = 20): Promise<void> {
  const refresh = page.getByRole("button", { name: "Actualizar" }).first();
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await predicate()) return;
    await refresh.click();
    // The queue consumer takes ~1-5s in mock mode; give each poll room.
    await page.waitForTimeout(1500);
  }
  // One last check so the caller's expect() reports the real end state.
  if (!(await predicate())) {
    throw new Error("refreshUntil: predicate never became true within the poll budget");
  }
}

function acceptedRow(page: Page): Locator {
  return page.locator("table tbody tr", { has: page.locator("span.status", { hasText: "ACEPTADO" }) }).first();
}

function invalidatedRow(page: Page): Locator {
  return page.locator("table tbody tr", { has: page.locator("span.status", { hasText: "INVALIDADO" }) }).first();
}

test("bootstrap owner, emit a quick CDE, and invalidate it", async ({ page }) => {
  await page.goto("/admin");

  // --- Bootstrap the owner (fresh DB -> bootstrap mode is available) ---
  await page.getByRole("button", { name: "Crear propietario" }).click();
  await page.getByPlaceholder("Nombre", { exact: true }).fill(OWNER.name);
  await page.getByPlaceholder("Correo").fill(OWNER.email);
  await page.getByPlaceholder("Contraseña", { exact: true }).fill(OWNER.password);
  await page.getByPlaceholder("Token de configuración").fill(OWNER.setupToken);
  await page.getByRole("button", { name: "Continuar" }).click();

  // --- Landed on the dashboard: the quick-emit panel is visible ---
  await expect(page.getByRole("heading", { name: "CDE rápido" })).toBeVisible();

  // --- Emit a quick CDE ---
  await page.getByPlaceholder("Monto").fill(DONOR.amount);
  await page.getByPlaceholder("Nombre o razón social").fill(DONOR.name);
  // Choose "Otro" so the donor document is not validated as a DUI.
  await page.getByLabel("Tipo de documento del donante").selectOption({ label: "Otro" });
  await page.getByPlaceholder("Documento").fill(DONOR.document);
  await page.getByRole("button", { name: "Generar" }).click();

  // Toast confirms the emission was accepted for transmission.
  await expect(page.getByText("CDE creado. Transmitiendo al Ministerio de Hacienda…")).toBeVisible();

  // --- Poll until the row reaches ACEPTADO (queue consumer, ~1-5s) ---
  await refreshUntil(page, async () => (await acceptedRow(page).count()) > 0);
  await expect(acceptedRow(page)).toBeVisible();

  // --- Open the detail panel and invalidate via the dialog ---
  await acceptedRow(page).click();
  await page.getByRole("button", { name: "Invalidar" }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // Keep the default tipo ("2 - ..."), fill the required Motivo, confirm.
  await dialog.locator("textarea").fill("Prueba E2E");
  await dialog.getByRole("button", { name: "Confirmar invalidación" }).click();
  await expect(dialog).toBeHidden();

  // --- Poll until the row shows INVALIDADO ---
  await refreshUntil(page, async () => (await invalidatedRow(page).count()) > 0);
  await expect(invalidatedRow(page)).toBeVisible();
});
