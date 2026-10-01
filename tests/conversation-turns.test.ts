import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIContentBlock, UIMessage } from "../shared/protocol.ts";
import { conversationTurns } from "../src/lib/conversation-turns.ts";
import { splitAssistantTurnCompletion } from "../src/lib/turn-completion.ts";

const text = (text: string): UIContentBlock => ({ type: "text", text });
const thinking: UIContentBlock = { type: "thinking", text: "Inspecting the implementation" };
const tool: UIContentBlock = {
  type: "toolCall", id: "read-1", name: "read", args: { path: "README.md" },
  result: { text: "contents", isError: false },
};
const message = (id: string, role: UIMessage["role"], content: UIContentBlock[]): UIMessage => ({ id, role, content });
const prompt = message("user-1", "user", [text("Please inspect")]);
const progress = message("progress-1", "assistant", [thinking, text("Reading"), tool]);
const final = message("final-1", "assistant", [text("Done.\n\n✻ Turn took 12s")]);

test("running commentary, thinking and paired tools remain in one expanded process", () => {
  const [turn] = conversationTurns([prompt, progress, final], true);
  assert.equal(turn?.active, true);
  assert.equal(turn?.collapsible, false);
  assert.equal(turn?.reply, undefined);
  assert.deepEqual(turn?.process.map((entry) => entry.key), ["progress-1", "final-1"]);
  assert.equal(turn?.process[0]?.message.content[2], tool);
  assert.equal(turn?.prompt?.index, 0);
});

test("settled turns separate the final reply and keep duration metadata", () => {
  const [turn] = conversationTurns([prompt, progress, final], false);
  assert.equal(turn?.collapsible, true);
  assert.deepEqual(turn?.process.map((entry) => entry.key), ["progress-1"]);
  assert.equal(turn?.reply?.key, "final-1");
  assert.equal(turn?.reply?.message, final, "unchanged final replies retain memo-friendly identity");
  assert.equal(splitAssistantTurnCompletion(turn!.reply!.message.content)?.summary, "✻ Turn took 12s");
  assert.deepEqual(final.content, [text("Done.\n\n✻ Turn took 12s")]);
});

test("thinking inside the final assistant message folds without hiding the reply", () => {
  const mixed = message("mixed", "assistant", [thinking, text("Answer")]);
  const [turn] = conversationTurns([prompt, mixed], false);
  assert.deepEqual(turn?.process[0]?.message.content, [thinking]);
  assert.deepEqual(turn?.reply?.message.content, [text("Answer")]);
  assert.equal(turn?.collapsible, true);
});

test("only text after the last tool belongs to the final reply", () => {
  const mixed = message("mixed", "assistant", [text("Before the tool"), tool, thinking, text("After the tool"), { type: "image", dataUrl: "test" }]);
  const [turn] = conversationTurns([prompt, mixed], false);
  assert.deepEqual(turn?.process[0]?.message.content, [text("Before the tool"), tool, thinking]);
  assert.deepEqual(turn?.reply?.message.content, [text("After the tool"), { type: "image", dataUrl: "test" }]);
});

test("plain replies and empty transcripts do not create process content", () => {
  const [turn] = conversationTurns([prompt, final], false);
  assert.equal(turn?.process.length, 0);
  assert.equal(turn?.reply?.key, "final-1");
  assert.deepEqual(conversationTurns([], false), []);
  assert.equal(conversationTurns([prompt], true)[0]?.active, true);
});

test("previous tasks can fold while a later task runs", () => {
  const second = message("user-2", "user", [text("Next task")]);
  const turns = conversationTurns([prompt, progress, final, second, progress], true);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.collapsible, true);
  assert.equal(turns[0]?.active, false);
  assert.equal(turns[1]?.collapsible, false);
  assert.equal(turns[1]?.active, true);
  assert.equal(turns[1]?.prompt?.index, 3);
});

test("partial historical turns retain identity after their prompt and earlier steps load", () => {
  const before = conversationTurns([progress, final], false)[0]!;
  const after = conversationTurns([prompt, message("earlier", "assistant", [thinking]), progress, final], false)[0]!;
  assert.equal(before.key, after.key);
  assert.equal(after.process.length, 2);
  assert.equal(after.prompt?.index, 0);
});

test("ordinary history prepend retains existing turn keys and updates user anchor indices", () => {
  const before = conversationTurns([prompt, progress, final], false)[0]!;
  const after = conversationTurns([message("old-user", "user", [text("Old prompt")]), message("old-answer", "assistant", [text("Old answer")]), prompt, progress, final], false)[1]!;
  assert.equal(before.key, after.key);
  assert.equal(after.prompt?.index, 2);
});

test("custom notices stay outside the folded process on either side of the reply", () => {
  const before = message("notice-1", "custom", [text("Important notice")]);
  const after = message("notice-2", "custom", [text("Post-task notice")]);
  const [turn] = conversationTurns([prompt, progress, before, final, after], false);
  assert.deepEqual(turn?.process.map((entry) => entry.key), ["progress-1"]);
  assert.deepEqual(turn?.noticesBefore.map((entry) => entry.key), ["notice-1"]);
  assert.deepEqual(turn?.noticesAfter.map((entry) => entry.key), ["notice-2"]);
});

test("no-final turns never fold even when streaming has stopped", () => {
  for (const tail of [progress, message("thinking-only", "assistant", [thinking]), message("duration-only", "assistant", [text("✻ Turn took 12s")]), message("blank", "assistant", [text("  ")])]) {
    const [turn] = conversationTurns([prompt, message("commentary", "assistant", [text("I will check")]), tail], false);
    assert.equal(turn?.reply, undefined);
    assert.equal(turn?.collapsible, false);
  }
});

test("pending tools, failed tools and assistant errors do not auto-fold", () => {
  const pending: UIContentBlock = { ...tool, result: undefined };
  const failed: UIContentBlock = { ...tool, result: { text: "failure", isError: true } };
  for (const blocked of [message("pending", "assistant", [pending]), message("failed", "assistant", [failed]), { ...progress, errorMessage: "Agent failed" }]) {
    const [turn] = conversationTurns([prompt, blocked, final], false);
    assert.equal(turn?.collapsible, false);
    assert.equal(turn?.reply?.key, "final-1");
  }
  assert.equal(conversationTurns([prompt, progress, { ...final, errorMessage: "Aborted" }], false)[0]?.reply, undefined);
});

test("custom-only pages and consecutive prompts have safe group identities", () => {
  assert.equal(conversationTurns([message("notice", "custom", [text("Notice")])], false)[0]?.key, "turn:notice");
  assert.equal(conversationTurns([prompt, message("user-2", "user", [text("Second")])], false).length, 2);
});
