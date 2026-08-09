import { expect, test, type Locator } from "@playwright/test";
import { DONAR_VERIFYING_NOTICE_DELAY_MS, GIVEBUTTER_CAMPAIGN } from "../src/client/donation";

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
 * mock Wompi links (https://mock.wompi.sv/...). Paso 3 embeds the checkout page
 * (urlEnlaceLargo + esWidget=1) directly in an iframe — no Wompi script, no
 * modal, never an automatic redirect. Requests to mock.wompi.sv are stubbed so
 * the iframe loads a placeholder and nothing leaves the sandbox.
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

// The Givebutter campaign slug is build configuration (VITE_GIVEBUTTER_CAMPAIGN), so the
// URL-shape assertions below interpolate whatever the app under test was built with.
const CAMPAIGN_PATTERN = GIVEBUTTER_CAMPAIGN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A configured display name for the branding stub: distinct from the seeded demo
// organization, so "the stub was honored" stays a real assertion.
const BRANDING_DISPLAY_NAME = "Iglesia Ejemplo Central";

async function renderedSvFlagDiameter(icon: Locator): Promise<number> {
  return icon.evaluate((element) => {
    const svg = element as SVGSVGElement;
    const flag = svg.querySelector("clipPath circle");
    const radius = Number(flag?.getAttribute("r"));
    return radius * 2 * (svg.getBoundingClientRect().width / svg.viewBox.baseVal.width);
  });
}

test.beforeEach(async ({ context }) => {
  // Keep everything inside the sandbox: stub the mock hosted-payment host (the
  // embed iframe src in mock mode) so no real network egress occurs.
  await context.route("https://mock.wompi.sv/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>mock wompi hosted flow</body></html>" })
  );
  // Stub the Givebutter hosted + embed pages so the iframe path stays offline-safe.
  await context.route("https://givebutter.com/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "<html><body>mock givebutter hosted flow</body></html>" })
  );
});

test("a clean donor load reveals only the fully styled page", async ({ page }) => {
  await page.route("**/*.woff2", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.continue();
  });

  await page.goto("/donar?cold-load=1", { waitUntil: "domcontentloaded" });
  const root = page.locator("#root");
  await expect(root).toHaveCSS("visibility", "hidden");

  await page.waitForFunction(() => document.fonts.status === "loaded");
  await expect(root).toHaveCSS("visibility", "visible");
  await expect(page.getByText("Elija según su lugar de residencia.")).toBeVisible();
});

test("keeps the ceremonial browser title across every donor entry route", async ({ page }) => {
  for (const path of ["/", "/donar", "/donar?ruta=sv"]) {
    await page.goto(path);
    await expect(page).toHaveTitle("Diezmos y Ofrendas");

    await page.reload();
    await expect(page).toHaveTitle("Diezmos y Ofrendas");
  }
});

test("uses neutral donor attribution when public branding has no configured name", async ({ page }) => {
  await page.route("**/api/branding", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        displayName: "   ",
        accentColor: "#000000",
        supportEmail: "support@example.org",
        logoVersion: null,
        donorLogoVersion: null
      })
    })
  );

  await page.goto("/donar");
  await expect(page.locator(".donar-landing-unifier")).toContainText("esta iglesia en El Salvador");
  await expect(page.getByText(/ExamplePerson1|ExampleOrganization/)).toHaveCount(0);

  await page.getByRole("button", { name: "EE. UU." }).click();
  await page.getByLabel("Monto").fill("100.00");
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await expect(page.locator(".donar-intro")).toContainText("apoya a esta iglesia en El Salvador");
  await expect(page.locator(".donar-intro")).toContainText("una organización estadounidense 501c3");
  await expect(page.getByText(/ExamplePerson1|ExampleOrganization/)).toHaveCount(0);
});

test("the direct SV route leaves the amount unfocused until the donor taps it", async ({ page }) => {
  await page.goto("/donar?ruta=sv");

  const amount = page.getByLabel("Monto");
  // The heading's flag is an aria-hidden inline SVG badge (emoji rendered as a
  // blank box off-Apple), so the accessible name is the bare title.
  const heading = page.getByRole("heading", { name: "Diezmos y Ofrendas" });
  await expect(heading).toBeVisible();
  const worldIcon = heading.locator("svg.donar-title-world-icon");
  await expect(worldIcon).toBeVisible();
  const globe = worldIcon.locator("g > circle");
  const flag = worldIcon.locator("clipPath circle");
  const globeRadius = Number(await globe.getAttribute("r"));
  const flagRadius = Number(await flag.getAttribute("r"));
  const globeX = Number(await globe.getAttribute("cx"));
  const flagX = Number(await flag.getAttribute("cx"));
  const globeY = Number(await globe.getAttribute("cy"));
  const flagY = Number(await flag.getAttribute("cy"));
  expect({ x: flagX, y: flagY, radius: flagRadius }).toEqual({ x: 48, y: 34, radius: 32 });
  expect({ x: globeX, y: globeY, radius: globeRadius }).toEqual({ x: 94, y: 34, radius: 24 });
  expect(flagX).toBeLessThan(globeX);
  expect(flagY).toBe(globeY);
  expect(flagRadius).toBeGreaterThan(globeRadius);
  expect(Math.hypot(globeX - flagX, globeY - flagY)).toBeLessThan(flagRadius + globeRadius);
  await expect(amount).not.toBeFocused();

  await amount.click();
  await expect(amount).toBeFocused();
});

test("the amount fields accept only dollars and cents in both donation lanes", async ({ page }) => {
  for (const route of ["sv", "eeuu"]) {
    await page.goto(`/donar?ruta=${route}`);
    const amount = page.getByLabel("Monto");

    await amount.fill("aaza");
    await expect(amount).toHaveValue("");

    await amount.fill("12.34");
    await expect(amount).toHaveValue("12.34");

    await amount.fill("12.345");
    await expect(amount).toHaveValue("12.34");
  }
});

test("keeps the home chooser artwork unchanged", async ({ page }) => {
  await page.goto("/donar");

  const svDoorIcon = page
    .getByRole("button", { name: "El Salvador y el mundo Comprobante de donación DTE salvadoreño", exact: true })
    .locator("svg");
  const usDoorFlag = page
    .getByRole("button", { name: "EE. UU. Recibo oficial deducible de impuestos (IRS 501c3)", exact: true })
    .locator("svg");
  await expect(svDoorIcon).toBeVisible();
  await expect(usDoorFlag).toBeVisible();
  await expect(svDoorIcon).toHaveAttribute("viewBox", "0 0 96 96");
  await expect(usDoorFlag).toHaveClass("donar-door-icon");
  const svDoorGlobe = svDoorIcon.locator("g > circle");
  const svDoorFlag = svDoorIcon.locator("clipPath circle");
  const svDoorGlobeX = Number(await svDoorGlobe.getAttribute("cx"));
  const svDoorGlobeY = Number(await svDoorGlobe.getAttribute("cy"));
  const svDoorGlobeRadius = Number(await svDoorGlobe.getAttribute("r"));
  const svDoorFlagX = Number(await svDoorFlag.getAttribute("cx"));
  const svDoorFlagY = Number(await svDoorFlag.getAttribute("cy"));
  const svDoorFlagRadius = Number(await svDoorFlag.getAttribute("r"));
  expect({ x: svDoorGlobeX, y: svDoorGlobeY, radius: svDoorGlobeRadius }).toEqual({ x: 42, y: 38, radius: 30 });
  expect({ x: svDoorFlagX, y: svDoorFlagY, radius: svDoorFlagRadius }).toEqual({ x: 69, y: 69, radius: 25 });
  expect(Math.hypot(svDoorGlobeX - svDoorFlagX, svDoorGlobeY - svDoorFlagY)).toBeLessThan(
    svDoorGlobeRadius + svDoorFlagRadius
  );
});

test("matches the EE. UU. secondary heading flag size to the SV secondary heading", async ({ page }) => {

  await page.goto("/donar?ruta=sv");
  const svTitleIcon = page.locator("svg.donar-title-world-icon");
  await expect(svTitleIcon).toBeVisible();
  const svTitleFlagDiameter = await renderedSvFlagDiameter(svTitleIcon);

  await page.goto("/donar?ruta=eeuu");
  const usTitleFlag = page.locator("svg.donar-title-lane-flag");
  await expect(usTitleFlag).toBeVisible();
  const usTitleFlagBox = await usTitleFlag.boundingBox();
  expect(usTitleFlagBox).not.toBeNull();
  expect(Math.abs(usTitleFlagBox!.width - svTitleFlagDiameter)).toBeLessThanOrEqual(1);
});

test("keeps the home chooser's original spacing", async ({ page }) => {
  await page.goto("/donar");

  await expect(page.locator(".donar-logo")).toHaveCSS("margin-bottom", "2px");
  const subtitle = page.locator(".donar-landing-subtitle");
  await expect(subtitle).toHaveCSS("margin-top", "0px");
  await expect(subtitle).toHaveCSS("margin-bottom", "6px");
});

test("keeps the desktop chooser doors equal-height with the annotated U.S. padding", async ({ page }) => {
  await page.setViewportSize({ width: 852, height: 987 });
  await page.goto("/donar");

  await expect(page.locator(".donar-doors")).toHaveCSS("align-items", "stretch");
  const svDoor = page.locator(".donar-door").nth(0);
  const usDoor = page.locator(".donar-door").nth(1);
  await expect(svDoor).toHaveCSS("padding-top", "24px");
  await expect(svDoor).toHaveCSS("padding-bottom", "24px");
  await expect(usDoor).toHaveCSS("padding-top", "35px");
  await expect(usDoor).toHaveCSS("padding-bottom", "35px");

  const [svBox, usBox] = await Promise.all([svDoor.boundingBox(), usDoor.boundingBox()]);
  expect(svBox).not.toBeNull();
  expect(usBox).not.toBeNull();
  expect(svBox!.height).toBe(usBox!.height);
  expect(usBox!.x - (svBox!.x + svBox!.width)).toBeCloseTo(14, 5);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.locator(".donar-door").nth(1)).toHaveCSS("padding-top", "14px");
  await expect(page.locator(".donar-door").nth(1)).toHaveCSS("padding-bottom", "14px");
});

test("the SV wizard walks monto → datos → Wompi handoff", async ({ page }) => {
  // Keep the whole flow at a phone-height viewport. Clicking the actions near the
  // bottom naturally scrolls the document, so each newly rendered view must
  // explicitly return the donor to its top.
  await page.setViewportSize({ width: 393, height: 700 });
  await page.goto("/donar");

  // The public page opens on the two-door chooser (renders without a session).
  await expect(page.getByRole("heading", { name: "Diezmos y Ofrendas" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continuar", exact: true })).toHaveCount(0);

  // Door 1 (El Salvador y el mundo) opens the SV fiscal (Wompi + CDE) wizard.
  await page.getByRole("button", { name: "El Salvador y el mundo" }).click();

  // Paso 1 — Monto. The diezmo/ofrenda framing (SV flag badge) heads the card; the
  // step indicator and segmented control render without summoning a mobile keyboard.
  await expect(page.getByRole("heading", { name: "Diezmos y Ofrendas" })).toBeVisible();
  // The assurance subtitle names the comprobante this SV path produces (user-centered
  // copy: donors know "DTE", not the CDE initials).
  await expect(page.getByText("Recibirá por correo electrónico un comprobante de donación oficial (DTE), con validez fiscal únicamente en El Salvador.")).toBeVisible();
  await expect(page.getByText("Paso 1 de 3")).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Tipo" })).toBeVisible();
  // Diezmo is preselected on mount.
  await expect(page.getByRole("radio", { name: "Diezmo" })).toBeChecked();
  await expect(page.getByLabel("Monto")).not.toBeFocused();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // The old "Otro monto" afterthought field is gone: the hero input IS the monto.
  await expect(page.getByPlaceholder("Otro monto")).toHaveCount(0);

  // Paso 2 fields are NOT on this screen (one concern per step).
  await expect(page.getByLabel("Número de documento")).toHaveCount(0);

  // Diezmo is already preselected; .check() is a no-op that confirms it. Continue
  // requires a tipo + amount, both now satisfied.
  await page.getByRole("radio", { name: "Diezmo" }).check();
  await page.getByLabel("Monto").fill(DONOR.amount);
  await page.getByRole("button", { name: "Continuar", exact: true }).click();

  // Paso 2 — Sus datos. The ceremonial header stays; a small caps step label
  // sits under the title. Nothing is auto-focused: focusing the native document
  // type select opens its picker on some mobile browsers.
  await expect(page.getByText("Paso 2 de 3")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Diezmos y Ofrendas" })).toBeVisible();
  await expect(page.getByText("Sus datos", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Tipo de documento")).not.toBeFocused();
  await expect(page.getByLabel("Nombre completo")).toHaveCount(0);
  await expect(page.getByLabel("Correo electrónico")).toHaveCount(0);
  // Wompi's hosted sheet forces both, so /donar must not ask a second time.
  await expect(page.getByLabel("Dirección")).toHaveCount(0);
  await expect(page.getByLabel("Teléfono (opcional)")).toHaveCount(0);
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // Default document type is DUI (13).
  await page.getByLabel("Número de documento").fill(DONOR.dui);

  // Cascading selects: municipio options depend on the chosen departamento.
  await page.getByLabel("Departamento").selectOption({ label: "San Salvador" });
  await page.getByLabel("Municipio").selectOption({ index: 1 });
  await page.getByLabel("Distrito").selectOption({ index: 1 });

  // Entering Paso 3 creates the payment intent.
  // The submit names the donor's own gift (entrega framing — never "pago").
  await page.getByRole("button", { name: "Continuar con su diezmo" }).click();

  // Paso 3 — the handoff step is labeled "Su entrega" (entrega framing, never
  // "pago"). The summary line recaps the Paso 1 choice with an Editar way back.
  await expect(page.getByText("Paso 3 de 3")).toBeVisible();
  await expect(page.getByText("Su entrega", { exact: true })).toBeVisible();
  await expect(page.getByText("Diezmo · $1.00")).toBeVisible();
  await expect(page.getByRole("button", { name: "Editar" })).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  // Handoff: the checkout is EMBEDDED in the wizard card — an iframe pointing at
  // the payment link with the esWidget flag — with the manual backup link below.
  // There is no automatic redirect: the donor stays on the canonical root wizard.
  const embed = page.locator("iframe.donar-embed");
  await expect(embed).toBeVisible({ timeout: 15_000 });
  await expect(embed).toHaveAttribute("src", /mock\.wompi\.sv.*esWidget=1/);
  for (const { reportedHeight, renderedHeight, inlineHeight } of [
    { reportedHeight: 430, renderedHeight: 465, inlineHeight: 465 },
    { reportedHeight: 710, renderedHeight: 546, inlineHeight: 745 }
  ]) {
    await page.evaluate((height) => {
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://pagos.wompi.sv",
          data: JSON.stringify({ message: "sizeUpdate", height })
        })
      );
    }, reportedHeight);
    await expect(embed).toHaveCSS("height", `${renderedHeight}px`);
    await expect(embed).toHaveAttribute("style", `height: ${inlineHeight}px;`);
  }

  // On mobile the hosted Wompi surface reaches the viewport edges so the only
  // remaining gutter belongs to Wompi itself. The surrounding donor shell is
  // flat and full-bleed at this size. At the tablet/desktop breakpoint the
  // established raised-card treatment and iframe alignment remain.
  const mobileViewport = { width: 393, height: 852 };
  await page.setViewportSize(mobileViewport);
  const mobileCardBox = await page.locator(".donar-card").boundingBox();
  const mobileEmbedBox = await embed.boundingBox();
  const mobileShellStyles = await page.evaluate(() => {
    const screen = getComputedStyle(document.querySelector(".donar-screen")!);
    const card = getComputedStyle(document.querySelector(".donar-card")!);
    const iframe = getComputedStyle(document.querySelector("iframe.donar-embed")!);
    return {
      screenPadding: screen.padding,
      cardBorderWidth: card.borderTopWidth,
      cardBorderRadius: card.borderRadius,
      cardBoxShadow: card.boxShadow,
      iframeBorderWidth: iframe.borderTopWidth,
      iframeBorderRadius: iframe.borderRadius
    };
  });
  expect(mobileCardBox).not.toBeNull();
  expect(mobileEmbedBox).not.toBeNull();
  expect(mobileCardBox!.x).toBeCloseTo(0, 1);
  expect(mobileCardBox!.x + mobileCardBox!.width).toBeCloseTo(mobileViewport.width, 1);
  expect(mobileEmbedBox!.x).toBeCloseTo(0, 1);
  expect(mobileEmbedBox!.x + mobileEmbedBox!.width).toBeCloseTo(mobileViewport.width, 1);
  expect(mobileEmbedBox!.height).toBeCloseTo(mobileViewport.height * 0.78, 1);
  expect(await embed.getAttribute("scrolling")).toBeNull();
  expect(mobileShellStyles).toEqual({
    screenPadding: "0px",
    cardBorderWidth: "0px",
    cardBorderRadius: "0px",
    cardBoxShadow: "none",
    iframeBorderWidth: "0px",
    iframeBorderRadius: "0px"
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(mobileViewport.width);

  const desktopViewport = { width: 671, height: 944 };
  await page.setViewportSize(desktopViewport);
  const cardBox = await page.locator(".donar-card").boundingBox();
  const desktopEmbedBox = await embed.boundingBox();
  expect(cardBox).not.toBeNull();
  expect(desktopEmbedBox).not.toBeNull();
  expect(desktopEmbedBox!.x).toBeCloseTo(cardBox!.x + 1, 1);
  expect(desktopEmbedBox!.x + desktopEmbedBox!.width).toBeCloseTo(cardBox!.x + cardBox!.width - 1, 1);
  expect(desktopEmbedBox!.height).toBeCloseTo(745, 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(desktopViewport.width);

  await expect(page.getByRole("button", { name: "¿Problemas con el formulario? Continúe aquí" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});

test("keeps checking the same intent when Wompi closes before its webhook is visible", async ({ page }) => {
  let paymentConfirmed = false;
  let statusChecks = 0;
  await page.route("**/api/donations/intent/*/status", (route) => {
    statusChecks += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: paymentConfirmed ? "COMPLETED" : "LINK_CREATED",
        paid: paymentConfirmed
      })
    });
  });

  await page.goto("/donar?ruta=sv");
  await page.getByLabel("Monto").fill(DONOR.amount);
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await page.getByLabel("Número de documento").fill(DONOR.dui);
  await page.getByLabel("Departamento").selectOption({ label: "San Salvador" });
  await page.getByLabel("Municipio").selectOption({ index: 1 });
  await page.getByLabel("Distrito").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Continuar con su diezmo" }).click();
  await expect(page.locator("iframe.donar-embed")).toBeVisible({ timeout: 15_000 });

  // The iframe can become visible before React has flushed the effects that install
  // both status polling and the Wompi message listener. Wait for the first poll so a
  // synthetic close cannot race ahead of the listener in headed Chromium.
  await expect.poll(() => statusChecks).toBeGreaterThan(0);
  statusChecks = 0;
  await page.evaluate(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://pagos.wompi.sv",
        data: JSON.stringify({ message: "close" })
      })
    );
  });

  await expect.poll(() => statusChecks).toBeGreaterThan(0);
  const verifyingMessage = page.getByText("Verificando su entrega…");
  await expect(verifyingMessage).toHaveCount(0);
  await expect(verifyingMessage).toBeVisible({
    timeout: DONAR_VERIFYING_NOTICE_DELAY_MS + 5_000
  });
  const verifyingSpinner = page.locator(".donar-widget-loading .donar-spinner");
  await expect(verifyingSpinner).toBeVisible();
  await expect(verifyingSpinner).toHaveCSS("width", "24px");
  await expect(verifyingSpinner).toHaveCSS("height", "24px");
  await expect(verifyingSpinner).toHaveCSS("border-top-width", "3px");
  await expect(page.getByLabel("Número de documento")).toHaveCount(0);

  paymentConfirmed = true;
  await expect(page.getByRole("heading", { name: "Dios le bendiga. Su aportación fue recibida." })).toBeVisible({
    timeout: 10_000
  });
});

test("Paso 2 reports every invalid field at once and clears each error as it is fixed", async ({ page }) => {
  await page.goto("/donar?ruta=sv");
  await page.getByLabel("Monto").fill(DONOR.amount);
  await page.getByRole("button", { name: "Continuar", exact: true }).click();

  // Submit the empty datos form: EVERY invalid control reports at once, each
  // message under its own field — no fix-one-resubmit-see-the-next loop.
  await page.getByRole("button", { name: "Continuar con su diezmo" }).click();
  await expect(page.getByText("Revise el número de DUI.")).toBeVisible();
  await expect(page.getByText("Seleccione un departamento.")).toBeVisible();
  await expect(page.getByText("Seleccione un municipio.")).toBeVisible();
  await expect(page.getByText("Seleccione un distrito.")).toBeVisible();
  // No dirección error: the field is gone — Wompi's sheet collects the address.
  await expect(page.getByText("Ingrese su dirección.")).toHaveCount(0);

  // Focus moved to the first invalid control, and it is marked for AT.
  const documento = page.getByLabel("Número de documento");
  await expect(documento).toBeFocused();
  await expect(documento).toHaveAttribute("aria-invalid", "true");

  // Fixing a field clears ITS message immediately; the others stay until fixed.
  await documento.fill(DONOR.dui);
  await expect(page.getByText("Revise el número de DUI.")).toHaveCount(0);
  await expect(page.getByText("Seleccione un departamento.")).toBeVisible();

  // The dependent selects clear their own errors as the cascade is completed.
  await page.getByLabel("Departamento").selectOption({ label: "San Salvador" });
  await expect(page.getByText("Seleccione un departamento.")).toHaveCount(0);
  await expect(page.getByText("Seleccione un municipio.")).toBeVisible();
});

test("the EE. UU. door shares Paso 1 and reveals the Givebutter embed", async ({ page }) => {
  await page.route("**/api/branding", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        displayName: BRANDING_DISPLAY_NAME,
        accentColor: "#000000",
        supportEmail: "support@example.org",
        logoVersion: null,
        donorLogoVersion: null
      })
    })
  );
  await page.goto("/donar");
  await expect(page.getByRole("heading", { name: "Diezmos y Ofrendas" })).toBeVisible();
  await expect(page.getByText(`${BRANDING_DISPLAY_NAME} en El Salvador`, { exact: false })).toBeVisible();
  await expect(page.getByText(/ExampleOrganization/)).toHaveCount(0);

  // Door 2 (EE. UU.) opens the US wizard — no extranjero toggle anywhere.
  await page.getByRole("button", { name: "EE. UU." }).click();

  // Paso 1 — Monto. The US flow shares the title (its flag badge is aria-hidden
  // SVG) and a 2-step count; the monthly toggle is the segmented control (Única |
  // Mensual, real radios).
  await expect(page.getByRole("heading", { name: "Diezmos y Ofrendas" })).toBeVisible();
  // The assurance subtitle names the US tax-deductible receipt in formal IRS terms.
  await expect(
    page.getByText("Recibirá un recibo oficial deducible de impuestos (IRS 501c3) en su dirección de correo electrónico.")
  ).toBeVisible();
  await expect(page.getByText("Paso 1 de 2")).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Donación mensual" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Única" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Mensual" })).toBeVisible();
  await expect(page.getByLabel("Monto")).not.toBeFocused();

  // The extranjero mechanics and SV fields are skipped entirely.
  await expect(page.getByLabel("Resido en el extranjero")).toHaveCount(0);
  await expect(page.getByLabel("Número de documento")).toHaveCount(0);
  await expect(page.getByLabel("Departamento")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Continuar con su/ })).toHaveCount(0);

  // A quick-amount chip fills the hero input. The US door's anchors bridge toward
  // the Givebutter campaign presets ($100–$2,000) instead of the SV $5–$50 scale.
  await expect(page.getByRole("button", { name: "$25", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "$100", exact: true }).click();
  await expect(page.getByLabel("Monto")).toHaveValue("100.00");
  await page.getByRole("button", { name: "Continuar", exact: true }).click();

  // Paso 2 — the donor's real Paso 2/3 is the Givebutter giving form. A summary
  // line with Editar sits above the 501c3 explanation and the embed.
  await expect(page.getByText("Paso 2 de 2")).toBeVisible();
  await expect(page.getByText("Su entrega", { exact: true })).toBeVisible();
  await expect(page.getByText("Única · $100.00")).toBeVisible();
  await expect(page.getByText(`Friends of ${BRANDING_DISPLAY_NAME}`)).toBeVisible();
  await expect(page.getByText("El formulario se muestra en inglés.")).toBeVisible();
  const givebutterFrame = page.locator("iframe.donar-givebutter-frame");
  await expect(givebutterFrame).toBeVisible();
  await expect(givebutterFrame).toHaveAttribute("src", new RegExp(`^https://givebutter\\.com/embed/c/${CAMPAIGN_PATTERN}\\?`));
  await expect(givebutterFrame).toHaveAttribute("src", /amount=100/);
  await expect(givebutterFrame).toHaveAttribute("src", /goalBar=false/);

  // The escape hatch back to the SV fiscal form is GONE.
  await expect(page.getByText("¿Necesita comprobante fiscal salvadoreño (CDE)?")).toHaveCount(0);

  // The always-visible hint uses the human "GiveButter" anchor text (no raw URL),
  // carrying the Paso 1 amount as the prefill.
  const hint = page.getByRole("link", { name: "¿Problemas con el formulario? Done en GiveButter" });
  await expect(hint).toHaveAttribute("href", new RegExp(`^https://givebutter\\.com/${CAMPAIGN_PATTERN}\\?`));
  await expect(hint).toHaveAttribute("href", /amount=100/);

  // The direct iframe loaded, so the slow-load CTA is not shown.
  await expect(page.getByRole("link", { name: "Donar en GiveButter" })).toHaveCount(0);

  // "← Atrás" returns to Paso 1 with the wizard state intact...
  await page.getByRole("button", { name: /Atrás/ }).click();
  await expect(page.getByText("Paso 1 de 2")).toBeVisible();
  await expect(page.getByLabel("Monto")).toHaveValue("100.00");
  await expect(page.locator("iframe.donar-givebutter-frame")).toHaveCount(0);

  // ...and "← Cambiar opción" (Paso 1 only) returns to the two-door chooser.
  await page.getByRole("button", { name: /Cambiar opción/ }).click();
  await expect(page.getByRole("button", { name: "El Salvador y el mundo" })).toBeVisible();
  await expect(page.locator("iframe.donar-givebutter-frame")).toHaveCount(0);
});

test("extranjero + USA on the SV form forwards to Givebutter, and Atrás returns to the SV datos", async ({ page }) => {
  // Regression: a donor on the SV door who checks "Resido en el extranjero" and picks
  // Estados Unidos is forwarded to the Givebutter path (intended), but used to be
  // TRAPPED there — Atrás only walked the US steps and re-picking the SV door kept the
  // lingering foreignResident+US form state, re-forwarding forever.
  await page.goto("/donar?ruta=sv");
  await page.getByLabel("Monto").fill("25.00");
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await page.getByLabel("Número de documento").fill("10000001-9");

  // Forward: extranjero + Estados Unidos → the US (Givebutter) path takes over
  // (the step label under the title reads "Su entrega").
  await page.getByLabel("Resido en el extranjero").check();
  await page.getByLabel("País").selectOption({ label: "Estados Unidos" });
  await expect(page.getByText("Su entrega", { exact: true })).toBeVisible();
  await expect(page.getByText("Paso 2 de 2")).toBeVisible();

  // THE ESCAPE: Atrás returns to the SV datos screen — datos intact, extranjero still
  // checked, país cleared back to "Seleccione" so the donor can re-choose or uncheck.
  await page.getByRole("button", { name: /Atrás/ }).click();
  await expect(page.getByText("Paso 2 de 3")).toBeVisible();
  await expect(page.getByLabel("Número de documento")).toHaveValue("10000001-9");
  await expect(page.getByLabel("Resido en el extranjero")).toBeChecked();
  await expect(page.getByLabel("País")).toHaveValue("");

  // Unchecking restores the domestic SV fields.
  await page.getByLabel("Resido en el extranjero").uncheck();
  await expect(page.getByLabel("Departamento")).toBeVisible();
});

test("thank-you page does not trust unverified redirect parameters", async ({ page }) => {
  await page.route("**/api/branding", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        displayName: "Iglesia Configurada",
        accentColor: "#000000",
        supportEmail: "support@example.org",
        logoVersion: null,
        donorLogoVersion: null
      })
    })
  );
  await page.goto("/donar/gracias?idTransaccion=TEST&monto=4999.99");

  await expect(page.getByRole("heading", { name: "No pudimos verificar su entrega todavía." })).toBeVisible();
  await expect(page.getByText("Si completó su entrega, recibirá su comprobante de donación por correo electrónico.")).toBeVisible();
  await expect(page.getByRole("link", { name: "support@example.org" })).toHaveAttribute("href", "mailto:support@example.org");
  await expect(page.getByRole("heading", { name: "Dios le bendiga. Su aportación fue recibida." })).toHaveCount(0);
  await expect(page.getByText("4999.99")).toHaveCount(0);
});

test("thank-you page shows the webhook-driven CDE copy after server verification", async ({ page }) => {
  await page.route("**/api/branding", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        displayName: "Iglesia Configurada",
        accentColor: "#000000",
        supportEmail: "support@example.org",
        logoVersion: null,
        donorLogoVersion: null
      })
    })
  );
  await page.route("**/api/donations/intent/di_verified/status", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "LINK_CREATED", paid: true })
    })
  );
  await page.goto("/donar/gracias?identificadorEnlaceComercio=di_verified&idTransaccion=TEST&monto=1.00");

  await expect(page.getByRole("heading", { name: "Dios le bendiga. Su aportación fue recibida." })).toBeVisible();
  await expect(
    page.getByText("Recibirá su comprobante de donación por correo electrónico cuando el Ministerio de Hacienda lo confirme.")
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "support@example.org" })).toHaveAttribute("href", "mailto:support@example.org");
  await expect(page.getByText("Monto: $1.00")).toHaveCount(0);
});

test("SV quick amounts preserve the previously verified donor anchors", async ({ page }) => {
  await page.goto("/donar?ruta=sv");

  for (const amount of ["$50", "$150", "$250", "$500"]) {
    await expect(page.getByRole("button", { name: amount, exact: true })).toBeVisible();
  }
  for (const staleAmount of ["$5", "$10", "$25"]) {
    await expect(page.getByRole("button", { name: staleAmount, exact: true })).toHaveCount(0);
  }
});
