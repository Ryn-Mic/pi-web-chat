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

test("simulated standalone layout uses normal document flow and centers starter headings", async ({ browser }, testInfo) => {
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
    // The unauthenticated gate intentionally returns 401 before signing in.
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await expectControlsWithin(page, 844);
    expect(await page.locator("body").evaluate((element) => getComputedStyle(element).position)).toBe("static");
    expect(await page.locator("header").evaluate((element) => getComputedStyle(element).paddingTop)).toBe("8px");
    expect(await page.locator(".composer-bar").evaluate((element) => getComputedStyle(element).paddingBottom)).toBe("8px");
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", "width=device-width, initial-scale=1");
    await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute("content", "default");
    for (const title of ["Explore Codebase", "Review Git Changes", "Write Unit Tests", "Optimize Performance"]) {
      const heading = page.getByText(title, { exact: true });
      const titleBox = await heading.boundingBox();
      const buttonBox = await heading.locator("xpath=ancestor::button").boundingBox();
      expect(Math.abs(titleBox!.x + titleBox!.width / 2 - buttonBox!.x - buttonBox!.width / 2))
        .toBeLessThan(1);
      expect(await heading.evaluate((element) => getComputedStyle(element).textAlign)).toBe("center");
    }
    await page.screenshot({ path: "/tmp/pi-web-chat-v123-native-mobile.png" });
    await page.getByRole("button", { name: /^Explore Codebase/ }).click();
    await expect(page.locator("textarea")).toHaveValue("Analyze repository architecture and key module structure");
    await expect(page.locator("textarea")).toBeFocused();
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("simulated visual viewport resize, pan and zoom leave document geometry to the browser", async ({ browser }, testInfo) => {
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
    let scale = 1;
    Object.defineProperties(viewport, {
      height: { get: () => height ?? innerHeight }, width: { get: () => innerWidth },
      scale: { get: () => scale }, offsetTop: { get: () => offsetTop }, offsetLeft: { value: 0 },
    });
    Object.defineProperty(window, "visualViewport", { value: viewport });
    Object.assign(window, {
      setTestViewportHeight(value: number | null) { height = value; viewport.dispatchEvent(new Event("resize")); },
      setTestViewportOffset(value: number) { offsetTop = value; viewport.dispatchEvent(new Event("scroll")); },
      setTestViewportScale(value: number) { scale = value; viewport.dispatchEvent(new Event("resize")); },
    });
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const layoutState = () => page.evaluate(() => ({
    inlineStyle: document.documentElement.getAttribute("style"),
    keyboardClass: document.documentElement.classList.contains("ua-keyboard-open"),
    viewportProperties: ["--app-viewport-height", "--safe-top", "--safe-bottom"].map((property) =>
      document.documentElement.style.getPropertyValue(property)),
    elements: ["body", "#root", "header", ".composer-bar", ".composer-panel", "textarea"].map((selector) => {
      const element = document.querySelector<HTMLElement>(selector)!;
      const style = getComputedStyle(element);
      const bounds = element.getBoundingClientRect();
      return {
        selector, inlineStyle: element.getAttribute("style"),
        position: style.position, top: style.top, bottom: style.bottom, transform: style.transform,
        height: style.height, paddingTop: style.paddingTop, paddingBottom: style.paddingBottom,
        y: bounds.y, bottomEdge: bounds.bottom,
      };
    }),
  }));
  const nextPaint = () => page.evaluate(() => new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  try {
    await openEmptyChat(page);
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    const beforeFocus = await layoutState();
    await page.locator("textarea").focus();
    await nextPaint();
    expect(await layoutState()).toEqual(beforeFocus);
    const baseline = await layoutState();
    expect(baseline.keyboardClass).toBe(false);
    expect(baseline.viewportProperties).toEqual(["", "", ""]);
    await page.evaluate(() => (window as unknown as { setTestViewportHeight(value: number | null): void })
      .setTestViewportHeight(405));
    await nextPaint();
    // Changing a mock visual viewport does not resize Chromium's layout viewport.
    // The app must not counteract the native keyboard by shrinking or translating itself.
    expect(await layoutState()).toEqual(baseline);
    await page.evaluate(() => (window as unknown as { setTestViewportOffset(value: number): void })
      .setTestViewportOffset(72));
    await nextPaint();
    expect(await layoutState()).toEqual(baseline);
    await page.evaluate(() => (window as unknown as { setTestViewportScale(value: number): void })
      .setTestViewportScale(1.5));
    await nextPaint();
    expect(await layoutState()).toEqual(baseline);
    await page.locator("textarea").blur();
    await nextPaint();
    expect(await layoutState()).toEqual(baseline);
    await page.evaluate(() => (window as unknown as { setTestViewportHeight(value: number | null): void })
      .setTestViewportHeight(null));
    await nextPaint();
    expect(await layoutState()).toEqual(baseline);
    // A real browser document resize still flows through ordinary percentage heights.
    await page.setViewportSize({ width: 390, height: 405 });
    await expect.poll(() => page.locator("#root").evaluate((element) => element.clientHeight)).toBe(405);
    await expectControlsWithin(page, 405);
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => window.dispatchEvent(new Event("orientationchange")));
    await expect.poll(() => page.locator("#root").evaluate((element) => element.clientHeight)).toBe(390);
    await expectControlsWithin(page, 390);
    await expect.poll(() => page.locator(".composer-bar").evaluate((element) =>
      getComputedStyle(element).paddingBottom)).toBe("8px");
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test("desktop and short browser viewports keep composer controls in bounds", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 720 });
  await openEmptyChat(page);
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await expectControlsWithin(page, 720);
  const heading = page.getByText("Explore Codebase", { exact: true });
  expect(await heading.evaluate((element) => getComputedStyle(element).textAlign)).toBe("left");
  await page.setViewportSize({ width: 375, height: 567 });
  await expect.poll(() => page.locator("#root").evaluate((element) => element.clientHeight)).toBe(567);
  await expectControlsWithin(page, 567);
  expect(errors).toEqual([]);
});
