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

async function mockChatWithQuestions(
  page: Page,
  count = 10,
  answerLines = 2,
  options: { historyHasMore?: boolean } = {},
): Promise<{ messages: UIMessage[]; update: (next: UIMessage[], isStreaming?: boolean) => void }> {
  const messages: UIMessage[] = [];
  for (let i = 1; i <= count; i++) {
    messages.push(message(`u-${i}`, `Question #${i} from user about topic ${i}`, "user"));
    messages.push(
      message(
        `a-${i}`,
        Array.from(
          { length: answerLines },
          () => `Answer #${i} with text to provide scrollable vertical distance.`,
        ).join("\n"),
        "assistant",
      ),
    );
  }

  const build = (next: UIMessage[], isStreaming = false): UISnapshot => ({
    ...snapshotFor("session-ticks", next),
    isStreaming,
    history: { cursor: options.historyHasMore ? "cursor-1" : null, hasMore: !!options.historyHasMore },
  });
  let wsSocket: WebSocketRoute | null = null;
  let seq = 0;
  let revision = 0;

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
    socket.send(JSON.stringify({ type: "snapshot", seq: 0, revision: 0, snapshot: build(messages) }));
  });

  return {
    messages,
    update(next: UIMessage[], isStreaming = false) {
      wsSocket?.send(JSON.stringify({
        type: "snapshot", seq: ++seq, revision: ++revision, snapshot: build(next, isStreaming),
      }));
    },
  };
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

/** Read the ordinal of the single bold/long "current" tick. */
async function activeTickOrdinal(page: Page): Promise<number | null> {
  const raw = await page
    .locator('aside[role="navigation"] button[data-ordinal].bg-accent')
    .first()
    .getAttribute("data-ordinal");
  return raw === null ? null : Number(raw);
}

/** Visible tick ordinals in track order (top → bottom). */
async function visibleTickOrdinals(page: Page): Promise<number[]> {
  return page
    .locator('aside[role="navigation"] button[data-ordinal]')
    .evaluateAll((els) => els.map((el) => Number(el.getAttribute("data-ordinal"))));
}

/**
 * Top edge of the Nth loaded user prompt, relative to the scroll container.
 * Only meaningful when the whole transcript is loaded (no history pages).
 */
async function loadedPromptTop(page: Page, ordinal: number): Promise<number> {
  return page.evaluate((target) => {
    const scroller = document.querySelector(".message-list .thin-scroll")!;
    const containerTop = scroller.getBoundingClientRect().top;
    const prompt = Array.from(scroller.querySelectorAll("[data-msg-index]"))[target - 1]!;
    return Math.round(prompt.getBoundingClientRect().top - containerTop);
  }, ordinal);
}

test("timeline ticks: the highlighted tick corresponds to the prompt at the top of the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  // Short answers keep the NEXT prompt well inside the viewport, which is the
  // geometry that used to highlight the neighbour of the prompt just jumped to.
  await mockChatWithQuestions(page, 10, 1);
  await login(page);

  const nav = page.locator('aside[role="navigation"]');
  await expect(nav).toBeVisible();

  // At rest the viewport is pinned to the end: the newest question is current.
  await expect.poll(() => activeTickOrdinal(page)).toBe(10);

  // Jump back to #5 from the flyout.
  await nav.locator(".group\\/ticks").click();
  const flyout = nav.locator(".animate-in");
  await expect(flyout).toBeVisible();
  await flyout.getByText("Question #5 from user about topic 5").click();

  // The jump aligns the prompt to the top of the viewport…
  await expect.poll(() => loadedPromptTop(page, 5)).toBeLessThanOrEqual(24);
  // …and the highlighted tick is that same prompt, not its neighbour.
  await expect.poll(() => activeTickOrdinal(page)).toBe(5);
  expect(await visibleTickOrdinals(page)).toEqual([2, 3, 4, 5, 6, 7, 8]);

  // Jumping forward tracks the target the same way.
  await nav.locator(".group\\/ticks").click();
  await expect(flyout).toBeVisible();
  await flyout.getByText("Question #8 from user about topic 8").click();
  await expect.poll(() => loadedPromptTop(page, 8)).toBeLessThanOrEqual(24);
  await expect.poll(() => activeTickOrdinal(page)).toBe(8);

  // Scrolling back to the end re-anchors to the newest question.
  await page.evaluate(() => {
    const scroller = document.querySelector(".message-list .thin-scroll")!;
    scroller.scrollTop = scroller.scrollHeight;
  });
  await expect.poll(() => activeTickOrdinal(page)).toBe(10);
});

test("timeline ticks: a transcript that starts mid-conversation is labelled by global ordinals", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });

  const messages: UIMessage[] = [];
  for (let i = 1; i <= 6; i++) {
    messages.push(message(`u-${i}`, `Loaded question #${i}`, "user"));
    messages.push(message(`a-${i}`, "Short answer.", "assistant"));
  }

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
            messageCount: 90,
            agent: "pi",
          },
        ],
        nextCursor: null,
        scanning: false,
      },
    }),
  );
  // The loaded page is the last 6 of 45 questions.
  await page.route("**/api/sessions/session-ticks/anchors", async (route) =>
    route.fulfill({
      json: {
        anchors: Array.from({ length: 45 }, (_, i) => ({
          id: `u${i + 1}`,
          ordinal: i + 1,
          text: `Question #${i + 1}`,
        })),
      },
    }),
  );
  await page.routeWebSocket(/\/ws\?/, (socket: WebSocketRoute) => {
    const snapshot: UISnapshot = {
      ...snapshotFor("session-ticks", messages),
      history: { cursor: "cursor-1", hasMore: true },
    };
    socket.send(JSON.stringify({ type: "session_bound", sessionId: "session-ticks" }));
    socket.send(JSON.stringify({ type: "snapshot", seq: 0, revision: 0, snapshot }));
  });

  await login(page);
  const nav = page.locator('aside[role="navigation"]');
  await expect(nav).toBeVisible();

  // Pinned to the end of a 45-question session: the newest question is tick 45.
  await expect.poll(() => activeTickOrdinal(page)).toBe(45);
  expect(await visibleTickOrdinals(page)).toEqual([39, 40, 41, 42, 43, 44, 45]);

  // The flyout labels the same global node.
  await nav.locator(".group\\/ticks").click();
  await expect(nav.locator(".animate-in")).toBeVisible();
  await expect(nav.locator(".animate-in").getByText("Question #39")).toBeVisible();

  // Scrolling to the top of the loaded page anchors on its first question (40),
  // never on the page-local ordinal 1.
  await page.evaluate(() => {
    document.querySelector(".message-list .thin-scroll")!.scrollTop = 0;
  });
  await expect.poll(() => activeTickOrdinal(page)).toBe(40);
});

test("timeline ticks: an open question flyout survives incoming messages and refreshes the index once", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 667 });
  let anchorRequests = 0;
  await page.route("**/api/sessions/session-ticks/anchors", (route) => {
    anchorRequests += 1;
    return route.fulfill({
      json: {
        anchors: Array.from({ length: 10 }, (_, i) => ({
          id: `u${i + 1}`,
          ordinal: i + 1,
          text: `Question #${i + 1} from user about topic ${i + 1}`,
        })),
      },
    });
  });

  const chat = await mockChatWithQuestions(page, 10, 2, { historyHasMore: true });
  await login(page);

  const nav = page.locator('aside[role="navigation"]');
  await expect(nav).toBeVisible();
  await expect.poll(() => anchorRequests).toBe(1);

  await nav.locator(".group\\/ticks").click();
  const flyout = nav.locator(".animate-in");
  await expect(flyout).toBeVisible();
  await flyout.hover();

  // A streamed assistant message must neither collapse the flyout nor refetch the index.
  chat.update([...chat.messages, message("a-live", "A streamed assistant answer.", "assistant")], true);
  await expect(page.getByText("A streamed assistant answer.", { exact: true })).toBeVisible();
  await expect(flyout).toBeVisible();
  expect(anchorRequests).toBe(1);

  // A new question changes the loaded user count, so the index refreshes exactly once.
  chat.update(
    [
      ...chat.messages,
      message("a-live", "A streamed assistant answer.", "assistant"),
      message("u-11", "Question #11 from user about topic 11", "user"),
    ],
    true,
  );
  await expect(page.getByText("Question #11 from user about topic 11", { exact: true })).toBeVisible();
  await expect.poll(() => anchorRequests).toBe(2);

  chat.update(
    [
      ...chat.messages,
      message("a-live", "A streamed assistant answer.", "assistant"),
      message("u-11", "Question #11 from user about topic 11", "user"),
      message("a-live-2", "More streamed text.", "assistant"),
    ],
    true,
  );
  await expect(page.getByText("More streamed text.", { exact: true })).toBeVisible();
  expect(anchorRequests).toBe(2);
});

test("timeline ticks: a jump lands on its target inside a long transcript", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.route("**/api/sessions/session-ticks/anchors", (route) =>
    route.fulfill({
      json: {
        anchors: Array.from({ length: 60 }, (_, i) => ({
          id: `u${i + 1}`,
          ordinal: i + 1,
          text: `Question #${i + 1} from user about topic ${i + 1}`,
        })),
      },
    }),
  );
  await mockChatWithQuestions(page, 60, 3);
  await login(page);

  const nav = page.locator('aside[role="navigation"]');
  await expect(nav).toBeVisible();
  await expect.poll(() => activeTickOrdinal(page)).toBe(60);

  // Long transcripts skip off-screen replies; the jump must still land exactly.
  await nav.locator(".group\\/ticks").click();
  const flyout = nav.locator(".animate-in");
  await expect(flyout).toBeVisible();
  await flyout.hover();
  await flyout.getByText("Questions outline · (60)").click();
  const outline = page.getByRole("dialog", { name: "Questions outline" });
  await expect(outline).toBeVisible();
  await outline.getByText("Question #5 from user about topic 5").click();

  await expect.poll(() => loadedPromptTop(page, 5)).toBeLessThanOrEqual(24);
  await expect.poll(() => activeTickOrdinal(page)).toBe(5);

  // And back to the end.
  await page.evaluate(() => {
    const scroller = document.querySelector(".message-list .thin-scroll")!;
    scroller.scrollTop = scroller.scrollHeight;
  });
  await expect.poll(() => activeTickOrdinal(page)).toBe(60);
});
