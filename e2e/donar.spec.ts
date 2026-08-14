import { expect, test, type Locator } from "@playwright/test";
import { DONAR_VERIFYING_NOTICE_DELAY_MS } from "../src/client/donation";

/**
 * End-to-end test for the PUBLIC donor-checkout pages against a REAL local
 * Cloudflare Worker (SPA + API served by `wrangler dev`, not vite). These pages
 * render WITHOUT a session, so — unlike smoke.spec.ts — there is no bootstrap /
 * login step.
 *
 * The donor flow is a step wizard: Paso 1 monto (segmented
 * control + hero amount input), Paso 2 datos, Paso 3 the Wompi handoff. The US
 * door shares Paso 1 and mounts Stripe Embedded Checkout inside Paso 2.
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
  // Billing Portal and result-return destinations stay offline-safe in browser tests.
  await context.route("https://checkout.stripe.test/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<html lang=\"es\"><body>Entrega segura de Stripe simulada</body></html>" })
  );
  await context.route("https://billing.stripe.test/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: "<html lang=\"es\"><body>Administración mensual simulada</body></html>" })
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
  await page.getByRole("button", { name: "Continuar con su diezmo", exact: true }).click();
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
  let wompiIframeRequestHeld = false;
  let releaseWompiIframe!: () => void;
  const wompiIframeRelease = new Promise<void>((resolve) => {
    releaseWompiIframe = resolve;
  });
  await page.route("https://mock.wompi.sv/**", async (route) => {
    wompiIframeRequestHeld = true;
    await wompiIframeRelease;
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<html><body>mock wompi hosted flow</body></html>"
    });
  });
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
  const embed = page.locator("iframe.donar-embed");
  await expect(embed).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => wompiIframeRequestHeld).toBe(true);

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
  releaseWompiIframe();
  await expect(page.frameLocator("iframe.donar-embed").getByText("mock wompi hosted flow")).toBeVisible();
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

test("the EE. UU. door mounts one idempotent monthly Stripe form in Spanish", async ({ page }) => {
  const checkoutBodies: Array<Record<string, unknown>> = [];
  const givebutterRequests: string[] = [];
  await page.route("https://givebutter.com/**", (route) => {
    givebutterRequests.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "<html lang=\"en\"><body>Givebutter test form</body></html>"
    });
  });
  await page.route("**/api/donations/stripe/checkout", async (route) => {
    checkoutBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (checkoutBodies.length === 1) {
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ message: "No pudimos preparar su entrega con Stripe. Inténtelo de nuevo." })
      });
      return;
    }
    if (checkoutBodies.length === 2) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "stripe_checkout_indeterminate",
          message: "Su entrega sigue pendiente de confirmación. Inténtelo de nuevo en un momento."
        })
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "cs_test_browser_fixture",
        clientSecret: "cs_test_browser_fixture_secret_mock",
        publishableKey: "pk_test_mock",
        mock: true
      })
    });
  });
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

  // Paso 1 keeps the complete choice explicit: gift type then frequency.
  await expect(page.getByRole("heading", { name: "Diezmos y Ofrendas" })).toBeVisible();
  // The assurance subtitle names the US tax-deductible receipt in formal IRS terms.
  await expect(
    page.getByText("Recibirá un recibo oficial deducible de impuestos (IRS 501c3) en su dirección de correo electrónico.")
  ).toBeVisible();
  await expect(page.getByText("Paso 1 de 2")).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Tipo de entrega" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Diezmo" })).toBeChecked();
  await page.getByRole("radio", { name: "Ofrenda" }).check();
  await expect(page.getByRole("radiogroup", { name: "Frecuencia de la entrega" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Única" })).toBeChecked();
  await page.getByRole("radio", { name: "Mensual" }).check();
  await expect(page.getByText("Su entrega se realizará cada mes hasta que usted la cancele.")).toBeVisible();
  await expect(page.getByLabel("Monto")).not.toBeFocused();

  // The extranjero mechanics and SV fields are skipped entirely.
  await expect(page.getByLabel("Resido en el extranjero")).toHaveCount(0);
  await expect(page.getByLabel("Número de documento")).toHaveCount(0);
  await expect(page.getByLabel("Departamento")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continuar con su ofrenda" })).toBeVisible();

  // A quick-amount chip fills the shared hero input.
  await expect(page.getByRole("button", { name: "$25", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "$100", exact: true }).click();
  await expect(page.getByLabel("Monto")).toHaveValue("100.00");
  await page.getByRole("button", { name: "Continuar con su ofrenda", exact: true }).click();

  // Paso 2 reviews the choice and immediately prepares the in-page Stripe form.
  await expect(page.getByText("Paso 2 de 2")).toBeVisible();
  await expect(page.getByText("Su entrega", { exact: true })).toBeVisible();
  await expect(page.getByText("Ofrenda · Mensual · $100.00")).toBeVisible();
  await expect(page.locator(".donar-intro")).toContainText(`apoya a ${BRANDING_DISPLAY_NAME} en El Salvador`);
  await expect(page.locator(".donar-intro")).toContainText("Friends of Iglesia Ejemplo Central (501c3)");
  await expect(
    page.getByText("Stripe mostrará en español las opciones disponibles para usted de forma segura.")
  ).toHaveCount(0);

  // The escape hatch back to the SV fiscal form is GONE.
  await expect(page.getByText("¿Necesita comprobante fiscal salvadoreño (CDE)?")).toHaveCount(0);

  // "← Atrás" returns to Paso 1 with the wizard state intact...
  await page.getByRole("button", { name: /Atrás/ }).click();
  await expect(page.getByText("Paso 1 de 2")).toBeVisible();
  await expect(page.getByLabel("Monto")).toHaveValue("100.00");
  await expect(page.getByRole("radio", { name: "Ofrenda" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Mensual" })).toBeChecked();
  await page.getByRole("button", { name: "Continuar con su ofrenda", exact: true }).click();

  // A transport failure and its indeterminate hold remain on Paso 2; every
  // controlled retry reuses the exact UUID until Stripe resolves the same key.
  await expect(page.getByRole("alert")).toContainText("No pudimos preparar su entrega con Stripe");
  await page.getByRole("button", { name: "Intentar de nuevo" }).click();
  await expect(page.getByRole("alert")).toContainText("sigue pendiente de confirmación");
  await page.getByRole("button", { name: "Intentar de nuevo" }).click();

  // Editar without changing the amount, gift type, or frequency must reuse the
  // current Stripe attempt without another Checkout-session request.
  await expect(page.getByRole("button", { name: "Editar" })).toBeVisible();
  await page.getByRole("button", { name: "Editar" }).click();
  await expect(page.getByText("Paso 1 de 2")).toBeVisible();
  await page.getByRole("button", { name: "Continuar con su ofrenda", exact: true }).click();

  // Local mock mode preserves the Stripe-hosted boundary without pretending to
  // expose a hand-maintained subset of wallets, fields, or payment methods.
  await expect(page.getByText("Simulación local del formulario alojado por Stripe")).toBeVisible();
  const hostedPreview = page.getByRole("heading", { name: "Formulario seguro alojado por Stripe" });
  await expect(hostedPreview).toBeVisible();
  await expect(page.getByText(/cada opción elegible para la persona donante/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Apple Pay" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Google Pay" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Link" })).toHaveCount(0);
  await expect(page.getByLabel("Correo electrónico")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Tarjeta" })).toHaveCount(0);
  await expect(page.getByRole("radio", { name: "Cuenta bancaria de EE. UU." })).toHaveCount(0);

  // Givebutter is an explicit alternative. Selecting it removes Stripe's embedded
  // tree entirely, preserves the amount/frequency prefill, and can return to the
  // already-created Stripe Session without minting another one.
  const givebutterChoice = page.getByRole("button", { name: /Dar con Givebutter.*Formulario en inglés/i });
  await expect(givebutterChoice).toBeVisible();
  await expect(givebutterChoice.locator("img")).toBeVisible();
  const givebutterChoiceBox = await givebutterChoice.boundingBox();
  expect(givebutterChoiceBox).not.toBeNull();
  expect(givebutterChoiceBox!.width).toBeLessThanOrEqual(360);
  expect(givebutterChoiceBox!.height).toBeGreaterThanOrEqual(44);
  expect(givebutterChoiceBox!.height).toBeLessThanOrEqual(54);
  expect(givebutterRequests).toEqual([]);
  await givebutterChoice.click();
  await expect(page.locator(".donar-stripe-embedded")).toHaveCount(0);
  const givebutterFrame = page.getByTitle("Formulario de donación Givebutter (en inglés)");
  await expect(givebutterFrame).toBeVisible();
  await expect(givebutterFrame).toHaveAttribute(
    "src",
    "https://givebutter.com/embed/c/example-campaign?amount=100&frequency=monthly&goalBar=false"
  );
  expect(givebutterRequests).toEqual([
    "https://givebutter.com/embed/c/example-campaign?amount=100&frequency=monthly&goalBar=false"
  ]);
  // One escape hatch out of a non-rendering embed — never a hint and a button to the
  // same hosted page — and it sits above the 760px frame, so a donor facing a blank
  // box never has to scroll past it to find the way out. The anchor keeps
  // .donar-givebutter-hint in both its quiet and its promoted state.
  const givebutterHatch = page.locator(".donar-givebutter-hint");
  await expect(givebutterHatch).toHaveCount(1);
  await expect(page.locator('.donar-givebutter-surface a[href^="https://givebutter.com/"]')).toHaveCount(1);
  const hatchBox = await givebutterHatch.boundingBox();
  const frameBox = await givebutterFrame.boundingBox();
  expect(hatchBox).not.toBeNull();
  expect(frameBox).not.toBeNull();
  expect(hatchBox!.y).toBeLessThan(frameBox!.y);
  await page.getByRole("button", { name: /Volver a Stripe.*Formulario en español/i }).click();
  await expect(givebutterFrame).toHaveCount(0);
  await expect(page.locator(".donar-stripe-embedded")).toBeVisible();

  // Stripe reuses the Wompi handoff shell: the hosted surface is full-bleed on
  // mobile and aligns to the raised card edges on tablet/desktop. Only the
  // provider-owned content inside that boundary differs.
  await expect(page.locator(".donar-stripe > .donar-handoff")).toBeVisible();
  const stripeEmbed = page.locator(".donar-stripe-embedded");
  const mobileViewport = { width: 393, height: 852 };
  await page.setViewportSize(mobileViewport);
  const mobileStripeBox = await stripeEmbed.boundingBox();
  expect(mobileStripeBox).not.toBeNull();
  expect(mobileStripeBox!.x).toBeCloseTo(0, 1);
  expect(mobileStripeBox!.x + mobileStripeBox!.width).toBeCloseTo(mobileViewport.width, 1);
  expect(await stripeEmbed.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderWidth: style.borderTopWidth, borderRadius: style.borderRadius };
  })).toEqual({ borderWidth: "0px", borderRadius: "0px" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(mobileViewport.width);

  const desktopViewport = { width: 671, height: 944 };
  await page.setViewportSize(desktopViewport);
  const desktopCardBox = await page.locator(".donar-card").boundingBox();
  const desktopStripeBox = await stripeEmbed.boundingBox();
  expect(desktopCardBox).not.toBeNull();
  expect(desktopStripeBox).not.toBeNull();
  expect(desktopCardBox!.width).toBeCloseTo(560, 1);
  expect(desktopStripeBox!.x).toBeCloseTo(desktopCardBox!.x + 1, 1);
  expect(desktopStripeBox!.x + desktopStripeBox!.width).toBeCloseTo(
    desktopCardBox!.x + desktopCardBox!.width - 1,
    1
  );
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(desktopViewport.width);

  expect(checkoutBodies).toHaveLength(3);
  expect(checkoutBodies[0]).toMatchObject({ amount: "100.00", frequency: "monthly", giftType: "offering" });
  expect(checkoutBodies[1]).toEqual(checkoutBodies[0]);
  expect(checkoutBodies[2]).toEqual(checkoutBodies[0]);
  expect(String(checkoutBodies[0].requestId)).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  );
  await expect(page).toHaveURL(/^http:\/\/127\.0\.0\.1:8787\/(?:donar)?\?ruta=eeuu$/);
});

test("a terminal Stripe Session failure releases the current browser request identity", async ({ page }) => {
  const checkoutBodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/donations/stripe/checkout", async (route) => {
    checkoutBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (checkoutBodies.length === 1) {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "stripe_checkout_unavailable",
          message: "Inicie una nueva entrega para continuar con Stripe."
        })
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "cs_test_terminal_retry_fixture",
        clientSecret: "cs_test_terminal_retry_fixture_secret_mock",
        publishableKey: "pk_test_mock",
        mock: true
      })
    });
  });

  await page.goto("/donar?ruta=eeuu");
  await page.getByRole("button", { name: "$50", exact: true }).click();
  await page.getByRole("button", { name: "Continuar con su diezmo", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Inicie una nueva entrega");
  await page.getByRole("button", { name: "Intentar de nuevo" }).click();
  await expect(page.getByText("Simulación local del formulario alojado por Stripe")).toBeVisible();

  expect(checkoutBodies).toHaveLength(2);
  expect(checkoutBodies[1]).toMatchObject({
    amount: checkoutBodies[0].amount,
    frequency: checkoutBodies[0].frequency,
    giftType: checkoutBodies[0].giftType
  });
  expect(checkoutBodies[1].requestId).not.toBe(checkoutBodies[0].requestId);
});

test("editing an unchanged Stripe attempt replaces a rejected cached Session promise", async ({ page }) => {
  const checkoutBodies: Array<Record<string, unknown>> = [];
  await page.route("**/api/donations/stripe/checkout", async (route) => {
    checkoutBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (checkoutBodies.length === 1) {
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ message: "No pudimos preparar su entrega con Stripe. Inténtelo de nuevo." })
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "cs_test_edited_retry_fixture",
        clientSecret: "cs_test_edited_retry_fixture_secret_mock",
        publishableKey: "pk_test_mock",
        mock: true
      })
    });
  });

  await page.goto("/donar?ruta=eeuu");
  await page.getByRole("button", { name: "$50", exact: true }).click();
  await page.getByRole("button", { name: "Continuar con su diezmo", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("No pudimos preparar su entrega con Stripe");

  await page.getByRole("button", { name: "Editar" }).click();
  await page.getByRole("button", { name: "Continuar con su diezmo", exact: true }).click();
  await expect(page.getByText("Simulación local del formulario alojado por Stripe")).toBeVisible();

  expect(checkoutBodies).toHaveLength(2);
  expect(checkoutBodies[1]).toEqual(checkoutBodies[0]);
});

test("a stale rejected Stripe request cannot clear the newer attempt identity", async ({ page }) => {
  const checkoutBodies: Array<Record<string, unknown>> = [];
  let releaseOld!: () => void;
  let oldResponseSent = false;
  const oldBarrier = new Promise<void>((resolve) => { releaseOld = resolve; });
  await page.route("**/api/donations/stripe/checkout", async (route) => {
    checkoutBodies.push(route.request().postDataJSON() as Record<string, unknown>);
    if (checkoutBodies.length === 1) {
      await oldBarrier;
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: "stripe_checkout_unavailable",
          message: "Inicie una nueva entrega para continuar con Stripe."
        })
      });
      oldResponseSent = true;
      return;
    }
    if (checkoutBodies.length === 2) {
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ message: "No pudimos preparar su entrega con Stripe. Inténtelo de nuevo." })
      });
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "cs_test_stale_owner_fixture",
        clientSecret: "cs_test_stale_owner_fixture_secret_mock",
        publishableKey: "pk_test_mock",
        mock: true
      })
    });
  });

  await page.goto("/donar?ruta=eeuu");
  await page.getByRole("button", { name: "$50", exact: true }).click();
  await page.getByRole("button", { name: "Continuar con su diezmo", exact: true }).click();
  await expect(page.getByText("Preparando su formulario seguro con Stripe…")).toBeVisible();

  await page.getByRole("button", { name: "Editar" }).click();
  await page.getByLabel("Monto").fill("100.00");
  await page.getByRole("button", { name: "Continuar con su diezmo", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("No pudimos preparar su entrega con Stripe");

  releaseOld();
  await expect.poll(() => oldResponseSent).toBe(true);
  await page.waitForTimeout(50);
  await page.getByRole("button", { name: "Intentar de nuevo" }).click();
  await expect(page.getByText("Simulación local del formulario alojado por Stripe")).toBeVisible();

  expect(checkoutBodies).toHaveLength(3);
  expect(checkoutBodies[0]).toMatchObject({ amount: "50.00" });
  expect(checkoutBodies[1]).toMatchObject({ amount: "100.00" });
  expect(checkoutBodies[2]).toMatchObject({ amount: "100.00" });
  expect(checkoutBodies[2].requestId).toBe(checkoutBodies[1].requestId);
  expect(checkoutBodies[1].requestId).not.toBe(checkoutBodies[0].requestId);
});

test("a canceled Stripe handoff returns to a neutral Spanish retry state", async ({ page }) => {
  await page.goto("/donar?ruta=eeuu&cancelado=1");
  await expect(page.getByText("Su entrega no se completó. Puede revisar los datos e intentarlo de nuevo cuando desee.")).toBeVisible();
  await expect(page.getByRole("radio", { name: "Única" })).toBeChecked();
  await expect(page.getByLabel("Monto")).toHaveValue("");
});

test("the Stripe result waits for durable confirmation and opens Spanish recurring management", async ({ page }) => {
  const sessionId = "cs_test_result_fixture";
  let statusReads = 0;
  let portalBody: Record<string, unknown> | null = null;
  await page.route("**/api/donations/stripe/session/**", async (route) => {
    statusReads += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: statusReads === 1 ? "PENDING" : "PAID",
        frequency: "MONTHLY",
        amountCents: 10000,
        currency: "usd",
        canManageRecurring: statusReads > 1,
        recurringStatus: "ACTIVE"
      })
    });
  });
  await page.route("**/api/donations/stripe/portal", async (route) => {
    portalBody = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "https://billing.stripe.test/session/browser_fixture" })
    });
  });

  await page.goto(`/donar/stripe/resultado?session_id=${sessionId}`);
  await expect(page.getByRole("heading", { name: "Diezmos y Ofrendas" })).toBeVisible();
  await expect(page.getByText("Su entrega", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Confirmando su entrega…" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Dios le bendiga. Su aportación fue recibida." })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("$100.00 USD")).toBeVisible();
  await Promise.all([
    page.waitForURL("https://billing.stripe.test/**"),
    page.getByRole("button", { name: "Administrar mi entrega mensual" }).click()
  ]);
  expect(portalBody).toEqual({ sessionId });
  await expect(page.getByText("Administración mensual simulada")).toBeVisible();
});

test("the Stripe result narrates a canceled monthly gift without implying future deliveries", async ({ page }) => {
  await page.route("**/api/donations/stripe/session/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status: "PAID",
        frequency: "MONTHLY",
        amountCents: 10000,
        currency: "usd",
        canManageRecurring: false,
        recurringStatus: "CANCELED"
      })
    })
  );

  await page.goto("/donar/stripe/resultado?session_id=cs_test_canceled_fixture");
  await expect(page.getByRole("heading", { name: "Dios le bendiga. Su aportación fue recibida." })).toBeVisible();
  await expect(page.getByText(/Su entrega mensual está cancelada/)).toBeVisible();
  await expect(page.getByText(/no se programarán nuevas aportaciones/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Administrar mi entrega mensual" })).toHaveCount(0);
});

test("SV to US safety routing requires an explicit single-rail Stripe confirmation", async ({ page }) => {
  const wompiDraftBodies: Record<string, unknown>[] = [];
  const stripeCheckoutBodies: Record<string, unknown>[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== "POST") return;
    if (pathname === "/api/donations/intent") {
      wompiDraftBodies.push(request.postDataJSON() as Record<string, unknown>);
    }
    if (pathname === "/api/donations/stripe/checkout") {
      stripeCheckoutBodies.push(request.postDataJSON() as Record<string, unknown>);
    }
  });

  await page.goto("/donar?ruta=sv");
  await page.getByLabel("Monto").fill("25.00");
  await page.getByRole("radio", { name: "Ofrenda" }).check();
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await page.getByLabel("Número de documento").fill("10000001-9");

  // Residence is still unknown at the end of SV Step 1, so no Wompi link may be
  // minted yet. This keeps the later US safety reroute from leaving two usable rails.
  expect(wompiDraftBodies).toHaveLength(0);

  await page.getByLabel("Resido en el extranjero").check();
  await page.getByLabel("País").selectOption({ label: "Estados Unidos" });

  // The safety route restarts at the explicit US Step 1. The amount and selected
  // gift type remain truthful, but no Stripe Session exists before confirmation.
  await expect(page.getByText("Paso 1 de 2")).toBeVisible();
  await expect(page.getByLabel("Monto")).toHaveValue("25.00");
  await expect(page.getByRole("radio", { name: "Ofrenda" })).toBeChecked();
  await expect(page.getByRole("radio", { name: "Única" })).toBeChecked();
  expect(stripeCheckoutBodies).toHaveLength(0);
  expect(wompiDraftBodies).toHaveLength(0);

  await page.getByRole("button", { name: "Continuar con su ofrenda", exact: true }).click();
  await expect.poll(() => stripeCheckoutBodies.length).toBe(1);
  expect(stripeCheckoutBodies[0]).toMatchObject({
    amount: "25.00",
    frequency: "once",
    giftType: "offering"
  });
  expect(wompiDraftBodies).toHaveLength(0);
});

test("chooser, SV, and mock US surfaces never load Stripe.js", async ({ page, context }) => {
  const stripeJsRequests: string[] = [];
  await context.route("https://js.stripe.com/**", async (route) => {
    stripeJsRequests.push(route.request().url());
    await route.abort();
  });

  await page.goto("/donar");
  await expect(page.getByRole("button", { name: /El Salvador y el mundo/ })).toBeVisible();
  expect(stripeJsRequests).toHaveLength(0);

  await page.getByRole("button", { name: /El Salvador y el mundo/ }).click();
  await expect(page.getByText("Paso 1 de 3")).toBeVisible();
  expect(stripeJsRequests).toHaveLength(0);

  await page.getByRole("button", { name: /Cambiar opción/ }).click();
  await page.getByRole("button", { name: /EE\. UU\./ }).click();
  await page.getByLabel("Monto").fill("50.00");
  await page.getByRole("button", { name: "Continuar con su diezmo", exact: true }).click();
  await expect(page.getByText("Simulación local del formulario alojado por Stripe")).toBeVisible();
  await expect(page.getByText("El formulario simulado no envía datos a Stripe.")).toBeVisible();
  expect(stripeJsRequests).toHaveLength(0);

  await page.goto("/admin");
  await expect(page.getByLabel("Contraseña")).toBeVisible();
  expect(stripeJsRequests).toHaveLength(0);
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
