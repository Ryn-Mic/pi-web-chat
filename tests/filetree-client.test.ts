import assert from "node:assert/strict";
import { test } from "node:test";
import {
  onRequestOpenFilesDrawer,
  requestOpenFilesDrawer,
} from "../src/lib/drawer.ts";
import {
  currentFileSearchMatches,
  parseExpanded,
  revealExpandedPath,
  toggleExpandedPath,
} from "../src/lib/filetree.ts";

test("toggleExpandedPath: expands then collapses a dir within a cwd", () => {
  let state: Record<string, string[]> = {};
  state = toggleExpandedPath(state, "/proj", "src");
  assert.deepEqual(state, { "/proj": ["src"] });
  state = toggleExpandedPath(state, "/proj", "src/deep");
  assert.deepEqual(state, { "/proj": ["src", "src/deep"] });
  state = toggleExpandedPath(state, "/proj", "src");
  assert.deepEqual(state, { "/proj": ["src/deep"] });
});

test("toggleExpandedPath: expansion state is isolated per cwd", () => {
  let state = toggleExpandedPath({}, "/a", "src");
  state = toggleExpandedPath(state, "/b", "lib");
  assert.deepEqual(state, { "/a": ["src"], "/b": ["lib"] });
  // toggling /a must not touch /b
  state = toggleExpandedPath(state, "/a", "src");
  assert.deepEqual(state, { "/a": [], "/b": ["lib"] });
});

test("revealExpandedPath: expands a matched directory and every ancestor", () => {
  const original = { "/proj": ["docs"], "/other": ["keep"] };
  const state = revealExpandedPath(original, "/proj", "src/components/deep");
  assert.deepEqual(state, {
    "/proj": ["docs", "src", "src/components", "src/components/deep"],
    "/other": ["keep"],
  });
  assert.deepEqual(original, { "/proj": ["docs"], "/other": ["keep"] });
  assert.equal(revealExpandedPath(state, "/proj", "src/components/deep"), state);
});

test("currentFileSearchMatches: distinguishes stale, pending, and resolved-empty results", () => {
  const response = {
    root: "/proj",
    query: "tree",
    matches: [
      { name: "tree", path: "src/tree", type: "dir" as const },
      { name: "tree.ts", path: "src/tree.ts", type: "file" as const },
    ],
  };
  assert.equal(currentFileSearchMatches(response, "other"), undefined);
  assert.equal(currentFileSearchMatches(response, "   "), undefined);
  assert.deepEqual(currentFileSearchMatches(response, " tree "), response.matches);
  assert.deepEqual(
    currentFileSearchMatches({ ...response, matches: [] }, "tree"),
    [],
  );
});

test("parseExpanded: valid JSON round-trips", () => {
  assert.deepEqual(parseExpanded(JSON.stringify({ "/a": ["src", "src/x"] })), {
    "/a": ["src", "src/x"],
  });
});

test("parseExpanded: null, malformed, and wrong-shaped values degrade to {}", () => {
  assert.deepEqual(parseExpanded(null), {});
  assert.deepEqual(parseExpanded(""), {});
  assert.deepEqual(parseExpanded("not json"), {});
  assert.deepEqual(parseExpanded("[]"), {});
  assert.deepEqual(parseExpanded('"str"'), {});
  assert.deepEqual(parseExpanded('{"a": "not-array"}'), {});
});

test("files drawer bus: request fires subscribed listeners, cleanup removes them", () => {
  const calls: string[] = [];
  const offA = onRequestOpenFilesDrawer(() => calls.push("a"));
  const offB = onRequestOpenFilesDrawer(() => calls.push("b"));
  requestOpenFilesDrawer();
  assert.deepEqual(calls, ["a", "b"]);
  offA();
  requestOpenFilesDrawer();
  assert.deepEqual(calls, ["a", "b", "b"]);
  offB();
  requestOpenFilesDrawer();
  assert.deepEqual(calls, ["a", "b", "b"]);
});
