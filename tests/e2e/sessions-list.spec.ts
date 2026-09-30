import { expect, test, type Page, type Route } from "@playwright/test";
import type { UISessionInfo, UISnapshot } from "../../shared/protocol";

const PROJECT = "/tmp/pi-web-chat-file-preview-e2e/project";
const summary = (index: number): UISessionInfo => ({
  id: `saved-${index}`, path: `${PROJECT}/saved-${index}.jsonl`, project: PROJECT,
  name: `Saved session ${index}`, firstMessage: `Request ${index}`,
  modified: new Date(Date.UTC(2026, 8, 30, 0, 0, 100 - index)).toISOString(), messageCount: 2,
});

async function setupChat(page: Page) {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.addInitScript((project) => localStorage.setItem("pi-web-chat:sidebar-expanded-projects", JSON.stringify([project])), PROJECT);
  await page.routeWebSocket(/\/ws\?/, (socket) => {
    const snapshot: UISnapshot = {
      messages: [], history: { cursor: null, hasMore: false }, isStreaming: false,
      model: null, thinkingLevel: "off", thinkingLevels: ["off"], agent: "pi", cwd: PROJECT,
      sessionId: "current", sessionFile: `${PROJECT}/current.jsonl`,
    };
    socket.send(JSON.stringify({ type: "session_bound", sessionId: "current" }));
    socket.send(JSON.stringify({ type: "snapshot", seq: 0, revision: 0, snapshot }));
  });
}

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Session list" })).toBeVisible();
}

test("session drawer progressively reconciles, pages and searches the complete catalog", async ({ page }) => {
  await setupChat(page);
  const rows = Array.from({ length: 85 }, (_, index) => summary(index));
  let discovered = false;
  const requests: string[] = [];
  await page.route("**/api/sessions?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    requests.push(params.toString());
    const query = params.get("q");
    if (query) return route.fulfill({ json: { sessions: rows.filter((row) => row.name!.toLowerCase().includes(query)), nextCursor: null, scanning: false } });
    if (!discovered) {
      discovered = true;
      return route.fulfill({ json: { sessions: rows.slice(0, 5), nextCursor: null, scanning: true } });
    }
    const offset = Number(params.get("cursor") ?? 0);
    return route.fulfill({ json: { sessions: rows.slice(offset, offset + 40), nextCursor: offset + 40 < rows.length ? String(offset + 40) : null, scanning: false } });
  });
  await login(page);
  await page.getByRole("button", { name: "Session list" }).click();
  await expect(page.getByText("Discovering more sessions…", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more sessions" })).toBeVisible();
  await page.getByRole("button", { name: "Load more sessions" }).click();
  await expect(page.getByText("Saved session 60", { exact: true })).toBeAttached();
  expect(requests.some((request) => request.includes("cursor=40"))).toBe(true);
  await page.getByPlaceholder("Search sessions…").fill("saved session 84");
  await expect(page.getByText("Saved session 84", { exact: true })).toBeVisible();
  await expect(page.getByText("Saved session 0", { exact: true })).toHaveCount(0);
});

test("local summaries render while reload is pending and logout clears them", async ({ page }) => {
  await setupChat(page);
  let delay = false;
  let pending: Route | undefined;
  await page.route("**/api/sessions?*", async (route) => {
    if (delay) { pending = route; return; }
    return route.fulfill({ json: { sessions: [summary(0)], nextCursor: null, scanning: false } });
  });
  await login(page);
  await page.getByRole("button", { name: "Session list" }).click();
  await expect(page.getByText("Saved session 0", { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("pi-web-chat:session-list:")).length)).toBe(1);
  delay = true;
  await page.reload();
  await expect(page.getByRole("button", { name: "Session list" })).toBeVisible();
  await page.getByRole("button", { name: "Session list" }).click();
  await expect(page.getByText("Saved session 0", { exact: true })).toBeVisible();
  await expect(page.getByText("Showing saved sessions while refreshing…", { exact: true })).toBeVisible();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByLabel("Access token")).toBeVisible();
  await pending?.fulfill({ json: { sessions: [summary(99)], nextCursor: null, scanning: false } }).catch(() => {});
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("pi-web-chat:session-list:")).length)).toBe(0);
});

test("expired page cursors retry from a new first page while preserving usable rows", async ({ page }) => {
  await setupChat(page);
  let expired = false;
  let refreshed = false;
  await page.route("**/api/sessions?*", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    if (params.has("cursor") && !refreshed) {
      expired = true;
      return route.fulfill({ status: 409, json: { error: "session page expired" } });
    }
    if (params.get("refresh") === "1") refreshed = true;
    return route.fulfill({ json: { sessions: Array.from({ length: 40 }, (_, index) => summary(index)), nextCursor: refreshed ? null : "expired-cursor", scanning: false } });
  });
  await login(page);
  await page.getByRole("button", { name: "Session list" }).click();
  await page.getByRole("button", { name: "Load more sessions" }).click();
  await expect(page.getByRole("button", { name: "Retry loading sessions" })).toBeVisible();
  expect(expired).toBe(true);
  await expect(page.getByText("Saved session 0", { exact: true })).toBeAttached();
  await page.getByRole("button", { name: "Retry loading sessions" }).click();
  await expect(page.getByRole("button", { name: "Retry loading sessions" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load more sessions" })).toHaveCount(0);
});

test("a partial catalog failure does not claim that the complete list is empty", async ({ page }) => {
  await setupChat(page);
  await page.route("**/api/sessions?*", (route) => route.fulfill({
    json: { sessions: [], nextCursor: null, scanning: false, partialFailure: true },
  }));
  await login(page);
  await page.getByRole("button", { name: "Session list" }).click();
  await expect(page.getByRole("button", { name: "Retry loading sessions" })).toBeVisible();
  await expect(page.getByText("No saved sessions", { exact: true })).toHaveCount(0);
  await page.getByPlaceholder("Search sessions…").fill("missing source");
  await expect(page.getByRole("button", { name: "Retry loading sessions" })).toBeVisible();
  await expect(page.getByText("No matching sessions", { exact: true })).toHaveCount(0);
});

test("an empty search reports no matches while an empty unfiltered catalog reports no saved sessions", async ({ page }) => {
  await setupChat(page);
  await page.route("**/api/sessions?*", (route) => route.fulfill({
    json: { sessions: [], nextCursor: null, scanning: false },
  }));
  await login(page);
  await page.getByRole("button", { name: "Session list" }).click();
  await expect(page.getByText("No saved sessions", { exact: true })).toBeVisible();
  await page.getByPlaceholder("Search sessions…").fill("not present");
  await expect(page.getByText("No matching sessions", { exact: true })).toBeVisible();
  await expect(page.getByText("No saved sessions", { exact: true })).toHaveCount(0);
});
