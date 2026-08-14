import assert from "node:assert/strict";
import { test } from "node:test";
import { sameToolCallBlock, sameToolResult, type ToolCallBlock } from "../src/lib/toolCall.ts";

function block(overrides: Partial<ToolCallBlock> = {}): ToolCallBlock {
  return {
    type: "toolCall",
    id: "call-1",
    name: "bash",
    args: { command: "ls" },
    ...overrides,
  } as ToolCallBlock;
}

test("sameToolResult: identical references and undefined pairs", () => {
  const result = { text: "ok", isError: false };
  assert.equal(sameToolResult(result, result), true);
  assert.equal(sameToolResult(undefined, undefined), true);
  assert.equal(sameToolResult(result, undefined), false);
  assert.equal(sameToolResult(undefined, result), false);
});

test("sameToolResult: rebuilt result objects with equal fields are equal", () => {
  assert.equal(
    sameToolResult({ text: "ok", isError: false }, { text: "ok", isError: false }),
    true,
  );
  assert.equal(
    sameToolResult({ text: "ok", isError: false }, { text: "changed", isError: false }),
    false,
  );
  assert.equal(
    sameToolResult({ text: "ok", isError: false }, { text: "ok", isError: true }),
    false,
  );
  assert.equal(
    sameToolResult({ text: "", isError: false, diff: "@@ -1 +1 @@" }, { text: "", isError: false }),
    false,
  );
});

test("sameToolResult: todo task lists compare by value, not reference", () => {
  const a = {
    text: "",
    isError: false,
    tasks: [
      { id: 1, subject: "one", status: "completed" as const },
      { id: 2, subject: "two", status: "in_progress" as const, activeForm: "doing two" },
    ],
  };
  const rebuilt = {
    text: "",
    isError: false,
    tasks: [
      { id: 1, subject: "one", status: "completed" as const },
      { id: 2, subject: "two", status: "in_progress" as const, activeForm: "doing two" },
    ],
  };
  assert.notEqual(a.tasks, rebuilt.tasks);
  assert.equal(sameToolResult(a, rebuilt), true);

  const statusChanged = {
    ...rebuilt,
    tasks: [rebuilt.tasks[0]!, { ...rebuilt.tasks[1]!, status: "completed" as const }],
  };
  assert.equal(sameToolResult(a, statusChanged), false);

  const activeFormChanged = {
    ...rebuilt,
    tasks: [rebuilt.tasks[0]!, { ...rebuilt.tasks[1]!, activeForm: "doing something else" }],
  };
  assert.equal(sameToolResult(a, activeFormChanged), false);

  const shorter = { ...rebuilt, tasks: [rebuilt.tasks[0]!] };
  assert.equal(sameToolResult(a, shorter), false);
});

test("sameToolCallBlock: rebuilt wrappers sharing the agent's args object are equal", () => {
  const args = { command: "ls" };
  assert.equal(sameToolCallBlock(block({ args }), block({ args })), true);
});

test("sameToolCallBlock: a cloned args object counts as a change", () => {
  // serialize.ts passes the agent's `arguments` reference straight through, so a
  // differing reference means the underlying call really changed.
  assert.equal(
    sameToolCallBlock(block({ args: { command: "ls" } }), block({ args: { command: "ls" } })),
    false,
  );
});

test("sameToolCallBlock: id, name and result arrival invalidate the memo", () => {
  const args = { command: "ls" };
  assert.equal(sameToolCallBlock(block({ args }), block({ args, id: "call-2" })), false);
  assert.equal(sameToolCallBlock(block({ args }), block({ args, name: "read" })), false);
  assert.equal(
    sameToolCallBlock(block({ args }), block({ args, result: { text: "done", isError: false } })),
    false,
  );
});
