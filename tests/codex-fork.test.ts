import assert from "node:assert/strict";
import { test } from "node:test";
import {
  forkCodexConnection,
  nativeCodexSessionId,
  nativeCodexThreadId,
  type CodexForkEntry,
} from "../server/codex-fork.ts";

type Client = { name: string };
type Entry = CodexForkEntry<Client>;

test("native Codex session ids round-trip through the canonical codex prefix", () => {
  assert.equal(nativeCodexSessionId("thread-123"), "codex:thread-123");
  assert.equal(nativeCodexThreadId("codex:thread-123"), "thread-123");
  assert.equal(nativeCodexThreadId("thread-123"), undefined);
  assert.equal(nativeCodexThreadId("codex:"), undefined);
  assert.throws(() => nativeCodexSessionId("  "), /empty forked thread id/);
});

test("forking Codex moves only the requesting client and installs the new baseline in order", async () => {
  const requester = { name: "requester" };
  const oldPeer = { name: "old-peer" };
  const newPeer = { name: "new-peer" };
  const source: Entry = {
    id: "codex:thread-old",
    clients: new Set([requester, oldPeer]),
    lastActive: 1,
  };
  const target: Entry = {
    id: "codex:thread-new",
    clients: new Set([newPeer]),
    lastActive: 2,
  };
  const bindings = new Map<Client, Entry>([
    [requester, source],
    [oldPeer, source],
    [newPeer, target],
  ]);
  const events: string[] = [];

  const result = await forkCodexConnection({
    client: requester,
    source,
    bindings,
    forkThread: async () => {
      events.push("fork");
      return "thread-new";
    },
    acquireEntry: async (sessionId) => {
      events.push(`acquire:${sessionId}`);
      return target;
    },
    sendSessionBound: (_entry, sessionId) => events.push(`bound:${sessionId}`),
    sendFullSnapshot: () => events.push("snapshot"),
    sendCommandCatalog: () => events.push("catalog"),
    sendForked: () => events.push("forked"),
    now: () => 42,
  });

  assert.equal(result.threadId, "thread-new");
  assert.equal(result.sessionId, "codex:thread-new");
  assert.equal(result.entry, target);
  assert.deepEqual([...source.clients], [oldPeer]);
  assert.deepEqual([...target.clients], [newPeer, requester]);
  assert.equal(bindings.get(requester), target);
  assert.equal(bindings.get(oldPeer), source);
  assert.equal(source.lastActive, 42);
  assert.equal(target.lastActive, 42);
  assert.deepEqual(events, [
    "fork",
    "acquire:codex:thread-new",
    "bound:codex:thread-new",
    "snapshot",
    "catalog",
    "forked",
  ]);
});

test("a malformed fork target leaves the requesting client on the source entry", async () => {
  const requester = { name: "requester" };
  const source: Entry = {
    id: "codex:thread-old",
    clients: new Set([requester]),
    lastActive: 1,
  };
  const wrongTarget: Entry = {
    id: "codex:unexpected",
    clients: new Set(),
    lastActive: 2,
  };
  const bindings = new Map<Client, Entry>([[requester, source]]);

  await assert.rejects(
    forkCodexConnection({
      client: requester,
      source,
      bindings,
      forkThread: async () => "thread-new",
      acquireEntry: async () => wrongTarget,
      sendSessionBound: () => assert.fail("must not bind a malformed target"),
      sendFullSnapshot: () => assert.fail("must not send a malformed target"),
      sendCommandCatalog: () => assert.fail("must not send a malformed target"),
      sendForked: () => assert.fail("must not acknowledge a malformed target"),
    }),
    /unexpected session id/,
  );

  assert.deepEqual([...source.clients], [requester]);
  assert.equal(wrongTarget.clients.size, 0);
  assert.equal(bindings.get(requester), source);
});

test("a client that disconnects during native hydration is never rebound", async () => {
  const requester = { name: "requester" };
  const source: Entry = {
    id: "codex:thread-old",
    clients: new Set([requester]),
    lastActive: 1,
  };
  const target: Entry = {
    id: "codex:thread-new",
    clients: new Set(),
    lastActive: 2,
  };
  const bindings = new Map<Client, Entry>();

  await assert.rejects(
    forkCodexConnection({
      client: requester,
      source,
      bindings,
      forkThread: async () => "thread-new",
      acquireEntry: async () => target,
      canMoveClient: () => false,
      sendSessionBound: () => assert.fail("must not bind a disconnected client"),
      sendFullSnapshot: () => assert.fail("must not send to a disconnected client"),
      sendCommandCatalog: () => assert.fail("must not send to a disconnected client"),
      sendForked: () => assert.fail("must not acknowledge a disconnected client"),
    }),
    /disconnected before the Codex fork completed/,
  );

  assert.deepEqual([...source.clients], [requester]);
  assert.equal(target.clients.size, 0);
  assert.equal(bindings.has(requester), false);
});
