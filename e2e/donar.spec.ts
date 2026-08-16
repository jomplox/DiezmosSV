import { expect, test, type Locator, type Page, type Route } from "@playwright/test";
import {
  DONAR_VERIFYING_NOTICE_DELAY_MS,
  GIVEBUTTER_RENDER_TIMEOUT_MS
} from "../src/client/donation";

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
const BRANDING_SUPPORT_EMAIL = "support@example.org";
const CONFIGURED_DONOR_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 12 12"><rect width="12" height="12" fill="#111"/></svg>`;

interface RouteDelay {
  held: Promise<void>;
  release: () => void;
  requestCount: () => number;
}

async function delayRoute(
  page: Page,
  url: string,
  fulfill: Parameters<Route["fulfill"]>[0]
): Promise<RouteDelay> {
  let markHeld!: () => void;
  let release!: () => void;
  let requestCount = 0;
  const held = new Promise<void>((resolve) => { markHeld = resolve; });
  const released = new Promise<void>((resolve) => { release = resolve; });
  page.once("close", release);
  await page.route(url, async (route) => {
    requestCount += 1;
    markHeld();
    await released;
    await route.fulfill(fulfill).catch(() => {
      // A RED assertion may close the page before releasing a held provider request.
    });
  });
  return { held, release, requestCount: () => requestCount };
}

async function enterWompiHandoff(page: Page): Promise<void> {
  await page.goto("/donar?ruta=sv");
  await page.getByLabel("Monto").fill(DONOR.amount);
  await page.getByRole("button", { name: "Continuar", exact: true }).click();
  await page.getByLabel("Número de documento").fill(DONOR.dui);
  await page.getByLabel("Departamento").selectOption({ label: "San Salvador" });
  await page.getByLabel("Municipio").selectOption({ index: 1 });
  await page.getByLabel("Distrito").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Continuar con su diezmo" }).click();
}

async function enterStripeHandoff(page: Page): Promise<void> {
  await page.goto("/donar?ruta=eeuu");
  await page.getByRole("button", { name: "$50", exact: true }).click();
  await page.getByRole("button", { name: "Continuar con su diezmo", exact: true }).click();
}

async function rememberNode(locator: Locator, key: string): Promise<void> {
  await locator.evaluate((element, storageKey) => {
    (window as Window & { __providerNodes?: Record<string, Element> }).__providerNodes ??= {};
    (window as Window & { __providerNodes: Record<string, Element> }).__providerNodes[storageKey] = element;
  }, key);
}

async function isRememberedNode(locator: Locator, key: string): Promise<boolean> {
  return locator.evaluate((element, storageKey) => (
    (window as Window & { __providerNodes?: Record<string, Element> }).__providerNodes?.[storageKey] === element
  ), key);
}

async function mobileProviderShellMetrics(provider: Locator) {
  return provider.evaluate((element) => {
    const providerBox = element.getBoundingClientRect();
    const dockBox = document.querySelector(".donar-provider-dock")!.getBoundingClientRect();
    return {
      providerTop: Math.round(providerBox.top),
      providerBottom: Math.round(providerBox.bottom),
      providerHeight: Math.round(providerBox.height),
      dockTop: Math.round(dockBox.top),
      pageScrollRange: Math.round(
        Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight
      ),
      pageScrollY: Math.round(window.scrollY)
    };
  });
}

const MOCK_STRIPE_JS = `
window.Stripe = function () {
  let mountedFrame = null;
  return {
    elements: function () { return {}; },
    createToken: function () {},
    createPaymentMethod: function () {},
    confirmCardPayment: function () {},
    _registerWrapper: function () {},
    registerAppInfo: function () {},
    createEmbeddedCheckoutPage: function (options) {
      window.__stripeEmbeddedCheckoutCreates = (window.__stripeEmbeddedCheckoutCreates || 0) + 1;
      window.__emitStripeAnalyticsEvent = function (eventType) {
        var details = eventType === "deviceData"
          ? { device: { category: "desktop", language: "es", platform: "test", viewport: { width: 1280, height: 720 } } }
          : { items: [], currency: "usd", amount: 5000 };
        options.onAnalyticsEvent({
          checkoutSession: "cs_test_delayed_embedded_fixture",
          eventType: eventType,
          details: details,
          clientMetadata: {},
          timestamp: Math.floor(Date.now() / 1000)
        });
      };
      window.__setStripeFrameHeight = function (height) {
        if (mountedFrame) mountedFrame.style.setProperty("height", height + "px", "important");
      };
      return Promise.resolve({
        mount: function (node) {
          mountedFrame = document.createElement("iframe");
          mountedFrame.title = "Formulario seguro de Stripe";
          mountedFrame.scrolling = "no";
          mountedFrame.src = "https://checkout.stripe.test/embedded-delayed";
          node.appendChild(mountedFrame);
        },
        unmount: function () { if (mountedFrame) mountedFrame.remove(); },
        destroy: function () { if (mountedFrame) mountedFrame.remove(); }
      });
    }
  };
};`;

async function recordDonorLogoNodes(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    const logoNodes: string[] = [];
    const record = (node: Node) => {
      if (!(node instanceof Element)) return;
      if (node.matches(".donar-logo")) {
        logoNodes.push(node.tagName);
      }
      node.querySelectorAll(".donar-logo").forEach((logo) => logoNodes.push(logo.tagName));
    };
    new MutationObserver((records) => records.forEach((mutation) => mutation.addedNodes.forEach(record)))
      .observe(document, { childList: true, subtree: true });
    (window as Window & { donorLogoNodes?: string[] }).donorLogoNodes = logoNodes;
  });
}

async function recordedDonorLogoNodes(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(() => (window as Window & { donorLogoNodes?: string[] }).donorLogoNodes ?? []);
}

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

test("never mounts the stock donor mark while delayed configured branding settles on either donor route", async ({ page }) => {
  for (const path of ["/donar", "/donar/stripe/resultado"]) {
    let releaseBranding: ((route: import("@playwright/test").Route) => void) | undefined;
    const brandingRequest = new Promise<import("@playwright/test").Route>((resolve) => {
      releaseBranding = resolve;
    });
    await recordDonorLogoNodes(page);
    await page.route("**/api/branding", (route) => releaseBranding?.(route));
    await page.route("**/api/branding/donor-logo**", (route) =>
      route.fulfill({ status: 200, contentType: "image/svg+xml", body: CONFIGURED_DONOR_LOGO })
    );

    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#root")).toHaveCSS("visibility", "visible", { timeout: 4_000 });
    await expect(page.locator("svg.donar-logo")).toHaveCount(0);

    const route = await brandingRequest;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        displayName: BRANDING_DISPLAY_NAME,
        accentColor: "#000000",
        supportEmail: BRANDING_SUPPORT_EMAIL,
        logoVersion: null,
        donorLogoVersion: "configured-logo"
      })
    });

    await expect(page.getByRole("img", { name: BRANDING_DISPLAY_NAME })).toBeVisible();
    await expect(page.getByRole("link", { name: BRANDING_SUPPORT_EMAIL })).toHaveAttribute("href", `mailto:${BRANDING_SUPPORT_EMAIL}`);
    expect(await recordedDonorLogoNodes(page)).toEqual(["IMG"]);
    await page.unroute("**/api/branding");
    await page.unroute("**/api/branding/donor-logo**");
  }
});

test("uses the stock donor mark only after no-logo branding or a branding failure resolves", async ({ page }) => {
  for (const [label, response] of [
    ["no logo", { status: 200, body: JSON.stringify({
      displayName: BRANDING_DISPLAY_NAME,
      accentColor: "#000000",
      supportEmail: BRANDING_SUPPORT_EMAIL,
      logoVersion: null,
      donorLogoVersion: null
    }) }],
    ["request failure", { status: 500, body: JSON.stringify({ error: "branding_unavailable" }) }]
  ] as const) {
    for (const path of ["/donar", "/donar/stripe/resultado"]) {
      let releaseBranding: ((route: import("@playwright/test").Route) => void) | undefined;
      const brandingRequest = new Promise<import("@playwright/test").Route>((resolve) => {
        releaseBranding = resolve;
      });
      await recordDonorLogoNodes(page);
      await page.route("**/api/branding", (route) => releaseBranding?.(route));

      await page.goto(path, { waitUntil: "domcontentloaded" });
      await expect(page.locator("#root")).toHaveCSS("visibility", "visible", { timeout: 4_000 });
      await expect(page.locator("svg.donar-logo"), label).toHaveCount(0);

      const route = await brandingRequest;
      await route.fulfill({ status: response.status, contentType: "application/json", body: response.body });

      await expect(page.locator("svg.donar-logo"), label).toBeVisible();
      expect(await recordedDonorLogoNodes(page)).toEqual(["svg"]);
      await page.unroute("**/api/branding");
    }
  }
});

test("keeps the donor logo space neutral when a configured logo cannot decode", async ({ page }) => {
  for (const path of ["/donar", "/donar/stripe/resultado"]) {
    let releaseBranding: ((route: import("@playwright/test").Route) => void) | undefined;
    const brandingRequest = new Promise<import("@playwright/test").Route>((resolve) => {
      releaseBranding = resolve;
    });
    await recordDonorLogoNodes(page);
    await page.route("**/api/branding", (route) => releaseBranding?.(route));
    await page.route("**/api/branding/donor-logo**", (route) =>
      route.fulfill({ status: 200, contentType: "image/png", body: "not an image" })
    );

    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#root")).toHaveCSS("visibility", "visible", { timeout: 4_000 });
    await expect(page.locator("svg.donar-logo")).toHaveCount(0);

    const route = await brandingRequest;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        displayName: BRANDING_DISPLAY_NAME,
        accentColor: "#000000",
        supportEmail: BRANDING_SUPPORT_EMAIL,
        logoVersion: null,
        donorLogoVersion: "broken-logo"
      })
    });

    await expect(page.locator(".donar-logo-placeholder")).toBeVisible();
    await expect(page.locator(".donar-logo")).toHaveCount(0);
    expect(await recordedDonorLogoNodes(page)).toEqual([]);
    await page.unroute("**/api/branding");
    await page.unroute("**/api/branding/donor-logo**");
  }
});

test("settles configured donor support without a stock mark when image decoding stalls", async ({ page }) => {
  for (const path of ["/donar", "/donar/stripe/resultado"]) {
    await recordDonorLogoNodes(page);
    await page.addInitScript(() => {
      const decode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = function() {
        return this.src.includes("/api/branding/donor-logo")
          ? new Promise<void>(() => {})
          : decode.call(this);
      };
    });
    await page.route("**/api/branding", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          displayName: BRANDING_DISPLAY_NAME,
          accentColor: "#000000",
          supportEmail: BRANDING_SUPPORT_EMAIL,
          logoVersion: null,
          donorLogoVersion: "stalled-logo"
        })
      })
    );
    await page.goto(path, { waitUntil: "domcontentloaded" });
    await expect(page.locator("#root")).toHaveCSS("visibility", "visible", { timeout: 4_000 });
    await expect(page.getByRole("link", { name: BRANDING_SUPPORT_EMAIL })).toHaveAttribute("href", `mailto:${BRANDING_SUPPORT_EMAIL}`);
    await expect(page.locator(".donar-logo-placeholder")).toBeVisible();
    await expect(page.locator(".donar-logo")).toHaveCount(0);
    expect(await recordedDonorLogoNodes(page)).toEqual([]);
    await page.unroute("**/api/branding");
  }
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

  await expect(page.getByRole("link", { name: "¿Problemas con el formulario? Continúe aquí" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});

test("a delayed Wompi frame keeps one stable loader and only the quiet escape hatch", async ({ page }) => {
  const wompiDelay = await delayRoute(page, "https://mock.wompi.sv/**", {
    status: 200,
    contentType: "text/html",
    body: "<html><body>mock wompi delayed flow</body></html>"
  });

  await enterWompiHandoff(page);
  await wompiDelay.held;

  const loader = page.locator('.donar-widget-loading[role="status"]');
  await expect(loader).toHaveCount(1);
  await expect(loader).toContainText("Preparando su entrega segura…");
  await rememberNode(loader, "wompi-loader");
  await expect(loader.locator(".donar-spinner")).toHaveCSS("animation-name", "donar-spin");

  const escapeHatch = page.getByRole("link", {
    name: "¿Problemas con el formulario? Continúe aquí",
    exact: true
  });
  await expect(escapeHatch).toHaveCount(1);
  await expect(page.getByText("Continuar en Wompi", { exact: true })).toHaveCount(0);
  await page.waitForTimeout(4_500);
  await expect(loader).toHaveCount(1);
  expect(await isRememberedNode(loader, "wompi-loader")).toBe(true);
  await expect(page.getByText("Continuar en Wompi", { exact: true })).toHaveCount(0);
  expect(await escapeHatch.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      textDecorationLine: style.textDecorationLine,
      whiteSpace: style.whiteSpace,
      backgroundColor: style.backgroundColor,
      borderWidth: style.borderTopWidth
    };
  })).toEqual({
    textDecorationLine: "underline",
    whiteSpace: "nowrap",
    backgroundColor: "rgba(0, 0, 0, 0)",
    borderWidth: "0px"
  });

  wompiDelay.release();
  await expect(page.frameLocator("iframe.donar-embed").getByText("mock wompi delayed flow")).toBeVisible();
  await expect(loader).toHaveCount(0);
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
      body: `<!doctype html>
        <html lang="en">
          <head>
            <style>
              html, body { margin: 0; }
              body { min-height: 1400px; }
            </style>
          </head>
          <body>
            <p>Givebutter test form</p>
            <p style="margin-top: 1250px">Givebutter test form end</p>
          </body>
        </html>`
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
  const legalOrganizationLink = page.getByRole("link", {
    name: `Friends of ${BRANDING_DISPLAY_NAME}`,
    exact: true
  });
  await expect(legalOrganizationLink).toHaveAttribute(
    "href",
    "https://givebutter.com/amigos-de-elim/about"
  );
  await expect(legalOrganizationLink).toHaveAttribute("target", "_blank");
  await expect(legalOrganizationLink).toHaveAttribute("rel", "noopener noreferrer");
  await expect(page.locator(".donar-intro")).toHaveText(
    `Su aporte apoya a ${BRANDING_DISPLAY_NAME} en El Salvador y se procesa en EE. UU. por Friends of ${BRANDING_DISPLAY_NAME} (501c3).`
  );
  const introFlag = page.locator(".donar-intro .donar-flag");
  await expect(introFlag).toBeVisible();
  await expect(introFlag).toHaveAttribute("aria-hidden", "true");
  expect(await introFlag.evaluate((element) => element.tagName)).toBe("IMG");
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

  // Givebutter is an explicit alternative. Selecting it preserves the already-loaded
  // Stripe tree, keeps the amount/frequency prefill, and can return without minting
  // another Session or rebuilding either provider surface.
  const givebutterChoice = page.getByRole("button", {
    name: /^Ofrendar con Givebutter\s+\(Con formulario en inglés\)$/i
  });
  await expect(givebutterChoice).toBeVisible();
  await expect(givebutterChoice.locator("img")).toBeVisible();
  const givebutterChoiceBox = await givebutterChoice.boundingBox();
  expect(givebutterChoiceBox).not.toBeNull();
  expect(givebutterChoiceBox!.width).toBeLessThanOrEqual(440);
  expect(givebutterChoiceBox!.height).toBeGreaterThanOrEqual(44);
  expect(givebutterChoiceBox!.height).toBeLessThanOrEqual(54);
  // Stripe is the default path — it carries the Spanish form and the tax receipt — so
  // the alternative sits below it instead of interrupting the reading flow.
  const stripeEmbed = page.locator(".donar-stripe-embedded");
  await rememberNode(stripeEmbed, "stripe-provider-surface");
  const defaultStripeBox = await stripeEmbed.boundingBox();
  expect(defaultStripeBox).not.toBeNull();
  expect(givebutterChoiceBox!.y).toBeGreaterThanOrEqual(defaultStripeBox!.y + defaultStripeBox!.height);
  // …and it is painted in the page's monochrome vocabulary, not as the loudest thing
  // on screen: the Givebutter favicon is the only brand color the control spends.
  // The pointer is parked off the control first, and the read polls: :hover repaints
  // the border over a 140ms transition, so a single read can catch it mid-flight.
  await page.mouse.move(0, 0);
  await expect.poll(async () => await givebutterChoice.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderTopColor, backgroundImage: style.backgroundImage };
  })).toEqual({ borderColor: "rgb(216, 216, 216)", backgroundImage: "none" });
  expect(givebutterRequests).toEqual([]);
  await givebutterChoice.click();
  const providerAnnouncement = page.locator(".donar-provider-announcement");
  await expect(providerAnnouncement).toHaveText("Formulario de Givebutter, en inglés.");
  await expect(page.getByText(
    "Confirme en Givebutter el tipo de entrega, el monto y la frecuencia antes de continuar; estos datos se envían solo como valores iniciales."
  )).toHaveCount(0);
  await expect(stripeEmbed).toHaveCount(1);
  await expect(stripeEmbed).toBeHidden();
  expect(await isRememberedNode(stripeEmbed, "stripe-provider-surface")).toBe(true);
  const givebutterFrame = page.getByTitle("Formulario de donación Givebutter (en inglés)");
  await expect(givebutterFrame).toBeVisible();
  await rememberNode(givebutterFrame, "givebutter-provider-frame");
  const givebutterEmbedRequest = new URL(givebutterRequests.at(0) ?? "");
  expect(givebutterEmbedRequest.pathname).toBe("/embed/c/example-campaign");
  expect(givebutterEmbedRequest.searchParams.get("amount")).toBe("100");
  expect(givebutterEmbedRequest.searchParams.get("frequency")).toBe("monthly");
  // Synthetic browser-build fixture: this proves the selected Ofrenda maps to the
  // offering member of the pair without reading or printing any deployment value.
  expect(givebutterEmbedRequest.searchParams.get("fund")).toBe("842013");
  expect(givebutterEmbedRequest.searchParams.get("goalBar")).toBe("false");
  // One escape hatch out of a non-rendering embed — never a hint and a button to the
  // same hosted page — and it sits above the bounded frame, so a donor facing a blank
  // box never has to scroll past it to find the way out. The delayed class records
  // that the render budget elapsed without changing the donor-visible help text.
  const givebutterHatch = page.locator(".donar-givebutter-hint");
  await expect(givebutterHatch).toHaveCount(1);
  await expect(page.getByRole("link", {
    name: "¿Problemas con el formulario? Abrir Givebutter en una pestaña nueva"
  })).toBeVisible();
  await expect(givebutterHatch).toBeFocused();
  const externalLinkIcon = givebutterHatch.locator(".lucide-square-arrow-out-up-right");
  await expect(externalLinkIcon).toBeVisible();
  await expect(externalLinkIcon).toHaveAttribute("aria-hidden", "true");
  await expect(page.locator('.donar-givebutter-surface a[href^="https://givebutter.com/"]')).toHaveCount(1);
  const givebutterHostedPage = new URL(await givebutterHatch.getAttribute("href") ?? "");
  expect(givebutterHostedPage.searchParams.get("amount")).toBe("100");
  expect(givebutterHostedPage.searchParams.get("frequency")).toBe("monthly");
  expect(givebutterHostedPage.searchParams.get("fund")).toBe(
    givebutterEmbedRequest.searchParams.get("fund")
  );
  const hatchBox = await givebutterHatch.boundingBox();
  const frameBox = await givebutterFrame.boundingBox();
  expect(hatchBox).not.toBeNull();
  expect(frameBox).not.toBeNull();
  expect(hatchBox!.y).toBeLessThan(frameBox!.y);
  const givebutterHelpText = "¿Problemas con el formulario? Abrir Givebutter";
  await expect(givebutterHatch).toHaveText(givebutterHelpText);
  await expect(givebutterHatch).toHaveClass(/\bdonar-givebutter-fallback\b/, {
    timeout: GIVEBUTTER_RENDER_TIMEOUT_MS + 5_000
  });
  await expect(givebutterHatch).toHaveText(givebutterHelpText);
  expect(await givebutterHatch.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderWidth: style.borderTopWidth,
      borderRadius: style.borderRadius,
      textDecorationLine: style.textDecorationLine,
      whiteSpace: style.whiteSpace
    };
  })).toEqual({
    backgroundColor: "rgba(0, 0, 0, 0)",
    borderWidth: "0px",
    borderRadius: "0px",
    textDecorationLine: "underline",
    whiteSpace: "nowrap"
  });
  const stripeReturn = page.getByRole("button", {
    name: /^Volver a Stripe\s+\(Con formulario en español\)$/i
  });
  await expect(stripeReturn.locator(".donar-provider-stripe-mark")).toBeVisible();

  // On desktop the return path follows the bounded provider form in document flow.
  // On mobile the same return path and the single support contact form a fixed dock,
  // while the Givebutter document itself remains independently scrollable.
  const givebutterProviderDock = page.locator(".donar-provider-dock");
  await expect(givebutterProviderDock).toBeVisible();
  await expect(givebutterProviderDock.getByRole("button", {
    name: /^Volver a Stripe\s+\(Con formulario en español\)$/i
  })).toBeVisible();
  await expect(givebutterProviderDock.getByText("¿Dudas o necesita ayuda?", { exact: false })).toBeVisible();
  await expect(page.locator(".donar-support")).toHaveCount(1);
  expect(await givebutterProviderDock.evaluate((element) => getComputedStyle(element).position)).toBe("static");
  const desktopGivebutterDockBox = await givebutterProviderDock.boundingBox();
  expect(desktopGivebutterDockBox).not.toBeNull();
  expect(desktopGivebutterDockBox!.y).toBeGreaterThanOrEqual(frameBox!.y + frameBox!.height);

  const mobileViewport = { width: 393, height: 852 };
  await page.setViewportSize(mobileViewport);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => await page.evaluate(() => window.scrollY)).toBe(0);
  const mobileGivebutterDockLayout = await givebutterProviderDock.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      position: getComputedStyle(element).position,
      bottom: Math.round(window.innerHeight - box.bottom),
      height: Math.round(box.height)
    };
  });
  expect(mobileGivebutterDockLayout.position).toBe("fixed");
  expect(Math.abs(mobileGivebutterDockLayout.bottom)).toBeLessThanOrEqual(1);
  expect(mobileGivebutterDockLayout.height).toBeGreaterThanOrEqual(80);
  expect(await page.locator(".donar-stripe-has-provider-dock").evaluate((element) => (
    Number.parseFloat(getComputedStyle(element).paddingBottom)
  ))).toBeGreaterThanOrEqual(mobileGivebutterDockLayout.height);

  // The provider step is one viewport-sized shell on mobile: the page itself
  // does not compete for the gesture, the active provider owns the remaining
  // space, and the switcher stays fixed below it. This preserves the reason for
  // the bounded form while removing the clunky page + iframe nested scroll.
  const mobileGivebutterBudget = await mobileProviderShellMetrics(
    page.locator(".donar-givebutter-frame-area")
  );
  expect(mobileGivebutterBudget.pageScrollRange).toBeLessThanOrEqual(1);
  expect(mobileGivebutterBudget.pageScrollY).toBe(0);
  expect(mobileGivebutterBudget.providerTop).toBeGreaterThanOrEqual(0);
  expect(mobileGivebutterBudget.providerBottom).toBeLessThanOrEqual(mobileGivebutterBudget.dockTop);
  expect(mobileGivebutterBudget.dockTop - mobileGivebutterBudget.providerBottom).toBeLessThanOrEqual(24);
  expect(mobileGivebutterBudget.providerHeight).toBeGreaterThanOrEqual(240);

  const mobileGivebutterFrameBox = await givebutterFrame.boundingBox();
  expect(mobileGivebutterFrameBox).not.toBeNull();
  const givebutterContent = page.frames().find((frame) => frame.url().startsWith("https://givebutter.com/"));
  expect(givebutterContent).toBeDefined();
  expect(await givebutterContent!.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(
    mobileGivebutterFrameBox!.height
  );
  const givebutterScrollBefore = await givebutterContent!.evaluate(() => window.scrollY);
  await page.mouse.move(
    mobileGivebutterFrameBox!.x + mobileGivebutterFrameBox!.width / 2,
    mobileGivebutterFrameBox!.y + Math.min(180, mobileGivebutterFrameBox!.height / 2)
  );
  await page.mouse.wheel(0, 360);
  await expect.poll(async () => await givebutterContent!.evaluate(() => window.scrollY)).toBeGreaterThan(
    givebutterScrollBefore
  );
  expect(await page.evaluate(() => window.scrollY)).toBe(0);

  await stripeReturn.click();
  await expect(givebutterFrame).toHaveCount(1);
  await expect(givebutterFrame).toBeHidden();
  expect(await isRememberedNode(givebutterFrame, "givebutter-provider-frame")).toBe(true);
  await expect(stripeEmbed).toBeVisible();
  expect(await isRememberedNode(stripeEmbed, "stripe-provider-surface")).toBe(true);
  expect(givebutterRequests).toHaveLength(1);
  const stripeIntro = page.locator(".donar-intro");
  await expect(stripeIntro).toContainText(`Friends of ${BRANDING_DISPLAY_NAME} (501c3)`);
  await expect(stripeIntro).toBeFocused();
  await expect(providerAnnouncement).toHaveText("Formulario de Stripe, en español.");

  // Repeated switching only changes visibility: neither the Stripe surface nor the
  // Givebutter iframe is replaced, and the iframe URL is not requested again.
  await givebutterChoice.click();
  await expect(stripeEmbed).toHaveCount(1);
  await expect(stripeEmbed).toBeHidden();
  expect(await isRememberedNode(stripeEmbed, "stripe-provider-surface")).toBe(true);
  await expect(givebutterFrame).toBeVisible();
  expect(await isRememberedNode(givebutterFrame, "givebutter-provider-frame")).toBe(true);
  expect(givebutterRequests).toHaveLength(1);
  await stripeReturn.click();
  await expect(stripeEmbed).toBeVisible();
  await expect(givebutterFrame).toBeHidden();
  await expect(stripeIntro).toBeFocused();

  // Stripe reuses the Wompi handoff shell: the hosted surface is full-bleed on
  // mobile and aligns to the raised card edges on tablet/desktop. Only the
  // provider-owned content inside that boundary differs.
  await expect(page.locator(".donar-stripe > .donar-handoff")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(async () => await page.evaluate(() => window.scrollY)).toBe(0);
  const mobileStripeBox = await stripeEmbed.boundingBox();
  expect(mobileStripeBox).not.toBeNull();
  expect(mobileStripeBox!.x).toBeCloseTo(0, 1);
  expect(mobileStripeBox!.x + mobileStripeBox!.width).toBeCloseTo(mobileViewport.width, 1);
  expect(await stripeEmbed.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderWidth: style.borderTopWidth, borderRadius: style.borderRadius };
  })).toEqual({ borderWidth: "0px", borderRadius: "0px" });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(mobileViewport.width);
  const mobileProviderDock = page.locator(".donar-provider-dock");
  await expect(mobileProviderDock).toBeVisible();
  await expect(mobileProviderDock.getByRole("button", {
    name: /^Ofrendar con Givebutter\s+\(Con formulario en inglés\)$/i
  })).toBeVisible();
  await expect(mobileProviderDock.getByText("¿Dudas o necesita ayuda?", { exact: false })).toBeVisible();
  await expect(page.locator(".donar-support")).toHaveCount(1);
  const mobileDockLayout = await mobileProviderDock.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return {
      position: getComputedStyle(element).position,
      bottom: Math.round(window.innerHeight - box.bottom),
      height: Math.round(box.height)
    };
  });
  expect(mobileDockLayout.position).toBe("fixed");
  expect(Math.abs(mobileDockLayout.bottom)).toBeLessThanOrEqual(1);
  expect(mobileDockLayout.height).toBeGreaterThanOrEqual(80);
  expect(await page.locator(".donar-stripe-has-provider-dock").evaluate((element) => (
    Number.parseFloat(getComputedStyle(element).paddingBottom)
  ))).toBeGreaterThanOrEqual(mobileDockLayout.height);
  const mobileStripeBudget = await mobileProviderShellMetrics(stripeEmbed);
  expect(mobileStripeBudget.pageScrollRange).toBeLessThanOrEqual(1);
  expect(mobileStripeBudget.pageScrollY).toBe(0);
  expect(mobileStripeBudget.providerTop).toBeGreaterThanOrEqual(0);
  expect(mobileStripeBudget.providerBottom).toBeLessThanOrEqual(mobileStripeBudget.dockTop);
  expect(mobileStripeBudget.dockTop - mobileStripeBudget.providerBottom).toBeLessThanOrEqual(24);
  expect(mobileStripeBudget.providerHeight).toBeGreaterThanOrEqual(240);

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
  expect(await mobileProviderDock.evaluate((element) => getComputedStyle(element).position)).toBe("static");
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

test("provider preconnects begin only after the U.S. lane is selected", async ({ page }) => {
  let stripeSessionRequests = 0;
  await page.route("**/api/donations/stripe/checkout", async (route) => {
    stripeSessionRequests += 1;
    await route.abort();
  });

  const providerPreconnects = page.locator('link[rel="preconnect"][href^="https://js.stripe.com"], link[rel="preconnect"][href^="https://checkout.stripe.com"], link[rel="preconnect"][href^="https://givebutter.com"]');
  await page.goto("/donar");
  await expect(providerPreconnects).toHaveCount(0);
  await expect(page.locator("iframe.donar-givebutter-frame, .donar-stripe-embedded")).toHaveCount(0);
  expect(stripeSessionRequests).toBe(0);

  await page.getByRole("button", { name: "EE. UU." }).click();
  await expect(page.locator('link[rel="preconnect"][href="https://js.stripe.com"]')).toHaveCount(1);
  await expect(page.locator('link[rel="preconnect"][href="https://checkout.stripe.com"]')).toHaveCount(1);
  await expect(page.locator('link[rel="preconnect"][href="https://givebutter.com"]')).toHaveCount(1);
  expect(stripeSessionRequests).toBe(0);
});

test("Stripe overlays one loader through a shell iframe until Checkout is rendered", async ({ page }) => {
  const sessionDelay = await delayRoute(page, "**/api/donations/stripe/checkout", {
    status: 201,
    contentType: "application/json",
    body: JSON.stringify({
      sessionId: "cs_test_delayed_embedded_fixture",
      clientSecret: "cs_test_delayed_embedded_fixture_secret_mock",
      publishableKey: "pk_test_mock",
      mock: false
    })
  });
  await page.route("https://js.stripe.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: MOCK_STRIPE_JS
  }));
  await page.route("https://checkout.stripe.test/embedded-delayed", (route) => route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: "<html lang=\"es\"><body><div id=\"stripe-shell\"></div></body></html>"
  }));

  await enterStripeHandoff(page);
  await sessionDelay.held;
  const loader = page.locator('.donar-stripe-loading[role="status"]');
  await expect(loader).toHaveCount(1);
  await expect(loader).toHaveText("Preparando su formulario seguro con Stripe…");
  await expect(page.getByRole("status")).toHaveCount(1);
  await rememberNode(loader, "stripe-loader");
  expect(sessionDelay.requestCount()).toBe(1);

  sessionDelay.release();
  await expect(page.getByTitle("Formulario seguro de Stripe")).toHaveCount(1);
  await expect(page.frameLocator('iframe[title="Formulario seguro de Stripe"]')
    .locator("#stripe-shell")).toHaveCount(1);
  await expect(loader).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(1);
  expect(await isRememberedNode(loader, "stripe-loader")).toBe(true);
  const stripeFrame = page.getByTitle("Formulario seguro de Stripe");
  const [loaderBox, loadingFrameBox] = await Promise.all([
    loader.boundingBox(),
    stripeFrame.boundingBox()
  ]);
  expect(loaderBox).not.toBeNull();
  expect(loadingFrameBox).not.toBeNull();
  expect(loadingFrameBox!.y).toBeLessThan(loaderBox!.y + loaderBox!.height);
  expect(sessionDelay.requestCount()).toBe(1);
  expect(await page.evaluate(() => (
    window as Window & { __stripeEmbeddedCheckoutCreates?: number }
  ).__stripeEmbeddedCheckoutCreates)).toBe(1);

  await page.evaluate(() => (
    window as Window & { __emitStripeAnalyticsEvent: (eventType: string) => void }
  ).__emitStripeAnalyticsEvent("deviceData"));
  await expect(loader).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(1);
  expect(await isRememberedNode(loader, "stripe-loader")).toBe(true);

  await page.evaluate(() => (
    window as Window & { __emitStripeAnalyticsEvent: (eventType: string) => void }
  ).__emitStripeAnalyticsEvent("checkoutRendered"));
  await expect(loader).toHaveCount(0);
  const readyFrameBox = await stripeFrame.boundingBox();
  expect(readyFrameBox).not.toBeNull();
  expect(Math.abs(readyFrameBox!.y - loadingFrameBox!.y)).toBeLessThanOrEqual(2);
  expect(sessionDelay.requestCount()).toBe(1);
  expect(await page.evaluate(() => (
    window as Window & { __stripeEmbeddedCheckoutCreates?: number }
  ).__stripeEmbeddedCheckoutCreates)).toBe(1);
});

test("Stripe bounds the rendered frame and preserves native scrolling without analytics", async ({ page }) => {
  await page.route("**/api/donations/stripe/checkout", (route) => route.fulfill({
    status: 201,
    contentType: "application/json",
    body: JSON.stringify({
      sessionId: "cs_test_height_ready_fixture",
      clientSecret: "cs_test_height_ready_fixture_secret_mock",
      publishableKey: "pk_test_mock",
      mock: false
    })
  }));
  await page.route("https://js.stripe.com/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/javascript",
    body: MOCK_STRIPE_JS
  }));
  await page.route("https://checkout.stripe.test/embedded-delayed", (route) => route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: "<!doctype html><html lang=\"es\"><head><style>html,body{margin:0}body{min-height:904px}</style></head><body><div id=\"stripe-shell\">Inicio del formulario</div><div style=\"margin-top:820px\">Final del formulario</div></body></html>"
  }));

  await enterStripeHandoff(page);
  const loader = page.locator('.donar-stripe-loading[role="status"]');
  const stripeFrame = page.getByTitle("Formulario seguro de Stripe");
  await expect(page.frameLocator('iframe[title="Formulario seguro de Stripe"]')
    .locator("#stripe-shell")).toHaveCount(1);
  await expect(loader).toBeVisible();
  const loadingFrameBox = await stripeFrame.boundingBox();
  expect(loadingFrameBox).not.toBeNull();

  await page.evaluate(() => (
    window as Window & { __setStripeFrameHeight: (height: number) => void }
  ).__setStripeFrameHeight(904));

  await expect(loader).toHaveCount(0);
  const readyFrameBox = await stripeFrame.boundingBox();
  expect(readyFrameBox).not.toBeNull();
  expect(Math.abs(readyFrameBox!.y - loadingFrameBox!.y)).toBeLessThanOrEqual(2);

  await page.setViewportSize({ width: 393, height: 852 });
  const stripeViewport = page.getByRole("region", { name: "Formulario seguro de Stripe" });
  await expect(stripeViewport).toBeVisible();
  const viewportMetrics = await stripeViewport.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      overflowY: style.overflowY,
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight
    };
  });
  expect(viewportMetrics.overflowY).toBe("hidden");
  expect(viewportMetrics.clientHeight).toBeGreaterThanOrEqual(240);
  expect(viewportMetrics.scrollHeight - viewportMetrics.clientHeight).toBeLessThanOrEqual(4);
  const horizontalClip = await stripeViewport.evaluate((element) => {
    const frame = element.querySelector("iframe");
    if (!frame) throw new Error("Stripe iframe is missing");
    const frameBox = frame.getBoundingClientRect();
    let visibleLeft = frameBox.left;
    let visibleRight = frameBox.right;
    for (let ancestor = frame.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (getComputedStyle(ancestor).overflowX === "visible") continue;
      const ancestorBox = ancestor.getBoundingClientRect();
      visibleLeft = Math.max(visibleLeft, ancestorBox.left);
      visibleRight = Math.min(visibleRight, ancestorBox.right);
    }
    return {
      frameLeft: Math.round(frameBox.left),
      frameRight: Math.round(frameBox.right),
      visibleLeft: Math.round(visibleLeft),
      visibleRight: Math.round(visibleRight)
    };
  });
  expect(horizontalClip.visibleLeft).toBeLessThanOrEqual(horizontalClip.frameLeft + 1);
  expect(horizontalClip.visibleRight).toBeGreaterThanOrEqual(horizontalClip.frameRight - 1);
  const mobileShell = await mobileProviderShellMetrics(stripeViewport);
  expect(mobileShell.pageScrollRange).toBeLessThanOrEqual(1);
  expect(mobileShell.providerBottom).toBeLessThanOrEqual(mobileShell.dockTop);
  expect(mobileShell.dockTop - mobileShell.providerBottom).toBeLessThanOrEqual(24);
  await expect.poll(async () => (await stripeFrame.boundingBox())?.height ?? 0)
    .toBeCloseTo(viewportMetrics.clientHeight, 0);

  const stripeFrameDocument = page.frameLocator('iframe[title="Formulario seguro de Stripe"]')
    .locator("html");
  await expect.poll(() => stripeFrameDocument.evaluate((element) => (
    element.ownerDocument.defaultView?.innerHeight ?? 0
  ))).toBe(viewportMetrics.clientHeight);
  const innerMetrics = await stripeFrameDocument.evaluate((element) => ({
    clientHeight: element.ownerDocument.defaultView?.innerHeight ?? 0,
    scrollHeight: Math.max(element.scrollHeight, element.ownerDocument.body.scrollHeight),
    scrollY: element.ownerDocument.defaultView?.scrollY ?? 0
  }));
  expect(innerMetrics.clientHeight).toBe(viewportMetrics.clientHeight);
  expect(innerMetrics.scrollHeight).toBeGreaterThan(innerMetrics.clientHeight);

  const stripeViewportBox = await stripeViewport.boundingBox();
  expect(stripeViewportBox).not.toBeNull();
  await page.mouse.move(
    stripeViewportBox!.x + stripeViewportBox!.width / 2,
    stripeViewportBox!.y + stripeViewportBox!.height / 2
  );
  await page.mouse.wheel(0, 360);
  await expect.poll(() => stripeFrameDocument.evaluate((element) => (
    element.ownerDocument.defaultView?.scrollY ?? 0
  ))).toBeGreaterThan(innerMetrics.scrollY);
});

test("Givebutter keeps a truthful reduced-motion loader until its bounded escape hatch", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/donations/stripe/checkout", (route) => route.fulfill({
    status: 201,
    contentType: "application/json",
    body: JSON.stringify({
      sessionId: "cs_test_givebutter_delayed_fixture",
      clientSecret: "cs_test_givebutter_delayed_fixture_secret_mock",
      publishableKey: "pk_test_mock",
      mock: true
    })
  }));
  const givebutterDelay = await delayRoute(page, "https://givebutter.com/**", {
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: "<html lang=\"en\"><body>Delayed Givebutter form</body></html>"
  });

  await enterStripeHandoff(page);
  await page.getByRole("button", {
    name: /^Diezmar con Givebutter\s+\(Con formulario en inglés\)$/i
  }).click();
  await givebutterDelay.held;

  const loader = page.locator('.donar-givebutter-loading[role="status"]');
  const givebutterFrame = page.getByTitle("Formulario de donación Givebutter (en inglés)");
  await expect(loader).toHaveCount(1);
  await expect(loader).toContainText("Preparando su formulario seguro con Givebutter…");
  await expect(page.getByRole("status")).toHaveCount(1);
  await rememberNode(loader, "givebutter-loader");
  const spinner = loader.locator(".donar-spinner");
  await expect(spinner).toBeVisible();
  await expect(spinner).toHaveCSS("animation-name", "none");
  const desktopViewport = page.viewportSize();
  if (!desktopViewport) throw new Error("Playwright viewport is unavailable");
  await page.setViewportSize({ width: 393, height: 852 });
  const loadingMessage = loader.locator(":scope > span").nth(1);
  const visualLoadingGap = await loadingMessage.evaluate((element) => {
    const spinner = element.previousElementSibling;
    const text = element.firstChild;
    if (!spinner || !text) throw new Error("Givebutter loader content is incomplete");
    const range = document.createRange();
    range.selectNodeContents(text);
    const firstLine = range.getClientRects()[0];
    if (!firstLine) throw new Error("Givebutter loader message did not render");
    return firstLine.left - spinner.getBoundingClientRect().right;
  });
  expect(visualLoadingGap).toBeGreaterThanOrEqual(6);
  expect(visualLoadingGap).toBeLessThanOrEqual(16);
  await page.setViewportSize(desktopViewport);
  expect(await loader.evaluate((element) => getComputedStyle(element).backgroundColor))
    .toBe("rgb(255, 255, 255)");
  const [loaderBox, loadingFrameBox] = await Promise.all([
    loader.boundingBox(),
    givebutterFrame.boundingBox()
  ]);
  expect(loaderBox).not.toBeNull();
  expect(loadingFrameBox).not.toBeNull();
  expect(loadingFrameBox!.height).toBeGreaterThanOrEqual(480);
  expect(loadingFrameBox!.height).toBeLessThanOrEqual(620);
  expect(Math.abs(loaderBox!.x - loadingFrameBox!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(loaderBox!.y - loadingFrameBox!.y)).toBeLessThanOrEqual(1);
  expect(Math.abs(loaderBox!.width - loadingFrameBox!.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(loaderBox!.height - loadingFrameBox!.height)).toBeLessThanOrEqual(1);
  expect(await page.evaluate(({ x, y }) => (
    document.elementFromPoint(x, y)?.closest(".donar-givebutter-loading") !== null
  ), {
    x: loadingFrameBox!.x + loadingFrameBox!.width / 2,
    y: loadingFrameBox!.y + loadingFrameBox!.height / 2
  })).toBe(true);
  await page.waitForTimeout(500);
  expect(await isRememberedNode(loader, "givebutter-loader")).toBe(true);

  const escapeHatch = page.locator(".donar-givebutter-hint");
  await expect(escapeHatch).toHaveClass(/\bdonar-givebutter-fallback\b/, {
    timeout: GIVEBUTTER_RENDER_TIMEOUT_MS + 5_000
  });
  await expect(loader).toHaveCount(0);
  await expect(escapeHatch).toHaveText("¿Problemas con el formulario? Abrir Givebutter");
  const readyFrameBox = await givebutterFrame.boundingBox();
  expect(readyFrameBox).not.toBeNull();
  expect(Math.abs(readyFrameBox!.y - loadingFrameBox!.y)).toBeLessThanOrEqual(1);

  givebutterDelay.release();
});

test("the Givebutter handoff verb follows the selected U.S. gift type", async ({ page }) => {
  let checkoutSequence = 0;
  await page.route("**/api/donations/stripe/checkout", async (route) => {
    checkoutSequence += 1;
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: `cs_test_givebutter_label_${checkoutSequence}`,
        clientSecret: `cs_test_givebutter_label_${checkoutSequence}_secret_mock`,
        publishableKey: "pk_test_mock",
        mock: true
      })
    });
  });

  const titheHandoff = page.getByRole("button", {
    name: /^Diezmar con Givebutter\s+\(Con formulario en inglés\)$/i
  });
  const offeringHandoff = page.getByRole("button", {
    name: /^Ofrendar con Givebutter\s+\(Con formulario en inglés\)$/i
  });

  await page.goto("/donar?ruta=eeuu");
  await page.getByRole("button", { name: "$50", exact: true }).click();
  await page.getByRole("button", { name: "Continuar con su diezmo", exact: true }).click();
  await expect(titheHandoff).toBeVisible();
  await expect(offeringHandoff).toHaveCount(0);

  await page.getByRole("button", { name: "Editar", exact: true }).click();
  await page.getByRole("radio", { name: "Ofrenda", exact: true }).check();
  await page.getByRole("button", { name: "Continuar con su ofrenda", exact: true }).click();
  await expect(offeringHandoff).toBeVisible();
  await expect(titheHandoff).toHaveCount(0);
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

test("repeated OPEN and PENDING result polls keep the same checking status node", async ({ page }) => {
  const sessionId = "cs_test_repeated_pending_fixture";
  let statusReads = 0;
  await page.route("**/api/donations/stripe/session/**", (route) => {
    statusReads += 1;
    const status = statusReads === 1 ? "OPEN" : statusReads === 2 ? "PENDING" : "PAID";
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        status,
        frequency: "ONCE",
        amountCents: 5000,
        currency: "usd",
        canManageRecurring: false,
        recurringStatus: null
      })
    });
  });

  await page.goto(`/donar/stripe/resultado?session_id=${sessionId}`);
  const checking = page.locator('.donar-result-checking[role="status"]');
  await expect(checking).toHaveCount(1);
  await rememberNode(checking, "stripe-result-checking");
  await expect.poll(() => statusReads, { timeout: 8_000 }).toBeGreaterThanOrEqual(2);
  await expect(checking).toHaveCount(1);
  expect(await isRememberedNode(checking, "stripe-result-checking")).toBe(true);
  await expect(page.getByRole("heading", { name: "Confirmando su entrega…" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Dios le bendiga. Su aportación fue recibida." }))
    .toBeVisible({ timeout: 8_000 });
  await expect(checking).toHaveCount(0);
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
  await page.route("**/api/donations/stripe/checkout", (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        sessionId: "cs_test_no_stripe_js_fixture",
        clientSecret: "cs_test_no_stripe_js_fixture_secret_mock",
        publishableKey: "pk_test_mock",
        mock: true
      })
    })
  );

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
