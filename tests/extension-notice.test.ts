import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { WebSocket } from "ws";

/**
 * A failing extension hook is reported by the pi SDK, not by the run: the hook
 * is skipped and the agent keeps going. The web UI must therefore surface it as
 * a named `notice` (never as a failed prompt) and must name the extension and
 * hook so the failure can be traced back to a file.
 */

const EXTENSION_SOURCE = `export default function boom(pi) {
  pi.on("session_start", () => {
    throw new Error("boom from test extension");
  });
}
`;

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
  return body.sessionToken as string;
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function stopChild(): Promise<void> {
  if (!child || child.killed) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child?.kill("SIGKILL"), 1_000);
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

test("a failing extension hook is reported once as a named notice, not as a prompt failure", async () => {
  home = mkdtempSync(join(tmpdir(), "pi-web-extension-notice-"));
  const project = join(home, "project");
  const agentDir = join(home, ".pi", "agent");
  const extensionDir = join(agentDir, "extensions");
  mkdirSync(project, { recursive: true });
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(join(extensionDir, "boom.ts"), EXTENSION_SOURCE);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: home,
      PORT: String(port),
      HOST: "127.0.0.1",
      PI_WEB_CWD: project,
      PI_WEB_TOKEN: "test-token",
      PI_WEB_2FA: "off",
      PI_CODING_AGENT_DIR: agentDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output += chunk.toString("utf8");
  });
  await waitForHealth(baseUrl);

  const sessionToken = await login(baseUrl);
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(sessionToken)}&agent=pi&cwd=${encodeURIComponent(project)}`,
  );
  const events: Array<Record<string, unknown>> = [];
  ws.on("message", (raw) => {
    events.push(JSON.parse(raw.toString()) as Record<string, unknown>);
  });
  try {
    await waitUntil(
      () => events.some((event) => event.type === "notice"),
      "the failing extension hook was never reported",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));

    const notices = events.filter(
      (event) => event.type === "notice" && String(event.message).includes("boom"),
    );
    assert.equal(notices.length, 1, "the same failure must be reported once per session");
    const message = String(notices[0]!.message);
    assert.match(message, /^Extension error \[boom · session_start\]: boom from test extension \(/);
    const extensionFile = join(extensionDir, "boom.ts");
    const shortened = `~${extensionFile.slice(home.length)}`;
    assert.ok(message.includes(shortened), message);

    // The failing hook never fails the run, so it must not arrive as an error.
    assert.equal(
      events.some((event) => event.type === "error" && String(event.message).includes("boom")),
      false,
    );
    // Diagnostics go to the daemon log, including the stack.
    await waitUntil(
      () => output.includes("pi-web-chat extension error:"),
      "the extension failure was not logged",
    );
    assert.ok(output.includes("boom from test extension"), output);
  } finally {
    ws.terminate();
  }
});
