import { expect, test } from "@playwright/test";

/**
 * End-to-end test for the PUBLIC donor-checkout pages against a REAL local
 * Cloudflare Worker (SPA + API served by `wrangler dev`, not vite). These pages
 * render WITHOUT a session, so — unlike smoke.spec.ts — there is no bootstrap /
 * login step.
 *
 * In mock mode (MOCK_EXTERNAL_SERVICES="true") the backend returns deterministic
 * mock Wompi links (https://mock.wompi.sv/...). The real Wompi widget script is
 * loaded from pagos.wompi.sv, but it cannot act on a mock URL, so this test only
 * asserts the HANDOFF state (the "Pagar con Wompi" widget area appears, or the
 * app attempts the graceful full-page fallback to urlEnlace). It never depends on
 * real Wompi network access: requests to mock.wompi.sv / pagos.wompi.sv are
 * stubbed so nothing leaves the sandbox.
 *
 * See playwright.config.ts / e2e/smoke.spec.ts for how to run locally with an
 * isolated wrangler state dir (PW_PERSIST_TO="$(mktemp -d)").
 */

// A DUI whose check digit is valid (10000001-9): exercises the DUI branch. Name and
// email are no longer collected on the form — the donor types them on Wompi's sheet.
const DONOR = {
  amount: "1.00",
  dui: "10000001-9"
};

test.beforeEach(async ({ context }) => {
  // Keep everything inside the sandbox: stub the Wompi CDN script and any
  // navigation to the mock hosted-payment host so no real network egress occurs.
  await context.route("https://pagos.wompi.sv/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "/* stubbed wompi widget */" })
  );
  await context.route("https://mock.wompi.sv/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>mock wompi hosted flow</body></html>" })
  );
});

test("public donation form submits and reaches the Wompi handoff state", async ({ page }) => {
  await page.goto("/donar");

  // The public page renders without a session (no login form present).
  await expect(page.getByRole("heading", { name: "Haga su donación" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continuar" })).toHaveCount(0);

  // Name and email are entered on Wompi's sheet, not here — the form no longer has them.
  await expect(page.getByLabel("Nombre completo")).toHaveCount(0);
  await expect(page.getByLabel("Correo electrónico")).toHaveCount(0);

  // Default document type is DUI (13).
  await page.getByLabel("Número de documento").fill(DONOR.dui);

  // Cascading selects: municipio options depend on the chosen departamento.
  await page.getByLabel("Departamento").selectOption({ label: "San Salvador" });
  await page.getByLabel("Municipio").selectOption({ index: 1 });
  await page.getByLabel("Distrito").selectOption({ index: 1 });
  await page.getByLabel("Dirección").fill("San Salvador, El Salvador");

  // Quick-amount chip sets the monto.
  await page.getByLabel("Monto").fill(DONOR.amount);

  await page.getByRole("button", { name: "Donar" }).click();

  // Handoff state: either the widget host + fallback link appear, or the app
  // performs the graceful full-page redirect to the mock hosted flow. Both are
  // acceptable "handoff attempted" outcomes in mock mode.
  const fallbackLink = page.getByRole("button", { name: "¿No se abre el pago? Continúe aquí" });
  await Promise.race([
    fallbackLink.waitFor({ state: "visible", timeout: 15_000 }),
    page.waitForURL("https://mock.wompi.sv/**", { timeout: 15_000 })
  ]);

  const handedOff = (await fallbackLink.count()) > 0 || page.url().startsWith("https://mock.wompi.sv/");
  expect(handedOff).toBe(true);
});

test("thank-you page shows the webhook-driven CDE copy", async ({ page }) => {
  await page.goto("/donar/gracias?monto=1.00&idTransaccion=TEST");

  await expect(page.getByRole("heading", { name: "Su donación fue recibida." })).toBeVisible();
  await expect(
    page.getByText("Recibirá su comprobante (CDE) por correo cuando el Ministerio de Hacienda lo confirme.")
  ).toBeVisible();
  // Monto is displayed from the query string (display only).
  await expect(page.getByText("Monto: $1.00")).toBeVisible();
});
