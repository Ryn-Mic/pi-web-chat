import { open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { UIAgentKind, UISessionInfo } from "../shared/protocol.ts";

const COLD_SUMMARY_BATCH_SIZE = 16;
const ANSI_RE = /[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

type FileState = {
  path: string;
  ino: number;
  size: number;
  mtimeMs: number;
  scannedBytes: number;
  pending: string;
  decoder: StringDecoder;
  headerSeen: boolean;
  id: string;
  cwd: string;
  name?: string;
  agent: UIAgentKind;
  codexThreadId?: string;
  firstMessage: string;
  messageCount: number;
  createdMs: number;
  lastActivityMs: number;
  info: UISessionInfo;
};

type JsonEntry = {
  type?: unknown;
  id?: unknown;
  cwd?: unknown;
  timestamp?: unknown;
  name?: unknown;
  customType?: unknown;
  data?: unknown;
  message?: {
    role?: unknown;
    timestamp?: unknown;
    content?: unknown;
  };
};

function sessionIdOf(file: string): string {
  const base = basename(file).replace(/\.jsonl$/, "");
  const split = base.lastIndexOf("_");
  return split >= 0 ? base.slice(split + 1) : base;
}

function projectOf(cwd: string, file: string): string {
  if (cwd) return cwd;
  return basename(dirname(file));
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.replace(ANSI_RE, "").trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text.replace(ANSI_RE, ""))
    .join("\n")
    .trim();
}

function parseTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

function createState(path: string, ino: number, size: number, mtimeMs: number): FileState {
  const now = Date.now();
  const state: FileState = {
    path,
    ino,
    size,
    mtimeMs,
    scannedBytes: 0,
    pending: "",
    decoder: new StringDecoder("utf8"),
    headerSeen: false,
    id: sessionIdOf(path),
    cwd: "",
    agent: "pi",
    firstMessage: "",
    messageCount: 0,
    createdMs: now,
    lastActivityMs: mtimeMs,
    info: {
      id: sessionIdOf(path),
      path,
      project: basename(path, ".jsonl"),
      firstMessage: "(no messages)",
      modified: new Date(mtimeMs).toISOString(),
      messageCount: 0,
    },
  };
  return state;
}

function applyEntry(state: FileState, entry: JsonEntry) {
  if (!state.headerSeen) {
    if (entry.type !== "session" || typeof entry.id !== "string") return;
    state.headerSeen = true;
    state.id = sessionIdOf(state.path) || entry.id;
    state.cwd = typeof entry.cwd === "string" ? entry.cwd : "";
    state.createdMs = parseTime(entry.timestamp) ?? state.mtimeMs;
    state.lastActivityMs = state.createdMs;
    return;
  }
  if (entry.type === "custom" && entry.customType === "pi-web-chat.codex") {
    state.agent = "codex";
    if (
      entry.data
      && typeof entry.data === "object"
      && typeof (entry.data as { threadId?: unknown }).threadId === "string"
    ) {
      state.codexThreadId = (entry.data as { threadId: string }).threadId;
    }
    return;
  }
  if (entry.type === "session_info") {
    state.name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
    return;
  }
  if (entry.type !== "message") return;
  state.messageCount += 1;
  const activity = parseTime(entry.message?.timestamp) ?? parseTime(entry.timestamp);
  if (activity !== null) state.lastActivityMs = Math.max(state.lastActivityMs, activity);
  if (!state.firstMessage && entry.message?.role === "user") {
    state.firstMessage = textFromContent(entry.message.content);
  }
}

function applyChunk(state: FileState, chunk: Buffer) {
  const text = state.pending + state.decoder.write(chunk);
  const lines = text.split("\n");
  state.pending = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      applyEntry(state, JSON.parse(trimmed) as JsonEntry);
    } catch {
      // Ignore malformed complete lines, matching the SDK's tolerant loader.
    }
  }
}

function finalizeInfo(state: FileState): UISessionInfo {
  const modifiedMs = state.lastActivityMs || state.createdMs || state.mtimeMs;
  const info: UISessionInfo = {
    id: state.id,
    path: state.path,
    project: projectOf(state.cwd, state.path),
    name: state.name,
    agent: state.agent,
    ...(state.codexThreadId ? { codexThreadId: state.codexThreadId } : {}),
    firstMessage: (state.firstMessage || "(no messages)").slice(0, 200),
    modified: new Date(modifiedMs).toISOString(),
    messageCount: state.messageCount,
  };
  state.info = info;
  return info;
}

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  if (end <= start) return Buffer.alloc(0);
  const file = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(end - start);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await file.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        start + bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

async function mapBatches<T, R>(items: T[], worker: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = [];
  for (let start = 0; start < items.length; start += COLD_SUMMARY_BATCH_SIZE) {
    output.push(...(await Promise.all(items.slice(start, start + COLD_SUMMARY_BATCH_SIZE).map(worker))));
  }
  return output;
}

/** In-memory, append-aware index for JSONL files below the pi sessions directory. */
export class SessionSummaryIndex {
  private readonly cache = new Map<string, FileState>();
  private byId = new Map<string, string>();

  constructor(private readonly sessionsDir: string) {}

  private async discover(): Promise<string[]> {
    let projects;
    try {
      projects = await readdir(this.sessionsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const directories = projects.filter((entry) => entry.isDirectory());
    const nested = await Promise.all(
      directories.map(async (directory) => {
        const dir = join(this.sessionsDir, directory.name);
        try {
          return (await readdir(dir, { withFileTypes: true }))
            .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
            .map((entry) => join(dir, entry.name));
        } catch {
          return [];
        }
      }),
    );
    return nested.flat();
  }

  private async refreshFile(path: string): Promise<UISessionInfo | null> {
    let fileStat;
    try {
      fileStat = await stat(path);
    } catch {
      this.cache.delete(path);
      return null;
    }
    const cached = this.cache.get(path);
    if (
      cached &&
      cached.ino === fileStat.ino &&
      cached.size === fileStat.size &&
      cached.mtimeMs === fileStat.mtimeMs
    ) {
      return cached.info;
    }

    const appendOnly = cached && cached.ino === fileStat.ino && fileStat.size > cached.size;
    const state = appendOnly
      ? cached
      : createState(path, fileStat.ino, fileStat.size, fileStat.mtimeMs);
    const start = appendOnly ? state.scannedBytes : 0;
    const chunk = await readRange(path, start, fileStat.size);
    applyChunk(state, chunk);
    // The SDK also accepts a valid final JSON entry without a trailing newline.
    if (state.pending.trim()) {
      try {
        applyEntry(state, JSON.parse(state.pending.trim()) as JsonEntry);
        state.pending = "";
      } catch {
        // Keep an incomplete tail; the next append completes it.
      }
    }
    state.ino = fileStat.ino;
    state.size = fileStat.size;
    state.mtimeMs = fileStat.mtimeMs;
    state.scannedBytes = fileStat.size;
    this.cache.set(path, state);
    return state.headerSeen ? finalizeInfo(state) : null;
  }

  async list(): Promise<UISessionInfo[]> {
    const paths = await this.discover();
    const present = new Set(paths);
    for (const path of this.cache.keys()) if (!present.has(path)) this.cache.delete(path);
    const infos = (
      await mapBatches(paths, async (path) => {
        try {
          return await this.refreshFile(path);
        } catch {
          // One concurrently removed/unreadable file must not fail the entire
          // session sidebar refresh.
          this.cache.delete(path);
          return null;
        }
      })
    ).filter((info): info is UISessionInfo => info !== null);
    this.byId = new Map(infos.map((info) => [info.id, info.path]));
    infos.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    return infos;
  }

  async resolve(id: string): Promise<string | undefined> {
    const cached = this.byId.get(id);
    if (cached) return cached;
    // Opening one session should not build every summary. The URL id is the
    // filename suffix, so directory enumeration alone is enough to locate it.
    const paths = await this.discover();
    const path = paths.find((candidate) => sessionIdOf(candidate) === id);
    if (path) this.byId.set(id, path);
    return path;
  }

  invalidate(path?: string) {
    if (path) {
      this.cache.delete(path);
      for (const [id, indexedPath] of this.byId) {
        if (indexedPath === path) this.byId.delete(id);
      }
    } else {
      this.cache.clear();
      this.byId.clear();
    }
  }
}
