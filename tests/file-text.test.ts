import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { handleTextFileRequest } from "../server/file-text.ts";
import { MAX_TEXT_BYTES } from "../shared/text-file.ts";

async function fixture(run: (root: string, get: (path: string, init?: RequestInit, cwd?: string) => Promise<Response>) => Promise<void>) {
  const base = mkdtempSync(join(tmpdir(), "pi-text-api-"));
  const root = join(base, "project");
  mkdirSync(root);
  const server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer test-session") { res.writeHead(401); res.end(); return; }
    void handleTextFileRequest(req, res, new URL(req.url!, "http://localhost"), {
      knownProjectRoots: async () => new Set([root]), expandHome: (cwd) => cwd,
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const get = (path: string, init?: RequestInit, cwd = root) => fetch(
    `http://127.0.0.1:${port}/api/files/text?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`,
    { ...init, headers: { authorization: "Bearer test-session", ...init?.headers } },
  );
  try { await run(root, get); }
  finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(base, { recursive: true, force: true }); }
}

const put = (text: string, revision: string): RequestInit => ({ method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, revision }) });

test("text API reads extensionless UTF-8 and conditionally saves atomically with original permissions", async () => fixture(async (root, get) => {
  const path = join(root, "Dockerfile");
  const original = "\ufeffFROM node:22\r\n# 中文\r\n";
  writeFileSync(path, original);
  chmodSync(path, 0o750);
  const response = await get("Dockerfile");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const snapshot = await response.json() as { text: string; revision: string; name: string };
  assert.equal(snapshot.text, original);
  assert.equal(snapshot.name, "Dockerfile");
  assert.match(snapshot.revision, /^[a-f0-9]{64}$/);
  const changed = await get("Dockerfile", put(original + "RUN npm test\r\n", snapshot.revision));
  assert.equal(changed.status, 200);
  assert.notEqual((await changed.json() as { revision: string }).revision, snapshot.revision);
  assert.equal(readFileSync(path, "utf8"), original + "RUN npm test\r\n");
  assert.equal(statSync(path).mode & 0o777, 0o750);
  assert.deepEqual(readdirSync(root), ["Dockerfile"]);
  assert.equal((await get("Dockerfile", put("stale", snapshot.revision))).status, 409);
  assert.equal(readFileSync(path, "utf8"), original + "RUN npm test\r\n");
}));

test("text API rejects traversal, unknown roots, unsafe links and unauthorized requests", async () => fixture(async (root, get) => {
  writeFileSync(join(root, ".gitignore"), "out/\n");
  writeFileSync(join(root, "source.txt"), "source");
  writeFileSync(join(root, "out.txt"), "outside");
  symlinkSync("source.txt", join(root, "linked.txt"));
  linkSync(join(root, "source.txt"), join(root, "hard.txt"));
  const revision = (await (await get("source.txt")).json() as { revision: string }).revision;
  assert.equal((await get("../out.txt")).status, 400);
  assert.equal((await get("source.txt", undefined, join(root, "unknown"))).status, 403);
  assert.equal((await get("source.txt", { headers: { authorization: "" } })).status, 401);
  assert.equal((await get("linked.txt", put("changed", revision))).status, 415);
  assert.equal((await get("hard.txt", put("changed", revision))).status, 415);
  assert.equal(readFileSync(join(root, "source.txt"), "utf8"), "source");
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "config"), "secret");
  assert.equal((await get(".git/config")).status, 404);
}));

test("text API rejects binary, invalid UTF-8, oversized files, invalid payload and read-only files", async () => fixture(async (root, get) => {
  writeFileSync(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(join(root, "invalid.txt"), Buffer.from([0xc3, 0x28]));
  writeFileSync(join(root, "big.txt"), Buffer.alloc(MAX_TEXT_BYTES + 1, 65));
  writeFileSync(join(root, "readonly.txt"), "read only");
  assert.equal((await get("binary.bin")).status, 415);
  assert.equal((await get("invalid.txt")).status, 415);
  assert.equal((await get("big.txt")).status, 413);
  const snapshot = await (await get("readonly.txt")).json() as { revision: string };
  assert.equal((await get("readonly.txt", { method: "PUT", headers: { "content-type": "application/json" }, body: "{" })).status, 400);
  assert.equal((await get("readonly.txt", put("\0", snapshot.revision))).status, 415);
  assert.equal((await get("readonly.txt", put("a".repeat(MAX_TEXT_BYTES + 1), snapshot.revision))).status, 413);
  chmodSync(join(root, "readonly.txt"), 0o444);
  assert.equal((await get("readonly.txt", put("changed", snapshot.revision))).status, 403);
}));

test("concurrent saves sharing a revision yield exactly one winner and preserve SVG as source text", async () => fixture(async (root, get) => {
  writeFileSync(join(root, "active.svg"), '<svg><script>alert(1)</script></svg>');
  const snapshot = await (await get("active.svg")).json() as { text: string; revision: string };
  assert.match(snapshot.text, /<script>/);
  const responses = await Promise.all([get("active.svg", put("first", snapshot.revision)), get("active.svg", put("second", snapshot.revision))]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.match(readFileSync(join(root, "active.svg"), "utf8"), /^(first|second)$/);
  assert.deepEqual(readdirSync(root), ["active.svg"]);
}));

test("a permission change during save is reported as conflict and is not overwritten", async (t) => fixture(async (root, get) => {
  const file = join(root, "source.txt");
  writeFileSync(file, "original");
  const snapshot = await (await get("source.txt")).json() as { revision: string };
  const originalOpen = fs.promises.open;
  t.mock.method(fs.promises, "open", async (...args: Parameters<typeof originalOpen>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]).includes(".pi-web-edit-")) {
      const originalSync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => {
        chmodSync(file, 0o444);
        await originalSync();
      });
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await get("source.txt", put("new", snapshot.revision))).status, 409);
    assert.equal(readFileSync(file, "utf8"), "original");
    assert.equal(statSync(file).mode & 0o777, 0o444);
    assert.deepEqual(readdirSync(root), ["source.txt"]);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
}));
