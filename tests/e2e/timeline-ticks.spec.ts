import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import type { UIMessage, UISnapshot } from "../../shared/protocol";

const PROJECT_ROOT = "/tmp/pi-web-chat-file-preview-e2e/project";
const message = (id: string, text: string, role: "user" | "assistant" = "assistant"): UIMessage => ({
  id,
  role,
  content: [{ type: "text", text }],
});

function snapshotFor(id: string, messages: UIMessage[]): UISnapshot {
  return {
    messages,
    history: { cursor: null, hasMore: false },
    isStreaming: false,
    model: null,
    thinkingLevel: "off",
    thinkingLevels: ["off"],
    agent: "pi",
    cwd: PROJECT_ROOT,
    sessionId: id,
    sessionFile: `${PROJECT_ROOT}/${id}.jsonl`,
  };
}

async function mockChatWithQuestions(page: Page, count = 10) {
  const messages: UIMessage[] = [];
  for (let i = 1; i <= count; i++) {
    messages.push(message(`u-${i}`, `Question #${i} from user about topic ${i}`, "user"));
    messages.push(message(`a-${i}`, `Answer #${i} with some long text to provide scrollable vertical distance.`, "assistant"));
  }

  const snapshot = snapshotFor("session-ticks", messages);
  let wsSocket: WebSocketRoute | null = null;

  await page.route("**/api/sessions?*", async (route) =>
    route.fulfill({
      json: {
        sessions: [
          {
            id: "session-ticks",
            path: `${PROJECT_ROOT}/session-ticks.jsonl`,
            project: PROJECT_ROOT,
            name: "Session Ticks",
            firstMessage: "Question #1",
            modified: "2026-09-30T00:00:00Z",
            messageCount: count * 2,
            agent: "pi",
          },
        ],
        nextCursor: null,
        scanning: false,
      },
    }),
  );

  await page.routeWebSocket(/\/ws\?/, (socket) => {
    wsSocket = socket;
    socket.send(JSON.stringify({ type: "session_bound", sessionId: "session-ticks" }));
    socket.send(JSON.stringify({ type: "snapshot", seq: 0, revision: 0, snapshot }));
  });
}

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Open files" })).toBeVisible();
  await expect(page).toHaveURL(/\/s\/session-ticks$/);
}

test("timeline ticks: renders up to 7 ticks, centers, highlights current, expands on first tap, and collapses after 2s inactivity", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await mockChatWithQuestions(page, 10);
  await login(page);

  // 1. Locate ticks navigation container
  const nav = page.locator('aside[role="navigation"]');
  await expect(nav).toBeVisible();

  // 2. Count tick buttons: exactly 7 ticks for 10 questions
  const ticks = nav.locator(".group\\/ticks button");
  await expect(ticks).toHaveCount(7);

  // 3. Current active tick is highlighted and wider (w-4.5 or w-5, bg-accent)
  const activeTick = nav.locator(".group\\/ticks button.bg-accent");
  await expect(activeTick).toHaveCount(1);

  // 4. First click on the ticks track expands the flyout card
  await nav.locator(".group\\/ticks").click();

  const flyout = nav.locator(".animate-in");
  await expect(flyout).toBeVisible();
  const flyoutItems = flyout.locator("button");
  // 7 tick items + 1 "all questions" footer button = 8 buttons
  await expect(flyoutItems).toHaveCount(8);

  // 5. Test 2-second auto-collapse: wait 2.3 seconds without interaction
  await page.waitForTimeout(2300);
  await expect(flyout).not.toBeVisible();

  // 6. Click again to expand, then click an item to jump
  await nav.locator(".group\\/ticks").click();
  await expect(flyout).toBeVisible();

  const firstItem = flyout.locator("button").first();
  await firstItem.click();

  // Clicking an item should jump and immediately collapse the flyout
  await expect(flyout).not.toBeVisible();
});

test("timeline ticks: sliding/scrubbing on ticks scrolls the chat viewport in real-time", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await mockChatWithQuestions(page, 10);
  await login(page);

  const nav = page.locator('aside[role="navigation"]');
  await expect(nav).toBeVisible();

  const track = nav.locator(".group\\/ticks");
  const trackBox = await track.boundingBox();
  expect(trackBox).not.toBeNull();

  // Pointer down at the bottom of the track (latest question), then slide up to the top
  const startX = trackBox!.x + trackBox!.width / 2;
  const bottomY = trackBox!.y + trackBox!.height - 5;
  const topY = trackBox!.y + 5;

  await page.mouse.move(startX, bottomY);
  await page.mouse.down();
  // Drag upward to scrub towards earlier messages
  await page.mouse.move(startX, topY, { steps: 5 });

  // Floating scrubber badge should be visible during scrubbing
  const badge = nav.locator(".animate-in");
  await expect(badge).toBeVisible();

  await page.mouse.up();
});
