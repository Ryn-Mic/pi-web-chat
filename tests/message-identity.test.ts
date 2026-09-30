import assert from "node:assert/strict";
import { test } from "node:test";
import type { UIMessage } from "../shared/protocol.ts";
import { messageKeys } from "../src/lib/message-identity.ts";

const message = (text: string, id?: string): UIMessage => ({ id, role: "assistant", content: [{ type: "text", text }] });

test("message ids preserve component identity across prepends and tool updates", () => {
  const original = [message("answer", "answer-1"), message("answer", "answer-2")];
  const keys = messageKeys(original);
  assert.deepEqual(messageKeys([message("older", "older"), ...original]).slice(1), keys);
  assert.equal(messageKeys([message("updated answer", "answer-1")])[0], keys[0]);
});

test("legacy message keys remain unique and retain newer duplicates after prepend", () => {
  const original = [message("same"), message("different"), message("same")];
  const keys = messageKeys(original);
  assert.equal(new Set(keys).size, original.length);
  assert.deepEqual(messageKeys([message("same"), ...original]).slice(1), keys);
  assert.deepEqual(messageKeys(original.map((item) => structuredClone(item))), keys);
});
