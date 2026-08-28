import { useSyncExternalStore } from "react";

const LAST_SESSION_KEY = "pi-web-chat:last-session";
/** "1" = on (default), "0" = off */
const ENABLED_KEY = "pi-web-chat:resume-session";
const listeners = new Set<() => void>();

function readEnabled(): boolean {
  try {
    return localStorage.getItem(ENABLED_KEY) !== "0";
  } catch {
    return true;
  }
}

function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_SESSION_KEY);
  } catch {
    return null;
  }
}

let enabled = typeof window !== "undefined" ? readEnabled() : true;
let lastId = typeof window !== "undefined" ? readLast() : null;
/**
 * When the user explicitly opens a fresh draft, keep `/` as a draft until it
 * is published. Module state is intentionally lost on reload, because an
 * unpublished draft cannot be restored.
 */
let freshDraftRequested = false;

function emit() {
  for (const l of listeners) l();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Record the id whenever a session is published in the URL (session_bound) */
export function rememberSessionId(id: string) {
  lastId = id;
  freshDraftRequested = false;
  try {
    localStorage.setItem(LAST_SESSION_KEY, id);
  } catch {
    /* ignore */
  }
}

export function getLastSessionId(): string | null {
  return lastId;
}

/** Explicit "new session": keep the root route on a fresh draft. */
export function markFreshDraftRequested() {
  freshDraftRequested = true;
}

/** Whether ChatPage should skip the resume branch for the active fresh draft. */
export function isFreshDraftRequested(): boolean {
  return freshDraftRequested;
}

export function isResumeEnabled(): boolean {
  return enabled;
}

export function setResumeEnabled(value: boolean) {
  enabled = value;
  try {
    localStorage.setItem(ENABLED_KEY, value ? "1" : "0");
  } catch {
    /* ignore */
  }
  emit();
}

export function useResumeEnabled(): boolean {
  return useSyncExternalStore(subscribe, () => enabled, () => true);
}
