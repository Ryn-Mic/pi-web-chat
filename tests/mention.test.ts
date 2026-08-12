import assert from "node:assert/strict";
import { test } from "node:test";
import { extractMentionQuery, replaceMentionToken } from "../src/lib/mention.ts";

test("extractMentionQuery: @ at text start with empty query", () => {
  assert.deepEqual(extractMentionQuery("@", 1), { start: 0, query: "" });
});

test("extractMentionQuery: query is the fragment between @ and caret", () => {
  assert.deepEqual(extractMentionQuery("@cha", 4), { start: 0, query: "cha" });
  assert.deepEqual(extractMentionQuery("look at @src/com", 16), { start: 8, query: "src/com" });
});

test("extractMentionQuery: caret before token end uses prefix up to caret", () => {
  // caret right after @ inside "@chat" (caret = 2)
  assert.deepEqual(extractMentionQuery("@chat", 2), { start: 0, query: "c" });
});

test("extractMentionQuery: email-like text does not trigger", () => {
  assert.equal(extractMentionQuery("a@b", 3), null);
  assert.equal(extractMentionQuery("mail a@b.com", 12), null);
});

test("extractMentionQuery: caret past the token (after whitespace) does not trigger", () => {
  assert.equal(extractMentionQuery("@foo bar", 8), null);
  assert.equal(extractMentionQuery("@foo ", 5), null);
});

test("replaceMentionToken: splices insert over [start, caret) and reports new caret", () => {
  // caret covers the token plus its trailing space, so the trailing space of the
  // inserted mention does not double up with the existing one
  const { next, caret } = replaceMentionToken("see @cha please", 4, 9, "@src/chat.ts ");
  assert.equal(next, "see @src/chat.ts please");
  assert.equal(caret, 4 + "@src/chat.ts ".length);
});
