import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { access, readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  CodexAppServerClient,
  CodexSession,
  codexThinkingLevels,
  type CodexSessionEvent,
} from "../server/codex.ts";

type RpcEnvelope = {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
};

type MessageWaiter = {
  predicate: (message: RpcEnvelope) => boolean;
  resolve: (message: RpcEnvelope) => void;
  timer: ReturnType<typeof setTimeout>;
};

class FakeRpcProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly received: RpcEnvelope[] = [];
  killed = false;
  private inputBuffer = "";
  private waiters = new Set<MessageWaiter>();

  constructor(private readonly onRequest?: (request: RpcEnvelope, process: FakeRpcProcess) => void) {
    super();
    this.stdin.on("data", (chunk: Buffer | string) => {
      this.inputBuffer += String(chunk);
      for (;;) {
        const newline = this.inputBuffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.inputBuffer.slice(0, newline).trim();
        this.inputBuffer = this.inputBuffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line) as RpcEnvelope;
        this.received.push(message);
        this.flushWaiters(message);
        if (message.id !== undefined && message.method) {
          this.onRequest?.(message, this);
          // Every connected session now releases its native thread. Most
          // tests only care that cleanup completes, while the dedicated
          // subscription test inspects this request before this default ACK.
          if (message.method === "thread/unsubscribe") this.respond(message, {});
        }
      }
    });
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    if (this.killed) return true;
    this.killed = true;
    queueMicrotask(() => this.emit("exit", null, "SIGTERM"));
    return true;
  }

  respond(request: RpcEnvelope, result: unknown = {}): void {
    assert.notEqual(request.id, undefined, "cannot respond to a notification");
    this.stdout.write(JSON.stringify({ id: request.id, result }) + "\n");
  }

  respondError(request: RpcEnvelope, message: string, code = -32000): void {
    assert.notEqual(request.id, undefined, "cannot respond to a notification");
    this.stdout.write(JSON.stringify({ id: request.id, error: { code, message } }) + "\n");
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify({ method, params }) + "\n");
  }

  sendServerRequest(id: number | string, method: string, params: Record<string, unknown>): void {
    this.stdout.write(JSON.stringify({ id, method, params }) + "\n");
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.emit("exit", code, signal);
  }

  requests(method: string): RpcEnvelope[] {
    return this.received.filter((message) => message.id !== undefined && message.method === method);
  }

  async waitForRequest(method: string, ordinal = 1): Promise<RpcEnvelope> {
    return this.waitFor((message) => {
      if (message.id === undefined || message.method !== method) return false;
      const matches = this.received.filter((candidate) => candidate.id !== undefined && candidate.method === method);
      return matches.indexOf(message) === ordinal - 1;
    });
  }

  async waitForResponse(id: number | string): Promise<RpcEnvelope> {
    return this.waitFor((message) => message.id === id && message.method === undefined);
  }

  private waitFor(predicate: (message: RpcEnvelope) => boolean, timeoutMs = 2_000): Promise<RpcEnvelope> {
    const existing = this.received.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: MessageWaiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error("Timed out waiting for fake Codex JSON-RPC message"));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  private flushWaiters(message: RpcEnvelope): void {
    for (const waiter of this.waiters) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      this.waiters.delete(waiter);
      waiter.resolve(message);
    }
  }
}

type SpawnCall = { command: string; args: string[]; process: FakeRpcProcess };

function fakeSpawner(factory: (call: Omit<SpawnCall, "process">, index: number) => FakeRpcProcess): {
  spawnProcess: typeof spawn;
  calls: SpawnCall[];
} {
  const calls: SpawnCall[] = [];
  const spawnProcess = ((command: string, args: string[] = []) => {
    const call = { command, args: [...args] };
    const process = factory(call, calls.length);
    calls.push({ ...call, process });
    return process as unknown as ChildProcessWithoutNullStreams;
  }) as unknown as typeof spawn;
  return { spawnProcess, calls };
}

function createCoreFake(options: { autoCompleteTurns?: boolean } = {}): FakeRpcProcess {
  let nextThread = 1;
  const process = new FakeRpcProcess((request, fake) => {
    if (request.method === "initialize") {
      fake.respond(request, {});
      return;
    }
    if (request.method === "thread/start" || request.method === "thread/resume") {
      const threadId = typeof request.params?.threadId === "string"
        ? request.params.threadId
        : "thr_" + nextThread++;
      fake.respond(request, {
        thread: { id: threadId, status: { type: "idle" }, turns: [] },
        model: "gpt-test",
        reasoningEffort: "medium",
      });
      return;
    }
    if (request.method === "turn/start") {
      const threadId = String(request.params?.threadId);
      const turnId = "turn_" + threadId;
      fake.respond(request, { turn: { id: turnId, status: "inProgress" } });
      if (options.autoCompleteTurns) {
        queueMicrotask(() => {
          fake.notify("turn/started", { threadId, turn: { id: turnId, status: "inProgress" } });
          fake.notify("item/agentMessage/delta", { threadId, itemId: "item_" + threadId, delta: "done" });
          fake.notify("item/completed", {
            threadId,
            item: { type: "agentMessage", id: "item_" + threadId, text: "done" },
            completedAtMs: 123,
          });
          fake.notify("turn/completed", {
            threadId,
            turn: { id: turnId, status: "completed", error: null },
          });
        });
      }
      return;
    }
    if (request.method === "turn/steer" || request.method === "turn/interrupt") fake.respond(request, {});
  });
  return process;
}

async function nextTask(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForMissingPath(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  for (;;) {
    try {
      await access(path);
    } catch {
      return;
    }
    if (Date.now() >= deadline) throw new Error("temporary image directory was not cleaned");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("CodexSession starts a thread and maps streamed app-server events", async () => {
  const fake = createCoreFake({ autoCompleteTurns: true });
  const events: CodexSessionEvent[] = [];
  const { spawnProcess } = fakeSpawner(() => fake);
  const session = new CodexSession({
    cwd: "/tmp/project",
    onEvent: (event) => events.push(event),
    spawnProcess,
  });

  try {
    await session.prompt("hello");

    assert.equal(session.currentThreadId, "thr_1");
    assert.equal(session.currentModel, "gpt-test");
    assert.equal(session.isStreaming, false);
    assert.deepEqual(
      events.filter((event) => event.type === "text_delta").map((event) => event.delta),
      ["done"],
    );
    assert.equal(
      events.find((event) => event.type === "message" && event.message.role === "assistant")?.message.content?.[0]?.text,
      "done",
    );
    assert.ok(events.some((event) => event.type === "turn_end" && event.status === "completed"));
  } finally {
    await session.dispose();
  }
});

test("two CodexSession instances share one client and isolate notifications by threadId", async () => {
  const fake = createCoreFake();
  const { spawnProcess, calls } = fakeSpawner(() => fake);
  const client = new CodexAppServerClient({ cwd: "/tmp/project", transport: "standalone", spawnProcess });
  const firstEvents: CodexSessionEvent[] = [];
  const secondEvents: CodexSessionEvent[] = [];
  const first = new CodexSession({
    cwd: "/tmp/project-a",
    state: { threadId: "thr_a" },
    client,
    onEvent: (event) => firstEvents.push(event),
  });
  const second = new CodexSession({
    cwd: "/tmp/project-b",
    state: { threadId: "thr_b" },
    client,
    onEvent: (event) => secondEvents.push(event),
  });

  try {
    await first.connect();
    await second.connect();
    firstEvents.length = 0;
    secondEvents.length = 0;

    fake.notify("item/agentMessage/delta", { threadId: "thr_a", itemId: "a1", delta: "only a" });
    fake.notify("item/started", {
      threadId: "thr_b",
      item: { id: "b1", type: "commandExecution", command: "pwd", status: "inProgress" },
    });
    await nextTask();

    assert.equal(calls.length, 1);
    assert.deepEqual(firstEvents.filter((event) => event.type === "text_delta").map((event) => event.delta), ["only a"]);
    assert.equal(firstEvents.some((event) => event.type === "tool_start"), false);
    assert.equal(secondEvents.some((event) => event.type === "text_delta"), false);
    assert.deepEqual(
      secondEvents.filter((event) => event.type === "tool_start").map((event) => event.toolCallId),
      ["b1"],
    );
  } finally {
    await first.dispose();
    await second.dispose();
    await client.dispose();
  }
});

test("uninitialized drafts do not claim another draft's thread/started broadcast", async () => {
  const pendingStarts: RpcEnvelope[] = [];
  const fake = new FakeRpcProcess((request, process) => {
    if (request.method === "initialize") process.respond(request, {});
    else if (request.method === "thread/start") pendingStarts.push(request);
  });
  const { spawnProcess } = fakeSpawner(() => fake);
  const client = new CodexAppServerClient({ cwd: "/tmp", transport: "standalone", spawnProcess });
  const firstEvents: CodexSessionEvent[] = [];
  const secondEvents: CodexSessionEvent[] = [];
  const first = new CodexSession({ cwd: "/tmp/first", client, onEvent: (event) => firstEvents.push(event) });
  const second = new CodexSession({ cwd: "/tmp/second", client, onEvent: (event) => secondEvents.push(event) });

  try {
    const firstConnect = first.connect();
    const secondConnect = second.connect();
    await fake.waitForRequest("thread/start", 2);
    fake.notify("thread/started", { thread: { id: "thr_someone_else" } });
    await nextTask();

    assert.equal(first.currentThreadId, undefined);
    assert.equal(second.currentThreadId, undefined);
    assert.equal(firstEvents.some((event) => event.type === "thread_ready"), false);
    assert.equal(secondEvents.some((event) => event.type === "thread_ready"), false);

    fake.respond(pendingStarts[0]!, { thread: { id: "thr_first", status: { type: "idle" } } });
    fake.respond(pendingStarts[1]!, { thread: { id: "thr_second", status: { type: "idle" } } });
    await Promise.all([firstConnect, secondConnect]);
    assert.equal(first.currentThreadId, "thr_first");
    assert.equal(second.currentThreadId, "thr_second");
  } finally {
    await first.dispose();
    await second.dispose();
    await client.dispose();
  }
});

test("only the last shared session disposal unsubscribes a retained native thread", async () => {
  const fake = createCoreFake();
  const { spawnProcess } = fakeSpawner(() => fake);
  const client = new CodexAppServerClient({ cwd: "/tmp/project", transport: "standalone", spawnProcess });
  const first = new CodexSession({ cwd: "/tmp/project", state: { threadId: "thr_shared" }, client });
  const second = new CodexSession({ cwd: "/tmp/project", state: { threadId: "thr_shared" }, client });

  try {
    await first.connect();
    await second.connect();
    await first.dispose();
    assert.equal(fake.requests("thread/unsubscribe").length, 0);

    await second.dispose();
    assert.equal(fake.requests("thread/unsubscribe").length, 1);
    assert.deepEqual(fake.requests("thread/unsubscribe")[0]?.params, { threadId: "thr_shared" });
  } finally {
    await first.dispose();
    await second.dispose();
    await client.dispose();
  }
});

test("auto transport tries the shared proxy before falling back to standalone", async () => {
  const first = new FakeRpcProcess((request, fake) => {
    if (request.method === "initialize") fake.respondError(request, "shared daemon unavailable");
  });
  const standalone = createCoreFake();
  const { spawnProcess, calls } = fakeSpawner((_call, index) => index === 0 ? first : standalone);
  const client = new CodexAppServerClient({ cwd: "/tmp/project", transport: "auto", spawnProcess });

  try {
    await client.connect();
    assert.deepEqual(calls.map((call) => call.args), [
      ["app-server", "proxy"],
      ["app-server", "--listen", "stdio://"],
    ]);
    assert.equal(first.killed, true);
    assert.equal(client.activeTransport, "standalone");
  } finally {
    await client.dispose();
  }
});

test("ultra reasoning remains selectable and is forwarded to turn/start", async () => {
  const fake = createCoreFake();
  const { spawnProcess } = fakeSpawner(() => fake);
  const session = new CodexSession({ cwd: "/tmp/project", state: { threadId: "thr_ultra" }, spawnProcess });

  try {
    await session.connect();
    session.setEffort("ULTRA");
    assert.equal(session.currentEffort, "ultra");
    assert.deepEqual(codexThinkingLevels({
      id: "gpt-ultra",
      model: "gpt-ultra",
      displayName: "GPT Ultra",
      isDefault: true,
      defaultReasoningEffort: "ultra",
      supportedReasoningEfforts: [
        { reasoningEffort: "high" },
        { reasoningEffort: "ultra" },
      ],
    }), ["high", "ultra"]);

    const prompt = session.prompt("reason deeply");
    const start = await fake.waitForRequest("turn/start");
    assert.equal(start.params?.effort, "ultra");
    fake.notify("turn/completed", {
      threadId: "thr_ultra",
      turn: { id: "turn_thr_ultra", status: "completed", error: null },
    });
    await prompt;
  } finally {
    await session.dispose();
  }
});

test("CodexSession resumes and hydrates initialTurnsPage in chronological order", async () => {
  const process = new FakeRpcProcess((request, fake) => {
    if (request.method === "initialize") {
      fake.respond(request, {});
      return;
    }
    if (request.method === "thread/resume") {
      fake.respond(request, {
        thread: { id: "thr_saved", status: { type: "idle" } },
        model: "gpt-history",
        reasoningEffort: "high",
        initialTurnsPage: {
          data: [
            {
              id: "turn_new",
              status: "completed",
              startedAt: 20,
              items: [{ id: "assistant_new", type: "agentMessage", text: "new answer" }],
            },
            {
              id: "turn_old",
              status: "completed",
              startedAt: 10,
              items: [{ id: "user_old", type: "userMessage", content: [{ type: "text", text: "old question" }] }],
            },
          ],
          nextCursor: "older-cursor",
        },
      });
    }
  });
  const { spawnProcess } = fakeSpawner(() => process);
  const events: CodexSessionEvent[] = [];
  const session = new CodexSession({
    cwd: "/tmp/project",
    state: { threadId: "thr_saved" },
    onEvent: (event) => events.push(event),
    spawnProcess,
  });

  try {
    await session.connect();
    const resume = process.requests("thread/resume")[0]!;
    assert.deepEqual(resume.params?.initialTurnsPage, {
      limit: 50,
      sortDirection: "desc",
      itemsView: "full",
    });
    assert.equal(process.requests("thread/start").length, 0);
    const history = events.find((event) => event.type === "history");
    assert.ok(history && history.type === "history");
    assert.equal(history.cursor, "older-cursor");
    assert.deepEqual(history.messages.map((message) => message.role), ["user", "assistant"]);
    assert.equal((history.messages[0]?.content as Array<{ text?: string }>)[0]?.text, "old question");
    assert.equal((history.messages[1]?.content as Array<{ text?: string }>)[0]?.text, "new answer");
    assert.equal(session.currentModel, "gpt-history");
    assert.equal(session.currentEffort, "high");
  } finally {
    await session.dispose();
  }
});

test("history invalidation received during a refresh schedules one deterministic rerun", async () => {
  const pendingRefreshes: RpcEnvelope[] = [];
  const process = new FakeRpcProcess((request, fake) => {
    if (request.method === "initialize") fake.respond(request, {});
    else if (request.method === "thread/resume") {
      fake.respond(request, {
        thread: { id: "thr_refresh_dirty", status: { type: "idle" } },
        initialTurnsPage: { data: [], nextCursor: null },
      });
    } else if (request.method === "thread/turns/list") {
      pendingRefreshes.push(request);
    }
  });
  const { spawnProcess } = fakeSpawner(() => process);
  const events: CodexSessionEvent[] = [];
  const session = new CodexSession({
    cwd: "/tmp/project",
    state: { threadId: "thr_refresh_dirty" },
    onEvent: (event) => events.push(event),
    spawnProcess,
  });

  try {
    await session.connect();
    events.length = 0;
    process.notify("thread/reverted", { threadId: "thr_refresh_dirty" });
    const first = await process.waitForRequest("thread/turns/list");

    // This second invalidation lands while the first history RPC is still
    // unresolved. It must mark the session dirty instead of being coalesced
    // away forever.
    process.notify("thread/compacted", { threadId: "thr_refresh_dirty" });
    await nextTask();
    assert.equal(process.requests("thread/turns/list").length, 1);

    process.respond(first, {
      data: [{
        id: "turn_first_refresh",
        status: "completed",
        items: [{ id: "first_answer", type: "agentMessage", text: "first refresh" }],
      }],
      nextCursor: null,
    });
    const second = await process.waitForRequest("thread/turns/list", 2);
    assert.equal(pendingRefreshes.length, 2);
    process.respond(second, {
      data: [{
        id: "turn_second_refresh",
        status: "completed",
        items: [{ id: "second_answer", type: "agentMessage", text: "second refresh" }],
      }],
      nextCursor: null,
    });

    await waitUntil(
      () => events.filter((event) => event.type === "history").length === 2,
      "dirty history refresh did not publish its rerun",
    );
    const historyEvents = events.filter((event) => event.type === "history");
    const latest = historyEvents.at(-1);
    assert.ok(latest && latest.type === "history");
    assert.equal((latest.messages[0]?.content as Array<{ text?: string }>)[0]?.text, "second refresh");
    assert.equal(process.requests("thread/turns/list").length, 2);
  } finally {
    await session.dispose();
  }
});

test("native compact and review commands use structured thread RPCs and publish review lifecycle items", async () => {
  const process = new FakeRpcProcess((request, fake) => {
    if (request.method === "initialize") fake.respond(request, {});
    else if (request.method === "thread/resume") {
      fake.respond(request, {
        thread: { id: "thr_commands", status: { type: "idle" } },
        initialTurnsPage: { data: [], nextCursor: null },
      });
    } else if (request.method === "thread/compact/start") {
      fake.respond(request, {});
    } else if (request.method === "review/start") {
      const turn = { id: "turn_review", status: "inProgress", items: [] };
      fake.respond(request, { turn, reviewThreadId: "thr_commands" });
    }
  });
  const { spawnProcess } = fakeSpawner(() => process);
  const events: CodexSessionEvent[] = [];
  const session = new CodexSession({
    cwd: "/tmp/project",
    state: { threadId: "thr_commands" },
    onEvent: (event) => events.push(event),
    spawnProcess,
  });

  try {
    await session.connect();
    events.length = 0;
    await session.compact();
    assert.deepEqual(process.requests("thread/compact/start")[0]?.params, { threadId: "thr_commands" });
    assert.equal(session.isStreaming, true, "accepted compaction must occupy the response/notification gap");
    assert.equal(session.controlOperation, "compact");
    assert.equal(session.canSteer, false);
    assert.equal(session.canAbort, false, "stop must stay disabled until app-server publishes a turn id");
    await assert.rejects(
      session.review({ type: "uncommittedChanges" }),
      /compact is already running/,
    );
    await assert.rejects(session.prompt("do not race compaction"), /compact is running/);
    process.notify("turn/started", {
      threadId: "thr_commands",
      turn: { id: "turn_compact", status: "inProgress" },
    });
    assert.equal(session.controlOperation, "compact", "control turns stay non-steerable after turn/started");
    assert.equal(session.canSteer, false);
    assert.equal(session.canAbort, true);
    await assert.rejects(session.prompt("still do not steer compaction"), /compact is running/);
    process.notify("item/completed", {
      threadId: "thr_commands",
      item: { type: "contextCompaction", id: "compact_item" },
    });
    process.notify("turn/completed", {
      threadId: "thr_commands",
      turn: { id: "turn_compact", status: "completed" },
    });
    await waitUntil(() => !session.isStreaming, "compaction lifecycle did not release its barrier");

    await session.review({ type: "baseBranch", branch: "origin/main" });
    assert.deepEqual(process.requests("review/start")[0]?.params, {
      threadId: "thr_commands",
      target: { type: "baseBranch", branch: "origin/main" },
      delivery: "inline",
    });
    assert.equal(session.controlOperation, "review");
    assert.equal(session.canSteer, false);
    assert.equal(session.canAbort, true);
    await assert.rejects(session.prompt("do not steer review"), /review is running/);
    process.notify("item/completed", {
      threadId: "thr_commands",
      item: { type: "enteredReviewMode", id: "review_mode", review: "Review started" },
    });
    process.notify("turn/completed", {
      threadId: "thr_commands",
      turn: { id: "turn_review", status: "completed", items: [] },
    });
    await waitUntil(() => events.some((event) => event.type === "turn_end"), "review turn did not complete");
    const lifecycleMessage = events.find((event) =>
      event.type === "message"
      && (event.message.content as Array<{ thinking?: unknown }> | undefined)?.[0]?.thinking === "Review started");
    assert.ok(lifecycleMessage);
    assert.equal(session.isStreaming, false);
  } finally {
    await session.dispose();
  }
});

test("prompt preparation reserves the thread against compact and review", async () => {
  const process = new FakeRpcProcess((request, fake) => {
    if (request.method === "initialize") fake.respond(request, {});
    else if (request.method === "thread/resume") {
      fake.respond(request, {
        thread: { id: "thr_prompt_reservation", status: { type: "idle" } },
        initialTurnsPage: { data: [], nextCursor: null },
      });
    } else if (request.method === "turn/start") {
      fake.respond(request, { turn: { id: "turn_prompt_reservation", status: "inProgress" } });
      queueMicrotask(() => {
        fake.notify("turn/completed", {
          threadId: "thr_prompt_reservation",
          turn: { id: "turn_prompt_reservation", status: "completed", items: [] },
        });
      });
    }
  });
  const { spawnProcess } = fakeSpawner(() => process);
  const session = new CodexSession({
    cwd: "/tmp/project",
    state: { threadId: "thr_prompt_reservation" },
    spawnProcess,
  });
  let releaseInput!: () => void;
  let inputStarted!: () => void;
  const inputGate = new Promise<void>((resolve) => { releaseInput = resolve; });
  const started = new Promise<void>((resolve) => { inputStarted = resolve; });

  try {
    await session.connect();
    (session as unknown as {
      createInput: () => Promise<{ input: []; cleanup: () => Promise<void> }>;
    }).createInput = async () => {
      inputStarted();
      await inputGate;
      return { input: [], cleanup: async () => {} };
    };

    const prompt = session.prompt("image prompt under preparation");
    await started;
    await assert.rejects(session.compact(), /pending Codex prompt/);
    await assert.rejects(session.review({ type: "uncommittedChanges" }), /pending Codex prompt/);
    assert.equal(process.requests("thread/compact/start").length, 0);
    assert.equal(process.requests("review/start").length, 0);

    releaseInput();
    await prompt;
    assert.equal(process.requests("turn/start").length, 1);
  } finally {
    releaseInput();
    await session.dispose();
  }
});

test("resuming and starting a turn do not overwrite native thread runtime policy", async () => {
  const process = new FakeRpcProcess((request, fake) => {
    if (request.method === "initialize") fake.respond(request, {});
    else if (request.method === "thread/resume") {
      fake.respond(request, {
        thread: { id: "thr_native_policy", status: { type: "idle" } },
        model: "gpt-native",
        reasoningEffort: "high",
        initialTurnsPage: { data: [], nextCursor: null },
      });
    } else if (request.method === "turn/start") {
      fake.respond(request, { turn: { id: "turn_native_policy", status: "inProgress" } });
    }
  });
  const { spawnProcess } = fakeSpawner(() => process);
  const session = new CodexSession({
    cwd: "/tmp/web-cwd-must-not-win",
    state: { threadId: "thr_native_policy" },
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    spawnProcess,
  });
  const policyKeys = [
    "cwd",
    "approvalPolicy",
    "approvalsReviewer",
    "sandbox",
    "sandboxPolicy",
    "runtimeWorkspaceRoots",
  ];

  try {
    await session.connect();
    const resume = process.requests("thread/resume")[0]!;
    for (const key of policyKeys) assert.equal(key in (resume.params ?? {}), false, "thread/resume sent " + key);

    const prompt = session.prompt("continue with the native policy");
    const start = await process.waitForRequest("turn/start");
    for (const key of policyKeys) assert.equal(key in (start.params ?? {}), false, "turn/start sent " + key);
    process.notify("turn/completed", {
      threadId: "thr_native_policy",
      turn: { id: "turn_native_policy", status: "completed", error: null },
    });
    await prompt;
  } finally {
    await session.dispose();
  }
});

test("native settings can clear reasoning effort and move the authoritative cwd", async () => {
  const process = new FakeRpcProcess((request, fake) => {
    if (request.method === "initialize") fake.respond(request, {});
    else if (request.method === "thread/resume") {
      fake.respond(request, {
        thread: { id: "thr_native_settings", cwd: "/tmp/native-a", status: { type: "idle" } },
        model: "gpt-native",
        reasoningEffort: null,
        initialTurnsPage: { data: [], nextCursor: null },
      });
    }
  });
  const { spawnProcess } = fakeSpawner(() => process);
  const events: CodexSessionEvent[] = [];
  const session = new CodexSession({
    cwd: "/tmp/web-cwd-must-not-win",
    state: { threadId: "thr_native_settings", effort: "high" },
    onEvent: (event) => events.push(event),
    spawnProcess,
  });

  try {
    await session.connect();
    assert.equal(session.currentEffort, undefined);
    assert.equal(session.currentCwd, "/tmp/native-a");
    assert.ok(events.some((event) =>
      event.type === "thread_ready"
      && event.cwd === "/tmp/native-a"
      && event.effort === null));

    process.notify("thread/settings/updated", {
      threadId: "thr_native_settings",
      threadSettings: { model: "gpt-native", effort: null, cwd: "/tmp/native-b" },
    });
    await nextTask();

    assert.equal(session.currentEffort, undefined);
    assert.equal(session.currentCwd, "/tmp/native-b");
    assert.ok(events.some((event) =>
      event.type === "thread_ready"
      && event.cwd === "/tmp/native-b"
      && event.effort === null));
  } finally {
    await session.dispose();
  }
});

test("resume restores only inProgress tools from the active turn", async () => {
  const process = new FakeRpcProcess((request, fake) => {
    if (request.method === "initialize") fake.respond(request, {});
    else if (request.method === "thread/resume") {
      fake.respond(request, {
        thread: { id: "thr_active_tools", status: { type: "active" } },
        initialTurnsPage: {
          data: [{
            id: "turn_active",
            status: "inProgress",
            items: [
              { id: "review_mode", type: "enteredReviewMode", review: "Reviewing changes" },
              { id: "tool_live", type: "commandExecution", command: "npm test", status: "inProgress" },
              { id: "tool_done", type: "commandExecution", command: "pwd", status: "completed", aggregatedOutput: "/tmp" },
              { id: "tool_failed", type: "commandExecution", command: "false", status: "failed", aggregatedOutput: "failed" },
              { id: "tool_unknown", type: "commandExecution", command: "echo queued" },
            ],
          }],
          nextCursor: null,
        },
      });
    }
  });
  const { spawnProcess } = fakeSpawner(() => process);
  const events: CodexSessionEvent[] = [];
  const session = new CodexSession({
    cwd: "/tmp/project",
    state: { threadId: "thr_active_tools" },
    onEvent: (event) => events.push(event),
    spawnProcess,
  });

  try {
    await session.connect();
    assert.deepEqual(session.activeTools.map((tool) => tool.toolCallId), ["tool_live"]);
    assert.equal(session.controlOperation, "review");
    assert.equal(session.canSteer, false, "a resumed review turn must not accept turn/steer");
    assert.equal(session.canAbort, true);
    const history = events.find((event) => event.type === "history");
    assert.ok(history && history.type === "history");
    assert.deepEqual(history.activeTools.map((tool) => tool.toolCallId), ["tool_live"]);
    assert.equal(session.isStreaming, true);
  } finally {
    await session.dispose();
  }
});

test("external user messages stream live while local client ids suppress echoed duplicates", async () => {
  const fake = createCoreFake();
  const { spawnProcess } = fakeSpawner(() => fake);
  const events: CodexSessionEvent[] = [];
  const session = new CodexSession({
    cwd: "/tmp/project",
    state: { threadId: "thr_user_messages" },
    onEvent: (event) => events.push(event),
    spawnProcess,
  });

  try {
    await session.connect();
    events.length = 0;
    fake.notify("item/completed", {
      threadId: "thr_user_messages",
      item: {
        id: "external_user_item",
        type: "userMessage",
        clientId: "another-codex-client",
        content: [{ type: "text", text: "external guidance" }],
      },
    });
    await nextTask();
    assert.deepEqual(
      events
        .filter((event) => event.type === "message" && event.message.role === "user")
        .map((event) => event.type === "message" ? (event.message.content as Array<{ text?: string }>)[0]?.text : undefined),
      ["external guidance"],
    );

    const prompt = session.prompt("local guidance", [], "web-client-message-1");
    const start = await fake.waitForRequest("turn/start");
    assert.equal(start.params?.clientUserMessageId, "web-client-message-1");
    await waitUntil(
      () => events.filter((event) => event.type === "message" && event.message.role === "user").length === 2,
      "local optimistic user message was not emitted",
    );
    fake.notify("item/completed", {
      threadId: "thr_user_messages",
      item: {
        id: "local_user_echo",
        type: "userMessage",
        clientId: "web-client-message-1",
        content: [{ type: "text", text: "local guidance" }],
      },
    });
    await nextTask();
    assert.deepEqual(
      events
        .filter((event) => event.type === "message" && event.message.role === "user")
        .map((event) => event.type === "message" ? (event.message.content as Array<{ text?: string }>)[0]?.text : undefined),
      ["external guidance", "local guidance"],
    );

    fake.notify("turn/completed", {
      threadId: "thr_user_messages",
      turn: { id: "turn_thr_user_messages", status: "completed", error: null },
    });
    await prompt;
  } finally {
    await session.dispose();
  }
});

test("command and file approvals block until the UI responds and preserve the decision", async () => {
  const fake = createCoreFake();
  const { spawnProcess } = fakeSpawner(() => fake);
  const events: CodexSessionEvent[] = [];
  const session = new CodexSession({
    cwd: "/tmp/project",
    state: { threadId: "thr_approval" },
    onEvent: (event) => events.push(event),
    spawnProcess,
  });

  try {
    await session.connect();
    fake.sendServerRequest(700, "item/commandExecution/requestApproval", {
      threadId: "thr_approval",
      command: ["npm", "test"],
      cwd: "/tmp/project",
      reason: "Run regression tests",
      availableDecisions: ["accept", "acceptForSession", "decline"],
    });
    await waitUntil(() => session.pendingInteractions.length === 1, "command approval was not surfaced");
    await nextTask();
    assert.equal(fake.received.some((message) => message.id === 700 && message.method === undefined), false);
    const command = session.pendingInteractions[0]!;
    assert.equal(command.kind, "command_approval");
    assert.equal(command.kind === "command_approval" ? command.command : "", "npm test");
    assert.equal(command.kind === "command_approval" ? command.allowSessionApproval : false, true);
    assert.equal(session.respondToInteraction({ id: command.id, action: "accept_for_session" }), true);
    assert.deepEqual((await fake.waitForResponse(700)).result, { decision: "acceptForSession" });

    fake.sendServerRequest(701, "item/fileChange/requestApproval", {
      threadId: "thr_approval",
      reason: "Apply generated patch",
      grantRoot: "/tmp/project",
      fileChanges: [{ path: "src/a.ts", kind: "update" }],
    });
    await waitUntil(() => session.pendingInteractions.length === 1, "file approval was not surfaced");
    const file = session.pendingInteractions[0]!;
    assert.equal(file.kind, "file_approval");
    assert.equal(session.respondToInteraction({ id: file.id, action: "decline" }), true);
    assert.deepEqual((await fake.waitForResponse(701)).result, { decision: "decline" });
    assert.equal(session.pendingInteractions.length, 0);
    assert.ok(events.filter((event) => event.type === "interaction_resolved").length >= 2);
  } finally {
    await session.dispose();
  }
});

test("file approvals inherit item changes and live turn diffs including an empty update", async () => {
  const fake = createCoreFake();
  const { spawnProcess } = fakeSpawner(() => fake);
  const events: CodexSessionEvent[] = [];
  const session = new CodexSession({
    cwd: "/tmp/project",
    state: { threadId: "thr_file_evidence" },
    onEvent: (event) => events.push(event),
    spawnProcess,
  });
  const itemChanges = [{ path: "src/a.ts", kind: "update", diff: "@@ -1 +1 @@\n-old\n+new" }];

  try {
    await session.connect();
    fake.notify("item/started", {
      threadId: "thr_file_evidence",
      item: { id: "file_item", type: "fileChange", status: "inProgress", changes: itemChanges },
    });
    fake.sendServerRequest(705, "item/fileChange/requestApproval", {
      threadId: "thr_file_evidence",
      itemId: "file_item",
      reason: "Apply item changes",
    });
    await waitUntil(() => session.pendingInteractions.length === 1, "item-backed file approval was not surfaced");
    const itemApproval = session.pendingInteractions[0]!;
    assert.equal(itemApproval.kind, "file_approval");
    assert.deepEqual(itemApproval.kind === "file_approval" ? itemApproval.changes : undefined, itemChanges);
    session.respondToInteraction({ id: itemApproval.id, action: "decline" });
    await fake.waitForResponse(705);

    fake.sendServerRequest(706, "item/fileChange/requestApproval", {
      threadId: "thr_file_evidence",
      turnId: "turn_diff",
      reason: "Apply turn diff",
    });
    await waitUntil(() => session.pendingInteractions.length === 1, "turn-backed file approval was not surfaced");
    const turnApprovalId = session.pendingInteractions[0]!.id;
    fake.notify("turn/diff/updated", {
      threadId: "thr_file_evidence",
      turnId: "turn_diff",
      diff: "@@ -2 +2 @@\n-before\n+after",
    });
    await waitUntil(
      () => {
        const pending = session.pendingInteractions[0];
        return pending?.kind === "file_approval" && pending.changes === "@@ -2 +2 @@\n-before\n+after";
      },
      "turn diff was not attached to the pending approval",
    );
    fake.notify("turn/diff/updated", {
      threadId: "thr_file_evidence",
      turnId: "turn_diff",
      diff: "",
    });
    await waitUntil(
      () => {
        const pending = session.pendingInteractions[0];
        return pending?.kind === "file_approval" && pending.changes === "";
      },
      "empty turn diff did not clear stale approval evidence",
    );
    assert.ok(events.some((event) =>
      event.type === "interaction"
      && event.interaction.id === turnApprovalId
      && event.interaction.kind === "file_approval"
      && event.interaction.changes === ""
    ));
    session.respondToInteraction({ id: turnApprovalId, action: "decline" });
    await fake.waitForResponse(706);

    fake.sendServerRequest(707, "item/fileChange/requestApproval", {
      threadId: "thr_file_evidence",
      turnId: "turn_diff",
    });
    await waitUntil(() => session.pendingInteractions.length === 1, "cached empty diff approval was not surfaced");
    const cachedEmpty = session.pendingInteractions[0]!;
    assert.equal(cachedEmpty.kind, "file_approval");
    assert.equal(cachedEmpty.kind === "file_approval" ? cachedEmpty.changes : undefined, "");
    session.respondToInteraction({ id: cachedEmpty.id, action: "decline" });
    await fake.waitForResponse(707);
  } finally {
    await session.dispose();
  }
});

test("requestUserInput is surfaced with options and sends structured answers", async () => {
  const fake = createCoreFake();
  const { spawnProcess } = fakeSpawner(() => fake);
  const session = new CodexSession({ cwd: "/tmp/project", state: { threadId: "thr_input" }, spawnProcess });

  try {
    await session.connect();
    fake.sendServerRequest(710, "item/tool/requestUserInput", {
      threadId: "thr_input",
      questions: [
        {
          id: "strategy",
          header: "Strategy",
          question: "Which approach?",
          options: [
            { label: "Repair", description: "Keep compatibility" },
            { label: "Rewrite", description: "Replace the adapter" },
          ],
          isOther: true,
        },
      ],
    });
    await waitUntil(() => session.pendingInteractions.length === 1, "user input was not surfaced");
    const interaction = session.pendingInteractions[0]!;
    assert.equal(interaction.kind, "user_input");
    if (interaction.kind !== "user_input") throw new Error("wrong interaction kind");
    assert.deepEqual(interaction.questions[0], {
      id: "strategy",
      header: "Strategy",
      question: "Which approach?",
      options: [
        { label: "Repair", description: "Keep compatibility" },
        { label: "Rewrite", description: "Replace the adapter" },
      ],
      allowOther: true,
      secret: false,
    });
    assert.equal(session.respondToInteraction({
      id: interaction.id,
      action: "submit",
      answers: { strategy: ["Rewrite"] },
    }), true);
    assert.deepEqual((await fake.waitForResponse(710)).result, {
      answers: { strategy: { answers: ["Rewrite"] } },
    });
    assert.equal(session.respondToInteraction({ id: interaction.id, action: "cancel" }), false);
  } finally {
    await session.dispose();
  }
});

test("serverRequest/resolved dismisses the interaction without racing a JSON-RPC response", async () => {
  const fake = createCoreFake();
  const { spawnProcess } = fakeSpawner(() => fake);
  const events: CodexSessionEvent[] = [];
  const session = new CodexSession({
    cwd: "/tmp/project",
    state: { threadId: "thr_resolved_elsewhere" },
    onEvent: (event) => events.push(event),
    spawnProcess,
  });

  try {
    await session.connect();
    fake.sendServerRequest(715, "item/commandExecution/requestApproval", {
      threadId: "thr_resolved_elsewhere",
      command: "git status",
      availableDecisions: ["accept", "decline"],
    });
    await waitUntil(() => session.pendingInteractions.length === 1, "approval was not surfaced");
    const interactionId = session.pendingInteractions[0]!.id;

    fake.notify("serverRequest/resolved", {
      threadId: "thr_resolved_elsewhere",
      requestId: 715,
    });
    await waitUntil(() => session.pendingInteractions.length === 0, "resolved approval remained visible");
    await nextTask();

    assert.ok(events.some((event) => event.type === "interaction_resolved" && event.id === interactionId));
    assert.equal(
      fake.received.some((message) => message.id === 715 && message.method === undefined),
      false,
      "the observing Web client must not answer a request resolved by another client",
    );
  } finally {
    await session.dispose();
  }
});

test("canceling requestUserInput suppresses empty answers and interrupts the active turn", async () => {
  const fake = createCoreFake();
  const { spawnProcess } = fakeSpawner(() => fake);
  const session = new CodexSession({ cwd: "/tmp/project", spawnProcess });

  try {
    const prompt = session.prompt("ask me before choosing");
    const start = await fake.waitForRequest("turn/start");
    const threadId = String(start.params?.threadId);
    const turnId = "turn_" + threadId;
    await waitUntil(() => session.isStreaming, "turn did not enter streaming state");
    fake.sendServerRequest(716, "item/tool/requestUserInput", {
      threadId,
      turnId,
      questions: [{ id: "choice", header: "Choice", question: "Continue?" }],
    });
    await waitUntil(() => session.pendingInteractions.length === 1, "requestUserInput was not surfaced");
    const interaction = session.pendingInteractions[0]!;
    assert.equal(interaction.kind, "user_input");
    assert.equal(session.respondToInteraction({ id: interaction.id, action: "cancel" }), true);

    const interrupt = await fake.waitForRequest("turn/interrupt");
    assert.deepEqual(interrupt.params, { threadId, turnId });
    await nextTask();
    assert.equal(
      fake.received.some((message) => message.id === 716 && message.method === undefined),
      false,
      "cancel must not masquerade as a successful empty answers response",
    );

    fake.notify("turn/completed", {
      threadId,
      turn: { id: turnId, status: "interrupted", error: null },
    });
    await prompt;
  } finally {
    await session.dispose();
  }
});

test("permissions approval returns only the requested grants and selected scope", async () => {
  const fake = createCoreFake();
  const { spawnProcess } = fakeSpawner(() => fake);
  const session = new CodexSession({ cwd: "/tmp/project", state: { threadId: "thr_permissions" }, spawnProcess });
  const requestedPermissions = {
    network: { hosts: ["api.example.test"] },
    fileSystem: { write: ["/tmp/project/generated"] },
  };

  try {
    await session.connect();
    fake.sendServerRequest(720, "item/permissions/requestApproval", {
      threadId: "thr_permissions",
      cwd: "/tmp/project",
      reason: "Generate an artifact",
      permissions: requestedPermissions,
    });
    await waitUntil(() => session.pendingInteractions.length === 1, "permissions approval was not surfaced");
    const accepted = session.pendingInteractions[0]!;
    assert.equal(accepted.kind, "permissions_approval");
    assert.equal(session.respondToInteraction({
      id: accepted.id,
      action: "accept",
      scope: "session",
      // Extra response content must never become an unsolicited permission grant.
      content: { network: { hosts: ["*"] } },
    }), true);
    assert.deepEqual((await fake.waitForResponse(720)).result, {
      permissions: requestedPermissions,
      scope: "session",
    });

    fake.sendServerRequest(721, "item/permissions/requestApproval", {
      threadId: "thr_permissions",
      permissions: requestedPermissions,
    });
    await waitUntil(() => session.pendingInteractions.length === 1, "second permissions approval was not surfaced");
    const declined = session.pendingInteractions[0]!;
    assert.equal(session.respondToInteraction({ id: declined.id, action: "decline" }), true);
    assert.deepEqual((await fake.waitForResponse(721)).result, {
      permissions: {},
      scope: "turn",
    });
  } finally {
    await session.dispose();
  }
});

test("MCP form and URL elicitation preserve accept and decline semantics", async () => {
  const fake = createCoreFake();
  const { spawnProcess } = fakeSpawner(() => fake);
  const session = new CodexSession({ cwd: "/tmp/project", state: { threadId: "thr_mcp" }, spawnProcess });

  try {
    await session.connect();
    fake.sendServerRequest(730, "mcpServer/elicitation/request", {
      threadId: "thr_mcp",
      serverName: "issue-tracker",
      message: "Choose the destination project",
      mode: "form",
      requestedSchema: {
        type: "object",
        properties: { project: { type: "string" } },
        required: ["project"],
      },
    });
    await waitUntil(() => session.pendingInteractions.length === 1, "MCP form elicitation was not surfaced");
    const form = session.pendingInteractions[0]!;
    assert.equal(form.kind, "mcp_elicitation");
    if (form.kind !== "mcp_elicitation") throw new Error("wrong interaction kind");
    assert.equal(form.mode, "form");
    assert.deepEqual(form.schema, {
      type: "object",
      properties: { project: { type: "string" } },
      required: ["project"],
    });
    assert.equal(session.respondToInteraction({
      id: form.id,
      action: "submit",
      content: { project: "web-chat" },
    }), true);
    assert.deepEqual((await fake.waitForResponse(730)).result, {
      action: "accept",
      content: { project: "web-chat" },
      _meta: null,
    });

    fake.sendServerRequest(731, "mcpServer/elicitation/request", {
      threadId: "thr_mcp",
      serverName: "oauth-provider",
      message: "Authorize access in the browser",
      mode: "url",
      url: "https://example.test/authorize",
    });
    await waitUntil(() => session.pendingInteractions.length === 1, "MCP URL elicitation was not surfaced");
    const url = session.pendingInteractions[0]!;
    assert.equal(url.kind, "mcp_elicitation");
    if (url.kind !== "mcp_elicitation") throw new Error("wrong interaction kind");
    assert.equal(url.mode, "url");
    assert.equal(url.url, "https://example.test/authorize");
    assert.equal(session.respondToInteraction({ id: url.id, action: "decline" }), true);
    assert.deepEqual((await fake.waitForResponse(731)).result, {
      action: "decline",
      content: null,
      _meta: null,
    });
  } finally {
    await session.dispose();
  }
});

test("a shared client leaves approvals for unowned threads unanswered", async () => {
  const fake = createCoreFake();
  const { spawnProcess } = fakeSpawner(() => fake);
  const client = new CodexAppServerClient({ cwd: "/tmp/project", transport: "standalone", spawnProcess });
  const session = new CodexSession({
    cwd: "/tmp/project",
    state: { threadId: "thr_owned" },
    client,
  });

  try {
    await session.connect();
    fake.sendServerRequest(740, "item/commandExecution/requestApproval", {
      threadId: "thr_owned_elsewhere",
      command: "git status",
      availableDecisions: ["accept", "decline"],
    });
    await nextTask();
    assert.equal(session.pendingInteractions.length, 0);
    assert.equal(
      fake.received.some((message) => message.id === 740 && message.method === undefined),
      false,
      "the proxy must not reject or auto-answer another Codex client's approval",
    );
  } finally {
    await session.dispose();
    await client.dispose();
  }
});

test("a second prompt during turn/start steers the same turn instead of starting another", async () => {
  let delayedTurnStart: RpcEnvelope | undefined;
  const process = new FakeRpcProcess((request, fake) => {
    if (request.method === "initialize") fake.respond(request, {});
    else if (request.method === "thread/start") {
      fake.respond(request, { thread: { id: "thr_steer", status: { type: "idle" } }, model: "gpt-test" });
    } else if (request.method === "turn/start") delayedTurnStart = request;
    else if (request.method === "turn/steer") fake.respond(request, {});
  });
  const { spawnProcess } = fakeSpawner(() => process);
  const events: CodexSessionEvent[] = [];
  const session = new CodexSession({ cwd: "/tmp/project", onEvent: (event) => events.push(event), spawnProcess });

  try {
    const firstPrompt = session.prompt("first");
    const start = await process.waitForRequest("turn/start");
    const secondPrompt = session.prompt("second");
    await nextTask();
    assert.equal(process.requests("turn/start").length, 1);

    process.respond(start, { turn: { id: "turn_shared", status: "inProgress" } });
    const steer = await process.waitForRequest("turn/steer");
    assert.equal(steer.params?.threadId, "thr_steer");
    assert.equal(steer.params?.expectedTurnId, "turn_shared");
    assert.deepEqual(steer.params?.input, [{ type: "text", text: "second", text_elements: [] }]);
    assert.equal(process.requests("turn/start").length, 1);
    assert.equal(delayedTurnStart, start);

    process.notify("turn/completed", {
      threadId: "thr_steer",
      turn: { id: "turn_shared", status: "completed", error: null },
    });
    await Promise.all([firstPrompt, secondPrompt]);
    assert.deepEqual(
      events
        .filter((event) => event.type === "message" && event.message.role === "user")
        .map((event) => event.type === "message" ? (event.message.content as Array<{ text?: string }>)[0]?.text : undefined),
      ["first", "second"],
    );
  } finally {
    await session.dispose();
  }
});

test("abort waits for turn/start to return the authoritative turn id", async () => {
  const process = new FakeRpcProcess((request, fake) => {
    if (request.method === "initialize") fake.respond(request, {});
    else if (request.method === "thread/start") {
      fake.respond(request, { thread: { id: "thr_abort", status: { type: "idle" } }, model: "gpt-test" });
    } else if (request.method === "turn/interrupt") fake.respond(request, {});
  });
  const { spawnProcess } = fakeSpawner(() => process);
  const session = new CodexSession({ cwd: "/tmp/project", spawnProcess });

  try {
    const prompt = session.prompt("wait for id");
    const start = await process.waitForRequest("turn/start");
    const abort = session.abort();
    await nextTask();
    assert.equal(process.requests("turn/interrupt").length, 0);

    process.respond(start, { turn: { id: "turn_authoritative", status: "inProgress" } });
    const interrupt = await process.waitForRequest("turn/interrupt");
    assert.deepEqual(interrupt.params, { threadId: "thr_abort", turnId: "turn_authoritative" });
    await abort;
    process.notify("turn/completed", {
      threadId: "thr_abort",
      turn: { id: "turn_authoritative", status: "interrupted", error: null },
    });
    await prompt;
    assert.equal(session.isStreaming, false);
  } finally {
    await session.dispose();
  }
});

test("image-only prompts remain visible and retain temporary files until turn completion", async () => {
  const process = new FakeRpcProcess((request, fake) => {
    if (request.method === "initialize") fake.respond(request, {});
    else if (request.method === "thread/start") {
      fake.respond(request, { thread: { id: "thr_image", status: { type: "idle" } }, model: "gpt-test" });
    } else if (request.method === "turn/start") {
      fake.respond(request, { turn: { id: "turn_image", status: "inProgress" } });
    }
  });
  const { spawnProcess } = fakeSpawner(() => process);
  const events: CodexSessionEvent[] = [];
  const session = new CodexSession({ cwd: "/tmp/project", onEvent: (event) => events.push(event), spawnProcess });
  const imageData = Buffer.from("fake png bytes").toString("base64");

  try {
    const prompt = session.prompt("", [{ data: imageData, mimeType: "image/png" }]);
    const start = await process.waitForRequest("turn/start");
    const input = start.params?.input as Array<{ type: string; path?: string }>;
    const imagePath = input.find((part) => part.type === "localImage")?.path;
    assert.ok(imagePath);
    assert.deepEqual(await readFile(imagePath), Buffer.from("fake png bytes"));
    await waitUntil(
      () => events.some((event) => event.type === "message" && event.message.role === "user"),
      "image user message was not emitted",
    );
    const user = events.find((event) => event.type === "message" && event.message.role === "user");
    assert.deepEqual(user && user.type === "message" ? user.message.content : undefined, [
      { type: "image", data: imageData, mimeType: "image/png" },
    ]);
    await access(imagePath);

    process.notify("turn/completed", {
      threadId: "thr_image",
      turn: { id: "turn_image", status: "completed", error: null },
    });
    await prompt;
    await waitForMissingPath(imagePath);
    await assert.rejects(access(imagePath));
  } finally {
    await session.dispose();
  }
});

test("process failure drains but redacts stderr and emits exactly one terminal event", async () => {
  const process = new FakeRpcProcess((request, fake) => {
    if (request.method === "initialize") fake.respond(request, {});
    else if (request.method === "thread/start") {
      fake.respond(request, { thread: { id: "thr_crash", status: { type: "idle" } }, model: "gpt-test" });
    } else if (request.method === "turn/start") {
      fake.respond(request, { turn: { id: "turn_crash", status: "inProgress" } });
    }
  });
  const { spawnProcess } = fakeSpawner(() => process);
  const events: CodexSessionEvent[] = [];
  const session = new CodexSession({ cwd: "/tmp/project", onEvent: (event) => events.push(event), spawnProcess });

  try {
    const prompt = session.prompt("crash later");
    await process.waitForRequest("turn/start");
    await waitUntil(() => session.isStreaming, "turn did not enter streaming state");
    process.notify("item/started", {
      threadId: "thr_crash",
      item: { id: "tool_crash", type: "commandExecution", command: "sleep 1", status: "inProgress" },
    });
    process.sendServerRequest(900, "item/commandExecution/requestApproval", {
      threadId: "thr_crash",
      command: "dangerous",
      availableDecisions: ["accept", "decline"],
    });
    await waitUntil(() => session.pendingInteractions.length === 1, "pending approval was not registered");
    assert.equal(process.stderr.listenerCount("data") > 0, true, "stderr must be actively consumed");
    process.stderr.write("daemon exploded after startup");
    process.emitExit(9);
    process.emit("error", new Error("late duplicate child failure"));

    await assert.rejects(prompt, /Codex app-server stopped \(exit code 9\)/);
    await nextTask();
    assert.equal(session.isStreaming, false);
    assert.deepEqual(session.activeTools, []);
    assert.deepEqual(session.pendingInteractions, []);
    assert.equal(events.filter((event) => event.type === "turn_end").length, 1);
    assert.ok(events.some((event) =>
      event.type === "turn_end"
      && event.status === "failed"
      && !event.error?.includes("daemon exploded after startup")
    ));
    assert.ok(events.some((event) => event.type === "tool_end" && event.toolCallId === "tool_crash" && event.isError));
    assert.ok(events.some((event) =>
      event.type === "error"
      && event.message.includes("exit code 9")
      && !event.message.includes("daemon exploded after startup")
    ));
    assert.equal(
      events.some((event) =>
        (event.type === "error" && event.message.includes("daemon exploded after startup"))
        || (event.type === "turn_end" && event.error?.includes("daemon exploded after startup"))
      ),
      false,
    );
  } finally {
    await session.dispose();
  }
});

test("connection failure abandons pending approvals and reports remote_status errored", async () => {
  const process = new FakeRpcProcess((request, fake) => {
    if (request.method === "initialize") fake.respond(request, {});
    else if (request.method === "thread/start") {
      fake.respond(request, { thread: { id: "thr_conn_err", status: { type: "idle" } }, model: "gpt-test" });
    }
  });
  const { spawnProcess } = fakeSpawner(() => process);
  const events: CodexSessionEvent[] = [];
  const session = new CodexSession({ cwd: "/tmp/project", onEvent: (event) => events.push(event), spawnProcess });

  try {
    await session.connect();
    process.sendServerRequest(910, "item/commandExecution/requestApproval", {
      threadId: "thr_conn_err",
      command: "risky command",
      availableDecisions: ["accept", "decline"],
    });
    await waitUntil(() => session.pendingInteractions.length === 1, "pending approval was not registered");
    const interactionId = session.pendingInteractions[0]!.id;

    // Backend dies while an approval dialog is open. The session must release
    // the pending interaction (so the browser dialog closes instead of
    // blocking forever) and surface the disconnected state to the badge.
    process.emitExit(1);

    await waitUntil(() => session.pendingInteractions.length === 0, "pending approval was not abandoned");
    assert.equal(session.transport, "unavailable");
    assert.ok(events.some((event) =>
      event.type === "interaction_resolved" && event.id === interactionId),
    "the abandoned approval must notify the UI");
    assert.ok(events.some((event) =>
      event.type === "remote_status"
      && event.status.status === "errored"
      && event.type === "remote_status"),
    "connection failure must report remote_status errored");
  } finally {
    await session.dispose();
  }
});

test("writer-conflicted threads attach read-only and upgrade when the writer releases", async () => {
  let resumeCalls = 0;
  const process = new FakeRpcProcess((request, fake) => {
    if (request.method === "initialize") fake.respond(request, {});
    else if (request.method === "thread/read") {
      fake.respond(request, { thread: { id: "thr_busy", cwd: "/tmp/project", status: { type: "active" } } });
    } else if (request.method === "thread/resume") {
      resumeCalls += 1;
      if (resumeCalls <= 2) {
        fake.respondError(request, "thread thr_busy already has an active writer");
      } else {
        fake.respond(request, {
          thread: { id: "thr_busy", cwd: "/tmp/project", status: { type: "idle" } },
          initialTurnsPage: {
            data: [{
              id: "turn_busy",
              status: "completed",
              items: [
                { type: "userMessage", id: "u_busy", content: [{ type: "text", text: "original prompt" }] },
                { type: "agentMessage", id: "a_busy", text: "controlled elsewhere" },
              ],
            }],
            nextCursor: null,
          },
          model: "gpt-test",
          reasoningEffort: "medium",
        });
      }
    } else if (request.method === "thread/turns/list") {
      fake.respond(request, {
        data: [
          {
            id: "turn_live",
            status: "inProgress",
            items: [
              { type: "agentMessage", id: "a_live_1", text: "observable text" },
              { type: "commandExecution", id: "exec_live", command: "watch me", status: "inProgress" },
            ],
          },
          {
            id: "turn_old",
            status: "completed",
            items: [
              { type: "userMessage", id: "u_busy", content: [{ type: "text", text: "original prompt" }] },
              { type: "agentMessage", id: "a_old", text: "controlled elsewhere" },
            ],
          },
        ],
        nextCursor: null,
      });
    } else if (request.method === "turn/start") {
      fake.respond(request, { turn: { id: "turn_after_upgrade", status: "inProgress" } });
      queueMicrotask(() => {
        fake.notify("item/completed", {
          threadId: "thr_busy",
          item: { type: "agentMessage", id: "a_after", text: "writable again" },
          completedAtMs: 456,
        });
        fake.notify("turn/completed", {
          threadId: "thr_busy",
          turn: { id: "turn_after_upgrade", status: "completed", error: null },
        });
      });
    }
  });
  const { spawnProcess } = fakeSpawner(() => process);
  const events: CodexSessionEvent[] = [];
  const session = new CodexSession({
    cwd: "/tmp/project",
    state: { threadId: "thr_busy" },
    onEvent: (event) => events.push(event),
    spawnProcess,
  });

  try {
    await session.connect();
    assert.equal(session.observerMode, true, "writer conflict must downgrade to read-only");
    const hist = events.find((event) => event.type === "history");
    assert.ok(hist && hist.type === "history", "observer must emit a history baseline");
    const texts = hist.type === "history"
      ? hist.messages.flatMap((message) =>
          (message.content as Array<{ text?: string }> | undefined)
            ?.filter((block) => block.text)
            .map((block) => block.text as string) ?? [])
      : [];
    assert.ok(texts.includes("observable text"), "polled agent text must reach the UI");
    assert.ok(texts.includes("original prompt"), "older completed turns must stay visible");
    assert.equal(hist.type === "history" ? hist.isStreaming : false, true);
    assert.deepEqual(
      hist.type === "history" ? hist.activeTools : [],
      [{ toolCallId: "exec_live", toolName: "bash", args: { command: "watch me", cwd: undefined } }],
    );
    await assert.rejects(session.prompt("nope"), /只读浏览/);
    process.sendServerRequest("observer-approval", "item/commandExecution/requestApproval", {
      threadId: "thr_busy",
      turnId: "turn_live",
      itemId: "exec_live",
      command: "echo must-stay-with-writer",
    });
    await nextTask();
    assert.equal(session.pendingInteractions.length, 0, "observer must not claim the writer's approval");

    // Writer releases on the next poll tick (~2s): the session upgrades and
    // becomes writable without any reconnect.
    await waitUntil(() => session.observerMode === false, "observer did not upgrade after writer release", 4_500);
    const resetHistories = events.filter((event) => event.type === "history" && event.reset === true);
    assert.equal(resetHistories.length, 1, "the upgrade must re-baseline the transcript exactly once");
    const prompt = session.prompt("now mine");
    await prompt;
    assert.ok(events.some((event) =>
      event.type === "message" && event.message.role === "assistant" && event.message.content?.[0]?.text === "writable again"),
    "a prompt after the upgrade must drive a real turn");
  } finally {
    await session.dispose();
  }
});

test("read-only observer refreshes when only tool details change", async () => {
  const toolSnapshots = [
    { command: "printf old", status: "inProgress", aggregatedOutput: "old output" },
    { command: "printf new", status: "inProgress", aggregatedOutput: "new output" },
    { command: "printf new", status: "completed", aggregatedOutput: "new output" },
    { command: "printf new", status: "failed", aggregatedOutput: "new output" },
  ];
  let listCalls = 0;
  const process = new FakeRpcProcess((request, fake) => {
    if (request.method === "initialize") fake.respond(request, {});
    else if (request.method === "thread/read") {
      fake.respond(request, { thread: { id: "thr_observer_tools", cwd: "/tmp/project", status: { type: "active" } } });
    } else if (request.method === "thread/resume") {
      fake.respondError(request, "thread thr_observer_tools already has an active writer");
    } else if (request.method === "thread/turns/list") {
      const tool = toolSnapshots[Math.min(listCalls, toolSnapshots.length - 1)]!;
      listCalls += 1;
      fake.respond(request, {
        data: [{
          id: "turn_observer_tools",
          status: "inProgress",
          items: [
            { type: "commandExecution", id: "exec_observer", ...tool },
            { type: "agentMessage", id: "tail_observer", text: "unchanged tail" },
          ],
        }],
        nextCursor: null,
      });
    }
  });
  const { spawnProcess } = fakeSpawner(() => process);
  const events: CodexSessionEvent[] = [];
  const session = new CodexSession({
    cwd: "/tmp/project",
    state: { threadId: "thr_observer_tools" },
    onEvent: (event) => events.push(event),
    spawnProcess,
  });
  const pollObserverTurn = () =>
    (session as unknown as { pollObserverTurn: () => Promise<void> }).pollObserverTurn();
  const histories = () => events.filter((event) => event.type === "history");

  try {
    await session.connect();
    const initial = histories()[0];
    assert.ok(initial && initial.type === "history");
    assert.equal(initial.messages.length, 1);
    assert.deepEqual(initial.activeTools, [{
      toolCallId: "exec_observer",
      toolName: "bash",
      args: { command: "printf old", cwd: undefined },
      output: "old output",
    }]);

    await pollObserverTurn();
    const activeUpdate = histories()[1];
    assert.ok(activeUpdate && activeUpdate.type === "history", "active tool detail changes must refresh history");
    assert.equal(activeUpdate.messages.length, initial.messages.length, "tool details changed without changing message count");
    assert.equal(activeUpdate.messages[0]?.content?.[0]?.text, "unchanged tail");
    assert.deepEqual(activeUpdate.activeTools, [{
      toolCallId: "exec_observer",
      toolName: "bash",
      args: { command: "printf new", cwd: undefined },
      output: "new output",
    }]);

    await pollObserverTurn();
    const completed = histories()[2];
    assert.ok(completed && completed.type === "history");
    const completedResult = completed.messages.find((message) => message.role === "toolResult");
    assert.equal(completedResult?.isError, false);

    await pollObserverTurn();
    const failed = histories()[3];
    assert.ok(failed && failed.type === "history", "tool status changes must refresh history");
    assert.equal(failed.messages.length, completed.messages.length, "tool status changed without changing message count");
    assert.equal(failed.messages.at(-1)?.content?.[0]?.text, "unchanged tail");
    const failedResult = failed.messages.find((message) => message.role === "toolResult");
    assert.equal(failedResult?.content, "new output");
    assert.equal(failedResult?.isError, true);
  } finally {
    await session.dispose();
  }
});
