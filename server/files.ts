/** Project directory listing & file search with shared ignore filtering. */
import {
  closeSync,
  createReadStream,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, extname, join, normalize, relative, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { UIFileMatch, UITreeNode } from "../shared/protocol.ts";

/** Always excluded, at any depth (huge or internal) */
const HARD_EXCLUDES = new Set([".git", "node_modules"]);
/** Max entries returned for one directory */
const MAX_DIR_ENTRIES = 1000;
/** Root .gitignore re-read interval */
const IGNORE_TTL_MS = 10_000;

export class PathEscapeError extends Error {}

export class PreviewTooLargeError extends Error {}

export const MAX_PREVIEW_BYTES = 100 * 1024 * 1024;

export interface ResolvedPreviewFile {
  abs: string;
  realAbs: string;
  path: string;
  name: string;
  size: number;
  mimeType: string;
  mtimeMs: number;
  dev: number;
  ino: number;
  etag: string;
}

export interface OpenResolvedPreviewFileResult {
  fd: number;
  stream: import("node:fs").ReadStream;
}

function posixRel(rel: string): string {
  return normalize(rel).replaceAll(sep, "/");
}

function enoentError(rel: string): NodeJS.ErrnoException {
  const err = new Error(`ENOENT: no such file or directory, preview '${rel}'`) as NodeJS.ErrnoException;
  err.code = "ENOENT";
  return err;
}

function lookupMime(rel: string): string {
  switch (extname(rel).toLowerCase()) {
    case ".md":
      return "text/markdown";
    case ".txt":
      return "text/plain";
    case ".html":
    case ".htm":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
    case ".mjs":
    case ".cjs":
      return "text/javascript";
    case ".ts":
    case ".mts":
    case ".cts":
      return "text/typescript";
    case ".json":
      return "application/json";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    default:
      return "application/octet-stream";
  }
}

function etagFor(st: { dev: number | bigint; ino: number | bigint; size: number; mtimeMs: number }): string {
  return `W/"${String(st.dev)}-${String(st.ino)}-${st.size}-${st.mtimeMs}"`;
}

export function resolvePreviewFile(root: string, rel: string): ResolvedPreviewFile {
  const rootAbs = resolve(root);
  const rootRealAbs = realpathSync(rootAbs);
  const abs = assertInsideRoot(rootAbs, rel);
  const normalizedRel = posixRel(rel);
  const ig = loadRootIgnore(rootAbs);
  if (isExcluded(normalizedRel, false, ig)) throw enoentError(normalizedRel);

  let targetAbs = abs;
  let st = lstatSync(abs);
  if (st.isSymbolicLink()) {
    targetAbs = realpathSync(abs);
    if (targetAbs !== rootRealAbs && !targetAbs.startsWith(rootRealAbs + sep)) {
      throw new PathEscapeError(rel);
    }
    const targetRel = posixRel(relative(rootRealAbs, targetAbs));
    if (isExcluded(targetRel, false, ig)) throw enoentError(normalizedRel);
    st = lstatSync(targetAbs);
  }

  if (!st.isFile()) throw enoentError(normalizedRel);
  if (st.size > MAX_PREVIEW_BYTES) throw new PreviewTooLargeError();

  return {
    abs,
    realAbs: targetAbs,
    path: normalizedRel,
    name: basename(normalizedRel),
    size: st.size,
    mimeType: lookupMime(normalizedRel),
    mtimeMs: st.mtimeMs,
    dev: st.dev,
    ino: st.ino,
    etag: etagFor(st),
  };
}

export function openResolvedPreviewFile(meta: ResolvedPreviewFile): OpenResolvedPreviewFileResult {
  const fd = openSync(meta.realAbs, "r");
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.dev !== meta.dev ||
      st.ino !== meta.ino ||
      st.size !== meta.size ||
      st.mtimeMs !== meta.mtimeMs
    ) {
      const err = new Error("file changed after metadata resolution") as NodeJS.ErrnoException;
      err.code = "ESTALE";
      throw err;
    }
    return {
      fd,
      stream: createReadStream(meta.realAbs, { fd, autoClose: true }),
    };
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/** Reject any existing rel segment that is a symlink resolving to a directory. */
function assertNoSymlinkedDirectorySegment(root: string, rel: string): void {
  const normalizedRel = normalize(rel).replaceAll(sep, "/");
  let cur = root;
  for (const segment of normalizedRel.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      cur = join(cur, segment);
      continue;
    }
    cur = join(cur, segment);
    let lst;
    try {
      lst = lstatSync(cur);
    } catch {
      return; // Only existing path segments can be symlink-checked.
    }
    if (!lst.isSymbolicLink()) continue;
    try {
      if (statSync(cur).isDirectory()) throw new PathEscapeError(rel);
    } catch (err) {
      if (err instanceof PathEscapeError) throw err;
      return; // Broken/unreadable symlink: let the caller's fs operation map the error.
    }
  }
}

/** Resolve rel against root, rejecting escapes, absolute paths, and symlinked-dir traversal. Returns abs. */
export function assertInsideRoot(root: string, rel: string): string {
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) throw new PathEscapeError(rel);
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, rel);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) throw new PathEscapeError(rel);
  assertNoSymlinkedDirectorySegment(rootAbs, rel);
  return abs;
}

const ignoreCache = new Map<string, { at: number; ig: Ignore | null }>();

/** Root-level .gitignore compiled rules (null when absent/unreadable). Nested .gitignore files are out of scope. */
function loadRootIgnore(root: string): Ignore | null {
  const hit = ignoreCache.get(root);
  if (hit && Date.now() - hit.at < IGNORE_TTL_MS) return hit.ig;
  let ig: Ignore | null = null;
  try {
    const file = join(root, ".gitignore");
    if (existsSync(file)) ig = ignore().add(readFileSync(file, "utf8"));
  } catch {
    ig = null;
  }
  ignoreCache.set(root, { at: Date.now(), ig });
  return ig;
}

function isExcluded(rel: string, isDir: boolean, ig: Ignore | null): boolean {
  if (rel.split("/").some((segment) => HARD_EXCLUDES.has(segment))) return true;
  if (!ig) return false;
  // `foo/` patterns only match directories — test both forms for dirs
  return ig.ignores(rel) || (isDir && ig.ignores(rel + "/"));
}

/** Peek a dir's children (filtered) to decide chevron rendering; EACCES → inaccessible. */
function probeDir(abs: string, rel: string, ig: Ignore | null): { hasChildren: boolean; inaccessible: boolean } {
  let dirents;
  try {
    dirents = readdirSync(abs, { withFileTypes: true });
  } catch {
    return { hasChildren: false, inaccessible: true };
  }
  for (const ent of dirents) {
    const childRel = `${rel}/${ent.name}`;
    if (!isExcluded(childRel, ent.isDirectory(), ig)) return { hasChildren: true, inaccessible: false };
  }
  return { hasChildren: false, inaccessible: false };
}

function byTypeThenName(a: UITreeNode, b: UITreeNode): number {
  if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
}

/** Single-level listing. rel "" = root. Symlinked dirs show as files (no traversal). */
export function listDir(root: string, rel: string): { nodes: UITreeNode[]; truncated: boolean } {
  const abs = assertInsideRoot(root, rel);
  const ig = loadRootIgnore(root);
  const kept: UITreeNode[] = [];
  for (const ent of readdirSync(abs, { withFileTypes: true })) {
    // Dirent is lstat semantics: symlinked dirs report isDirectory() === false
    const isDir = ent.isDirectory();
    const childRel = rel ? `${rel}/${ent.name}` : ent.name;
    if (isExcluded(childRel, isDir, ig)) continue;
    const node: UITreeNode = { name: ent.name, path: childRel, type: isDir ? "dir" : "file" };
    if (isDir) {
      const probe = probeDir(join(abs, ent.name), childRel, ig);
      node.hasChildren = probe.hasChildren;
      if (probe.inaccessible) node.inaccessible = true;
    }
    kept.push(node);
  }
  kept.sort(byTypeThenName);
  return { nodes: kept.slice(0, MAX_DIR_ENTRIES), truncated: kept.length > MAX_DIR_ENTRIES };
}

export interface FileIndexEntry {
  name: string;
  path: string;
  type: "dir" | "file";
}

/** Safety cap for the full-project walk */
const WALK_CAP = 100_000;
const SEARCH_CACHE_TTL_MS = 5_000;
const EMPTY_QUERY_CAP = 20;
const MAX_LIMIT = 200;

/** Uncached full-project walk (exported for tests with a custom cap). */
export function walkProject(root: string, cap: number): { entries: FileIndexEntry[]; partial: boolean } {
  const ig = loadRootIgnore(root);
  const entries: FileIndexEntry[] = [];
  let partial = false;
  const walk = (abs: string, rel: string) => {
    if (partial) return;
    let dirents;
    try {
      dirents = readdirSync(abs, { withFileTypes: true });
    } catch {
      return; // unreadable dir — skip, don't fail the whole search
    }
    for (const ent of dirents) {
      if (entries.length >= cap) {
        partial = true;
        return;
      }
      const isDir = ent.isDirectory();
      if (ent.isSymbolicLink()) {
        // Symlinked dirs: never traverse, never index (cycle guard). Stat to tell them apart.
        try {
          if (statSync(join(abs, ent.name)).isDirectory()) continue;
        } catch {
          continue; // broken symlink
        }
      }
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (isExcluded(childRel, isDir, ig)) continue;
      entries.push({ name: ent.name, path: childRel, type: isDir ? "dir" : "file" });
      if (isDir) walk(join(abs, ent.name), childRel);
    }
  };
  walk(root, "");
  return { entries, partial };
}

const indexCache = new Map<string, { at: number; entries: FileIndexEntry[]; partial: boolean }>();

/** Cached project index (5s TTL — keystrokes hit cache, new files appear after expiry). */
export function buildFileIndex(root: string): { entries: FileIndexEntry[]; partial: boolean } {
  const hit = indexCache.get(root);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL_MS) return hit;
  const { entries, partial } = walkProject(root, WALK_CAP);
  const result = { at: Date.now(), entries, partial };
  indexCache.set(root, result);
  return result;
}

/** Case-insensitive tiers: basename prefix > basename substring > path substring; shorter path wins ties. */
export function rankMatches(entries: FileIndexEntry[], query: string): FileIndexEntry[] {
  const q = query.toLowerCase();
  const scored: { entry: FileIndexEntry; tier: number }[] = [];
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    const path = entry.path.toLowerCase();
    const tier = name.startsWith(q) ? 0 : name.includes(q) ? 1 : path.includes(q) ? 2 : -1;
    if (tier >= 0) scored.push({ entry, tier });
  }
  scored.sort(
    (a, b) =>
      a.tier - b.tier ||
      a.entry.path.length - b.entry.path.length ||
      a.entry.path.localeCompare(b.entry.path),
  );
  return scored.map((s) => s.entry);
}

export function searchFiles(root: string, query: string, limit = 50): { matches: UIFileMatch[]; partial: boolean } {
  const { entries, partial } = buildFileIndex(root);
  const clamped = Math.max(1, Math.min(Math.trunc(limit) || 50, MAX_LIMIT));
  const q = query.trim();
  if (!q) {
    const top = entries
      .filter((e) => !e.path.includes("/"))
      .sort((a, b) =>
        a.type !== b.type
          ? a.type === "dir" ? -1 : 1
          : a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      );
    return { matches: top.slice(0, EMPTY_QUERY_CAP), partial };
  }
  return { matches: rankMatches(entries, q).slice(0, clamped), partial };
}
