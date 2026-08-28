import { useSyncExternalStore } from "react";
import type { UIFileMatch, UIFileSearchResponse } from "../../shared/protocol";

const PANEL_KEY = "pi-web-chat:files-panel-open";
/** cwd → expanded relative dir paths */
const EXPANDED_KEY = "pi-web-chat:files-tree-expanded";
const listeners = new Set<() => void>();

function readPanelOpen(): boolean {
  try {
    return localStorage.getItem(PANEL_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Parse persisted expanded state. Malformed or wrong-shaped values degrade to
 * an empty record (each cwd maps to an array of relative dir paths).
 */
export function parseExpanded(raw: string | null): Record<string, string[]> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, string[]> = {};
  for (const [cwd, paths] of Object.entries(parsed)) {
    if (Array.isArray(paths)) {
      out[cwd] = paths.filter((p): p is string => typeof p === "string");
    }
  }
  return out;
}

/**
 * Pure toggle: expand/collapse a dir path within a cwd, returning a new record
 * (never mutates the input).
 */
export function toggleExpandedPath(
  expanded: Record<string, string[]>,
  cwd: string,
  path: string,
): Record<string, string[]> {
  const current = expanded[cwd] ?? [];
  const next = current.includes(path)
    ? current.filter((p) => p !== path)
    : [...current, path];
  return { ...expanded, [cwd]: next };
}

/**
 * Expand a directory and all of its ancestors so a project-wide search hit is
 * visible after returning to the normal, lazily-loaded tree.
 */
export function revealExpandedPath(
  expanded: Record<string, string[]>,
  cwd: string,
  path: string,
): Record<string, string[]> {
  const segments = path.split("/").filter(Boolean);
  const paths = segments.map((_, index) => segments.slice(0, index + 1).join("/"));
  const current = expanded[cwd] ?? [];
  const next = [...current];
  for (const candidate of paths) {
    if (!next.includes(candidate)) next.push(candidate);
  }
  if (next.length === current.length) return expanded;
  return { ...expanded, [cwd]: next };
}

/**
 * React Query keeps the previous file-search response while a new query is in
 * flight. Only expose results that belong to the current normalized query;
 * `undefined` means pending/inactive while `[]` is an authoritative no-match.
 */
export function currentFileSearchMatches(
  response: UIFileSearchResponse | undefined,
  query: string,
): UIFileMatch[] | undefined {
  const normalized = query.trim();
  if (!normalized || response?.query !== normalized) return undefined;
  return response.matches;
}

function readExpanded(): Record<string, string[]> {
  try {
    return parseExpanded(localStorage.getItem(EXPANDED_KEY));
  } catch {
    return {};
  }
}

let panelOpen = typeof window !== "undefined" ? readPanelOpen() : false;
let expandedByCwd: Record<string, string[]> =
  typeof window !== "undefined" ? readExpanded() : {};

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useFilesPanelOpen(): boolean {
  return useSyncExternalStore(subscribe, () => panelOpen, () => false);
}

export function setFilesPanelOpen(open: boolean) {
  panelOpen = open;
  try {
    localStorage.setItem(PANEL_KEY, open ? "1" : "0");
  } catch {
    /* ignore */
  }
  emit();
}

export function isTreeDirExpanded(cwd: string, path: string): boolean {
  return (expandedByCwd[cwd] ?? []).includes(path);
}

export function toggleTreeDirExpanded(cwd: string, path: string) {
  expandedByCwd = toggleExpandedPath(expandedByCwd, cwd, path);
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(expandedByCwd));
  } catch {
    /* ignore */
  }
  emit();
}

export function revealTreeDir(cwd: string, path: string) {
  const next = revealExpandedPath(expandedByCwd, cwd, path);
  if (next === expandedByCwd) return;
  expandedByCwd = next;
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify(expandedByCwd));
  } catch {
    /* ignore */
  }
  emit();
}

export function useTreeDirExpanded(cwd: string, path: string): boolean {
  return useSyncExternalStore(subscribe, () => isTreeDirExpanded(cwd, path), () => false);
}
