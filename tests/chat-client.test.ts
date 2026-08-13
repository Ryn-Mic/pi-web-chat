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

function createConnectedClient(timeoutMs = 10) {
  const previousWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  const client = new ChatClient(undefined, timeoutMs);
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

test("keeps a prompt pending until the first assistant response", () => {
  const { client, restore } = createConnectedClient();
  try {
    client.send({ type: "prompt", text: "keep this draft" });

    assert.equal(client.state.promptStatus, "waiting");
    const responseToken = client.state.promptResponseToken;

    (client as unknown as { handle(event: unknown): void }).handle({ type: "agent_start" });

    assert.equal(client.state.promptStatus, "responding");
    assert.equal(client.state.promptResponseToken, responseToken + 1);
  } finally {
    restore();
  }
});

test("notifies the owning tab once when the first response arrives", () => {
  const previousWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: FakeWebSocket,
  });

  let responseCount = 0;
  const client = new ChatClient(undefined, 1_000, () => {
    responseCount += 1;
  });
  (client as unknown as { ws: FakeWebSocket }).ws = new FakeWebSocket();
  try {
    client.send({ type: "prompt", text: "notify this tab" });
    (client as unknown as { handle(event: unknown): void }).handle({ type: "agent_start" });
    (client as unknown as { handle(event: unknown): void }).handle({ type: "delta", kind: "text", delta: "done" });

    assert.equal(responseCount, 1);
  } finally {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: previousWebSocket,
    });
  }
});

test("marks a prompt as timed out so the composer can restore send", async () => {
  const { client, restore } = createConnectedClient(5);
  try {
    client.send({ type: "prompt", text: "retry this draft" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(client.state.promptStatus, "timeout");
    assert.equal(client.state.promptFailureToken, 1);
  } finally {
    restore();
  }
});

test("aborts a timed-out run before accepting a retry", async () => {
  const { client, restore } = createConnectedClient(5);
  try {
    const socket = (client as unknown as { ws: FakeWebSocket }).ws;
    client.send({ type: "prompt", text: "old prompt" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(socket.sent.map((data) => JSON.parse(data).type), ["prompt", "abort"]);
    client.send({ type: "prompt", text: "retry prompt" });
    assert.deepEqual(socket.sent.map((data) => JSON.parse(data).type), ["prompt", "abort"]);

    (client as unknown as { handle(event: unknown): void }).handle({ type: "agent_end" });
    (client as unknown as { handle(event: unknown): void }).handle({
      type: "snapshot",
      snapshot: { messages: [], isStreaming: false },
    });
    client.send({ type: "prompt", text: "retry prompt" });

    assert.deepEqual(
      socket.sent
        .map((data) => JSON.parse(data))
        .filter((command) => command.type === "prompt")
        .map((command) => command.text),
      ["old prompt", "retry prompt"],
    );
  } finally {
    restore();
  }
});

test("keeps a disconnected timed-out run from accepting a retry", async () => {
  const { client, restore } = createConnectedClient(5);
  try {
    const socket = (client as unknown as { ws: FakeWebSocket }).ws;
    client.send({ type: "prompt", text: "old prompt" });
    socket.readyState = 0;
    await new Promise((resolve) => setTimeout(resolve, 20));

    client.send({ type: "prompt", text: "retry prompt" });
    assert.equal(client.state.promptStatus, "error");
    assert.deepEqual(socket.sent.map((data) => JSON.parse(data).type), ["prompt"]);
  } finally {
    restore();
  }
});

test("waits for abort acknowledgement before retrying after a disconnected timeout", async () => {
  const { client, restore } = createConnectedClient(5);
  try {
    const socket = (client as unknown as { ws: FakeWebSocket }).ws;
    client.send({ type: "prompt", text: "old prompt" });
    socket.readyState = 0;
    await new Promise((resolve) => setTimeout(resolve, 20));

    socket.readyState = FakeWebSocket.OPEN;
    (client as unknown as { handle(event: unknown): void }).handle({
      type: "snapshot",
      snapshot: { messages: [], isStreaming: false },
    });
    client.send({ type: "prompt", text: "retry prompt" });
    assert.equal(client.state.promptStatus, "error");

    (client as unknown as { handle(event: unknown): void }).handle({ type: "abort_complete" });
    client.send({ type: "prompt", text: "retry prompt" });

    assert.equal(client.state.promptStatus, "waiting");
    assert.deepEqual(
      socket.sent.map((data) => JSON.parse(data).text).filter(Boolean),
      ["old prompt", "retry prompt"],
    );
  } finally {
    restore();
  }
});

test("completes a retry after the abort acknowledgement", async () => {
  const { client, restore } = createConnectedClient(5);
  try {
    client.send({ type: "prompt", text: "old prompt" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    (client as unknown as { handle(event: unknown): void }).handle({ type: "abort_complete" });
    client.send({ type: "prompt", text: "retry prompt" });

    (client as unknown as { handle(event: unknown): void }).handle({ type: "agent_start" });
    assert.equal(client.state.promptStatus, "responding");
    assert.equal(client.state.promptResponseToken, 1);
    (client as unknown as { handle(event: unknown): void }).handle({ type: "agent_end" });
    assert.equal(client.state.promptStatus, "idle");
  } finally {
    restore();
  }
});

test("does not let a late agent_end acknowledge a retry", async () => {
  const { client, restore } = createConnectedClient(5);
  try {
    const socket = (client as unknown as { ws: FakeWebSocket }).ws;
    client.send({ type: "prompt", text: "old prompt" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    (client as unknown as { handle(event: unknown): void }).handle({
      type: "snapshot",
      snapshot: { messages: [], isStreaming: false },
    });
    (client as unknown as { handle(event: unknown): void }).handle({ type: "abort_complete" });

    client.send({ type: "prompt", text: "retry prompt" });
    assert.equal(client.state.promptStatus, "waiting");
    (client as unknown as { handle(event: unknown): void }).handle({ type: "agent_end" });
    assert.equal(client.state.promptResponseToken, 0);
    assert.equal(client.state.promptStatus, "waiting");
    assert.deepEqual(
      socket.sent.map((data) => JSON.parse(data).type),
      ["prompt", "abort", "prompt"],
    );
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

  const client = new ChatClient(undefined, 1_000);
  (client as unknown as { ws: FakeWebSocket }).ws = {
    readyState: 0,
    sent: [],
    send() {},
  };
  try {
    client.send({ type: "prompt", text: "send when disconnected" });

    assert.equal(client.state.promptStatus, "error");
    assert.equal(client.state.promptFailureToken, 1);
  } finally {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      value: previousWebSocket,
    });
  }
});

test("recognizes a completed response from a non-streaming snapshot", () => {
  const { client, restore } = createConnectedClient(1_000);
  try {
    client.send({ type: "prompt", text: "reconnect this draft" });
    const responseToken = client.state.promptResponseToken;

    (client as unknown as { handle(event: unknown): void }).handle({
      type: "snapshot",
      snapshot: {
        messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
        isStreaming: false,
      },
    });

    assert.equal(client.state.promptStatus, "idle");
    assert.equal(client.state.promptResponseToken, responseToken + 1);
  } finally {
    restore();
  }
});

test("finishes a pending prompt when agent_end is the first event", () => {
  const { client, restore } = createConnectedClient(1_000);
  try {
    client.send({ type: "prompt", text: "finish this draft" });

    (client as unknown as { handle(event: unknown): void }).handle({ type: "agent_end" });

    assert.equal(client.state.promptStatus, "idle");
    assert.equal(client.state.promptResponseToken, 1);
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
