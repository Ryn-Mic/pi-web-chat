import { expect, test, type Page, type Route, type WebSocketRoute } from "@playwright/test";
import type { UIMessage, UISnapshot } from "../../shared/protocol";

const PROJECT_ROOT = "/tmp/pi-web-chat-file-preview-e2e/project";
const message = (id: string, text: string, role: "user" | "assistant" = "assistant"): UIMessage => ({
  id, role, content: [{ type: "text", text }],
});

function snapshotFor(id: string, messages: UIMessage[], hasMore = true): UISnapshot {
  return {
    messages, history: { cursor: hasMore ? "cursor-1" : null, hasMore },
    isStreaming: false, model: null, thinkingLevel: "off", thinkingLevels: ["off"],
    agent: "pi", cwd: PROJECT_ROOT, sessionId: id, sessionFile: `${PROJECT_ROOT}/${id}.jsonl`,
  };
}

/** Exercise the built app through its real HTTP surface, with deterministic agent frames. */
async function mockChat(page: Page, messages: UIMessage[]) {
  const snapshots = new Map([
    ["session-a", snapshotFor("session-a", messages)],
    ["session-b", snapshotFor("session-b", Array.from({ length: 60 }, (_, i) =>
      message(`b-${i}`, `Session B message ${i} with enough content to scroll.`, i % 2 ? "assistant" : "user")), false)],
  ]);
  const sockets = new Map<string, WebSocketRoute>();
  const revisions = new Map<string, number>();
  let rejectReconnect = false;
  await page.route("**/api/sessions?*", async (route) => route.fulfill({ json: { sessions: ["a", "b"].map((letter) => ({
    id: `session-${letter}`, path: `${PROJECT_ROOT}/session-${letter}.jsonl`, project: PROJECT_ROOT,
    name: `Session ${letter.toUpperCase()}`, firstMessage: `Session ${letter.toUpperCase()}`,
    modified: "2026-09-30T00:00:00Z", messageCount: 60, agent: "pi",
  })), nextCursor: null, scanning: false } }));
  await page.routeWebSocket(/\/ws\?/, (socket) => {
    const id = new URL(socket.url()).searchParams.get("session") ?? "session-a";
    if (rejectReconnect) { socket.close(); return; }
    sockets.set(id, socket);
    revisions.set(id, 0);
    socket.send(JSON.stringify({ type: "session_bound", sessionId: id }));
    socket.send(JSON.stringify({ type: "snapshot", seq: 0, revision: 0, snapshot: snapshots.get(id) }));
  });
  return {
    notice(text: string) { sockets.get("session-a")!.send(JSON.stringify({ type: "command_result", message: text })); },
    reset(messages: UIMessage[], cursor = "cursor-1") {
      const oldRevision = revisions.get("session-a")!;
      const snapshot = snapshotFor("session-a", messages);
      snapshot.history = { cursor, hasMore: true };
      snapshots.set("session-a", snapshot);
      const { messages: nextMessages, ...metadata } = snapshot;
      revisions.set("session-a", oldRevision + 1);
      sockets.get("session-a")!.send(JSON.stringify({ type: "snapshot_delta", seq: oldRevision + 1, delta: {
        baseRevision: oldRevision, revision: oldRevision + 1, from: 0,
        messages: nextMessages, snapshot: metadata, resetHistory: true,
      } }));
    },
    disconnect() { rejectReconnect = true; sockets.get("session-a")!.close(); },
    reconnect() { rejectReconnect = false; },
  };
}

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Open files" })).toBeVisible();
  await expect(page).toHaveURL(/\/s\/session-a$/);
}

test("mobile previews keep one Back entry across chat renders and close through browser Back", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const chat = await mockChat(page, [message("file-link", "Open README.md")]);
  await login(page);
  const before = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "Preview README.md" }).click();
  await expect(page.locator('iframe[title="Preview README.md"]')).toBeVisible();
  for (let index = 0; index < 3; index += 1) {
    chat.notice(`Preview update ${index}`);
    await expect(page.getByText(`Preview update ${index}`, { exact: true })).toBeAttached();
  }
  expect(await page.evaluate(() => history.length)).toBe(before + 1);
  await expect(page.frameLocator('iframe[title="Preview README.md"]').getByText("Changed after the commit.", { exact: false })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("mobile-file-preview.png") });
  await page.goBack();
  await expect(page.locator("iframe")).toHaveCount(0);
  await expect(page).toHaveURL(/\/s\/session-a$/);

  await page.getByRole("button", { name: "Open files" }).click();
  await page.getByRole("tab", { name: "Git", exact: true }).click();
  await page.getByText("update preview files", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Close commit" })).toBeVisible();
  const commitHistory = await page.evaluate(() => history.length);
  chat.notice("Commit update");
  await expect(page.getByText("Commit update", { exact: true })).toBeAttached();
  expect(await page.evaluate(() => history.length)).toBe(commitHistory);
  await page.goBack();
  await expect(page.getByRole("button", { name: "Close commit" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/s\/session-a$/);
});

test("mobile history retry preserves expanded message identity after prepend", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await mockChat(page, [
    message("user-current", "Current request", "user"),
    { id: "assistant-current", role: "assistant", content: [
      { type: "thinking", text: "Keep this expanded thinking" }, { type: "text", text: "Current answer" },
    ] },
  ]);
  let requests = 0;
  await page.route("**/api/sessions/session-a/history?*", async (route) => {
    requests += 1;
    if (requests === 1) return route.fulfill({ status: 503, body: "unavailable" });
    return route.fulfill({ json: { messages: [message("older", "Older history")], cursor: null, hasMore: false } });
  });
  await login(page);
  await page.locator("summary").filter({ hasText: "thinking…" }).click();
  const thinking = page.locator("details").filter({ hasText: "Keep this expanded thinking" });
  await expect(thinking).toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await expect(page.getByText("Couldn't load earlier messages. Try again.")).toBeVisible();
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await expect(page.getByText("Older history", { exact: true })).toBeAttached();
  await expect(thinking).toHaveAttribute("open", "");
  await expect(page.getByText("Couldn't load earlier messages. Try again.")).toHaveCount(0);
});

test("a sliding history window ignores its older pending response and restores the load entry", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const chat = await mockChat(page, [message("latest", "Initial window")]);
  let pending!: Route;
  await page.route("**/api/sessions/session-a/history?*", (route) => { pending = route; });
  await login(page);
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  chat.reset([message("next-window", "New window")]);
  await expect(page.getByText("New window", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Load earlier messages" })).toBeEnabled();
  const staleResponse = page.waitForResponse((response) => response.url().includes("/session-a/history?"));
  await pending.fulfill({ json: { messages: [message("stale", "Stale page")], cursor: null, hasMore: false } });
  await (await staleResponse).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByText("Stale page", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Load earlier messages" })).toBeEnabled();
});

test("an inactive tab's completed page does not move the active tab's scroll container", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await mockChat(page, Array.from({ length: 60 }, (_, index) => message(`a-${index}`, `Session A message ${index}`, index % 2 ? "assistant" : "user")));
  let pending!: Route;
  await page.route("**/api/sessions/session-a/history?*", (route) => { pending = route; });
  await login(page);
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await expect.poll(() => Boolean(pending)).toBe(true);
  await page.getByRole("button", { name: "Session list", exact: true }).click();
  await page.getByRole("button", { name: "project 2", exact: true }).click();
  await page.getByRole("button", { name: /Session B$/ }).click();
  await expect(page).toHaveURL(/\/s\/session-b$/);
  const scroller = page.locator(".message-list > .thin-scroll");
  await scroller.evaluate((element) => { element.scrollTop = 450; });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(450);
  const inactiveResponse = page.waitForResponse((response) => response.url().includes("/session-a/history?"));
  await pending.fulfill({ json: { messages: [message("inactive-older", "Inactive older page")], cursor: null, hasMore: false } });
  await (await inactiveResponse).finished();
  // Two paint frames include React's page installation and the old compensation callback.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(450);
  await page.getByRole("tab", { name: "Session A message 0", exact: true }).click();
  await expect(page.getByText("Inactive older page", { exact: true })).toBeAttached();
});

test("an existing mobile transcript stays readable while disconnected and recovers", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const chat = await mockChat(page, [message("readable", "Transcript survives disconnect")]);
  await login(page);
  chat.disconnect();
  await expect(page.getByText("Can't reach the server. Retrying…", { exact: true })).toBeVisible();
  await expect(page.getByText("Transcript survives disconnect", { exact: true })).toBeVisible();
  chat.reconnect();
  await expect(page.getByText("Can't reach the server. Retrying…", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Transcript survives disconnect", { exact: true })).toBeVisible();
});

test("an auth-driven mobile preview unmount releases its owned Back entry", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  const chat = await mockChat(page, [message("file-link", "Open README.md")]);
  await login(page);
  await page.getByRole("button", { name: "Preview README.md" }).click();
  await expect(page.locator('iframe[title="Preview README.md"]')).toBeVisible();
  expect(await page.evaluate(() => Boolean(history.state?.mobilePreviewLayer))).toBe(true);
  await page.route("**/api/auth/status", (route) => route.fulfill({ status: 401, json: { authenticated: false } }));
  chat.disconnect();
  await expect(page.getByLabel("Access token")).toBeVisible();
  await expect.poll(() => page.evaluate(() => history.state?.mobilePreviewLayer ?? null)).toBe(null);
  await expect(page).toHaveURL(/\/s\/session-a$/);
});
