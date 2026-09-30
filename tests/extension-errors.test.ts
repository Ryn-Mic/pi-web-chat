import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createExtensionErrorReporter,
  describeExtensionError,
  extensionNameFromPath,
  type ExtensionErrorLike,
} from "../server/extension-errors.ts";

const failure: ExtensionErrorLike = {
  extensionPath: "/home/u/.pi/agent/extensions/goal-mode.ts",
  event: "before_agent_start",
  error: "Cannot convert undefined or null to object",
  stack: "TypeError: Cannot convert undefined or null to object\n    at goal-mode.ts:232:40",
};

test("names an extension from its entry file, including directory index entries", () => {
  assert.equal(extensionNameFromPath("/home/u/.pi/agent/extensions/goal-mode.ts"), "goal-mode");
  assert.equal(extensionNameFromPath("/home/u/.pi/agent/extensions/pi-cua-driver/index.ts"), "pi-cua-driver");
  assert.equal(extensionNameFromPath("/home/u/.pi/agent/npm/node_modules/pi-zentui/extensions/zentui/index.js"), "zentui");
  assert.equal(extensionNameFromPath("/home/u/.pi/agent/npm/node_modules/pi-claude-code-ui/extensions/index.ts"), "pi-claude-code-ui");
});

test("describes the failing extension, hook, message and file", () => {
  assert.equal(
    describeExtensionError(failure, { home: "/home/u" }),
    "Extension error [goal-mode · before_agent_start]: Cannot convert undefined or null to object (~/.pi/agent/extensions/goal-mode.ts)",
  );
  // Without a home prefix the path stays absolute so it can still be opened.
  assert.ok(
    describeExtensionError(failure).endsWith("(/home/u/.pi/agent/extensions/goal-mode.ts)"),
  );
});

test("logs the first failure with its stack and collapses hot repeats", () => {
  const lines: string[] = [];
  const report = createExtensionErrorReporter({ log: (line) => lines.push(line), repeatEvery: 3 });

  assert.deepEqual(report(failure), { first: true, count: 1 });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^pi-web-chat extension error: Extension error \[goal-mode · before_agent_start\]/);
  assert.ok(lines[0]!.includes("at goal-mode.ts:232:40"), "the first report carries the stack");

  assert.deepEqual(report(failure), { first: false, count: 2 });
  assert.equal(lines.length, 1, "a repeat must not log again");
  assert.deepEqual(report(failure), { first: false, count: 3 });
  assert.equal(lines.length, 2);
  assert.match(lines[1]!, /^pi-web-chat extension error \(x3\): /);

  // A different failure is its own first occurrence.
  const other: ExtensionErrorLike = {
    extensionPath: "/home/u/.pi/agent/extensions/pi-cua-driver/index.ts",
    event: "tool_call",
    error: "nope",
  };
  assert.deepEqual(report(other), { first: true, count: 1 });
  assert.equal(lines.length, 3);
  assert.match(lines[2]!, /\[pi-cua-driver · tool_call\]/);
});
