import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page) {
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function openSettings(page: Page) {
  const settings = page.getByRole("button", { name: "Settings", exact: true }).first();
  if (!(await settings.isVisible())) await page.getByRole("button", { name: "Session list", exact: true }).click();
  await settings.click();
}

test("sign-out releases the old connection and draft; sign-in reconnects the same saved session", async ({ page }) => {
  let opened = 0;
  let closed = 0;
  page.on("websocket", (socket) => { opened += 1; socket.on("close", () => { closed += 1; }); });
  await page.goto("/s/e2e-file-links");
  await signIn(page);
  await expect(page.getByText("show linked files", { exact: true })).toBeVisible();
  const composer = page.locator(".composer-bar textarea");
  await composer.fill("private unsent draft");
  await expect(composer).toHaveValue("private unsent draft");
  expect(opened).toBe(1);
  await openSettings(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Access token")).toBeVisible();
  await expect.poll(() => closed).toBe(1);
  await expect(page.getByText("show linked files", { exact: true })).toHaveCount(0);
  await signIn(page);
  await expect.poll(() => opened).toBe(2);
  await expect(page.getByText("show linked files", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect(page.getByText("Can't reach the server. Retrying…", { exact: true })).toHaveCount(0);
  await expect(page).toHaveURL(/\/s\/e2e-file-links$/);
});

test("a missing Pi session shows a terminal error without changing its URL or reconnecting", async ({ page }) => {
  let opened = 0;
  let closed = 0;
  page.on("websocket", (socket) => { opened += 1; socket.on("close", () => { closed += 1; }); });
  await page.goto("/s/e2e-missing-session");
  await signIn(page);
  await expect(page.getByRole("alert")).toHaveText("Session not found");
  await expect.poll(() => closed).toBe(1);
  // The first ordinary reconnect starts after 400 ms. The terminal close must
  // remain quiescent across that retry window, with no replacement URL.
  await page.waitForTimeout(1_200);
  expect(opened).toBe(1);
  await expect(page).toHaveURL(/\/s\/e2e-missing-session$/);
  await expect(page.locator(".composer-bar")).toHaveCount(0);
});
