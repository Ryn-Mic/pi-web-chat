import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  assertGitRoot,
  checkoutGitBranch,
  getGitBranches,
  getGitCommit,
  getGitLog,
  getGitStatus,
  GitCommandError,
  parseGitStatus,
} from "../server/git.ts";
import { formatGitTimestamp, splitCommitDiffByFile } from "../src/lib/git.ts";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function git(...args: string[]) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" });
}

function fixture() {
  root = mkdtempSync(join(tmpdir(), "pi-git-test-"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Git Test");
  writeFileSync(join(root, "README.md"), "one\n");
  git("add", "README.md");
  git("commit", "-qm", "initial commit");
  git("switch", "-qc", "feature/test");
  writeFileSync(join(root, "README.md"), "two\n");
  writeFileSync(join(root, "untracked.txt"), "new\n");
}

test("parseGitStatus handles branch header and staged, changed, untracked files", () => {
  const status = parseGitStatus("## main...origin/main [ahead 2, behind 1]\0 M changed.ts\0M  staged.ts\0?? new.txt\0", "/repo");
  assert.equal(status.branch, "main");
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 1);
  assert.deepEqual(status.unstaged.map((file) => file.path), ["changed.ts"]);
  assert.deepEqual(status.staged.map((file) => file.path), ["staged.ts"]);
  assert.deepEqual(status.untracked.map((file) => file.path), ["new.txt"]);
});

test("git status, branches, log and commit detail use structured repository data", () => {
  fixture();
  const status = getGitStatus(root);
  assert.equal(status.branch, "feature/test");
  assert.equal(status.isDirty, true);
  assert.deepEqual(status.untracked.map((file) => file.path), ["untracked.txt"]);
  assert.deepEqual(getGitBranches(root).map((branch) => branch.name), ["feature/test", "main"]);
  const log = getGitLog(root);
  assert.equal(log[0]?.subject, "initial commit");
  const detail = getGitCommit(root, log[0]!.hash);
  assert.equal(detail.files[0]?.path, "README.md");
});

test("checkout refuses dirty worktrees and switches clean local branches", () => {
  fixture();
  assert.throws(() => checkoutGitBranch(root, "main"), (error: unknown) => error instanceof GitCommandError && error.code === "invalid");
  rmSync(join(root, "untracked.txt"));
  git("restore", "README.md");
  const status = checkoutGitBranch(root, "main");
  assert.equal(status.branch, "main");
});

test("commit diff splits into file-sized patches and timestamps include seconds", () => {
  const patches = splitCommitDiffByFile("diff --git a/one.txt b/one.txt\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/two.txt b/two.txt\n@@ -1 +1 @@\n-c\n+d");
  assert.equal(patches.length, 2);
  assert.match(patches[0]!, /one\.txt/);
  assert.match(patches[1]!, /two\.txt/);
  assert.match(formatGitTimestamp("2026-08-13T12:34:56+08:00", "en-US"), /12:34:56/);
});

test("git root rejects a non-repository", () => {
  root = mkdtempSync(join(tmpdir(), "pi-not-git-"));
  mkdirSync(join(root, "nested"));
  assert.throws(() => assertGitRoot(join(root, "nested")), (error: unknown) => error instanceof GitCommandError && error.code === "not-repository");
});
