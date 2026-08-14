import assert from "node:assert/strict";
import { test } from "node:test";
import type { SequencedServerEvent } from "../server/event-replay.ts";
import { selectReplayEvents } from "../server/event-replay.ts";

const delta = (seq: number): SequencedServerEvent => ({
  type: "delta",
  seq,
  kind: "text",
  delta: String(seq),
});

test("selects the contiguous suffix after a reconnect baseline", () => {
  const retained = [delta(4), delta(5), delta(6)];
  assert.deepEqual(selectReplayEvents(retained, 6, 3), retained);
  assert.deepEqual(selectReplayEvents(retained, 6, 5), [retained[2]]);
  assert.deepEqual(selectReplayEvents(retained, 6, 6), []);
});

test("requires a full snapshot for expired, future, or invalid baselines", () => {
  const retained = [delta(4), delta(5), delta(6)];
  assert.equal(selectReplayEvents(retained, 6, 2), null);
  assert.equal(selectReplayEvents(retained, 6, 7), null);
  assert.equal(selectReplayEvents(retained, 6, -1), null);
  assert.equal(selectReplayEvents(retained, 6, 1.5), null);
});

test("rejects an internally gapped replay window", () => {
  assert.equal(selectReplayEvents([delta(4), delta(6)], 6, 3), null);
  assert.equal(selectReplayEvents([delta(4), delta(5)], 6, 3), null);
});
