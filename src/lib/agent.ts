import { useSyncExternalStore } from "react";
import type { UIAgentKind } from "../../shared/protocol";

const STORAGE_KEY = "pi-web-chat-agent";
const listeners = new Set<() => void>();

function isAgent(value: unknown): value is UIAgentKind {
  return value === "pi" || value === "codex";
}

function readPreference(): UIAgentKind | null {
  if (typeof localStorage === "undefined") return null;
  const value = localStorage.getItem(STORAGE_KEY);
  return isAgent(value) ? value : null;
}

let current: UIAgentKind | null = readPreference();

function notify() {
  for (const listener of listeners) listener();
}

/** Explicit agent preference for new sessions; null delegates to the server default. */
export function getAgentPreference(): UIAgentKind | null {
  return current;
}

export function setAgentPreference(agent: UIAgentKind | null) {
  if (agent === current) return;
  current = agent;
  if (typeof localStorage !== "undefined") {
    if (agent) localStorage.setItem(STORAGE_KEY, agent);
    else localStorage.removeItem(STORAGE_KEY);
  }
  notify();
}

export function useAgentPreference(): UIAgentKind | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
    () => null,
  );
}
