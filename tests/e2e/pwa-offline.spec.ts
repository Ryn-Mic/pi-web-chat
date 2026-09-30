import { expect, test } from "@playwright/test";

test("installed chat shell reloads offline without fetching lazy viewer runtime", async ({ page, context }) => {
  const errors: string[] = [];
  const viewerRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/\/file-viewer\/|\/assets\/file-viewer-(?:react-full|preset-all|renderer-)/.test(request.url())) viewerRequests.push(request.url());
  });
  // All API responses in this test are synthetic; only built static assets and
  // the service worker use the isolated Playwright fixture server.
  await page.route("**/api/**", (route) => route.fulfill({ status: 401, contentType: "application/json", body: "{}" }));
  await page.goto("/");
  await expect(page.getByLabel("Access token")).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  });
  const precached = await page.evaluate(async () => {
    const names = (await caches.keys()).filter((name) => name.includes("precache"));
    return (await Promise.all(names.map(async (name) => (await (await caches.open(name)).keys()).map((request) => new URL(request.url).pathname)))).flat();
  });
  expect(precached).toContain("/index.html");
  expect(precached.some((url) => /file-viewer-(?:react-full|preset-all|renderer-)/.test(url))).toBe(false);
  await context.setOffline(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(page.locator("#root > *")).not.toHaveCount(0);
  expect(errors).toEqual([]);
  expect(viewerRequests).toEqual([]);
});
