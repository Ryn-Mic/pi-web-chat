import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
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
import QRCode from "qrcode";
import type {
  ClientCommand,
  ServerEvent,
  UICustomModelsResponse,
  UICustomProvider,
  UIActiveTodo,
  UIFileSearchResponse,
  UIModelDiscoveryRequest,
  UIExtensionInfo,
  UICommandInfo,
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
} from "../shared/protocol.ts";
import { createSnapshotDelta } from "../shared/snapshot.ts";
import { auth, authStartupInfo } from "./auth.ts";
import { selectReplayEvents } from "./event-replay.ts";
import { handleDesktopFileContent, streamStaticFile } from "./file-content.ts";
import { listDir, PathEscapeError, searchFiles } from "./files.ts";
import {
  handlePreviewContentRequest,
  handlePreviewContextRequest,
  PreviewContextStore,
} from "./preview-context.ts";
import { readCustomModels, resolveIncomingApiKey, validateProviders, writeCustomModels } from "./models-config.ts";
import { getActiveTodo, getOptimisticActiveTodo, serializeMessages } from "./serialize.ts";
import {
  AppendedJsonlDecoder,
  applyExternalSessionEntries,
} from "./session-append.ts";
import { readSessionHistoryPage } from "./session-history.ts";
import { createCwdBoundCoreTools } from "./runtime-tools.ts";
import { SessionSummaryIndex } from "./session-index.ts";
import {
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
const sessionSummaryIndex = new SessionSummaryIndex(join(getAgentDir(), "sessions"));

/** Daemon state file dir (same STATE_DIR as extensions/pi-web-chat.ts) */
const DAEMON_STATE_DIR = join(HOME, ".pi", "web-chat");

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
type SessionEventPayload = SequencedServerEvent extends infer Event
  ? Event extends SequencedServerEvent
    ? Omit<Event, "seq">
    : never
  : never;

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
  lastFileStat?: { ino: number; size: number; mtimeMs: number };
  externalDecoder: AppendedJsonlDecoder;
  syncingExternal?: boolean;
  /** Browser that initiated the current extension command, if any. */
  extensionUIClient?: WebSocket;
  /** Recently accepted browser prompt IDs, used to deduplicate reconnect replays. */
  receivedPromptIds: Map<string, number>;
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
  return sessionSummaryIndex.resolve(id);
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

/** Rebuild the browser's fixed tail window from the runtime's current leaf. */
function refreshEntryFileState(entry: SessionEntry) {
  entry.externalDecoder = new AppendedJsonlDecoder();
  const file = entry.runtime.session.sessionFile;
  if (!file) {
    entry.snapshotMessageOffset = 0;
    entry.historyCursor = null;
    entry.historyHasMore = false;
    entry.lastFileStat = undefined;
    return;
  }
  try {
    const page = readSessionHistoryPage(file, {
      leafId: entry.runtime.session.sessionManager.getLeafId(),
    });
    const messageCount = serializeMessages(entry.runtime.session.messages).length;
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
    receivedPromptIds: new Map(),
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
  refreshEntryFileState(entry);
  entry.lastSnapshot = buildSnapshot(entry);
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
      entry.reloading ||
      entry.syncingExternal ||
      entry.runtime.session.isStreaming
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

/** ~-shorten an absolute path for display */
function shortenHome(p: string): string {
  return p === HOME ? "~" : p.startsWith(HOME + "/") ? "~" + p.slice(HOME.length) : p;
}

// Known-project cache for file API authorization (anti arbitrary-read).
const KNOWN_ROOTS_TTL_MS = 3_000;
let knownRootsCache: { at: number; roots: Set<string> } | null = null;

/** Roots the file APIs may serve: loaded runtimes + sessions' cwds + the chat workspace. */
async function knownProjectRoots(): Promise<Set<string>> {
  if (knownRootsCache && Date.now() - knownRootsCache.at < KNOWN_ROOTS_TTL_MS) {
    return knownRootsCache.roots;
  }
  const roots = new Set<string>([AGENT_CWD]);
  for (const entry of entries.values()) roots.add(entry.runtime.cwd);
  try {
    for (const session of await sessionSummaryIndex.list()) {
      if (session.project.startsWith("/")) roots.add(session.project);
    }
  } catch {
    /* keep the entry/AGENT_CWD roots */
  }
  knownRootsCache = { at: Date.now(), roots };
  return roots;
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
  const allMessages = serializeMessages(session.messages);
  const messages = allMessages.slice(entry.snapshotMessageOffset);
  return {
    messages,
    history: {
      cursor: entry.historyCursor,
      hasMore: entry.historyHasMore,
    },
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
    activeTodo: [...entry.activeTodos.values()].at(-1) ?? getActiveTodo(allMessages),
    activeTools: [...entry.activeTools].map(([toolCallId, toolName]) => ({
      toolCallId,
      toolName,
    })),
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
function broadcastSnapshot(entry: SessionEntry, override?: Partial<UISnapshot>) {
  const previous = entry.lastSnapshot ?? buildSnapshot(entry);
  const next = { ...buildSnapshot(entry), ...override };
  const delta = createSnapshotDelta(previous, next, entry.snapshotRevision);
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
      case "message_end":
        broadcastSnapshot(entry);
        break;
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
      if (cmd.requestId && !rememberReceivedPrompt(entry, cmd.requestId)) {
        sendTo(ws, { type: "prompt_received", requestId: cmd.requestId });
        return;
      }
      // Publish the session to the URL at first input → client switches to /s/:id
      if (!entry.published) publishEntry(entry, ws);
      const slashCommand = parseSlashCommand(text);
      if (slashCommand && (await handleBuiltinCommand(slashCommand, entry, ws))) {
        return;
      }
      entry.extensionUIClient = ws;
      // Calling prompt() starts the run but the returned promise resolves only
      // after the whole run ends. Confirm only after the runtime accepted the
      // call, without making the client wait for agent lifecycle events.
      let promptRun: Promise<unknown>;
      try {
        promptRun = session.prompt(text, {
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
      // AgentSessionRuntime's rebind callback has already refreshed the entry,
      // history window, command catalog, and full snapshot baseline.
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
      broadcastTo(entry, { type: "error", message: `Extension error: ${error.error}` });
    },
  });
}

function installEntryRuntimeRebind(entry: SessionEntry) {
  entry.runtime.setRebindSession(async () => {
    entry.activeTools.clear();
    entry.activeTodos.clear();
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
      send(getGitStatus(cwd) satisfies UIGitStatus);
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/git/branches") {
      send(getGitBranches(cwd) satisfies UIGitBranch[]);
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/git/log") {
      send(getGitLog(cwd, Number(url.searchParams.get("limit") ?? "50")) satisfies UIGitCommit[]);
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/git/commit") {
      send(getGitCommit(cwd, url.searchParams.get("hash") ?? "") satisfies UIGitCommitDetail);
      return true;
    }
    if (req.method === "GET" && url.pathname === "/api/git/diff") {
      send(getGitDiff(cwd, url.searchParams.get("path") ?? "", url.searchParams.get("staged") === "1") satisfies UIGitDiff);
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
      if (typeof body.branch !== "string") {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "branch is required", code: "invalid" }));
        return true;
      }
      const status = checkoutGitBranch(cwd, body.branch) satisfies UIGitStatus;
      gitBranchCache.delete(cwd);
      gitBranchCache.delete(status.root);
      for (const entry of entries.values()) {
        if (resolve(entry.runtime.cwd) === resolve(cwd)) broadcastSnapshot(entry);
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

  if (req.method === "GET" || req.method === "HEAD") {
    sendJson(404, { error: "not found" });
  } else {
    sendJson(405, { error: "method not allowed" });
  }
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

    if (url.pathname === "/api/sessions") {
      const sessions = await sessionSummaryIndex.list();
      // Which loaded runtimes are currently streaming (for the sidebar running dot)
      const streamingIds = new Set<string>();
      for (const entry of entries.values()) {
        if (entry.runtime.session.isStreaming) streamingIds.add(entry.id);
      }
      const list: UISessionInfo[] = sessions.slice(0, 300).map((session) => ({
        ...session,
        project: projectOf({ cwd: session.project, path: session.path }),
        isStreaming: streamingIds.has(session.id),
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(list));
      return;
    }

    const historyMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
    if (req.method === "GET" && historyMatch) {
      const id = decodeURIComponent(historyMatch[1]!);
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
                  isStreaming: e.runtime.session.isStreaming,
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

    // Static files (production build)
    if (existsSync(DIST_DIR)) {
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("Bad request");
        return;
      }
      const viewerPrefix = "/file-viewer/";
      const isViewer = pathname.startsWith(viewerPrefix);

      const filePath = resolve(DIST_DIR, "." + pathname);
      const distRoot = resolve(DIST_DIR);
      if (filePath !== distRoot && !filePath.startsWith(distRoot + "/")) {
        res.writeHead(403, { "content-type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      if (isViewer) {
        if (existsSync(filePath) && statSync(filePath).isFile()) {
          streamStaticFile(req, res, filePath, {
            cacheControl: "public, max-age=3600, must-revalidate",
          });
        } else {
          res.writeHead(404, { "content-type": "text/plain" });
          res.end("Not found");
        }
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
  const sinceValue = query.get("since");
  const parsedSince = sinceValue === null ? null : Number(sinceValue);
  const since =
    parsedSince !== null && Number.isSafeInteger(parsedSince) && parsedSince >= 0
      ? parsedSince
      : null;
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
      sendTo(ws, {
        type: "error",
        message: String(err instanceof Error ? err.message : err),
        requestId: cmd.type === "prompt" ? cmd.requestId : undefined,
      });
    });
  });

  let preloaded = false;
  const prepareEntry = async () => {
    // A cold runtime switch synchronously parses the whole JSONL. Send a cheap
    // tail page first, then yield once so the browser can paint while the SDK
    // reconstructs the full agent context in the background.
    if (requested && !entries.has(requested)) {
      const path = await resolveSessionPath(requested);
      if (path && ws.readyState === ws.OPEN) {
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
    return acquireEntry(requested, cwd);
  };

  prepareEntry()
    .then((entry) => {
      if (ws.readyState !== ws.OPEN) return;
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
      ready = true;
      for (const cmd of queue.splice(0)) {
        handleCommand(cmd, ws).catch((err) => {
          sendTo(ws, {
            type: "error",
            message: String(err instanceof Error ? err.message : err),
            requestId: cmd.type === "prompt" ? cmd.requestId : undefined,
          });
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
