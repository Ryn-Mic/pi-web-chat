import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionUserMessageAnchors } from "../server/session-anchors.ts";

test("builds a lightweight ordered index from active-branch user messages", () => {
  const anchors = createSessionUserMessageAnchors([
    { type: "session", id: "s1" },
    {
      type: "message",
      id: "u1",
      timestamp: "2026-08-14T09:05:07.000Z",
      message: { role: "user", content: [{ type: "text", text: "  first\nmessage  " }] },
    },
    {
      type: "message",
      id: "a1",
      timestamp: "2026-08-14T09:05:08.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
    },
    {
      type: "message",
      id: "u2",
      timestamp: "invalid",
      message: { role: "user", content: "second message" },
    },
  ]);

  assert.deepEqual(anchors, [
    {
      id: "u1",
      ordinal: 1,
      text: "first message",
      timestamp: Date.parse("2026-08-14T09:05:07.000Z"),
    },
    { id: "u2", ordinal: 2, text: "second message", timestamp: undefined },
  ]);
});

test("truncates previews without retaining full message bodies", () => {
  const anchors = createSessionUserMessageAnchors([
    {
      type: "message",
      id: "u1",
      message: { role: "user", content: [{ type: "text", text: "x".repeat(500) }] },
    },
  ]);

  assert.equal(anchors[0]?.text.length, 240);
  assert.equal(anchors[0]?.text.endsWith("…"), true);
});

test("skips user entries that do not render into transcript history", () => {
  const anchors = createSessionUserMessageAnchors([
    {
      type: "message",
      id: "hidden",
      message: { role: "user", content: [] },
    },
    {
      type: "message",
      id: "image",
      message: { role: "user", content: [{ type: "image" }] },
    },
    {
      type: "message",
      id: "text",
      message: { role: "user", content: "" },
    },
  ]);

  assert.deepEqual(
    anchors.map(({ id, ordinal }) => ({ id, ordinal })),
    [
      { id: "image", ordinal: 1 },
      { id: "text", ordinal: 2 },
    ],
  );
});
