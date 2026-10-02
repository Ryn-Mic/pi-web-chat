import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
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
import { boundedPromptRequestId, CLIENT_COMMAND_MAX_BYTES, parseClientCommand } from "./client-command.ts";
import type {
  ClientCommand,
  ServerEvent,
  UICustomModelsResponse,
  UICustomProvider,
  UIActiveTodo,
  UIContextUsage,
  UIAgentKind,
  UIFileSearchResponse,
  UIModelDiscoveryRequest,
  UIExtensionInfo,
  UICommandInfo,
  UIClientAction,
  UIExtensionUIRequest,
  UISessionInfo,
  UISnapshot,
  UIThinkingLevel,
  UITreeResponse,
  UIGitStatus,
  UIGitBranch,
  UIGitCommit,
  UIGitCommitDetail,
  UIGitDiff,
  UIMessage,
} from "../shared/protocol.ts";
import { SESSION_NOT_FOUND_CLOSE_CODE } from "../shared/protocol.ts";
import { createSnapshotDelta } from "../shared/snapshot.ts";
import { auth, authStartupInfo } from "./auth.ts";
import {
  MANAGED_DAEMON_INSTANCE_ENV,
  isManagedDaemon,
  writeManagedDaemonState,
} from "./daemon-state.ts";
import { selectReplayEvents } from "./event-replay.ts";
import {
  createExtensionErrorReporter,
  describeExtensionError,
} from "./extension-errors.ts";
import { handleDesktopFileContent, streamStaticFile } from "./file-content.ts";
import { handleTextFileRequest } from "./file-text.ts";
import {
  FileViewerAssetPathEscapeError,
  FILE_VIEWER_URL_PREFIX,
  FILE_VIEWER_URL_ROOT,
  resolveFileViewerAssetPath,
} from "./file-viewer-assets.ts";
import { listDir, PathEscapeError, searchFiles } from "./files.ts";
import {
  handlePreviewContentRequest,
  handlePreviewContextRequest,
  PreviewContextStore,
} from "./preview-context.ts";
import { readCustomModels, resolveIncomingApiKey, validateProviders, writeCustomModels } from "./models-config.ts";
import {
  getActiveTodo,
  getOptimisticActiveTodo,
  recordMessageCompletion,
  recordMessageIdentity,
  recordSessionMessageCompletions,
  serializeMessages,
} from "./serialize.ts";
import {
  AppendedJsonlDecoder,
  applyExternalSessionEntries,
} from "./session-append.ts";
import { readSessionHistoryPage } from "./session-history.ts";
import {
  createCodexUserMessageAnchors,
  createSessionAnchorCache,
  createSessionUserMessageAnchors,
} from "./session-anchors.ts";
import { createCwdBoundCoreTools } from "./runtime-tools.ts";
import {
  CodexAppServerClient,
  CodexSession,
  codexThinkingLevels,
  type CodexModelInfo,
  type CodexRemoteStatus,
  type CodexSessionEvent,
  type CodexSessionState,
  type CodexThreadInfo,
  type CodexTransportMode,
} from "./codex.ts";
import { CODEX_COMMANDS, parseCodexReviewTarget } from "./codex-commands.ts";
import {
  forkCodexConnection,
  nativeCodexSessionId,
  nativeCodexThreadId,
} from "./codex-fork.ts";
import { SessionSummaryIndex } from "./session-index.ts";
import { SessionCatalog, SessionCatalogCursorError } from "./session-catalog.ts";
import {
  branchFromHeadFile,
  checkoutGitBranch,
  getGitBranches,
  getGitCommit,
  getGitDiff,
  getGitLog,
  getGitStatus,
  GitCommandError,
} from "./git.ts";

const PORT = Number(process.env.PORT ?? 3141);
// Default to loopback — this server has no auth and can drive a coding agent.
// Override with HOST=0.0.0.0 only on trusted networks.
const HOST = process.env.HOST ?? "127.0.0.1";
const HOME = homedir();
// Personal chat workspace (separate from the project cwd). Override with PI_WEB_CWD.
const DEFAULT_AGENT_CWD = join(HOME, ".pi", "web-chat");
const AGENT_CWD = resolve(process.env.PI_WEB_CWD ?? DEFAULT_AGENT_CWD);
mkdirSync(AGENT_CWD, { recursive: true });

type AgentKind = UIAgentKind;
const DEFAULT_AGENT_KIND: AgentKind =
  process.env.PI_WEB_AGENT?.trim().toLowerCase() === "codex" ? "codex" : "pi";
const CODEX_BINARY = process.env.PI_WEB_CODEX_BIN?.trim() || "codex";
const CODEX_MODEL = process.env.PI_WEB_CODEX_MODEL?.trim() || undefined;
const CODEX_SANDBOX =
  process.env.PI_WEB_CODEX_SANDBOX?.trim() === "read-only"
    ? "read-only"
    : process.env.PI_WEB_CODEX_SANDBOX?.trim() === "danger-full-access"
      ? "danger-full-access"
      : "workspace-write";
const CODEX_APPROVAL =
  process.env.PI_WEB_CODEX_APPROVAL?.trim() === "never"
    ? "never"
    : process.env.PI_WEB_CODEX_APPROVAL?.trim() === "untrusted"
      ? "untrusted"
      : "on-request";
const CODEX_TRANSPORT: CodexTransportMode =
  process.env.PI_WEB_CODEX_TRANSPORT?.trim() === "proxy"
    ? "proxy"
    : process.env.PI_WEB_CODEX_TRANSPORT?.trim() === "standalone"
      ? "standalone"
      : "auto";
const CODEX_METADATA_TYPE = "pi-web-chat.codex";
// PI_WEB_PROFILE=1 prints createEntry stage timings to stderr so slow session
// opens can be attributed without a debugger. Off in production by default.
const PROFILE = process.env.PI_WEB_PROFILE?.trim() === "1";
const profile = PROFILE
  ? (label: string, ms: number) => {
      process.stderr.write(`[profile] createEntry ${label}: ${ms.toFixed(1)}ms\n`);
    }
  : undefined;
// A hydrated Codex turn page can dwarf anything a browser should receive in a
// single frame: one real 216 MB rollout hydrated to 7220 messages / ~124 MB,
// which makes mobile Safari kill the page ("A problem repeatedly occurred").
// Browsers therefore get a bounded tail window plus cursor-based paging — the
// same contract Pi sessions already use through snapshotMessageOffset.
const CODEX_TAIL_MESSAGES = 120;
/** Older hydrated messages served per history page. */
const CODEX_PAGE_MESSAGES = 120;
/**
 * The live tail may grow past the initial window before it slides. A slide
 * turns the next delta into a full tail replacement (dropping already-loaded
 * older pages), so slides stay rare but still bound a long running turn.
 */
const CODEX_TAIL_HIGH_WATER = CODEX_TAIL_MESSAGES * 2;
/** Prefix for cursors that address the in-memory hydrated page. */
const CODEX_PAGE_CURSOR_PREFIX = "page:";

const sessionSummaryIndex = new SessionSummaryIndex(join(getAgentDir(), "sessions"), () => sessionCatalog.invalidate());
const codexAppServer = new CodexAppServerClient({
  cwd: AGENT_CWD,
  binary: CODEX_BINARY,
  transport: CODEX_TRANSPORT,
});
let codexModelsCache: { at: number; models: CodexModelInfo[] } | null = null;
let codexThreadsCache: { at: number; threads: CodexThreadInfo[] } | null = null;
let codexThreadsRefresh: Promise<CodexThreadInfo[]> | null = null;
const codexThreadsProgress = new Set<(threads: CodexThreadInfo[]) => void>();
let codexRemoteStatusCache: { at: number; status: CodexRemoteStatus } | null = null;

/** Daemon state file dir (shared by the npm CLI and legacy Pi extension). */
const TEST_STATE_DIR = process.env.NODE_ENV === "test"
  ? process.env.PI_WEB_TEST_STATE_DIR?.trim()
  : undefined;
const DAEMON_STATE_DIR = TEST_STATE_DIR
  ? resolve(TEST_STATE_DIR)
  : join(HOME, ".pi", "web-chat");
const MANAGED_INSTANCE_ID = isManagedDaemon()
  ? process.env[MANAGED_DAEMON_INSTANCE_ENV]?.trim()
  : undefined;

/** Short-lived mobile preview capability store. Cleanup timer lives here so the
 * store itself stays testable without a background interval. */
const previewContextStore = new PreviewContextStore();
setInterval(() => previewContextStore.cleanup(), 60_000).unref();

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
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      customTools: createCwdBoundCoreTools(cwd, services.settingsManager),
    })),
    services,
    diagnostics: services.diagnostics,
  };
};

// ---------------------------------------------------------------------------
// Session hub: holds one runtime per session and broadcasts only among
// clients viewing the same session. Maps 1:1 to URL /s/:sessionId.
// ---------------------------------------------------------------------------

type SequencedServerEvent = Extract<ServerEvent, { seq: number }>;
type CommandTerminalEvent = Extract<ServerEvent, { type: "command_result" | "client_action" | "error" }>;
type SessionEventPayload = SequencedServerEvent extends infer Event
  ? Event extends SequencedServerEvent
    ? Omit<Event, "seq">
    : never
  : never;

interface SessionEntry {
  id: string;
  /** Browser-generated identity that keeps an unpublished draft stable across reconnects. */
  draftConnectionId?: string;
  agent: AgentKind;
  runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
  /** Native Codex thread controller; Pi runtime is compatibility-only and in-memory for native sessions. */
  codex?: CodexSession;
  codexState?: CodexSessionState;
  /** Name chosen before a native Codex draft has created its authoritative thread. */
  codexDraftName?: string;
  /** True when the URL directly represents a native Codex thread. */
  codexNative?: boolean;
  codexContext?: UIContextUsage | null;
  codexAgentStarted?: boolean;
  /** Hydrated turn page; browsers only ever receive a bounded tail of it. */
  codexMessages: unknown[];
  /**
   * Serialized projection of `codexMessages` (tool results merged into their
   * calls). Snapshots and history pages both slice this array so paging can
   * never split a tool call from its result. Invalidated when the page changes.
   */
  codexUi: UIMessage[] | null;
  /** App-server cursor for turns older than the hydrated page (opaque). */
  codexStreamCursor: string | null;
  codexHistoryGeneration: number;
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
  lastFileStat?: { ino: number; size: number; mtimeMs: number };
  externalDecoder: AppendedJsonlDecoder;
  syncingExternal?: boolean;
  /** Browser that initiated the current extension command, if any. */
  extensionUIClient?: WebSocket;
  /**
   * Log-once bookkeeping for extension hook failures in this session. A hook
   * that throws on every streaming delta must not flood the daemon log.
   */
  extensionErrors?: ReturnType<typeof createExtensionErrorReporter>;
  /**
   * Notices produced while no browser was attached (extension hooks fire
   * during session creation, before `clients.add`). Flushed to the first
   * client that binds, then dropped.
   */
  pendingNotices?: string[];
  /** Recently accepted browser prompt IDs, used to deduplicate reconnect replays. */
  receivedPromptIds: Map<string, number>;
  /** Web built-ins retain their terminal event so reconnect replays do not repeat side effects. */
  commandReceipts: Map<string, {
    at: number;
    terminal?: CommandTerminalEvent;
    waiters: Set<WebSocket>;
  }>;
  pendingExtensionUI: Map<string, (response: { cancelled?: boolean; value?: string; confirmed?: boolean }) => void>;
  /** Revision and full value used as the base for suffix snapshot updates. */
  snapshotRevision: number;
  lastSnapshot?: UISnapshot;
  /** Fixed start of the live snapshot window; it may grow but never slides. */
  snapshotMessageOffset: number;
  historyCursor: string | null;
  historyHasMore: boolean;
  eventSeq: number;
  replayEvents: SequencedServerEvent[];
  activeTools: Map<string, string>;
  /** In-progress todo updates visible before their tool result is appended. */
  activeTodos: Map<string, UIActiveTodo>;
}

const entries = new Map<string, SessionEntry>();
const pending = new Map<string, Promise<SessionEntry>>();
const pendingDrafts = new Map<string, Promise<SessionEntry>>();
const draftEntries = new Map<string, SessionEntry>();
const wsEntry = new Map<WebSocket, SessionEntry>();
/** Serializes later commands behind a native fork so they use the new binding. */
const codexForksInFlight = new WeakMap<WebSocket, Promise<unknown>>();
/** Grace period before idle session runtimes are cleaned up */
const IDLE_TTL_MS = 15 * 60_000;
const CODEX_CATALOG_TTL_MS = 15_000;
// thread/list with useStateDbOnly=false rescans every Codex rollout file. On a
// long-lived ~/.codex that single RPC can take seconds, so the thread catalog
// uses stale-while-revalidate instead of blocking the sessions API.
const CODEX_THREADS_TTL_MS = 60_000;

async function codexModels(): Promise<CodexModelInfo[]> {
  if (codexModelsCache && Date.now() - codexModelsCache.at < CODEX_CATALOG_TTL_MS) {
    return codexModelsCache.models;
  }
  const models = await codexAppServer.listModels();
  codexModelsCache = { at: Date.now(), models };
  return models;
}

/** In-flight thread/list refresh shared by cold calls and revalidation. */
function refreshCodexThreads(onProgress?: (threads: CodexThreadInfo[]) => void): Promise<CodexThreadInfo[]> {
  if (onProgress) {
    codexThreadsProgress.add(onProgress);
    if (codexThreadsCache) onProgress(codexThreadsCache.threads);
  }
  if (!codexThreadsRefresh) {
    codexThreadsRefresh = codexAppServer.listThreads(100_000, (threads) => {
      for (const publish of codexThreadsProgress) publish(threads);
    })
      .then((threads) => {
        codexThreadsCache = { at: Date.now(), threads };
        return threads;
      })
      .finally(() => {
        codexThreadsRefresh = null;
      });
  }
  const refresh = codexThreadsRefresh;
  return onProgress ? refresh.finally(() => codexThreadsProgress.delete(onProgress)) : refresh;
}

/**
 * Serve the cached catalog immediately; refresh it in the background once it
 * is older than the TTL. Only the very first call after startup blocks (and
 * startup pre-warms even that away in practice).
 */
async function codexThreads(): Promise<CodexThreadInfo[]> {
  const cached = codexThreadsCache;
  if (cached && Date.now() - cached.at < CODEX_THREADS_TTL_MS) {
    return cached.threads;
  }
  if (cached) {
    void refreshCodexThreads().catch(() => {});
    return cached.threads;
  }
  return refreshCodexThreads().catch(() => []);
}

/** Mark the catalog stale but keep serving it until the refresh lands. */
function invalidateCodexThreads(): void {
  if (codexThreadsCache) codexThreadsCache.at = 0;
  sessionCatalog.invalidate();
}

/** Apply a known thread mutation to the cache without any list round trip. */
function upsertCachedCodexThread(thread: CodexThreadInfo): void {
  sessionCatalog.invalidate();
  const cached = codexThreadsCache;
  if (!cached) return;
  // Keep an already-applied display name if the fresh read predates a rename.
  const existing = cached.threads.find((candidate) => candidate.id === thread.id);
  const merged = thread.name || !existing?.name ? thread : { ...thread, name: existing.name };
  cached.threads = [merged, ...cached.threads.filter((candidate) => candidate.id !== thread.id)];
}

function renameCachedCodexThread(threadId: string, name: string): void {
  sessionCatalog.invalidate();
  const cached = codexThreadsCache;
  if (!cached) return;
  cached.threads = cached.threads.map((thread) =>
    thread.id === threadId ? { ...thread, name } : thread,
  );
}

function dropCachedCodexThread(threadId: string): void {
  sessionCatalog.invalidate();
  const cached = codexThreadsCache;
  if (!cached) return;
  cached.threads = cached.threads.filter((thread) => thread.id !== threadId);
}

function codexSessionSummaries(threads: CodexThreadInfo[]): UISessionInfo[] {
  return threads.map((thread) => {
    const id = nativeCodexSessionId(thread.id);
    const status = isRecord(thread.status) ? thread.status : undefined;
    return {
      id,
      path: thread.path ?? id,
      project: projectOf({ cwd: thread.cwd, path: thread.path ?? id }),
      ...(thread.name ? { name: thread.name } : {}),
      firstMessage: thread.preview.slice(0, 200),
      modified: new Date(Math.max(thread.updatedAt, thread.createdAt) * 1000).toISOString(),
      messageCount: 0,
      isStreaming: status?.type === "active",
      agent: "codex" as const,
    };
  });
}

function visibleSessionSummaries(sessions: UISessionInfo[]): UISessionInfo[] {
  const nativeIds = new Set(sessions.flatMap((session) => {
    const id = nativeCodexThreadId(session.id);
    return id ? [id] : [];
  }));
  return sessions.filter((session) => !session.codexThreadId || !nativeIds.has(session.codexThreadId))
    .map((session) => ({
      ...session,
      project: projectOf({ cwd: session.project, path: session.path }),
      isStreaming: entries.has(session.id) ? entryIsStreaming(entries.get(session.id)!) : session.isStreaming ?? false,
      agent: entries.get(session.id)?.agent ?? session.agent ?? "pi",
    }));
}

const sessionCatalog = new SessionCatalog({
  pi: (publish) => sessionSummaryIndex.list(publish),
  codex: async (publish) => {
    if (codexThreadsCache && Date.now() - codexThreadsCache.at < CODEX_THREADS_TTL_MS) {
      return codexSessionSummaries(codexThreadsCache.threads);
    }
    return codexSessionSummaries(await refreshCodexThreads((threads) => publish(codexSessionSummaries(threads))));
  },
}, { transform: visibleSessionSummaries });

async function codexRemoteStatus(): Promise<CodexRemoteStatus | undefined> {
  if (codexRemoteStatusCache && Date.now() - codexRemoteStatusCache.at < CODEX_CATALOG_TTL_MS) {
    return codexRemoteStatusCache.status;
  }
  try {
    const status = await codexAppServer.remoteControlStatus();
    codexRemoteStatusCache = { at: Date.now(), status };
    return status;
  } catch {
    return undefined;
  }
}

/** Session filename (<timestamp>_<uuid>.jsonl) → URL identifier */
function sessionIdOf(file?: string): string {
  if (!file) return "";
  const base = basename(file).replace(/\.jsonl$/, "");
  const i = base.lastIndexOf("_");
  return i >= 0 ? base.slice(i + 1) : base;
}

class SessionNotFoundError extends Error {
  constructor() { super("Session not found"); }
}

async function resolveSessionPath(id: string): Promise<string | undefined> {
  return sessionSummaryIndex.resolve(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function readCodexState(runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>): CodexSessionState | undefined {
  let state: CodexSessionState | undefined;
  for (const entry of runtime.session.sessionManager.getEntries()) {
    if (
      entry.type !== "custom" ||
      entry.customType !== CODEX_METADATA_TYPE ||
      !entry.data ||
      typeof entry.data !== "object"
    )
      continue;
    const data = entry.data as Record<string, unknown>;
    state = {
      ...(typeof data.threadId === "string" ? { threadId: data.threadId } : {}),
      ...(typeof data.model === "string" ? { model: data.model } : {}),
      ...(typeof data.effort === "string" ? { effort: data.effort } : {}),
    };
  }
  return state;
}

function agentKindForRuntime(
  runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>,
  path: string | undefined,
  requestedAgent?: AgentKind,
): AgentKind {
  // Persisted sessions are immutable with respect to their backend. Older
  // sessions without Codex metadata remain Pi sessions even when the server's
  // default for new drafts is Codex.
  if (path) return readCodexState(runtime) ? "codex" : "pi";
  return requestedAgent ?? DEFAULT_AGENT_KIND;
}

function entryMessages(entry: SessionEntry): unknown[] {
  return entry.agent === "codex" ? entry.codexMessages : entry.runtime.session.messages;
}

function entryIsStreaming(entry: SessionEntry): boolean {
  return entry.agent === "codex" ? entry.codex?.isStreaming === true : entry.runtime.session.isStreaming;
}

function entryCwd(entry: SessionEntry): string {
  return entry.agent === "codex"
    ? entry.codex?.currentCwd || entry.runtime.session.sessionManager.getHeader()?.cwd || entry.runtime.cwd
    : entry.runtime.cwd;
}

function codexThinkingLevel(effort: string | undefined): UIThinkingLevel {
  const value = effort?.trim().toLowerCase();
  if (!value) return "off";
  if (value === "minimal" || value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max" || value === "ultra") {
    return value;
  }
  return "medium";
}

function codexEffortForLevel(level: UIThinkingLevel): string | undefined {
  return level === "off" ? undefined : level;
}

function codexStateForEntry(entry: SessionEntry): CodexSessionState {
  const state: CodexSessionState = {};
  const threadId = entry.codex?.currentThreadId ?? entry.codexState?.threadId;
  const model = entry.codex?.currentModel;
  const effort = entry.codex?.currentEffort;
  if (threadId) state.threadId = threadId;
  if (model) state.model = model;
  if (effort) state.effort = effort;
  return state;
}

function appendCodexState(entry: SessionEntry, state: CodexSessionState): void {
  entry.codexState = state;
  // Native drafts are re-keyed to codex:<threadId> before publication. Never
  // append their transient identity to Pi JSONL or they become a duplicate
  // legacy bridge/ghost in the session catalog.
  if (entry.codexNative || !entry.published) return;
  entry.runtime.session.sessionManager.appendCustomEntry(CODEX_METADATA_TYPE, state);
  const file = entry.runtime.session.sessionFile;
  if (file) sessionSummaryIndex.invalidate(file);
}

function appendCodexMessage(entry: SessionEntry, message: Record<string, unknown>, completedAt?: number): void {
  if (!entry.codexNative) entry.runtime.session.sessionManager.appendMessage(message as never);
  entry.codexMessages.push(message);
  entry.codexUi = null;
  if (message.role === "assistant") recordMessageCompletion(message, completedAt ?? Date.now());
  // Bound a long running turn once it passes the high-water mark; sliding on
  // every append would make each delta a full tail replacement.
  const ui = codexUiMessages(entry);
  const resetHistory = ui.length - entry.snapshotMessageOffset > CODEX_TAIL_HIGH_WATER;
  if (resetHistory) setCodexWindow(entry, ui.length - CODEX_TAIL_MESSAGES);
  const file = entry.runtime.session.sessionFile;
  if (file) sessionSummaryIndex.invalidate(file);
  broadcastSnapshot(entry, undefined, resetHistory);
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

const REPLAY_EVENT_LIMIT = 4096;
/** Notices buffered for a session that has no browser attached yet. */
const PENDING_NOTICE_LIMIT = 20;

function broadcastSessionEvent(entry: SessionEntry, payload: SessionEventPayload) {
  const event = { ...payload, seq: ++entry.eventSeq } as SequencedServerEvent;
  entry.replayEvents.push(event);
  if (entry.replayEvents.length > REPLAY_EVENT_LIMIT) {
    entry.replayEvents.splice(0, entry.replayEvents.length - REPLAY_EVENT_LIMIT);
  }
  broadcastTo(entry, event);
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

function parseAgentKind(value: string | null): AgentKind | undefined {
  return value === "pi" || value === "codex" ? value : undefined;
}

function parseDraftConnectionId(value: string | null): string | undefined {
  return value && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase()
    : undefined;
}

/**
 * Cursors we mint for the in-memory hydrated page look like `page:generation:120`;
 * app-server cursors are opaque strings. The prefix lets the history endpoint
 * tell them apart without a second query parameter.
 */
function codexPageCursor(entry: SessionEntry, offset: number): string {
  return `${CODEX_PAGE_CURSOR_PREFIX}${entry.codexHistoryGeneration}:${offset}`;
}

function parseCodexPageCursor(cursor: string | null): { generation: number; offset: number } | null {
  const match = cursor?.match(/^page:(\d+):(\d+)$/);
  if (!match) return null;
  const generation = Number(match[1]);
  const offset = Number(match[2]);
  return Number.isSafeInteger(generation) && Number.isSafeInteger(offset) ? { generation, offset } : null;
}

function codexUiMessages(entry: SessionEntry): UIMessage[] {
  if (!entry.codexUi) entry.codexUi = serializeMessages(entry.codexMessages);
  return entry.codexUi;
}

/**
 * Point the browser's fixed tail window at `offset` inside the hydrated page.
 * Messages before the window stay reachable through `page:` cursors, and turns
 * before the hydrated page through the app-server cursor.
 */
function setCodexWindow(entry: SessionEntry, offset: number): void {
  entry.snapshotMessageOffset = offset;
  if (offset > 0) {
    entry.historyCursor = codexPageCursor(entry, offset);
    entry.historyHasMore = true;
  } else {
    entry.historyCursor = entry.codexStreamCursor;
    entry.historyHasMore = entry.codexStreamCursor !== null;
  }
}

/** Re-anchor the tail window to the last CODEX_TAIL_MESSAGES of the page. */
function applyCodexTailWindow(entry: SessionEntry): void {
  setCodexWindow(entry, Math.max(0, codexUiMessages(entry).length - CODEX_TAIL_MESSAGES));
}

/** Rebuild the browser's fixed tail window from the runtime's current leaf. */
function refreshEntryFileState(entry: SessionEntry) {
  entry.externalDecoder = new AppendedJsonlDecoder();
  const file = entry.runtime.session.sessionFile;
  if (!file) {
    // Native Codex sessions have no Pi JSONL; their window is anchored to the
    // hydrated app-server page, so re-anchor it instead of exposing everything.
    if (entry.agent === "codex") {
      applyCodexTailWindow(entry);
    } else {
      entry.snapshotMessageOffset = 0;
      entry.historyCursor = null;
      entry.historyHasMore = false;
    }
    entry.lastFileStat = undefined;
    return;
  }
  try {
    const page = readSessionHistoryPage(file, {
      leafId: entry.runtime.session.sessionManager.getLeafId(),
    });
    const messageCount = serializeMessages(entryMessages(entry)).length;
    entry.snapshotMessageOffset = Math.max(0, messageCount - page.messages.length);
    entry.historyCursor = page.cursor;
    entry.historyHasMore = page.hasMore;
    const fileStat = statSync(file);
    entry.lastFileStat = {
      ino: fileStat.ino,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  } catch {
    entry.snapshotMessageOffset = 0;
    entry.historyCursor = null;
    entry.historyHasMore = false;
    entry.lastFileStat = undefined;
  }
}

/** Reset revisions and loaded history with one authoritative full baseline. */
function broadcastFullSnapshotReset(entry: SessionEntry) {
  entry.snapshotRevision += 1;
  entry.eventSeq += 1;
  entry.replayEvents = [];
  const snapshot = currentSnapshot(entry);
  broadcastTo(entry, {
    type: "snapshot",
    seq: entry.eventSeq,
    revision: entry.snapshotRevision,
    snapshot,
  });
}

async function createEntry(
  id: string | null,
  cwd?: string,
  requestedAgent?: AgentKind,
  draftConnectionId?: string,
): Promise<SessionEntry> {
  const profileT0 = PROFILE ? performance.now() : 0;
  const nativeThreadId = nativeCodexThreadId(id);
  const nativeThread = nativeThreadId
    ? await codexAppServer.readThread(nativeThreadId).catch(() => undefined)
    : undefined;
  if (nativeThreadId && !nativeThread) throw new Error("Codex thread not found");
  const path = id && !nativeThreadId ? await resolveSessionPath(id) : undefined;
  if (id && !nativeThreadId && (!path || !existsSync(path))) throw new SessionNotFoundError();
  // Opening an existing session keeps the old behavior (AGENT_CWD); only
  // brand-new sessions honor the cwd parameter.
  const sessionCwd = nativeThread?.cwd ?? (path ? AGENT_CWD : cwd ? expandHome(cwd) : AGENT_CWD);
  const inMemoryCodexRuntime = !!nativeThreadId
    || (!path && (requestedAgent ?? DEFAULT_AGENT_KIND) === "codex");
  let profileT1 = PROFILE ? performance.now() : 0;
  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: sessionCwd,
    agentDir: getAgentDir(),
    sessionManager: inMemoryCodexRuntime
      ? SessionManager.inMemory(sessionCwd)
      : SessionManager.create(sessionCwd),
  });
  profile?.("createRuntime", performance.now() - profileT1);
  if (path) {
    const t = PROFILE ? performance.now() : 0;
    await runtime.switchSession(path);
    profile?.("switchSession", performance.now() - t);
  }
  if (PROFILE) {
    const t = performance.now();
    recordSessionMessageCompletions(runtime.session.sessionManager.getEntries());
    profile?.("recordCompletions", performance.now() - t);
  } else {
    recordSessionMessageCompletions(runtime.session.sessionManager.getEntries());
  }
  const agent = nativeThreadId ? "codex" : agentKindForRuntime(runtime, path, requestedAgent);
  const codexState = agent === "codex"
    ? nativeThreadId
      ? { threadId: nativeThreadId }
      : readCodexState(runtime) ?? (!path && CODEX_MODEL ? { model: CODEX_MODEL } : undefined)
    : undefined;
  const canonicalCodexThreadId = agent === "codex"
    ? nativeThreadId ?? codexState?.threadId
    : undefined;
  const canonicalId = canonicalCodexThreadId
    ? nativeCodexSessionId(canonicalCodexThreadId)
    : sessionIdOf(runtime.session.sessionFile)
      || "draft:" + runtime.session.sessionManager.getSessionId();
  const canonicalEntry = canonicalCodexThreadId ? entries.get(canonicalId) : undefined;
  if (canonicalEntry) {
    await runtime.dispose().catch(() => {});
    await canonicalEntry.codex?.connect();
    return canonicalEntry;
  }
  const codexCwd = runtime.session.sessionManager.getHeader()?.cwd || runtime.cwd;
  let entry!: SessionEntry;
  const codex =
    agent === "codex"
      ? new CodexSession({
          cwd: codexCwd,
          state: codexState,
          client: codexAppServer,
          sandbox: CODEX_SANDBOX,
          approvalPolicy: CODEX_APPROVAL,
          onEvent: (event) => handleCodexEvent(entry, event),
        })
      : undefined;
  entry = {
    id: canonicalId,
    ...(draftConnectionId ? { draftConnectionId } : {}),
    agent,
    runtime,
    codex,
    codexState,
    codexNative: !!canonicalCodexThreadId,
    codexContext: null,
    codexMessages: agent === "codex" ? [...runtime.session.messages] : [],
    codexUi: null,
    codexStreamCursor: null,
    codexHistoryGeneration: 0,
    clients: new Set(),
    lastActive: Date.now(),
    // Only sessions opened with an explicit id are published immediately.
    // A null connect is a blank draft.
    published: id !== null,
    receivedPromptIds: new Map(),
    commandReceipts: new Map(),
    pendingExtensionUI: new Map(),
    snapshotRevision: 0,
    snapshotMessageOffset: 0,
    historyCursor: null,
    historyHasMore: false,
    externalDecoder: new AppendedJsonlDecoder(),
    eventSeq: 0,
    replayEvents: [],
    activeTools: new Map(),
    activeTodos: new Map(),
  };
  if (PROFILE) {
    const t = performance.now();
    refreshEntryFileState(entry);
    profile?.("refreshFileState", performance.now() - t);
  } else {
    refreshEntryFileState(entry);
  }
  entries.set(entry.id, entry);
  if (draftConnectionId) draftEntries.set(draftConnectionId, entry);
  if (entry.codex && (nativeThreadId || path)) {
    await Promise.all([
      entry.codex.connect(),
      codexModels().catch(() => []),
      codexRemoteStatus().catch(() => undefined),
    ]);
  }
  if (PROFILE) {
    const t = performance.now();
    entry.lastSnapshot = buildSnapshot(entry);
    profile?.("buildSnapshot", performance.now() - t);
    profile?.("total", performance.now() - profileT0);
  } else {
    entry.lastSnapshot = buildSnapshot(entry);
  }
  if (entry.agent === "pi") {
    bindSession(entry);
    await bindWebExtensions(entry);
    installEntryRuntimeRebind(entry);
  }
  return entry;
}

/** New session when id is null, otherwise reuse the existing runtime (avoids
 * concurrent-connect races) */
async function acquireEntry(
  id: string | null,
  cwd?: string,
  requestedAgent?: AgentKind,
  draftConnectionId?: string,
): Promise<SessionEntry> {
  if (!id && draftConnectionId) {
    const draft = draftEntries.get(draftConnectionId);
    if (draft && entries.get(draft.id) === draft) {
      if (draft.agent === "codex" && draft.published) await draft.codex?.connect();
      return draft;
    }
    if (draft) draftEntries.delete(draftConnectionId);
    const inflightDraft = pendingDrafts.get(draftConnectionId);
    if (inflightDraft) return inflightDraft;
    const created = createEntry(null, cwd, requestedAgent, draftConnectionId)
      .finally(() => pendingDrafts.delete(draftConnectionId));
    pendingDrafts.set(draftConnectionId, created);
    return created;
  }
  if (!id) return createEntry(null, cwd, requestedAgent);
  const hit = entries.get(id);
  if (hit) {
    if (hit.agent === "codex") await hit.codex?.connect();
    return hit;
  }
  const inflight = pending.get(id);
  if (inflight) return inflight;
  const p = createEntry(id).finally(() => pending.delete(id));
  pending.set(id, p);
  return p;
}

/** File-stamped cache for the per-session question index (see session-anchors.ts). */
const sessionAnchorCache = createSessionAnchorCache();

/** Clean up empty, stale runtimes */
setInterval(() => {
  const now = Date.now();
  for (const entry of [...entries.values()]) {
    if (entry.clients.size > 0 || entryIsStreaming(entry)) continue;
    if (now - entry.lastActive < IDLE_TTL_MS) continue;
    entries.delete(entry.id);
    if (entry.draftConnectionId && draftEntries.get(entry.draftConnectionId) === entry) {
      draftEntries.delete(entry.draftConnectionId);
    }
    entry.unsubscribe?.();
    void entry.codex?.dispose().catch(() => {});
    void entry.runtime.dispose().catch(() => {});
  }
}, 60_000).unref();

/**
 * Full compatibility fallback for file replacement, truncation, divergent
 * branches, external model changes, or an SDK version without ingestible
 * SessionManager internals.
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
    recordSessionMessageCompletions(runtime.session.sessionManager.getEntries());
    entry.runtime = runtime;
    entry.activeTools.clear();
    entry.activeTodos.clear();
    refreshEntryFileState(entry);
    bindSession(entry);
    await bindWebExtensions(entry);
    installEntryRuntimeRebind(entry);
    // A replacement invalidates loaded history cursors, so reset every client
    // with a full baseline rather than a suffix patch.
    broadcastFullSnapshotReset(entry);
    sendCommandCatalog(entry);
  } finally {
    entry.reloading = false;
  }
}

function readFileRange(file: string, start: number, end: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(end - start);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, start + bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

async function syncExternalAppend(
  entry: SessionEntry,
  file: string,
  previousSize: number,
  fileStat: { ino: number; size: number; mtimeMs: number },
): Promise<void> {
  if (entry.syncingExternal) return;
  entry.syncingExternal = true;
  try {
    const chunk = readFileRange(file, previousSize, fileStat.size);
    const appended = entry.externalDecoder.push(chunk);
    const result = applyExternalSessionEntries(entry.runtime.session, appended);
    entry.lastFileStat = fileStat;
    if (result.status === "reload") {
      await reloadEntry(entry);
      return;
    }
    if (result.status === "applied") {
      recordSessionMessageCompletions(entry.runtime.session.sessionManager.getEntries());
      broadcastSnapshot(entry);
      sessionSummaryIndex.invalidate(file);
    }
  } finally {
    entry.syncingExternal = false;
  }
}

setInterval(() => {
  for (const entry of [...entries.values()]) {
    if (entry.clients.size === 0) continue;
    const file = entry.runtime.session.sessionFile;
    if (
      !file ||
      entry.agent === "codex" ||
      entry.reloading ||
      entry.syncingExternal ||
      entryIsStreaming(entry)
    )
      continue;
    let stat;
    try {
      stat = statSync(file);
    } catch {
      continue; // file not created yet (blank draft)
    }
    const nextStat = { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
    const previous = entry.lastFileStat;
    if (!previous) {
      // A draft's file was just created by this runtime; all entries are
      // already in memory, so establish the append cursor without rereading.
      entry.lastFileStat = nextStat;
      continue;
    }
    if (
      previous.ino === nextStat.ino &&
      previous.size === nextStat.size &&
      previous.mtimeMs === nextStat.mtimeMs
    )
      continue;
    if (previous.ino !== nextStat.ino || nextStat.size <= previous.size) {
      void reloadEntry(entry).catch(() => {});
      continue;
    }
    void syncExternalAppend(entry, file, previous.size, nextStat).catch(() => {
      void reloadEntry(entry).catch(() => {});
    });
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

/** Spawn git for the layouts where HEAD is not readable directly. */
function branchFromGit(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["-C", cwd, "branch", "--show-current"], {
      encoding: "utf8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Git branch at the given cwd (null when not a git repo) */
function gitBranchAt(cwd: string): string | null {
  const hit = gitBranchCache.get(cwd);
  if (hit && Date.now() - hit.at < GIT_BRANCH_TTL_MS) return hit.branch;
  // Reading .git/HEAD costs ~10µs against ~6ms for spawning git, and this runs
  // from every snapshot build, so git is only the fallback.
  const fromHead = branchFromHeadFile(cwd);
  const branch = fromHead === undefined ? branchFromGit(cwd) : fromHead;
  gitBranchCache.set(cwd, { branch, at: Date.now() });
  return branch;
}

/** ~-shorten an absolute path for display */
function shortenHome(p: string): string {
  return p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
}

// Known-project cache for file API authorization (anti arbitrary-read).
const KNOWN_ROOTS_TTL_MS = 3_000;
let knownRootsCache: { at: number; roots: Set<string> } | null = null;

/** Roots the file APIs may serve: loaded runtimes + sessions' cwds + the chat workspace. */
async function knownProjectRoots(requested?: string): Promise<Set<string>> {
  // A selected session's workspace is already authoritative. File reads and
  // saves should not rescan unrelated transcripts to reauthorize that cwd.
  if (requested) {
    const loaded = new Set<string>([AGENT_CWD]);
    for (const entry of entries.values()) loaded.add(entryCwd(entry));
    for (const session of sessionSummaryIndex.cachedSummaries()) {
      if (session.project.startsWith("/")) loaded.add(session.project);
    }
    for (const thread of codexThreadsCache?.threads ?? []) loaded.add(resolve(thread.cwd));
    if (loaded.has(requested)) return loaded;
  }
  if (knownRootsCache && Date.now() - knownRootsCache.at < KNOWN_ROOTS_TTL_MS) {
    return knownRootsCache.roots;
  }
  const roots = new Set<string>([AGENT_CWD]);
  for (const entry of entries.values()) roots.add(entryCwd(entry));
  try {
    for (const session of await sessionSummaryIndex.list()) {
      if (session.project.startsWith("/")) roots.add(session.project);
    }
  } catch {
    /* keep the entry/AGENT_CWD roots */
  }
  for (const thread of codexThreadsCache?.threads ?? []) roots.add(resolve(thread.cwd));
  knownRootsCache = { at: Date.now(), roots };
  return roots;
}

async function authorizedSessionCwd(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined;
  const requested = resolve(expandHome(value));
  let requestedReal = requested;
  try {
    requestedReal = realpathSync(requested);
  } catch {
    throw new Error("Unknown project cwd");
  }
  for (const root of await knownProjectRoots()) {
    const normalized = resolve(root);
    let real = normalized;
    try {
      real = realpathSync(normalized);
    } catch {
      continue;
    }
    if (requested === normalized || requestedReal === real) return real;
  }
  throw new Error("Unknown project cwd");
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
  const piModel = session.model;
  const codex = entry.codex;
  const codexModelId = codex?.currentModel ?? CODEX_MODEL
    ?? codexModelsCache?.models.find((candidate) => candidate.isDefault)?.model
    ?? "default";
  const codexModel = codexModelsCache?.models.find(
    (candidate) => candidate.model === codexModelId || candidate.id === codexModelId,
  );
  const model =
    entry.agent === "codex"
      ? {
          provider: "codex",
          id: codexModelId,
          name: codexModel?.displayName ?? codexModelId,
          reasoning: true,
          thinkingLevels: codexThinkingLevels(codexModel),
          ...(codexModel?.defaultReasoningEffort
            ? { defaultThinkingLevel: codexThinkingLevel(codexModel.defaultReasoningEffort) }
            : {}),
        }
      : piModel
        ? {
            provider: piModel.provider,
            id: piModel.id,
            name: (piModel as { name?: string }).name,
            reasoning: (piModel as { reasoning?: boolean }).reasoning,
          }
        : null;
  const cwd = entryCwd(entry);
  const allMessages = entry.agent === "codex"
    ? codexUiMessages(entry)
    : serializeMessages(entryMessages(entry));
  const messages = allMessages.slice(entry.snapshotMessageOffset);
  return {
    messages,
    history: {
      cursor: entry.historyCursor,
      hasMore: entry.historyHasMore,
    },
    isStreaming: entryIsStreaming(entry),
    model,
    thinkingLevel:
      entry.agent === "codex"
        ? codexThinkingLevel(codex?.currentEffort ?? codexModel?.defaultReasoningEffort)
        : session.thinkingLevel as UIThinkingLevel,
    thinkingLevels:
      entry.agent === "codex" ? codexThinkingLevels(codexModel) : supportedThinkingLevels(piModel),
    context: entry.agent === "codex" ? entry.codexContext ?? null : session.getContextUsage() ?? null,
    sessionFile: entry.codexNative ? undefined : session.sessionFile,
    sessionId: entry.id,
    agent: entry.agent,
    cwd,
    gitBranch: gitBranchAt(cwd),
    activeTodo: [...entry.activeTodos.values()].at(-1) ?? getActiveTodo(allMessages),
    activeTools: entry.agent === "codex"
      ? codex?.activeTools ?? []
      : [...entry.activeTools].map(([toolCallId, toolName]) => ({ toolCallId, toolName })),
    pendingInteractions: entry.agent === "codex" ? codex?.pendingInteractions ?? [] : [],
    ...(entry.agent === "codex"
      ? {
          codex: {
            threadId: codex?.currentThreadId,
            transport: codex?.transport ?? codexAppServer.activeTransport,
            ...(entry.codex?.observerMode === true ? { observer: true } : {}),
            ...(codex?.controlOperation ? { controlOperation: codex.controlOperation } : {}),
            canSteer: codex?.canSteer ?? false,
            canAbort: codex?.canAbort ?? false,
            ...(codexRemoteStatusCache?.status.status
              ? { remoteControl: codexRemoteStatusCache.status.status }
              : {}),
          },
        }
      : {}),
  };
}

function currentSnapshot(entry: SessionEntry): UISnapshot {
  const snapshot = buildSnapshot(entry);
  entry.lastSnapshot = snapshot;
  return snapshot;
}

/** Send a complete baseline to a new/reconnected client without advancing it. */
function sendFullSnapshot(entry: SessionEntry, ws: WebSocket) {
  sendTo(ws, {
    type: "snapshot",
    seq: entry.eventSeq,
    revision: entry.snapshotRevision,
    snapshot: currentSnapshot(entry),
  });
}

/** Replay a contiguous retained suffix, otherwise reset with a full baseline. */
function sendEventsSince(entry: SessionEntry, ws: WebSocket, afterSeq: number): boolean {
  const events = selectReplayEvents(entry.replayEvents, entry.eventSeq, afterSeq);
  if (!events) {
    sendFullSnapshot(entry, ws);
    return false;
  }
  for (const event of events) sendTo(ws, event);
  return true;
}

/**
 * Replace only the changed suffix for clients already on this entry's current
 * revision. Stable serializeMessages references make the common-prefix scan
 * cheap, including the tool-result case where one older assistant message is
 * rebuilt and everything before it remains shared.
 */
function broadcastSnapshot(entry: SessionEntry, override?: Partial<UISnapshot>, resetHistory = false) {
  const previous = entry.lastSnapshot ?? buildSnapshot(entry);
  const next = { ...buildSnapshot(entry), ...override };
  const delta = createSnapshotDelta(previous, next, entry.snapshotRevision);
  if (resetHistory) delta.resetHistory = true;
  entry.snapshotRevision = delta.revision;
  entry.lastSnapshot = next;
  broadcastSessionEvent(entry, { type: "snapshot_delta", delta });
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
const BUILTIN_COMMAND_NAMES = new Set(BUILTIN_COMMANDS.map((command) => command.name));
const CODEX_OBSERVER_COMMAND_NAMES = new Set(["settings", "new", "resume", "copy", "diff", "status", "session"]);

function buildCommandCatalog(entry: SessionEntry): UICommandInfo[] {
  if (entry.agent === "codex") {
    return entry.codex?.observerMode
      ? CODEX_COMMANDS.filter((command) => CODEX_OBSERVER_COMMAND_NAMES.has(command.name))
      : [...CODEX_COMMANDS];
  }
  const session = entry.runtime.session;
  const commands: UICommandInfo[] = [...BUILTIN_COMMANDS];

  for (const command of session.extensionRunner.getRegisteredCommands()) {
    // Interactive mode reserves the un-suffixed built-in names too.
    if (BUILTIN_COMMAND_NAMES.has(command.invocationName)) continue;
    commands.push({
      name: command.invocationName,
      description: command.description,
      source: "extension",
      scope: command.sourceInfo.scope,
    });
  }
  for (const template of session.promptTemplates) {
    if (BUILTIN_COMMAND_NAMES.has(template.name)) continue;
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

function handleCodexEvent(entry: SessionEntry, event: CodexSessionEvent): void {
  if (!entry || entry.agent !== "codex") return;
  entry.lastActive = Date.now();
  const broadcast = (payload: SessionEventPayload) => broadcastSessionEvent(entry, payload);
  switch (event.type) {
    case "history": {
      const previousUi = codexUiMessages(entry);
      const previousOffset = entry.snapshotMessageOffset;
      entry.codexMessages = [...event.messages];
      entry.codexUi = null;
      // The hydrated page can be arbitrarily large, so browsers get a tail
      // window; `page:` cursors walk the rest of the page and the app-server
      // cursor (which starts before the whole page) continues past it.
      entry.codexStreamCursor = event.cursor;
      const nextUi = codexUiMessages(entry);
      const originChanged = previousUi.length === 0 || previousUi.some((message, index) => message.id !== nextUi[index]?.id);
      if (event.reset || originChanged) entry.codexHistoryGeneration += 1;
      if (event.reset || originChanged || nextUi.length - previousOffset > CODEX_TAIL_HIGH_WATER) applyCodexTailWindow(entry);
      else setCodexWindow(entry, previousOffset);
      const resetHistory = originChanged || previousOffset !== entry.snapshotMessageOffset;
      entry.activeTools.clear();
      for (const tool of event.activeTools) entry.activeTools.set(tool.toolCallId, tool.toolName);
      entry.codexAgentStarted = event.isStreaming;
      if (event.reset) broadcastFullSnapshotReset(entry);
      else broadcastSnapshot(entry, { isStreaming: event.isStreaming }, resetHistory);
      break;
    }
    case "thread_ready": {
      const cwdChanged = event.cwd !== undefined && entry.lastSnapshot?.cwd !== event.cwd;
      if (cwdChanged) knownRootsCache = null;
      const nextState: CodexSessionState = {
        ...(entry.codexState ?? {}),
        threadId: event.threadId,
        ...(event.model ? { model: event.model } : {}),
      };
      if (event.effort !== undefined) {
        if (event.effort) nextState.effort = event.effort;
        else delete nextState.effort;
      }
      const changed = JSON.stringify(nextState) !== JSON.stringify(entry.codexState ?? {});
      if (changed) appendCodexState(entry, nextState);
      // cwd is native thread state rather than legacy Web metadata. A settings
      // update that only changes cwd still has to refresh file/Git authority in
      // every connected browser.
      if (changed || cwdChanged) broadcastSnapshot(entry);
      sendCommandCatalog(entry);
      break;
    }
    case "turn_start":
      if (!entry.codexAgentStarted) {
        entry.codexAgentStarted = true;
        broadcast({ type: "agent_start" });
      }
      broadcastSnapshot(entry);
      break;
    case "text_delta":
      broadcast({ type: "delta", kind: "text", delta: event.delta });
      break;
    case "thinking_delta":
      broadcast({ type: "delta", kind: "thinking", delta: event.delta });
      break;
    case "thinking_end":
      broadcast({ type: "thinking_end" });
      break;
    case "tool_start":
      entry.activeTools.set(event.toolCallId, event.toolName);
      broadcast({
        type: "tool_start",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
      break;
    case "tool_progress":
      broadcast({ type: "tool_progress", toolCallId: event.toolCallId, delta: event.delta });
      break;
    case "message":
      appendCodexMessage(entry, event.message, event.completedAt);
      break;
    case "tool_end":
      entry.activeTools.delete(event.toolCallId);
      broadcast({
        type: "tool_end",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
      });
      broadcastSnapshot(entry);
      break;
    case "context":
      entry.codexContext = event.context;
      broadcastSnapshot(entry);
      break;
    case "plan": {
      const current = event.plan.findIndex((step) => step.status === "inProgress" || step.status === "in_progress");
      const completed = current < 0 && event.plan.length > 0 && event.plan.every((step) => step.status === "completed");
      if (current >= 0 || completed) {
        const index = current >= 0 ? current : event.plan.length - 1;
        const step = event.plan[index]!;
        entry.activeTodos.set("codex-plan", {
          subject: step.step,
          activeForm: event.explanation,
          status: completed ? "completed" : "in_progress",
          current: index + 1,
          total: event.plan.length,
        });
      } else {
        entry.activeTodos.delete("codex-plan");
      }
      broadcastSnapshot(entry);
      break;
    }
    case "interaction":
      broadcastTo(entry, { type: "codex_interaction", interaction: event.interaction });
      broadcastSnapshot(entry);
      break;
    case "interaction_resolved":
      broadcastTo(entry, { type: "codex_interaction_resolved", id: event.id });
      broadcastSnapshot(entry);
      break;
    case "catalog_changed":
      invalidateCodexThreads();
      knownRootsCache = null;
      break;
    case "remote_status":
      codexRemoteStatusCache = { at: Date.now(), status: event.status };
      broadcastSnapshot(entry);
      break;
    case "turn_end":
      entry.codexAgentStarted = false;
      entry.activeTools.clear();
      entry.activeTodos.clear();
      // Keep the sidebar current (preview/updatedAt) without a full rollout
      // rescan; fall back to a stale-marked catalog if the read fails.
      if (entry.codex?.currentThreadId) {
        const threadId = entry.codex.currentThreadId;
        void codexAppServer.readThread(threadId)
          .then(upsertCachedCodexThread)
          .catch(() => invalidateCodexThreads());
      } else {
        invalidateCodexThreads();
      }
      broadcast({ type: "agent_end" });
      broadcastSnapshot(entry, { isStreaming: false });
      if (event.error) broadcastTo(entry, { type: "error", message: event.error });
      break;
    case "error": {
      // A crashed/errored backend must surface immediately: force the transport
      // / remote state into the snapshot so the connection badge turns red
      // instead of pinning a stale "connected". Non-fatal errors (guardrails,
      // warnings) keep the old behavior and skip the full snapshot.
      const backendDown = entry.codex?.transport === "unavailable";
      if (!entry.codex?.isStreaming && entry.codexAgentStarted) {
        entry.codexAgentStarted = false;
        entry.activeTools.clear();
        entry.activeTodos.clear();
        broadcast({ type: "agent_end" });
      }
      if (backendDown) {
        codexRemoteStatusCache = { at: Date.now(), status: { status: "errored" } };
        broadcastSnapshot(entry);
      }
      broadcastTo(entry, { type: "error", message: event.message });
      break;
    }
  }
}

function parseSlashCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith("/")) return null;
  const firstSpace = text.search(/\s/);
  const name = (firstSpace === -1 ? text.slice(1) : text.slice(1, firstSpace)).trim();
  if (!name) return null;
  return { name, args: firstSpace === -1 ? "" : text.slice(firstSpace).trim() };
}

const COMMAND_RECEIPT_TTL_MS = 5 * 60_000;
const MAX_COMPLETED_COMMAND_RECEIPTS = 256;
const MAX_IN_FLIGHT_COMMAND_RECEIPTS = 256;

function pruneCommandReceipts(entry: SessionEntry, now = Date.now()): void {
  const cutoff = now - COMMAND_RECEIPT_TTL_MS;
  const completed = [...entry.commandReceipts]
    .filter(([, receipt]) => receipt.terminal !== undefined)
    .sort((left, right) => left[1].at - right[1].at);
  for (const [id, receipt] of completed) {
    if (receipt.at < cutoff) entry.commandReceipts.delete(id);
  }
  const retainedCompleted = completed.filter(([id]) => entry.commandReceipts.has(id));
  for (const [id] of retainedCompleted.slice(0, -MAX_COMPLETED_COMMAND_RECEIPTS)) {
    entry.commandReceipts.delete(id);
  }
}

/** Return true when this request is already running or completed. */
function replayOrWaitForCommand(entry: SessionEntry, ws: WebSocket, requestId?: string): boolean {
  if (!requestId) return false;
  pruneCommandReceipts(entry);
  const receipt = entry.commandReceipts.get(requestId);
  if (!receipt) {
    const inFlightCount = [...entry.commandReceipts.values()]
      .filter((candidate) => candidate.terminal === undefined).length;
    if (inFlightCount >= MAX_IN_FLIGHT_COMMAND_RECEIPTS) {
      const terminal: CommandTerminalEvent = {
        type: "error",
        message: "Too many Web commands are still running; wait for one to finish.",
        requestId,
      };
      entry.commandReceipts.set(requestId, { at: Date.now(), terminal, waiters: new Set() });
      sendTo(ws, terminal);
      pruneCommandReceipts(entry);
      return true;
    }
    entry.commandReceipts.set(requestId, { at: Date.now(), waiters: new Set() });
    return false;
  }
  if (receipt.terminal) sendTo(ws, receipt.terminal);
  else receipt.waiters.add(ws);
  return true;
}

function finishCommand(entry: SessionEntry, ws: WebSocket, terminal: CommandTerminalEvent): void {
  const requestId = terminal.requestId;
  if (!requestId) {
    sendTo(ws, terminal);
    return;
  }
  const receipt = entry.commandReceipts.get(requestId)
    ?? { at: Date.now(), waiters: new Set<WebSocket>() };
  receipt.terminal = terminal;
  receipt.at = Date.now();
  entry.commandReceipts.set(requestId, receipt);
  const targets = new Set([ws, ...receipt.waiters]);
  receipt.waiters.clear();
  for (const target of targets) sendTo(target, terminal);
  pruneCommandReceipts(entry, receipt.at);
}

function commandResponder(entry: SessionEntry, ws: WebSocket, requestId?: string) {
  return {
    result(message: string) {
      finishCommand(entry, ws, {
        type: "command_result",
        message,
        ...(requestId ? { requestId } : {}),
      });
    },
    action(action: UIClientAction) {
      finishCommand(entry, ws, {
        type: "client_action",
        action,
        ...(requestId ? { requestId } : {}),
      });
    },
    error(message: string) {
      finishCommand(entry, ws, {
        type: "error",
        message,
        ...(requestId ? { requestId } : {}),
      });
    },
  };
}

async function handleCodexBuiltinCommand(
  parsed: { name: string; args: string },
  entry: SessionEntry,
  ws: WebSocket,
  requestId?: string,
): Promise<boolean> {
  const codex = entry.codex;
  const session = entry.runtime.session;
  const respond = commandResponder(entry, ws, requestId);
  if (codex?.observerMode && !CODEX_OBSERVER_COMMAND_NAMES.has(parsed.name)) {
    respond.error(`/${parsed.name} is unavailable while this Codex thread is read-only.`);
    return true;
  }
  switch (parsed.name) {
    case "settings":
      respond.action({ action: "open_settings" });
      return true;
    case "model": {
      if (!parsed.args) {
        respond.action({ action: "open_model" });
        return true;
      }
      const slash = parsed.args.indexOf("/");
      const model = slash >= 0 ? parsed.args.slice(slash + 1).trim() : parsed.args.trim();
      if (!model || (slash >= 0 && parsed.args.slice(0, slash).trim() !== "codex")) {
        respond.error("Use /model codex/<model>.");
        return true;
      }
      codex?.setModel(model);
      appendCodexState(entry, codexStateForEntry(entry));
      broadcastSnapshot(entry);
      respond.result(`Codex model set to ${model}.`);
      return true;
    }
    case "reasoning": {
      if (!parsed.args) {
        respond.action({ action: "open_reasoning" });
        return true;
      }
      const level = parsed.args.trim().toLowerCase() as UIThinkingLevel;
      const supported = buildSnapshot(entry).thinkingLevels;
      if (!supported.includes(level)) {
        respond.error(`Unsupported reasoning level: ${parsed.args}. Available: ${supported.join(", ")}.`);
        return true;
      }
      codex?.setEffort(codexEffortForLevel(level));
      appendCodexState(entry, codexStateForEntry(entry));
      broadcastSnapshot(entry);
      respond.result(`Codex reasoning effort set to ${level}.`);
      return true;
    }
    case "new":
      respond.action({ action: "new_session", agent: "codex" });
      return true;
    case "resume":
      respond.action({ action: "open_sessions" });
      return true;
    case "fork":
      respond.action({ action: "open_fork" });
      return true;
    case "diff":
      respond.action({ action: "open_git" });
      return true;
    case "copy": {
      const text = codex?.lastAssistantText || [...serializeMessages(entryMessages(entry))]
        .reverse()
        .find((message) => message.role === "assistant")
        ?.content.filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      if (!text) {
        respond.error("There is no assistant message to copy.");
        return true;
      }
      respond.action({ action: "copy_text", text });
      return true;
    }
    case "rename":
    case "name":
      if (!parsed.args) {
        respond.error(`Use /${parsed.name} <name>.`);
        return true;
      }
      if (!entry.published && !codex?.currentThreadId) {
        // Keep a draft name in memory until the first real prompt creates the
        // authoritative native thread. Writing it through Pi's SessionManager
        // here would materialize a shadow JSONL session.
        entry.codexDraftName = parsed.args;
      } else if (codex?.currentThreadId) {
        await codexAppServer.renameThread(codex.currentThreadId, parsed.args);
        renameCachedCodexThread(codex.currentThreadId, parsed.args);
      }
      if (entry.published && !entry.codexNative) session.setSessionName(parsed.args);
      broadcastSnapshot(entry);
      respond.result("Codex thread name updated.");
      return true;
    case "status": {
      const snapshot = buildSnapshot(entry);
      const context = snapshot.context;
      const contextLabel = context?.tokens != null && context.contextWindow != null
        ? `${context.tokens}/${context.contextWindow} tokens`
        : context?.tokens != null
          ? `${context.tokens} tokens`
        : context?.contextWindow
          ? `unknown/${context.contextWindow} tokens`
          : "unavailable";
      const state = codex?.observerMode
        ? "observer"
        : entryIsStreaming(entry)
          ? "running"
          : "idle";
      respond.result(
        [
          `Codex status: ${state}`,
          `thread ${codex?.currentThreadId ?? "draft"}`,
          `model ${snapshot.model?.id ?? "default"}`,
          `reasoning ${snapshot.thinkingLevel}`,
          `context ${contextLabel}`,
          `transport ${codex?.transport ?? codexAppServer.activeTransport}`,
          `cwd ${snapshot.cwd ?? entry.runtime.cwd}`,
        ].join(" · "),
      );
      return true;
    }
    case "session": {
      const messages = entryMessages(entry) as Array<{ role?: unknown; content?: unknown }>;
      const userMessages = messages.filter((message) => message.role === "user").length;
      const assistantMessages = messages.filter((message) => message.role === "assistant").length;
      const toolCalls = messages.filter((message) =>
        Array.isArray(message.content) && message.content.some((block) => isRecord(block) && block.type === "toolCall"),
      ).length;
      respond.result(`Codex session: ${userMessages} user messages, ${assistantMessages} assistant messages, ${toolCalls} tool calls.`);
      return true;
    }
    case "compact": {
      if (parsed.args) {
        respond.error("Use /compact without arguments in a Codex session.");
        return true;
      }
      const threadId = codex?.currentThreadId;
      if (!codex || !entry.published || !threadId || entry.id !== nativeCodexSessionId(threadId)) {
        respond.error("Send a message before using /compact.");
        return true;
      }
      await codex.compact();
      broadcastSnapshot(entry);
      respond.result("Codex context compaction started.");
      return true;
    }
    case "review": {
      const parsedTarget = parseCodexReviewTarget(parsed.args);
      if (!parsedTarget.ok) {
        respond.error(parsedTarget.error);
        return true;
      }
      const threadId = codex?.currentThreadId;
      if (!codex || !entry.published || !threadId || entry.id !== nativeCodexSessionId(threadId)) {
        respond.error("Send a message before using /review.");
        return true;
      }
      await codex.review(parsedTarget.target);
      respond.result("Codex review started.");
      return true;
    }
    default:
      respond.error(`/${parsed.name} is not available for Codex sessions.`);
      return true;
  }
}

async function handleBuiltinCommand(
  parsed: { name: string; args: string },
  entry: SessionEntry,
  ws: WebSocket,
  requestId?: string,
): Promise<boolean> {
  if (entry.agent === "codex") return handleCodexBuiltinCommand(parsed, entry, ws, requestId);
  const session = entry.runtime.session;
  const respond = commandResponder(entry, ws, requestId);
  switch (parsed.name) {
    case "settings":
      respond.action({ action: "open_settings" });
      return true;
    case "model": {
      if (!parsed.args) {
        respond.action({ action: "open_model" });
        return true;
      }
      const slash = parsed.args.indexOf("/");
      if (slash <= 0 || slash === parsed.args.length - 1) {
        respond.error("Use /model <provider/model>.");
        return true;
      }
      const provider = parsed.args.slice(0, slash);
      const id = parsed.args.slice(slash + 1);
      const model = modelRuntime.getModel(provider, id);
      if (!model) {
        respond.error(`Model not found: ${provider}/${id}`);
        return true;
      }
      await session.setModel(model);
      broadcastSnapshot(entry);
      respond.result(`Model set to ${model.name ?? model.id}.`);
      return true;
    }
    case "new":
      respond.action({ action: "new_session", agent: "pi" });
      return true;
    case "resume":
      respond.action({ action: "open_sessions" });
      return true;
    case "fork":
      respond.action({ action: "open_fork" });
      return true;
    case "copy": {
      const text = session.getLastAssistantText();
      if (!text) {
        respond.error("There is no assistant message to copy.");
        return true;
      }
      respond.action({ action: "copy_text", text });
      return true;
    }
    case "compact":
      await session.compact(parsed.args || undefined);
      broadcastSnapshot(entry);
      respond.result("Context compacted.");
      return true;
    case "name":
      if (!parsed.args) {
        respond.error("Use /name <name>.");
        return true;
      }
      session.setSessionName(parsed.args);
      broadcastSnapshot(entry);
      respond.result("Session name updated.");
      return true;
    case "session": {
      const stats = session.getSessionStats();
      const name = session.sessionName ? ` (${session.sessionName})` : "";
      respond.result(`Session${name}: ${stats.userMessages} user messages, ${stats.assistantMessages} assistant messages, ${stats.toolCalls} tool calls.`);
      return true;
    }
    case "reload":
      await session.reload();
      broadcastSnapshot(entry);
      sendCommandCatalog(entry);
      respond.result("Resources reloaded.");
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
    const broadcast = (event: SessionEventPayload) => broadcastSessionEvent(entry, event);
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
      case "message_end": {
        recordMessageCompletion(event.message);
        // SDK listeners run before the JSONL entry is appended. Read its id
        // after persistence so live and paginated messages share one identity.
        queueMicrotask(() => {
          const manager = entry.runtime.session.sessionManager;
          const leafId = manager.getLeafId();
          const leaf = leafId ? manager.getEntry(leafId) : undefined;
          if (leaf?.type === "message" && leaf.message === event.message) recordMessageIdentity(event.message, `pi:${leaf.id}`);
          broadcastSnapshot(entry);
        });
        break;
      }
      case "tool_execution_start": {
        entry.activeTools.set(event.toolCallId, event.toolName);
        const activeTodo =
          event.toolName === "todo"
            ? getOptimisticActiveTodo(
                serializeMessages(entry.runtime.session.messages),
                event.args,
              )
            : undefined;
        if (activeTodo) entry.activeTodos.set(event.toolCallId, activeTodo);
        broadcast({
          type: "tool_start",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          ...(activeTodo ? { activeTodo } : {}),
        });
        break;
      }
      case "tool_execution_end":
        entry.activeTools.delete(event.toolCallId);
        entry.activeTodos.delete(event.toolCallId);
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
        entry.activeTools.clear();
        entry.activeTodos.clear();
        broadcast({ type: "agent_end" });
        // session.isStreaming can still be true right after agent_end — set it false explicitly.
        broadcastSnapshot(entry, { isStreaming: false });
        break;
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Client command handling
// ---------------------------------------------------------------------------

function rememberReceivedPrompt(entry: SessionEntry, requestId: string): boolean {
  const now = Date.now();
  const previous = entry.receivedPromptIds.get(requestId);
  if (previous !== undefined) return false;
  entry.receivedPromptIds.set(requestId, now);
  // Retain a bounded replay window across temporary mobile/frp disconnects.
  const cutoff = now - 5 * 60_000;
  for (const [id, receivedAt] of entry.receivedPromptIds) {
    if (receivedAt >= cutoff && entry.receivedPromptIds.size <= 256) break;
    entry.receivedPromptIds.delete(id);
  }
  return true;
}

async function handleCommand(cmd: ClientCommand, ws: WebSocket) {
  const pendingFork = codexForksInFlight.get(ws);
  if (pendingFork && cmd.type !== "fork") {
    // The message listener invokes handlers concurrently. Commands that arrive
    // after a fork click must resolve their entry after the binding changes,
    // otherwise a fast prompt can accidentally continue the source thread.
    await pendingFork.catch(() => {});
  }
  if (!socketAuthenticated(ws)) return;
  const entry = wsEntry.get(ws);
  if (!entry) return;
  entry.lastActive = Date.now();
  const runtime = entry.runtime;
  const session = runtime.session;
  switch (cmd.type) {
    case "get_snapshot":
      sendFullSnapshot(entry, ws);
      return;
    case "sync_events":
      sendEventsSince(entry, ws, cmd.afterSeq);
      return;
    case "prompt": {
      const text = cmd.text.trim();
      const images = (cmd.images ?? []).map((img) => ({
        type: "image" as const,
        data: img.data,
        mimeType: img.mimeType,
      }));
      if (!text && images.length === 0) {
        sendTo(ws, { type: "error", message: "Prompt text or an image is required.", requestId: cmd.requestId });
        return;
      }
      const slashCommand = parseSlashCommand(text);
      const webBuiltin = !!slashCommand && (
        entry.agent === "codex" || BUILTIN_COMMAND_NAMES.has(slashCommand.name)
      );
      if (webBuiltin && replayOrWaitForCommand(entry, ws, cmd.requestId)) return;
      // Codex slash commands are Web-local control operations. Handle them
      // before connecting a blank draft so opening settings, choosing a model,
      // naming the future task, etc. cannot create an empty native thread.
      if (slashCommand && entry.agent === "codex") {
        try {
          await handleBuiltinCommand(slashCommand, entry, ws, cmd.requestId);
        } catch (error) {
          commandResponder(entry, ws, cmd.requestId).error(
            String(error instanceof Error ? error.message : error),
          );
        }
        return;
      }
      if (!webBuiltin && cmd.requestId && !rememberReceivedPrompt(entry, cmd.requestId)) {
        sendTo(ws, { type: "prompt_received", requestId: cmd.requestId });
        return;
      }
      // Codex drafts become native thread URLs before they are published. This
      // avoids a shadow Pi session that can turn into a ghost after first-turn
      // failure and makes Codex the authoritative identity/history source.
      if (!entry.published && entry.agent === "codex") {
        await Promise.all([
          entry.codex!.connect(),
          codexModels().catch(() => []),
          codexRemoteStatus().catch(() => undefined),
        ]);
        const threadId = entry.codex?.currentThreadId;
        if (!threadId) throw new Error("Codex thread was not initialized");
        entries.delete(entry.id);
        entry.id = nativeCodexSessionId(threadId);
        entry.codexNative = true;
        entry.codexState = { ...codexStateForEntry(entry), threadId };
        entries.set(entry.id, entry);
        // The new native thread must appear in the sidebar right away. A cheap
        // single-thread read updates the cached catalog; only fall back to a
        // full rescan if that read fails.
        void codexAppServer.readThread(threadId)
          .then(upsertCachedCodexThread)
          .catch(() => invalidateCodexThreads());
        publishEntry(entry, ws);
        const draftName = entry.codexDraftName;
        entry.codexDraftName = undefined;
        if (draftName) {
          // Naming is cosmetic and must not hold the first real turn behind a
          // slow shared-daemon round trip.
          void codexAppServer.renameThread(threadId, draftName)
            .then(() => {
              renameCachedCodexThread(threadId, draftName);
            })
            .catch((error) => {
              sendTo(ws, {
                type: "error",
                message: `Unable to apply the draft name: ${error instanceof Error ? error.message : String(error)}`,
              });
            });
        }
      } else if (!entry.published) {
        publishEntry(entry, ws);
      }
      if (slashCommand && webBuiltin) {
        try {
          await handleBuiltinCommand(slashCommand, entry, ws, cmd.requestId);
        } catch (error) {
          commandResponder(entry, ws, cmd.requestId).error(
            String(error instanceof Error ? error.message : error),
          );
        }
        return;
      }
      entry.extensionUIClient = ws;
      // Calling prompt() starts the run but the returned promise resolves only
      // after the whole run ends. Confirm only after the runtime accepted the
      // call, without making the client wait for agent lifecycle events.
      let promptRun: Promise<unknown>;
      try {
        promptRun =
          entry.agent === "codex"
            ? entry.codex!.prompt(text, images, cmd.requestId)
            : session.prompt(text, {
                images: images.length > 0 ? images : undefined,
                ...(session.isStreaming ? { streamingBehavior: "steer" as const } : {}),
              });
      } catch (err) {
        if (cmd.requestId) entry.receivedPromptIds.delete(cmd.requestId);
        sendTo(ws, {
          type: "error",
          message: String(err instanceof Error ? err.message : err),
          requestId: cmd.requestId,
        });
        if (entry.extensionUIClient === ws) entry.extensionUIClient = undefined;
        return;
      }
      if (cmd.requestId) sendTo(ws, { type: "prompt_received", requestId: cmd.requestId });
      promptRun
        .catch((err) => {
          sendTo(ws, {
            type: "error",
            message: String(err instanceof Error ? err.message : err),
            requestId: cmd.requestId,
          });
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
        if (entry.agent === "codex") await entry.codex?.abort();
        else await session.abort();
      } finally {
        // Always refresh the UI after an abort attempt. Only acknowledge the
        // recovery barrier once the session is no longer streaming; if abort
        // failed while work is still active, the client must keep blocking a
        // retry until the normal agent_end/snapshot sequence settles it.
        broadcastSnapshot(entry);
        if (!entryIsStreaming(entry)) sendTo(ws, { type: "abort_complete" });
      }
      break;
    case "set_model": {
      if (entry.agent === "codex") {
        if (entry.codex?.observerMode) {
          sendTo(ws, { type: "error", message: "Model selection is unavailable while this Codex thread is read-only." });
          return;
        }
        if (cmd.provider !== "codex") {
          sendTo(ws, { type: "error", message: "Codex sessions only accept codex/<model>." });
          return;
        }
        entry.codex?.setModel(cmd.id);
        appendCodexState(entry, codexStateForEntry(entry));
        broadcastSnapshot(entry);
        return;
      }
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
      if (entry.agent === "codex") {
        if (entry.codex?.observerMode) {
          sendTo(ws, { type: "error", message: "Reasoning selection is unavailable while this Codex thread is read-only." });
          return;
        }
        entry.codex?.setEffort(codexEffortForLevel(cmd.level));
        appendCodexState(entry, codexStateForEntry(entry));
      } else {
        if (cmd.level === "ultra") {
          sendTo(ws, { type: "error", message: "Ultra reasoning is only available for Codex models that advertise it." });
          return;
        }
        session.setThinkingLevel(cmd.level);
      }
      broadcastSnapshot(entry);
      break;
    case "fork": {
      if (entry.agent === "codex") {
        const codex = entry.codex;
        const threadId = codex?.currentThreadId;
        if (!codex || !threadId || entry.id !== nativeCodexSessionId(threadId)) {
          sendTo(ws, { type: "error", message: "Send a message before forking this Codex session." });
          return;
        }
        if (cmd.entryId !== entry.id) {
          sendTo(ws, { type: "error", message: "The Codex session changed before the fork started." });
          return;
        }
        if (entryIsStreaming(entry) || codex.pendingInteractions.length > 0) {
          sendTo(ws, { type: "error", message: "Stop the active Codex task and resolve pending requests before forking." });
          return;
        }
        if (codexForksInFlight.has(ws)) {
          sendTo(ws, { type: "error", message: "A Codex fork is already in progress." });
          return;
        }
        const forkOperation = forkCodexConnection({
          client: ws,
          source: entry,
          bindings: wsEntry,
          forkThread: async () => {
            const forkedThreadId = await codex.fork();
            // Show the forked thread immediately; only rescan the catalog if
            // the single-thread read fails.
            void codexAppServer.readThread(forkedThreadId)
              .then(upsertCachedCodexThread)
              .catch(() => invalidateCodexThreads());
            return forkedThreadId;
          },
          acquireEntry: (sessionId) => acquireEntry(sessionId),
          canMoveClient: () => ws.readyState === ws.OPEN && wsEntry.get(ws) === entry,
          sendSessionBound: (_target, sessionId) => {
            sendTo(ws, { type: "session_bound", sessionId });
          },
          sendFullSnapshot: (target) => sendFullSnapshot(target, ws),
          sendCommandCatalog: (target) => sendCommandCatalog(target, ws),
          sendForked: () => sendTo(ws, { type: "forked" }),
        });
        codexForksInFlight.set(ws, forkOperation);
        try {
          await forkOperation;
        } finally {
          if (codexForksInFlight.get(ws) === forkOperation) codexForksInFlight.delete(ws);
        }
        return;
      }
      if (!cmd.entryId) {
        sendTo(ws, { type: "error", message: "Choose a message to fork from." });
        return;
      }
      const result = await runtime.fork(cmd.entryId);
      if (result.cancelled) return;
      // AgentSessionRuntime's rebind callback has already refreshed the entry,
      // history window, command catalog, and full snapshot baseline.
      sendTo(ws, { type: "forked", selectedText: result.selectedText });
      break;
    }
    case "get_commands":
      sendCommandCatalog(entry, ws);
      break;
    case "codex_interaction_response":
      if (entry.agent === "codex" && entry.codex?.observerMode) {
        sendTo(ws, { type: "error", message: "Codex requests cannot be answered from read-only observer mode." });
        break;
      }
      if (entry.agent !== "codex" || !entry.codex?.respondToInteraction(cmd.response)) {
        sendTo(ws, { type: "error", message: "This Codex request is no longer pending." });
      }
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
        if (!result.cancelled) {
          refreshEntryFileState(entry);
          const file = runtime.session.sessionFile;
          if (file) sessionSummaryIndex.invalidate(file);
          broadcastFullSnapshotReset(entry);
        }
        return { cancelled: result.cancelled };
      },
      switchSession: (sessionPath, options) => runtime.switchSession(sessionPath, options),
      reload: async () => {
        await runtime.session.reload();
        sendCommandCatalog(entry);
      },
    },
    onError: (error) => {
      entry.extensionErrors ??= createExtensionErrorReporter({ log: (line) => console.error(line) });
      const report = entry.extensionErrors(error);
      // Extension hook failures are never fatal: the SDK skips the hook and
      // keeps the run alive. Report them as a named, dismissible notice
      // instead of a prompt failure, and only once per distinct failure.
      if (!report.first) return;
      const message = describeExtensionError(error, { home: HOME });
      if (entry.clients.size === 0) {
        const pending = (entry.pendingNotices ??= []);
        pending.push(message);
        if (pending.length > PENDING_NOTICE_LIMIT) pending.shift();
        return;
      }
      broadcastTo(entry, { type: "notice", message });
    },
  });
}

function installEntryRuntimeRebind(entry: SessionEntry) {
  entry.runtime.setRebindSession(async () => {
    entry.activeTools.clear();
    entry.activeTodos.clear();
    recordSessionMessageCompletions(entry.runtime.session.sessionManager.getEntries());
    refreshEntryFileState(entry);
    await bindWebExtensions(entry);
    bindSession(entry);
    rekeyEntry(entry);
    sessionSummaryIndex.invalidate();
    broadcastFullSnapshotReset(entry);
    sendCommandCatalog(entry);
  });
}

/**
 * Delete a session file. Cleans up the loaded runtime if any and closes
 * connected clients. Sessions are append-only JSONL files, so this removes
 * the file directly instead of using an SDK delete API.
 */
async function deleteSession(id: string): Promise<{ ok: boolean; error?: string }> {
  const codexThreadId = nativeCodexThreadId(id);
  if (codexThreadId) {
    try {
      await codexAppServer.deleteThread(codexThreadId);
      dropCachedCodexThread(codexThreadId);
      const entry = entries.get(id);
      if (entry) {
        for (const ws of entry.clients) ws.close(1000, "session deleted");
        entries.delete(id);
        await entry.codex?.dispose();
        await entry.runtime.dispose();
      }
      // Remove obsolete Pi bridge records for the same native identity. They
      // are hidden while the native thread exists and would otherwise reappear
      // as zombie sessions immediately after a native delete.
      for (const legacy of await sessionSummaryIndex.list()) {
        if (legacy.codexThreadId !== codexThreadId) continue;
        try {
          unlinkSync(legacy.path);
          sessionSummaryIndex.invalidate(legacy.path);
        } catch {
          // Native deletion already succeeded; a stale migration record must
          // not turn the whole operation into a false failure.
        }
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: "failed to delete Codex thread: " + (error instanceof Error ? error.message : String(error)) };
    }
  }
  const path = await resolveSessionPath(id);
  if (!path) return { ok: false, error: "session not found" };

  const entry = entries.get(id);
  let bridgedCodexThreadId = entry?.codex?.currentThreadId;
  if (!bridgedCodexThreadId) {
    try {
      for (const stored of SessionManager.open(path).getEntries()) {
        if (
          stored.type === "custom"
          && stored.customType === CODEX_METADATA_TYPE
          && isRecord(stored.data)
          && typeof stored.data.threadId === "string"
        ) {
          bridgedCodexThreadId = stored.data.threadId;
        }
      }
    } catch {
      /* leave this as a Pi-only deletion when legacy metadata is unreadable */
    }
  }
  if (bridgedCodexThreadId) {
    try {
      await codexAppServer.deleteThread(bridgedCodexThreadId);
      dropCachedCodexThread(bridgedCodexThreadId);
    } catch (error) {
      return { ok: false, error: "failed to delete Codex thread: " + (error instanceof Error ? error.message : String(error)) };
    }
  }
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
      await entry.codex?.dispose();
      await entry.runtime.dispose();
    } catch {
      /* ignore */
    }
  }

  try {
    unlinkSync(path);
    sessionSummaryIndex.invalidate(path);
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
  const codexThreadId = nativeCodexThreadId(id);
  if (codexThreadId) {
    try {
      await codexAppServer.renameThread(codexThreadId, name);
      renameCachedCodexThread(codexThreadId, name);
      return { ok: true, name };
    } catch (error) {
      return { ok: false, error: "failed to rename Codex thread: " + (error instanceof Error ? error.message : String(error)) };
    }
  }
  const path = await resolveSessionPath(id);
  if (!path) return { ok: false, error: "session not found" };

  const entry = entries.get(id);
  if (entry) {
    if (entry.agent === "codex" && entry.codex?.currentThreadId) {
      try {
        await codexAppServer.renameThread(entry.codex.currentThreadId, name);
        renameCachedCodexThread(entry.codex.currentThreadId, name);
      } catch (error) {
        return { ok: false, error: "failed to rename Codex thread: " + (error instanceof Error ? error.message : String(error)) };
      }
    }
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
  sessionSummaryIndex.invalidate(path);
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
    return `models.json saved, but live reload failed (restart pi-web-chat to apply): ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
  return undefined;
}

let knownCustomProviderKeys = new Set(readCustomModels().providers.map((p) => p.key));

// ---------------------------------------------------------------------------
// HTTP server (API + static files)
// ---------------------------------------------------------------------------

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

function sendGitError(res: import("node:http").ServerResponse, error: unknown): void {
  const gitError = error instanceof GitCommandError ? error : null;
  const status = gitError?.code === "not-repository" ? 422 : gitError?.code === "invalid" ? 409 : 500;
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify({ error: gitError?.message ?? "git operation failed", code: gitError?.code ?? "failed" }));
}

async function handleGitRequest(
  req: IncomingMessage,
  res: import("node:http").ServerResponse,
  url: URL,
  deps: { knownProjectRoots: () => Promise<Set<string>>; expandHome: (path: string) => string },
): Promise<boolean> {
  if (!url.pathname.startsWith("/api/git/")) return false;
  const cwd = deps.expandHome(url.searchParams.get("cwd") ?? "");
  if (!cwd || !(await deps.knownProjectRoots()).has(cwd)) {
    res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "unknown project cwd", code: "forbidden" }));
    return true;
  }
  const send = (body: unknown) => {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };
  try {
    if (req.method === "GET" && url.pathname === "/api/git/status") {
      send(await getGitStatus(cwd) satisfies UIGitStatus);
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/git/branches") {
      send(await getGitBranches(cwd) satisfies UIGitBranch[]);
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/git/log") {
      send(await getGitLog(cwd, Number(url.searchParams.get("limit") ?? "50")) satisfies UIGitCommit[]);
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/git/commit") {
      send(await getGitCommit(cwd, url.searchParams.get("hash") ?? "") satisfies UIGitCommitDetail);
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/git/diff") {
      send(await getGitDiff(cwd, url.searchParams.get("path") ?? "", url.searchParams.get("staged") === "1") satisfies UIGitDiff);
      return true;
    }
    if (req.method === "POST" && url.pathname === "/api/git/checkout") {
      let body: { branch?: unknown };
      try {
        body = JSON.parse(await readBody(req, 10_000)) as { branch?: unknown };
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body", code: "invalid" }));
        return true;
      }
      if (!body || typeof body !== "object" || typeof body.branch !== "string") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "branch is required", code: "invalid" }));
        return true;
      }
      const status = await checkoutGitBranch(cwd, body.branch) satisfies UIGitStatus;
      gitBranchCache.clear();
      for (const entry of entries.values()) {
        const withinRoot = relative(status.root, entryCwd(entry));
        if (withinRoot !== ".." && !withinRoot.startsWith("../") && !withinRoot.startsWith("/")) broadcastSnapshot(entry);
      }
      send(status);
      return true;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found", code: "invalid" }));
  } catch (error) {
    sendGitError(res, error);
  }
  return true;
}

async function handleAuthRequest(
  req: IncomingMessage,
  res: import("node:http").ServerResponse,
  url: URL,
  previewStore: PreviewContextStore,
) {
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
    if (!body || typeof body !== "object" || Array.isArray(body)) {
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
    const sessionToken = sessionTokenFromRequest(req);
    previewStore.deleteBySessionToken(sessionToken);
    auth.logout(sessionToken);
    sendJson(200, { ok: true });
    return;
  }

  // Pair only on the server itself; neither factor may disclose the other.
  if (url.pathname === "/api/auth/setup" && req.method === "GET") {
    if (!auth.validSession(sessionTokenFromRequest(req))) {
      sendJson(401, { error: "authentication required" });
      return;
    }
    sendJson(410, { error: "Set up your authenticator using the local ~/.pi/web-chat/2fa.secret file on the server." });
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    sendJson(404, { error: "not found" });
  } else {
    sendJson(405, { error: "method not allowed" });
  }
}


function parseRequestUrl(requestTarget: string): URL | null {
  try { return new URL(requestTarget, "http://localhost"); }
  catch { return null; }
}

function rawPathnameFromRequestTarget(requestTarget: string): string {
  const absoluteForm = /^[A-Za-z][A-Za-z\d+.-]*:\/\//.exec(requestTarget);
  let pathStart = 0;
  if (absoluteForm) {
    const authorityStart = absoluteForm[0].length;
    const slashIndex = requestTarget.indexOf("/", authorityStart);
    const backslashIndex = requestTarget.indexOf("\\", authorityStart);
    const queryIndex = requestTarget.indexOf("?", authorityStart);
    const pathSeparators = [slashIndex, backslashIndex].filter((index) => index >= 0);
    if (pathSeparators.length === 0) return "/";
    const pathSeparator = Math.min(...pathSeparators);
    if (queryIndex >= 0 && queryIndex < pathSeparator) return "/";
    pathStart = pathSeparator;
  }

  const queryIndex = requestTarget.indexOf("?", pathStart);
  const fragmentIndex = requestTarget.indexOf("#", pathStart);
  const endCandidates = [queryIndex, fragmentIndex].filter((index) => index >= 0);
  const pathEnd = endCandidates.length > 0 ? Math.min(...endCandidates) : requestTarget.length;
  return requestTarget.slice(pathStart, pathEnd) || "/";
}

const httpServer = createServer(async (req, res) => {
  const requestTarget = req.url ?? "/";
  const rawPathname = rawPathnameFromRequestTarget(requestTarget);
  const url = parseRequestUrl(requestTarget);
  if (!url) {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("Bad request");
    return;
  }

  try {
    // Decode and dispatch the File Viewer namespace before WHATWG-normalized
    // API routing. Otherwise /file-viewer/../api/* can become an alternate API
    // path before the asset-root escape check sees the original request target.
    let pathname: string;
    try {
      const decodedRawPathname = decodeURIComponent(rawPathname);
      const slashNormalizedRawPathname = decodedRawPathname.replaceAll("\\", "/");
      const rawTargetsFileViewer =
        slashNormalizedRawPathname === FILE_VIEWER_URL_ROOT ||
        slashNormalizedRawPathname.startsWith(FILE_VIEWER_URL_PREFIX);
      if (rawTargetsFileViewer && decodedRawPathname !== slashNormalizedRawPathname) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Forbidden");
        return;
      }
      pathname = rawTargetsFileViewer
        ? slashNormalizedRawPathname
        : decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Bad request");
      return;
    }

    const isFileViewerRequest =
      pathname === FILE_VIEWER_URL_ROOT || pathname.startsWith(FILE_VIEWER_URL_PREFIX);

    if (isFileViewerRequest && pathname.includes("\0")) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("Bad request");
      return;
    }

    if (isFileViewerRequest && req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, {
        "content-type": "text/plain",
        allow: "GET, HEAD",
      });
      res.end("Method not allowed");
      return;
    }

    if (pathname === FILE_VIEWER_URL_ROOT) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Not found");
      return;
    }

    let viewerFilePath: string | null;
    try {
      viewerFilePath = resolveFileViewerAssetPath(pathname);
    } catch (error) {
      if (!(error instanceof FileViewerAssetPathEscapeError)) throw error;
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    if (viewerFilePath !== null) {
      streamStaticFile(req, res, viewerFilePath, {
        cacheControl: "public, max-age=3600, must-revalidate",
      });
      return;
    }

    // Lightweight readiness probe used by managed launchers before opening the browser.
    if (url.pathname === "/api/health") {
      res.writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(
        JSON.stringify({
          ok: true,
          version: PACKAGE_VERSION,
          service: "pi-web-chat",
          ...(MANAGED_INSTANCE_ID
            ? { managed: { instanceId: MANAGED_INSTANCE_ID, pid: process.pid } }
            : {}),
        }),
      );
      return;
    }

    // Auth API (reachable without a session)
    if (url.pathname.startsWith("/api/auth/")) {
      await handleAuthRequest(req, res, url, previewContextStore);
      return;
    }

    // Mobile preview content is reachable with a short-lived Preview capability id,
    // before the global Bearer gate, and must reject Bearer/query auth.
    if (await handlePreviewContentRequest(req, res, url, {
      knownProjectRoots,
      expandHome,
      previewContextStore,
    })) {
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

    if (await handleTextFileRequest(req, res, url, {
      knownProjectRoots: () => knownProjectRoots(expandHome(url.searchParams.get("cwd") ?? "")),
      expandHome,
    })) {
      return;
    }

    if (await handleGitRequest(req, res, url, { knownProjectRoots, expandHome })) {
      return;
    }

    // Mobile preview capability creation (requires a valid session).
    if (await handlePreviewContextRequest(req, res, url, {
      knownProjectRoots,
      expandHome,
      previewContextStore,
    })) {
      return;
    }

    if (url.pathname === "/api/codex/status") {
      const remote = await codexRemoteStatus();
      res.writeHead(remote ? 200 : 503, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify({
        transport: codexAppServer.activeTransport,
        remoteControl: remote ?? null,
      }));
      return;
    }

    if (url.pathname === "/api/sessions") {
      if (url.searchParams.has("limit") || url.searchParams.has("cursor") || url.searchParams.has("q")) {
        const rawLimit = url.searchParams.get("limit");
        const query = url.searchParams.get("q") ?? "";
        if ((rawLimit !== null && !/^[1-9]\d{0,2}$/.test(rawLimit)) || query.length > 200) {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "invalid session page request" }));
          return;
        }
        try {
          const page = sessionCatalog.page({
            limit: rawLimit === null ? 40 : Number(rawLimit),
            cursor: url.searchParams.get("cursor"), query,
            refresh: url.searchParams.get("refresh") === "1",
          });
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(page));
        } catch (error) {
          if (!(error instanceof SessionCatalogCursorError)) throw error;
          res.writeHead(url.searchParams.has("cursor") ? 409 : 400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: url.searchParams.has("cursor") ? "session page expired; reload the list" : "invalid page size" }));
        }
        return;
      }
      const [sessions, nativeThreads] = await Promise.all([
        sessionSummaryIndex.list(),
        codexThreads().catch(() => [] as CodexThreadInfo[]),
      ]);
      void codexRemoteStatus();
      const list = visibleSessionSummaries([...sessions, ...codexSessionSummaries(nativeThreads)])
        .sort((a, b) => Date.parse(b.modified) - Date.parse(a.modified))
        .slice(0, 300);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    const historyMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
    if (req.method === "GET" && historyMatch) {
      const id = decodeURIComponent(historyMatch[1]!);
      if (nativeCodexThreadId(id)) {
        try {
          const loaded = await acquireEntry(id);
          const cursor = url.searchParams.get("cursor");
          if (!cursor) {
            // Mirror the snapshot contract: never more than the tail window.
            res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
            res.end(JSON.stringify({
              messages: codexUiMessages(loaded).slice(loaded.snapshotMessageOffset),
              cursor: loaded.historyCursor,
              hasMore: loaded.historyHasMore,
            }));
            return;
          }
          const pageCursor = parseCodexPageCursor(cursor);
          if (cursor.startsWith(CODEX_PAGE_CURSOR_PREFIX) && !pageCursor) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "invalid history cursor" }));
            return;
          }
          if (pageCursor !== null) {
            if (pageCursor.generation !== loaded.codexHistoryGeneration) {
              res.writeHead(409, { "content-type": "application/json" });
              res.end(JSON.stringify({ error: "history changed; reload the current snapshot" }));
              return;
            }
            // Walk the hydrated page backwards, then hand over to the
            // app-server cursor for turns older than the page.
            const ui = codexUiMessages(loaded);
            const end = Math.min(pageCursor.offset, ui.length);
            const from = Math.max(0, end - CODEX_PAGE_MESSAGES);
            const next = from > 0 ? codexPageCursor(loaded, from) : loaded.codexStreamCursor;
            res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
            res.end(JSON.stringify({
              messages: ui.slice(from, end),
              cursor: next,
              hasMore: from > 0 || next !== null,
            }));
            return;
          }
          const page = await loaded.codex!.loadHistory(cursor);
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ ...page, messages: serializeMessages(page.messages) }));
        } catch {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Codex history read failed" }));
        }
        return;
      }
      const path = await resolveSessionPath(id);
      if (!path) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "session not found" }));
        return;
      }
      try {
        const cursor = url.searchParams.get("cursor") ?? undefined;
        const loaded = entries.get(id);
        const page = readSessionHistoryPage(path, {
          cursor,
          ...(!cursor && loaded
            ? { leafId: loaded.runtime.session.sessionManager.getLeafId() }
            : {}),
        });
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(page));
      } catch (error) {
        const invalidCursor = error instanceof Error && error.message === "invalid history cursor";
        res.writeHead(invalidCursor ? 400 : 500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: invalidCursor ? "invalid history cursor" : "history read failed" }));
      }
      return;
    }

    const anchorsMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/anchors$/);
    if (req.method === "GET" && anchorsMatch) {
      const id = decodeURIComponent(anchorsMatch[1]!);
      const codexThreadId = nativeCodexThreadId(id);
      if (codexThreadId) {
        try {
          const anchors = await createCodexUserMessageAnchors(async (cursor) => {
            const response = await codexAppServer.request("thread/items/list", {
              threadId: codexThreadId,
              cursor,
              limit: 100,
              sortDirection: "asc",
            });
            const record = isRecord(response) ? response : {};
            return {
              data: Array.isArray(record.data) ? record.data : [],
              nextCursor: typeof record.nextCursor === "string" ? record.nextCursor : null,
            };
          });
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ anchors }));
        } catch {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "Codex message anchor read failed" }));
        }
        return;
      }
      const path = await resolveSessionPath(id);
      if (!path) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "session not found" }));
        return;
      }
      try {
        // Cached by (mtime, size): a cache hit skips both the branch walk and the
        // SessionManager.open parse for a session that is not loaded in memory.
        const anchors = await sessionAnchorCache.read(path, () => {
          const loaded = entries.get(id);
          const manager = loaded?.runtime.session.sessionManager ?? SessionManager.open(path);
          return createSessionUserMessageAnchors(manager.getBranch());
        });
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ anchors }));
      } catch {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "message anchor read failed" }));
      }
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
      const requestedModelAgent = parseAgentKind(url.searchParams.get("agent"));
      if (requestedModelAgent === "codex") {
        try {
          const models = await codexModels();
          const available = models.map((model) => ({
            provider: "codex",
            id: model.model,
            name: model.displayName,
            reasoning: true,
            thinkingLevels: codexThinkingLevels(model),
            ...(model.defaultReasoningEffort
              ? { defaultThinkingLevel: codexThinkingLevel(model.defaultReasoningEffort) }
              : {}),
          }));
          res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify(available));
        } catch (error) {
          res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
          res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }
      const models = await modelRuntime.getAvailable();
      const codexEnabled =
        DEFAULT_AGENT_KIND === "codex" || [...entries.values()].some((entry) => entry.agent === "codex");
      const available = models.map((m) => ({
        provider: m.provider,
        id: m.id,
        name: (m as { name?: string }).name,
        reasoning: (m as { reasoning?: boolean }).reasoning,
      }));
      if (codexEnabled && requestedModelAgent !== "pi") {
        const nativeModels = await codexModels().catch(() => []);
        available.unshift(...nativeModels.map((model) => ({
          provider: "codex",
          id: model.model,
          name: model.displayName,
          reasoning: true,
          thinkingLevels: codexThinkingLevels(model),
          ...(model.defaultReasoningEffort
            ? { defaultThinkingLevel: codexThinkingLevel(model.defaultReasoningEffort) }
            : {}),
        })));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(available));
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

    // Project file browsing (tree + @-mention search). cwd must be a known project root.
    if (await handleDesktopFileContent(req, res, url, { knownProjectRoots, expandHome })) {
      return;
    }

    if (url.pathname === "/api/tree" || url.pathname === "/api/files/search") {
      const root = expandHome(url.searchParams.get("cwd") ?? "");
      if (!root || !(await knownProjectRoots()).has(root)) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown project cwd" }));
        return;
      }
      try {
        if (!statSync(root).isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOENT" });
        if (url.pathname === "/api/tree") {
          const rel = url.searchParams.get("path") ?? "";
          const { nodes, truncated } = listDir(root, rel);
          const body: UITreeResponse = { root: shortenHome(root), path: rel, nodes, ...(truncated ? { truncated } : {}) };
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
          return;
        }
        const q = url.searchParams.get("q") ?? "";
        const limitParam = Number(url.searchParams.get("limit") ?? "50");
        const { matches, partial } = searchFiles(root, q, Number.isFinite(limitParam) ? limitParam : 50);
        const body: UIFileSearchResponse = { root: shortenHome(root), query: q, matches, ...(partial ? { partial } : {}) };
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const status =
          err instanceof PathEscapeError || code === "ENOTDIR" ? 400
          : code === "ENOENT" ? 404
          : code === "EACCES" ? 403
          : 500;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: status === 500 ? "internal server error" : err instanceof Error ? err.message : String(err) }));
        return;
      }
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
                  isStreaming: entryIsStreaming(e),
                })),
              },
        ),
      );
      return;
    }

    // Unmatched API routes
    if (url.pathname.startsWith("/api/")) {
      if (req.method === "GET" || req.method === "HEAD") {
        res.writeHead(404, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "not found" }));
      } else {
        res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ error: "method not allowed" }));
      }
      return;
    }

    // Static application files (production build)
    if (existsSync(DIST_DIR)) {
      const filePath = resolve(DIST_DIR, "." + pathname);
      const distRoot = resolve(DIST_DIR);
      if (filePath !== distRoot && !filePath.startsWith(distRoot + "/")) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      if (existsSync(filePath) && statSync(filePath).isFile()) {
        const ext = extname(filePath).toLowerCase();
        const cacheControl = ext === ".html" ? "no-cache" : undefined;
        streamStaticFile(req, res, filePath, cacheControl ? { cacheControl } : undefined);
        return;
      }

      // SPA fallback for non-API, non-viewer navigation
      const indexHtml = join(DIST_DIR, "index.html");
      res.writeHead(200, {
        "content-type": "text/html",
        "cache-control": "no-cache",
      });
      res.end(readFileSync(indexHtml));
      return;
    }

    res.writeHead(404);
    res.end("Not found. Run `npm run build` first, or use `npm run dev`.");
  } catch {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal server error" }));
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: CLIENT_COMMAND_MAX_BYTES });
const socketSessionTokens = new Map<WebSocket, string>();
auth.onSessionRevoked((token) => {
  previewContextStore.deleteBySessionToken(token);
  for (const [socket, sessionToken] of socketSessionTokens) {
    if (sessionToken === token) socket.close(1008, "Session expired or signed out");
  }
});

function socketAuthenticated(ws: WebSocket, touch = true): boolean {
  if (ws.readyState !== ws.OPEN) return false;
  const token = socketSessionTokens.get(ws) ?? "";
  const valid = touch ? auth.validSession(token) : auth.isSessionValid(token);
  if (!valid) ws.close(1008, "Session expired or signed out");
  return valid;
}

// Heartbeat: browsers auto-pong server pings at the WebSocket layer, so a
// socket that misses pongs is provably dead at the protocol level. Without it,
// a half-open connection (laptop sleep, WiFi roam, VPN drop) can leave both
// ends reporting "connected" while no frames flow, and the client's DOM
// onclose/auto-reconnect never fires because the TCP socket stays up.
const HEARTBEAT_INTERVAL_MS = 30_000;
const wssHeartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (!socketAuthenticated(client, false)) continue;
    const alive = (client as WebSocket & { isAlive?: boolean }).isAlive;
    if (!alive) {
      client.terminate();
      continue;
    }
    (client as WebSocket & { isAlive?: boolean }).isAlive = false;
    client.ping();
  }
}, HEARTBEAT_INTERVAL_MS);
wss.on("close", () => clearInterval(wssHeartbeat));

// WS handshake validates the session token (?token=)
httpServer.on("upgrade", (req, socket, head) => {
  const url = parseRequestUrl(req.url ?? "/");
  if (!url) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n", () => socket.destroy());
    return;
  }
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
  (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  ws.on("pong", () => {
    (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
  });
  const query = new URL(req.url ?? "/ws", "http://localhost").searchParams;
  socketSessionTokens.set(ws, query.get("token") ?? "");
  // Protocol errors (oversized or invalid frames) belong to this socket.
  ws.on("error", () => ws.close());
  const requested = query.get("session");
  const cwd = query.get("cwd") ?? undefined;
  const requestedAgent = parseAgentKind(query.get("agent"));
  const requestedDraft = requested ? undefined : parseDraftConnectionId(query.get("draft"));
  const sinceValue = query.get("since");
  const parsedSince = sinceValue === null ? null : Number(sinceValue);
  const since =
    parsedSince !== null && Number.isSafeInteger(parsedSince) && parsedSince >= 0
      ? parsedSince
      : null;
  const queue: ClientCommand[] = [];
  let ready = false;

  const dispatch = (cmd: ClientCommand) => {
    handleCommand(cmd, ws).catch((err) => {
      if (ws.readyState !== ws.OPEN) return;
      sendTo(ws, {
        type: "error",
        message: String(err instanceof Error ? err.message : err),
        requestId: cmd.type === "prompt" ? cmd.requestId : undefined,
      });
    });
  };
  ws.on("message", (raw) => {
    if (!socketAuthenticated(ws)) return;
    let cmd: ClientCommand | null = null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw.toString()); cmd = parseClientCommand(parsed); } catch { /* invalid JSON */ }
    if (!cmd) {
      sendTo(ws, { type: "error", message: "Invalid command", requestId: boundedPromptRequestId(parsed) });
      return;
    }
    if (!ready) {
      if (queue.length >= 64) { ws.close(1008, "Too many pending commands"); return; }
      queue.push(cmd);
      return;
    }
    dispatch(cmd);
  });

  let preloaded = false;
  const prepareEntry = async () => {
    // A cold runtime switch synchronously parses the whole JSONL. Send a cheap
    // tail page first, then yield once so the browser can paint while the SDK
    // reconstructs the full agent context in the background.
    if (requested && !nativeCodexThreadId(requested) && !entries.has(requested)) {
      const path = await resolveSessionPath(requested);
      if (path && socketAuthenticated(ws, false)) {
        try {
          const page = readSessionHistoryPage(path);
          sendTo(ws, { type: "session_bound", sessionId: requested });
          sendTo(ws, { type: "hello", version: PACKAGE_VERSION, updateNotes: RELEASE_NOTES });
          sendTo(ws, {
            type: "snapshot",
            seq: 0,
            revision: 0,
            snapshot: {
              messages: page.messages,
              history: { cursor: page.cursor, hasMore: page.hasMore },
              isStreaming: false,
              model: null,
              thinkingLevel: "off",
              thinkingLevels: ["off"],
              sessionFile: path,
              sessionId: requested,
            },
          });
          preloaded = true;
          await new Promise<void>((resolve) => setImmediate(resolve));
        } catch {
          // Fall through to the normal SDK baseline if the file changed while
          // the tail page was being read.
        }
      }
    }
    const safeCwd = requested ? undefined : await authorizedSessionCwd(cwd);
    if (!socketAuthenticated(ws, false)) throw new Error("authentication required");
    return acquireEntry(requested, safeCwd, requestedAgent, requestedDraft);
  };

  // Binding a session can fail transiently — most often a Codex thread whose
  // active turn is owned by another client ("already has an active writer").
  // Closing the socket on every failure makes the browser auto-reconnect in a
  // tight loop: the UI flickers and the same error repeats indefinitely.
  // Instead keep the socket open, surface the error once, and retry with a
  // capped backoff; when the conflict clears the bind completes and the
  // session materializes without a reconnect.
  let bindAttempts = 0;
  let bindErrorShown = false;
  let bindTimer: ReturnType<typeof setTimeout> | null = null;
  const bindSession = async (): Promise<void> => {
    let entry: SessionEntry;
    try {
      entry = await prepareEntry();
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        sendTo(ws, { type: "error", message: error.message });
        ws.close(SESSION_NOT_FOUND_CLOSE_CODE, error.message);
        return;
      }
      if (ws.readyState === ws.OPEN && !bindErrorShown) {
        bindErrorShown = true;
        sendTo(ws, {
          type: "error",
          message:
            String(error instanceof Error ? error.message : error)
            + " — retrying automatically",
        });
      }
      if (ws.readyState === ws.OPEN) {
        const delay = Math.min(2_000 * Math.pow(1.6, bindAttempts++), 10_000);
        bindTimer = setTimeout(() => {
          bindTimer = null;
          void bindSession();
        }, delay);
      }
      return;
    }
    if (!socketAuthenticated(ws, false)) return;
    if (bindTimer !== null) {
      clearTimeout(bindTimer);
      bindTimer = null;
    }
    entry.clients.add(ws);
    entry.lastActive = Date.now();
    wsEntry.set(ws, entry);
    // Only existing (/s/:id) or already-published sessions bind immediately.
    // A `/` blank draft gets session_bound → URL rewrite on the first prompt.
    if (!preloaded && (entry.published || requested)) {
      publishEntry(entry, ws);
    }
    if (!preloaded) {
      sendTo(ws, { type: "hello", version: PACKAGE_VERSION, updateNotes: RELEASE_NOTES });
    }
    if (preloaded || since === null) sendFullSnapshot(entry, ws);
    else sendEventsSince(entry, ws, since);
    sendCommandCatalog(entry, ws);
    // Notices raised before this socket existed cannot be broadcast; hand the
    // buffered ones to the client that finally attached.
    for (const notice of entry.pendingNotices?.splice(0) ?? []) sendTo(ws, { type: "notice", message: notice });
    ready = true;
    for (const cmd of queue.splice(0)) dispatch(cmd);
  };
  void bindSession();

  ws.on("close", () => {
    socketSessionTokens.delete(ws);
    queue.length = 0;
    if (bindTimer !== null) {
      clearTimeout(bindTimer);
      bindTimer = null;
    }
    const entry = wsEntry.get(ws);
    if (entry) {
      if (entry.extensionUIClient === ws) {
        entry.extensionUIClient = undefined;
        for (const pending of entry.pendingExtensionUI.values()) pending({ cancelled: true });
      }
      for (const receipt of entry.commandReceipts.values()) receipt.waiters.delete(ws);
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
      `pi-web-chat: run \`pi-web-chat status\` / \`pi-web-chat stop\` (legacy: \`pi --web ...\`), or remove stale ~/.pi/web-chat/pi-web-chat.pid, then retry.`,
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

  // Only a managed npm CLI or legacy Pi launcher owns shared pid/port/host files.
  // Source/dev servers can bind any other port without changing what a later
  // Managed status/restart commands treat this as the production service.
  try {
    writeManagedDaemonState(DAEMON_STATE_DIR, {
      pid: process.pid,
      port: PORT,
      host: HOST,
    });
  } catch {
    /* state files are auxiliary — the server still works without them */
  }
  if (auth.twoFactorEnabled) {
    console.log(`pi-web-chat auth: access token file: ${authStartupInfo().tokenFile}`);
    console.log(`pi-web-chat auth: 2FA(TOTP) enabled — secret: ${authStartupInfo().secretFile}`);
    console.log(
      `pi-web-chat auth: login needs the token + a 2FA code from your authenticator app`,
    );
  } else {
    console.log(`pi-web-chat auth: 2FA disabled (PI_WEB_2FA=off), access token file: ${authStartupInfo().tokenFile}`);
  }

  // The Codex thread catalog is slow to build from rollout files (seconds on a
  // long-lived ~/.codex). Warm it once in the background so the first
  // /api/sessions request does not pay that cost on the response path.
  // Skip it while a test fake backend is in play: tests assert that certain
  // paths never start Codex at all.
  if (!process.env.PI_WEB_CODEX_STARTED_MARKER) {
    void refreshCodexThreads().catch(() => {
      // Codex missing or not usable here; the first sessions request will retry
      // and simply report no Codex threads if the backend stays unavailable.
    });
  }
});

let shuttingDown = false;

// Flush login state, close live sockets, and restore the signal's expected
// behavior. Registering a signal listener suppresses Node's default exit, so
// merely flushing here would leave dev servers running after Ctrl-C.
function shutDown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  auth.flushSessions();
  for (const client of wss.clients) client.terminate();
  wss.close();
  void Promise.allSettled(
    [...entries.values()].map(async (entry) => {
      await entry.codex?.dispose();
      await entry.runtime.dispose();
    }),
  )
    .then(() => codexAppServer.dispose())
    .finally(() => {
      httpServer.close(() => process.exit(0));
      httpServer.closeAllConnections();
    });
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.once("SIGTERM", shutDown);
process.once("SIGINT", shutDown);
