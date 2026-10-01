import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { WebSocket } from "ws";
import { CLIENT_COMMAND_MAX_TEXT_LENGTH } from "../shared/client-command.ts";
import { SESSION_NOT_FOUND_CLOSE_CODE } from "../shared/protocol.ts";

// auth has a production singleton. Isolate its initial import as well as every
// test instance, without changing HOME or touching the real ~/.pi state.
const root = mkdtempSync(join(tmpdir(), "pi-web-auth-unit-"));
const previousNodeEnv = process.env.NODE_ENV;
const previousStateDir = process.env.PI_WEB_TEST_STATE_DIR;
const previousAccessToken = process.env.PI_WEB_TOKEN;
process.env.NODE_ENV = "test";
process.env.PI_WEB_TEST_STATE_DIR = join(root, "singleton");
process.env.PI_WEB_TOKEN = "isolated-singleton-access-token";
const { Auth, auth, SESSION_TTL_MS } = await import("../server/auth.ts");
if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = previousNodeEnv;
if (previousStateDir === undefined) delete process.env.PI_WEB_TEST_STATE_DIR;
else process.env.PI_WEB_TEST_STATE_DIR = previousStateDir;
if (previousAccessToken === undefined) delete process.env.PI_WEB_TOKEN;
else process.env.PI_WEB_TOKEN = previousAccessToken;

after(() => {
  auth.flushSessions();
  rmSync(root, { recursive: true, force: true });
});

function instance(t: TestContext, options: ConstructorParameters<typeof Auth>[0] = {}) {
  const stateDir = mkdtempSync(join(root, "instance-"));
  const store = new Auth({ stateDir, token: "unit-access-token", twoFactorEnabled: false, ...options });
  t.after(() => { store.flushSessions(); });
  return store;
}

function login(store: InstanceType<typeof Auth>): string {
  const result = store.login("unit-access-token", store.twoFactorEnabled ? store.currentTotp() : undefined);
  assert.equal(typeof result.sessionToken, "string");
  return result.sessionToken!;
}

test("launch token overrides retained credentials and existing auth files become private", (t) => {
  const stateDir = mkdtempSync(join(root, "permissions-"));
  const tokenFile = join(stateDir, "token");
  const secretFile = join(stateDir, "2fa.secret");
  const sessionsFile = join(stateDir, "sessions.json");
  writeFileSync(tokenFile, "retained-access-token\n", { mode: 0o644 });
  writeFileSync(secretFile, "JBSWY3DPEHPK3PXP\n", { mode: 0o644 });
  writeFileSync(sessionsFile, "{}", { mode: 0o644 });
  chmodSync(stateDir, 0o755);
  const previousToken = process.env.PI_WEB_TOKEN;
  process.env.PI_WEB_TOKEN = "unit-access-token";
  let store: InstanceType<typeof Auth>;
  try {
    store = new Auth({ stateDir, twoFactorEnabled: false });
  } finally {
    if (previousToken === undefined) delete process.env.PI_WEB_TOKEN;
    else process.env.PI_WEB_TOKEN = previousToken;
  }
  t.after(() => store.flushSessions());
  assert.equal(store.login("retained-access-token").reason, "token");
  assert.equal(typeof store.login("unit-access-token").sessionToken, "string");
  assert.ok(readFileSync(tokenFile, "utf8").trim() === "unit-access-token");
  assert.equal(statSync(stateDir).mode & 0o777, 0o700);
  for (const path of [tokenFile, secretFile, sessionsFile]) assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("file rotation applies to later login after an explicit launch token", (t) => {
  const store = instance(t);
  writeFileSync(store.tokenFile, "rotated-unit-access-token\n");
  assert.equal(store.login("unit-access-token").reason, "token");
  assert.equal(typeof store.login("rotated-unit-access-token").sessionToken, "string");
});

test("login safely rejects malformed input and still requires the second factor", (t) => {
  const now = 1_800_000_000_000;
  const store = instance(t, { twoFactorEnabled: true, now: () => now });
  for (const rawToken of [null, undefined, 1, [], {}]) assert.equal(store.login(rawToken).reason, "token");
  for (const totp of [null, undefined, 1, [], {}, "invalid", "0".repeat(129)]) {
    assert.equal(store.login("unit-access-token", totp).reason, "2fa");
  }
  assert.equal(typeof store.login("unit-access-token", store.currentTotp()).sessionToken, "string");
});

test("validSession expires immediately at TTL before periodic cleanup and cannot revive the session", (t) => {
  let now = 1_800_000_000_000;
  const store = instance(t, { now: () => now });
  const sessionToken = login(store);
  const revoked: string[] = [];
  store.onSessionRevoked((_token, reason) => { revoked.push(reason); });
  now += SESSION_TTL_MS;
  assert.equal(store.validSession(sessionToken), false);
  assert.equal(store.validSession(sessionToken), false);
  assert.deepEqual(revoked, ["expired"]);
  store.flushSessions();
  assert.equal(Object.keys(JSON.parse(readFileSync(join(store.tokenFile, "..", "sessions.json"), "utf8"))).length, 0);
});

test("HTTP or commands renew sliding expiry while passive checks do not", (t) => {
  let now = 1_800_000_000_000;
  const store = instance(t, { now: () => now });
  const sessionToken = login(store);
  now += SESSION_TTL_MS - 1;
  assert.equal(store.validSession(sessionToken), true);
  now += SESSION_TTL_MS - 1;
  assert.equal(store.isSessionValid(sessionToken), true);
  now += 1;
  assert.equal(store.isSessionValid(sessionToken), false);
});

test("logout notifies every cleanup listener once and a failing listener cannot block revocation", (t) => {
  const store = instance(t);
  const sessionToken = login(store);
  let ignored = 0;
  const unsubscribe = store.onSessionRevoked(() => { ignored += 1; });
  unsubscribe();
  store.onSessionRevoked(() => { throw new Error("cleanup failure"); });
  const revoked: string[] = [];
  store.onSessionRevoked((token, reason) => { assert.ok(token === sessionToken); revoked.push(reason); });
  store.logout(sessionToken);
  store.logout(sessionToken);
  assert.equal(store.validSession(sessionToken), false);
  assert.deepEqual(revoked, ["logout"]);
  assert.equal(ignored, 0);
});

test("persisted sessions with expired or malformed last-used values are not restored", (t) => {
  const stateDir = mkdtempSync(join(root, "restore-"));
  mkdirSync(stateDir, { recursive: true });
  const now = 1_800_000_000_000;
  writeFileSync(join(stateDir, "sessions.json"), JSON.stringify({
    fresh: { createdAt: now - 1, lastUsed: now - 1 },
    expired: { createdAt: now - SESSION_TTL_MS, lastUsed: now - SESSION_TTL_MS },
    future: { createdAt: now + 1, lastUsed: now + 1 },
    malformed: { createdAt: now, lastUsed: "yesterday" },
    missing: { createdAt: now },
    nestedArray: [],
  }));
  const store = new Auth({ stateDir, token: "unit-access-token", twoFactorEnabled: false, now: () => now });
  t.after(() => store.flushSessions());
  assert.equal(store.isSessionValid("fresh"), true);
  for (const token of ["expired", "future", "malformed", "missing", "nestedArray"]) assert.equal(store.isSessionValid(token), false);
});

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("test port was unavailable"));
      });
    });
  });
}

async function rawRequest(port: number, target: string, upgrade = false): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    let response = "";
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("raw request timed out")); }, 2_000);
    socket.once("connect", () => {
      const headers = upgrade
        ? "Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
        : "Connection: close\r\n";
      socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\n${headers}\r\n`);
    });
    socket.on("data", (chunk) => { response += chunk.toString(); });
    socket.once("end", () => { clearTimeout(timer); socket.destroy(); resolve(response); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(description);
}

test("HTTP auth rejects malformed login and raw-token setup, and logout or TTL closes an existing WebSocket", async (t) => {
  const fixture = mkdtempSync(join(root, "http-"));
  const stateDir = join(fixture, "auth");
  const agentDir = join(fixture, "agent");
  const project = join(fixture, "project");
  const clockFile = join(fixture, "clock-offset");
  for (const directory of [stateDir, agentDir, project]) mkdirSync(directory, { recursive: true });
  writeFileSync(clockFile, "0");
  const accessToken = "http-auth-access-token";
  // The child must use this launch token even when an earlier launch left a file.
  writeFileSync(join(stateDir, "token"), "earlier-http-access-token\n");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  // Advance only this isolated child clock to exercise TTL without waiting a
  // month or adding a test-only expiry setting to the production server.
  const bootstrap = `import { readFileSync } from "node:fs";
const nativeNow = Date.now;
Date.now = () => nativeNow() + Number(readFileSync(process.env.PI_WEB_TEST_CLOCK_FILE, "utf8"));
await import("./server/index.ts");`;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", bootstrap], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      HOST: "127.0.0.1",
      PI_WEB_CWD: project,
      PI_WEB_TOKEN: accessToken,
      PI_WEB_2FA: "on",
      PI_WEB_TEST_STATE_DIR: stateDir,
      PI_WEB_TEST_CLOCK_FILE: clockFile,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
      PI_WEB_DAEMON_MANAGED: "0",
      PI_WEB_CODEX_BIN: join(fixture, "unused-codex"),
      PI_WEB_CODEX_STARTED_MARKER: join(fixture, "codex-must-not-start"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
  const sockets: WebSocket[] = [];
  t.after(async () => {
    for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    await stopChild(child);
  });
  await waitUntil(async () => {
    try { return (await fetch(`${baseUrl}/api/health`)).ok; }
    catch { return false; }
  }, "isolated auth server did not become healthy");

  for (const upgrade of [false, true]) {
    for (const target of ["//[", "http://["]) {
      assert.match(await rawRequest(port, target, upgrade), /^HTTP\/1\.1 400/);
      assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
      assert.equal(child.exitCode, null, "malformed URLs must not stop the service");
    }
  }

  for (const [value, expectedStatus] of [[null, 400], [[], 400], [1, 400], [{ token: null }, 401], [{ token: accessToken, totp: 1 }, 401]] as const) {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value),
    });
    assert.equal(response.status, expectedStatus);
  }
  const rawSetup = await fetch(`${baseUrl}/api/auth/setup?token=${encodeURIComponent(accessToken)}`);
  assert.equal(rawSetup.status, 401);
  const status = await fetch(`${baseUrl}/api/auth/status`);
  assert.equal(status.status, 401);
  const localAuth = new Auth({ stateDir, token: accessToken, twoFactorEnabled: true });
  const localTotp = localAuth.currentTotp();
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: accessToken, totp: localTotp }),
  });
  assert.equal(response.status, 200);
  const result = await response.json() as { sessionToken?: unknown };
  assert.equal(typeof result.sessionToken, "string");
  const sessionToken = result.sessionToken as string;
  const headers = { authorization: `Bearer ${sessionToken}` };
  const setup = await fetch(`${baseUrl}/api/auth/setup`, { headers });
  assert.equal(setup.status, 410);
  const setupBody = await setup.json() as Record<string, unknown>;
  for (const sensitive of ["secret", "otpauthUrl", "qr"]) assert.equal(Object.hasOwn(setupBody, sensitive), false);
  assert.equal(output.includes(accessToken), false);
  assert.equal(output.includes(localAuth.totpSecret), false);
  assert.equal(output.includes(localTotp), false);

  const missing = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(sessionToken)}&session=missing-pi-session`);
  sockets.push(missing);
  const missingEvents: Array<Record<string, unknown>> = [];
  let missingCloseCode: number | undefined;
  missing.on("message", (raw) => { missingEvents.push(JSON.parse(raw.toString())); });
  missing.once("close", (code) => { missingCloseCode = code; });
  await waitUntil(() => missingCloseCode !== undefined, "missing Pi session did not terminate binding");
  assert.equal(missingCloseCode, SESSION_NOT_FOUND_CLOSE_CODE);
  assert.ok(missingEvents.some((event) => event.type === "error" && event.message === "Session not found"));
  assert.equal(missingEvents.some((event) => event.type === "session_bound" || event.type === "snapshot"), false);
  const emptyState = await (await fetch(`${baseUrl}/api/state`, { headers })).json() as { activeSessions: unknown[] };
  assert.deepEqual(emptyState.activeSessions, [], "an explicit missing id must not create a replacement runtime");

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(sessionToken)}&agent=pi&cwd=${encodeURIComponent(project)}`);
  sockets.push(ws);
  const events: Array<Record<string, unknown>> = [];
  ws.on("message", (raw) => { events.push(JSON.parse(raw.toString()) as Record<string, unknown>); });
  await waitUntil(() => events.some((event) => event.type === "snapshot"), "authorized socket did not bind");
  const offset = events.length;
  for (const command of [null, [], { type: "prompt", text: null }, { type: "extension_ui_response", response: null }, { type: "codex_interaction_response", response: null }]) {
    ws.send(JSON.stringify(command));
  }
  ws.send(JSON.stringify({ type: "get_snapshot" }));
  await waitUntil(() => events.slice(offset).some((event) => event.type === "snapshot"), "socket did not recover after invalid command frames");
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);

  const invalidRequestId = "oversized-prompt-1";
  const invalidOffset = events.length;
  ws.send(JSON.stringify({ type: "prompt", text: "x".repeat(CLIENT_COMMAND_MAX_TEXT_LENGTH + 1), requestId: invalidRequestId }));
  await waitUntil(() => events.slice(invalidOffset).some((event) => event.type === "error" && event.requestId === invalidRequestId), "rejected prompt lost its request id");
  const recoveryOffset = events.length;
  ws.send(JSON.stringify({ type: "get_snapshot" }));
  await waitUntil(() => events.slice(recoveryOffset).some((event) => event.type === "snapshot"), "socket did not recover after an oversized prompt");

  let closeCode: number | undefined;
  ws.once("close", (code) => { closeCode = code; });
  const logout = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST", headers });
  assert.equal(logout.status, 200);
  await waitUntil(() => closeCode !== undefined, "logout did not close the existing authorized socket");
  assert.equal(closeCode, 1008);
  assert.equal((await fetch(`${baseUrl}/api/auth/status`, { headers })).status, 401);

  const freshLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: accessToken, totp: localAuth.currentTotp() }),
  });
  assert.equal(freshLogin.status, 200);
  const freshResult = await freshLogin.json() as { sessionToken: string };
  const freshHeaders = { authorization: `Bearer ${freshResult.sessionToken}` };
  const expiring = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(freshResult.sessionToken)}&agent=pi&cwd=${encodeURIComponent(project)}`);
  sockets.push(expiring);
  let hasSnapshot = false;
  let expiryCloseCode: number | undefined;
  expiring.on("message", (raw) => {
    if ((JSON.parse(raw.toString()) as { type?: string }).type === "snapshot") hasSnapshot = true;
  });
  expiring.once("close", (code) => { expiryCloseCode = code; });
  await waitUntil(() => hasSnapshot, "socket for expiry did not bind");
  writeFileSync(clockFile, String(SESSION_TTL_MS + 1_000));
  expiring.send(JSON.stringify({ type: "get_snapshot" }));
  await waitUntil(() => expiryCloseCode !== undefined, "idle expiry did not close an existing socket before dispatch");
  assert.equal(expiryCloseCode, 1008);
  assert.equal((await fetch(`${baseUrl}/api/auth/status`, { headers: freshHeaders })).status, 401);
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
});

test("authenticated file APIs deny credentials even when a legacy workspace equals auth state", async (t) => {
  const fixture = mkdtempSync(join(root, "private-api-"));
  const stateDir = join(fixture, "state");
  const agentDir = join(fixture, "agent");
  mkdirSync(agentDir, { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: "test", PORT: String(port), HOST: "127.0.0.1",
      PI_WEB_CWD: stateDir, PI_WEB_TEST_STATE_DIR: stateDir, PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"), PI_WEB_TOKEN: "private-api-fixture",
      PI_WEB_2FA: "on", PI_WEB_DAEMON_MANAGED: "0", PI_WEB_CODEX_STARTED_MARKER: join(fixture, "no-codex") },
    stdio: "ignore",
  });
  t.after(() => stopChild(child));
  const base = `http://127.0.0.1:${port}`;
  await waitUntil(async () => { try { return (await fetch(base + "/api/health")).ok; } catch { return false; } }, "private API fixture unavailable");
  const local = new Auth({ stateDir, token: "private-api-fixture", twoFactorEnabled: true });
  const result = await (await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "private-api-fixture", totp: local.currentTotp() }) })).json() as { sessionToken: string };
  const headers = { authorization: `Bearer ${result.sessionToken}`, "content-type": "application/json" };
  const cwd = encodeURIComponent(stateDir);
  for (const path of ["token", "2fa.secret", "sessions.json"]) {
    for (const [url, method, body] of [
      [`/api/files/text?cwd=${cwd}&path=${path}`, "GET", undefined],
      [`/api/files/text?cwd=${cwd}&path=${path}`, "PUT", JSON.stringify({ text: "replacement", revision: "0".repeat(64) })],
      [`/api/files/content?cwd=${cwd}&path=${path}`, "HEAD", undefined],
      ["/api/files/preview-context", "POST", JSON.stringify({ cwd: stateDir, path })],
    ] as const) {
      const response = await fetch(base + url, { method, headers, body });
      assert.equal(response.status, 403, `${method} ${path} must be private`);
    }
  }
  for (const url of [`/api/tree?cwd=${cwd}`, `/api/files/search?cwd=${cwd}&q=token`]) {
    assert.equal((await fetch(base + url, { headers })).status, 403);
  }
  assert.equal(readFileSync(join(stateDir, "token"), "utf8").trim() === "private-api-fixture", true);
});
