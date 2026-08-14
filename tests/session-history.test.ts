import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSessionHistoryPage } from "../server/session-history.ts";

function text(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: Array<{ type?: string; text?: string }> }).content;
  return content?.find((block) => block.type === "text")?.text ?? "";
}

function writeSession(entries: unknown[]): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-history-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return { dir, file };
}

const READ_TEST_SIZE = 256 * 1024;
const header = { type: "session", version: 3, id: "s1", timestamp: "2025-01-01T00:00:00Z", cwd: "/tmp" };
const user = (id: string, parentId: string | null, value: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2025-01-01T00:00:00Z",
  message: { role: "user", content: [{ type: "text", text: value }] },
});
const assistant = (id: string, parentId: string, value: string) => ({
  type: "message",
  id,
  parentId,
  timestamp: "2025-01-01T00:00:00Z",
  message: { role: "assistant", content: [{ type: "text", text: value }] },
});

test("reads active-branch pages from the JSONL tail", () => {
  const { dir, file } = writeSession([
    header,
    user("u1", null, "user one"),
    assistant("a1", "u1", "assistant one"),
    user("u2", "a1", "user two"),
    assistant("a2", "u2", "assistant two"),
  ]);
  try {
    const latest = readSessionHistoryPage(file, { limit: 2 });
    assert.deepEqual(latest.messages.map(text), ["user two", "assistant two"]);
    assert.equal(latest.hasMore, true);
    assert.ok(latest.cursor);

    const older = readSessionHistoryPage(file, { limit: 2, cursor: latest.cursor! });
    assert.deepEqual(older.messages.map(text), ["user one", "assistant one"]);
    assert.equal(older.hasMore, false);
    assert.equal(older.cursor, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("skips entries from an abandoned fork branch", () => {
  const { dir, file } = writeSession([
    header,
    user("u1", null, "root"),
    assistant("a1", "u1", "root answer"),
    assistant("abandoned", "a1", "do not show"),
    user("u2", "a1", "forked user"),
    assistant("a2", "u2", "forked answer"),
  ]);
  try {
    const latest = readSessionHistoryPage(file, { limit: 2 });
    const older = readSessionHistoryPage(file, { limit: 2, cursor: latest.cursor! });
    assert.deepEqual(latest.messages.map(text), ["forked user", "forked answer"]);
    assert.deepEqual(older.messages.map(text), ["root", "root answer"]);
    assert.equal([...latest.messages, ...older.messages].some((message) => text(message) === "do not show"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("starts from an in-memory leaf that is not the physical JSONL tail", () => {
  const { dir, file } = writeSession([
    header,
    user("u1", null, "root"),
    assistant("a1", "u1", "root answer"),
    user("abandoned-user", "a1", "abandoned user"),
    assistant("abandoned-answer", "abandoned-user", "abandoned answer"),
  ]);
  try {
    const page = readSessionHistoryPage(file, { leafId: "a1", limit: 10 });
    assert.deepEqual(page.messages.map(text), ["root", "root answer"]);
    assert.equal(page.hasMore, false);

    const root = readSessionHistoryPage(file, { leafId: null });
    assert.deepEqual(root.messages, []);
    assert.equal(root.hasMore, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps an assistant tool call and result in the same page", () => {
  const toolCall = {
    type: "message",
    id: "a1",
    parentId: "u1",
    timestamp: "2025-01-01T00:00:00Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call1", name: "bash", arguments: { command: "pwd" } }],
    },
  };
  const result = {
    type: "message",
    id: "r1",
    parentId: "a1",
    timestamp: "2025-01-01T00:00:00Z",
    message: { role: "toolResult", toolCallId: "call1", content: "/tmp", isError: false },
  };
  const { dir, file } = writeSession([header, user("u1", null, "run"), toolCall, result]);
  try {
    const page = readSessionHistoryPage(file, { limit: 1 });
    assert.equal(page.messages.length, 2);
    const block = page.messages[1]?.content[0];
    assert.equal(block?.type, "toolCall");
    if (block?.type === "toolCall") assert.equal(block.result?.text, "/tmp");
    assert.equal(page.hasMore, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reads a message row spanning multiple reverse-read chunks", () => {
  const largeText = "x".repeat(READ_TEST_SIZE);
  const { dir, file } = writeSession([
    header,
    user("u1", null, "large"),
    assistant("a1", "u1", largeText),
  ]);
  try {
    const page = readSessionHistoryPage(file, { limit: 2 });
    assert.equal(page.messages.length, 2);
    assert.equal(text(page.messages[1]), largeText);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects malformed or out-of-range cursors", () => {
  const { dir, file } = writeSession([header, user("u1", null, "one")]);
  try {
    assert.throws(() => readSessionHistoryPage(file, { cursor: "not-base64" }), /invalid history cursor/);
    const invalid = Buffer.from(JSON.stringify({ before: 999_999, target: "u1" })).toString("base64url");
    assert.throws(() => readSessionHistoryPage(file, { cursor: invalid }), /invalid history cursor/);

    const missingTarget = Buffer.from(
      JSON.stringify({ before: statSync(file).size, target: "missing" }),
    ).toString("base64url");
    const exhausted = readSessionHistoryPage(file, { cursor: missingTarget });
    assert.deepEqual(exhausted.messages, []);
    assert.equal(exhausted.cursor, null);
    assert.equal(exhausted.hasMore, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
