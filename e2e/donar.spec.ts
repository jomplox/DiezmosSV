import { expect, test } from "@playwright/test";

/**
 * End-to-end test for the PUBLIC donor-checkout pages against a REAL local
 * Cloudflare Worker (SPA + API served by `wrangler dev`, not vite). These pages
 * render WITHOUT a session, so — unlike smoke.spec.ts — there is no bootstrap /
 * login step.
 *
 * The donor flow is a step wizard (Givebutter-style): Paso 1 monto (segmented
 * control + hero amount input), Paso 2 datos, Paso 3 the Wompi handoff. The US
 * door shares Paso 1 and reveals the embedded Givebutter form on Paso 2.
 *
 * In mock mode (MOCK_EXTERNAL_SERVICES="true") the backend returns deterministic
 * mock Wompi links (https://mock.wompi.sv/...). The real Wompi widget script is
 * loaded from pagos.wompi.sv, but it cannot act on a mock URL, so this test only
 * asserts the HANDOFF state (the widget area appears, or the app attempts the
 * graceful full-page fallback to urlEnlace). It never depends on real Wompi
 * network access: requests to mock.wompi.sv / pagos.wompi.sv are stubbed so
 * nothing leaves the sandbox.
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

test("the SV wizard walks monto → datos → Wompi handoff", async ({ page }) => {
  await page.goto("/donar");

  // The public page opens on the two-door chooser (renders without a session).
  await expect(page.getByRole("heading", { name: "Diezmos y Ofrendas" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continuar", exact: true })).toHaveCount(0);

  // Door 1 (El Salvador y el mundo) opens the SV fiscal (Wompi + CDE) wizard.
  await page.getByRole("button", { name: "El Salvador y el mundo" }).click();

  // Paso 1 — Monto. The diezmo/ofrenda framing (flagged 🇸🇻) heads the card; the
  // step indicator and the segmented control render; the hero input is auto-focused.
  await expect(page.getByRole("heading", { name: "Entregue su diezmo u ofrenda 🇸🇻" })).toBeVisible();
  // The assurance subtitle names the CDE this SV path produces.
  await expect(page.getByText("Recibirá su comprobante de donación electrónico (CDE) por correo.")).toBeVisible();
  await expect(page.getByText("Paso 1 de 3")).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Tipo" })).toBeVisible();
  // Diezmo is preselected on mount.
  await expect(page.getByRole("radio", { name: "Diezmo" })).toBeChecked();
  await expect(page.getByLabel("Monto")).toBeFocused();

  // The old "Otro monto" afterthought field is gone: the hero input IS the monto.
  await expect(page.getByPlaceholder("Otro monto")).toHaveCount(0);

  // Paso 2 fields are NOT on this screen (one concern per step).
  await expect(page.getByLabel("Número de documento")).toHaveCount(0);

  // Diezmo is already preselected; .check() is a no-op that confirms it. Continue
  // requires a tipo + amount, both now satisfied.
  await page.getByRole("radio", { name: "Diezmo" }).check();
  await page.getByLabel("Monto").fill(DONOR.amount);
  await page.getByRole("button", { name: "Continuar", exact: true }).click();

  // Paso 2 — Sus datos. Focus lands on the first field; name/email are entered
  // on Wompi's sheet, not here.
  await expect(page.getByText("Paso 2 de 3")).toBeVisible();
  await expect(page.getByLabel("Tipo de documento")).toBeFocused();
  await expect(page.getByLabel("Nombre completo")).toHaveCount(0);
  await expect(page.getByLabel("Correo electrónico")).toHaveCount(0);

  // Default document type is DUI (13).
  await page.getByLabel("Número de documento").fill(DONOR.dui);

  // Cascading selects: municipio options depend on the chosen departamento.
  await page.getByLabel("Departamento").selectOption({ label: "San Salvador" });
  await page.getByLabel("Municipio").selectOption({ index: 1 });
  await page.getByLabel("Distrito").selectOption({ index: 1 });
  await page.getByLabel("Dirección").fill("San Salvador, El Salvador");

  // Entering Paso 3 creates the payment intent.
  await page.getByRole("button", { name: "Continuar al pago" }).click();

  // Paso 3 — Pago. The summary line recaps the Paso 1 choice with an Editar way
  // back, above the Wompi handoff.
  await expect(page.getByText("Paso 3 de 3")).toBeVisible();
  await expect(page.getByText("Diezmo · $1.00")).toBeVisible();
  await expect(page.getByRole("button", { name: "Editar" })).toBeVisible();

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

test("the EE. UU. door shares Paso 1 and reveals the Givebutter (FMCE) embed", async ({ page }) => {
  await page.goto("/donar");
  await expect(page.getByRole("heading", { name: "Diezmos y Ofrendas" })).toBeVisible();

  // Door 2 (EE. UU.) opens the US wizard — no extranjero toggle anywhere.
  await page.getByRole("button", { name: "EE. UU." }).click();

  // Paso 1 — Monto. The US flow has its own heading (flagged 🇺🇸) and a 2-step
  // count; the monthly toggle is the segmented control (Única | Mensual, real radios).
  await expect(page.getByRole("heading", { name: "Diezmos y Ofrendas 🇺🇸" })).toBeVisible();
  // The assurance subtitle names the US tax-deductible receipt this path produces.
  await expect(page.getByText("Recibirá un recibo deducible de impuestos en EE. UU. por correo.")).toBeVisible();
  await expect(page.getByText("Paso 1 de 2")).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Donación mensual" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Única" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Mensual" })).toBeVisible();
  await expect(page.getByLabel("Monto")).toBeFocused();

  // The extranjero mechanics and SV fields are skipped entirely.
  await expect(page.getByLabel("Resido en el extranjero")).toHaveCount(0);
  await expect(page.getByLabel("Número de documento")).toHaveCount(0);
  await expect(page.getByLabel("Dirección")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continuar al pago" })).toHaveCount(0);

  // A quick-amount chip fills the hero input.
  await page.getByRole("button", { name: "$25", exact: true }).click();
  await expect(page.getByLabel("Monto")).toHaveValue("25.00");
  await page.getByRole("button", { name: "Continuar", exact: true }).click();

  // Paso 2 — the donor's real Paso 2/3 is the Givebutter giving form. A summary
  // line with Editar sits above the FMCE explanation and the embed.
  await expect(page.getByText("Paso 2 de 2")).toBeVisible();
  await expect(page.getByText("Única · $25.00")).toBeVisible();
  await expect(page.getByText("Friends of Misión ExampleOrganization")).toBeVisible();
  await expect(page.getByText("El formulario de pago se muestra en inglés.")).toBeVisible();
  await expect(page.locator("givebutter-giving-form")).toHaveAttribute("campaign", "example-campaign");

  // The escape hatch back to the SV fiscal form is GONE.
  await expect(page.getByText("¿Necesita comprobante fiscal salvadoreño (CDE)?")).toHaveCount(0);

  // The always-visible hint uses the human "GiveButter" anchor text (no raw URL),
  // carrying the Paso 1 amount as the prefill.
  const hint = page.getByRole("link", { name: "¿Problemas con el formulario? Done en GiveButter" });
  await expect(hint).toHaveAttribute("href", /givebutter\.com\/example-campaign/);
  await expect(hint).toHaveAttribute("href", /amount=25/);

  // The stubbed widget never renders, so the prominent fallback CTA appears too.
  const fallback = page.getByRole("link", { name: "Donar en GiveButter" });
  await expect(fallback).toBeVisible({ timeout: 10_000 });
  await expect(fallback).toHaveAttribute("href", /givebutter\.com\/example-campaign\?amount=25/);

  // "← Atrás" returns to Paso 1 with the wizard state intact...
  await page.getByRole("button", { name: /Atrás/ }).click();
  await expect(page.getByText("Paso 1 de 2")).toBeVisible();
  await expect(page.getByLabel("Monto")).toHaveValue("25.00");
  await expect(page.locator("givebutter-giving-form")).toHaveCount(0);

  // ...and "← Cambiar opción" (Paso 1 only) returns to the two-door chooser.
  await page.getByRole("button", { name: /Cambiar opción/ }).click();
  await expect(page.getByRole("button", { name: "El Salvador y el mundo" })).toBeVisible();
  await expect(page.locator("givebutter-giving-form")).toHaveCount(0);
});

test("thank-you page shows the webhook-driven CDE copy", async ({ page }) => {
  await page.goto("/donar/gracias?monto=1.00&idTransaccion=TEST");

  await expect(page.getByRole("heading", { name: "Dios le bendiga. Su aportación fue recibida." })).toBeVisible();
  await expect(
    page.getByText("Recibirá su comprobante (CDE) por correo cuando el Ministerio de Hacienda lo confirme.")
  ).toBeVisible();
  // Monto is displayed from the query string (display only).
  await expect(page.getByText("Monto: $1.00")).toBeVisible();
});
