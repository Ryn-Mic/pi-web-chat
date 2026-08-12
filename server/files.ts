/** Project directory listing & file search with shared ignore filtering. */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import ignore, { type Ignore } from "ignore";
import type { UIFileMatch, UITreeNode } from "../shared/protocol.ts";

/** Always excluded, at any depth (huge or internal) */
const HARD_EXCLUDES = new Set([".git", "node_modules"]);
/** Max entries returned for one directory */
const MAX_DIR_ENTRIES = 1000;
/** Root .gitignore re-read interval */
const IGNORE_TTL_MS = 10_000;

export class PathEscapeError extends Error {}

/** Resolve rel against root, rejecting escapes and absolute paths. Returns abs. */
export function assertInsideRoot(root: string, rel: string): string {
  if (rel.startsWith("/") || /^[A-Za-z]:[\\/]/.test(rel)) throw new PathEscapeError(rel);
  const abs = resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + sep)) throw new PathEscapeError(rel);
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
