import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "../shared/protocol.ts";
import { computeVisibleTicks, messageIndexForUserOrdinal } from "../src/lib/message-anchors.ts";

const message = (role: UIMessage["role"], text: string): UIMessage => ({
  role,
  content: [{ type: "text", text }],
});

test("maps global user ordinals onto the loaded transcript suffix", () => {
  const loaded = [
    message("user", "third"),
    message("assistant", "answer three"),
    message("custom", "notice"),
    message("user", "fourth"),
    message("assistant", "answer four"),
  ];

  assert.equal(messageIndexForUserOrdinal(loaded, 4, 3), 0);
  assert.equal(messageIndexForUserOrdinal(loaded, 4, 4), 3);
  assert.equal(messageIndexForUserOrdinal(loaded, 4, 2), null);
});

test("rejects stale or invalid anchor ordinals", () => {
  const loaded = [message("user", "only")];
  assert.equal(messageIndexForUserOrdinal(loaded, 1, 0), null);
  assert.equal(messageIndexForUserOrdinal(loaded, 1, 2), null);
  assert.equal(messageIndexForUserOrdinal(loaded, 0, 1), null);
});

test("computeVisibleTicks displays all when total <= 7", () => {
  assert.deepEqual(computeVisibleTicks(0, 1), []);
  assert.deepEqual(computeVisibleTicks(1, 1), [1]);
  assert.deepEqual(computeVisibleTicks(5, 3), [1, 2, 3, 4, 5]);
  assert.deepEqual(computeVisibleTicks(7, 4), [1, 2, 3, 4, 5, 6, 7]);
});

test("computeVisibleTicks dynamically slides centered window when total > 7", () => {
  // Near beginning
  assert.deepEqual(computeVisibleTicks(10, 1), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(computeVisibleTicks(10, 2), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(computeVisibleTicks(10, 3), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(computeVisibleTicks(10, 4), [1, 2, 3, 4, 5, 6, 7]);

  // Center
  assert.deepEqual(computeVisibleTicks(10, 5), [2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(computeVisibleTicks(10, 6), [3, 4, 5, 6, 7, 8, 9]);

  // Near end
  assert.deepEqual(computeVisibleTicks(10, 7), [4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(computeVisibleTicks(10, 8), [4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual(computeVisibleTicks(10, 10), [4, 5, 6, 7, 8, 9, 10]);
});
