import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

let child: ChildProcessWithoutNullStreams | undefined;
let home = "";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      srv.close(() => {
        if (typeof address === "object" && address) resolve(address.port);
        else reject(new Error("no port"));
      });
    });
    srv.on("error", reject);
  });
}

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
      lastError = new Error(`health ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function login(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "test-token" }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { sessionToken?: string };
  assert.equal(typeof body.sessionToken, "string");
  return body.sessionToken;
}

async function getJson(baseUrl: string, path: string, token: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}${path.includes("?") ? "&" : "?"}token=${token}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function stopChild(): Promise<void> {
  if (!child || child.killed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child?.kill("SIGKILL");
    }, 1_000);
    child!.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child!.kill("SIGTERM");
  });
}

afterEach(async () => {
  await stopChild();
  child = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  home = "";
});

test("file APIs require a session token, authorize known cwd, and reject unsafe paths", async () => {
  home = mkdtempSync(join(tmpdir(), "pi-web-home-"));
  const root = join(home, "project");
  const outside = join(home, "outside");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "README.md"), "hello");
  writeFileSync(join(root, "src", "chat.ts"), "");
  writeFileSync(join(outside, "outside.txt"), "");
  symlinkSync(outside, join(root, "linkout"));

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      PORT: String(port),
      HOST: "127.0.0.1",
      PI_WEB_CWD: root,
      PI_WEB_TOKEN: "test-token",
      PI_WEB_2FA: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.resume();
  child.stderr.resume();
  await waitForHealth(baseUrl);

  const unauthorized = await fetch(`${baseUrl}/api/tree?cwd=${encodeURIComponent(root)}`);
  assert.equal(unauthorized.status, 401);

  const sessionToken = await login(baseUrl);
  const tree = await getJson(baseUrl, `/api/tree?cwd=${encodeURIComponent(root)}&path=`, sessionToken);
  assert.equal(tree.status, 200);
  assert.deepEqual(tree.body, {
    root: "~/project",
    path: "",
    nodes: [
      { name: "src", path: "src", type: "dir", hasChildren: true },
      { name: "linkout", path: "linkout", type: "file" },
      { name: "README.md", path: "README.md", type: "file" },
    ],
  });

  const search = await getJson(baseUrl, `/api/files/search?cwd=${encodeURIComponent(root)}&q=chat`, sessionToken);
  assert.equal(search.status, 200);
  assert.deepEqual(search.body, {
    root: "~/project",
    query: "chat",
    matches: [{ name: "chat.ts", path: "src/chat.ts", type: "file" }],
  });

  const unknownRoot = await getJson(baseUrl, `/api/tree?cwd=${encodeURIComponent("/etc")}`, sessionToken);
  assert.equal(unknownRoot.status, 403);
  const escapePath = await getJson(baseUrl, `/api/tree?cwd=${encodeURIComponent(root)}&path=..%2F..`, sessionToken);
  assert.equal(escapePath.status, 400);
  const filePath = await getJson(baseUrl, `/api/tree?cwd=${encodeURIComponent(root)}&path=README.md`, sessionToken);
  assert.equal(filePath.status, 400);
  const symlinkedDir = await getJson(baseUrl, `/api/tree?cwd=${encodeURIComponent(root)}&path=linkout`, sessionToken);
  assert.equal(symlinkedDir.status, 400);

  // EACCES on the listed directory itself → 403 (skip when running as root, which ignores modes)
  if (typeof process.getuid !== "function" || process.getuid() !== 0) {
    const locked = join(root, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "x.txt"), "");
    chmodSync(locked, 0o000);
    try {
      const lockedResp = await getJson(baseUrl, `/api/tree?cwd=${encodeURIComponent(root)}&path=locked`, sessionToken);
      assert.equal(lockedResp.status, 403);
    } finally {
      chmodSync(locked, 0o755);
    }
  }

  // A known root (AGENT_CWD) deleted after startup → still authorized but missing → 404
  rmSync(root, { recursive: true, force: true });
  const missingRoot = await getJson(baseUrl, `/api/tree?cwd=${encodeURIComponent(root)}`, sessionToken);
  assert.equal(missingRoot.status, 404);
});
