import { expect, test, type Page } from "@playwright/test";
import type { UISessionInfo, UISnapshot } from "../../shared/protocol";

const PROJECT_ROOT = "/tmp/pi-web-chat-file-preview-e2e/project";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1";

const rows: UISessionInfo[] = ["Tab one", "Tab two"].map((name, index) => ({
  id: `tab-session-${index + 1}`,
  path: `${PROJECT_ROOT}/tab-session-${index + 1}.jsonl`,
  project: PROJECT_ROOT,
  name,
  firstMessage: `${name} first message`,
  modified: new Date(Date.UTC(2026, 8, 30, 1, 0, 100 - index)).toISOString(),
  messageCount: 2,
}));

/** Two open sessions in the same viewport: the tab strip only renders with 2+ tabs. */
async function openChat(page: Page) {
  await page.addInitScript(
    (project) =>
      localStorage.setItem(
        "pi-web-chat:sidebar-expanded-projects",
        JSON.stringify([project]),
      ),
    PROJECT_ROOT,
  );
  await page.route(/\/api\/sessions(?:\?|$)/, (route) => {
    const paged = new URL(route.request().url()).search.length > 0;
    return route.fulfill({ json: paged ? { sessions: rows, nextCursor: null, scanning: false } : rows });
  });
  await page.routeWebSocket(/\/ws\?/, (socket) => {
    const snapshot: UISnapshot = {
      messages: [{ role: "user", content: [{ type: "text", text: "steady message" }] }],
      history: { cursor: null, hasMore: false },
      isStreaming: false,
      model: null,
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      agent: "pi",
      cwd: PROJECT_ROOT,
    };
    socket.send(JSON.stringify({ type: "snapshot", seq: 0, revision: 0, snapshot }));
  });
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Open files" })).toBeVisible();
}

async function openSessionRow(page: Page, name: string) {
  await page.getByRole("button", { name: "Session list" }).click();
  const row = page.getByRole("button", { name }).first();
  await expect(row).toBeVisible();
  await row.click();
}

test("switching session tabs keeps exactly one message surface", async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    userAgent: IPHONE_UA,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await openChat(page);
    await openSessionRow(page, "Tab one");
    await expect(page).toHaveURL(/\/s\/tab-session-1$/);
    await openSessionRow(page, "Tab two");
    await expect(page).toHaveURL(/\/s\/tab-session-2$/);

    const tabs = page.locator('[role="tab"]');
    await expect(tabs).toHaveCount(3); // draft + both sessions

    for (const index of [0, 1, 2, 1, 0]) {
      await tabs.nth(index).click();
      const selected = tabs.nth(index);
      await expect(selected).toHaveAttribute("aria-selected", "true");
      // The previous session's surface must be gone, not stacked under this one.
      await expect(page.locator(".message-list")).toHaveCount(1);
      await expect(page.locator(".composer-bar")).toBeVisible();
      // One surface fills the column instead of sharing it with a stale sibling.
      const column = page.locator(".message-list").first();
      const box = await column.boundingBox();
      const viewport = page.viewportSize()!;
      expect(box!.height).toBeGreaterThan(viewport.height / 2);
    }
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
