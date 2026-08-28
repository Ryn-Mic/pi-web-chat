import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionSummaryIndex } from "../server/session-index.ts";

function sessionFile(root: string, id: string): string {
  const project = join(root, "project-a");
  mkdirSync(project, { recursive: true });
  return join(project, `2025-01-01_${id}.jsonl`);
}

function line(entry: unknown): string {
  return JSON.stringify(entry) + "\n";
}

const header = (id: string, cwd = "/workspace/project-a") => ({
  type: "session",
  version: 3,
  id,
  timestamp: "2025-01-01T00:00:00.000Z",
  cwd,
});
const message = (id: string, parentId: string | null, role: string, text: string, timestamp: string) => ({
  type: "message",
  id,
  parentId,
  timestamp,
  message: { role, content: [{ type: "text", text }], timestamp: new Date(timestamp).getTime() },
});

test("indexes session summaries and reuses unchanged cached objects", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-index-"));
  const file = sessionFile(root, "id-a");
  writeFileSync(
    file,
    line(header("id-a")) +
      line(message("u1", null, "user", "hello", "2025-01-01T00:01:00.000Z")) +
      line(message("a1", "u1", "assistant", "hi", "2025-01-01T00:02:00.000Z")),
  );
  try {
    const index = new SessionSummaryIndex(root);
    const first = await index.list();
    assert.equal(first.length, 1);
    assert.equal(first[0]?.id, "id-a");
    assert.equal(first[0]?.project, "/workspace/project-a");
    assert.equal(first[0]?.firstMessage, "hello");
    assert.equal(first[0]?.messageCount, 2);
    assert.equal(await index.resolve("id-a"), file);

    const second = await index.list();
    assert.equal(second[0], first[0], "unchanged stat should return the cached summary object");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identifies Codex sessions from persisted adapter metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-index-"));
  const file = sessionFile(root, "codex-a");
  writeFileSync(
    file,
    line(header("codex-a")) +
      line({ type: "custom", customType: "pi-web-chat.codex", data: { threadId: "thread-1" } }) +
      line(message("u1", null, "user", "hello Codex", "2025-01-01T00:01:00.000Z")),
  );
  try {
    const index = new SessionSummaryIndex(root);
    const sessions = await index.list();
    assert.equal(sessions[0]?.agent, "codex");
    assert.equal(sessions[0]?.codexThreadId, "thread-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads only an append into the existing summary state", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-index-"));
  const file = sessionFile(root, "id-a");
  writeFileSync(file, line(header("id-a")) + line(message("u1", null, "user", "first", "2025-01-01T00:01:00.000Z")));
  try {
    const index = new SessionSummaryIndex(root);
    const before = await index.list();
    appendFileSync(file, line({ type: "session_info", id: "n1", parentId: "u1", name: "Renamed" }));
    appendFileSync(file, line(message("a1", "n1", "assistant", "answer", "2025-01-01T00:03:00.000Z")));

    const after = await index.list();
    assert.equal(after[0]?.messageCount, 2);
    assert.equal(after[0]?.firstMessage, "first");
    assert.equal(after[0]?.name, "Renamed");
    assert.notEqual(after[0], before[0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rebuilds after truncation and drops deleted files", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-index-"));
  const file = sessionFile(root, "id-a");
  writeFileSync(file, line(header("id-a")) + line(message("u1", null, "user", "old", "2025-01-01T00:01:00.000Z")));
  try {
    const index = new SessionSummaryIndex(root);
    assert.equal((await index.list())[0]?.messageCount, 1);

    writeFileSync(file, line(header("id-a", "/new-workspace")));
    const rebuilt = await index.list();
    assert.equal(rebuilt[0]?.messageCount, 0);
    assert.equal(rebuilt[0]?.project, "/new-workspace");

    rmSync(file);
    assert.deepEqual(await index.list(), []);
    assert.equal(await index.resolve("id-a"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains a UTF-8 code point split across appends", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-index-"));
  const file = sessionFile(root, "id-a");
  const complete = Buffer.from(
    line(message("u1", null, "user", "中文消息", "2025-01-01T00:01:00.000Z")),
  );
  const chinese = Buffer.from("中");
  const split = complete.indexOf(chinese) + 1;
  assert.ok(split > 0);
  writeFileSync(file, Buffer.concat([Buffer.from(line(header("id-a"))), complete.subarray(0, split)]));
  try {
    const index = new SessionSummaryIndex(root);
    assert.equal((await index.list())[0]?.messageCount, 0);

    appendFileSync(file, complete.subarray(split));
    const after = await index.list();
    assert.equal(after[0]?.messageCount, 1);
    assert.equal(after[0]?.firstMessage, "中文消息");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("retains a torn tail until a later append completes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-index-"));
  const file = sessionFile(root, "id-a");
  const complete = line(message("u1", null, "user", "completed later", "2025-01-01T00:01:00.000Z"));
  const split = Math.floor(complete.length / 2);
  writeFileSync(file, line(header("id-a")) + complete.slice(0, split));
  try {
    const index = new SessionSummaryIndex(root);
    assert.equal((await index.list())[0]?.messageCount, 0);

    appendFileSync(file, complete.slice(split));
    const after = await index.list();
    assert.equal(after[0]?.messageCount, 1);
    assert.equal(after[0]?.firstMessage, "completed later");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
