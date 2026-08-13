import { expect, test, type Page } from "@playwright/test";

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Open files" })).toBeVisible();
}

test("desktop file preview and @ reference are independent", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.getByRole("button", { name: "Open files" }).click();

  const composer = page.locator("textarea");
  await expect(composer).toHaveValue("");
  await page.getByRole("button", { name: "Preview README.md" }).click();
  await expect(page.getByRole("tab", { name: "README.md" })).toHaveAttribute("aria-selected", "true");
  await expect(composer).toHaveValue("");

  await page.getByRole("tab", { name: "Files" }).click();
  await page.getByRole("button", { name: "Reference notes.txt" }).click();
  await expect(composer).toHaveValue("@notes.txt ");
  await expect(page.getByRole("tab", { name: "notes.txt" })).toHaveCount(0);
});

test("Git workspace shows changes and opens changed files in preview", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.getByRole("button", { name: "Open files" }).click();
  await page.getByRole("tab", { name: "Git" }).click();

  await expect(page.getByText("seed preview files")).toBeVisible();
  await expect(page.getByTitle("README.md", { exact: true }).first()).toBeVisible();
  await expect(page.getByTitle("active.html", { exact: true })).toBeVisible();
  await page.getByTitle("README.md", { exact: true }).first().click();
  await expect(page.getByRole("tab", { name: "README.md" })).toHaveAttribute("aria-selected", "true");
});

test("mobile commit detail is full-screen and expands one file diff at a time", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await login(page);
  await page.getByRole("button", { name: "Open files" }).click();
  await page.getByRole("tab", { name: "Git" }).click();
  await page.getByText("update preview files").click();

  await expect(page.getByRole("heading", { name: "update preview files" })).toBeVisible();
  await expect(page.getByText("README.md", { exact: true })).toBeVisible();
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  await expect(page.locator("[aria-expanded=true]")).toHaveCount(0);
  await page.locator('button[aria-expanded="false"]').filter({ hasText: "README.md" }).last().click();
  await expect(page.locator("[aria-expanded=true]")).toHaveCount(1);
  await expect(page.getByText("Changed in the working tree.", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Back to Git" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Git" })).toHaveAttribute("aria-selected", "true");
});

test("mobile preview uses an isolated capability iframe and browser history", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await login(page);
  await page.getByRole("button", { name: "Open files" }).click();
  await page.getByRole("button", { name: "Preview README.md" }).click();

  const iframe = page.locator('iframe[title="Preview README.md"]');
  await expect(iframe).toBeVisible();
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts allow-same-origin");
  const src = await iframe.getAttribute("src");
  expect(src).toMatch(/^\/file-preview\.html#context=/);
  expect(src).not.toContain("cwd=");
  expect(src).not.toContain("path=");
  expect(src).not.toContain("token=");

  await expect.poll(async () => page.frames().find((frame) => frame !== page.mainFrame())?.url()).toMatch(/\/file-preview\.html$/);
  await page.getByRole("button", { name: "Back to files" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
});

test("active content cannot execute and SVG preview is denied", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.evaluate(() => {
    (window as Window & { __previewPwned?: boolean }).__previewPwned = false;
  });
  await page.getByRole("button", { name: "Open files" }).click();
  await page.getByRole("button", { name: "Preview active.html" }).click();
  await expect(page.getByRole("tab", { name: "active.html" })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as Window & { __previewPwned?: boolean }).__previewPwned)).toBe(false);

  await page.getByRole("tab", { name: "Files" }).click();
  await page.getByRole("button", { name: "Preview active.svg" }).click();
  await expect(page.getByText(/unsupported format/i)).toBeVisible();
});
