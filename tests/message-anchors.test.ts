import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "../shared/protocol.ts";
import { messageIndexForUserOrdinal } from "../src/lib/message-anchors.ts";

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
