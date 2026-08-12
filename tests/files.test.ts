import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { listDir, PathEscapeError } from "../server/files.ts";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function fixture() {
  root = mkdtempSync(join(tmpdir(), "pi-files-test-"));
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true });
  mkdirSync(join(root, "dist"), { recursive: true });
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(root, "empty"), { recursive: true });
  writeFileSync(join(root, "node_modules", "dep", "x.js"), "");
  writeFileSync(join(root, "dist", "bundle.js"), "");
  writeFileSync(join(root, "src", "b.ts"), "");
  writeFileSync(join(root, "src", "a.ts"), "");
  writeFileSync(join(root, "src", "deep", "c.ts"), "");
  writeFileSync(join(root, "README.md"), "");
  writeFileSync(join(root, ".env"), "");
  writeFileSync(join(root, "secret.txt"), "");
  writeFileSync(join(root, ".gitignore"), "dist/\nsecret.txt\n");
  symlinkSync(join(root, "src"), join(root, "linkdir"));
}

test("listDir: dirs first, case-insensitive sort, hard excludes + root .gitignore applied", () => {
  fixture();
  const { nodes, truncated } = listDir(root, "");
  assert.equal(truncated, false);
  const names = nodes.map((n) => n.name);
  // hard excludes + gitignore hits are absent
  for (const excluded of [".git", "node_modules", "dist", "secret.txt"]) {
    assert.ok(!names.includes(excluded), `${excluded} must be excluded`);
  }
  // dirs first
  assert.equal(nodes[0]!.type, "dir");
  const dirNames = nodes.filter((n) => n.type === "dir").map((n) => n.name);
  const fileNames = nodes.filter((n) => n.type === "file").map((n) => n.name);
  assert.deepEqual(dirNames, ["empty", "src"]);
  // dotfiles shown; symlinked dir appears as a file; case-insensitive alpha
  assert.deepEqual(fileNames, [".env", ".gitignore", "linkdir", "README.md"]);
});

test("listDir: hasChildren reflects filtered content", () => {
  fixture();
  const { nodes } = listDir(root, "");
  const src = nodes.find((n) => n.name === "src");
  const empty = nodes.find((n) => n.name === "empty");
  assert.equal(src?.hasChildren, true);
  assert.equal(empty?.hasChildren, false);
});

test("listDir: nested listing uses relative paths", () => {
  fixture();
  const { nodes } = listDir(root, "src");
  assert.deepEqual(
    nodes.map((n) => `${n.type}:${n.path}`),
    ["dir:src/deep", "file:src/a.ts", "file:src/b.ts"],
  );
});

test("listDir: path escape and absolute rel are rejected", () => {
  fixture();
  assert.throws(() => listDir(root, "../outside"), PathEscapeError);
  assert.throws(() => listDir(root, "/etc"), PathEscapeError);
});

test("listDir: truncates at 1000 entries", () => {
  fixture();
  const big = join(root, "big");
  mkdirSync(big);
  for (let i = 0; i < 1005; i++) writeFileSync(join(big, `f${String(i).padStart(4, "0")}.txt`), "");
  const { nodes, truncated } = listDir(root, "big");
  assert.equal(nodes.length, 1000);
  assert.equal(truncated, true);
});

test("listDir: unreadable dir is marked inaccessible (skipped for root user)", () => {
  fixture();
  if (typeof process.getuid === "function" && process.getuid() === 0) return;
  const locked = join(root, "locked");
  mkdirSync(locked);
  writeFileSync(join(locked, "x.txt"), "");
  chmodSync(locked, 0o000);
  try {
    const { nodes } = listDir(root, "");
    const node = nodes.find((n) => n.name === "locked");
    assert.equal(node?.inaccessible, true);
    assert.equal(node?.hasChildren, false);
  } finally {
    chmodSync(locked, 0o755);
  }
});
