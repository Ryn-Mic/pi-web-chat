import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getActiveTodo,
  getOptimisticActiveTodo,
  recordMessageCompletion,
  recordSessionMessageCompletions,
  serializeMessages,
} from "../server/serialize.ts";

function userMessage(text: string) {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantWithToolCall(id: string, name = "bash", args: unknown = { command: "ls" }) {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "running" },
      { type: "toolCall", id, name, arguments: args },
    ],
  };
}

function toolResult(toolCallId: string, text: string, details?: Record<string, unknown>) {
  return {
    role: "toolResult",
    toolCallId,
    content: text,
    isError: false,
    ...(details ? { details } : {}),
  };
}

test("unchanged messages keep their object reference across calls", () => {
  const messages: unknown[] = [userMessage("hello"), assistantWithToolCall("c1")];

  const first = serializeMessages(messages);
  const second = serializeMessages(messages);

  assert.equal(second.length, first.length);
  first.forEach((message, i) => {
    assert.equal(second[i], message, `message ${i} should be the same reference`);
  });
});

test("appending a message reuses the earlier references", () => {
  const first = userMessage("hello");
  const messages: unknown[] = [first];
  const before = serializeMessages(messages);

  messages.push(assistantWithToolCall("c1"));
  const after = serializeMessages(messages);

  assert.equal(after[0], before[0], "existing message must not be rebuilt");
  assert.equal(after.length, 2);
});

test("a tool result arriving invalidates only its own message", () => {
  const user = userMessage("hello");
  const assistant = assistantWithToolCall("c1");
  const messages: unknown[] = [user, assistant];
  const before = serializeMessages(messages);

  const pendingCall = before[1]?.content[1];
  assert.equal(pendingCall?.type, "toolCall");
  assert.equal(pendingCall.type === "toolCall" ? pendingCall.result : "unset", undefined);

  messages.push(toolResult("c1", "file-a\nfile-b"));
  const after = serializeMessages(messages);

  assert.equal(after[0], before[0], "unrelated message must keep its reference");
  assert.notEqual(after[1], before[1], "the message owning the tool call must be rebuilt");

  const settledCall = after[1]?.content[1];
  assert.equal(settledCall?.type, "toolCall");
  if (settledCall?.type === "toolCall") {
    assert.equal(settledCall.result?.text, "file-a\nfile-b");
    assert.equal(settledCall.result?.isError, false);
  }
});

test("a settled tool call is stable on subsequent calls", () => {
  const messages: unknown[] = [assistantWithToolCall("c1"), toolResult("c1", "done")];
  const first = serializeMessages(messages);
  const second = serializeMessages(messages);

  assert.equal(second[0], first[0], "message reference must be reused");

  const firstCall = first[0]?.content[1];
  const secondCall = second[0]?.content[1];
  assert.equal(firstCall?.type, "toolCall");
  assert.equal(secondCall?.type, "toolCall");
  if (firstCall?.type === "toolCall" && secondCall?.type === "toolCall") {
    assert.equal(secondCall.result, firstCall.result, "result reference must be reused");
    assert.equal(secondCall.result?.text, "done");
  }
});

test("separate message objects with equal content are cached independently", () => {
  // Session switch / fork produces fresh objects: the cache must not serve the
  // previous session's output for them.
  const a = serializeMessages([userMessage("hello")]);
  const b = serializeMessages([userMessage("hello")]);
  assert.notEqual(b[0], a[0]);
  assert.deepEqual(b[0], a[0]);
});

test("args keep the agent's original object reference", () => {
  const args = { command: "ls" };
  const out = serializeMessages([assistantWithToolCall("c1", "bash", args)]);
  const call = out[0]?.content[1];
  assert.equal(call?.type === "toolCall" ? call.args : null, args);
});

test("ANSI escapes are stripped and empty messages are dropped", () => {
  const out = serializeMessages([
    { role: "user", content: [{ type: "text", text: "" }] },
    { role: "user", content: "\u001b[31mred\u001b[0m plain" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0]?.content[0]?.type === "text" ? out[0].content[0].text : "", "red plain");
});

test("assistant completion time invalidates an earlier cached serialization", () => {
  const assistant = { role: "assistant", content: [{ type: "text", text: "done" }] };
  const before = serializeMessages([assistant]);
  assert.equal(before[0]?.completedAt, undefined);

  recordMessageCompletion(assistant, 1_786_331_830_345);
  const after = serializeMessages([assistant]);

  assert.notEqual(after[0], before[0]);
  assert.equal(after[0]?.completedAt, 1_786_331_830_345);
});

test("assistant completion time is restored from a persisted session entry", () => {
  const assistant = { role: "assistant", content: [{ type: "text", text: "done" }] };
  recordSessionMessageCompletions([
    {
      type: "message",
      timestamp: "2026-08-14T09:05:07.000Z",
      message: assistant,
    },
  ]);

  const out = serializeMessages([assistant]);
  assert.equal(out[0]?.completedAt, Date.parse("2026-08-14T09:05:07.000Z"));
});

test("todo update exposes the next active task before its result arrives", () => {
  const tasks = [
    { id: 1, subject: "one", status: "completed" },
    { id: 2, subject: "two", status: "pending", activeForm: "old label" },
  ];
  const messages = serializeMessages([
    assistantWithToolCall("c1", "todo", { action: "list" }),
    toolResult("c1", "", { tasks }),
  ]);

  assert.deepEqual(
    getOptimisticActiveTodo(messages, {
      action: "update",
      id: 2,
      status: "in_progress",
      activeForm: "doing two now",
    }),
    {
      subject: "two",
      activeForm: "doing two now",
      status: "in_progress",
      current: 2,
      total: 2,
    },
  );
  assert.equal(
    getOptimisticActiveTodo(messages, { action: "update", id: 2, status: "completed" }),
    undefined,
  );
});

test("todo task lists survive the cache and feed getActiveTodo", () => {
  const tasks = [
    { id: 1, subject: "one", status: "completed" },
    { id: 2, subject: "two", status: "in_progress", activeForm: "doing two" },
  ];
  const messages: unknown[] = [
    assistantWithToolCall("c1", "todo", {}),
    toolResult("c1", "", { tasks }),
  ];

  const out = serializeMessages(messages);
  const active = getActiveTodo(out);
  assert.equal(active?.subject, "two");
  assert.equal(active?.status, "in_progress");
  assert.equal(active?.current, 2);
  assert.equal(active?.total, 2);

  // A second pass must return the cached message and the same todo view.
  const again = serializeMessages(messages);
  assert.equal(again[0], out[0]);
  assert.deepEqual(getActiveTodo(again), active);
});
