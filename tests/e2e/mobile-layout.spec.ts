import { expect, test, type Page } from "@playwright/test";

const PROJECT_ROOT = "/tmp/pi-web-chat-file-preview-e2e/project";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

async function openEmptyChat(page: Page) {
  await page.route(/\/api\/sessions(?:\?|$)/, (route) => {
    const paged = new URL(route.request().url()).search.length > 0;
    return route.fulfill({ json: paged ? { sessions: [], nextCursor: null, scanning: false } : [] });
  });
  await page.routeWebSocket(/\/ws\?/, (socket) => {
    socket.send(JSON.stringify({ type: "snapshot", seq: 0, revision: 0, snapshot: {
      messages: [], history: { cursor: null, hasMore: false }, isStreaming: false,
      model: null, thinkingLevel: "off", thinkingLevels: ["off"], agent: "pi", cwd: PROJECT_ROOT,
    } }));
  });
  await page.goto("/");
  await expect(page).toHaveTitle("pi web chat");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Open files" })).toBeVisible();
  await expect(page.locator(".composer-bar")).toBeVisible();
}

async function expectControlsWithin(page: Page, height: number) {
  for (const selector of ["#root", ".composer-bar", ".composer-panel", "textarea"]) {
    const box = await page.locator(selector).boundingBox();
    expect(box, selector).not.toBeNull();
    expect(box!.y, `${selector} top`).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height, `${selector} bottom`).toBeLessThanOrEqual(height + 1);
  }
  for (const button of await page.locator(".composer-panel button:visible").all()) {
    const box = await button.boundingBox();
    expect(box!.y, "composer control top").toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height, await button.getAttribute("aria-label") ?? "composer control")
      .toBeLessThanOrEqual(height + 1);
  }
}

test("standalone mobile composer fits its viewport and centers starter headings", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, userAgent: IPHONE_UA,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { value: true });
    localStorage.setItem("pi-web-chat-locale", "en");
  });
  try {
    await openEmptyChat(page);
    await expectControlsWithin(page, 844);
    await expect.poll(() => page.locator(".composer-bar").evaluate((element) =>
      getComputedStyle(element).paddingBottom)).toBe("34px");
    for (const title of ["Explore Codebase", "Review Git Changes", "Write Unit Tests", "Optimize Performance"]) {
      const heading = page.getByText(title, { exact: true });
      const titleBox = await heading.boundingBox();
      const buttonBox = await heading.locator("xpath=ancestor::button").boundingBox();
      expect(Math.abs(titleBox!.x + titleBox!.width / 2 - buttonBox!.x - buttonBox!.width / 2))
        .toBeLessThan(1);
      expect(await heading.evaluate((element) => getComputedStyle(element).textAlign)).toBe("center");
    }
    await page.screenshot({ path: testInfo.outputPath("standalone-mobile-layout.png") });
    await page.getByRole("button", { name: /^Explore Codebase/ }).click();
    await expect(page.locator("textarea")).toHaveValue("Analyze repository architecture and key module structure");
    await expect(page.locator("textarea")).toBeFocused();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("a smaller keyboard viewport keeps controls visible without compensating native panning", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, userAgent: IPHONE_UA,
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { value: true });
    localStorage.setItem("pi-web-chat-locale", "en");
    const viewport = new EventTarget();
    let height: number | null = null;
    let offsetTop = 0;
    Object.defineProperties(viewport, {
      height: { get: () => height ?? innerHeight }, width: { get: () => innerWidth },
      scale: { value: 1 }, offsetTop: { get: () => offsetTop }, offsetLeft: { value: 0 },
    });
    Object.defineProperty(window, "visualViewport", { value: viewport });
    Object.assign(window, {
      setTestViewportHeight(value: number | null) { height = value; viewport.dispatchEvent(new Event("resize")); },
      setTestViewportOffset(value: number) { offsetTop = value; viewport.dispatchEvent(new Event("scroll")); },
    });
  });
  const page = await context.newPage();
  try {
    await openEmptyChat(page);
    await page.locator("textarea").focus();
    await page.evaluate(() => (window as unknown as { setTestViewportHeight(value: number | null): void })
      .setTestViewportHeight(405));
    await expect.poll(() => page.locator("#root").evaluate((element) => element.clientHeight)).toBe(405);
    await expectControlsWithin(page, 405);
    await expect.poll(() => page.locator(".composer-bar").evaluate((element) =>
      getComputedStyle(element).paddingBottom)).toBe("8px");
    const style = await page.locator("html").getAttribute("style");
    await page.evaluate(() => (window as unknown as { setTestViewportOffset(value: number): void })
      .setTestViewportOffset(72));
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.locator("html").getAttribute("style")).toBe(style);
    expect(await page.locator("body").evaluate((element) => element.getBoundingClientRect().top)).toBe(0);
    await page.evaluate(() => (window as unknown as { setTestViewportHeight(value: number | null): void })
      .setTestViewportHeight(null));
    await expect.poll(() => page.locator("#root").evaluate((element) => element.clientHeight)).toBe(844);
    await expect.poll(() => page.locator(".composer-bar").evaluate((element) =>
      getComputedStyle(element).paddingBottom)).toBe("34px");
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
    await expect.poll(() => page.locator("#root").evaluate((element) => element.clientHeight)).toBe(390);
    await expectControlsWithin(page, 390);
    await expect.poll(() => page.locator(".composer-bar").evaluate((element) =>
      getComputedStyle(element).paddingBottom)).toBe("8px");
  } finally {
    await context.close();
  }
});

test("desktop and short browser viewports keep composer controls in bounds", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openEmptyChat(page);
  await expectControlsWithin(page, 720);
  const heading = page.getByText("Explore Codebase", { exact: true });
  expect(await heading.evaluate((element) => getComputedStyle(element).textAlign)).toBe("left");
  await page.setViewportSize({ width: 375, height: 567 });
  await expect.poll(() => page.locator("#root").evaluate((element) => element.clientHeight)).toBe(567);
  await expectControlsWithin(page, 567);
});
