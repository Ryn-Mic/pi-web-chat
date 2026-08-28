import { useSyncExternalStore } from "react";

export interface PreviewTab {
  cwd: string;
  path: string;
  name: string;
  lastActiveAt: number;
}

export const GIT_WORKSPACE_ID = "git";

export interface PreviewWorkspaceState {
  active: "files" | typeof GIT_WORKSPACE_ID | string;
  tabs: PreviewTab[];
}

export type PreviewWorkspaceAction =
  | { type: "open"; tab: PreviewTab }
  | { type: "activate"; identity: string }
  | { type: "close"; identity: string }
  | { type: "showFiles" }
  | { type: "clear" }
  | { type: "merge"; source: PreviewWorkspaceState };

const MAX_TABS = 8;

/**
 * Collision-free identity for a preview tab. Using JSON.stringify avoids
 * ambiguity when `cwd` or `path` contain separators.
 */
export function previewIdentity(cwd: string, path: string): string {
  return JSON.stringify([cwd, path]);
}

export function createPreviewWorkspaceState(): PreviewWorkspaceState {
  return { active: "files", tabs: [] };
}

function identityOf(tab: PreviewTab): string {
  return previewIdentity(tab.cwd, tab.path);
}

/**
 * Keep at most `MAX_TABS` tabs. The active identity is always protected;
 * otherwise evict the least recently active tab, breaking ties by position
 * (leftmost first).
 */
function enforceLruCap(
  state: PreviewWorkspaceState,
  protectedIdentity: "files" | string,
): PreviewWorkspaceState {
  if (state.tabs.length <= MAX_TABS) return state;

  const tabsWithIndex = state.tabs.map((tab, index) => ({ tab, index }));
  const protectedIndex =
    protectedIdentity === "files"
      ? -1
      : state.tabs.findIndex((tab) => identityOf(tab) === protectedIdentity);

  const candidates = tabsWithIndex.filter((_, i) => i !== protectedIndex);
  // Sort by least recently active, then by original position (leftmost first).
  candidates.sort((a, b) => {
    if (a.tab.lastActiveAt !== b.tab.lastActiveAt) {
      return a.tab.lastActiveAt - b.tab.lastActiveAt;
    }
    return a.index - b.index;
  });

  const keepCount = protectedIndex === -1 ? MAX_TABS : MAX_TABS - 1;
  const keptSet = new Set<number>();
  for (let i = candidates.length - 1; i >= candidates.length - keepCount; i--) {
    keptSet.add(candidates[i].index);
  }
  if (protectedIndex !== -1) keptSet.add(protectedIndex);

  const keptTabs = state.tabs.filter((_, i) => keptSet.has(i));
  return { ...state, tabs: keptTabs };
}

export function reducePreviewWorkspace(
  state: PreviewWorkspaceState,
  action: PreviewWorkspaceAction,
): PreviewWorkspaceState {
  switch (action.type) {
    case "open": {
      const id = identityOf(action.tab);
      let replaced = false;
      const tabs = state.tabs.map((tab) => {
        if (identityOf(tab) === id) {
          replaced = true;
          return { ...tab, lastActiveAt: action.tab.lastActiveAt };
        }
        return tab;
      });
      if (!replaced) tabs.push(action.tab);
      return enforceLruCap({ active: id, tabs }, id);
    }

    case "activate": {
      if (
        action.identity === "files" ||
        action.identity === GIT_WORKSPACE_ID ||
        state.tabs.some((tab) => identityOf(tab) === action.identity)
      ) {
        return { ...state, active: action.identity };
      }
      return state;
    }

    case "close": {
      if (action.identity === "files" || action.identity === GIT_WORKSPACE_ID) return state;
      const index = state.tabs.findIndex(
        (tab) => identityOf(tab) === action.identity,
      );
      if (index === -1) return state;

      const tabs = state.tabs.filter((_, i) => i !== index);
      let active = state.active;
      if (active === action.identity) {
        if (tabs.length === 0) {
          active = "files";
        } else {
          const nextIndex = Math.max(index - 1, 0);
          active = identityOf(tabs[Math.min(nextIndex, tabs.length - 1)]);
        }
      }
      return enforceLruCap({ active, tabs }, active);
    }

    case "showFiles":
      return { ...state, active: "files" };

    case "clear":
      return createPreviewWorkspaceState();

    case "merge": {
      const source = action.source;
      const seen = new Map<string, PreviewTab>();
      const order: string[] = [];

      for (const tab of state.tabs) {
        const id = identityOf(tab);
        if (!seen.has(id)) {
          seen.set(id, tab);
          order.push(id);
        } else if (tab.lastActiveAt > seen.get(id)!.lastActiveAt) {
          seen.set(id, tab);
        }
      }

      for (const tab of source.tabs) {
        const id = identityOf(tab);
        const existing = seen.get(id);
        if (!existing) {
          seen.set(id, tab);
          order.push(id);
        } else if (tab.lastActiveAt > existing.lastActiveAt) {
          seen.set(id, tab);
        }
      }

      const tabs = order.map((id) => seen.get(id)!);
      const retained = new Set(tabs.map(identityOf));

      let active: "files" | string;
      if (source.active !== "files" && retained.has(source.active)) {
        active = source.active;
      } else if (state.active !== "files" && retained.has(state.active)) {
        active = state.active;
      } else if (state.active === GIT_WORKSPACE_ID || source.active === GIT_WORKSPACE_ID) {
        active = GIT_WORKSPACE_ID;
      } else {
        active = "files";
      }

      return enforceLruCap({ active, tabs }, active);
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// In-memory store + React hook
// ---------------------------------------------------------------------------

const workspaces = new Map<string, PreviewWorkspaceState>();
const listeners = new Set<() => void>();
const EMPTY_STATE = createPreviewWorkspaceState();

function emit() {
  for (const listener of listeners) listener();
}

function dispatch(tabKey: string, action: PreviewWorkspaceAction) {
  const prev = workspaces.get(tabKey) ?? EMPTY_STATE;
  workspaces.set(tabKey, reducePreviewWorkspace(prev, action));
  emit();
}

export function openPreview(
  tabKey: string,
  cwd: string,
  path: string,
  name: string,
  at?: number,
): void {
  dispatch(tabKey, {
    type: "open",
    tab: { cwd, path, name, lastActiveAt: at ?? Date.now() },
  });
}

export function activatePreview(tabKey: string, identity: string): void {
  dispatch(tabKey, { type: "activate", identity });
}

export function closePreview(tabKey: string, identity: string): void {
  dispatch(tabKey, { type: "close", identity });
}

export function showFilesTab(tabKey: string): void {
  dispatch(tabKey, { type: "showFiles" });
}

export function clearPreviewWorkspace(tabKey: string): void {
  dispatch(tabKey, { type: "clear" });
}

export function mergePreviewWorkspace(
  losingKey: string,
  survivingKey: string,
): void {
  if (losingKey === survivingKey) return;
  const losing = workspaces.get(losingKey);
  if (!losing) {
    workspaces.delete(losingKey);
    emit();
    return;
  }
  const surviving = workspaces.get(survivingKey) ?? createPreviewWorkspaceState();
  workspaces.set(
    survivingKey,
    reducePreviewWorkspace(surviving, { type: "merge", source: losing }),
  );
  workspaces.delete(losingKey);
  emit();
}

/** Read the current preview state for a chat tab (non-React consumers/tests). */
export function getPreviewWorkspaceState(
  tabKey: string,
): PreviewWorkspaceState {
  return workspaces.get(tabKey) ?? EMPTY_STATE;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getServerSnapshot(): PreviewWorkspaceState {
  return EMPTY_STATE;
}

export function usePreviewWorkspace(tabKey: string): PreviewWorkspaceState {
  return useSyncExternalStore(
    subscribe,
    () => getPreviewWorkspaceState(tabKey),
    getServerSnapshot,
  );
}
