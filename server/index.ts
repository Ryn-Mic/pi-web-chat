import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CreateAgentSessionRuntimeFactory,
  type ExtensionUIContext,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { WebSocketServer, type WebSocket } from "ws";
import QRCode from "qrcode";
import type {
  ClientCommand,
  ServerEvent,
  UICustomModelsResponse,
  UICustomProvider,
  UIModelDiscoveryRequest,
  UIExtensionInfo,
  UICommandInfo,
  UIExtensionUIRequest,
  UISessionInfo,
  UISnapshot,
  UIThinkingLevel,
} from "../shared/protocol.ts";
import { auth, authStartupInfo } from "./auth.ts";
import { readCustomModels, resolveIncomingApiKey, validateProviders, writeCustomModels } from "./models-config.ts";
import { getActiveTodo, serializeMessages } from "./serialize.ts";

const PORT = Number(process.env.PORT ?? 3141);
// Default to loopback — this server has no auth and can drive a coding agent.
// Override with HOST=0.0.0.0 only on trusted networks.
const HOST = process.env.HOST ?? "127.0.0.1";
const HOME = homedir();
// Personal chat workspace (separate from the project cwd). Override with PI_WEB_CWD.
const DEFAULT_AGENT_CWD = join(HOME, ".pi", "web-chat");
const AGENT_CWD = resolve(process.env.PI_WEB_CWD ?? DEFAULT_AGENT_CWD);
mkdirSync(AGENT_CWD, { recursive: true });

/** Daemon state file dir (same STATE_DIR as extensions/pi-web-chat.ts) */
const DAEMON_STATE_DIR = join(HOME, ".pi", "web-chat");

// Resolve static assets for both layouts:
//   production package: <pkg>/dist/index.js  + <pkg>/dist/public/
//   dev (tsx server/):  <pkg>/server/index.ts + <pkg>/dist/  (vite default) or dist/public
const HERE = dirname(fileURLToPath(import.meta.url));

function readPackageVersion(): string {
  for (const candidate of [join(HERE, "..", "package.json"), join(HERE, "package.json")]) {
    try {
      if (!existsSync(candidate)) continue;
      const v = (JSON.parse(readFileSync(candidate, "utf8")) as { version?: string }).version;
      if (v) return v;
    } catch {
      /* ignore */
    }
  }
  return "unknown";
}
const PACKAGE_VERSION = readPackageVersion();

function readReleaseNotes(version: string): string[] {
  const candidates = [
    join(HERE, "..", "release-notes.json"),
    join(HERE, "release-notes.json"),
    join(HERE, "..", "..", "release-notes.json"),
  ];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>;
      const notes = parsed[version];
      if (!Array.isArray(notes)) continue;
      return notes.filter(
        (note): note is string => typeof note === "string" && note.trim().length > 0,
      );
    } catch {
      /* A missing or malformed notes file must not prevent the server from starting. */
    }
  }
  return [];
}
const RELEASE_NOTES = readReleaseNotes(PACKAGE_VERSION);
const DIST_DIR = (() => {
  const candidates = [
    join(HERE, "public"), // dist/index.js → dist/public
    join(HERE, "dist", "public"), // monorepo-style
    join(HERE, "..", "dist", "public"), // server/index.ts → dist/public
    join(HERE, "..", "dist"), // server/index.ts → dist (legacy vite outDir)
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return candidates[0]!;
})();

// ---------------------------------------------------------------------------
// pi session runtime
// ---------------------------------------------------------------------------

let modelRuntime = await ModelRuntime.create();

const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
  const services = await createAgentSessionServices({ cwd });
  return {
    ...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
    services,
    diagnostics: services.diagnostics,
  };
};

// ---------------------------------------------------------------------------
// Session hub: holds one runtime per session and broadcasts only among
// clients viewing the same session. Maps 1:1 to URL /s/:sessionId.
// ---------------------------------------------------------------------------

interface SessionEntry {
  id: string;
  runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  clients: Set<WebSocket>;
  unsubscribe?: () => void;
  lastActive: number;
  /**
   * Whether this session is exposed in the URL.
   * A blank draft created from `/` stays false until the first prompt — the
   * address does not get a sessionId attached.
   */
  published: boolean;
  /** Guards against duplicate reloads */
  reloading?: boolean;
  /** Last (size, mtimeMs) seen by the external-append poller — avoids
      re-reading the whole session file when it hasn't changed. */
  lastFileStat?: { size: number; mtimeMs: number };
  /** Browser that initiated the current extension command, if any. */
  extensionUIClient?: WebSocket;
  pendingExtensionUI: Map<string, (response: { cancelled?: boolean; value?: string; confirmed?: boolean }) => void>;
}

const entries = new Map<string, SessionEntry>();
const pending = new Map<string, Promise<SessionEntry>>();
const wsEntry = new Map<WebSocket, SessionEntry>();
/** Grace period before idle session runtimes are cleaned up */
const IDLE_TTL_MS = 15 * 60_000;

/** Session filename (<timestamp>_<uuid>.jsonl) → URL identifier */
function sessionIdOf(file?: string): string {
  if (!file) return "";
  const base = basename(file).replace(/\.jsonl$/, "");
  const i = base.lastIndexOf("_");
  return i >= 0 ? base.slice(i + 1) : base;
}

async function resolveSessionPath(id: string): Promise<string | undefined> {
  const sessions = await SessionManager.listAll();
  return sessions.find((s) => sessionIdOf(s.path) === id)?.path;
}

/**
 * Project directory a session belongs to (for display): session header cwd
 * wins; otherwise fall back to the parent dir name under sessions/.
 */
function projectOf(s: { cwd?: string; path: string }): string {
  const cwd = s.cwd;
  if (cwd) {
    return cwd === HOME ? "~" : cwd.startsWith(HOME + "/") ? "~" + cwd.slice(HOME.length) : cwd;
  }
  return basename(dirname(s.path));
}

function broadcastTo(entry: SessionEntry, event: ServerEvent) {
  const data = JSON.stringify(event);
  for (const ws of entry.clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

/** Expose a session in the URL (idempotent). Called on first message, on
 * existing-session connect, and on fork. */
function publishEntry(entry: SessionEntry, ws?: WebSocket) {
  entry.published = true;
  const event: ServerEvent = { type: "session_bound", sessionId: entry.id };
  if (ws) sendTo(ws, event);
  else broadcastTo(entry, event);
}

/** Re-key the entry when the session is replaced (fork etc.) and notify clients */
function rekeyEntry(entry: SessionEntry) {
  const next = sessionIdOf(entry.runtime.session.sessionFile);
  if (!next || next === entry.id) return;
  entries.delete(entry.id);
  entry.id = next;
  entries.set(next, entry);
  entry.published = true;
  broadcastTo(entry, { type: "session_bound", sessionId: next });
}

/** Expand ~ or ~/... to a HOME-based absolute path */
function expandHome(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return join(HOME, p.slice(2));
  return p;
}

async function createEntry(id: string | null, cwd?: string): Promise<SessionEntry> {
  const path = id ? await resolveSessionPath(id) : undefined;
  // Opening an existing session keeps the old behavior (AGENT_CWD); only
  // brand-new sessions honor the cwd parameter.
  const sessionCwd = path ? AGENT_CWD : cwd ? expandHome(cwd) : AGENT_CWD;
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: sessionCwd,
    agentDir: getAgentDir(),
    sessionManager: SessionManager.create(sessionCwd),
  });
  if (path) await runtime.switchSession(path);
  const entry: SessionEntry = {
    id: sessionIdOf(runtime.session.sessionFile),
    runtime,
    clients: new Set(),
    lastActive: Date.now(),
    // Only sessions opened with an explicit id are published immediately.
    // A null connect is a blank draft.
    published: id !== null,
    pendingExtensionUI: new Map(),
  };
  entries.set(entry.id, entry);
  bindSession(entry);
  await bindWebExtensions(entry);
  installEntryRuntimeRebind(entry);
  return entry;
}

/** New session when id is null, otherwise reuse the existing runtime (avoids
 * concurrent-connect races) */
async function acquireEntry(id: string | null, cwd?: string): Promise<SessionEntry> {
  if (!id) return createEntry(null, cwd);
  const hit = entries.get(id);
  if (hit) return hit;
  const inflight = pending.get(id);
  if (inflight) return inflight;
  const p = createEntry(id).finally(() => pending.delete(id));
  pending.set(id, p);
  return p;
}

/** Clean up empty, stale runtimes */
setInterval(() => {
  const now = Date.now();
  for (const entry of [...entries.values()]) {
    if (entry.clients.size > 0 || entry.runtime.session.isStreaming) continue;
    if (now - entry.lastActive < IDLE_TTL_MS) continue;
    entries.delete(entry.id);
    entry.unsubscribe?.();
    void entry.runtime.dispose().catch(() => {});
  }
}, 60_000).unref();

/**
 * If the session file gains entries externally (a pi process in the terminal
 * etc.), reload the runtime so the view stays current. Streaming sessions are
 * left alone to protect an in-flight prompt response.
 */
async function reloadEntry(entry: SessionEntry): Promise<void> {
  if (entry.reloading) return;
  entry.reloading = true;
  try {
    const file = entry.runtime.session.sessionFile;
    if (!file) return;
    entry.unsubscribe?.();
    try {
      await entry.runtime.dispose();
    } catch {
      /* ignore */
    }
    const runtime = await createAgentSessionRuntime(createRuntime, {
      cwd: AGENT_CWD,
      agentDir: getAgentDir(),
      sessionManager: SessionManager.create(AGENT_CWD),
    });
    await runtime.switchSession(file);
    entry.runtime = runtime;
    bindSession(entry);
    await bindWebExtensions(entry);
    installEntryRuntimeRebind(entry);
    broadcastSnapshot(entry);
    sendCommandCatalog(entry);
  } finally {
    entry.reloading = false;
  }
}

/** Actual entry count in the file (excluding blank lines) */
function countFileEntries(file: string): number {
  const content = readFileSync(file, "utf8");
  let count = 0;
  for (const line of content.split("\n")) {
    if (line.trim().length > 0) count++;
  }
  return count;
}

setInterval(() => {
  for (const entry of [...entries.values()]) {
    if (entry.clients.size === 0) continue;
    const file = entry.runtime.session.sessionFile;
    if (!file || entry.reloading || entry.runtime.session.isStreaming) continue;
    // Cheap stat first: only read the whole file when it actually changed.
    // Long sessions grow to hundreds of KB — parsing that every 1.5s is a
    // sustained disk/CPU cost (noticeable on battery-powered dev machines).
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue; // file not created yet (blank draft)
    }
    const prev = entry.lastFileStat;
    if (prev && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) continue;
    entry.lastFileStat = { size: stat.size, mtimeMs: stat.mtimeMs };
    let fileEntries = 0;
    try {
      fileEntries = countFileEntries(file);
    } catch {
      continue; // file not created yet (blank draft)
    }
    // More file entries than header(1) + in-memory entries → external append → reload
    const memoryEntries = entry.runtime.session.sessionManager.getEntries().length + 1;
    if (fileEntries > memoryEntries) {
      void reloadEntry(entry).catch(() => {});
    }
  }
}, 1500).unref();

const ALL_THINKING_LEVELS: UIThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

// Cache git branch lookups with a short TTL so we don't spawn git on every snapshot.
const gitBranchCache = new Map<string, { branch: string | null; at: number }>();
const GIT_BRANCH_TTL_MS = 3_000;

/** Git branch at the given cwd (null when not a git repo) */
function gitBranchAt(cwd: string): string | null {
  const hit = gitBranchCache.get(cwd);
  if (hit && Date.now() - hit.at < GIT_BRANCH_TTL_MS) return hit.branch;
  let branch: string | null = null;
  try {
    const out = execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    branch = out.trim() || null;
  } catch {
    branch = null;
  }
  gitBranchCache.set(cwd, { branch, at: Date.now() });
  return branch;
}

function supportedThinkingLevels(model: unknown): UIThinkingLevel[] {
  const m = model as
    | { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> }
    | null
    | undefined;
  if (!m?.reasoning) return ["off"];
  const map = m.thinkingLevelMap;
  return ALL_THINKING_LEVELS.filter((level) => {
    if (map && map[level] === null) return false;
    // xhigh/max are only supported by model families that map them explicitly
    if ((level === "xhigh" || level === "max") && map?.[level] == null) return false;
    return true;
  });
}

function buildSnapshot(entry: SessionEntry): UISnapshot {
  const session = entry.runtime.session;
  const model = session.model;
  const cwd = entry.runtime.cwd;
  const messages = serializeMessages(session.messages);
  return {
    messages,
    isStreaming: session.isStreaming,
    model: model
      ? {
          provider: model.provider,
          id: model.id,
          name: (model as { name?: string }).name,
          reasoning: (model as { reasoning?: boolean }).reasoning,
        }
      : null,
    thinkingLevel: session.thinkingLevel as UIThinkingLevel,
    thinkingLevels: supportedThinkingLevels(model),
    context: session.getContextUsage() ?? null,
    sessionFile: session.sessionFile,
    sessionId: entry.id,
    cwd,
    gitBranch: gitBranchAt(cwd),
    activeTodo: getActiveTodo(messages),
  };
}

function broadcastSnapshot(entry: SessionEntry) {
  broadcastTo(entry, { type: "snapshot", snapshot: buildSnapshot(entry) });
}

const BUILTIN_COMMANDS: UICommandInfo[] = [
  { name: "settings", description: "Open web settings", source: "builtin" },
  { name: "model", description: "Select a model or set provider/model", source: "builtin", argumentHint: "<provider/model>" },
  { name: "new", description: "Start a new session", source: "builtin" },
  { name: "resume", description: "Browse saved sessions", source: "builtin" },
  { name: "fork", description: "Fork from a previous message", source: "builtin" },
  { name: "copy", description: "Copy the last assistant message", source: "builtin" },
  { name: "compact", description: "Compact the current context", source: "builtin", argumentHint: "[instructions]" },
  { name: "name", description: "Set the session display name", source: "builtin", argumentHint: "<name>" },
  { name: "session", description: "Show current session statistics", source: "builtin" },
  { name: "reload", description: "Reload extensions, skills, prompts, and themes", source: "builtin" },
];

function buildCommandCatalog(entry: SessionEntry): UICommandInfo[] {
  const session = entry.runtime.session;
  const builtinNames = new Set(BUILTIN_COMMANDS.map((command) => command.name));
  const commands: UICommandInfo[] = [...BUILTIN_COMMANDS];

  for (const command of session.extensionRunner.getRegisteredCommands()) {
    // Interactive mode reserves the un-suffixed built-in names too.
    if (builtinNames.has(command.invocationName)) continue;
    commands.push({
      name: command.invocationName,
      description: command.description,
      source: "extension",
      scope: command.sourceInfo.scope,
    });
  }
  for (const template of session.promptTemplates) {
    if (builtinNames.has(template.name)) continue;
    commands.push({
      name: template.name,
      description: template.description,
      source: "prompt",
      scope: template.sourceInfo.scope,
      argumentHint: template.argumentHint,
    });
  }
  for (const skill of session.resourceLoader.getSkills().skills) {
    commands.push({
      name: `skill:${skill.name}`,
      description: skill.description,
      source: "skill",
      scope: skill.sourceInfo.scope,
    });
  }
  return commands;
}

function sendCommandCatalog(entry: SessionEntry, ws?: WebSocket) {
  const event: ServerEvent = { type: "command_catalog", commands: buildCommandCatalog(entry) };
  if (ws) sendTo(ws, event);
  else broadcastTo(entry, event);
}

function parseSlashCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith("/")) return null;
  const firstSpace = text.search(/\s/);
  const name = (firstSpace === -1 ? text.slice(1) : text.slice(1, firstSpace)).trim();
  if (!name) return null;
  return { name, args: firstSpace === -1 ? "" : text.slice(firstSpace).trim() };
}

async function handleBuiltinCommand(
  parsed: { name: string; args: string },
  entry: SessionEntry,
  ws: WebSocket,
): Promise<boolean> {
  const session = entry.runtime.session;
  switch (parsed.name) {
    case "settings":
      sendTo(ws, { type: "client_action", action: { action: "open_settings" } });
      return true;
    case "model": {
      if (!parsed.args) {
        sendTo(ws, { type: "client_action", action: { action: "open_model" } });
        return true;
      }
      const slash = parsed.args.indexOf("/");
      if (slash <= 0 || slash === parsed.args.length - 1) {
        sendTo(ws, { type: "error", message: "Use /model <provider/model>." });
        return true;
      }
      const provider = parsed.args.slice(0, slash);
      const id = parsed.args.slice(slash + 1);
      const model = modelRuntime.getModel(provider, id);
      if (!model) {
        sendTo(ws, { type: "error", message: `Model not found: ${provider}/${id}` });
        return true;
      }
      await session.setModel(model);
      broadcastSnapshot(entry);
      sendTo(ws, { type: "command_result", message: `Model set to ${model.name ?? model.id}.` });
      return true;
    }
    case "new":
      sendTo(ws, { type: "client_action", action: { action: "new_session" } });
      return true;
    case "resume":
      sendTo(ws, { type: "client_action", action: { action: "open_sessions" } });
      return true;
    case "fork":
      sendTo(ws, { type: "client_action", action: { action: "open_fork" } });
      return true;
    case "copy": {
      const text = session.getLastAssistantText();
      if (!text) {
        sendTo(ws, { type: "error", message: "There is no assistant message to copy." });
        return true;
      }
      sendTo(ws, { type: "client_action", action: { action: "copy_text", text } });
      return true;
    }
    case "compact":
      await session.compact(parsed.args || undefined);
      broadcastSnapshot(entry);
      sendTo(ws, { type: "command_result", message: "Context compacted." });
      return true;
    case "name":
      if (!parsed.args) {
        sendTo(ws, { type: "error", message: "Use /name <name>." });
        return true;
      }
      session.setSessionName(parsed.args);
      broadcastSnapshot(entry);
      sendTo(ws, { type: "command_result", message: "Session name updated." });
      return true;
    case "session": {
      const stats = session.getSessionStats();
      const name = session.sessionName ? ` (${session.sessionName})` : "";
      sendTo(ws, {
        type: "command_result",
        message: `Session${name}: ${stats.userMessages} user messages, ${stats.assistantMessages} assistant messages, ${stats.toolCalls} tool calls.`,
      });
      return true;
    }
    case "reload":
      await session.reload();
      broadcastSnapshot(entry);
      sendCommandCatalog(entry);
      sendTo(ws, { type: "command_result", message: "Resources reloaded." });
      return true;
    default:
      return false;
  }
}

/** Subscribe to session events (re-subscribe after the session is replaced) */
function bindSession(entry: SessionEntry) {
  entry.unsubscribe?.();
  entry.unsubscribe = entry.runtime.session.subscribe((event) => {
    entry.lastActive = Date.now();
    const broadcast = (e: ServerEvent) => broadcastTo(entry, e);
    switch (event.type) {
      case "message_update": {
        const e = event.assistantMessageEvent;
        if (e.type === "text_delta") {
          broadcast({ type: "delta", kind: "text", delta: e.delta });
        } else if (e.type === "thinking_delta") {
          broadcast({ type: "delta", kind: "thinking", delta: e.delta });
        } else if (e.type === "thinking_end") {
          broadcast({ type: "thinking_end" });
        }
        break;
      }
      case "message_end":
        broadcastSnapshot(entry);
        break;
      case "tool_execution_start":
        broadcast({ type: "tool_start", toolCallId: event.toolCallId, toolName: event.toolName });
        break;
      case "tool_execution_end":
        broadcast({
          type: "tool_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
        });
        broadcastSnapshot(entry);
        break;
      case "agent_start":
        broadcast({ type: "agent_start" });
        break;
      case "agent_end": {
        broadcast({ type: "agent_end" });
        // session.isStreaming can still be true right after agent_end — set it false explicitly
        const snap = buildSnapshot(entry);
        snap.isStreaming = false;
        broadcast({ type: "snapshot", snapshot: snap });
        break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Client command handling
// ---------------------------------------------------------------------------

async function handleCommand(cmd: ClientCommand, ws: WebSocket) {
  const entry = wsEntry.get(ws);
  if (!entry) return;
  entry.lastActive = Date.now();
  const runtime = entry.runtime;
  const session = runtime.session;
  switch (cmd.type) {
    case "prompt": {
      const text = cmd.text.trim();
      const images = (cmd.images ?? []).map((img) => ({
        type: "image" as const,
        data: img.data,
        mimeType: img.mimeType,
      }));
      if (!text && images.length === 0) return;
      // Publish the session to the URL at first input → client switches to /s/:id
      if (!entry.published) publishEntry(entry, ws);
      const slashCommand = parseSlashCommand(text);
      if (slashCommand && (await handleBuiltinCommand(slashCommand, entry, ws))) {
        return;
      }
      entry.extensionUIClient = ws;
      // prompt() doesn't resolve until the whole run ends, so don't await it
      session
        .prompt(text, {
          images: images.length > 0 ? images : undefined,
          ...(session.isStreaming ? { streamingBehavior: "steer" as const } : {}),
        })
        .catch((err) => {
          sendTo(ws, { type: "error", message: String(err instanceof Error ? err.message : err) });
        })
        .finally(() => {
          if (entry.extensionUIClient === ws) entry.extensionUIClient = undefined;
          // Commands may register resources dynamically; update each open client
          // after the SDK has finished handling this input.
          sendCommandCatalog(entry);
        });
      break;
    }
    case "abort":
      try {
        await session.abort();
      } finally {
        // Always refresh the UI after an abort attempt. Only acknowledge the
        // recovery barrier once the session is no longer streaming; if abort
        // failed while work is still active, the client must keep blocking a
        // retry until the normal agent_end/snapshot sequence settles it.
        broadcastSnapshot(entry);
        if (!session.isStreaming) sendTo(ws, { type: "abort_complete" });
      }
      break;
    case "set_model": {
      const model = modelRuntime.getModel(cmd.provider, cmd.id);
      if (!model) {
        sendTo(ws, { type: "error", message: `Model not found: ${cmd.provider}/${cmd.id}` });
        return;
      }
      await runtime.session.setModel(model);
      broadcastSnapshot(entry);
      break;
    }
    case "set_thinking_level":
      session.setThinkingLevel(cmd.level);
      broadcastSnapshot(entry);
      break;
    case "fork": {
      const result = await runtime.fork(cmd.entryId);
      if (result.cancelled) return;
      bindSession(entry);
      rekeyEntry(entry);
      broadcastSnapshot(entry);
      sendTo(ws, { type: "forked", selectedText: result.selectedText });
      break;
    }
    case "get_commands":
      sendCommandCatalog(entry, ws);
      break;
    case "extension_ui_response": {
      const pending = entry.pendingExtensionUI.get(cmd.response.id);
      if (pending) pending(cmd.response);
      break;
    }
  }
}

function sendTo(ws: WebSocket, event: ServerEvent) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
}

function extensionUIClient(entry: SessionEntry): WebSocket | undefined {
  const owner = entry.extensionUIClient;
  if (owner && owner.readyState === owner.OPEN) return owner;
  return [...entry.clients].find((client) => client.readyState === client.OPEN);
}

type ExtensionUIRequestPayload =
  | Omit<Extract<UIExtensionUIRequest, { method: "select" }>, "id">
  | Omit<Extract<UIExtensionUIRequest, { method: "confirm" }>, "id">
  | Omit<Extract<UIExtensionUIRequest, { method: "input" }>, "id">
  | Omit<Extract<UIExtensionUIRequest, { method: "editor" }>, "id">;

function requestExtensionUI<T>(
  entry: SessionEntry,
  request: ExtensionUIRequestPayload,
  fallback: T,
  parse: (response: { cancelled?: boolean; value?: string; confirmed?: boolean }) => T,
  options?: { timeout?: number; signal?: AbortSignal },
): Promise<T> {
  const ws = extensionUIClient(entry);
  if (!ws) return Promise.resolve(fallback);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (response: { cancelled?: boolean; value?: string; confirmed?: boolean }) => {
      if (timeout) clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", onAbort);
      entry.pendingExtensionUI.delete(id);
      resolve(parse(response));
    };
    const onAbort = () => finish({ cancelled: true });
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    if (options?.timeout) timeout = setTimeout(onAbort, options.timeout);
    entry.pendingExtensionUI.set(id, finish);
    sendTo(ws, { type: "extension_ui_request", request: { ...request, id } as UIExtensionUIRequest });
  });
}

function createWebExtensionUIContext(entry: SessionEntry): ExtensionUIContext {
  return {
    select: (title, options, opts) =>
      requestExtensionUI(
        entry,
        { method: "select", title, options },
        undefined,
        (response) => (response.cancelled ? undefined : response.value),
        opts,
      ),
    confirm: (title, message, opts) =>
      requestExtensionUI(
        entry,
        { method: "confirm", title, message },
        false,
        (response) => !response.cancelled && response.confirmed === true,
        opts,
      ),
    input: (title, placeholder, opts) =>
      requestExtensionUI(
        entry,
        { method: "input", title, placeholder },
        undefined,
        (response) => (response.cancelled ? undefined : response.value),
        opts,
      ),
    editor: (title, prefill) =>
      requestExtensionUI(
        entry,
        { method: "editor", title, prefill },
        undefined,
        (response) => (response.cancelled ? undefined : response.value),
      ),
    notify(message) {
      const ws = extensionUIClient(entry);
      if (ws) sendTo(ws, { type: "command_result", message });
    },
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: {} as ExtensionUIContext["theme"],
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching is not supported in the web UI." }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  } as ExtensionUIContext;
}

async function bindWebExtensions(entry: SessionEntry) {
  const runtime = entry.runtime;
  const session = runtime.session;
  await session.bindExtensions({
    uiContext: createWebExtensionUIContext(entry),
    mode: "rpc",
    commandContextActions: {
      waitForIdle: () => runtime.session.waitForIdle(),
      newSession: (options) => runtime.newSession(options),
      fork: async (entryId, options) => {
        const result = await runtime.fork(entryId, options);
        return { cancelled: result.cancelled };
      },
      navigateTree: async (entryId, options) => {
        const result = await runtime.session.navigateTree(entryId, options);
        return { cancelled: result.cancelled };
      },
      switchSession: (sessionPath, options) => runtime.switchSession(sessionPath, options),
      reload: async () => {
        await runtime.session.reload();
        sendCommandCatalog(entry);
      },
    },
    onError: (error) => {
      broadcastTo(entry, { type: "error", message: `Extension error: ${error.error}` });
    },
  });
}

function installEntryRuntimeRebind(entry: SessionEntry) {
  entry.runtime.setRebindSession(async () => {
    await bindWebExtensions(entry);
    bindSession(entry);
    rekeyEntry(entry);
    broadcastSnapshot(entry);
    sendCommandCatalog(entry);
  });
}

/**
 * Delete a session file. Cleans up the loaded runtime if any and closes
 * connected clients. Sessions are append-only JSONL files, so this removes
 * the file directly instead of using an SDK delete API.
 */
async function deleteSession(id: string): Promise<{ ok: boolean; error?: string }> {
  const path = await resolveSessionPath(id);
  if (!path) return { ok: false, error: "session not found" };

  const entry = entries.get(id);
  if (entry) {
    entry.unsubscribe?.();
    for (const ws of [...entry.clients]) {
      try {
        ws.close(1000, "session deleted");
      } catch {
        /* ignore */
      }
    }
    entry.clients.clear();
    entries.delete(id);
    try {
      await entry.runtime.dispose();
    } catch {
      /* ignore */
    }
  }

  try {
    unlinkSync(path);
  } catch (err) {
    return { ok: false, error: `failed to delete file: ${String(err)}` };
  }
  return { ok: true };
}

/** Set a session display name (empty clears the name). */
async function renameSession(
  id: string,
  name: string,
): Promise<{ ok: boolean; error?: string; name?: string }> {
  const path = await resolveSessionPath(id);
  if (!path) return { ok: false, error: "session not found" };

  const entry = entries.get(id);
  if (entry) {
    // Loaded runtime: setSessionName → appendSessionInfo (persisted to the file
    // immediately) + emits an event
    entry.runtime.session.setSessionName(name);
    broadcastSnapshot(entry);
  } else {
    try {
      const sm = SessionManager.open(path);
      sm.appendSessionInfo(name);
    } catch (err) {
      return { ok: false, error: `failed to rename: ${String(err)}` };
    }
  }
  return { ok: true, name };
}

// ---------------------------------------------------------------------------
// Custom models (models.json) reflection
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function resolveDiscoveryApiKey(value?: string): string | undefined {
  const key = value?.trim();
  if (!key) return undefined;
  const envMatch = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(key);
  if (!envMatch) return key;
  const resolved = process.env[envMatch[1]]?.trim();
  if (!resolved) throw new Error(`environment variable ${envMatch[1]} is not set`);
  return resolved;
}

function appendModelsPath(baseUrl: string): URL {
  const url = new URL(baseUrl);
  const pathname = url.pathname.replace(/\/+$/, "");
  if (!pathname.endsWith("/models")) url.pathname = `${pathname}/models`;
  return url;
}

function extractDiscoveredModelIds(payload: unknown): string[] {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === "object";
  const root = isRecord(payload) ? payload : undefined;
  const rawItems = Array.isArray(payload)
    ? payload
    : Array.isArray(root?.data)
      ? root.data
      : Array.isArray(root?.models)
        ? root.models
        : Array.isArray(root?.items)
          ? root.items
          : [];
  const ids = rawItems.flatMap((item) => {
    if (typeof item === "string") return [item];
    if (!isRecord(item)) return [];
    for (const key of ["id", "name", "model"]) {
      if (typeof item[key] === "string" && item[key].trim()) return [item[key].trim()];
    }
    return [];
  });
  return [...new Set(ids.map((id) => id.replace(/^models\//, "")).filter(Boolean))];
}

async function discoverProviderModels(provider: UIModelDiscoveryRequest): Promise<string[]> {
  if (!provider.baseUrl?.trim()) throw new Error("base URL is required");
  const endpoint = appendModelsPath(provider.baseUrl.trim());
  const apiKey = resolveDiscoveryApiKey(provider.apiKey);
  const headers: Record<string, string> = { accept: "application/json" };

  if (provider.api === "google-generative-ai") {
    if (apiKey && !endpoint.searchParams.has("key")) endpoint.searchParams.set("key", apiKey);
  } else if (provider.api === "anthropic-messages") {
    if (apiKey) headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(endpoint, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok) {
    const detail = typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, 180) : "";
    throw new Error(`provider returned ${response.status}${detail ? `: ${detail}` : ""}`);
  }
  const models = extractDiscoveredModelIds(payload);
  if (models.length === 0) throw new Error("provider returned no model ids");
  return models;
}

/**
 * Reflect saved providers into running runtimes.
 * - The list modelRuntime is recreated (re-reads models.json)
 * - Live-session runtimes get registerProvider for live registration
 * Returns a warning string when a restart is required on failure.
 */
async function reloadModelProviders(providers: UICustomProvider[]): Promise<string | undefined> {
  const previousKeys = new Set(knownCustomProviderKeys);
  knownCustomProviderKeys = new Set(providers.map((p) => p.key));

  try {
    modelRuntime = await ModelRuntime.create();
  } catch (err) {
    return `models.json saved, but reloading failed: ${String(err)}`;
  }

  try {
    for (const entry of entries.values()) {
      const sessionModels = entry.runtime.services.modelRuntime;
      for (const key of previousKeys) {
        if (!knownCustomProviderKeys.has(key)) sessionModels.unregisterProvider(key);
      }
      for (const p of providers) {
        sessionModels.registerProvider(p.key, {
          baseUrl: p.baseUrl,
          apiKey: p.apiKey,
          api: p.api,
          models: p.models.map((m) => ({
            id: m.id,
            name: m.name ?? m.id,
            reasoning: m.reasoning ?? false,
            thinkingLevelMap: m.thinkingLevelMap,
            input: m.input && m.input.length > 0 ? m.input : ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: m.contextWindow ?? 128_000,
            maxTokens: m.maxTokens ?? 8_192,
          })),
        });
      }
    }
  } catch (err) {
    return `models.json saved, but live reload failed (restart pi --web to apply): ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
  return undefined;
}

let knownCustomProviderKeys = new Set(readCustomModels().providers.map((p) => p.key));

// ---------------------------------------------------------------------------
// HTTP server (API + static files)
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

/** Extract the session token from Authorization: Bearer <t> or ?token=<t> */
function sessionTokenFromRequest(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();
  try {
    return new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
  } catch {
    return "";
  }
}

async function handleAuthRequest(req: IncomingMessage, res: import("node:http").ServerResponse, url: URL) {
  const sendJson = (status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  // Login status check
  if (url.pathname === "/api/auth/status") {
    if (!auth.validSession(sessionTokenFromRequest(req))) {
      sendJson(401, { ok: false, twoFactor: auth.twoFactorEnabled });
      return;
    }
    sendJson(200, { ok: true, twoFactor: auth.twoFactorEnabled });
    return;
  }

  // Login (token + 2FA code)
  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    let body: { token?: unknown; totp?: unknown };
    try {
      body = JSON.parse(await readBody(req, 10_000)) as { token?: unknown; totp?: unknown };
    } catch {
      sendJson(400, { error: "invalid JSON body" });
      return;
    }
    const token = typeof body.token === "string" ? body.token : "";
    const totp = typeof body.totp === "string" ? body.totp : undefined;
    const result = auth.login(token, totp);
    if (!result.sessionToken) {
      sendJson(401, {
        error: result.reason === "2fa" ? "invalid 2FA code" : "invalid access token",
      });
      return;
    }
    sendJson(200, { sessionToken: result.sessionToken });
    return;
  }

  // Logout
  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    auth.logout(sessionTokenFromRequest(req));
    sendJson(200, { ok: true });
    return;
  }

  // 2FA secret/QR re-fetch — needs the raw token (enrolling an authenticator app locally)
  if (url.pathname === "/api/auth/setup" && req.method === "GET") {
    const rawToken = url.searchParams.get("token") ?? "";
    if (!auth.verifyRawToken(rawToken)) {
      sendJson(401, { error: "invalid token" });
      return;
    }
    const otpauth = auth.otpauthUrl();
    let qr = "";
    try {
      qr = await QRCode.toDataURL(otpauth, { width: 220, margin: 1 });
    } catch {
      /* return the otpauth URL even if QR generation fails */
    }
    sendJson(200, {
      twoFactorEnabled: auth.twoFactorEnabled,
      secret: auth.totpSecret,
      otpauthUrl: otpauth,
      qr,
    });
    return;
  }

  sendJson(404, { error: "not found" });
}


const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  try {
    // Lightweight readiness probe (used by `pi --web` before opening the browser).
    if (url.pathname === "/api/health") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ ok: true, version: PACKAGE_VERSION }));
      return;
    }

    // Auth API (reachable without a session)
    if (url.pathname.startsWith("/api/auth/")) {
      await handleAuthRequest(req, res, url);
      return;
    }

    // All other APIs require a session token (static files/fonts stay open so the login screen can load)
    if (url.pathname.startsWith("/api/") && !auth.validSession(sessionTokenFromRequest(req))) {
      res.writeHead(401, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    if (url.pathname === "/api/sessions") {
      const sessions = await SessionManager.listAll();
      // Which loaded runtimes are currently streaming (for the sidebar running dot)
      const streamingIds = new Set<string>();
      for (const entry of entries.values()) {
        if (entry.runtime.session.isStreaming) streamingIds.add(entry.id);
      }
      const list: UISessionInfo[] = sessions
        .sort((a, b) => b.modified.getTime() - a.modified.getTime())
        .slice(0, 300)
        .map((s) => ({
          id: sessionIdOf(s.path),
          path: s.path,
          project: projectOf(s),
          name: s.name,
          firstMessage: s.firstMessage.slice(0, 200),
          modified: s.modified.toISOString(),
          messageCount: s.messageCount,
          isStreaming: streamingIds.has(sessionIdOf(s.path)),
        }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    // Session delete / rename
    if (url.pathname.startsWith("/api/sessions/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
      if (!id) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing session id" }));
        return;
      }

      if (req.method === "DELETE") {
        const result = await deleteSession(id);
        res.writeHead(result.ok ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(result.ok ? { ok: true } : { error: result.error }));
        return;
      }

      if (req.method === "POST" && url.pathname.endsWith("/name")) {
        const sessionId = decodeURIComponent(
          url.pathname.slice("/api/sessions/".length, -"/name".length),
        );
        if (!sessionId) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "missing session id" }));
          return;
        }
        const body = await readBody(req, 10_000);
        let name = "";
        try {
          name = String((JSON.parse(body) as { name?: unknown }).name ?? "").trim();
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid JSON body" }));
          return;
        }
        const result = await renameSession(sessionId, name);
        res.writeHead(result.ok ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(result.ok ? { ok: true, name: result.name } : { error: result.error }));
        return;
      }

      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    if (url.pathname === "/api/models") {
      const models = await modelRuntime.getAvailable();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          models.map((m) => ({
            provider: m.provider,
            id: m.id,
            name: (m as { name?: string }).name,
            reasoning: (m as { reasoning?: boolean }).reasoning,
          })),
        ),
      );
      return;
    }

    // Discover remote models using the unsaved provider connection details.
    if (url.pathname === "/api/custom-models/discover") {
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "method not allowed" }));
        return;
      }
      const body = await readBody(req, 50_000);
      try {
        const parsed = JSON.parse(body) as Partial<UIModelDiscoveryRequest>;
        const supportedApis = [
          "openai-completions",
          "openai-responses",
          "anthropic-messages",
          "google-generative-ai",
        ] as const;
        if (
          typeof parsed.baseUrl !== "string" ||
          !parsed.baseUrl.trim() ||
          !supportedApis.includes(parsed.api as (typeof supportedApis)[number])
        ) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "base URL and a supported API type are required" }));
          return;
        }
        const models = await discoverProviderModels({
          baseUrl: parsed.baseUrl,
          api: parsed.api as UIModelDiscoveryRequest["api"],
          // A masked apiKey (from the UI) is restored to the stored real key.
          apiKey: resolveIncomingApiKey(
            typeof parsed.key === "string" ? parsed.key : "",
            typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
          ),
        });
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ models }));
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // Custom model management (~/.pi/agent/models.json)
    if (url.pathname === "/api/custom-models") {
      if (req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(readCustomModels()));
        return;
      }
      if (req.method === "PUT") {
        const body = await readBody(req);
        let providers: UICustomProvider[];
        try {
          providers = (JSON.parse(body) as { providers: UICustomProvider[] }).providers;
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `invalid JSON: ${String(err)}` }));
          return;
        }
        const invalid = validateProviders(providers);
        if (invalid) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: invalid }));
          return;
        }
        // writeCustomModels resolves masked apiKeys back to the stored real
        // keys, so the reload below must use its return value (not the input).
        let resolved: UICustomProvider[];
        try {
          resolved = writeCustomModels(providers);
        } catch (err) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          return;
        }
        const warning = await reloadModelProviders(resolved);
        const result: UICustomModelsResponse = { ...readCustomModels(), warning };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(405, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    if (url.pathname === "/api/fork-points") {
      const entry = entries.get(url.searchParams.get("session") ?? "");
      if (!entry) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("[]");
        return;
      }
      const points = entry.runtime.session.getUserMessagesForForking();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(points.map((p) => ({ entryId: p.entryId, text: p.text.slice(0, 200) }))),
      );
      return;
    }

    if (url.pathname === "/api/extensions") {
      const anyEntry = entries.values().next().value as SessionEntry | undefined;
      if (!anyEntry) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ extensions: [], errors: [] }));
        return;
      }
      const { extensions, errors } = anyEntry.runtime.session.resourceLoader.getExtensions();
      const shorten = (p: string) => (p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p);
      const list: UIExtensionInfo[] = extensions.map((ext) => {
        const { sourceInfo } = ext;
        let name: string;
        let packageName: string | undefined;
        if (sourceInfo.origin === "package") {
          packageName = sourceInfo.source.replace(/^npm:/, "");
          // Derive the display name from the path relative to the package root (extensions/foo/index.ts -> foo)
          const rel = relative(sourceInfo.baseDir ?? dirname(ext.path), ext.path)
            .replace(/\.(ts|js|mjs|cjs)$/, "")
            .replace(/\/index$/, "")
            .replace(/^index$/, "")
            .replace(/^(src\/)?(extensions\/)?/, "");
          name = rel && rel !== "src" ? rel : packageName;
        } else {
          name = basename(ext.path).replace(/\.(ts|js|mjs|cjs)$/, "");
        }
        return {
          name,
          packageName,
          path: shorten(ext.path),
          scope: sourceInfo.scope,
          tools: [...ext.tools.keys()],
          commands: [...ext.commands.keys()],
          flags: [...ext.flags.keys()],
          events: [...ext.handlers.keys()],
        };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          extensions: list,
          errors: errors.map((e) => ({ path: shorten(e.path), error: e.error })),
        }),
      );
      return;
    }

    if (url.pathname === "/api/state") {
      const requested = url.searchParams.get("session");
      const entry = requested ? entries.get(requested) : undefined;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          entry
            ? buildSnapshot(entry)
            : {
                activeSessions: [...entries.values()].map((e) => ({
                  id: e.id,
                  clients: e.clients.size,
                  isStreaming: e.runtime.session.isStreaming,
                })),
              },
        ),
      );
      return;
    }

    // Static files (production build)
    if (existsSync(DIST_DIR)) {
      let filePath = join(DIST_DIR, url.pathname === "/" ? "index.html" : url.pathname);
      if (!filePath.startsWith(DIST_DIR) || !existsSync(filePath)) {
        filePath = join(DIST_DIR, "index.html"); // SPA fallback
      }
      const ext = extname(filePath);
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
      res.end(readFileSync(filePath));
      return;
    }

    res.writeHead(404);
    res.end("Not found. Run `npm run build` first, or use `npm run dev`.");
  } catch (err) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err instanceof Error ? err.message : err) }));
  }
});

const wss = new WebSocketServer({ noServer: true });

// WS handshake validates the session token (?token=)
httpServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const token = url.searchParams.get("token") ?? "";
  if (!auth.validSession(token)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const query = new URL(req.url ?? "/ws", "http://localhost").searchParams;
  const requested = query.get("session");
  const cwd = query.get("cwd") ?? undefined;
  const queue: ClientCommand[] = [];
  let ready = false;

  ws.on("message", (raw) => {
    let cmd: ClientCommand;
    try {
      cmd = JSON.parse(raw.toString());
    } catch {
      return;
    }
    // Commands arriving before the session bind is complete are queued briefly
    if (!ready) {
      queue.push(cmd);
      return;
    }
    handleCommand(cmd, ws).catch((err) => {
      sendTo(ws, { type: "error", message: String(err instanceof Error ? err.message : err) });
    });
  });

  acquireEntry(requested, cwd)
    .then((entry) => {
      if (ws.readyState !== ws.OPEN) return;
      entry.clients.add(ws);
      entry.lastActive = Date.now();
      wsEntry.set(ws, entry);
      // Only existing (/s/:id) or already-published sessions bind immediately.
      // A `/` blank draft gets session_bound → URL rewrite on the first prompt.
      if (entry.published || requested) {
        publishEntry(entry, ws);
      }
      sendTo(ws, { type: "hello", version: PACKAGE_VERSION, updateNotes: RELEASE_NOTES });
      sendTo(ws, { type: "snapshot", snapshot: buildSnapshot(entry) });
      sendCommandCatalog(entry, ws);
      ready = true;
      for (const cmd of queue.splice(0)) {
        handleCommand(cmd, ws).catch((err) => {
          sendTo(ws, { type: "error", message: String(err instanceof Error ? err.message : err) });
        });
      }
    })
    .catch((err) => {
      sendTo(ws, { type: "error", message: String(err instanceof Error ? err.message : err) });
      ws.close();
    });

  ws.on("close", () => {
    const entry = wsEntry.get(ws);
    if (entry) {
      if (entry.extensionUIClient === ws) {
        entry.extensionUIClient = undefined;
        for (const pending of entry.pendingExtensionUI.values()) pending({ cancelled: true });
      }
      entry.clients.delete(ws);
      entry.lastActive = Date.now();
      wsEntry.delete(ws);
    }
  });
});

// Handle bind failures (port in use etc.) with a clear message instead of a
// crash stack. If the extension (startServer) wrote the pid file right after
// spawning, this server would die anyway — readPid()'s liveness check filters
// that out. Here we only inform the user.
httpServer.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `pi-web-chat: port ${PORT} is already in use — another pi-web-chat server or process is listening.`,
    );
    console.error(
      `pi-web-chat: run \`pi --web status\` / \`pi --web stop\`, or remove stale ~/.pi/web-chat/pi-web-chat.pid, then retry.`,
    );
    process.exit(1);
  }
  throw err;
});

httpServer.listen(PORT, HOST, () => {
  const displayHost = HOST === "0.0.0.0" || HOST === "::" ? "localhost" : HOST;
  console.log(
    `pi-web-chat server: http://${displayHost}:${PORT}  (bind ${HOST}, chat cwd: ${AGENT_CWD})`,
  );

  // The extension writes pid/port/host right after spawning; overwrite them
  // here (after a successful bind) to avoid a stale pid from a port-conflict
  // crash lingering and looping the next start.
  try {
    mkdirSync(DAEMON_STATE_DIR, { recursive: true });
    writeFileSync(join(DAEMON_STATE_DIR, "pi-web-chat.pid"), `${process.pid}\n`, "utf8");
    writeFileSync(join(DAEMON_STATE_DIR, "pi-web-chat.port"), `${PORT}\n`, "utf8");
    writeFileSync(join(DAEMON_STATE_DIR, "pi-web-chat.host"), `${HOST}\n`, "utf8");
  } catch {
    /* state files are auxiliary — the server still works without them */
  }
  if (auth.twoFactorEnabled) {
    console.log(`pi-web-chat auth: access token = ${auth.token}  (file: ${authStartupInfo().tokenFile})`);
    console.log(`pi-web-chat auth: 2FA(TOTP) enabled — secret: ${authStartupInfo().secretFile}`);
    console.log(
      `pi-web-chat auth: login needs the token + a 2FA code from your authenticator app`,
    );
  } else {
    console.log(`pi-web-chat auth: 2FA disabled (PI_WEB_2FA=off), access token = ${auth.token}`);
  }
});

// Flush sessions (login state) to disk on restart
process.on("SIGTERM", () => {
  auth.flushSessions();
});
process.on("SIGINT", () => {
  auth.flushSessions();
});
