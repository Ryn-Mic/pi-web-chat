import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { listDir, resolvePreviewFile, searchFiles } from "../server/files.ts";
import { saveTextFile } from "../server/file-text.ts";
import { defaultChatWorkspace } from "../server/private-paths.ts";

test("private state is blocked through known parent roots, aliases and writes; workspace stays public", async () => {
  const root = mkdtempSync(join(tmpdir(), "private-path-review-"));
  const previous = { node: process.env.NODE_ENV, state: process.env.PI_WEB_TEST_STATE_DIR };
  process.env.NODE_ENV = "test"; process.env.PI_WEB_TEST_STATE_DIR = join(root, "state");
  const state = process.env.PI_WEB_TEST_STATE_DIR;
  const workspace = defaultChatWorkspace(); mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "notes.txt"), "public workspace\n");
  for (const name of ["token", "2fa.secret", "sessions.json"]) writeFileSync(join(state, name), "private fixture\n", { mode: 0o600 });
  try {
    for (const path of ["state/token", "state/2fa.secret", "state/sessions.json"]) {
      assert.throws(() => resolvePreviewFile(root, path), { code: "EACCES" });
      await assert.rejects(saveTextFile(root, path, "replacement", "0".repeat(64)), { code: "EACCES" });
    }
    assert.throws(() => listDir(state, ""), { code: "EACCES" });
    assert.throws(() => searchFiles(state, "token"), { code: "EACCES" });
    assert.equal(listDir(root, "").nodes.some((entry) => entry.name === "state"), false);
    assert.equal(searchFiles(root, "2fa").matches.length, 0);
    symlinkSync(join(state, "token"), join(root, "symlink.txt"));
    linkSync(join(state, "token"), join(root, "hardlink.txt"));
    for (const path of ["symlink.txt", "hardlink.txt"]) assert.throws(() => resolvePreviewFile(root, path), { code: "EACCES" });
    assert.equal(resolvePreviewFile(workspace, "notes.txt").name, "notes.txt");
    chmodSync(join(state, "token"), 0o600);
    assert.equal(readFileSync(join(state, "token"), "utf8"), "private fixture\n");
  } finally {
    if (previous.node === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.node;
    if (previous.state === undefined) delete process.env.PI_WEB_TEST_STATE_DIR; else process.env.PI_WEB_TEST_STATE_DIR = previous.state;
    rmSync(root, { recursive: true, force: true });
  }
});
