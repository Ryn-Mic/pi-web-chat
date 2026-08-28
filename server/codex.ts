import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createInterface, type Interface } from "node:readline";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  UIActiveTool,
  UICodexInteraction,
  UICodexInteractionResponse,
  UIContextUsage,
  UIThinkingLevel,
} from "../shared/protocol.ts";

export interface CodexImageInput {
  data: string;
  mimeType: string;
}

export interface CodexSessionState {
  threadId?: string;
  model?: string;
  effort?: string;
}

export interface CodexModelInfo {
  id: string;
  model: string;
  displayName: string;
  isDefault: boolean;
  supportedReasoningEfforts: Array<{ reasoningEffort: string; description?: string }>;
  defaultReasoningEffort?: string;
}

export interface CodexThreadInfo {
  id: string;
  sessionId?: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  name?: string;
  path?: string;
  status?: unknown;
}

export interface CodexRemoteStatus {
  status: "disabled" | "connecting" | "connected" | "errored";
  serverName?: string;
  installationId?: string;
  environmentId?: string | null;
}

export type CodexSessionEvent =
  | { type: "thread_ready"; threadId: string; model?: string; effort?: string | null; cwd?: string }
  | {
      type: "history";
      messages: Record<string, unknown>[];
      cursor: string | null;
      isStreaming: boolean;
      activeTools: UIActiveTool[];
      reset?: boolean;
    }
  | { type: "turn_start"; turnId?: string }
  | { type: "text_delta"; delta: string }
  | { type: "thinking_delta"; delta: string }
  | { type: "thinking_end" }
  | { type: "tool_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_progress"; toolCallId: string; delta: string }
  | { type: "tool_end"; toolCallId: string; toolName: string; isError: boolean }
  | { type: "message"; message: Record<string, unknown>; completedAt?: number }
  | { type: "context"; context: UIContextUsage | null }
  | { type: "plan"; plan: Array<{ step: string; status: string }>; explanation?: string }
  | { type: "interaction"; interaction: UICodexInteraction }
  | { type: "interaction_resolved"; id: string }
  | { type: "catalog_changed" }
  | { type: "remote_status"; status: CodexRemoteStatus }
  | { type: "turn_end"; status: string; error?: string }
  | { type: "error"; message: string };

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexTransportMode = "auto" | "proxy" | "standalone";
export type CodexActiveTransport = "shared" | "standalone" | "connecting" | "unavailable";

type JsonRpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type CodexInput =
  | { type: "text"; text: string; text_elements: unknown[] }
  | { type: "localImage"; path: string };

type TurnCompletion = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
};

type ServerRequestResult = { result?: unknown; suppressResponse?: boolean };
type ServerRequestHandler = (message: JsonRpcMessage) => Promise<ServerRequestResult | undefined>;
type NotificationListener = (method: string, params: Record<string, unknown>) => void;

export interface CodexAppServerOptions {
  cwd: string;
  binary?: string;
  transport?: CodexTransportMode;
  spawnProcess?: typeof spawn;
}

export interface CodexSessionOptions {
  cwd: string;
  state?: CodexSessionState;
  client?: CodexAppServerClient;
  binary?: string;
  transport?: CodexTransportMode;
  sandbox?: CodexSandboxMode;
  approvalPolicy?: "untrusted" | "on-request" | "never";
  onEvent?: (event: CodexSessionEvent) => void;
  spawnProcess?: typeof spawn;
}

const RPC_TIMEOUT_MS = 30_000;
const HISTORY_TURN_LIMIT = 50;
/** Read-only observation cadence for threads whose active turn is owned by
 * another client ("already has an active writer"). Every tick also probes
 * thread/resume so the session upgrades to interactive control as soon as the
 * current writer releases the thread. */
const OBSERVER_POLL_MS = 2_000;

function isWriterConflict(error: unknown): boolean {
  return errorMessage(error).includes("already has an active writer");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return String(value);
}

function safeJson(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function threadIdFromParams(params: Record<string, unknown>): string | undefined {
  return stringValue(params.threadId) ?? stringValue(params.conversationId);
}

function itemId(item: Record<string, unknown>): string {
  return stringValue(item.id) ?? "codex-item-" + crypto.randomUUID();
}

function itemTool(item: Record<string, unknown>): { id: string; name: string; args: unknown } | null {
  const id = itemId(item);
  switch (item.type) {
    case "commandExecution":
      return { id, name: "bash", args: { command: item.command ?? "", cwd: item.cwd } };
    case "fileChange":
      return { id, name: "file_change", args: item.changes ?? [] };
    case "mcpToolCall":
      return {
        id,
        name: "mcp:" + (stringValue(item.server) ?? "server") + "/" + (stringValue(item.tool) ?? "tool"),
        args: item.arguments ?? {},
      };
    case "dynamicToolCall":
      return { id, name: "dynamic:" + (stringValue(item.tool) ?? "tool"), args: item.arguments ?? {} };
    case "collabAgentToolCall":
      return {
        id,
        name: "agent:" + (stringValue(item.tool) ?? "collaboration"),
        args: {
          prompt: item.prompt,
          receivers: item.receiverThreadIds ?? [],
          model: item.model,
          effort: item.reasoningEffort,
        },
      };
    case "subAgentActivity":
      return { id, name: "agent_activity", args: { kind: item.kind, threadId: item.agentThreadId, path: item.agentPath } };
    case "webSearch":
      return { id, name: "web_search", args: { query: item.query ?? item.searchQuery ?? item } };
    case "imageView":
      return { id, name: "view_image", args: { path: item.path } };
    case "imageGeneration":
      return { id, name: "image_generation", args: item };
    case "sleep":
      return { id, name: "wait", args: item };
    default:
      return null;
  }
}

function itemIsActive(item: Record<string, unknown>): boolean {
  const status = stringValue(item.status)?.toLowerCase();
  return status === "inprogress" || status === "in_progress" || status === "running";
}

function itemError(item: Record<string, unknown>): boolean {
  const status = stringValue(item.status)?.toLowerCase();
  return !!status && ["failed", "declined", "error", "cancelled", "canceled"].includes(status)
    || item.success === false
    || item.error !== null && item.error !== undefined;
}

function fileChangeDiff(item: Record<string, unknown>): string {
  if (!Array.isArray(item.changes)) return "";
  return item.changes
    .filter(isRecord)
    .map((change) => stringValue(change.diff) ?? "")
    .filter(Boolean)
    .join("\n");
}

function itemResultText(item: Record<string, unknown>): string {
  if (typeof item.aggregatedOutput === "string") return item.aggregatedOutput;
  if (typeof item.output === "string") return item.output;
  if (typeof item.error === "string") return item.error;
  if (isRecord(item.error) && typeof item.error.message === "string") return item.error.message;
  if (item.type === "fileChange") return fileChangeDiff(item);
  if (item.type === "mcpToolCall") return item.result == null ? "" : safeJson(item.result);
  if (item.type === "dynamicToolCall") return item.contentItems == null ? "" : safeJson(item.contentItems);
  if (item.type === "collabAgentToolCall") return safeJson(item.agentsStates ?? item.receiverThreadIds ?? []);
  if (item.type === "webSearch") return safeJson(item.results ?? item.action ?? item);
  if (item.type === "imageGeneration") return safeJson(item.result ?? item);
  return "";
}

function userItemContent(item: Record<string, unknown>): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const part of Array.isArray(item.content) ? item.content : []) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") blocks.push({ type: "text", text: part.text });
    else if (part.type === "mention") blocks.push({ type: "text", text: stringValue(part.name) ?? stringValue(part.path) ?? "" });
    else if (part.type === "skill") blocks.push({ type: "text", text: stringValue(part.name) ?? "" });
    else if (part.type === "localImage" && typeof part.path === "string") {
      blocks.push({ type: "text", text: "[Image: " + part.path + "]" });
    } else if (part.type === "image" && typeof part.url === "string") {
      blocks.push({ type: "text", text: "[Image: " + part.url + "]" });
    }
  }
  return blocks.filter((block) => block.text !== "");
}

function itemMessages(item: Record<string, unknown>, timestamp?: number): Record<string, unknown>[] {
  const type = item.type;
  if (type === "userMessage") {
    const content = userItemContent(item);
    return content.length ? [{ role: "user", content, timestamp }] : [];
  }
  if (type === "agentMessage") {
    const text = typeof item.text === "string" ? item.text : "";
    return text ? [{ role: "assistant", content: [{ type: "text", text }], timestamp }] : [];
  }
  if (type === "reasoning") {
    const summary = Array.isArray(item.summary) ? item.summary.filter((v): v is string => typeof v === "string") : [];
    const content = Array.isArray(item.content) ? item.content.filter((v): v is string => typeof v === "string") : [];
    const text = [...summary, ...content].filter(Boolean).join("\n");
    return text ? [{ role: "assistant", content: [{ type: "thinking", thinking: text }], timestamp }] : [];
  }
  if (type === "plan") {
    const text = typeof item.text === "string" ? item.text : "";
    return text ? [{ role: "assistant", content: [{ type: "thinking", thinking: text }], timestamp }] : [];
  }
  if (type === "enteredReviewMode" || type === "exitedReviewMode" || type === "contextCompaction") {
    const text = type === "contextCompaction" ? "Context compacted" : String(item.review ?? type);
    return [{ role: "assistant", content: [{ type: "thinking", thinking: text }], timestamp }];
  }
  const tool = itemTool(item);
  if (!tool) return [];
  const diff = type === "fileChange" ? fileChangeDiff(item) : "";
  return [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: tool.id, name: tool.name, arguments: tool.args }],
      timestamp,
    },
    {
      role: "toolResult",
      toolCallId: tool.id,
      content: itemResultText(item),
      isError: itemError(item),
      ...(diff ? { details: { diff } } : {}),
      timestamp,
    },
  ];
}

function turnMessages(turn: Record<string, unknown>): Record<string, unknown>[] {
  const startedAt = numberValue(turn.startedAt);
  const timestamp = startedAt === undefined ? undefined : startedAt * 1000;
  const inProgress = turn.status === "inProgress";
  return (Array.isArray(turn.items) ? turn.items.filter(isRecord) : []).flatMap((item) => {
    if (inProgress && itemTool(item) && itemIsActive(item)) return [];
    return itemMessages(item, timestamp);
  });
}

function observerSnapshotFingerprint(snapshot: {
  messages: Record<string, unknown>[];
  cursor: string | null;
  isStreaming: boolean;
  turnId?: string;
  activeTools: UIActiveTool[];
}): string {
  // Observer polling has no incremental event stream, so every UI-visible
  // field must participate. In particular, tool args/output/error state can
  // change while both the message count and trailing assistant text stay put.
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("base64url");
}

function turnsFromResume(response: Record<string, unknown>): {
  turns: Record<string, unknown>[];
  cursor: string | null;
} {
  const page = isRecord(response.initialTurnsPage) ? response.initialTurnsPage : undefined;
  const thread = isRecord(response.thread) ? response.thread : undefined;
  const turns = page && Array.isArray(page.data)
    ? page.data.filter(isRecord).reverse()
    : Array.isArray(thread?.turns)
      ? thread.turns.filter(isRecord)
      : [];
  return { turns, cursor: page ? stringValue(page.nextCursor) ?? null : null };
}

/**
 * One process-wide JSONL client. Auto mode prefers the shared daemon proxy and
 * safely falls back to an isolated app-server when no daemon is running.
 */
export class CodexAppServerClient {
  private readonly cwd: string;
  private readonly binary: string;
  private readonly configuredTransport: CodexTransportMode;
  private readonly spawnProcess: typeof spawn;
  private child: ChildProcessWithoutNullStreams | null = null;
  private lines: Interface | null = null;
  private nextRequestId = 1;
  private pending = new Map<string, PendingRequest>();
  private listeners = new Set<NotificationListener>();
  private requestHandlers = new Set<ServerRequestHandler>();
  private threadSubscriptions = new Map<string, number>();
  private startPromise: Promise<void> | null = null;
  private ready = false;
  private disposed = false;
  private activeTransportValue: CodexActiveTransport = "unavailable";
  private sharedTransportEstablished = false;

  constructor(options: CodexAppServerOptions) {
    this.cwd = options.cwd;
    this.binary = options.binary?.trim() || "codex";
    this.configuredTransport = options.transport ?? "auto";
    this.spawnProcess = options.spawnProcess ?? spawn;
  }

  get activeTransport(): CodexActiveTransport {
    return this.activeTransportValue;
  }

  onNotification(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onServerRequest(handler: ServerRequestHandler): () => void {
    this.requestHandlers.add(handler);
    return () => this.requestHandlers.delete(handler);
  }

  async connect(): Promise<void> {
    if (this.disposed) throw new Error("Codex app-server client is disposed");
    if (this.ready && this.child) return;
    if (this.startPromise) return this.startPromise;
    this.activeTransportValue = "connecting";
    this.startPromise = this.startSequence().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    await this.connect();
    return this.sendRequest(method, params);
  }

  async listThreads(limit = 300): Promise<CodexThreadInfo[]> {
    const result: CodexThreadInfo[] = [];
    let cursor: string | null = null;
    do {
      const response = await this.request("thread/list", {
        cursor,
        limit: Math.min(100, limit - result.length),
        sortKey: "updated_at",
        sortDirection: "desc",
        archived: false,
        useStateDbOnly: false,
      });
      const record = isRecord(response) ? response : {};
      for (const raw of Array.isArray(record.data) ? record.data : []) {
        if (!isRecord(raw) || !stringValue(raw.id)) continue;
        result.push({
          id: String(raw.id),
          ...(stringValue(raw.sessionId) ? { sessionId: String(raw.sessionId) } : {}),
          preview: typeof raw.preview === "string" ? raw.preview : "",
          cwd: typeof raw.cwd === "string" ? raw.cwd : this.cwd,
          createdAt: numberValue(raw.createdAt) ?? 0,
          updatedAt: numberValue(raw.updatedAt) ?? 0,
          ...(stringValue(raw.name) ? { name: String(raw.name) } : {}),
          ...(stringValue(raw.path) ? { path: String(raw.path) } : {}),
          status: raw.status,
        });
        if (result.length >= limit) break;
      }
      cursor = stringValue(record.nextCursor) ?? null;
    } while (cursor && result.length < limit);
    return result;
  }

  async listModels(): Promise<CodexModelInfo[]> {
    const result: CodexModelInfo[] = [];
    let cursor: string | null = null;
    do {
      const response = await this.request("model/list", { cursor, limit: 100, includeHidden: false });
      const record = isRecord(response) ? response : {};
      for (const raw of Array.isArray(record.data) ? record.data : []) {
        if (!isRecord(raw)) continue;
        const model = stringValue(raw.model) ?? stringValue(raw.id);
        if (!model) continue;
        const efforts = Array.isArray(raw.supportedReasoningEfforts)
          ? raw.supportedReasoningEfforts.filter(isRecord).flatMap((effort) => {
              const value = stringValue(effort.reasoningEffort);
              return value ? [{
                reasoningEffort: value,
                ...(stringValue(effort.description) ? { description: String(effort.description) } : {}),
              }] : [];
            })
          : [];
        result.push({
          id: stringValue(raw.id) ?? model,
          model,
          displayName: stringValue(raw.displayName) ?? model,
          isDefault: raw.isDefault === true,
          supportedReasoningEfforts: efforts,
          ...(stringValue(raw.defaultReasoningEffort)
            ? { defaultReasoningEffort: String(raw.defaultReasoningEffort) }
            : {}),
        });
      }
      cursor = stringValue(record.nextCursor) ?? null;
    } while (cursor);
    return result;
  }

  async readThread(threadId: string): Promise<CodexThreadInfo> {
    const response = await this.request("thread/read", { threadId, includeTurns: false });
    const raw = isRecord(response) && isRecord(response.thread) ? response.thread : undefined;
    const id = stringValue(raw?.id);
    if (!raw || !id) throw new Error("Codex thread not found");
    return {
      id,
      ...(stringValue(raw.sessionId) ? { sessionId: String(raw.sessionId) } : {}),
      preview: typeof raw.preview === "string" ? raw.preview : "",
      cwd: typeof raw.cwd === "string" ? raw.cwd : this.cwd,
      createdAt: numberValue(raw.createdAt) ?? 0,
      updatedAt: numberValue(raw.updatedAt) ?? 0,
      ...(stringValue(raw.name) ? { name: String(raw.name) } : {}),
      ...(stringValue(raw.path) ? { path: String(raw.path) } : {}),
      status: raw.status,
    };
  }

  async remoteControlStatus(): Promise<CodexRemoteStatus> {
    const response = await this.request("remoteControl/status/read", {});
    const record = isRecord(response) ? response : {};
    const status = stringValue(record.status);
    return {
      status: status === "connecting" || status === "connected" || status === "errored" ? status : "disabled",
      ...(stringValue(record.serverName) ? { serverName: String(record.serverName) } : {}),
      ...(stringValue(record.installationId) ? { installationId: String(record.installationId) } : {}),
      ...(record.environmentId === null || typeof record.environmentId === "string"
        ? { environmentId: record.environmentId }
        : {}),
    };
  }

  async renameThread(threadId: string, name: string): Promise<void> {
    await this.request("thread/name/set", { threadId, name });
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.request("thread/delete", { threadId });
  }

  async forkThread(threadId: string, cwd?: string): Promise<string> {
    const response = await this.request("thread/fork", {
      threadId,
      ...(cwd ? { cwd, runtimeWorkspaceRoots: [cwd] } : {}),
      excludeTurns: true,
    });
    const thread = isRecord(response) && isRecord(response.thread) ? response.thread : undefined;
    const id = stringValue(thread?.id);
    if (!id) throw new Error("Codex app-server returned no forked thread id");
    return id;
  }

  retainThread(threadId: string): void {
    this.threadSubscriptions.set(threadId, (this.threadSubscriptions.get(threadId) ?? 0) + 1);
  }

  async releaseThread(threadId: string): Promise<void> {
    const count = this.threadSubscriptions.get(threadId) ?? 0;
    if (count > 1) {
      this.threadSubscriptions.set(threadId, count - 1);
      return;
    }
    this.threadSubscriptions.delete(threadId);
    // Do not bring up a new process merely to unsubscribe from one that is
    // already gone. A closed proxy/stdio connection has no live subscription.
    if (!this.ready || !this.child) return;
    await this.sendRequest("thread/unsubscribe", { threadId }).catch(() => {});
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.activeTransportValue = "unavailable";
    this.lines?.close();
    this.lines = null;
    this.rejectPending(new Error("Codex app-server client disposed"));
    this.threadSubscriptions.clear();
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already stopped
      }
    }
  }

  private async startSequence(): Promise<void> {
    const modes: Array<"proxy" | "standalone"> = this.configuredTransport === "auto"
      ? this.sharedTransportEstablished ? ["proxy"] : ["proxy", "standalone"]
      : [this.configuredTransport];
    let lastError: Error | null = null;
    for (const mode of modes) {
      try {
        await this.startMode(mode);
        this.activeTransportValue = mode === "proxy" ? "shared" : "standalone";
        if (mode === "proxy") this.sharedTransportEstablished = true;
        return;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(errorMessage(error));
        this.stopCurrentProcess(lastError);
      }
    }
    this.activeTransportValue = "unavailable";
    throw lastError ?? new Error("Unable to start Codex app-server");
  }

  private async startMode(mode: "proxy" | "standalone"): Promise<void> {
    if (this.disposed) throw new Error("Codex app-server client is disposed");
    const childEnv = { ...process.env };
    delete childEnv.PI_WEB_TOKEN;
    delete childEnv.PI_WEB_SESSION_TOKEN;
    const args = mode === "proxy" ? ["app-server", "proxy"] : ["app-server", "--listen", "stdio://"];
    const child = this.spawnProcess(this.binary, args, {
      cwd: this.cwd,
      env: childEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    this.lines = lines;
    lines.on("line", (line) => this.handleLine(child, line));
    // Drain stderr so the child cannot block, but do not retain or forward it:
    // diagnostics may contain credentials, headers, or private local paths.
    child.stderr.on("data", () => {});
    child.once("error", (error) => this.handleProcessFailure(child, error));
    child.once("exit", (code, signal) => {
      const detail = code !== null ? "exit code " + code : "signal " + (signal ?? "unknown");
      this.handleProcessFailure(
        child,
        // stderr is intentionally drained but never forwarded to browsers: it
        // may contain upstream headers, credentials, or private local paths.
        new Error("Codex app-server stopped (" + detail + ")"),
      );
    });
    await this.sendRequest("initialize", {
      clientInfo: {
        name: "pi-web-chat",
        title: "Pi Web Chat",
        version: process.env.npm_package_version ?? "unknown",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        mcpServerOpenaiFormElicitation: true,
        extensions: { "openai/form": {} },
      },
    });
    this.sendNotification("initialized", {});
    if (this.child !== child) throw new Error("Codex app-server stopped during initialization");
    this.ready = true;
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.child?.stdin.writable) throw new Error("Codex app-server stdin is closed");
    this.child.stdin.write(JSON.stringify({ method, params }) + "\n");
  }

  private sendRequest(method: string, params: unknown): Promise<unknown> {
    if (!this.child?.stdin.writable) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.nextRequestId++;
    const key = String(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error("Codex request timed out: " + method));
      }, RPC_TIMEOUT_MS);
      this.pending.set(key, { resolve, reject, timer });
      try {
        this.child!.stdin.write(JSON.stringify({ method, id, params }) + "\n");
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(key);
        reject(new Error(errorMessage(error)));
      }
    });
  }

  private handleLine(child: ChildProcessWithoutNullStreams, line: string): void {
    if (child !== this.child) return;
    const trimmed = line.trim();
    if (!trimmed) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return;
    }
    if (message.id !== undefined && !message.method && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message || "Codex request failed (" + (message.error.code ?? "unknown") + ")"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (message.method && message.id !== undefined) {
      void this.handleServerRequest(message);
      return;
    }
    if (message.method) {
      const params = isRecord(message.params) ? message.params : {};
      for (const listener of this.listeners) {
        try {
          listener(message.method, params);
        } catch {
          // Isolate session/UI listeners from the process-wide transport.
        }
      }
    }
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<void> {
    try {
      if (message.method === "currentTime/read") {
        this.sendResponse(message.id!, { currentTimeAt: Math.floor(Date.now() / 1000) });
        return;
      }
      for (const handler of this.requestHandlers) {
        const handled = await handler(message);
        if (handled) {
          if (!handled.suppressResponse) this.sendResponse(message.id!, handled.result);
          return;
        }
      }
      // A proxy shares one daemon with other clients. Requests this Web client
      // did not claim may belong to a Desktop/CLI capability (token refresh,
      // dynamic tools, attestation, or a thread not open in Web); never race it
      // with an unsupported error response.
      if (this.activeTransportValue === "shared") return;
      // Shared-daemon approval requests may be observed by several clients.
      // If this Web process does not own the thread, leave the request for the
      // owning client instead of declining or erroring on the user's behalf.
      if ([
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/tool/requestUserInput",
        "mcpServer/elicitation/request",
        "item/permissions/requestApproval",
        "execCommandApproval",
        "applyPatchApproval",
      ].includes(message.method ?? "")) return;
      this.sendResponse(message.id!, undefined, new Error("Unsupported Codex server request: " + message.method));
    } catch (error) {
      this.sendResponse(message.id!, undefined, error instanceof Error ? error : new Error(errorMessage(error)));
    }
  }

  private sendResponse(id: number | string, result?: unknown, error?: Error): void {
    if (!this.child?.stdin.writable) return;
    const response = error
      ? { id, error: { code: -32000, message: error.message } }
      : { id, result: result ?? {} };
    try {
      this.child.stdin.write(JSON.stringify(response) + "\n");
    } catch {
      // child failure handler owns recovery
    }
  }

  private handleProcessFailure(child: ChildProcessWithoutNullStreams, error: unknown): void {
    if (child !== this.child || this.disposed) return;
    const wasReady = this.ready;
    const message = errorMessage(error);
    this.child = null;
    this.ready = false;
    this.lines?.close();
    this.lines = null;
    this.rejectPending(new Error(message));
    if (wasReady) {
      this.activeTransportValue = "unavailable";
      for (const listener of this.listeners) {
        try {
          listener("connection/error", { message });
        } catch {
          // Isolate a failing session listener from the remaining sessions.
        }
      }
    }
  }

  private stopCurrentProcess(error: Error): void {
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.lines?.close();
    this.lines = null;
    this.rejectPending(error);
    if (child) {
      try {
        child.kill("SIGTERM");
      } catch {
        // already stopped
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

type PendingInteraction = {
  interaction: UICodexInteraction;
  method: string;
  rpcId: string;
  params: Record<string, unknown>;
  resolve: (response: UICodexInteractionResponse | null) => void;
};

/** One native Codex thread attached to the process-wide app-server client. */
export class CodexSession {
  private cwdValue: string;
  private readonly sandbox: CodexSandboxMode;
  private readonly approvalPolicy: "untrusted" | "on-request" | "never";
  private readonly emitEvent: (event: CodexSessionEvent) => void;
  private readonly client: CodexAppServerClient;
  private readonly ownsClient: boolean;
  private unsubscribeNotification: (() => void) | null = null;
  private unsubscribeRequest: (() => void) | null = null;
  private connectPromise: Promise<void> | null = null;
  private startTurnPromise: Promise<void> | null = null;
  private refreshHistoryPromise: Promise<void> | null = null;
  private historyRefreshDirty = false;
  private turnCompletion: TurnCompletion | null = null;
  private retainedThreadId: string | null = null;
  private itemText = new Map<string, string>();
  private itemThinking = new Map<string, string>();
  private localUserMessageIds = new Set<string>();
  private activeItems = new Map<string, { name: string; args: unknown; output: string }>();
  private turnDiffs = new Map<string, string>();
  private fileChanges = new Map<string, unknown>();
  private interactions = new Map<string, PendingInteraction>();
  private observerModeValue = false;
  private observerPollTimer: ReturnType<typeof setInterval> | null = null;
  private observerPolling = false;
  private observerFingerprint: string | null = null;
  private disposed = false;
  private ready = false;
  private streaming = false;
  private threadId: string | undefined;
  private turnId: string | undefined;
  private model: string | undefined;
  private effort: string | undefined;
  private historyCursorValue: string | null = null;
  private lastAssistantTextValue = "";
  private imageDirs = new Set<string>();
  private turnImageCleanups: Array<() => Promise<void>> = [];

  constructor(options: CodexSessionOptions) {
    this.cwdValue = options.cwd;
    this.sandbox = options.sandbox ?? "workspace-write";
    this.approvalPolicy = options.approvalPolicy ?? "on-request";
    this.emitEvent = options.onEvent ?? (() => {});
    this.threadId = options.state?.threadId;
    this.model = options.state?.model || undefined;
    this.effort = options.state?.effort || undefined;
    this.ownsClient = !options.client;
    this.client = options.client ?? new CodexAppServerClient({
      cwd: options.cwd,
      binary: options.binary,
      transport: options.transport ?? "standalone",
      spawnProcess: options.spawnProcess,
    });
    this.unsubscribeNotification = this.client.onNotification((method, params) => this.handleNotification(method, params));
    this.unsubscribeRequest = this.client.onServerRequest((message) => this.handleServerRequest(message));
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  get currentThreadId(): string | undefined {
    return this.threadId;
  }

  get currentModel(): string | undefined {
    return this.model;
  }

  get currentEffort(): string | undefined {
    return this.effort;
  }

  get currentCwd(): string {
    return this.cwdValue;
  }

  get historyCursor(): string | null {
    return this.historyCursorValue;
  }

  get pendingInteractions(): UICodexInteraction[] {
    return [...this.interactions.values()].map((pending) => pending.interaction);
  }

  get activeTools(): UIActiveTool[] {
    return [...this.activeItems].map(([toolCallId, item]) => ({
      toolCallId,
      toolName: item.name,
      args: item.args,
      ...(item.output ? { output: item.output } : {}),
    }));
  }

  get lastAssistantText(): string {
    return this.lastAssistantTextValue;
  }

  get transport(): CodexActiveTransport {
    return this.client.activeTransport;
  }

  /** True while attached read-only because another client owns the active turn. */
  get observerMode(): boolean {
    return this.observerModeValue;
  }

  setModel(model: string): void {
    const normalized = model.trim();
    this.model = normalized && normalized !== "default" ? normalized : undefined;
  }

  setEffort(effort: string | undefined): void {
    const normalized = effort?.trim().toLowerCase();
    this.effort = normalized && normalized !== "off" ? normalized : undefined;
  }

  async connect(): Promise<void> {
    if (this.disposed) throw new Error("Codex session is disposed");
    if (this.ready && this.threadId) return;
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.connectThread().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  async prompt(text: string, images: CodexImageInput[] = [], requestedClientId?: string): Promise<void> {
    if (this.disposed) throw new Error("Codex session is disposed");
    if (this.observerModeValue) {
      throw new Error("该 Codex 会话正被其他客户端使用，当前为只读浏览模式");
    }
    const clientUserMessageId = requestedClientId?.trim() || crypto.randomUUID();
    const prepared = await this.createInput(text, images);
    let retained = false;
    try {
      await this.connect();
      if (this.startTurnPromise) await this.startTurnPromise;
      if (this.streaming) {
        if (!this.threadId || !this.turnId) throw new Error("Codex turn is starting; try steering again shortly");
        const completion = this.turnCompletion;
        this.localUserMessageIds.add(clientUserMessageId);
        try {
          await this.client.request("turn/steer", {
            threadId: this.threadId,
            expectedTurnId: this.turnId,
            clientUserMessageId,
            input: prepared.input,
          });
        } catch (error) {
          this.localUserMessageIds.delete(clientUserMessageId);
          throw error;
        }
        this.turnImageCleanups.push(prepared.cleanup);
        retained = true;
        this.emitUserMessage(text, images);
        return completion?.promise ?? Promise.resolve();
      }
      const completion = this.createTurnCompletion();
      this.startTurnPromise = this.startTurn(
        prepared.input,
        text,
        images,
        clientUserMessageId,
        prepared.cleanup,
        completion,
      ).finally(() => {
        this.startTurnPromise = null;
      });
      retained = true;
      await this.startTurnPromise;
      return completion.promise;
    } catch (error) {
      if (!retained) await prepared.cleanup();
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.observerModeValue) return;
    if (this.startTurnPromise) await this.startTurnPromise.catch(() => {});
    if (!this.streaming || !this.threadId || !this.turnId) return;
    await this.client.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId });
  }

  respondToInteraction(response: UICodexInteractionResponse): boolean {
    const pending = this.interactions.get(response.id);
    if (!pending) return false;
    this.interactions.delete(response.id);
    const cancelsUserInput = pending.interaction.kind === "user_input" && response.action === "cancel";
    pending.resolve(cancelsUserInput ? null : response);
    this.emitEvent({ type: "interaction_resolved", id: response.id });
    // requestUserInput has no protocol-level cancel decision. The Web action
    // explicitly means "cancel task", so release the server request and also
    // interrupt the active turn instead of submitting an empty answer as if it
    // were successful input.
    if (cancelsUserInput) {
      void this.abort().catch((error) => {
        this.emitEvent({ type: "error", message: "Unable to cancel Codex turn: " + errorMessage(error) });
      });
    }
    return true;
  }

  async loadHistory(cursor: string): Promise<{
    messages: Record<string, unknown>[];
    cursor: string | null;
    hasMore: boolean;
  }> {
    if (!this.threadId) throw new Error("Codex thread is not initialized");
    const response = await this.client.request("thread/turns/list", {
      threadId: this.threadId,
      cursor,
      limit: HISTORY_TURN_LIMIT,
      sortDirection: "desc",
      itemsView: "full",
    });
    const record = isRecord(response) ? response : {};
    const turns = Array.isArray(record.data) ? record.data.filter(isRecord).reverse() : [];
    const next = stringValue(record.nextCursor) ?? null;
    return { messages: turns.flatMap(turnMessages), cursor: next, hasMore: next !== null };
  }

  async fork(): Promise<string> {
    await this.connect();
    if (!this.threadId) throw new Error("Codex thread is not initialized");
    if (this.observerModeValue) {
      throw new Error("该 Codex 会话正被其他客户端使用，当前为只读浏览模式");
    }
    return this.client.forkThread(this.threadId, this.cwdValue);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeNotification?.();
    this.unsubscribeRequest?.();
    this.unsubscribeNotification = null;
    this.unsubscribeRequest = null;
    this.stopObserverPolling();
    // failTurn() abandons every pending interaction (resolving them and
    // notifying the UI), so a browser can never be stranded on an approval
    // dialog for a session that is going away.
    this.failTurn(new Error("Codex session disposed"), false);
    await this.cleanupTurnImages();
    for (const dir of this.imageDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
    this.imageDirs.clear();
    if (this.retainedThreadId) {
      const threadId = this.retainedThreadId;
      this.retainedThreadId = null;
      await this.client.releaseThread(threadId);
    }
    if (this.ownsClient) await this.client.dispose();
  }

  private async connectThread(): Promise<void> {
    await this.client.connect();
    let response: unknown;
    try {
      response = await this.client.request(
        this.threadId ? "thread/resume" : "thread/start",
        this.threadId
          ? {
              threadId: this.threadId,
              initialTurnsPage: { limit: HISTORY_TURN_LIMIT, sortDirection: "desc", itemsView: "full" },
            }
          : {
              cwd: this.cwdValue,
              runtimeWorkspaceRoots: [this.cwdValue],
              approvalPolicy: this.approvalPolicy,
              approvalsReviewer: "user",
              sandbox: this.sandbox,
              ...(this.model ? { model: this.model } : {}),
            },
      );
    } catch (error) {
      // Another client owns the thread's active turn, so the app-server
      // refuses to hand it over. Attach read-only instead of failing the
      // whole session: the Web UI can watch the running turn and gains full
      // control automatically once the writer releases it.
      if (this.threadId && isWriterConflict(error)) {
        await this.enterObserverMode();
        return;
      }
      throw error;
    }
    this.installResumedThread(response);
  }

  /** Shared post-connect processing for a successful thread/resume (initial
   * attach and observer→writer upgrades). */
  private installResumedThread(response: unknown): void {
    const record = isRecord(response) ? response : {};
    const thread = isRecord(record.thread) ? record.thread : undefined;
    const nextThreadId = stringValue(thread?.id);
    if (!nextThreadId) throw new Error("Codex app-server returned no thread id");
    this.threadId = nextThreadId;
    if (!this.retainedThreadId) {
      this.client.retainThread(nextThreadId);
      this.retainedThreadId = nextThreadId;
    }
    this.model = stringValue(record.model) ?? this.model;
    // A resumed native thread owns its runtime settings. In particular,
    // reasoningEffort: null means "use the model default", not "reuse the
    // stale effort remembered by a legacy Web bridge".
    if (Object.hasOwn(record, "reasoningEffort")) {
      this.effort = stringValue(record.reasoningEffort);
    }
    this.cwdValue = stringValue(record.cwd) ?? stringValue(thread?.cwd) ?? this.cwdValue;
    this.observerModeValue = false;
    this.stopObserverPolling();
    this.ready = true;

    const page = turnsFromResume(record);
    this.historyCursorValue = page.cursor;
    const activeTurn = [...page.turns].reverse().find((turn) => stringValue(turn.status) === "inProgress");
    const threadStatus = isRecord(thread?.status) ? thread.status : undefined;
    this.streaming = threadStatus?.type === "active" || !!activeTurn;
    this.turnId = activeTurn ? stringValue(activeTurn.id) : undefined;
    this.activeItems.clear();
    if (activeTurn) {
      for (const item of Array.isArray(activeTurn.items) ? activeTurn.items.filter(isRecord) : []) {
        const tool = itemTool(item);
        if (tool && itemIsActive(item)) {
          this.activeItems.set(tool.id, { name: tool.name, args: tool.args, output: itemResultText(item) });
        }
      }
    }
    this.emitEvent({
      type: "history",
      messages: page.turns.flatMap(turnMessages),
      cursor: page.cursor,
      isStreaming: this.streaming,
      activeTools: this.activeTools,
      reset: true,
    });
    this.emitEvent({
      type: "thread_ready",
      threadId: nextThreadId,
      ...(this.model ? { model: this.model } : {}),
      effort: this.effort ?? null,
      cwd: this.cwdValue,
    });
    if (this.streaming) {
      this.emitEvent({ type: "turn_start", ...(this.turnId ? { turnId: this.turnId } : {}) });
    }
  }

  /** Read-only attach for a thread whose active turn belongs to another client. */
  private async enterObserverMode(): Promise<void> {
    const threadId = this.threadId!;
    const thread = await this.client.readThread(threadId).catch(() => undefined);
    if (!this.retainedThreadId) {
      this.client.retainThread(threadId);
      this.retainedThreadId = threadId;
    }
    if (thread) {
      this.cwdValue = thread.cwd || this.cwdValue;
    }
    this.ready = true;
    this.observerModeValue = true;
    this.emitEvent({
      type: "thread_ready",
      threadId,
      ...(this.model ? { model: this.model } : {}),
      effort: null,
      cwd: this.cwdValue,
    });
    await this.pollObserverTurn();
    this.observerPollTimer = setInterval(() => {
      void this.pollObserverTurn();
    }, OBSERVER_POLL_MS);
  }

  private stopObserverPolling(): void {
    if (this.observerPollTimer !== null) {
      clearInterval(this.observerPollTimer);
      this.observerPollTimer = null;
    }
    this.observerPolling = false;
  }

  /** One read-only observation tick: try to claim the thread (upgrade), then
   * refresh the newest turn page and broadcast any visible changes. */
  private async pollObserverTurn(): Promise<void> {
    if (this.observerPolling || !this.threadId || !this.observerModeValue) return;
    this.observerPolling = true;
    try {
      // Upgrade probe: the app-server hands the thread over as soon as the
      // current writer releases it (turn completes, is cancelled, or the
      // owning client disconnects).
      let upgraded = false;
      try {
        const response = await this.client.request("thread/resume", {
          threadId: this.threadId,
          initialTurnsPage: { limit: HISTORY_TURN_LIMIT, sortDirection: "desc", itemsView: "full" },
        });
        this.installResumedThread(response);
        upgraded = true;
      } catch (error) {
        if (!isWriterConflict(error)) {
          this.emitEvent({ type: "error", message: errorMessage(error) });
        }
      }
      if (upgraded) return;

      const response = await this.client.request("thread/turns/list", {
        threadId: this.threadId,
        cursor: null,
        limit: HISTORY_TURN_LIMIT,
        sortDirection: "desc",
        itemsView: "full",
      });
      const record = isRecord(response) ? response : {};
      const turns = Array.isArray(record.data) ? record.data.filter(isRecord).reverse() : [];
      const cursor = stringValue(record.nextCursor) ?? null;
      const activeTurn = turns.find((turn) => stringValue(turn.status) === "inProgress");
      this.activeItems.clear();
      if (activeTurn) {
        for (const item of Array.isArray(activeTurn.items) ? activeTurn.items.filter(isRecord) : []) {
          const tool = itemTool(item);
          if (tool && itemIsActive(item)) {
            this.activeItems.set(tool.id, { name: tool.name, args: tool.args, output: itemResultText(item) });
          }
        }
      }
      const streaming = !!activeTurn;
      const messages = turns.flatMap(turnMessages);
      const turnId = activeTurn ? stringValue(activeTurn.id) : undefined;
      const activeTools = this.activeTools;
      const fingerprint = observerSnapshotFingerprint({
        messages,
        cursor,
        isStreaming: streaming,
        ...(turnId ? { turnId } : {}),
        activeTools,
      });
      if (fingerprint === this.observerFingerprint) return;
      this.observerFingerprint = fingerprint;
      this.historyCursorValue = cursor;
      this.streaming = streaming;
      this.turnId = turnId;
      this.emitEvent({
        type: "history",
        messages,
        cursor,
        isStreaming: streaming,
        activeTools,
      });
      if (streaming) {
        this.emitEvent({ type: "turn_start", ...(this.turnId ? { turnId: this.turnId } : {}) });
      }
    } finally {
      this.observerPolling = false;
    }
  }

  private async startTurn(
    input: CodexInput[],
    text: string,
    images: CodexImageInput[],
    clientUserMessageId: string,
    cleanup: () => Promise<void>,
    completion: TurnCompletion,
  ): Promise<void> {
    if (!this.threadId) throw new Error("Codex thread was not initialized");
    this.streaming = true;
    this.turnImageCleanups.push(cleanup);
    this.localUserMessageIds.add(clientUserMessageId);
    try {
      const response = await this.client.request("turn/start", {
        threadId: this.threadId,
        clientUserMessageId,
        input,
        ...(this.model ? { model: this.model } : {}),
        ...(this.effort ? { effort: this.effort } : {}),
      });
      const turn = isRecord(response) && isRecord(response.turn) ? response.turn : undefined;
      this.turnId = stringValue(turn?.id) ?? this.turnId;
      if (this.turnCompletion === completion) {
        this.emitEvent({ type: "turn_start", ...(this.turnId ? { turnId: this.turnId } : {}) });
      }
      this.emitUserMessage(text, images);
    } catch (error) {
      this.localUserMessageIds.delete(clientUserMessageId);
      this.failTurn(error instanceof Error ? error : new Error(errorMessage(error)), true);
      throw error;
    }
  }

  private createTurnCompletion(): TurnCompletion {
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    void promise.catch(() => {});
    this.turnCompletion = { promise, resolve, reject };
    return this.turnCompletion;
  }

  private async handleServerRequest(message: JsonRpcMessage): Promise<ServerRequestResult | undefined> {
    if (!message.method || message.id === undefined) return undefined;
    const params = isRecord(message.params) ? message.params : {};
    if (!this.threadId || threadIdFromParams(params) !== this.threadId) return undefined;
    const interaction = this.interactionForRequest(String(message.id), message.method, params);
    if (!interaction) return undefined;
    const response = await new Promise<UICodexInteractionResponse | null>((resolve) => {
      this.interactions.set(interaction.id, {
        interaction,
        method: message.method!,
        rpcId: String(message.id),
        params,
        resolve,
      });
      this.emitEvent({ type: "interaction", interaction });
    });
    if (!response) return { suppressResponse: true };
    return { result: this.interactionResult(message.method, params, response) };
  }

  private interactionForRequest(
    rpcId: string,
    method: string,
    params: Record<string, unknown>,
  ): UICodexInteraction | null {
    const id = this.threadId + ":" + rpcId;
    if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
      const rawCommand = params.command;
      const command = Array.isArray(rawCommand)
        ? rawCommand.map(String).join(" ")
        : typeof rawCommand === "string" ? rawCommand : "";
      const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions : [];
      const details = Object.fromEntries(
        ["commandActions", "networkApprovalContext", "additionalPermissions", "proposedExecpolicyAmendment", "proposedNetworkPolicyAmendments"]
          .flatMap((key) => params[key] === undefined || params[key] === null ? [] : [[key, params[key]]]),
      );
      return {
        id,
        kind: "command_approval",
        command,
        ...(stringValue(params.cwd) ? { cwd: String(params.cwd) } : {}),
        ...(stringValue(params.reason) ? { reason: String(params.reason) } : {}),
        ...(Object.keys(details).length ? { details } : {}),
        allowSessionApproval: method === "execCommandApproval" || decisions.includes("acceptForSession"),
      };
    }
    if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
      const itemId = stringValue(params.itemId);
      const turnId = stringValue(params.turnId);
      const changes = params.fileChanges
        ?? (itemId ? this.fileChanges.get(itemId) : undefined)
        ?? (turnId ? this.turnDiffs.get(turnId) : undefined);
      return {
        id,
        kind: "file_approval",
        ...(stringValue(params.reason) ? { reason: String(params.reason) } : {}),
        ...(stringValue(params.grantRoot) ? { grantRoot: String(params.grantRoot) } : {}),
        ...(changes !== undefined ? { changes } : {}),
        allowSessionApproval: true,
      };
    }
    if (method === "item/tool/requestUserInput") {
      const questions = Array.isArray(params.questions)
        ? params.questions.filter(isRecord).flatMap((question) => {
            const questionId = stringValue(question.id);
            if (!questionId) return [];
            const options = Array.isArray(question.options)
              ? question.options.filter(isRecord).flatMap((option) => {
                  const label = stringValue(option.label);
                  return label ? [{
                    label,
                    ...(stringValue(option.description) ? { description: String(option.description) } : {}),
                  }] : [];
                })
              : undefined;
            return [{
              id: questionId,
              header: stringValue(question.header) ?? "Question",
              question: stringValue(question.question) ?? "",
              ...(options && options.length ? { options } : {}),
              allowOther: question.isOther === true,
              secret: question.isSecret === true,
            }];
          })
        : [];
      return { id, kind: "user_input", questions };
    }
    if (method === "mcpServer/elicitation/request") {
      const mode = params.mode === "url" ? "url" : "form";
      return {
        id,
        kind: "mcp_elicitation",
        serverName: stringValue(params.serverName) ?? "MCP server",
        message: stringValue(params.message) ?? "This MCP server needs more information.",
        mode,
        ...(mode === "url" && stringValue(params.url) ? { url: String(params.url) } : {}),
        ...(mode === "form" ? { schema: params.requestedSchema ?? {} } : {}),
      };
    }
    if (method === "item/permissions/requestApproval") {
      return {
        id,
        kind: "permissions_approval",
        ...(stringValue(params.cwd) ? { cwd: String(params.cwd) } : {}),
        ...(stringValue(params.reason) ? { reason: String(params.reason) } : {}),
        permissions: params.permissions ?? {},
      };
    }
    return null;
  }

  private interactionResult(
    method: string,
    params: Record<string, unknown>,
    response: UICodexInteractionResponse,
  ): unknown {
    const accepted = response.action === "accept"
      || response.action === "accept_for_session"
      || response.action === "submit";
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const decision = response.action === "accept_for_session"
        ? "acceptForSession"
        : response.action === "accept" || response.action === "submit"
          ? "accept"
          : response.action === "cancel" ? "cancel" : "decline";
      return { decision };
    }
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      const decision = response.action === "accept_for_session"
        ? "approved_for_session"
        : response.action === "accept" || response.action === "submit"
          ? "approved"
          : response.action === "cancel"
            ? "abort"
            : { denied: { rejection: "Declined by user" } };
      return { decision };
    }
    if (method === "item/tool/requestUserInput") {
      const answers = Object.fromEntries(
        Object.entries(response.answers ?? {}).map(([id, values]) => [id, { answers: values }]),
      );
      return { answers };
    }
    if (method === "mcpServer/elicitation/request") {
      return {
        action: accepted ? "accept" : response.action === "cancel" ? "cancel" : "decline",
        content: accepted ? response.content ?? {} : null,
        _meta: null,
      };
    }
    if (method === "item/permissions/requestApproval") {
      const requested = isRecord(params.permissions) ? params.permissions : {};
      const permissions = accepted
        ? Object.fromEntries(Object.entries(requested).filter(([, value]) => value !== null))
        : {};
      return { permissions, scope: response.scope ?? "turn" };
    }
    return {};
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === "connection/error") {
      this.ready = false;
      const message = stringValue(params.message) ?? "Codex app-server connection failed";
      // Surface the disconnected state to the connection badge immediately.
      // failTurn() below also abandons any pending approvals so open dialogs
      // close instead of blocking the UI forever.
      this.emitEvent({
        type: "remote_status",
        status: { status: "errored" },
      });
      this.failTurn(new Error(message), true);
      this.emitEvent({ type: "error", message });
      return;
    }
    const notificationThreadId = threadIdFromParams(params)
      ?? (isRecord(params.thread) ? stringValue(params.thread.id) : undefined);
    // A shared app-server can have several not-yet-started Web drafts. The
    // matching thread/start response, not another draft's broadcast, owns a
    // new thread identity.
    if (notificationThreadId && (!this.threadId || notificationThreadId !== this.threadId)) return;
    switch (method) {
      case "thread/started": {
        const thread = isRecord(params.thread) ? params.thread : undefined;
        const id = stringValue(thread?.id);
        if (id && (!this.threadId || id === this.threadId)) {
          this.threadId = id;
          this.emitEvent({ type: "thread_ready", threadId: id });
        }
        return;
      }
      case "turn/started": {
        const turn = isRecord(params.turn) ? params.turn : undefined;
        this.turnId = stringValue(turn?.id) ?? this.turnId;
        this.streaming = true;
        this.emitEvent({ type: "turn_start", ...(this.turnId ? { turnId: this.turnId } : {}) });
        return;
      }
      case "item/agentMessage/delta":
        this.appendItemText(params);
        return;
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta":
        this.appendItemThinking(params);
        return;
      case "item/reasoning/summaryPartAdded":
        return;
      case "item/started":
        this.handleItemStarted(params);
        return;
      case "item/completed":
        this.handleItemCompleted(params);
        return;
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
      case "item/fileChange/patchUpdated":
      case "item/mcpToolCall/progress":
        this.handleToolProgress(params);
        return;
      case "turn/diff/updated": {
        const turnId = stringValue(params.turnId);
        const diff = typeof params.diff === "string" ? params.diff : "";
        if (turnId) {
          this.turnDiffs.set(turnId, diff);
          this.refreshFileApprovalEvidence({ turnId, changes: diff });
        }
        return;
      }
      case "turn/plan/updated": {
        const plan = Array.isArray(params.plan)
          ? params.plan.filter(isRecord).flatMap((step) => {
              const text = stringValue(step.step);
              return text ? [{ step: text, status: stringValue(step.status) ?? "pending" }] : [];
            })
          : [];
        this.emitEvent({
          type: "plan",
          plan,
          ...(stringValue(params.explanation) ? { explanation: String(params.explanation) } : {}),
        });
        return;
      }
      case "thread/tokenUsage/updated":
        this.handleTokenUsage(params);
        return;
      case "serverRequest/resolved":
        this.resolveInteractionExternally(String(params.requestId ?? ""));
        return;
      case "model/rerouted":
        this.model = stringValue(params.toModel) ?? stringValue(params.model) ?? this.model;
        if (this.threadId) {
          this.emitEvent({
            type: "thread_ready",
            threadId: this.threadId,
            ...(this.model ? { model: this.model } : {}),
          });
        }
        return;
      case "thread/settings/updated": {
        const settings = isRecord(params.threadSettings) ? params.threadSettings : undefined;
        this.model = stringValue(settings?.model) ?? this.model;
        const hasEffort = !!settings && Object.hasOwn(settings, "effort");
        if (hasEffort) this.effort = stringValue(settings.effort);
        this.cwdValue = stringValue(settings?.cwd) ?? this.cwdValue;
        if (this.threadId) {
          this.emitEvent({
            type: "thread_ready",
            threadId: this.threadId,
            ...(this.model ? { model: this.model } : {}),
            ...(hasEffort ? { effort: this.effort ?? null } : {}),
            cwd: this.cwdValue,
          });
        }
        return;
      }
      case "thread/reverted":
      case "thread/compacted":
        this.emitEvent({ type: "catalog_changed" });
        this.scheduleHistoryRefresh();
        return;
      case "thread/name/updated":
      case "thread/status/changed":
      case "thread/unarchived":
        this.emitEvent({ type: "catalog_changed" });
        return;
      case "thread/deleted":
      case "thread/archived":
      case "thread/closed": {
        this.ready = false;
        const message = method === "thread/deleted"
          ? "This Codex thread was deleted in another client."
          : "This Codex thread is no longer available in this view.";
        this.failTurn(new Error(message), true);
        this.emitEvent({ type: "catalog_changed" });
        this.emitEvent({ type: "error", message });
        return;
      }
      case "remoteControl/status/changed": {
        const status = stringValue(params.status);
        this.emitEvent({
          type: "remote_status",
          status: {
            status: status === "connecting" || status === "connected" || status === "errored" ? status : "disabled",
            ...(stringValue(params.serverName) ? { serverName: String(params.serverName) } : {}),
            ...(stringValue(params.installationId) ? { installationId: String(params.installationId) } : {}),
            ...(params.environmentId === null || typeof params.environmentId === "string"
              ? { environmentId: params.environmentId }
              : {}),
          },
        });
        return;
      }
      case "turn/completed":
        this.handleTurnCompleted(params);
        return;
      case "warning":
      case "guardianWarning":
      case "configWarning":
      case "error": {
        const error = isRecord(params.error) ? params.error : params;
        this.emitEvent({
          type: "error",
          message: stringValue(error.message) ?? stringValue(params.message) ?? "Codex app-server error",
        });
        return;
      }
      default:
        return;
    }
  }

  private appendItemText(params: Record<string, unknown>): void {
    const id = stringValue(params.itemId);
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (!id || !delta) return;
    this.itemText.set(id, (this.itemText.get(id) ?? "") + delta);
    this.emitEvent({ type: "text_delta", delta });
  }

  private appendItemThinking(params: Record<string, unknown>): void {
    const id = stringValue(params.itemId);
    const delta = typeof params.delta === "string" ? params.delta : "";
    if (!id || !delta) return;
    this.itemThinking.set(id, (this.itemThinking.get(id) ?? "") + delta);
    this.emitEvent({ type: "thinking_delta", delta });
  }

  private handleItemStarted(params: Record<string, unknown>): void {
    const item = isRecord(params.item) ? params.item : null;
    if (!item) return;
    const tool = itemTool(item);
    if (!tool) return;
    if (item.type === "fileChange" && item.changes !== undefined) {
      this.fileChanges.set(tool.id, item.changes);
      this.refreshFileApprovalEvidence({ itemId: tool.id, changes: item.changes });
    }
    this.activeItems.set(tool.id, { name: tool.name, args: tool.args, output: "" });
    this.emitEvent({ type: "tool_start", toolCallId: tool.id, toolName: tool.name, args: tool.args });
  }

  private handleToolProgress(params: Record<string, unknown>): void {
    const id = stringValue(params.itemId);
    if (id && Array.isArray(params.changes)) {
      this.fileChanges.set(id, params.changes);
      this.refreshFileApprovalEvidence({ itemId: id, changes: params.changes });
    }
    const delta = typeof params.delta === "string"
      ? params.delta
      : typeof params.output === "string"
        ? params.output
        : typeof params.patch === "string"
          ? params.patch
          : Array.isArray(params.changes)
            ? safeJson(params.changes)
            : stringValue(params.message) ?? "";
    if (!id || !delta) return;
    const active = this.activeItems.get(id);
    if (active) active.output = (active.output + delta).slice(-128_000);
    this.emitEvent({ type: "tool_progress", toolCallId: id, delta });
  }

  private handleItemCompleted(params: Record<string, unknown>): void {
    const item = isRecord(params.item) ? params.item : null;
    if (!item) return;
    const id = itemId(item);
    if (item.type === "fileChange" && item.changes !== undefined) this.fileChanges.set(id, item.changes);
    const completedAt = numberValue(params.completedAtMs);
    if (item.type === "userMessage") {
      const clientId = stringValue(item.clientId);
      if (!clientId || !this.localUserMessageIds.delete(clientId)) {
        for (const message of itemMessages(item, Date.now())) {
          this.emitEvent({ type: "message", message, ...(completedAt ? { completedAt } : {}) });
        }
      }
    } else if (item.type === "agentMessage") {
      const text = typeof item.text === "string" ? item.text : this.itemText.get(id) ?? "";
      if (text) {
        this.lastAssistantTextValue = text;
        this.emitEvent({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text }], timestamp: Date.now() },
          ...(completedAt ? { completedAt } : {}),
        });
      }
    } else if (item.type === "reasoning" || item.type === "plan") {
      for (const message of itemMessages(item, Date.now())) {
        this.emitEvent({ type: "message", message, ...(completedAt ? { completedAt } : {}) });
      }
      if (item.type === "reasoning") this.emitEvent({ type: "thinking_end" });
    }
    const tool = itemTool(item);
    if (tool) {
      if (!this.activeItems.has(tool.id)) {
        this.activeItems.set(tool.id, { name: tool.name, args: tool.args, output: "" });
        this.emitEvent({ type: "tool_start", toolCallId: tool.id, toolName: tool.name, args: tool.args });
      }
      for (const message of itemMessages(item, Date.now())) {
        this.emitEvent({ type: "message", message, ...(completedAt ? { completedAt } : {}) });
      }
      this.activeItems.delete(tool.id);
      this.emitEvent({ type: "tool_end", toolCallId: tool.id, toolName: tool.name, isError: itemError(item) });
    }
    this.itemText.delete(id);
    this.itemThinking.delete(id);
  }

  private scheduleHistoryRefresh(): void {
    if (!this.threadId || this.disposed) return;
    this.historyRefreshDirty = true;
    if (this.refreshHistoryPromise) return;
    const drainRefreshes = async () => {
      while (this.historyRefreshDirty && this.threadId && !this.disposed) {
        this.historyRefreshDirty = false;
        await this.refreshHistory();
      }
    };
    this.refreshHistoryPromise = drainRefreshes().finally(() => {
      this.refreshHistoryPromise = null;
      // If the current refresh failed after another invalidation arrived, the
      // dirty state still needs a fresh attempt rather than being dropped.
      if (this.historyRefreshDirty && this.threadId && !this.disposed) this.scheduleHistoryRefresh();
    });
    void this.refreshHistoryPromise.catch((error) => {
      this.emitEvent({ type: "error", message: "Unable to refresh Codex history: " + errorMessage(error) });
    });
  }

  private async refreshHistory(): Promise<void> {
    if (!this.threadId) return;
    const response = await this.client.request("thread/turns/list", {
      threadId: this.threadId,
      cursor: null,
      limit: HISTORY_TURN_LIMIT,
      sortDirection: "desc",
      itemsView: "full",
    });
    const record = isRecord(response) ? response : {};
    const turns = Array.isArray(record.data) ? record.data.filter(isRecord).reverse() : [];
    const cursor = stringValue(record.nextCursor) ?? null;
    const activeTurn = [...turns].reverse().find((turn) => stringValue(turn.status) === "inProgress");
    this.historyCursorValue = cursor;
    this.streaming = !!activeTurn;
    this.turnId = activeTurn ? stringValue(activeTurn.id) : undefined;
    this.activeItems.clear();
    if (activeTurn) {
      for (const item of Array.isArray(activeTurn.items) ? activeTurn.items.filter(isRecord) : []) {
        const tool = itemTool(item);
        if (tool && itemIsActive(item)) {
          this.activeItems.set(tool.id, { name: tool.name, args: tool.args, output: itemResultText(item) });
        }
      }
    }
    this.emitEvent({
      type: "history",
      messages: turns.flatMap(turnMessages),
      cursor,
      isStreaming: this.streaming,
      activeTools: this.activeTools,
      reset: true,
    });
  }

  private handleTokenUsage(params: Record<string, unknown>): void {
    const usage = isRecord(params.tokenUsage) ? params.tokenUsage : undefined;
    const total = isRecord(usage?.total) ? usage.total : undefined;
    const tokens = numberValue(total?.totalTokens);
    const contextWindow = numberValue(usage?.modelContextWindow);
    const context = tokens !== undefined && contextWindow !== undefined && contextWindow > 0
      ? { tokens, contextWindow, percent: Math.min(100, tokens / contextWindow * 100) }
      : null;
    this.emitEvent({ type: "context", context });
  }

  private refreshFileApprovalEvidence(update: {
    turnId?: string;
    itemId?: string;
    changes: unknown;
  }): void {
    for (const pending of this.interactions.values()) {
      if (pending.interaction.kind !== "file_approval") continue;
      if (update.turnId && stringValue(pending.params.turnId) !== update.turnId) continue;
      if (update.itemId && stringValue(pending.params.itemId) !== update.itemId) continue;
      pending.interaction = { ...pending.interaction, changes: update.changes };
      this.emitEvent({ type: "interaction", interaction: pending.interaction });
    }
  }

  private handleTurnCompleted(params: Record<string, unknown>): void {
    const turn = isRecord(params.turn) ? params.turn : undefined;
    const status = stringValue(turn?.status) ?? "completed";
    const error = isRecord(turn?.error) ? stringValue(turn.error.message) : stringValue(turn?.error);
    this.streaming = false;
    this.turnId = undefined;
    for (const [id, active] of this.activeItems) {
      this.emitEvent({ type: "tool_end", toolCallId: id, toolName: active.name, isError: status !== "completed" });
    }
    this.activeItems.clear();
    this.localUserMessageIds.clear();
    this.turnDiffs.clear();
    this.fileChanges.clear();
    this.abandonInteractions();
    this.emitEvent({ type: "turn_end", status, ...(error ? { error } : {}) });
    const completion = this.turnCompletion;
    this.turnCompletion = null;
    if (completion) {
      if (status === "failed") completion.reject(new Error(error ?? "Codex turn failed"));
      else completion.resolve();
    }
    void this.cleanupTurnImages();
  }

  private emitUserMessage(text: string, images: CodexImageInput[]): void {
    const content: Record<string, unknown>[] = [];
    if (text) content.push({ type: "text", text });
    for (const image of images) content.push({ type: "image", data: image.data, mimeType: image.mimeType });
    if (content.length) {
      this.emitEvent({ type: "message", message: { role: "user", content, timestamp: Date.now() } });
    }
  }

  private async createInput(
    text: string,
    images: CodexImageInput[],
  ): Promise<{ input: CodexInput[]; cleanup: () => Promise<void> }> {
    const input: CodexInput[] = [];
    if (text) input.push({ type: "text", text, text_elements: [] });
    if (!images.length) return { input, cleanup: async () => {} };
    const dir = await mkdtemp(join(tmpdir(), "pi-web-chat-codex-"));
    this.imageDirs.add(dir);
    for (const [index, image] of images.entries()) {
      const path = join(dir, String(index) + imageExtension(image.mimeType));
      await writeFile(path, Buffer.from(image.data, "base64"));
      input.push({ type: "localImage", path });
    }
    let cleaned = false;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      this.imageDirs.delete(dir);
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    };
    return { input, cleanup };
  }

  private resolveInteractionExternally(rpcId: string): void {
    const pending = [...this.interactions.values()].find((value) => value.rpcId === rpcId);
    if (!pending) return;
    this.interactions.delete(pending.interaction.id);
    // Another app-server client already answered this request. Dismiss the Web
    // prompt without racing that decision with a second JSON-RPC response.
    pending.resolve(null);
    this.emitEvent({ type: "interaction_resolved", id: pending.interaction.id });
  }

  private abandonInteractions(): void {
    for (const pending of this.interactions.values()) {
      pending.resolve(null);
      this.emitEvent({ type: "interaction_resolved", id: pending.interaction.id });
    }
    this.interactions.clear();
  }

  private failTurn(error: Error, emitTerminal: boolean): void {
    const wasStreaming = this.streaming || !!this.turnCompletion;
    this.streaming = false;
    this.turnId = undefined;
    for (const [id, active] of this.activeItems) {
      this.emitEvent({ type: "tool_end", toolCallId: id, toolName: active.name, isError: true });
    }
    this.activeItems.clear();
    this.localUserMessageIds.clear();
    this.turnDiffs.clear();
    this.fileChanges.clear();
    this.abandonInteractions();
    const completion = this.turnCompletion;
    this.turnCompletion = null;
    if (completion) completion.reject(error);
    if (emitTerminal && wasStreaming) {
      this.emitEvent({ type: "turn_end", status: "failed", error: error.message });
    }
    void this.cleanupTurnImages();
  }

  private async cleanupTurnImages(): Promise<void> {
    const cleanups = this.turnImageCleanups.splice(0);
    await Promise.all(cleanups.map((cleanup) => cleanup().catch(() => {})));
  }
}

export function codexThinkingLevels(model: CodexModelInfo | undefined): UIThinkingLevel[] {
  const levels = model?.supportedReasoningEfforts
    .map((option) => option.reasoningEffort)
    .filter((value): value is UIThinkingLevel =>
      ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"].includes(value),
    ) ?? [];
  const unique = levels.filter((value, index) => levels.indexOf(value) === index);
  return unique.length > 0 ? unique : ["medium"];
}

function imageExtension(mimeType: string): string {
  const subtype = mimeType.toLowerCase().split("/", 2)[1] ?? "png";
  const clean = subtype.replace(/[^a-z0-9]/g, "");
  return "." + (clean || "png");
}
