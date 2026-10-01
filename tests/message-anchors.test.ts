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
  // Absolute content offsets: prompts start at 0 / 600 / 1200 inside the content.
  const offsets = [
    { ordinal: 1, offset: 0 },
    { ordinal: 2, offset: 600 },
    { ordinal: 3, offset: 1200 },
  ];

  // A prompt pinned to the top by scrollIntoView({ block: "start" }) is itself,
  // not the following prompt that happens to sit near the middle of the screen.
  assert.equal(viewportUserOrdinal(offsets, 584), 2);

  // Prompts below the fold never win, so an answer in progress keeps its own prompt.
  assert.equal(viewportUserOrdinal(offsets, 900), 2);

  // Scrolling until the next prompt reaches the top edge promotes it.
  assert.equal(viewportUserOrdinal(offsets, 1200), 3);
  assert.equal(viewportUserOrdinal(offsets, 5000), 3);

  // Still at the very top of the transcript.
  assert.equal(viewportUserOrdinal([{ ordinal: 1, offset: 16 }, { ordinal: 2, offset: 300 }], 0), 1);

  // Nothing has reached the top edge yet (e.g. only a history loader is above).
  assert.equal(viewportUserOrdinal([{ ordinal: 1, offset: 120 }], 0), null);
  assert.equal(viewportUserOrdinal([], 0), null);

  // Unmeasurable entries are ignored rather than treated as topmost.
  assert.equal(
    viewportUserOrdinal([{ ordinal: 9, offset: Number.NaN }, { ordinal: 3, offset: -40 }], 0),
    3,
  );
  assert.equal(viewportUserOrdinal([{ ordinal: 1, offset: 0 }], Number.NaN), null);
});
