import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import type { ServerEvent, UIAgentKind, UIMessage, UISnapshot } from "../../shared/protocol";

type UnsequencedEvent<T = ServerEvent> = T extends ServerEvent ? Omit<T, "seq"> : never;
const ROOT = "/tmp/pi-web-chat-file-preview-e2e/project";
const message = (id: string, role: UIMessage["role"], text: string): UIMessage => ({ id, role, content: [{ type: "text", text }] });
const prompt = message("prompt", "user", "Inspect this project");
const progress: UIMessage = { id: "progress", role: "assistant", content: [
  { type: "thinking", text: "Inspecting the project carefully" },
  { type: "text", text: "Reading the documentation" },
  { type: "toolCall", id: "read-1", name: "read", args: { path: "README.md" }, result: { text: "Project documentation", isError: false } },
] };
const final = message("final", "assistant", "The project is ready.\n\n✻ Turn took 12s");

/** Deterministic agent frames through the real built HTTP/WebSocket UI. */
async function mockTurn(page: Page, initial: UIMessage[], active = false, agent: UIAgentKind = "pi") {
  const snapshot = (messages: UIMessage[], isStreaming: boolean): UISnapshot => ({
    messages, isStreaming, history: { cursor: "older", hasMore: true }, model: null,
    thinkingLevel: "off", thinkingLevels: ["off"], agent, cwd: ROOT,
    sessionId: "session-a", sessionFile: `${ROOT}/session-a.jsonl`,
  });
  let current = snapshot(initial, active);
  let socket: WebSocketRoute;
  let seq = 0;
  let revision = 0;
  let reconnectBlocked = false;
  await page.route("**/api/sessions?*", (route) => route.fulfill({ json: { sessions: ["a", "b"].map((letter) => ({
    id: `session-${letter}`, path: `${ROOT}/session-${letter}.jsonl`, project: ROOT,
    name: `Session ${letter.toUpperCase()}`, firstMessage: `Session ${letter.toUpperCase()}`,
    modified: "2026-10-01T00:00:00Z", messageCount: 3, agent,
  })), nextCursor: null, scanning: false } }));
  await page.routeWebSocket(/\/ws\?/, (ws) => {
    const id = new URL(ws.url()).searchParams.get("session") ?? "session-a";
    if (id === "session-b") {
      ws.send(JSON.stringify({ type: "session_bound", sessionId: id }));
      ws.send(JSON.stringify({ type: "snapshot", seq: 0, revision: 0, snapshot: { ...snapshot([
        message("b-prompt", "user", "Second task"), message("b-final", "assistant", "Session B answer"),
      ], false), sessionId: id, sessionFile: `${ROOT}/session-b.jsonl` } }));
      return;
    }
    if (reconnectBlocked) { ws.close(); return; }
    socket = ws;
    seq = 0;
    revision = 0;
    ws.send(JSON.stringify({ type: "session_bound", sessionId: id }));
    ws.send(JSON.stringify({ type: "snapshot", seq, revision, snapshot: current }));
  });
  return {
    event(event: UnsequencedEvent) { socket.send(JSON.stringify({ ...event, seq: ++seq })); },
    update(messages: UIMessage[], isStreaming = false) {
      current = snapshot(messages, isStreaming);
      socket.send(JSON.stringify({ type: "snapshot", seq: ++seq, revision: ++revision, snapshot: current }));
    },
    disconnect() { reconnectBlocked = true; socket.close(); },
    reconnect() { reconnectBlocked = false; },
  };
}

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/s\/session-a$/);
  await expect(page.getByRole("button", { name: "Open files" })).toBeVisible();
}

for (const agent of ["pi", "codex"] as const) {
  test(`${agent}: live work stays expanded until the final turn, then folds as one process`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 375, height: 667 });
    if (agent === "codex") await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    const chat = await mockTurn(page, [prompt, progress], true, agent);
    await login(page);
    const process = page.locator("[data-execution-process]");
    await expect(process).toHaveCount(1);
    await expect(process).toHaveAttribute("open", "");
    await expect(page.getByText("Inspecting the project carefully")).toBeVisible();
    chat.event({ type: "delta", kind: "thinking", delta: "Checking another possibility" });
    await expect(page.getByText("Checking another possibility")).toBeVisible();
    chat.event({ type: "thinking_end" });
    await expect(page.getByText("Checking another possibility")).toBeVisible();
    chat.event({ type: "tool_start", toolCallId: "read-2", toolName: "read", args: { path: "package.json" } });
    chat.event({ type: "tool_progress", toolCallId: "read-2", delta: "Live package output" });
    await expect(page.getByText("Live package output")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath(`${agent}-running-process-mobile.png`) });
    chat.event({ type: "tool_end", toolCallId: "read-2", toolName: "read", isError: false });
    chat.event({ type: "delta", kind: "text", delta: "This is progress, not the final answer" });
    await expect(page.getByText("This is progress, not the final answer")).toBeVisible();
    await expect(process).toHaveAttribute("open", "");
    chat.update([prompt, progress, final], true);
    await expect(page.getByText("The project is ready.", { exact: true })).toBeVisible();
    await expect(process).toHaveAttribute("open", "");
    chat.event({ type: "agent_end" });
    await expect(process).not.toHaveAttribute("open", "");
    await expect(page.getByText("Reading the documentation")).toBeHidden();
    await expect(page.getByText("The project is ready.", { exact: true })).toBeVisible();
    await expect(page.getByText("✻ Turn took 12s", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy message", exact: true })).toHaveCount(2);
    const scroller = page.locator(".message-list > .thin-scroll");
    expect(await scroller.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(24);
    await page.screenshot({ path: testInfo.outputPath(`${agent}-folded-process-mobile.png`) });
    await process.locator(":scope > summary").focus();
    await page.keyboard.press("Enter");
    await expect(process).toHaveAttribute("open", "");
    await expect(page.getByText("Reading the documentation")).toBeVisible();
    await page.keyboard.press("Space");
    await expect(process).not.toHaveAttribute("open", "");
  });
}

test("manual reopening survives partial-turn history, snapshot refresh and reconnect without leaking to other tabs", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const chat = await mockTurn(page, [progress, final]);
  await page.route("**/api/sessions/session-a/history?*", (route) => route.fulfill({ json: { messages: [prompt], cursor: null, hasMore: false } }));
  await login(page);
  const process = page.locator("[data-execution-process]");
  await expect(process).not.toHaveAttribute("open", "");
  await process.locator(":scope > summary").click();
  await expect(page.getByText("Reading the documentation")).toBeVisible();
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await expect(page.getByText("Inspect this project", { exact: true })).toBeVisible();
  await expect(process).toHaveAttribute("open", "");
  chat.update([progress, final]);
  await expect(process).toHaveAttribute("open", "");
  chat.disconnect();
  await expect(page.getByText("Can't reach the server. Retrying…", { exact: true })).toBeVisible();
  await expect(process).toHaveAttribute("open", "");
  chat.reconnect();
  await expect(page.getByText("Can't reach the server. Retrying…", { exact: true })).toHaveCount(0);
  await expect(process).toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Session list", exact: true }).click();
  await page.getByRole("button", { name: "project 2", exact: true }).click();
  await page.getByRole("button", { name: /Session B$/ }).click();
  await expect(page).toHaveURL(/\/s\/session-b$/);
  await expect(process).toHaveCount(0);
  await expect(page.getByText("Session B answer", { exact: true })).toBeVisible();
});

test("historical task boundaries fold separately while the current task remains expanded", async ({ page }) => {
  const longProcess = Array.from({ length: 35 }, (_, i): UIMessage => ({ ...progress, id: `step-${i}`, content: [
    { type: "text", text: `Step ${i}: inspecting a long transcript` },
    { ...progress.content[2]!, id: `tool-${i}` } as UIMessage["content"][number],
  ] }));
  await mockTurn(page, [prompt, ...longProcess, final, message("new-prompt", "user", "Next task"), { ...progress, id: "new-progress" }], true);
  await login(page);
  const processes = page.locator("[data-execution-process]");
  await expect(processes).toHaveCount(2);
  await expect(processes.nth(0)).not.toHaveAttribute("open", "");
  await expect(processes.nth(1)).toHaveAttribute("open", "");
  await expect(page.getByText("The project is ready.", { exact: true })).toBeVisible();
  await expect(page.getByText("Step 0: inspecting a long transcript", { exact: true })).toBeHidden();
  await processes.nth(0).locator(":scope > summary").click();
  await expect(page.getByText("Step 0: inspecting a long transcript", { exact: true })).toBeVisible();
  await expect(page.getByText("Tool calls: 35", { exact: true })).toBeVisible();
});

test("interrupted and failed tasks fold by default and flag the summary row", async ({ page }) => {
  const chat = await mockTurn(page, [prompt, progress], true);
  await login(page);
  const process = page.locator("[data-execution-process]");
  await expect(process).toHaveAttribute("open", "", "running work stays expanded");
  chat.update([prompt, { ...progress, errorMessage: "The task was interrupted" }, message("notice", "custom", "Important custom notice"), final]);
  // Settled turns fold even when they carried an error…
  await expect(process).not.toHaveAttribute("open", "");
  // …and the collapsed row reports it instead of hiding it.
  await expect(process.locator(":scope > summary").getByText("Had errors", { exact: true })).toBeVisible();
  await expect(page.getByText("Important custom notice", { exact: true })).toBeVisible();
  await expect(page.getByText("The project is ready.", { exact: true })).toBeVisible();
  // Expanding still exposes the error text and the retained work.
  await process.locator(":scope > summary").click();
  await expect(process).toHaveAttribute("open", "");
  await expect(page.getByText("The task was interrupted", { exact: true })).toBeVisible();
  await expect(page.getByText("Reading the documentation", { exact: true })).toBeVisible();
});

test("a settled turn that recovered from a failed tool folds and counts the failure", async ({ page }) => {
  const failedStep: UIMessage = {
    id: "failed-step",
    role: "assistant",
    content: [
      { type: "thinking", text: "Inspecting the missing file" },
      { type: "toolCall", id: "read-missing", name: "read", args: { path: "missing.md" }, result: { text: "no such file", isError: true } },
    ],
  };
  await mockTurn(page, [prompt, failedStep, final]);
  await login(page);
  const process = page.locator("[data-execution-process]");
  await expect(process).not.toHaveAttribute("open", "");
  const summary = process.locator(":scope > summary");
  await expect(summary.getByText("1 failed", { exact: true })).toBeVisible();
  // Both pills must fit the folded row at mobile width.
  const fitted = await summary.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(fitted).toBe(true);
  await expect(page.getByText("The project is ready.", { exact: true })).toBeVisible();
  await summary.click();
  await expect(process.getByText("read missing.md", { exact: true }).first()).toBeVisible();
});

test("a tool call that never returned a result is flagged as incomplete", async ({ page }) => {
  const pendingStep: UIMessage = {
    id: "pending-step",
    role: "assistant",
    content: [
      { type: "text", text: "Checking the package manifest" },
      { type: "toolCall", id: "read-pending", name: "read", args: { path: "package.json" } },
    ],
  };
  await mockTurn(page, [prompt, pendingStep, final]);
  await login(page);
  const process = page.locator("[data-execution-process]");
  await expect(process).not.toHaveAttribute("open", "");
  await expect(process.locator(":scope > summary").getByText("Had errors", { exact: true })).toBeVisible();
  await expect(page.getByText("The project is ready.", { exact: true })).toBeVisible();
});

test("a plain historical answer has no empty execution disclosure", async ({ page }) => {
  await mockTurn(page, [prompt, final]);
  await login(page);
  await expect(page.locator("[data-execution-process]")).toHaveCount(0);
  await expect(page.getByText("The project is ready.", { exact: true })).toBeVisible();
});

test("live tools remain visible before the running snapshot even on an empty transcript", async ({ page }) => {
  const chat = await mockTurn(page, []);
  await login(page);
  chat.event({ type: "tool_start", toolCallId: "early-tool", toolName: "read", args: { path: "README.md" } });
  chat.event({ type: "tool_progress", toolCallId: "early-tool", delta: "Output before the running snapshot" });
  await expect(page.locator("[data-execution-process]")).toHaveAttribute("open", "");
  await expect(page.getByText("Output before the running snapshot", { exact: true })).toBeVisible();
  chat.event({ type: "tool_end", toolCallId: "early-tool", toolName: "read", isError: false });
  await expect(page.locator("[data-execution-process]")).toHaveCount(0);
});

test("settled process content stays unmounted until it is revealed", async ({ page }) => {
  await mockTurn(page, [prompt, progress, final]);
  await login(page);
  const process = page.locator("[data-execution-process]");
  await expect(process).not.toHaveAttribute("open", "");
  // A settled disclosure keeps no contents in the DOM: a tool-heavy transcript
  // keeps roughly half of its nodes inside closed disclosures, so mounting them
  // ahead of a reveal is the expensive default.
  await expect(process.locator(":scope > div *")).toHaveCount(0);
  await expect(page.getByText("Reading the documentation")).toHaveCount(0);

  await process.locator(":scope > summary").click();
  await expect(process).toHaveAttribute("open", "");
  await expect(page.getByText("Reading the documentation")).toBeVisible();

  // Revealed once → the contents stay mounted, so re-collapsing does not throw
  // away what the reader opened inside.
  await process.locator(":scope > summary").click();
  await expect(process).not.toHaveAttribute("open", "");
  await expect(process.locator(":scope > div *")).not.toHaveCount(0);
});
