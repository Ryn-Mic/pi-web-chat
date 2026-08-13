import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatClient, chatClient } from "../src/lib/chat.ts";

class FakeWebSocket {
  static readonly OPEN = 1;
  readyState = FakeWebSocket.OPEN;
  sent: string[] = [];

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
    assert.equal(client.state.optimisticMessages.length, 1);

    (client as unknown as { handle(event: unknown): void }).handle({
      type: "snapshot",
      snapshot: {
        messages: [{ role: "user", content: [{ type: "text", text: "finish this draft" }] }],
        isStreaming: false,
      },
    });

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

test("insertComposerText reaches only the active client in the workspace", () => {
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
