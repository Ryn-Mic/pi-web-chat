import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  const contentUrl = `${baseUrl}/api/files/content?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent("README.md")}`;
  const head = await fetch(contentUrl, {
    method: "HEAD",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-length"), "5");
  assert.equal(head.headers.get("cache-control"), "private, no-store");
  assert.equal(head.headers.get("content-disposition"), "inline; filename*=UTF-8''README.md");
  assert.equal(head.headers.get("x-content-type-options"), "nosniff");
  assert.equal(head.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(head.headers.get("accept-ranges"), null);
  const etag = head.headers.get("etag");
  assert.ok(etag);

  const body = await fetch(contentUrl, {
    headers: { authorization: `Bearer ${sessionToken}`, "if-match": etag },
  });
  assert.equal(body.status, 200);
  assert.equal(await body.text(), "hello");

  writeFileSync(join(root, "README.md"), "changed");
  const changed = await fetch(contentUrl, {
    headers: { authorization: `Bearer ${sessionToken}`, "if-match": etag },
  });
  assert.equal(changed.status, 409);

  const getNoIfMatch = await fetch(contentUrl, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(getNoIfMatch.status, 409);

  const postContent = await fetch(contentUrl, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(postContent.status, 405);

  const unknownCwd = await fetch(
    `${baseUrl}/api/files/content?cwd=${encodeURIComponent("/etc")}&path=${encodeURIComponent("passwd")}`,
    { headers: { authorization: `Bearer ${sessionToken}` } },
  );
  assert.equal(unknownCwd.status, 403);

  const missingFile = await fetch(
    `${baseUrl}/api/files/content?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent("missing.txt")}`,
    { headers: { authorization: `Bearer ${sessionToken}`, "if-match": '"x"' } },
  );
  assert.equal(missingFile.status, 404);

  const hardExcludedFile = await fetch(
    `${baseUrl}/api/files/content?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent(".git/config")}`,
    { headers: { authorization: `Bearer ${sessionToken}`, "if-match": '"x"' } },
  );
  assert.equal(hardExcludedFile.status, 404);

  const bigPath = join(root, "big.bin");
  const bigFd = openSync(bigPath, "w");
  try {
    ftruncateSync(bigFd, 101 * 1024 * 1024);
  } finally {
    closeSync(bigFd);
  }
  const tooLarge = await fetch(
    `${baseUrl}/api/files/content?cwd=${encodeURIComponent(root)}&path=${encodeURIComponent("big.bin")}`,
    { headers: { authorization: `Bearer ${sessionToken}`, "if-match": '"x"' } },
  );
  assert.equal(tooLarge.status, 413);
  rmSync(bigPath, { force: true });

  const unknownApi = await fetch(`${baseUrl}/api/nope`, {
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(unknownApi.status, 404);
  assert.equal(unknownApi.headers.get("content-type"), "application/json");
  const unknownApiBody = (await unknownApi.json()) as { error?: string };
  assert.equal(unknownApiBody.error, "not found");

  const unknownApiPost = await fetch(`${baseUrl}/api/nope`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(unknownApiPost.status, 405);
  assert.equal(unknownApiPost.headers.get("content-type"), "application/json");
  const unknownApiPostBody = (await unknownApiPost.json()) as { error?: string };
  assert.equal(unknownApiPostBody.error, "method not allowed");

  const malformedPercent = await fetch(`${baseUrl}/file-viewer/%`);
  assert.equal(malformedPercent.status, 400);

  const distDir = resolve(process.cwd(), "dist", "public");
  if (existsSync(distDir)) {
    const viewerDir = join(distDir, "file-viewer");
    mkdirSync(viewerDir, { recursive: true });
    const percentFile = join(viewerDir, "%");
    writeFileSync(percentFile, "ok");
    try {
      const percentFileRes = await fetch(`${baseUrl}/file-viewer/%25`);
      assert.equal(percentFileRes.status, 200);
      assert.equal(await percentFileRes.text(), "ok");
    } finally {
      rmSync(percentFile, { force: true });
    }
  }

  const missingViewerAsset = await fetch(`${baseUrl}/file-viewer/nope.wasm`);
  assert.equal(missingViewerAsset.status, 404);
  assert.notEqual(await missingViewerAsset.text(), "fallback");

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

test("mobile preview context and preview-content routes", async () => {
  home = mkdtempSync(join(tmpdir(), "pi-web-home-"));
  const root = join(home, "project");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), "hello");

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

  const sessionToken = await login(baseUrl);

  const created = await fetch(`${baseUrl}/api/files/preview-context`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ cwd: root, path: "README.md", theme: "dark", locale: "ko" }),
  });
  assert.equal(created.status, 200);
  const { id } = (await created.json()) as { id: string };
  assert.equal(typeof id, "string");

  const preview = await fetch(`${baseUrl}/api/files/preview-content`, {
    headers: { authorization: `Preview ${id}` },
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("x-preview-theme"), "dark");
  assert.equal(preview.headers.get("x-preview-locale"), "en-US");
  assert.equal(preview.headers.get("content-type"), "text/markdown");
  assert.equal(await preview.text(), "hello");

  const head = await fetch(`${baseUrl}/api/files/preview-content`, {
    method: "HEAD",
    headers: { authorization: `Preview ${id}` },
  });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("x-preview-theme"), "dark");
  assert.equal(await head.text(), "");

  assert.equal((await fetch(`${baseUrl}/api/files/preview-content`)).status, 401);
  assert.equal(
    (await fetch(`${baseUrl}/api/files/preview-content`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    })).status,
    401,
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/files/preview-content?id=${encodeURIComponent(id)}`)).status,
    401,
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/files/preview-content`, {
      headers: { authorization: "Preview   " },
    })).status,
    401,
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/files/preview-content`, {
      headers: { authorization: `PREVIEW ${id}` },
    })).status,
    200,
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/files/preview-content`, {
      headers: { authorization: `preview ${id}` },
    })).status,
    200,
  );
  assert.equal(
    (await fetch(`${baseUrl}/api/files/preview-content`, {
      method: "POST",
      headers: { authorization: `Preview ${id}` },
    })).status,
    405,
  );

  const unknownCwd = await fetch(`${baseUrl}/api/files/preview-context`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ cwd: "/etc", path: "passwd", theme: "light", locale: "en" }),
  });
  assert.equal(unknownCwd.status, 403);

  const escapePath = await fetch(`${baseUrl}/api/files/preview-context`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ cwd: root, path: "../outside.txt", theme: "light", locale: "en" }),
  });
  assert.equal(escapePath.status, 400);

  const bigPath = join(root, "big.bin");
  const bigFd = openSync(bigPath, "w");
  try {
    ftruncateSync(bigFd, 101 * 1024 * 1024);
  } finally {
    closeSync(bigFd);
  }
  const tooLarge = await fetch(`${baseUrl}/api/files/preview-context`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ cwd: root, path: "big.bin", theme: "light", locale: "en" }),
  });
  assert.equal(tooLarge.status, 413);

  writeFileSync(join(root, "README.md"), "HELLO");
  const changed = await fetch(`${baseUrl}/api/files/preview-content`, {
    headers: { authorization: `Preview ${id}` },
  });
  assert.equal(changed.status, 409);

  const created2 = await fetch(`${baseUrl}/api/files/preview-context`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${sessionToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ cwd: root, path: "README.md", theme: "light", locale: "zh" }),
  });
  assert.equal(created2.status, 200);
  const { id: id2 } = (await created2.json()) as { id: string };

  const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${sessionToken}` },
  });
  assert.equal(logoutRes.status, 200);

  const afterLogout = await fetch(`${baseUrl}/api/files/preview-content`, {
    headers: { authorization: `Preview ${id2}` },
  });
  assert.equal(afterLogout.status, 410);

  const noSession = await fetch(`${baseUrl}/api/files/preview-context`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: root, path: "README.md", theme: "light", locale: "en" }),
  });
  assert.equal(noSession.status, 401);

  const queryTokenOnly = await fetch(
    `${baseUrl}/api/files/preview-context?token=${sessionToken}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd: root, path: "README.md", theme: "light", locale: "en" }),
    },
  );
  assert.equal(queryTokenOnly.status, 401);
});
