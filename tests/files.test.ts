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
import { listDir, PathEscapeError, searchFiles, walkProject } from "../server/files.ts";

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
  mkdirSync(join(root, "utils"), { recursive: true });
  writeFileSync(join(root, "utils", "helper.ts"), "");
  writeFileSync(join(root, "node_modules", "dep", "x.js"), "");
  writeFileSync(join(root, "dist", "bundle.js"), "");
  writeFileSync(join(root, "src", "b.ts"), "");
  writeFileSync(join(root, "src", "a.ts"), "");
  writeFileSync(join(root, "src", "utils.ts"), "");
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
  assert.deepEqual(dirNames, ["empty", "src", "utils"]);
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
    ["dir:src/deep", "file:src/a.ts", "file:src/b.ts", "file:src/utils.ts"],
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

test("walkProject: respects the same filters as listDir", () => {
  fixture();
  const { entries, partial } = walkProject(root, 100_000);
  assert.equal(partial, false);
  const paths = entries.map((e) => e.path);
  for (const excluded of ["node_modules/dep/x.js", "dist/bundle.js", "secret.txt", ".git"]) {
    assert.ok(!paths.some((p) => p === excluded || p.startsWith(excluded + "/")), excluded);
  }
  // symlinked dir is not traversed nor indexed
  assert.ok(!paths.includes("linkdir"));
  assert.ok(paths.includes("src/deep/c.ts"));
});

test("walkProject: cap marks partial", () => {
  fixture();
  const { entries, partial } = walkProject(root, 5);
  assert.equal(partial, true);
  assert.equal(entries.length, 5);
});

test("searchFiles: ranking tiers — basename prefix > basename substring > path substring", () => {
  fixture();
  const { matches } = searchFiles(root, "utils", 50);
  // tier 0: root dir "utils" (shorter path) then file "src/utils.ts" (same basename-prefix tier);
  // "utils/helper.ts" ranks last as a tier-2 path hit (consistent with the tier system)
  assert.deepEqual(matches.map((m) => m.path), ["utils", "src/utils.ts", "utils/helper.ts"]);
});

test("searchFiles: path-substring tier ranks after name tiers", () => {
  fixture();
  const { matches } = searchFiles(root, "deep", 50);
  assert.equal(matches[0]!.path, "src/deep"); // dir name hit (tier 0)
  assert.deepEqual(matches.map((m) => m.path).slice(1), ["src/deep/c.ts"]); // path hit (tier 2)
});

test("searchFiles: empty query degrades to root-level, dirs first, cap 20", () => {
  fixture();
  const { matches } = searchFiles(root, "", 50);
  assert.ok(matches.length > 0 && matches.length <= 20);
  assert.ok(matches.every((m) => !m.path.includes("/")));
  assert.equal(matches[0]!.type, "dir");
});

test("searchFiles: limit clamps results", () => {
  fixture();
  const { matches } = searchFiles(root, "ts", 2);
  assert.equal(matches.length, 2);
});
