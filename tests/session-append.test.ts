import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AppendedJsonlDecoder,
  applyExternalSessionEntries,
  parseAppendedJsonl,
} from "../server/session-append.ts";

type Entry = { type: string; id: string; parentId: string | null; message?: unknown };

function fakeSession(initial: Entry[]) {
  const fileEntries = [...initial];
  const byId = new Map(initial.map((entry) => [entry.id, entry]));
  let leaf = initial.at(-1)?.id ?? null;
  const manager = {
    fileEntries,
    getLeafId: () => leaf,
    getEntry: (id: string) => byId.get(id),
    _buildIndex: () => {
      byId.clear();
      for (const entry of fileEntries) byId.set(entry.id, entry);
      leaf = fileEntries.at(-1)?.id ?? null;
    },
    buildSessionContext: () => ({
      messages: fileEntries
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message),
    }),
  };
  const session = { sessionManager: manager, agent: { state: { messages: [] as unknown[] } } };
  return { session, manager };
}

const message = (id: string, parentId: string | null, text: string): Entry => ({
  type: "message",
  id,
  parentId,
  message: { role: "user", content: [{ type: "text", text }] },
});

test("parses complete appended rows and retains a torn tail", () => {
  const first = JSON.stringify(message("m1", null, "one"));
  const second = JSON.stringify(message("m2", "m1", "two"));
  const split = Math.floor(second.length / 2);

  const partial = parseAppendedJsonl("", `${first}\n${second.slice(0, split)}`);
  assert.equal(partial.entries.length, 1);
  assert.notEqual(partial.pending, "");

  const completed = parseAppendedJsonl(partial.pending, `${second.slice(split)}\n`);
  assert.equal(completed.entries.length, 1);
  assert.equal(completed.entries[0]?.id, "m2");
  assert.equal(completed.pending, "");
});

test("decodes a UTF-8 code point split across file appends", () => {
  const decoder = new AppendedJsonlDecoder();
  const row = Buffer.from(`${JSON.stringify(message("m1", null, "中文"))}\n`);
  const marker = Buffer.from("中");
  const split = row.indexOf(marker) + 1;
  assert.ok(split > 0);

  assert.deepEqual(decoder.push(row.subarray(0, split)), []);
  const entries = decoder.push(row.subarray(split));
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.id, "m1");
});

test("applies a contiguous external chain and rebuilds agent messages", () => {
  const { session, manager } = fakeSession([message("m1", null, "one")]);
  const result = applyExternalSessionEntries(session, [
    message("m2", "m1", "two"),
    message("m3", "m2", "three"),
  ]);

  assert.deepEqual(result, { status: "applied", count: 2 });
  assert.equal(manager.getLeafId(), "m3");
  assert.equal(session.agent.state.messages.length, 3);
});

test("ignores entries already appended by the local runtime", () => {
  const local = message("m2", "m1", "two");
  const { session, manager } = fakeSession([message("m1", null, "one"), local]);
  const result = applyExternalSessionEntries(session, [local]);

  assert.deepEqual(result, { status: "noop" });
  assert.equal(manager.fileEntries.length, 2);
});

test("requires reload for a divergent branch or external live setting", () => {
  const { session } = fakeSession([message("m1", null, "one")]);
  assert.equal(
    applyExternalSessionEntries(session, [message("m2", "somewhere-else", "two")]).status,
    "reload",
  );
  assert.equal(
    applyExternalSessionEntries(session, [
      { type: "model_change", id: "model", parentId: "m1" },
    ]).status,
    "reload",
  );
});

test("falls back when SessionManager internals change", () => {
  const session = {
    sessionManager: {
      getLeafId: () => null,
      getEntry: () => undefined,
      buildSessionContext: () => ({ messages: [] }),
    },
    agent: { state: { messages: [] } },
  };
  assert.equal(applyExternalSessionEntries(session, [message("m1", null, "one")]).status, "reload");
});
