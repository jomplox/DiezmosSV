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
  // Stub the Givebutter widget CDN and hosted page too. The stubbed script never
  // upgrades <givebutter-giving-form>, so the render probe times out and the
  // fallback link state is what renders — exactly the offline-safe path to assert.
  await context.route("https://widgets.givebutter.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "application/javascript", body: "/* stubbed givebutter widget */" })
  );
  await context.route("https://givebutter.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>mock givebutter hosted flow</body></html>" })
  );
});

test("public donation form submits and reaches the Wompi handoff state", async ({ page }) => {
  await page.goto("/donar");

  // The public page opens on the two-door chooser (renders without a session).
  await expect(page.getByRole("heading", { name: "Haga su donación" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continuar" })).toHaveCount(0);

  // Door 1 (El Salvador y el mundo) opens the SV fiscal (Wompi + CDE) form.
  await page.getByRole("button", { name: "El Salvador y el mundo" }).click();

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

test("the EE. UU. door routes straight to the Givebutter (FMCE) block", async ({ page }) => {
  await page.goto("/donar");
  await expect(page.getByRole("heading", { name: "Haga su donación" })).toBeVisible();

  // Door 2 (EE. UU.) opens the Givebutter block directly — no extranjero toggle.
  await page.getByRole("button", { name: "EE. UU." }).click();

  // The extranjero mechanics are skipped entirely: no toggle, no país, no SV form.
  await expect(page.getByLabel("Resido en el extranjero")).toHaveCount(0);
  await expect(page.getByLabel("Número de documento")).toHaveCount(0);
  await expect(page.getByLabel("Dirección")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Donar" })).toHaveCount(0);

  // Pick a quick amount for the widget prefill.
  await page.getByLabel("Monto").fill("25.00");

  // The FMCE explanation, the English-form notice, and the embedded giving form appear.
  await expect(page.getByText("Friends of Misión ExampleOrganization")).toBeVisible();
  await expect(page.getByText("El formulario de pago se muestra en inglés.")).toBeVisible();
  await expect(page.locator("givebutter-giving-form")).toHaveAttribute("campaign", "example-campaign");

  // The always-visible "done directly on givebutter.com" hint links to the slug URL.
  const hint = page.getByRole("link", { name: "¿Problemas con el formulario? Done directamente en givebutter.com" });
  await expect(hint).toHaveAttribute("href", /givebutter\.com\/example-campaign/);
  await expect(hint).toHaveAttribute("href", /amount=25/);

  // The stubbed widget never renders, so the prominent fallback CTA appears too.
  const fallback = page.getByRole("link", { name: "Donar en givebutter.com" });
  await expect(fallback).toBeVisible({ timeout: 10_000 });
  await expect(fallback).toHaveAttribute("href", /givebutter\.com\/example-campaign\?amount=25/);

  // "Cambiar opción" returns to the two-door chooser.
  await page.getByRole("button", { name: /Cambiar opción/ }).click();
  await expect(page.getByRole("button", { name: "El Salvador y el mundo" })).toBeVisible();
  await expect(page.locator("givebutter-giving-form")).toHaveCount(0);
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
