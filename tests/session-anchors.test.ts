import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createCodexUserMessageAnchors,
  createSessionUserMessageAnchors,
} from "../server/session-anchors.ts";

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

test("builds global Codex anchors across chronological native item pages", async () => {
  const requestedCursors: Array<string | null> = [];
  const anchors = await createCodexUserMessageAnchors(async (cursor) => {
    requestedCursors.push(cursor);
    if (cursor === null) {
      return {
        data: [
          {
            turnId: "turn-1",
            item: {
              type: "userMessage",
              id: "codex-u1",
              content: [{ type: "text", text: "  first\nmessage " }],
            },
          },
          { turnId: "turn-1", item: { type: "agentMessage", id: "codex-a1", text: "answer" } },
        ],
        nextCursor: "older-page-2",
      };
    }
    assert.equal(cursor, "older-page-2");
    return {
      data: [
        {
          turnId: "turn-2",
          item: {
            type: "userMessage",
            id: "codex-u2",
            content: [
              { type: "mention", name: "README.md" },
              { type: "localImage", path: "/tmp/reference.png" },
            ],
          },
        },
        {
          turnId: "turn-3",
          item: { type: "userMessage", id: "empty", content: [] },
        },
        {
          turnId: "turn-3",
          item: {
            type: "userMessage",
            id: "codex-u3",
            content: [{ type: "skill", name: "review" }],
          },
        },
      ],
      nextCursor: null,
    };
  });

  assert.deepEqual(requestedCursors, [null, "older-page-2"]);
  assert.deepEqual(anchors, [
    { id: "codex-u1", ordinal: 1, text: "first message" },
    {
      id: "codex-u2",
      ordinal: 2,
      text: "README.md [Image: /tmp/reference.png]",
    },
    { id: "codex-u3", ordinal: 3, text: "review" },
  ]);
});

test("rejects a repeated Codex item cursor instead of looping forever", async () => {
  await assert.rejects(
    createCodexUserMessageAnchors(async () => ({ data: [], nextCursor: "same" })),
    /repeated cursor/,
  );
});
