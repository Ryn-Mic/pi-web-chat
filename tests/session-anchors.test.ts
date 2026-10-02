import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createCodexUserMessageAnchors,
  createSessionAnchorCache,
  createSessionUserMessageAnchors,
  sessionFileStamp,
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

/**
 * The anchor index is cached by file stamp: a hit must skip both the branch walk
 * and the `SessionManager.open` parse, and any file change must rebuild.
 */
test("sessionFileStamp distinguishes appended content and missing files", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-anchors-"));
  try {
    const file = join(dir, "session.jsonl");
    writeFileSync(file, "{}\n");
    const first = sessionFileStamp(file);
    appendFileSync(file, "{}\n");
    assert.notEqual(first, sessionFileStamp(file));
    assert.equal(sessionFileStamp(join(dir, "absent.jsonl")), "missing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createSessionAnchorCache rebuilds only when the session file changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-anchors-cache-"));
  try {
    const file = join(dir, "session.jsonl");
    writeFileSync(file, "{}\n");
    const cache = createSessionAnchorCache();
    let builds = 0;
    const build = () => {
      builds += 1;
      return createSessionUserMessageAnchors([
        { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: `Question ${builds}` }] } },
      ]);
    };

    const first = await cache.read(file, build);
    const cached = await cache.read(file, build);
    assert.equal(builds, 1);
    assert.equal(cached, first, "a cache hit returns the same array instance");

    appendFileSync(file, "{}\n");
    const rebuilt = await cache.read(file, build);
    assert.equal(builds, 2);
    assert.notEqual(rebuilt, first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createSessionAnchorCache bounds its entries", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-anchors-lru-"));
  try {
    const cache = createSessionAnchorCache(2);
    const build = () => createSessionUserMessageAnchors([
      { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "Question" }] } },
    ]);
    for (const name of ["a", "b", "c"]) {
      const file = join(dir, `${name}.jsonl`);
      writeFileSync(file, "{}\n");
      await cache.read(file, build);
    }
    assert.equal(cache.size(), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
