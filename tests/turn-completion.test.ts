import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "../shared/protocol.ts";
import {
  formatTurnCompletedAt,
  isAssistantTurnComplete,
  splitAssistantTurnCompletion,
} from "../src/lib/turn-completion.ts";

const message = (role: UIMessage["role"], text: string): UIMessage => ({
  role,
  content: [{ type: "text", text }],
});

test("extracts a terminal Turn took line from assistant content", () => {
  const content: UIMessage["content"] = [
    { type: "thinking", text: "checking" },
    { type: "text", text: "Done.\n\n✻ Turn took 12s (Total time 1m 4s · 2 turns)\n" },
  ];

  const completion = splitAssistantTurnCompletion(content);

  assert.equal(completion?.summary, "✻ Turn took 12s (Total time 1m 4s · 2 turns)");
  assert.deepEqual(completion?.content, [
    { type: "thinking", text: "checking" },
    { type: "text", text: "Done." },
  ]);
  assert.equal(content[1]?.type === "text" ? content[1].text.includes("Turn took") : false, true);
});

test("does not extract Turn took text unless it is the final line", () => {
  const content: UIMessage["content"] = [
    { type: "text", text: "Turn took is a label, not metadata.\nMore text follows." },
  ];
  assert.equal(splitAssistantTurnCompletion(content), null);
});

test("active assistant turn waits for streaming to finish", () => {
  const active = [message("user", "go"), message("assistant", "done")];
  assert.equal(isAssistantTurnComplete(active, 1, true), false);
  assert.equal(isAssistantTurnComplete(active, 1, false), true);
});

test("previous assistant turn stays complete while the next turn streams", () => {
  const messages = [
    message("user", "first"),
    message("assistant", "first answer"),
    message("custom", "notice"),
    message("user", "second"),
    message("assistant", "second answer"),
  ];
  assert.equal(isAssistantTurnComplete(messages, 1, true), true);
  assert.equal(isAssistantTurnComplete(messages, 4, true), false);
});

test("formats today's completion with time only", () => {
  const now = new Date(2026, 7, 14, 15, 30, 0).getTime();
  const completed = new Date(2026, 7, 14, 9, 5, 7).getTime();
  assert.equal(formatTurnCompletedAt(completed, now), "09:05:07");
});

test("formats earlier completion with a short local date and time", () => {
  const now = new Date(2026, 7, 14, 15, 30, 0).getTime();
  const completed = new Date(2026, 6, 3, 9, 5, 7).getTime();
  assert.equal(formatTurnCompletedAt(completed, now), "26/7/3 09:05:07");
});
