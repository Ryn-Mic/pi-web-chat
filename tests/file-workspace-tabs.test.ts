import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nextWorkspaceFocusAfterClose,
  nextWorkspaceTabId,
  shouldCloseWorkspaceTab,
} from "../src/lib/file-workspace-tabs.ts";

const ids = ["files", "one", "two", "three"];

test("nextWorkspaceTabId wraps ArrowLeft and ArrowRight", () => {
  assert.equal(nextWorkspaceTabId(ids, "files", "ArrowLeft"), "three");
  assert.equal(nextWorkspaceTabId(ids, "three", "ArrowRight"), "files");
  assert.equal(nextWorkspaceTabId(ids, "one", "ArrowLeft"), "files");
  assert.equal(nextWorkspaceTabId(ids, "two", "ArrowRight"), "three");
});

test("nextWorkspaceTabId moves to Home and End", () => {
  assert.equal(nextWorkspaceTabId(ids, "two", "Home"), "files");
  assert.equal(nextWorkspaceTabId(ids, "one", "End"), "three");
});

test("nextWorkspaceTabId leaves an unknown current id unchanged", () => {
  assert.equal(nextWorkspaceTabId(ids, "missing", "ArrowRight"), "missing");
  assert.equal(nextWorkspaceTabId([], "files", "Home"), "files");
});

test("only preview tabs can be closed with Delete or Backspace", () => {
  assert.equal(shouldCloseWorkspaceTab("Delete"), true);
  assert.equal(shouldCloseWorkspaceTab("Backspace"), true);
  assert.equal(shouldCloseWorkspaceTab("ArrowLeft"), false);
});

test("nextWorkspaceFocusAfterClose follows preview reducer activation rules", () => {
  assert.equal(nextWorkspaceFocusAfterClose(ids, "one", "one"), "two");
  assert.equal(nextWorkspaceFocusAfterClose(ids, "two", "two"), "one");
  assert.equal(nextWorkspaceFocusAfterClose(["files", "one"], "one", "one"), "files");
  assert.equal(nextWorkspaceFocusAfterClose(ids, "three", "one"), "three");
});

test("Git fixed tab does not change preview close focus", () => {
  const withGit = ["files", "git", "one", "two"];
  assert.equal(nextWorkspaceFocusAfterClose(withGit, "one", "one"), "two");
  assert.equal(nextWorkspaceFocusAfterClose(withGit, "two", "two"), "one");
});
