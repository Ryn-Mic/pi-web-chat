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

test("worker activation purges legacy API navigation data and repaired navigation never caches APIs", async ({ page, context, request }) => {
  // JSON navigation does not register a worker. Seed the previous cache before
  // installing the repaired worker, plus an unrelated cache that must survive.
  await page.goto("/api/health");
  await page.evaluate(async () => {
    await (await caches.open("pi-web-html")).put("/api/sessions?token=legacy-fixture", new Response("private fixture"));
    await (await caches.open("unrelated-fixture")).put("/unrelated-fixture", new Response("keep"));
  });
  await page.goto("/");
  await expect(page.getByLabel("Access token")).toBeVisible();
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  });
  const migrated = await page.evaluate(async () => ({
    legacyPresent: (await caches.keys()).includes("pi-web-html"),
    unrelatedPresent: !!(await (await caches.open("unrelated-fixture")).match("/unrelated-fixture")),
  }));
  expect(migrated.legacyPresent).toBe(false);
  expect(migrated.unrelatedPresent).toBe(true);

  const login = await request.post("/api/auth/login", { data: { token: "e2e-token" } });
  expect(login.ok()).toBe(true);
  const { sessionToken } = await login.json() as { sessionToken: string };
  await page.setExtraHTTPHeaders({ authorization: `Bearer ${sessionToken}` });
  const response = await page.goto("/api/sessions?limit=40");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["cache-control"]).toBe("no-store");
  const cachedApis = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls = (await Promise.all(names.map(async (name) => (await (await caches.open(name)).keys()).map((entry) => new URL(entry.url).pathname)))).flat();
    return urls.filter((url) => url === "/api" || url.startsWith("/api/"));
  });
  expect(cachedApis).toEqual([]);
  await context.setOffline(true);
  let servedOffline = false;
  await page.reload({ waitUntil: "domcontentloaded" }).then((result) => { servedOffline = result?.status() === 200; }, () => {});
  expect(servedOffline).toBe(false);
  // Chromium may still commit its internal error document after the rejected
  // navigation promise settles. Dispose that page rather than racing it with
  // the positive app-shell navigation; the worker and caches remain shared.
  await page.close();
  const shellPage = await context.newPage();
  await shellPage.goto("/", { waitUntil: "domcontentloaded" });
  await expect(shellPage.locator("#root > *")).not.toHaveCount(0);
});
