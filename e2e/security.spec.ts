import { expect, test } from "@playwright/test";

test("reset fragments are scrubbed before mount and never enter request metadata", async ({ page }) => {
  const sentinel = "fragment-capability-sentinel";
  const observed: Array<{ url: string; referer: string }> = [];
  page.on("request", (request) => {
    observed.push({
      url: request.url(),
      referer: request.headers().referer ?? ""
    });
  });

  await page.goto(`/admin#reset=${sentinel}`);

  await expect(page).toHaveURL("http://127.0.0.1:8787/admin");
  await expect(page.getByPlaceholder("Nueva contraseña", { exact: true })).toBeVisible();
  expect(observed.some((request) => request.url.includes(sentinel) || request.referer.includes(sentinel))).toBe(false);
});

test("legacy query links remain usable but only the initial navigation carries the token", async ({ page }) => {
  const sentinel = "legacy-capability-sentinel";
  const observed: Array<{ url: string; referer: string; resourceType: string }> = [];
  page.on("request", (request) => {
    observed.push({
      url: request.url(),
      referer: request.headers().referer ?? "",
      resourceType: request.resourceType()
    });
  });

  await page.goto(`/admin?reset=${sentinel}&utm_source=email`);

  await expect(page).toHaveURL("http://127.0.0.1:8787/admin?utm_source=email");
  await expect(page.getByPlaceholder("Nueva contraseña", { exact: true })).toBeVisible();
  const carryingToken = observed.filter(
    (request) => request.url.includes(sentinel) || request.referer.includes(sentinel)
  );
  expect(carryingToken).toHaveLength(1);
  expect(carryingToken[0].resourceType).toBe("document");
  expect(carryingToken[0].referer).toBe("");
});

test("the real Worker serves document anti-framing and referrer headers", async ({ request }) => {
  const response = await request.get("/");

  expect(response.ok()).toBe(true);
  expect(response.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(response.headers()["x-frame-options"]).toBe("DENY");
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
});

test("a different origin cannot embed the application document", async ({ page }) => {
  await page.goto("http://localhost:8787/");
  await page.setContent('<iframe title="blocked-app" src="http://127.0.0.1:8787/"></iframe>');

  await expect(page.getByTitle("blocked-app")).toBeVisible();
  await expect
    .poll(() => page.frames().filter((frame) => frame.parentFrame()).map((frame) => frame.url()))
    .not.toContain("http://127.0.0.1:8787/");
});
