import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const PROJECT_ROOT = "/tmp/pi-web-chat-file-preview-e2e/project";

async function login(page: Page, mobile = false) {
  await page.setViewportSize(mobile ? { width: 375, height: 667 } : { width: 1440, height: 900 });
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Open files" }).click();
}

async function edit(page: Page, name: string, text: string) {
  if ((page.viewportSize()?.width ?? 0) >= 768) await expect(page.locator(".monaco-editor")).toBeVisible();
  const editor = page.getByRole("textbox", { name: new RegExp(`^Edit ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`) });
  await expect(editor).toBeVisible();
  await editor.focus();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
}

test("unknown source format previews and desktop source edits persist", async ({ page }) => {
  await login(page);
  const issues: string[] = [];
  page.on("pageerror", (error) => issues.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") issues.push(message.text());
  });
  await page.getByRole("button", { name: "Preview Dockerfile" }).click();
  await expect(page.getByRole("button", { name: "Edit source" })).toBeVisible();
  await expect(page.getByText(/unsupported format/)).toHaveCount(0);
  await page.getByRole("button", { name: "Edit source" }).click();
  await edit(page, "Dockerfile", "FROM node:22\nWORKDIR /app\n");
  await page.screenshot({ path: "/tmp/pi-web-chat-v122-monaco.png" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved to the project" })).toBeVisible();
  expect(readFileSync(`${PROJECT_ROOT}/Dockerfile`, "utf8")).toBe("FROM node:22\nWORKDIR /app\n");
  expect(issues).toEqual([]);
});

test("switching files restores a draft and closing asks before discarding", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Preview edit-draft.txt" }).click();
  await page.getByRole("button", { name: "Edit source" }).click();
  await edit(page, "edit-draft.txt", "draft retained across tabs\n");
  await page.getByRole("tab", { name: "Files", exact: true }).click();
  const beforeUnload = page.waitForEvent("dialog");
  const reload = page.reload({ timeout: 1000 }).catch(() => null);
  const dialog = await beforeUnload;
  expect(dialog.type()).toBe("beforeunload");
  await dialog.dismiss();
  await reload; // Cancelled navigation never emits load; bound its navigation wait.
  await expect(page.getByRole("tab", { name: "Files", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "edit-draft.txt", exact: true }).click();
  await expect(page.getByText("Unsaved changes · drafts stay when switching files")).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Close preview tab: edit-draft.txt" }).click();
  await expect(page.getByRole("tab", { name: "edit-draft.txt", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved to the project")).toBeVisible();
  expect(readFileSync(`${PROJECT_ROOT}/edit-draft.txt`, "utf8")).toBe("draft retained across tabs\n");
});

test("server changes reject saving and keep the user's draft", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: "Preview edit-conflict.txt" }).click();
  await page.getByRole("button", { name: "Edit source" }).click();
  await edit(page, "edit-conflict.txt", "my local draft\n");
  await page.evaluate(async (cwd) => {
    const headers = { authorization: `Bearer ${localStorage.getItem("pi-web-chat:session-token")}` };
    const url = `/api/files/text?cwd=${encodeURIComponent(cwd)}&path=edit-conflict.txt`;
    const latest = await (await fetch(url, { headers })).json();
    const response = await fetch(url, { method: "PUT", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ text: "external change\n", revision: latest.revision }) });
    if (!response.ok) throw new Error("fixture update failed");
  }, PROJECT_ROOT);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The file changed on the server" })).toBeVisible();
  await expect(page.getByText("Unsaved changes · drafts stay when switching files")).toBeVisible();
  expect(readFileSync(`${PROJECT_ROOT}/edit-conflict.txt`, "utf8")).toBe("external change\n");
});

test("mobile editing stays outside the preview iframe and cancelled Back keeps its draft", async ({ page }) => {
  await login(page, true);
  await page.getByRole("button", { name: "Preview edit-mobile.txt" }).click();
  const preview = page.locator('iframe[title="Preview edit-mobile.txt"]');
  await expect(preview).toBeVisible();
  await page.getByRole("button", { name: "Edit source" }).click();
  await edit(page, "edit-mobile.txt", "mobile draft survives Back\n");
  const editor = page.getByRole("textbox", { name: "Edit edit-mobile.txt", exact: true });
  await expect(editor).toHaveValue("mobile draft survives Back\n");
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page.locator(".monaco-editor")).toHaveCount(0);
  const historyLength = await page.evaluate(() => history.length);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.evaluate(() => history.back());
  await expect(editor).toHaveValue("mobile draft survives Back\n");
  expect(await page.evaluate(() => history.length)).toBe(historyLength);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved to the project")).toBeVisible();
  expect(readFileSync(`${PROJECT_ROOT}/edit-mobile.txt`, "utf8")).toBe("mobile draft survives Back\n");
  await page.getByRole("button", { name: "Close preview", exact: true }).click();
  await expect(editor).toHaveCount(0);
});
