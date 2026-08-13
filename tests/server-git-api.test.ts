import assert from "node:assert/strict";
import { spawn, type ChildProcess, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

let child: ChildProcess | undefined;
let home = "";
let project = "";

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) resolve(address.port);
        else reject(new Error("no port"));
      });
    });
    server.on("error", reject);
  });
}

function git(...args: string[]) {
  return execFileSync("git", ["-C", project, ...args], { encoding: "utf8" });
}

async function waitForHealth(url: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {
      // server is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server did not become ready");
}

async function request(url: string, path: string, token?: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${url}${path}`, { ...init, headers });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) as Record<string, unknown> : null };
}

afterEach(async () => {
  if (child && !child.killed) {
    await new Promise<void>((resolve) => {
      const process = child;
      const forceKill = setTimeout(() => process.kill("SIGKILL"), 1_000);
      process.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
      process.kill("SIGTERM");
    });
  }
  child = undefined;
  if (home) rmSync(home, { recursive: true, force: true });
  if (project) rmSync(project, { recursive: true, force: true });
  home = "";
  project = "";
});

test("Git API is authenticated, cwd-scoped, and exposes status/log/branches", async () => {
  home = mkdtempSync(join(tmpdir(), "pi-git-api-home-"));
  project = mkdtempSync(join(tmpdir(), "pi-git-api-project-"));
  mkdirSync(join(project, "src"));
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Git Test");
  writeFileSync(join(project, "README.md"), "hello\n");
  git("add", "README.md");
  git("commit", "-qm", "initial");
  git("switch", "-qc", "feature/api");
  writeFileSync(join(project, "README.md"), "changed\n");
  writeFileSync(join(project, "new.txt"), "untracked\n");

  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      PORT: String(port),
      HOST: "127.0.0.1",
      PI_WEB_CWD: project,
      PI_WEB_TOKEN: "git-api-token",
      PI_WEB_2FA: "off",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth(url);
  const login = await fetch(`${url}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "git-api-token" }),
  });
  const { sessionToken } = await login.json() as { sessionToken: string };

  const unauthorized = await request(url, `/api/git/status?cwd=${encodeURIComponent(project)}`);
  assert.equal(unauthorized.response.status, 401);

  const status = await request(url, `/api/git/status?cwd=${encodeURIComponent(project)}`, sessionToken);
  assert.equal(status.response.status, 200);
  assert.equal(status.body?.branch, "feature/api");
  assert.equal(status.body?.isDirty, true);

  const branches = await request(url, `/api/git/branches?cwd=${encodeURIComponent(project)}`, sessionToken);
  assert.equal(branches.response.status, 200);
  assert.ok((branches.body as unknown as Array<{ name: string }>).some((branch) => branch.name === "feature/api"));

  const log = await request(url, `/api/git/log?cwd=${encodeURIComponent(project)}`, sessionToken);
  assert.equal(log.response.status, 200);
  assert.equal((log.body as unknown as Array<{ subject: string }>)[0]?.subject, "initial");

  const unknown = await request(url, `/api/git/status?cwd=${encodeURIComponent("/etc")}`, sessionToken);
  assert.equal(unknown.response.status, 403);

  const checkout = await request(url, `/api/git/checkout?cwd=${encodeURIComponent(project)}`, sessionToken, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ branch: "main" }),
  });
  assert.equal(checkout.response.status, 409);
});
