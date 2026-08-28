import { useSyncExternalStore } from "react";

const STORAGE_KEY = "pi-web-chat:sidebar-pinned";
/** Only expanded projects are stored — default is all collapsed */
const EXPANDED_KEY = "pi-web-chat:sidebar-expanded-projects";
const listeners = new Set<() => void>();

function readPinned(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function readExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

let cache = typeof window !== "undefined" ? readPinned() : false;
let expanded = typeof window !== "undefined" ? readExpanded() : new Set<string>();

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isSidebarPinned(): boolean {
  return cache;
}

export function setSidebarPinned(pinned: boolean) {
  cache = pinned;
  try {
    localStorage.setItem(STORAGE_KEY, pinned ? "1" : "0");
  } catch {
    // ignore quota / private mode
  }
  emit();
}

export function toggleSidebarPinned() {
  setSidebarPinned(!cache);
}

export function useSidebarPinned(): boolean {
  return useSyncExternalStore(subscribe, () => cache, () => false);
}

const EMPTY_SET = new Set<string>();

export function isProjectCollapsed(project: string): boolean {
  return !expanded.has(project);
}

export function toggleProjectCollapsed(project: string) {
  const next = new Set(expanded);
  if (next.has(project)) next.delete(project);
  else next.add(project);
  expanded = next;
  try {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...expanded]));
  } catch {
    /* ignore */
  }
  emit();
}

export function useExpandedProjects(): Set<string> {
  return useSyncExternalStore(subscribe, () => expanded, () => EMPTY_SET);
}

export function useProjectCollapsed(project: string): boolean {
  const currentExpanded = useExpandedProjects();
  return !currentExpanded.has(project);
}
