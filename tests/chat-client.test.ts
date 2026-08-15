import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatClient, chatClient } from "../src/lib/chat.ts";

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];

  constructor(readonly url = "") {}

  send(data: string) {
    this.sent.push(data);
  }
}

function createConnectedClient() {
  const previousWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  const client = new ChatClient();
  (client as unknown as { ws: FakeWebSocket }).ws = new FakeWebSocket();
  return {
    client,
    restore() {
      Object.defineProperty(globalThis, "WebSocket", {
        configurable: true,
        value: previousWebSocket,
      });
    },
  };
}

test("does not apply a delayed focus request after its tab becomes inactive", async () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { setTimeout },
  });
  const client = new ChatClient();
  try {
    client.requestComposerFocus(() => false);
    await new Promise((resolve) => setTimeout(resolve, 70));

    assert.equal(client.state.focusToken, 0);
  } finally {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: previousWindow,
    });
  }
});

test("shows a prompt immediately and clears it once the server accepts the command", () => {
  const { client, restore } = createConnectedClient();
  try {
    const socket = (client as unknown as { ws: FakeWebSocket }).ws;
    assert.equal(client.send({ type: "prompt", text: "show this now" }), true);

    const command = JSON.parse(socket.sent[0]!);
    assert.equal(client.state.promptStatus, "sending");
    assert.equal(client.state.promptAcceptedToken, 0);
    assert.equal(client.state.optimisticMessages[0]?.content[0]?.type, "text");
    assert.equal(client.state.optimisticMessages[0]?.content[0]?.text, "show this now");

    (client as unknown as { handle(event: unknown): void }).handle({
      type: "prompt_received",
      requestId: command.requestId,
    });

    assert.equal(client.state.promptStatus, "accepted");
    assert.equal(client.state.promptAcceptedToken, 1);
  } finally {
    restore();
  }
});

test("keeps a long-running prompt active without an automatic abort", async () => {
  const { client, restore } = createConnectedClient();
  try {
    const socket = (client as unknown as { ws: FakeWebSocket }).ws;
    client.send({ type: "prompt", text: "slow remote response" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(client.state.promptStatus, "sending");
    assert.deepEqual(socket.sent.map((data) => JSON.parse(data).type), ["prompt"]);
  } finally {
    restore();
  }
});

test("replaces the local prompt when its user message reaches a snapshot", () => {
  const { client, restore } = createConnectedClient();
  try {
    client.send({ type: "prompt", text: "persisted prompt" });
    (client as unknown as { handle(event: unknown): void }).handle({
      type: "snapshot",
      revision: 0,
      snapshot: {
        messages: [{ role: "user", content: [{ type: "text", text: "persisted prompt" }] }],
        isStreaming: true,
      },
    });

    assert.equal(client.state.optimisticMessages.length, 0);
    assert.equal(client.state.promptStatus, "running");
  } finally {
    restore();
  }
});

test("replays an unacknowledged prompt with the same request id after reconnecting", () => {
  const { client, restore } = createConnectedClient();
  try {
    const initialSocket = (client as unknown as { ws: FakeWebSocket }).ws;
    client.send({ type: "prompt", text: "replay safely" });
    const original = JSON.parse(initialSocket.sent[0]!);

    const reconnectSocket = new FakeWebSocket();
    (client as unknown as { ws: FakeWebSocket }).ws = reconnectSocket;
    (client as unknown as { ws: FakeWebSocket; connectionVersion: number }).connectionVersion = 1;
    // The reconnect path reuses this pending command; preserving the request
    // id is the client contract the server uses for deduplication.
    const pending = (client as unknown as { pendingPrompt: { command: unknown } }).pendingPrompt;
    reconnectSocket.send(JSON.stringify(pending.command));

    assert.equal(JSON.parse(reconnectSocket.sent[0]!).requestId, original.requestId);
  } finally {
    restore();
  }
});

test("keeps an optimistic prompt visible when the server rejects it", () => {
  const { client, restore } = createConnectedClient();
  try {
    const socket = (client as unknown as { ws: FakeWebSocket }).ws;
    client.send({ type: "prompt", text: "rejected prompt" });
    const command = JSON.parse(socket.sent[0]!);

    (client as unknown as { handle(event: unknown): void }).handle({
      type: "error",
      message: "server rejected prompt",
      requestId: command.requestId,
    });

    assert.equal(client.state.promptStatus, "idle");
    assert.equal(client.state.optimisticMessages[0]?.errorMessage, "server rejected prompt");
  } finally {
    restore();
  }
});

test("does not enter loading when the prompt cannot be sent", () => {
  const previousWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  const client = new ChatClient();
  (client as unknown as { ws: FakeWebSocket }).ws = {
    readyState: 0,
    sent: [],
    send() {},
  };
  try {
    assert.equal(client.send({ type: "prompt", text: "send when disconnected" }), false);

    assert.equal(client.state.promptStatus, "idle");
  } finally {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: previousWebSocket,
    });
  }
});

test("releases the composer as soon as agent_end arrives", () => {
  const { client, restore } = createConnectedClient();
  try {
    client.send({ type: "prompt", text: "finish this draft" });

    (client as unknown as { handle(event: unknown): void }).handle({ type: "agent_end" });

    assert.equal(client.state.promptStatus, "idle");
    assert.equal(client.state.optimisticMessages.length, 0);

    (client as unknown as { handle(event: unknown): void }).handle({
      type: "snapshot",
      revision: 0,
      snapshot: {
        messages: [{ role: "user", content: [{ type: "text", text: "finish this draft" }] }],
        isStreaming: false,
      },
    });

    assert.equal(client.state.snapshot?.messages.length, 1);
    assert.equal(client.state.optimisticMessages.length, 0);
  } finally {
    restore();
  }
});

test("refillComposer requests a full composer replace", () => {
  const client = new ChatClient();
  client.refillComposer("reuse me");

  assert.deepEqual(client.state.injectText, { text: "reuse me", mode: "replace" });
});

test("insertComposerText requests an insert at the caret", () => {
  const client = new ChatClient();
  client.insertComposerText("src/app.ts");

  assert.deepEqual(client.state.injectText, { text: "src/app.ts", mode: "insert" });
});

test("forked event refills the composer in replace mode", () => {
  const client = new ChatClient();
  (client as unknown as { handle(event: unknown): void }).handle({
    type: "forked",
    selectedText: "selected",
  });

  assert.deepEqual(client.state.injectText, { text: "selected", mode: "replace" });
});

test("consumeInjectText clears a pending inject in either mode", () => {
  const client = new ChatClient();
  client.insertComposerText("x");
  client.consumeInjectText();
  assert.equal(client.state.injectText, null);

  client.refillComposer("y");
  client.consumeInjectText();
  assert.equal(client.state.injectText, null);
});

test("insertComposerText reaches only the active client in the workspace", async () => {
  const previousLocation = (globalThis as { location?: unknown }).location;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "http:", host: "localhost" },
  });
  const previousWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });
  try {
    chatClient.connect("session-a");
    chatClient.connect("session-b");
    chatClient.activate("session-a");

    chatClient.insertComposerText("src/index.ts");
    await Promise.resolve();

    const tabs = chatClient.getTabsSnapshot();
    const active = tabs.find((tab) => tab.key === "session-a");
    const background = tabs.find((tab) => tab.key === "session-b");
    assert.deepEqual(active?.state.injectText, { text: "src/index.ts", mode: "insert" });
    assert.equal(background?.state.injectText, null);
  } finally {
    chatClient.closeTab("session-a");
    chatClient.closeTab("session-b");
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: previousWebSocket,
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: previousLocation,
    });
  }
});

// ---------------------------------------------------------------------------
// Delta flush cadence (two-tier: frame-coalesced deltas, synchronous state)
// ---------------------------------------------------------------------------

function emit(client: ChatClient, event: unknown) {
  (client as unknown as { handle(event: unknown): void }).handle(event);
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("ordinary state updates notify subscribers once per microtask", async () => {
  const { client, restore } = createConnectedClient();
  try {
    let notifications = 0;
    client.subscribe(() => {
      notifications += 1;
    });

    emit(client, { type: "agent_start" });
    emit(client, { type: "tool_start", toolCallId: "c1", toolName: "bash" });
    emit(client, { type: "tool_end", toolCallId: "c1" });

    assert.equal(notifications, 0, "state publication is deferred to the microtask");
    await Promise.resolve();
    assert.equal(notifications, 1, "related state events are published together");
  } finally {
    restore();
  }
});

test("todo tool start exposes optimistic active status immediately", () => {
  const { client, restore } = createConnectedClient();
  try {
    emit(client, {
      type: "snapshot",
      revision: 0,
      snapshot: {
        messages: [],
        isStreaming: true,
        model: null,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
      },
    });
    emit(client, {
      type: "tool_start",
      toolCallId: "todo-1",
      toolName: "todo",
      activeTodo: {
        subject: "Fix latency",
        activeForm: "fixing latency",
        status: "in_progress",
        current: 2,
        total: 3,
      },
    });

    assert.equal(client.state.snapshot?.activeTodo?.subject, "Fix latency");
    assert.equal(client.state.snapshot?.activeTodo?.activeForm, "fixing latency");
    assert.equal(client.state.activeTools[0]?.toolCallId, "todo-1");
  } finally {
    restore();
  }
});

test("the first delta of a stream is not held for a full flush window", async () => {
  const { client, restore } = createConnectedClient();
  try {
    emit(client, { type: "delta", kind: "text", delta: "He" });
    assert.equal(client.state.streamText, "", "delta is buffered, not applied inline");

    // No animation frame in node, so the fallback macrotask runs immediately.
    await tick(5);
    assert.equal(client.state.streamText, "He", "first delta paints without the 100ms wait");
  } finally {
    restore();
  }
});

test("bursts of deltas coalesce into one update per flush window", async () => {
  const { client, restore } = createConnectedClient();
  try {
    let renders = 0;
    client.subscribe(() => {
      renders += 1;
    });

    emit(client, { type: "delta", kind: "text", delta: "a" });
    await tick(5);
    assert.equal(client.state.streamText, "a");
    const rendersAfterFirst = renders;

    // Everything in this burst lands in a single flush at the end of the window.
    for (const chunk of ["b", "c", "d", "e"]) {
      emit(client, { type: "delta", kind: "text", delta: chunk });
    }
    await tick(20);
    assert.equal(client.state.streamText, "a", "still inside the rate window");
    assert.equal(renders, rendersAfterFirst, "no render before the window elapses");

    await tick(120);
    assert.equal(client.state.streamText, "abcde");
    assert.equal(renders, rendersAfterFirst + 1, "the whole burst is one render");
  } finally {
    restore();
  }
});

test("text and thinking deltas are buffered independently", async () => {
  const { client, restore } = createConnectedClient();
  try {
    emit(client, { type: "delta", kind: "thinking", delta: "hmm" });
    emit(client, { type: "delta", kind: "text", delta: "answer" });
    await tick(5);

    assert.equal(client.state.streamThinking, "hmm");
    assert.equal(client.state.streamText, "answer");
    assert.equal(client.state.streamThinkingComplete, false);
  } finally {
    restore();
  }
});

test("a state event flushes pending deltas synchronously", () => {
  const { client, restore } = createConnectedClient();
  try {
    emit(client, { type: "delta", kind: "text", delta: "partial" });
    assert.equal(client.state.streamText, "");

    // thinking_end is a state event: it must not wait for the delta window.
    emit(client, { type: "thinking_end" });
    assert.equal(client.state.streamText, "partial");
    assert.equal(client.state.streamThinkingComplete, true);
  } finally {
    restore();
  }
});

test("a snapshot flushes then clears the stream buffers", () => {
  const { client, restore } = createConnectedClient();
  try {
    emit(client, { type: "delta", kind: "text", delta: "streamed" });
    emit(client, {
      type: "snapshot",
      revision: 0,
      snapshot: {
        messages: [{ role: "assistant", content: [{ type: "text", text: "streamed" }] }],
        isStreaming: false,
      },
    });

    assert.equal(client.state.streamText, "", "completed text lives in the snapshot now");
    assert.equal(client.state.streamThinking, "");
  } finally {
    restore();
  }
});

test("no delta is lost when the window elapses between bursts", async () => {
  const { client, restore } = createConnectedClient();
  try {
    emit(client, { type: "delta", kind: "text", delta: "1" });
    await tick(5);
    emit(client, { type: "delta", kind: "text", delta: "2" });
    await tick(140);
    emit(client, { type: "delta", kind: "text", delta: "3" });
    await tick(140);

    assert.equal(client.state.streamText, "123");
  } finally {
    restore();
  }
});

test("installs a matching incremental snapshot suffix", () => {
  const { client, restore } = createConnectedClient();
  try {
    emit(client, {
      type: "snapshot",
      revision: 3,
      snapshot: {
        messages: [{ role: "user", content: [{ type: "text", text: "one" }] }],
        isStreaming: false,
        model: null,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
      },
    });
    emit(client, {
      type: "snapshot_delta",
      delta: {
        baseRevision: 3,
        revision: 4,
        from: 1,
        messages: [{ role: "assistant", content: [{ type: "text", text: "two" }] }],
        snapshot: {
          isStreaming: false,
          model: null,
          thinkingLevel: "off",
          thinkingLevels: ["off"],
        },
      },
    });

    assert.equal(client.state.snapshot?.messages.length, 2);
    assert.equal(client.state.snapshot?.messages[1]?.content[0]?.type, "text");
    assert.equal(client.state.snapshot?.messages[1]?.content[0]?.text, "two");
  } finally {
    restore();
  }
});

test("requests one full snapshot when an incremental revision has a gap", () => {
  const { client, restore } = createConnectedClient();
  try {
    const socket = (client as unknown as { ws: FakeWebSocket }).ws;
    emit(client, {
      type: "snapshot",
      revision: 1,
      snapshot: {
        messages: [],
        isStreaming: false,
        model: null,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
      },
    });
    const gap = {
      type: "snapshot_delta",
      delta: {
        baseRevision: 9,
        revision: 10,
        from: 0,
        messages: [],
        snapshot: {
          isStreaming: false,
          model: null,
          thinkingLevel: "off",
          thinkingLevels: ["off"],
        },
      },
    };
    emit(client, gap);
    emit(client, gap);

    assert.deepEqual(socket.sent.map((data) => JSON.parse(data)), [{ type: "get_snapshot" }]);

    emit(client, { ...gap, delta: { ...gap.delta, baseRevision: 1, revision: 2 } });
    assert.equal(client.state.snapshot?.messages.length, 0, "matching updates still install");
  } finally {
    restore();
  }
});

test("prepends an older history page and advances its cursor", async () => {
  const previousFetch = globalThis.fetch;
  const { client, restore } = createConnectedClient();
  try {
    emit(client, { type: "session_bound", sessionId: "session-a" });
    emit(client, {
      type: "snapshot",
      revision: 0,
      snapshot: {
        messages: [{ role: "assistant", content: [{ type: "text", text: "latest" }] }],
        history: { cursor: "cursor-1", hasMore: true },
        isStreaming: false,
        model: null,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
      },
    });
    globalThis.fetch = (async (url: string | URL | Request) => {
      assert.match(String(url), /session-a\/history\?cursor=cursor-1/);
      return new Response(
        JSON.stringify({
          messages: [{ role: "user", content: [{ type: "text", text: "older" }] }],
          cursor: null,
          hasMore: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    assert.equal(await client.loadOlderMessages(), true);
    assert.equal(client.state.historicalMessages[0]?.content[0]?.text, "older");
    assert.equal(client.state.historyCursor, null);
    assert.equal(client.state.historyHasMore, false);
    assert.equal(client.state.historyLoading, false);
  } finally {
    globalThis.fetch = previousFetch;
    restore();
  }
});

test("fetches lightweight message anchors without loading transcript pages", async () => {
  const previousFetch = globalThis.fetch;
  const { client, restore } = createConnectedClient();
  try {
    emit(client, { type: "session_bound", sessionId: "session-a" });
    emit(client, {
      type: "snapshot",
      revision: 0,
      snapshot: {
        messages: [{ role: "assistant", content: [{ type: "text", text: "latest" }] }],
        history: { cursor: "cursor-2", hasMore: true },
        isStreaming: false,
        model: null,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
      },
    });
    let requested = "";
    globalThis.fetch = (async (url: string | URL | Request) => {
      requested = String(url);
      return new Response(
        JSON.stringify({
          anchors: [
            { id: "u1", ordinal: 1, text: "oldest" },
            { id: "u2", ordinal: 2, text: "latest" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    assert.deepEqual(await client.loadMessageAnchors(), [
      { id: "u1", ordinal: 1, text: "oldest" },
      { id: "u2", ordinal: 2, text: "latest" },
    ]);
    assert.match(requested, /session-a\/anchors$/);
    assert.deepEqual(client.state.historicalMessages, []);
    assert.equal(client.state.historyHasMore, true);
  } finally {
    globalThis.fetch = previousFetch;
    restore();
  }
});

test("loads history only through the selected user-message page", async () => {
  const previousFetch = globalThis.fetch;
  const { client, restore } = createConnectedClient();
  try {
    emit(client, { type: "session_bound", sessionId: "session-a" });
    emit(client, {
      type: "snapshot",
      revision: 0,
      snapshot: {
        messages: [
          { role: "user", content: [{ type: "text", text: "latest" }] },
          { role: "assistant", content: [{ type: "text", text: "latest answer" }] },
        ],
        history: { cursor: "cursor-2", hasMore: true },
        isStreaming: false,
        model: null,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
      },
    });
    const requested: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const value = String(url);
      requested.push(value);
      if (!value.includes("cursor=cursor-2")) {
        throw new Error(`unexpected extra history request: ${value}`);
      }
      return new Response(
        JSON.stringify({
          messages: [
            { role: "user", content: [{ type: "text", text: "middle" }] },
            { role: "assistant", content: [{ type: "text", text: "middle answer" }] },
          ],
          cursor: "cursor-1",
          hasMore: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    assert.equal(await client.loadHistoryThroughUserMessage(2, 3), true);
    assert.equal(requested.length, 1);
    assert.equal(client.state.historicalMessages[0]?.content[0]?.text, "middle");
    assert.equal(client.state.historyCursor, "cursor-1");
    assert.equal(client.state.historyHasMore, true, "the oldest page remains unloaded");
  } finally {
    globalThis.fetch = previousFetch;
    restore();
  }
});

test("ignores an older history response after switching sessions", async () => {
  const previousFetch = globalThis.fetch;
  const { client, restore } = createConnectedClient();
  try {
    emit(client, { type: "session_bound", sessionId: "session-a" });
    emit(client, {
      type: "snapshot",
      seq: 0,
      revision: 0,
      snapshot: {
        messages: [],
        history: { cursor: "cursor-1", hasMore: true },
        isStreaming: false,
        model: null,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
      },
    });
    let resolveFetch!: (response: Response) => void;
    globalThis.fetch = (() => new Promise<Response>((resolve) => (resolveFetch = resolve))) as typeof fetch;

    const loading = client.loadOlderMessages();
    emit(client, { type: "session_bound", sessionId: "session-b" });
    resolveFetch(
      new Response(JSON.stringify({ messages: [], cursor: null, hasMore: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    assert.equal(await loading, false);
    assert.deepEqual(client.state.historicalMessages, []);
  } finally {
    globalThis.fetch = previousFetch;
    restore();
  }
});

test("requests one event replay for a sequence gap and installs ordered frames", async () => {
  const { client, restore } = createConnectedClient();
  try {
    const socket = (client as unknown as { ws: FakeWebSocket }).ws;
    emit(client, {
      type: "snapshot",
      seq: 5,
      revision: 0,
      snapshot: {
        messages: [],
        isStreaming: true,
        model: null,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
      },
    });

    emit(client, { type: "delta", seq: 7, kind: "text", delta: "b" });
    emit(client, { type: "delta", seq: 7, kind: "text", delta: "b" });
    assert.deepEqual(socket.sent.map((data) => JSON.parse(data)), [
      { type: "sync_events", afterSeq: 5 },
    ]);

    emit(client, { type: "delta", seq: 6, kind: "text", delta: "a" });
    emit(client, { type: "delta", seq: 7, kind: "text", delta: "b" });
    emit(client, { type: "delta", seq: 7, kind: "text", delta: "duplicate" });
    await tick(5);

    assert.equal(client.state.streamText, "ab");
  } finally {
    restore();
  }
});

test("a full snapshot authoritatively restores active tools", () => {
  const { client, restore } = createConnectedClient();
  try {
    emit(client, {
      type: "snapshot",
      seq: 0,
      revision: 0,
      snapshot: {
        messages: [],
        isStreaming: true,
        model: null,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
      },
    });
    emit(client, { type: "tool_start", seq: 1, toolCallId: "old", toolName: "read" });
    assert.equal(client.state.activeTools[0]?.toolCallId, "old");

    emit(client, {
      type: "snapshot",
      seq: 5,
      revision: 2,
      snapshot: {
        messages: [],
        isStreaming: true,
        model: null,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
        activeTools: [{ toolCallId: "current", toolName: "bash" }],
      },
    });
    assert.deepEqual(client.state.activeTools, [{ toolCallId: "current", toolName: "bash" }]);

    emit(client, {
      type: "snapshot",
      seq: 6,
      revision: 3,
      snapshot: {
        messages: [],
        isStreaming: false,
        model: null,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
      },
    });
    assert.deepEqual(client.state.activeTools, []);
  } finally {
    restore();
  }
});

test("a reconnect advertises the last contiguous event sequence", () => {
  const previousLocation = (globalThis as { location?: unknown }).location;
  const previousWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { protocol: "http:", host: "localhost" },
  });
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });
  const client = new ChatClient();
  try {
    emit(client, { type: "session_bound", sessionId: "session-a" });
    emit(client, {
      type: "snapshot",
      seq: 12,
      revision: 3,
      snapshot: {
        messages: [],
        isStreaming: false,
        model: null,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
      },
    });

    client.connect("session-a");
    const socket = (client as unknown as { ws: FakeWebSocket }).ws;
    const url = new URL(socket.url);
    assert.equal(url.searchParams.get("session"), "session-a");
    assert.equal(url.searchParams.get("since"), "12");
  } finally {
    client.dispose();
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: previousWebSocket,
    });
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: previousLocation,
    });
  }
});

test("a full snapshot resets an expired event sequence baseline", () => {
  const { client, restore } = createConnectedClient();
  try {
    const socket = (client as unknown as { ws: FakeWebSocket }).ws;
    emit(client, {
      type: "snapshot",
      seq: 2,
      revision: 0,
      snapshot: {
        messages: [],
        isStreaming: false,
        model: null,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
      },
    });
    emit(client, { type: "agent_start", seq: 9 });
    assert.deepEqual(socket.sent.map((data) => JSON.parse(data)), [
      { type: "sync_events", afterSeq: 2 },
    ]);

    emit(client, {
      type: "snapshot",
      seq: 20,
      revision: 4,
      snapshot: {
        messages: [],
        isStreaming: false,
        model: null,
        thinkingLevel: "off",
        thinkingLevels: ["off"],
      },
    });
    emit(client, { type: "agent_start", seq: 21 });
    assert.equal(client.state.snapshot?.isStreaming, true);
  } finally {
    restore();
  }
});
