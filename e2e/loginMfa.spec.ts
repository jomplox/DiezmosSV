import { expect, test, type Route } from "@playwright/test";

async function fulfillJson(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}

test("mounts the login step-up flow, clears the password, and establishes the verified session", async ({ page }) => {
  const loginBodies: Array<Record<string, unknown>> = [];
  const mfaBodies: Array<Record<string, unknown>> = [];

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/branding") {
      await fulfillJson(route, {
        displayName: "Iglesia Ejemplo",
        accentColor: "#0f766e",
        supportEmail: "soporte@example.org",
        logoVersion: null,
        donorLogoVersion: null
      });
      return;
    }
    if (url.pathname === "/api/auth/bootstrap-status") {
      await fulfillJson(route, { bootstrapAvailable: false });
      return;
    }
    if (url.pathname === "/api/auth/login" && request.method() === "POST") {
      loginBodies.push(request.postDataJSON() as Record<string, unknown>);
      await fulfillJson(route, {
        mfaRequired: true,
        challengeId: `login_mfa_challenge_${loginBodies.length}`,
        continuationToken: `continuation-token-${loginBodies.length}`,
        expiresAt: "2026-08-23T18:10:00.000Z"
      }, 202);
      return;
    }
    if (url.pathname === "/api/auth/login/mfa" && request.method() === "POST") {
      mfaBodies.push(request.postDataJSON() as Record<string, unknown>);
      await fulfillJson(route, {
        user: {
          id: "user_operator",
          email: "operator@example.org",
          name: "Operador",
          role: "OPERATOR"
        },
        token: "verified-session-token",
        expiresAt: "2026-08-24T18:00:00.000Z"
      });
      return;
    }
    await fulfillJson(route, { error: "not_part_of_login_mfa_fixture" }, 503);
  });

  await page.goto("/admin");
  const email = page.getByLabel("Correo");
  const password = page.getByLabel("Contraseña");
  await email.fill("operator@example.org");
  await password.fill("Valid#Pass2026");
  await page.getByRole("button", { name: "Continuar" }).click();

  await expect(page.getByText("Ingrese el código de 6 dígitos que enviamos a su correo.")).toBeVisible();
  await expect(page.getByLabel("Código de verificación")).toBeVisible();
  await expect(page.getByLabel("Contraseña")).toHaveCount(0);

  await page.getByRole("button", { name: "Volver a iniciar sesión" }).click();
  await expect(page.getByLabel("Contraseña")).toHaveValue("");
  await page.getByLabel("Contraseña").fill("Valid#Pass2026");
  await page.getByRole("button", { name: "Continuar" }).click();
  await page.getByLabel("Código de verificación").fill("123456");
  await page.getByRole("button", { name: "Verificar código" }).click();

  expect(loginBodies).toEqual([
    { email: "operator@example.org", password: "Valid#Pass2026" },
    { email: "operator@example.org", password: "Valid#Pass2026" }
  ]);
  expect(mfaBodies).toEqual([{
    challengeId: "login_mfa_challenge_2",
    continuationToken: "continuation-token-2",
    code: "123456"
  }]);
  expect(mfaBodies[0]).not.toHaveProperty("password");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("diezmos_token")))
    .toBe("verified-session-token");
  await expect.poll(() => page.evaluate(() => localStorage.getItem("diezmos_user")))
    .toBe(JSON.stringify({
      id: "user_operator",
      email: "operator@example.org",
      name: "Operador",
      role: "OPERATOR"
    }));
});
