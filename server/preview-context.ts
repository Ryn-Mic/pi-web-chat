import { createHash, randomBytes } from "node:crypto";

const INITIAL_TTL_MS = 5 * 60 * 1000;
const EXTENDED_TTL_MS = 10 * 60 * 1000;
const MAX_PER_FINGERPRINT = 16;

export type PreviewTheme = "light" | "dark";
export type PreviewLocale = "en-US" | "zh-CN" | "ja-JP";

export interface PreviewContextRecord {
  root: string;
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  mimeType: string;
  theme: PreviewTheme;
  locale: PreviewLocale;
  sessionFingerprint: string;
  createdAt: number;
  firstUsedAt: number | null;
}

export interface PreviewContextMetadata {
  name: string;
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
  mimeType: string;
}

export interface CreatePreviewContextInput {
  sessionToken: string;
  root: string;
  path: string;
  metadata: PreviewContextMetadata;
  theme: string;
  locale: string;
}

export interface PreviewContextStoreOptions {
  now?: () => number;
  createId?: () => string;
}

export class PreviewContextExpiredError extends Error {}
export class PreviewContextNotFoundError extends Error {}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizeTheme(value: string): PreviewTheme {
  return value === "dark" ? "dark" : "light";
}

function normalizeLocale(value: string): PreviewLocale {
  const lower = (value ?? "").toLowerCase();
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("ja")) return "ja-JP";
  return "en-US";
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { sendResolvedFile } from "./file-content.ts";
import {
  PathEscapeError,
  PreviewTooLargeError,
  PreviewUnsupportedError,
  resolvePreviewFile,
  type ResolvedPreviewFile,
} from "./files.ts";

export class PreviewContextStore {
  private readonly records = new Map<string, PreviewContextRecord>();
  /** Per-session-fingerprint FIFO queue of record keys (SHA-256 of raw ids). */
  private readonly order = new Map<string, string[]>();
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(options: PreviewContextStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.createId = options.createId ?? (() => randomBytes(16).toString("base64url"));
  }

  create(input: CreatePreviewContextInput): { id: string; expiresAt: string } {
    const now = this.now();
    const id = this.createId();
    const key = sha256(id);
    const sessionFingerprint = sha256(input.sessionToken);

    const record: PreviewContextRecord = {
      root: input.root,
      path: input.path,
      name: input.metadata.name,
      size: input.metadata.size,
      mtimeMs: input.metadata.mtimeMs,
      dev: input.metadata.dev,
      ino: input.metadata.ino,
      mimeType: input.metadata.mimeType,
      theme: normalizeTheme(input.theme),
      locale: normalizeLocale(input.locale),
      sessionFingerprint,
      createdAt: now,
      firstUsedAt: null,
    };

    this.records.set(key, record);
    const list = this.order.get(sessionFingerprint) ?? [];
    list.push(key);
    this.order.set(sessionFingerprint, list);

    if (list.length > MAX_PER_FINGERPRINT) {
      const evictKey = list.shift()!;
      this.records.delete(evictKey);
    }

    return { id, expiresAt: new Date(now + INITIAL_TTL_MS).toISOString() };
  }

  inspect(rawId: string): PreviewContextRecord {
    const key = sha256(rawId);
    const record = this.records.get(key);
    if (!record) {
      throw new PreviewContextNotFoundError();
    }

    const now = this.now();
    const deadline =
      record.firstUsedAt === null
        ? record.createdAt + INITIAL_TTL_MS
        : record.firstUsedAt + EXTENDED_TTL_MS;

    if (now >= deadline) {
      this.records.delete(key);
      this.removeFromOrder(record.sessionFingerprint, key);
      throw new PreviewContextExpiredError();
    }

    return record;
  }

  consume(rawId: string): PreviewContextRecord {
    const record = this.inspect(rawId);
    if (record.firstUsedAt === null) {
      record.firstUsedAt = this.now();
    }
    return record;
  }

  deleteBySessionToken(sessionToken: string): number {
    const fingerprint = sha256(sessionToken);
    const list = this.order.get(fingerprint) ?? [];
    let removed = 0;
    for (const key of list) {
      if (this.records.delete(key)) removed++;
    }
    this.order.delete(fingerprint);
    return removed;
  }

  cleanup(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, record] of this.records) {
      const deadline =
        record.firstUsedAt === null
          ? record.createdAt + INITIAL_TTL_MS
          : record.firstUsedAt + EXTENDED_TTL_MS;
      if (now >= deadline) {
        this.records.delete(key);
        this.removeFromOrder(record.sessionFingerprint, key);
        removed++;
      }
    }
    return removed;
  }

  get size(): number {
    return this.records.size;
  }

  private removeFromOrder(fingerprint: string, key: string): void {
    const list = this.order.get(fingerprint);
    if (!list) return;
    const idx = list.indexOf(key);
    if (idx >= 0) list.splice(idx, 1);
    if (list.length === 0) this.order.delete(fingerprint);
  }
}

// ---------------------------------------------------------------------------
// HTTP handlers
// ---------------------------------------------------------------------------

const INTERNAL_ERROR_TEXT = "internal server error";
const INTERNAL_ERROR_JSON = { error: INTERNAL_ERROR_TEXT };

function readBody(req: IncomingMessage, limit = 50_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function sessionTokenFromRequest(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (header?.toLowerCase().startsWith("bearer ")) return header.slice("Bearer ".length).trim();
  return "";
}

function previewIdFromRequest(req: IncomingMessage): string {
  const header = req.headers.authorization;
  if (!header) return "";
  const match = /^([A-Za-z][A-Za-z0-9+.-]*)\s+(.+)$/.exec(header);
  if (!match) return "";
  if (match[1].toLowerCase() !== "preview") return "";
  const value = match[2].trim();
  return value || "";
}

function sendPreviewError(
  res: ServerResponse,
  err: unknown,
): void {
  if (err instanceof PathEscapeError) {
    sendJson(res, 400, { error: "invalid path" });
    return;
  }
  if (err instanceof PreviewTooLargeError) {
    sendJson(res, 413, { error: "file too large" });
    return;
  }
  if (err instanceof PreviewUnsupportedError) {
    sendJson(res, 415, { error: "unsupported file" });
    return;
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    sendJson(res, 404, { error: "not found" });
    return;
  }
  if (code === "EACCES") {
    sendJson(res, 403, { error: "forbidden" });
    return;
  }
  sendJson(res, 500, INTERNAL_ERROR_JSON);
}

export interface PreviewRouteDeps {
  knownProjectRoots(): Promise<Set<string>>;
  expandHome(path: string): string;
  previewContextStore: PreviewContextStore;
}

/**
 * HEAD/GET /api/files/preview-content
 * Handled before the global Bearer gate: only accepts `Authorization: Preview <id>`.
 */
export async function handlePreviewContentRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: PreviewRouteDeps,
): Promise<boolean> {
  if (url.pathname !== "/api/files/preview-content") return false;
  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "method not allowed" });
    return true;
  }

  const id = previewIdFromRequest(req);
  if (!id) {
    sendJson(res, 401, { error: "unauthorized" });
    return true;
  }

  let record: PreviewContextRecord;
  try {
    record = deps.previewContextStore.inspect(id);
  } catch (err) {
    if (err instanceof PreviewContextExpiredError || err instanceof PreviewContextNotFoundError) {
      sendJson(res, 410, { error: "preview expired" });
      return true;
    }
    sendJson(res, 500, INTERNAL_ERROR_JSON);
    return true;
  }

  const root = deps.expandHome(record.root);
  if (!(await deps.knownProjectRoots()).has(root)) {
    sendJson(res, 403, { error: "unknown project cwd" });
    return true;
  }

  let meta: ResolvedPreviewFile;
  try {
    meta = resolvePreviewFile(root, record.path);
  } catch (err) {
    sendPreviewError(res, err);
    return true;
  }

  if (
    meta.dev !== record.dev ||
    meta.ino !== record.ino ||
    meta.size !== record.size ||
    meta.mtimeMs !== record.mtimeMs
  ) {
    sendJson(res, 409, { error: "content changed" });
    return true;
  }

  try {
    sendResolvedFile(req, res, meta, {
      extraHeaders: {
        "x-preview-theme": record.theme,
        "x-preview-locale": record.locale,
      },
      onReady: () => {
        deps.previewContextStore.consume(id);
      },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESTALE") {
      sendJson(res, 409, { error: "content changed" });
      return true;
    }
    sendPreviewError(res, err);
  }
  return true;
}

/**
 * POST /api/files/preview-context
 * Handled after the global Bearer gate.
 */
export async function handlePreviewContextRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: PreviewRouteDeps,
): Promise<boolean> {
  if (url.pathname !== "/api/files/preview-context" || req.method !== "POST") return false;

  let body: string;
  try {
    body = await readBody(req, 10_000);
  } catch {
    sendJson(res, 400, { error: "invalid request body" });
    return true;
  }

  let parsed: { cwd?: unknown; path?: unknown; theme?: unknown; locale?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    sendJson(res, 400, { error: "invalid JSON body" });
    return true;
  }

  const rawCwd = typeof parsed.cwd === "string" ? parsed.cwd : "";
  const rel = typeof parsed.path === "string" ? parsed.path : "";
  const theme = typeof parsed.theme === "string" ? parsed.theme : "light";
  const locale = typeof parsed.locale === "string" ? parsed.locale : "en-US";

  if (!rawCwd || !rel) {
    sendJson(res, 400, { error: "cwd and path are required" });
    return true;
  }

  const root = deps.expandHome(rawCwd);
  if (!(await deps.knownProjectRoots()).has(root)) {
    sendJson(res, 403, { error: "unknown project cwd" });
    return true;
  }

  let meta: ResolvedPreviewFile;
  try {
    meta = resolvePreviewFile(root, rel);
  } catch (err) {
    sendPreviewError(res, err);
    return true;
  }

  const sessionToken = sessionTokenFromRequest(req);
  if (!sessionToken) {
    sendJson(res, 401, { error: "unauthorized" });
    return true;
  }

  const { id, expiresAt } = deps.previewContextStore.create({
    sessionToken,
    root,
    path: rel,
    metadata: meta,
    theme,
    locale,
  });

  sendJson(res, 200, { id, expiresAt });
  return true;
}
