import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";

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

async function waitForHealth(baseUrl: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("server did not become healthy");
}

async function login(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "codex-server-test-token" }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { sessionToken?: unknown };
  assert.equal(typeof body.sessionToken, "string");
  return body.sessionToken as string;
}

async function waitForEvent(
  events: Array<Record<string, unknown>>,
  predicate: (event: Record<string, unknown>) => boolean,
  from = 0,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const event = events.slice(from).find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("expected WebSocket event was not received");
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function jsonlFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...jsonlFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

test("one Web service controls Pi and Codex independently while native Codex features stay authoritative", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-web-codex-server-"));
  const project = join(home, "project");
  const fakeCodex = join(home, "fake-codex.mjs");
  const startedMarker = join(home, "codex-started");
  const requestLog = join(home, "codex-requests.jsonl");
  mkdirSync(project, { recursive: true });
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
appendFileSync(process.env.FAKE_CODEX_STARTED, "started\\n");
const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    return;
  }
  if (message.method === "thread/items/list") {
    appendFileSync(process.env.FAKE_CODEX_REQUESTS, JSON.stringify(message) + "\\n");
    const second = message.params?.cursor === "page-2";
    const result = second
      ? {
          data: [
            { turnId: "turn-2", item: { type: "userMessage", id: "u2", content: [{ type: "text", text: "second" }] } },
            { turnId: "turn-3", item: { type: "userMessage", id: "u3", content: [{ type: "text", text: "third" }] } },
          ],
          nextCursor: null,
        }
      : {
          data: [
            { turnId: "turn-1", item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "first" }] } },
            { turnId: "turn-1", item: { type: "agentMessage", id: "a1", text: "answer" } },
          ],
          nextCursor: "page-2",
        };
    process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
    return;
  }
  if (message.method === "thread/read") {
    const threadId = message.params?.threadId;
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: { thread: { id: threadId, cwd: process.env.FAKE_PROJECT, preview: "native thread", status: { type: "idle" } } },
    }) + "\\n");
    return;
  }
  if (message.method === "thread/resume") {
    const threadId = message.params?.threadId;
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: {
        thread: { id: threadId, cwd: process.env.FAKE_PROJECT, status: { type: "idle" } },
        initialTurnsPage: {
          data: [{
            id: "turn-" + threadId,
            status: "completed",
            items: [
              { type: "userMessage", id: "user-" + threadId, content: [{ type: "text", text: "fork source" }] },
              { type: "agentMessage", id: "agent-" + threadId, text: "fork answer" },
            ],
          }],
          nextCursor: null,
        },
        model: "gpt-test",
        reasoningEffort: "medium",
      },
    }) + "\\n");
    return;
  }
  if (message.method === "thread/fork") {
    appendFileSync(process.env.FAKE_CODEX_REQUESTS, JSON.stringify(message) + "\\n");
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: { thread: { id: "thread-forked", cwd: process.env.FAKE_PROJECT, status: { type: "idle" } } },
    }) + "\\n");
    return;
  }
  if (message.method === "thread/compact/start") {
    appendFileSync(process.env.FAKE_CODEX_REQUESTS, JSON.stringify(message) + "\\n");
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    const threadId = message.params?.threadId;
    const turn = { id: "compact-turn", status: "inProgress", items: [] };
    setTimeout(() => {
      process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId, turn } }) + "\\n");
      process.stdout.write(JSON.stringify({
        method: "item/completed",
        params: { threadId, item: { type: "contextCompaction", id: "compact-item" } },
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        method: "turn/completed",
        params: { threadId, turn: { ...turn, status: "completed" } },
      }) + "\\n");
    }, 10);
    return;
  }
  if (message.method === "review/start") {
    appendFileSync(process.env.FAKE_CODEX_REQUESTS, JSON.stringify(message) + "\\n");
    const threadId = message.params?.threadId;
    const turn = { id: "review-turn", status: "inProgress", items: [] };
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: { turn, reviewThreadId: threadId },
    }) + "\\n");
    setTimeout(() => process.stdout.write(JSON.stringify({
      method: "turn/completed",
      params: { threadId, turn: { ...turn, status: "completed" } },
    }) + "\\n"), 10);
    return;
  }
  if (message.method === "model/list") {
    process.stdout.write(JSON.stringify({
      id: message.id,
      result: { data: [{ id: "gpt-test", model: "gpt-test", displayName: "GPT Test", isDefault: true }], nextCursor: null },
    }) + "\\n");
    return;
  }
  if (message.method === "remoteControl/status/read") {
    process.stdout.write(JSON.stringify({ id: message.id, result: { status: "disabled" } }) + "\\n");
    return;
  }
  if (message.method === "thread/unsubscribe") {
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    return;
  }
  process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "unsupported test method" } }) + "\\n");
});
`);
  chmodSync(fakeCodex, 0o755);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      PI_WEB_CWD: project,
      PI_WEB_TEST_STATE_DIR: join(home, ".pi", "web-chat"),
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      PI_CODING_AGENT_SESSION_DIR: join(home, ".pi", "agent", "sessions"),
      PI_WEB_TOKEN: "codex-server-test-token",
      PI_WEB_2FA: "off",
      PI_WEB_CODEX_BIN: fakeCodex,
      PI_WEB_CODEX_TRANSPORT: "proxy",
      FAKE_CODEX_STARTED: startedMarker,
      FAKE_CODEX_REQUESTS: requestLog,
      FAKE_PROJECT: project,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  let piWs: WebSocket | undefined;
  let ws: WebSocket | undefined;
  let forkWs: WebSocket | undefined;
  let peerWs: WebSocket | undefined;

  try {
    await waitForHealth(baseUrl);
    const sessionToken = await login(baseUrl);
    piWs = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(sessionToken)}&agent=pi&cwd=${encodeURIComponent(project)}`,
    );
    const piEvents: Array<Record<string, unknown>> = [];
    piWs.on("message", (raw) => piEvents.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      piWs!.once("open", resolve);
      piWs!.once("error", reject);
    });
    await waitForEvent(piEvents, (event) =>
      event.type === "snapshot"
      && (event.snapshot as { agent?: unknown } | undefined)?.agent === "pi");

    const draftConnectionId = "019fef18-c752-4adc-8a5c-7fb668879ed2";
    const draftSocketUrl =
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(sessionToken)}`
      + `&agent=codex&cwd=${encodeURIComponent(project)}&draft=${draftConnectionId}`;
    ws = new WebSocket(draftSocketUrl);
    const events: Array<Record<string, unknown>> = [];
    ws.on("message", (raw) => events.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", resolve);
      ws!.once("error", reject);
    });
    await waitForEvent(events, (event) =>
      event.type === "snapshot"
      && (event.snapshot as { agent?: unknown } | undefined)?.agent === "codex");
    const catalog = await waitForEvent(events, (event) => event.type === "command_catalog");
    const catalogCommands = (catalog.commands as Array<{ name?: unknown; source?: unknown }> | undefined) ?? [];
    assert.deepEqual(catalogCommands.map((command) => command.name), [
      "settings",
      "new",
      "resume",
      "fork",
      "copy",
      "diff",
      "model",
      "reasoning",
      "rename",
      "status",
      "compact",
      "review",
    ]);
    assert.ok(catalogCommands.every((command) => command.source === "builtin"));

    const piControlStart = piEvents.length;
    const codexControlStart = events.length;
    piWs.send(JSON.stringify({ type: "prompt", text: "/session", requestId: "pi-session" }));
    ws.send(JSON.stringify({ type: "prompt", text: "/session", requestId: "codex-session" }));
    const piControl = await waitForEvent(piEvents, (event) =>
      event.type === "command_result"
      && typeof event.message === "string"
      && event.message.startsWith("Session"), piControlStart);
    const codexControl = await waitForEvent(events, (event) =>
      event.type === "command_result"
      && typeof event.message === "string"
      && event.message.startsWith("Codex session:"), codexControlStart);
    assert.match(String(piControl.message), /^Session/);
    assert.match(String(codexControl.message), /^Codex session:/);
    assert.equal(piControl.requestId, "pi-session");
    assert.equal(codexControl.requestId, "codex-session");
    assert.equal(
      piEvents.slice(piControlStart).some((event) =>
        event.type === "command_result" && String(event.message).startsWith("Codex session:")),
      false,
      "Codex control results must not leak into the Pi socket",
    );
    assert.equal(
      events.slice(codexControlStart).some((event) =>
        event.type === "command_result" && /^Session(?! name)/.test(String(event.message))),
      false,
      "Pi control results must not leak into the Codex socket",
    );
    let piReplayStart = piEvents.length;
    piWs.send(JSON.stringify({ type: "prompt", text: "/name Stable Pi name", requestId: "pi-name-replay" }));
    const piNameResult = await waitForEvent(piEvents, (event) => event.type === "command_result", piReplayStart);
    piReplayStart = piEvents.length;
    piWs.send(JSON.stringify({ type: "prompt", text: "/name Changed by replay", requestId: "pi-name-replay" }));
    const piNameReplay = await waitForEvent(
      piEvents,
      (event) => event.type === "command_result" && event.requestId === "pi-name-replay",
      piReplayStart,
    );
    assert.equal(piNameReplay.message, piNameResult.message);
    piReplayStart = piEvents.length;
    piWs.send(JSON.stringify({ type: "prompt", text: "/session", requestId: "pi-name-check" }));
    const piNamedSession = await waitForEvent(
      piEvents,
      (event) => event.type === "command_result" && event.requestId === "pi-name-check",
      piReplayStart,
    );
    assert.match(String(piNamedSession.message), /Stable Pi name/);
    assert.doesNotMatch(String(piNamedSession.message), /Changed by replay/);
    const sessionFilesBeforeCodexDraft = jsonlFiles(home);

    let draftStart = events.length;
    ws.send(JSON.stringify({ type: "prompt", text: "/rename Future task", requestId: "draft-rename" }));
    const renamed = await waitForEvent(events, (event) => event.type === "command_result", draftStart);
    assert.equal(renamed.requestId, "draft-rename");
    draftStart = events.length;
    ws.send(JSON.stringify({ type: "prompt", text: "/settings", requestId: "draft-settings" }));
    const settingsAction = await waitForEvent(events, (event) =>
      event.type === "client_action"
      && (event.action as { action?: unknown } | undefined)?.action === "open_settings", draftStart);
    assert.equal(settingsAction.requestId, "draft-settings");

    draftStart = events.length;
    ws.send(JSON.stringify({ type: "prompt", text: "/new", requestId: "draft-new" }));
    const newAction = await waitForEvent(events, (event) =>
      event.type === "client_action"
      && (event.action as { action?: unknown } | undefined)?.action === "new_session", draftStart);
    assert.equal((newAction.action as { agent?: unknown }).agent, "codex");
    assert.equal(newAction.requestId, "draft-new");

    draftStart = events.length;
    ws.send(JSON.stringify({ type: "prompt", text: "/reasoning", requestId: "draft-reasoning-menu" }));
    const reasoningAction = await waitForEvent(events, (event) =>
      event.type === "client_action"
      && (event.action as { action?: unknown } | undefined)?.action === "open_reasoning", draftStart);
    assert.equal(reasoningAction.requestId, "draft-reasoning-menu");

    draftStart = events.length;
    ws.send(JSON.stringify({ type: "prompt", text: "/reasoning medium", requestId: "draft-reasoning" }));
    const reasoningResult = await waitForEvent(events, (event) => event.type === "command_result", draftStart);
    assert.equal(reasoningResult.requestId, "draft-reasoning");

    draftStart = events.length;
    ws.send(JSON.stringify({ type: "prompt", text: "/status", requestId: "draft-status" }));
    const statusResult = await waitForEvent(events, (event) =>
      event.type === "command_result" && String(event.message).startsWith("Codex status:"), draftStart);
    assert.equal(statusResult.requestId, "draft-status");

    draftStart = events.length;
    ws.send(JSON.stringify({ type: "prompt", text: "/compact", requestId: "draft-compact" }));
    const compactError = await waitForEvent(events, (event) => event.type === "error", draftStart);
    assert.equal(compactError.requestId, "draft-compact");
    assert.match(String(compactError.message), /Send a message/);

    draftStart = events.length;
    ws.send(JSON.stringify({ type: "prompt", text: "/not-a-command", requestId: "draft-unknown" }));
    const unknownError = await waitForEvent(events, (event) => event.type === "error", draftStart);
    assert.equal(unknownError.requestId, "draft-unknown");

    // Reconnecting an unpublished draft must retain its receipt ledger. A
    // replay with the same request id returns the first terminal and cannot
    // apply changed arguments a second time.
    const closedDraft = new Promise<void>((resolve) => ws!.once("close", () => resolve()));
    ws.terminate();
    await closedDraft;
    const reconnectSnapshotStart = events.length;
    ws = new WebSocket(draftSocketUrl);
    ws.on("message", (raw) => events.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", resolve);
      ws!.once("error", reject);
    });
    await waitForEvent(events, (event) =>
      event.type === "snapshot"
      && (event.snapshot as { agent?: unknown } | undefined)?.agent === "codex", reconnectSnapshotStart);
    const draftReplayStart = events.length;
    ws.send(JSON.stringify({ type: "prompt", text: "/reasoning high", requestId: "draft-reasoning" }));
    const replayedDraftReasoning = await waitForEvent(
      events,
      (event) => event.type === "command_result" && event.requestId === "draft-reasoning",
      draftReplayStart,
    );
    assert.equal(replayedDraftReasoning.message, reasoningResult.message);

    assert.equal(existsSync(startedMarker), false, "draft-only commands must not start Codex");
    assert.equal(events.some((event) => event.type === "session_bound"), false);
    assert.deepEqual(
      jsonlFiles(home),
      sessionFilesBeforeCodexDraft,
      "Codex draft commands must not create a shadow Pi session beside the live Pi runtime",
    );

    const anchorsResponse = await fetch(
      `${baseUrl}/api/sessions/${encodeURIComponent("codex:thread-long")}/anchors`,
      { headers: { authorization: `Bearer ${sessionToken}` } },
    );
    assert.equal(anchorsResponse.status, 200);
    assert.deepEqual(await anchorsResponse.json(), {
      anchors: [
        { id: "u1", ordinal: 1, text: "first" },
        { id: "u2", ordinal: 2, text: "second" },
        { id: "u3", ordinal: 3, text: "third" },
      ],
    });

    const requests = readFileSync(requestLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: unknown; params?: Record<string, unknown> });
    assert.deepEqual(requests.filter((request) => request.method === "thread/items/list").map((request) => request.params), [
      { threadId: "thread-long", cursor: null, limit: 100, sortDirection: "asc" },
      { threadId: "thread-long", cursor: "page-2", limit: 100, sortDirection: "asc" },
    ]);

    const sourceSessionId = "codex:thread-source";
    const socketUrl =
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(sessionToken)}`
      + `&session=${encodeURIComponent(sourceSessionId)}`;
    forkWs = new WebSocket(socketUrl);
    peerWs = new WebSocket(socketUrl);
    const forkEvents: Array<Record<string, unknown>> = [];
    const peerEvents: Array<Record<string, unknown>> = [];
    forkWs.on("message", (raw) => forkEvents.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    peerWs.on("message", (raw) => peerEvents.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        forkWs!.once("open", resolve);
        forkWs!.once("error", reject);
      }),
      new Promise<void>((resolve, reject) => {
        peerWs!.once("open", resolve);
        peerWs!.once("error", reject);
      }),
    ]);
    await Promise.all([
      waitForEvent(forkEvents, (event) =>
        event.type === "snapshot"
        && (event.snapshot as { sessionId?: unknown } | undefined)?.sessionId === sourceSessionId),
      waitForEvent(peerEvents, (event) =>
        event.type === "snapshot"
        && (event.snapshot as { sessionId?: unknown } | undefined)?.sessionId === sourceSessionId),
    ]);

    let nativeCommandStart = forkEvents.length;
    forkWs.send(JSON.stringify({ type: "prompt", text: "/compact", requestId: "native-compact" }));
    const compactResult = await waitForEvent(forkEvents, (event) => event.type === "command_result", nativeCommandStart);
    assert.equal(compactResult.requestId, "native-compact");
    const compactStarting = await waitForEvent(forkEvents, (event) => {
      if (event.type !== "snapshot_delta") return false;
      const codex = (event.delta as { snapshot?: { codex?: Record<string, unknown> } } | undefined)?.snapshot?.codex;
      return codex?.controlOperation === "compact" && codex.canSteer === false && codex.canAbort === false;
    }, nativeCommandStart);
    assert.equal(
      (compactStarting.delta as { snapshot?: { codex?: { controlOperation?: unknown } } }).snapshot?.codex?.controlOperation,
      "compact",
    );
    await waitForEvent(forkEvents, (event) => {
      if (event.type !== "snapshot_delta") return false;
      const codex = (event.delta as { snapshot?: { codex?: Record<string, unknown> } } | undefined)?.snapshot?.codex;
      return codex?.controlOperation === "compact" && codex.canSteer === false && codex.canAbort === true;
    }, nativeCommandStart);
    await waitForEvent(forkEvents, (event) => event.type === "agent_end", nativeCommandStart);

    nativeCommandStart = forkEvents.length;
    forkWs.send(JSON.stringify({
      type: "prompt",
      text: "/review --base origin/main",
      requestId: "native-review",
    }));
    const reviewResult = await waitForEvent(forkEvents, (event) => event.type === "command_result", nativeCommandStart);
    assert.equal(reviewResult.requestId, "native-review");
    await waitForEvent(forkEvents, (event) => {
      if (event.type !== "snapshot_delta") return false;
      const codex = (event.delta as { snapshot?: { codex?: Record<string, unknown> } } | undefined)?.snapshot?.codex;
      return codex?.controlOperation === "review" && codex.canSteer === false && codex.canAbort === true;
    }, nativeCommandStart);
    await waitForEvent(forkEvents, (event) => event.type === "agent_end", nativeCommandStart);
    nativeCommandStart = forkEvents.length;
    forkWs.send(JSON.stringify({
      type: "prompt",
      text: "/review --base origin/main",
      requestId: "native-review",
    }));
    const replayedReview = await waitForEvent(
      forkEvents,
      (event) => event.type === "command_result" && event.requestId === "native-review",
      nativeCommandStart,
    );
    assert.equal(replayedReview.message, reviewResult.message);

    const forkStart = forkEvents.length;
    const peerStart = peerEvents.length;
    forkWs.send(JSON.stringify({ type: "fork", entryId: sourceSessionId }));
    await waitForEvent(forkEvents, (event) => event.type === "forked");
    const forkResult = forkEvents.slice(forkStart);
    const boundIndex = forkResult.findIndex((event) =>
      event.type === "session_bound" && event.sessionId === "codex:thread-forked");
    const snapshotIndex = forkResult.findIndex((event) =>
      event.type === "snapshot"
      && (event.snapshot as { sessionId?: unknown } | undefined)?.sessionId === "codex:thread-forked");
    const catalogIndex = forkResult.findIndex((event) => event.type === "command_catalog");
    const forkedIndex = forkResult.findIndex((event) => event.type === "forked");
    assert.ok(boundIndex >= 0, "fork must bind the canonical native session id");
    assert.ok(snapshotIndex > boundIndex, "the fork snapshot must follow session_bound");
    assert.ok(catalogIndex > snapshotIndex, "the fork command catalog must follow its snapshot");
    assert.ok(forkedIndex > catalogIndex, "forked must acknowledge the installed target baseline");
    assert.equal(
      peerEvents.slice(peerStart).some((event) => event.type === "session_bound"),
      false,
      "another tab on the source thread must not be rebound",
    );

    const allRequests = readFileSync(requestLog, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method?: unknown; params?: Record<string, unknown> });
    const forkRequest = allRequests.find((request) => request.method === "thread/fork");
    assert.deepEqual(forkRequest?.params, {
      threadId: "thread-source",
      cwd: project,
      runtimeWorkspaceRoots: [project],
      excludeTurns: true,
    });
    const compactRequest = allRequests.find((request) => request.method === "thread/compact/start");
    assert.deepEqual(compactRequest?.params, { threadId: "thread-source" });
    const reviewRequest = allRequests.find((request) => request.method === "review/start");
    assert.deepEqual(reviewRequest?.params, {
      threadId: "thread-source",
      target: { type: "baseBranch", branch: "origin/main" },
      delivery: "inline",
    });
    assert.equal(allRequests.filter((request) => request.method === "review/start").length, 1);
  } finally {
    piWs?.terminate();
    ws?.terminate();
    forkWs?.terminate();
    peerWs?.terminate();
    await stopChild(child);
    rmSync(home, { recursive: true, force: true });
  }
});

async function waitForEventUpTo(
  events: Array<Record<string, unknown>>,
  predicate: (event: Record<string, unknown>) => boolean,
  timeoutMs: number,
  from = 0,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = events.slice(from).find(predicate);
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("expected WebSocket event was not received");
}

test("a busy Codex thread keeps the socket open and binds once the writer conflict clears", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-web-codex-busy-"));
  const project = join(home, "project");
  const fakeCodex = join(home, "fake-codex-busy.mjs");
  mkdirSync(project, { recursive: true });
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { createInterface } from "node:readline";
const lines = createInterface({ input: process.stdin });
let resumeFails = Number(process.env.FAKE_CODEX_RESUME_FAILS ?? 0);
function respond(message, result) {
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
}
function respondError(message, text) {
  process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32000, message: text } }) + "\\n");
}
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize") { respond(message, {}); return; }
  if (message.method === "thread/read") {
    respond(message, { thread: { id: message.params?.threadId, cwd: process.env.FAKE_PROJECT, status: { type: "idle" } } });
    return;
  }
  if (message.method === "thread/resume") {
    if (resumeFails > 0) {
      resumeFails -= 1;
      respondError(message, "thread " + String(message.params?.threadId) + " already has an active writer");
      return;
    }
    respond(message, {
      thread: { id: message.params?.threadId, cwd: process.env.FAKE_PROJECT, status: { type: "active" } },
      initialTurnsPage: { data: [], nextCursor: null },
      model: "gpt-test",
      reasoningEffort: "medium",
    });
    return;
  }
  if (message.method === "thread/turns/list") {
    respond(message, {
      data: [{
        id: "turn_observe",
        status: "inProgress",
        items: [
          { type: "userMessage", id: "u_obs", content: [{ type: "text", text: "watchable prompt" }] },
          { type: "agentMessage", id: "a_obs", text: "watchable answer" },
        ],
      }],
      nextCursor: null,
    });
    return;
  }
  if (message.method === "thread/unsubscribe") { respond(message, {}); return; }
  respondError(message, "unsupported test method");
});
`);
  chmodSync(fakeCodex, 0o755);

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", "server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      PI_WEB_CWD: project,
      PI_WEB_TEST_STATE_DIR: join(home, ".pi", "web-chat"),
      PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
      PI_CODING_AGENT_SESSION_DIR: join(home, ".pi", "agent", "sessions"),
      PI_WEB_TOKEN: "codex-server-test-token",
      PI_WEB_2FA: "off",
      PI_WEB_CODEX_BIN: fakeCodex,
      PI_WEB_CODEX_TRANSPORT: "standalone",
      FAKE_CODEX_RESUME_FAILS: "2",
      FAKE_PROJECT: project,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.resume();
  child.stderr?.resume();
  let ws: WebSocket | undefined;
  try {
    await waitForHealth(baseUrl);
    const sessionToken = await login(baseUrl);
    ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(sessionToken)}`
      + `&session=${encodeURIComponent("codex:thr-busy")}`,
    );
    const events: Array<Record<string, unknown>> = [];
    let closed = false;
    ws.on("message", (raw) => events.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    ws.on("close", () => { closed = true; });
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", resolve);
      ws!.once("error", reject);
    });

    // A writer-owned thread never errors/reconnects: the same socket binds
    // directly into read-only observer mode and shows the running turn.
    // While the writer owns the thread the session must be viewable read-only:
    // the snapshot reports observer mode and carries the polled transcript.
    const observeSnapshot = await waitForEventUpTo(
      events,
      (event) =>
        event.type === "snapshot"
        && (event.snapshot as { codex?: { observer?: unknown } | undefined } | undefined)?.codex?.observer === true,
      10_000,
    );
    const observeMessages = (observeSnapshot as { snapshot?: { messages?: Array<{ content?: Array<{ text?: string }> }> } }).snapshot
      ?.messages
      ?.flatMap((message) => message.content?.map((block) => block.text ?? "").filter(Boolean) ?? []) ?? [];
    assert.ok(observeMessages.includes("watchable answer"), "the polled running turn must be visible while observing");
    assert.equal(closed, false, "the socket must stay open while observing");

    const observerCatalog = events.find((event) => event.type === "command_catalog");
    const observerCommandNames = ((observerCatalog?.commands as Array<{ name?: unknown }> | undefined) ?? [])
      .map((command) => command.name);
    assert.deepEqual(observerCommandNames, ["settings", "new", "resume", "copy", "diff", "status"]);
    const upgradeStart = events.length;
    ws.send(JSON.stringify({ type: "prompt", text: "/status", requestId: "observer-status" }));
    const observerStatus = await waitForEventUpTo(
      events,
      (event) => event.type === "command_result" && event.requestId === "observer-status",
      3_000,
    );
    assert.match(String(observerStatus.message), /Codex status: observer/);
    ws.send(JSON.stringify({ type: "prompt", text: "/model codex/blocked", requestId: "observer-model" }));
    const observerModel = await waitForEventUpTo(
      events,
      (event) => event.type === "error" && event.requestId === "observer-model",
      3_000,
    );
    assert.match(String(observerModel.message), /read-only/);
    const directModelStart = events.length;
    ws.send(JSON.stringify({ type: "set_model", provider: "codex", id: "blocked-directly" }));
    const directModel = await waitForEventUpTo(
      events,
      (event) => event.type === "error" && /Model selection/.test(String(event.message)),
      3_000,
      directModelStart,
    );
    assert.match(String(directModel.message), /read-only/);
    const directReasoningStart = events.length;
    ws.send(JSON.stringify({ type: "set_thinking_level", level: "high" }));
    const directReasoning = await waitForEventUpTo(
      events,
      (event) => event.type === "error" && /Reasoning selection/.test(String(event.message)),
      3_000,
      directReasoningStart,
    );
    assert.match(String(directReasoning.message), /read-only/);
    const directInteractionStart = events.length;
    ws.send(JSON.stringify({
      type: "codex_interaction_response",
      response: { id: "writer-owned-request", action: "accept" },
    }));
    const directInteraction = await waitForEventUpTo(
      events,
      (event) => event.type === "error" && /cannot be answered/.test(String(event.message)),
      3_000,
      directInteractionStart,
    );
    assert.match(String(directInteraction.message), /read-only/);
    const quietPollStart = events.length;
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    assert.equal(
      events.slice(quietPollStart).some((event) => event.type === "error"),
      false,
      "writer conflicts must stay silent",
    );
    assert.equal(closed, false, "socket must stay open while observing");

    // The writer releases on a later poll: the same socket upgrades to a full
    // interactive session without reconnecting.
    await waitForEventUpTo(events, (event) => event.type === "session_bound", 12_000);
    const upgraded = await waitForEventUpTo(
      events,
      (event) =>
        event.type === "snapshot"
        && (event.snapshot as { sessionId?: unknown } | undefined)?.sessionId === "codex:thr-busy"
        && (event.snapshot as { agent?: unknown } | undefined)?.agent === "codex"
        && (event.snapshot as { codex?: { observer?: unknown } | undefined } | undefined)?.codex?.observer !== true,
      12_000,
    );
    assert.equal((upgraded as { snapshot?: { sessionId?: unknown } }).snapshot?.sessionId, "codex:thr-busy");
    const upgradedCatalog = await waitForEventUpTo(
      events,
      (event) => event.type === "command_catalog"
        && ((event.commands as Array<{ name?: unknown }> | undefined) ?? [])
          .some((command) => command.name === "review"),
      4_000,
      upgradeStart,
    );
    assert.ok(((upgradedCatalog.commands as Array<{ name?: unknown }> | undefined) ?? [])
      .some((command) => command.name === "compact"));
    assert.equal(closed, false, "the socket must never close during the whole observer flow");
  } finally {
    ws?.terminate();
    await stopChild(child);
    rmSync(home, { recursive: true, force: true });
  }
});
