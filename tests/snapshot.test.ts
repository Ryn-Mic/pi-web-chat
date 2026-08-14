import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage, UISnapshot } from "../shared/protocol.ts";
import {
  applySnapshotDelta,
  createSnapshotDelta,
  firstChangedMessage,
} from "../shared/snapshot.ts";

function message(text: string): UIMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function snapshot(messages: UIMessage[]): UISnapshot {
  return {
    messages,
    isStreaming: false,
    model: null,
    thinkingLevel: "off",
    thinkingLevels: ["off"],
  };
}

test("snapshot delta sends only an appended suffix", () => {
  const first = message("first");
  const previous = snapshot([first]);
  const next = snapshot([first, message("second")]);

  const delta = createSnapshotDelta(previous, next, 4);
  assert.equal(delta.baseRevision, 4);
  assert.equal(delta.revision, 5);
  assert.equal(delta.from, 1);
  assert.deepEqual(delta.messages, [next.messages[1]]);
  assert.deepEqual(applySnapshotDelta(previous, 4, delta), next);
});

test("snapshot delta replaces a changed tool-call owner and its suffix", () => {
  const first = message("first");
  const pending = message("pending tool");
  const previous = snapshot([first, pending]);
  const settled = message("settled tool");
  const next = snapshot([first, settled, message("after")]);

  assert.equal(firstChangedMessage(previous.messages, next.messages), 1);
  const delta = createSnapshotDelta(previous, next, 9);
  assert.equal(delta.from, 1);
  assert.deepEqual(delta.messages, [settled, next.messages[2]]);
  assert.deepEqual(applySnapshotDelta(previous, 9, delta), next);
});

test("metadata-only updates carry no messages", () => {
  const stable = message("stable");
  const previous = snapshot([stable]);
  const next = { ...previous, isStreaming: true };

  const delta = createSnapshotDelta(previous, next, 0);
  assert.equal(delta.from, 1);
  assert.deepEqual(delta.messages, []);
  assert.deepEqual(applySnapshotDelta(previous, 0, delta), next);
});

test("revision gaps and invalid offsets require a full snapshot", () => {
  const current = snapshot([message("one")]);
  const delta = createSnapshotDelta(current, snapshot([...current.messages, message("two")]), 2);

  assert.equal(applySnapshotDelta(current, 1, delta), null);
  assert.equal(applySnapshotDelta(null, 2, delta), null);
  assert.equal(applySnapshotDelta(current, 2, { ...delta, from: 2 }), null);
  assert.equal(applySnapshotDelta(current, 2, { ...delta, from: -1 }), null);
});

test("truncation is represented by an empty replacement suffix", () => {
  const first = message("first");
  const previous = snapshot([first, message("second")]);
  const next = snapshot([first]);

  const delta = createSnapshotDelta(previous, next, 3);
  assert.equal(delta.from, 1);
  assert.deepEqual(delta.messages, []);
  assert.deepEqual(applySnapshotDelta(previous, 3, delta), next);
});
