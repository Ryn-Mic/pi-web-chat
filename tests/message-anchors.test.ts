import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "../shared/protocol.ts";
import {
  computeVisibleTicks,
  firstLoadedUserOrdinal,
  messageIndexForUserOrdinal,
  viewportUserOrdinal,
} from "../src/lib/message-anchors.ts";

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

test("derives the global ordinal of the first loaded user message", () => {
  assert.equal(firstLoadedUserOrdinal(4, 4), 1);
  assert.equal(firstLoadedUserOrdinal(45, 6), 40);
  assert.equal(firstLoadedUserOrdinal(0, 0), 1);
  // Never below 1 even when the caller still carries a placeholder total.
  assert.equal(firstLoadedUserOrdinal(3, 5), 1);
});

test("viewportUserOrdinal anchors to the last prompt that reached the top edge", () => {
  // A prompt pinned to the top by scrollIntoView({ block: "start" }) is itself,
  // not the following prompt that happens to sit near the middle of the screen.
  assert.equal(
    viewportUserOrdinal([{ ordinal: 4, top: -167 }, { ordinal: 5, top: 16 }, { ordinal: 6, top: 198 }]),
    5,
  );

  // Prompts below the fold never win, so an answer in progress keeps its own prompt.
  assert.equal(
    viewportUserOrdinal([{ ordinal: 1, top: -720 }, { ordinal: 2, top: -140 }, { ordinal: 3, top: 380 }]),
    2,
  );

  // Still at the very top of the transcript.
  assert.equal(viewportUserOrdinal([{ ordinal: 1, top: 16 }, { ordinal: 2, top: 300 }]), 1);

  // Nothing has reached the top edge yet.
  assert.equal(viewportUserOrdinal([{ ordinal: 1, top: 120 }]), null);
  assert.equal(viewportUserOrdinal([]), null);

  // Unmeasurable (collapsed) entries are ignored rather than treated as topmost.
  assert.equal(
    viewportUserOrdinal([{ ordinal: 9, top: Number.NaN }, { ordinal: 3, top: -40 }]),
    3,
  );
});
