import { expect, test, type Page, type Route } from "@playwright/test";

const project = "/tmp/pi-web-chat-file-preview-e2e/project";
const pairs = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => [
  { id: `u-${from + i}`, role: "user", content: [{ type: "text", text: `Prompt ${from + i}` }] },
  { id: `a-${from + i}`, role: "assistant", content: [{ type: "text", text: ("fixture answer paragraph ".repeat(25) + "\n\n").repeat(3) }] },
]).flat();
const anchors = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `u-${i + 1}`, ordinal: i + 1, text: `Prompt ${i + 1}` }));
async function open(page: Page, index: (route: Route) => void | Promise<void>, more = true) {
  let socket: Parameters<Parameters<Page["routeWebSocket"]>[1]>[0];
  const snapshot = (messages: ReturnType<typeof pairs>) => ({ sessionId: "navigator", agent: "pi", cwd: project,
    messages, history: { cursor: more ? "older" : null, hasMore: more }, isStreaming: false, model: null,
    thinkingLevel: "off", thinkingLevels: ["off"] });
  await page.route("**/api/sessions?*", r => r.fulfill({ json: { sessions: [], nextCursor: null, scanning: false } }));
  await page.route("**/api/sessions/navigator/anchors", index);
  await page.routeWebSocket(/\/ws\?/, s => {
    socket = s; s.send(JSON.stringify({ type: "session_bound", sessionId: "navigator" }));
    s.send(JSON.stringify({ type: "snapshot", seq: 0, revision: 0, snapshot: snapshot(more ? pairs(98, 100) : pairs(1, 3)) }));
  });
  await page.goto("/s/navigator");
  await page.getByLabel("Access token").fill("e2e-token"); await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const center = page.getByRole("button", { name: "Questions outline", exact: true });
  await expect(center).toBeVisible();
  return { center, update: (messages: ReturnType<typeof pairs>) => socket.send(JSON.stringify({ type: "snapshot", seq: 1, revision: 1, snapshot: snapshot(messages) })) };
}

test("global ordinals remain correct across suffix pages and earlier-history jumps", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  let historyCalls = 0;
  const { center } = await open(page, r => r.fulfill({ json: { anchors: anchors(100) } }));
  await page.route("**/api/sessions/navigator/history?*", r => { historyCalls++; return r.fulfill({ json: { messages: pairs(1, 97), cursor: null, hasMore: false } }); });
  await expect(center).toHaveText("100/100");
  await expect(page.getByRole("button", { name: "Next question", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Previous question", exact: true }).click();
  await expect(page.locator(".anchor-flash")).toHaveText("Prompt 99"); expect(historyCalls).toBe(0);
  await center.click();
  await page.getByRole("dialog").locator("button").filter({ hasText: "Prompt 1" }).first().click();
  await expect(page.locator(".anchor-flash").filter({ hasText: /^Prompt 1$/ })).toHaveCount(1); expect(historyCalls).toBe(1);
  await expect(center).toHaveText("1/100");
});

test("unknown index disables jumps until the global count is known", async ({ page }) => {
  let pending!: Route;
  const { center } = await open(page, r => { pending = r; });
  await expect(page.getByRole("button", { name: "Next question", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Previous question", exact: true })).toBeDisabled();
  await expect.poll(() => !!pending).toBe(true); await pending.fulfill({ json: { anchors: anchors(100) } });
  await expect(center).toHaveText("100/100");
  await expect(page.getByRole("button", { name: "Previous question", exact: true })).toBeEnabled();
});

test("new persisted questions invalidate the outline without stale counts", async ({ page }) => {
  let count = 3;
  const { center, update } = await open(page, r => r.fulfill({ json: { anchors: anchors(count) } }), false);
  await center.click(); await expect(page.getByRole("dialog").locator("button").filter({ hasText: "Prompt 3" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  count = 4; update(pairs(1, 4)); await expect(center).toHaveText("4/4");
  await page.getByRole("button", { name: "Previous question", exact: true }).click();
  await expect(page.locator(".anchor-flash")).toHaveText("Prompt 3");
  await center.click(); await expect(page.getByRole("dialog").locator("button").filter({ hasText: "Prompt 4" })).toBeVisible();
});

test("failed indexes stop automatically and retry only after user action", async ({ page }) => {
  let requests = 0;
  const { center } = await open(page, r => { requests++; return r.fulfill({ status: 503 }); });
  await expect.poll(() => requests).toBe(1); await page.waitForTimeout(600); expect(requests).toBe(1);
  await center.click(); const retry = page.getByRole("dialog").getByRole("button", { name: /retry/i });
  await expect(retry).toBeVisible(); const before = requests; await retry.click();
  await expect.poll(() => requests).toBe(before + 1); await page.waitForTimeout(300); expect(requests).toBe(before + 1);
});

test("failed jump retries its history operation rather than rereading the index", async ({ page }) => {
  let historyCalls = 0, indexCalls = 0;
  const { center } = await open(page, r => { indexCalls++; return r.fulfill({ json: { anchors: anchors(100) } }); });
  await page.route("**/api/sessions/navigator/history?*", r => {
    historyCalls++; return historyCalls === 1 ? r.fulfill({ status: 503 }) : r.fulfill({ json: { messages: pairs(1, 97), cursor: null, hasMore: false } });
  });
  await expect(center).toHaveText("100/100"); await center.click();
  await page.getByRole("dialog").locator("button").filter({ hasText: "Prompt 1" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: /retry/i }).click();
  await expect(page.locator(".anchor-flash")).toHaveText("Prompt 1");
  expect(historyCalls).toBe(2); expect(indexCalls).toBe(1);
});
